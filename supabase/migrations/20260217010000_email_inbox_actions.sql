-- Conversational email triage queue for heartbeat/web/whatsapp.

create extension if not exists "pgcrypto";

create table if not exists public.email_sender_intel_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sender_domain text not null,
  sender_email text null,
  reputation text null,
  confidence numeric null,
  summary text null,
  signals jsonb not null default '{}'::jsonb,
  source text not null default 'search',
  fetched_at timestamptz not null default now(),
  expires_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_sender_intel_cache_unique unique (user_id, sender_domain)
);

create index if not exists email_sender_intel_cache_user_idx
  on public.email_sender_intel_cache(user_id, sender_domain, updated_at desc);

alter table public.email_sender_intel_cache enable row level security;

drop policy if exists "email_sender_intel_cache_select_own" on public.email_sender_intel_cache;
drop policy if exists "email_sender_intel_cache_insert_own" on public.email_sender_intel_cache;
drop policy if exists "email_sender_intel_cache_update_own" on public.email_sender_intel_cache;
drop policy if exists "email_sender_intel_cache_delete_own" on public.email_sender_intel_cache;

create policy "email_sender_intel_cache_select_own"
on public.email_sender_intel_cache
for select
using (auth.uid() = user_id);

create policy "email_sender_intel_cache_insert_own"
on public.email_sender_intel_cache
for insert
with check (auth.uid() = user_id);

create policy "email_sender_intel_cache_update_own"
on public.email_sender_intel_cache
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "email_sender_intel_cache_delete_own"
on public.email_sender_intel_cache
for delete
using (auth.uid() = user_id);

create table if not exists public.email_sender_affinity_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id text not null,
  sender_email text not null,
  incoming_count integer not null default 0,
  replied_count integer not null default 0,
  last_received_at timestamptz null,
  last_replied_at timestamptz null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_sender_affinity_cache_unique unique (user_id, connection_id, sender_email)
);

create index if not exists email_sender_affinity_cache_user_idx
  on public.email_sender_affinity_cache(user_id, connection_id, sender_email, updated_at desc);

alter table public.email_sender_affinity_cache enable row level security;

drop policy if exists "email_sender_affinity_cache_select_own" on public.email_sender_affinity_cache;
drop policy if exists "email_sender_affinity_cache_insert_own" on public.email_sender_affinity_cache;
drop policy if exists "email_sender_affinity_cache_update_own" on public.email_sender_affinity_cache;
drop policy if exists "email_sender_affinity_cache_delete_own" on public.email_sender_affinity_cache;

create policy "email_sender_affinity_cache_select_own"
on public.email_sender_affinity_cache
for select
using (auth.uid() = user_id);

create policy "email_sender_affinity_cache_insert_own"
on public.email_sender_affinity_cache
for insert
with check (auth.uid() = user_id);

create policy "email_sender_affinity_cache_update_own"
on public.email_sender_affinity_cache
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "email_sender_affinity_cache_delete_own"
on public.email_sender_affinity_cache
for delete
using (auth.uid() = user_id);

create table if not exists public.inbox_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid null references public.orchestrator_sessions(id) on delete set null,
  source_job_id uuid null references public.scheduled_jobs(id) on delete set null,
  run_id text null,

  provider text not null default 'gmail',
  connection_id text not null,
  mailbox_label text null,

  gmail_message_id text not null,
  gmail_thread_id text null,
  gmail_draft_id text null,

  sender_email text null,
  sender_name text null,
  sender_domain text null,
  subject text null,
  snippet text null,
  received_at timestamptz null,

  recommended_action text not null,
  status text not null default 'pending',

  confidence numeric null,
  p_important numeric null,
  p_spam numeric null,
  p_actionable numeric null,

  reason text null,
  draft_to jsonb null,
  draft_subject text null,
  draft_body text null,
  metadata jsonb not null default '{}'::jsonb,

  executed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint inbox_actions_recommended_action_check
    check (recommended_action in ('draft_reply', 'mark_spam', 'unsubscribe', 'archive', 'label_only')),
  constraint inbox_actions_status_check
    check (status in ('pending', 'approved', 'executing', 'done', 'rejected', 'failed')),
  constraint inbox_actions_unique_message_action
    unique (user_id, provider, connection_id, gmail_message_id, recommended_action)
);

create index if not exists inbox_actions_user_status_idx
  on public.inbox_actions(user_id, status, created_at desc);

create index if not exists inbox_actions_session_idx
  on public.inbox_actions(user_id, session_id, status, created_at desc);

create index if not exists inbox_actions_connection_idx
  on public.inbox_actions(user_id, connection_id, created_at desc);

alter table public.inbox_actions enable row level security;

drop policy if exists "inbox_actions_select_own" on public.inbox_actions;
drop policy if exists "inbox_actions_insert_own" on public.inbox_actions;
drop policy if exists "inbox_actions_update_own" on public.inbox_actions;
drop policy if exists "inbox_actions_delete_own" on public.inbox_actions;

create policy "inbox_actions_select_own"
on public.inbox_actions
for select
using (auth.uid() = user_id);

create policy "inbox_actions_insert_own"
on public.inbox_actions
for insert
with check (auth.uid() = user_id);

create policy "inbox_actions_update_own"
on public.inbox_actions
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "inbox_actions_delete_own"
on public.inbox_actions
for delete
using (auth.uid() = user_id);

create table if not exists public.inbox_action_aliases (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.orchestrator_sessions(id) on delete cascade,
  alias integer not null check (alias > 0),
  action_id uuid not null references public.inbox_actions(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, session_id, alias),
  constraint inbox_action_aliases_unique_action unique (action_id)
);

create index if not exists inbox_action_aliases_session_idx
  on public.inbox_action_aliases(user_id, session_id, alias);

alter table public.inbox_action_aliases enable row level security;

drop policy if exists "inbox_action_aliases_select_own" on public.inbox_action_aliases;
drop policy if exists "inbox_action_aliases_insert_own" on public.inbox_action_aliases;
drop policy if exists "inbox_action_aliases_update_own" on public.inbox_action_aliases;
drop policy if exists "inbox_action_aliases_delete_own" on public.inbox_action_aliases;

create policy "inbox_action_aliases_select_own"
on public.inbox_action_aliases
for select
using (auth.uid() = user_id);

create policy "inbox_action_aliases_insert_own"
on public.inbox_action_aliases
for insert
with check (auth.uid() = user_id);

create policy "inbox_action_aliases_update_own"
on public.inbox_action_aliases
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "inbox_action_aliases_delete_own"
on public.inbox_action_aliases
for delete
using (auth.uid() = user_id);

