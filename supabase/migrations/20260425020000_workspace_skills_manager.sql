-- Workspace Skills Manager
-- Git remains the source of truth. Flow stores repo/artifact metadata,
-- assignments, sync status, and audit events, but not skill/doc contents.

create extension if not exists "pgcrypto";

create table if not exists public.workspace_skill_repositories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  repo_url text not null,
  label text not null,
  default_ref text not null default 'main',
  status text not null default 'active',
  last_commit_sha text null,
  last_synced_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_skill_repositories_status_check
    check (status in ('active', 'archived', 'error')),
  constraint workspace_skill_repositories_unique_url
    unique (workspace_id, repo_url)
);

create index if not exists workspace_skill_repositories_workspace_idx
  on public.workspace_skill_repositories(workspace_id, updated_at desc);

create table if not exists public.workspace_skill_artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  repository_id uuid not null references public.workspace_skill_repositories(id) on delete cascade,
  artifact_type text not null,
  slug text not null,
  name text not null,
  description text not null default '',
  relative_path text not null,
  exact_filename text null,
  targets jsonb not null default '[]'::jsonb,
  checksum text not null,
  commit_sha text null,
  lifecycle text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  risk_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_skill_artifacts_type_check
    check (artifact_type in ('skill', 'instruction_doc')),
  constraint workspace_skill_artifacts_lifecycle_check
    check (lifecycle in ('active', 'deprecated', 'archived')),
  constraint workspace_skill_artifacts_repo_path_unique
    unique (repository_id, relative_path)
);

create index if not exists workspace_skill_artifacts_workspace_idx
  on public.workspace_skill_artifacts(workspace_id, artifact_type, updated_at desc);

create table if not exists public.workspace_skill_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  artifact_id uuid not null references public.workspace_skill_artifacts(id) on delete cascade,
  agent_id uuid null references public.agents(id) on delete cascade,
  target text not null default 'all',
  scope text not null default 'workspace',
  enabled boolean not null default true,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_skill_assignments_target_check
    check (target in ('all', 'flow', 'claude', 'codex')),
  constraint workspace_skill_assignments_scope_check
    check (scope in ('workspace', 'agent'))
);

create index if not exists workspace_skill_assignments_workspace_idx
  on public.workspace_skill_assignments(workspace_id, enabled, updated_at desc);
create unique index if not exists workspace_skill_assignments_workspace_unique_idx
  on public.workspace_skill_assignments(workspace_id, artifact_id, target)
  where agent_id is null;
create unique index if not exists workspace_skill_assignments_agent_unique_idx
  on public.workspace_skill_assignments(workspace_id, artifact_id, agent_id, target)
  where agent_id is not null;

create table if not exists public.workspace_skill_device_syncs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  repository_id uuid not null references public.workspace_skill_repositories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  status text not null default 'never',
  local_path text null,
  commit_sha text null,
  last_error_code text null,
  last_error_message text null,
  diagnostics jsonb not null default '{}'::jsonb,
  synced_at timestamptz null,
  materialized_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint workspace_skill_device_syncs_status_check
    check (status in ('never', 'synced', 'no_permission', 'offline', 'error')),
  constraint workspace_skill_device_syncs_unique
    unique (repository_id, user_id, device_id)
);

create index if not exists workspace_skill_device_syncs_workspace_idx
  on public.workspace_skill_device_syncs(workspace_id, user_id, device_id, updated_at desc);

create table if not exists public.workspace_skill_sync_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  repository_id uuid not null references public.workspace_skill_repositories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  operation text not null default 'sync',
  status text not null default 'running',
  commit_sha text null,
  artifacts_count integer not null default 0,
  error_code text null,
  error_message text null,
  diagnostics jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint workspace_skill_sync_runs_operation_check
    check (operation in ('check', 'sync', 'scan', 'create', 'materialize', 'preflight')),
  constraint workspace_skill_sync_runs_status_check
    check (status in ('running', 'success', 'no_permission', 'error'))
);

create index if not exists workspace_skill_sync_runs_workspace_idx
  on public.workspace_skill_sync_runs(workspace_id, started_at desc);

create table if not exists public.workspace_skill_audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  repository_id uuid null references public.workspace_skill_repositories(id) on delete set null,
  artifact_id uuid null references public.workspace_skill_artifacts(id) on delete set null,
  assignment_id uuid null references public.workspace_skill_assignments(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists workspace_skill_audit_events_workspace_idx
  on public.workspace_skill_audit_events(workspace_id, created_at desc);

alter table public.workspace_skill_repositories enable row level security;
alter table public.workspace_skill_artifacts enable row level security;
alter table public.workspace_skill_assignments enable row level security;
alter table public.workspace_skill_device_syncs enable row level security;
alter table public.workspace_skill_sync_runs enable row level security;
alter table public.workspace_skill_audit_events enable row level security;

drop policy if exists "workspace_skill_repositories_select_member" on public.workspace_skill_repositories;
create policy "workspace_skill_repositories_select_member"
on public.workspace_skill_repositories for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_skill_repositories_admin_write" on public.workspace_skill_repositories;
create policy "workspace_skill_repositories_admin_write"
on public.workspace_skill_repositories for all
using (public.is_workspace_admin(workspace_id))
with check (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_skill_artifacts_select_member" on public.workspace_skill_artifacts;
create policy "workspace_skill_artifacts_select_member"
on public.workspace_skill_artifacts for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_skill_artifacts_admin_write" on public.workspace_skill_artifacts;
create policy "workspace_skill_artifacts_admin_write"
on public.workspace_skill_artifacts for all
using (public.is_workspace_admin(workspace_id))
with check (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_skill_assignments_select_member" on public.workspace_skill_assignments;
create policy "workspace_skill_assignments_select_member"
on public.workspace_skill_assignments for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_skill_assignments_admin_write" on public.workspace_skill_assignments;
create policy "workspace_skill_assignments_admin_write"
on public.workspace_skill_assignments for all
using (public.is_workspace_admin(workspace_id))
with check (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_skill_device_syncs_select_member" on public.workspace_skill_device_syncs;
create policy "workspace_skill_device_syncs_select_member"
on public.workspace_skill_device_syncs for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_skill_device_syncs_member_write_own" on public.workspace_skill_device_syncs;
create policy "workspace_skill_device_syncs_member_write_own"
on public.workspace_skill_device_syncs for all
using (auth.uid() = user_id and public.is_workspace_member(workspace_id))
with check (auth.uid() = user_id and public.is_workspace_member(workspace_id));

drop policy if exists "workspace_skill_sync_runs_select_member" on public.workspace_skill_sync_runs;
create policy "workspace_skill_sync_runs_select_member"
on public.workspace_skill_sync_runs for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_skill_sync_runs_member_insert" on public.workspace_skill_sync_runs;
create policy "workspace_skill_sync_runs_member_insert"
on public.workspace_skill_sync_runs for insert
with check (auth.uid() = user_id and public.is_workspace_member(workspace_id));

drop policy if exists "workspace_skill_audit_events_select_member" on public.workspace_skill_audit_events;
create policy "workspace_skill_audit_events_select_member"
on public.workspace_skill_audit_events for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_skill_audit_events_member_insert" on public.workspace_skill_audit_events;
create policy "workspace_skill_audit_events_member_insert"
on public.workspace_skill_audit_events for insert
with check (auth.uid() = actor_user_id and public.is_workspace_member(workspace_id));
