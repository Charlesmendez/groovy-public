-- Workspace-shared orchestrator sessions
create table if not exists public.workspace_orchestrator_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.orchestrator_sessions(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (workspace_id, session_id)
);

create index if not exists idx_workspace_orch_sessions_workspace
  on public.workspace_orchestrator_sessions(workspace_id, created_at desc);

create index if not exists idx_workspace_orch_sessions_session
  on public.workspace_orchestrator_sessions(session_id);

alter table public.workspace_orchestrator_sessions enable row level security;

create policy "Workspace members can view shared sessions" on public.workspace_orchestrator_sessions
  for select using (public.is_workspace_member(workspace_id));

create policy "Workspace members can share sessions" on public.workspace_orchestrator_sessions
  for insert with check (public.is_workspace_member(workspace_id));

create policy "Workspace admins can unshare sessions" on public.workspace_orchestrator_sessions
  for delete using (public.is_workspace_admin(workspace_id));

-- Allow workspace members to read shared sessions, messages, and activity
create policy "Workspace members can view shared orchestrator sessions" on public.orchestrator_sessions
  for select using (
    exists (
      select 1
      from public.workspace_orchestrator_sessions ws
      join public.workspace_members wm on wm.workspace_id = ws.workspace_id
      where ws.session_id = orchestrator_sessions.id
        and wm.user_id = auth.uid()
    )
  );

create policy "Workspace members can view shared orchestrator messages" on public.orchestrator_messages
  for select using (
    exists (
      select 1
      from public.workspace_orchestrator_sessions ws
      join public.workspace_members wm on wm.workspace_id = ws.workspace_id
      where ws.session_id = orchestrator_messages.session_id
        and wm.user_id = auth.uid()
    )
  );

create policy "Workspace members can view shared activity" on public.activity_log
  for select using (
    exists (
      select 1
      from public.workspace_orchestrator_sessions ws
      join public.workspace_members wm on wm.workspace_id = ws.workspace_id
      where ws.session_id = activity_log.session_id
        and wm.user_id = auth.uid()
    )
  );
