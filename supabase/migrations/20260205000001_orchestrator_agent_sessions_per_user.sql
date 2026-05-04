-- Allow each workspace member to have their own agent-session links per orchestrator session.
-- This is required for shared sessions so each participant can link their own Files session.

-- Replace unique index (session_id, agent_type) -> (user_id, session_id, agent_type)
drop index if exists public.orchestrator_agent_sessions_unique;
create unique index if not exists orchestrator_agent_sessions_unique
  on public.orchestrator_agent_sessions(user_id, orchestrator_session_id, agent_type);

-- Tighten insert policy: user can insert only for sessions they can see (owned OR workspace-shared).
drop policy if exists "orchestrator_agent_sessions_insert_own" on public.orchestrator_agent_sessions;
create policy "orchestrator_agent_sessions_insert_own"
on public.orchestrator_agent_sessions
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.orchestrator_sessions os
    where os.id = orchestrator_agent_sessions.orchestrator_session_id
  )
);

