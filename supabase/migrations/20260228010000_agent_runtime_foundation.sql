-- Agent runtime foundation:
-- 1) scheduled jobs are owned by an agent
-- 2) orchestrator messages can be scoped by agent (not only session)

-- ---------------------------------------------------------------------------
-- scheduled_jobs: add agent ownership
-- ---------------------------------------------------------------------------
alter table public.scheduled_jobs
  add column if not exists agent_id uuid references public.agents(id) on delete set null;

create index if not exists scheduled_jobs_agent_id_idx
  on public.scheduled_jobs (agent_id)
  where agent_id is not null;

create index if not exists scheduled_jobs_user_agent_updated_idx
  on public.scheduled_jobs (user_id, agent_id, updated_at desc)
  where agent_id is not null;

-- ---------------------------------------------------------------------------
-- orchestrator_messages: add agent scope and relax session requirement
-- ---------------------------------------------------------------------------
alter table public.orchestrator_messages
  add column if not exists agent_id uuid references public.agents(id) on delete set null;

alter table public.orchestrator_messages
  alter column session_id drop not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_messages_scope_check'
  ) then
    alter table public.orchestrator_messages
      add constraint orchestrator_messages_scope_check
      check (session_id is not null or agent_id is not null);
  end if;
end $$;

create index if not exists idx_orchestrator_messages_agent_created
  on public.orchestrator_messages (agent_id, created_at)
  where agent_id is not null;

-- ---------------------------------------------------------------------------
-- RLS insert policy: allow inserts into either visible sessions or owned agents
-- ---------------------------------------------------------------------------
drop policy if exists "Users can insert own orchestrator messages" on public.orchestrator_messages;
drop policy if exists "Users can insert messages into visible sessions" on public.orchestrator_messages;
drop policy if exists "Users can insert messages into visible runtime scopes" on public.orchestrator_messages;

create policy "Users can insert messages into visible runtime scopes"
on public.orchestrator_messages
for insert
with check (
  auth.uid() = user_id
  and (
    (
      session_id is not null
      and exists (
        select 1
        from public.orchestrator_sessions os
        where os.id = orchestrator_messages.session_id
      )
    )
    or
    (
      agent_id is not null
      and exists (
        select 1
        from public.agents a
        where a.id = orchestrator_messages.agent_id
          and a.user_id = auth.uid()
      )
    )
  )
);
