-- Agent ACL for workspace/invited-user access + request fanout by agent scope.

create table if not exists public.workspace_orchestrator_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (workspace_id, agent_id)
);

create index if not exists idx_workspace_orch_agents_workspace
  on public.workspace_orchestrator_agents(workspace_id, created_at desc);

create index if not exists idx_workspace_orch_agents_agent
  on public.workspace_orchestrator_agents(agent_id);

alter table public.workspace_orchestrator_agents enable row level security;

drop policy if exists "Workspace members can view shared agents" on public.workspace_orchestrator_agents;
drop policy if exists "Workspace members can share agents" on public.workspace_orchestrator_agents;
drop policy if exists "Workspace admins can unshare agents" on public.workspace_orchestrator_agents;

create policy "Workspace members can view shared agents" on public.workspace_orchestrator_agents
  for select using (public.is_workspace_member(workspace_id));

create policy "Workspace members can share agents" on public.workspace_orchestrator_agents
  for insert with check (public.is_workspace_member(workspace_id));

create policy "Workspace admins can unshare agents" on public.workspace_orchestrator_agents
  for delete using (public.is_workspace_admin(workspace_id));

create table if not exists public.orchestrator_agent_members (
  agent_id uuid not null references public.agents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer',
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (agent_id, user_id),
  constraint orchestrator_agent_members_role_check
    check (role in ('owner', 'editor', 'viewer'))
);

create index if not exists idx_orchestrator_agent_members_user
  on public.orchestrator_agent_members(user_id, updated_at desc);

alter table public.orchestrator_agent_members enable row level security;

drop policy if exists "orchestrator_agent_members_select_visible" on public.orchestrator_agent_members;
drop policy if exists "orchestrator_agent_members_insert_owner" on public.orchestrator_agent_members;
drop policy if exists "orchestrator_agent_members_update_owner" on public.orchestrator_agent_members;
drop policy if exists "orchestrator_agent_members_delete_owner" on public.orchestrator_agent_members;

create policy "orchestrator_agent_members_select_visible"
on public.orchestrator_agent_members
for select
using (
  auth.uid() = user_id
  or exists (
    select 1
    from public.agents a
    where a.id = orchestrator_agent_members.agent_id
      and a.user_id = auth.uid()
  )
);

create policy "orchestrator_agent_members_insert_owner"
on public.orchestrator_agent_members
for insert
with check (
  exists (
    select 1
    from public.agents a
    where a.id = orchestrator_agent_members.agent_id
      and a.user_id = auth.uid()
  )
);

create policy "orchestrator_agent_members_update_owner"
on public.orchestrator_agent_members
for update
using (
  exists (
    select 1
    from public.agents a
    where a.id = orchestrator_agent_members.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.agents a
    where a.id = orchestrator_agent_members.agent_id
      and a.user_id = auth.uid()
  )
);

create policy "orchestrator_agent_members_delete_owner"
on public.orchestrator_agent_members
for delete
using (
  exists (
    select 1
    from public.agents a
    where a.id = orchestrator_agent_members.agent_id
      and a.user_id = auth.uid()
  )
);

-- Allow reading shared agents through workspace + direct agent ACL.
drop policy if exists "agents_select_shared_acl" on public.agents;
create policy "agents_select_shared_acl"
on public.agents
for select
using (
  exists (
    select 1
    from public.workspace_orchestrator_agents wa
    join public.workspace_members wm on wm.workspace_id = wa.workspace_id
    where wa.agent_id = agents.id
      and wm.user_id = auth.uid()
  )
  or exists (
    select 1
    from public.orchestrator_agent_members am
    where am.agent_id = agents.id
      and am.user_id = auth.uid()
  )
);

-- Optional read expansion for session/message visibility when sharing happens at agent scope.
drop policy if exists "Workspace members can view sessions shared by agent ACL" on public.orchestrator_sessions;
create policy "Workspace members can view sessions shared by agent ACL" on public.orchestrator_sessions
  for select using (
    exists (
      select 1
      from public.orchestrator_session_runtime osr
      join public.workspace_orchestrator_agents wa on wa.agent_id = osr.agent_id
      join public.workspace_members wm on wm.workspace_id = wa.workspace_id
      where osr.session_id = orchestrator_sessions.id
        and wm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.orchestrator_session_runtime osr
      join public.orchestrator_agent_members am on am.agent_id = osr.agent_id
      where osr.session_id = orchestrator_sessions.id
        and am.user_id = auth.uid()
    )
  );

drop policy if exists "Workspace members can view shared orchestrator messages by agent ACL" on public.orchestrator_messages;
create policy "Workspace members can view shared orchestrator messages by agent ACL" on public.orchestrator_messages
  for select using (
    agent_id is not null and (
      exists (
        select 1
        from public.workspace_orchestrator_agents wa
        join public.workspace_members wm on wm.workspace_id = wa.workspace_id
        where wa.agent_id = orchestrator_messages.agent_id
          and wm.user_id = auth.uid()
      )
      or exists (
        select 1
        from public.orchestrator_agent_members am
        where am.agent_id = orchestrator_messages.agent_id
          and am.user_id = auth.uid()
      )
    )
  );

-- Backfill shared agents from existing shared sessions.
insert into public.workspace_orchestrator_agents (workspace_id, agent_id, created_by_user_id)
select distinct ws.workspace_id, osr.agent_id, ws.created_by_user_id
from public.workspace_orchestrator_sessions ws
join public.orchestrator_session_runtime osr on osr.session_id = ws.session_id
where osr.agent_id is not null
on conflict (workspace_id, agent_id) do nothing;

-- workspace_orchestrator_requests: support agent scope (session optional)
alter table public.workspace_orchestrator_requests
  add column if not exists agent_id uuid references public.agents(id) on delete cascade;

update public.workspace_orchestrator_requests wor
set agent_id = osr.agent_id
from public.orchestrator_session_runtime osr
where wor.session_id = osr.session_id
  and wor.agent_id is null
  and osr.agent_id is not null;

alter table public.workspace_orchestrator_requests
  alter column session_id drop not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspace_orchestrator_requests_scope_check'
      and conrelid = 'public.workspace_orchestrator_requests'::regclass
  ) then
    alter table public.workspace_orchestrator_requests
      add constraint workspace_orchestrator_requests_scope_check
      check (session_id is not null or agent_id is not null);
  end if;
end $$;

create index if not exists idx_workspace_orch_requests_agent
  on public.workspace_orchestrator_requests(agent_id, created_at asc)
  where agent_id is not null;

create unique index if not exists uniq_workspace_orch_requests_agent_dedupe
  on public.workspace_orchestrator_requests(agent_id, requested_user_id, dedupe_key)
  where dedupe_key is not null and agent_id is not null;

drop policy if exists "workspace_orch_requests_insert" on public.workspace_orchestrator_requests;
create policy "workspace_orch_requests_insert"
on public.workspace_orchestrator_requests
for insert
with check (
  auth.uid() = requested_by_user_id
  and public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = workspace_orchestrator_requests.workspace_id
      and wm.user_id = workspace_orchestrator_requests.requested_user_id
  )
  and (
    (
      session_id is not null
      and exists (
        select 1 from public.workspace_orchestrator_sessions ws
        where ws.workspace_id = workspace_orchestrator_requests.workspace_id
          and ws.session_id = workspace_orchestrator_requests.session_id
      )
    )
    or
    (
      agent_id is not null
      and exists (
        select 1 from public.workspace_orchestrator_agents wa
        where wa.workspace_id = workspace_orchestrator_requests.workspace_id
          and wa.agent_id = workspace_orchestrator_requests.agent_id
      )
    )
  )
);
