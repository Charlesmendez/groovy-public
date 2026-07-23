-- Harness pivot: context transfers between agents.
-- Stores the summarized context moved from one agent (or the orchestrator)
-- to another. The summary is injected into the target's next prompt.

create table if not exists public.context_transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  from_agent_id uuid null references public.agents (id) on delete set null,
  to_agent_id uuid not null references public.agents (id) on delete cascade,
  summary text not null,
  source_kind text not null
    check (source_kind in ('worker_thread', 'orchestrator_session', 'manual')),
  source_ref text null,
  -- Set once the summary has been delivered into the target's prompt.
  consumed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists context_transfers_user_created_idx
on public.context_transfers (user_id, created_at desc);

-- Pending-injection lookup for the target agent.
create index if not exists context_transfers_to_agent_pending_idx
on public.context_transfers (to_agent_id, created_at)
where consumed_at is null;

alter table public.context_transfers enable row level security;

drop policy if exists "context_transfers_select_own" on public.context_transfers;
drop policy if exists "context_transfers_insert_own" on public.context_transfers;
drop policy if exists "context_transfers_update_own" on public.context_transfers;
drop policy if exists "context_transfers_delete_own" on public.context_transfers;

create policy "context_transfers_select_own"
on public.context_transfers
for select
using (auth.uid() = user_id);

create policy "context_transfers_insert_own"
on public.context_transfers
for insert
with check (
  auth.uid() = user_id
  and (
    from_agent_id is null
    or exists (
      select 1 from public.agents source_agent
      where source_agent.id = from_agent_id and source_agent.user_id = auth.uid()
    )
  )
  and exists (
    select 1 from public.agents target_agent
    where target_agent.id = to_agent_id
      and target_agent.user_id = auth.uid()
      and target_agent.type = 'claude-code'
  )
);

create policy "context_transfers_update_own"
on public.context_transfers
for update
using (auth.uid() = user_id)
with check (
  auth.uid() = user_id
  and (
    from_agent_id is null
    or exists (
      select 1 from public.agents source_agent
      where source_agent.id = from_agent_id and source_agent.user_id = auth.uid()
    )
  )
  and exists (
    select 1 from public.agents target_agent
    where target_agent.id = to_agent_id
      and target_agent.user_id = auth.uid()
      and target_agent.type = 'claude-code'
  )
);

create policy "context_transfers_delete_own"
on public.context_transfers
for delete
using (auth.uid() = user_id);
