-- Link orchestrator sessions to agent-specific sessions (e.g., Files agent chat_sessions)

-- 1) Add metadata to orchestrator messages so we can render rich outputs (files, dashboards, etc)
alter table public.orchestrator_messages
add column if not exists metadata jsonb not null default '{}'::jsonb;

-- 2) Mapping table from orchestrator_sessions -> chat_sessions (agent sessions)
create table if not exists public.orchestrator_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  orchestrator_session_id uuid not null references public.orchestrator_sessions(id) on delete cascade,
  agent_type text not null,
  agent_id uuid not null references public.agents(id) on delete cascade,
  agent_session_id uuid not null references public.chat_sessions(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists orchestrator_agent_sessions_unique
  on public.orchestrator_agent_sessions(orchestrator_session_id, agent_type);

create index if not exists orchestrator_agent_sessions_user_idx
  on public.orchestrator_agent_sessions(user_id, orchestrator_session_id);

alter table public.orchestrator_agent_sessions enable row level security;

drop policy if exists "orchestrator_agent_sessions_select_own" on public.orchestrator_agent_sessions;
drop policy if exists "orchestrator_agent_sessions_insert_own" on public.orchestrator_agent_sessions;
drop policy if exists "orchestrator_agent_sessions_delete_own" on public.orchestrator_agent_sessions;

create policy "orchestrator_agent_sessions_select_own"
on public.orchestrator_agent_sessions
for select
using (auth.uid() = user_id);

create policy "orchestrator_agent_sessions_insert_own"
on public.orchestrator_agent_sessions
for insert
with check (auth.uid() = user_id);

create policy "orchestrator_agent_sessions_delete_own"
on public.orchestrator_agent_sessions
for delete
using (auth.uid() = user_id);

