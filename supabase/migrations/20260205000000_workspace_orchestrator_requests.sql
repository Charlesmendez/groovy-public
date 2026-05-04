-- Workspace fan-out requests for shared orchestrator sessions
-- Used for "@alice @bob ..." style team requests where each recipient runs tools as themselves.

create table if not exists public.workspace_orchestrator_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.orchestrator_sessions(id) on delete cascade,
  requested_by_user_id uuid not null references auth.users(id) on delete cascade,
  requested_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'complete', 'error', 'cancelled')),
  request jsonb not null default '{}'::jsonb,
  result jsonb null,
  dedupe_key text null,
  expires_at timestamptz null,
  claimed_at timestamptz null,
  claimed_by_client_id text null,
  attempt_count int not null default 0,
  last_error text null,
  completed_at timestamptz null,
  cancelled_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_workspace_orch_requests_inbox
  on public.workspace_orchestrator_requests(requested_user_id, status, created_at desc);

create index if not exists idx_workspace_orch_requests_session
  on public.workspace_orchestrator_requests(session_id, created_at asc);

create unique index if not exists uniq_workspace_orch_requests_dedupe
  on public.workspace_orchestrator_requests(session_id, requested_user_id, dedupe_key)
  where dedupe_key is not null;

alter table public.workspace_orchestrator_requests enable row level security;

-- Read: only requester, requested user, or workspace admins
drop policy if exists "workspace_orch_requests_select" on public.workspace_orchestrator_requests;
create policy "workspace_orch_requests_select"
on public.workspace_orchestrator_requests
for select
using (
  auth.uid() = requested_by_user_id
  or auth.uid() = requested_user_id
  or public.is_workspace_admin(workspace_id)
);

-- Insert: requester must be a workspace member, target must be a member, and session must be shared into workspace.
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
  and exists (
    select 1 from public.workspace_orchestrator_sessions ws
    where ws.workspace_id = workspace_orchestrator_requests.workspace_id
      and ws.session_id = workspace_orchestrator_requests.session_id
  )
);

-- Update: requested user can update their own request rows; requester can cancel/update their own rows.
drop policy if exists "workspace_orch_requests_update_requested" on public.workspace_orchestrator_requests;
create policy "workspace_orch_requests_update_requested"
on public.workspace_orchestrator_requests
for update
using (auth.uid() = requested_user_id)
with check (auth.uid() = requested_user_id);

drop policy if exists "workspace_orch_requests_update_requester" on public.workspace_orchestrator_requests;
create policy "workspace_orch_requests_update_requester"
on public.workspace_orchestrator_requests
for update
using (auth.uid() = requested_by_user_id)
with check (auth.uid() = requested_by_user_id);

-- Realtime
alter publication supabase_realtime add table public.workspace_orchestrator_requests;

