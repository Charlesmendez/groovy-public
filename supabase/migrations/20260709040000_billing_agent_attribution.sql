-- Harness pivot: attribute billing events to agents and harnesses so the
-- usage dashboard can break spend down by agent and the optimizer can join
-- usage to task outcomes.

alter table public.billing_usage_events
  add column if not exists agent_id uuid null references public.agents (id) on delete set null,
  add column if not exists harness text null;

alter table public.billing_tool_events
  add column if not exists agent_id uuid null references public.agents (id) on delete set null;

create index if not exists idx_billing_usage_events_workspace_agent
on public.billing_usage_events (workspace_id, agent_id, created_at desc)
where agent_id is not null;

create index if not exists idx_billing_tool_events_workspace_agent
on public.billing_tool_events (workspace_id, agent_id, created_at desc)
where agent_id is not null;
