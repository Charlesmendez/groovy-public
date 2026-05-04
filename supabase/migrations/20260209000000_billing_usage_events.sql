-- Billing: workspace-scoped usage + tool metering (Stripe usage-based pricing)
-- Notes:
-- - Inserts are intended to be performed with the Supabase service role (bypasses RLS).
-- - Members can SELECT their workspace's billing events for audits/debugging.

create extension if not exists "pgcrypto";

-- ==========================
-- Usage events (token meter)
-- ==========================
create table if not exists public.billing_usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  -- Stable id for a single user action across multi-round loops (UI send / WhatsApp message)
  turn_id text not null,

  -- Trace identifier from the caller (e.g. orch-..., hb-..., UUID traces, etc.)
  trace_id text not null,

  -- Source bucket: orchestrator, datagran_agent, memory_planner, compaction, connector_cli, etc.
  source text not null,

  -- Optional sub-identifier when a single trace has multiple events for the same source.
  span_id text not null default 'main',

  provider text null,
  model text null,

  input_tokens bigint null,
  output_tokens bigint null,
  total_tokens bigint null,

  estimated boolean not null default false,
  estimation_reason text null,

  -- Extra fields for debugging/audits (tool names, costs, durations, etc.)
  meta jsonb not null default '{}'::jsonb,

  -- Stripe flushing fields (best-effort; the authoritative idempotency is in billing_stripe_flush_windows)
  stripe_sent_at timestamptz null,
  stripe_event_id text null,
  stripe_error text null,

  created_at timestamptz not null default now()
);

create index if not exists idx_billing_usage_events_workspace_created
on public.billing_usage_events (workspace_id, created_at desc);

create index if not exists idx_billing_usage_events_workspace_unsent
on public.billing_usage_events (workspace_id, stripe_sent_at)
where stripe_sent_at is null;

create unique index if not exists uniq_billing_usage_events_trace_source_span
on public.billing_usage_events (workspace_id, trace_id, source, span_id);

alter table public.billing_usage_events enable row level security;

drop policy if exists "billing_usage_events_select_member" on public.billing_usage_events;
create policy "billing_usage_events_select_member"
on public.billing_usage_events for select
using (public.is_workspace_member(workspace_id));

-- ======================
-- Tool invocation events
-- ======================
create table if not exists public.billing_tool_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  turn_id text not null,
  trace_id text not null,

  tool_call_id text not null,
  tool_name text not null,
  agent text null,

  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_billing_tool_events_workspace_created
on public.billing_tool_events (workspace_id, created_at desc);

create unique index if not exists uniq_billing_tool_events_trace_call
on public.billing_tool_events (workspace_id, trace_id, tool_call_id);

alter table public.billing_tool_events enable row level security;

drop policy if exists "billing_tool_events_select_member" on public.billing_tool_events;
create policy "billing_tool_events_select_member"
on public.billing_tool_events for select
using (public.is_workspace_member(workspace_id));

-- ==========================================
-- Stripe flush windows (idempotency + audits)
-- ==========================================
create table if not exists public.billing_stripe_flush_windows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,

  window_start timestamptz not null,
  window_end timestamptz not null,

  total_tokens bigint not null,
  usage_event_ids uuid[] null,

  -- A stable idempotency key used for Stripe API calls.
  stripe_idempotency_key text not null,

  status text not null default 'pending'
    check (status in ('pending', 'sent', 'error')),
  stripe_event_id text null,
  error text null,

  created_at timestamptz not null default now(),
  sent_at timestamptz null
);

create unique index if not exists uniq_billing_stripe_flush_window
on public.billing_stripe_flush_windows (workspace_id, window_start, window_end);

create unique index if not exists uniq_billing_stripe_flush_idem
on public.billing_stripe_flush_windows (stripe_idempotency_key);

alter table public.billing_stripe_flush_windows enable row level security;

drop policy if exists "billing_stripe_flush_windows_select_member" on public.billing_stripe_flush_windows;
create policy "billing_stripe_flush_windows_select_member"
on public.billing_stripe_flush_windows for select
using (public.is_workspace_member(workspace_id));

