-- Workspace-scoped secret declarations and local-device readiness.
-- Secret values never enter Postgres. They are encrypted by the Connector on
-- each device; these tables contain names, capability grants, and readiness only.

create extension if not exists "pgcrypto";

create table if not exists public.workspace_secret_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  key text not null,
  description text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_secret_definitions_key_format
    check (key ~ '^[A-Z][A-Z0-9_]{1,127}$'),
  constraint workspace_secret_definitions_unique_key unique (workspace_id, key)
);

create table if not exists public.workspace_secret_profile_grants (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  secret_id uuid not null references public.workspace_secret_definitions(id) on delete cascade,
  profile_id uuid not null references public.orchestrator_profiles(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (secret_id, profile_id)
);

create table if not exists public.workspace_secret_agent_grants (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  secret_id uuid not null references public.workspace_secret_definitions(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (secret_id, agent_id)
);

create table if not exists public.workspace_secret_artifact_grants (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  secret_id uuid not null references public.workspace_secret_definitions(id) on delete cascade,
  artifact_id uuid not null references public.workspace_skill_artifacts(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (secret_id, artifact_id)
);

create table if not exists public.workspace_secret_device_readiness (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  secret_id uuid not null references public.workspace_secret_definitions(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  configured boolean not null default false,
  configured_at timestamptz null,
  updated_at timestamptz not null default now(),
  primary key (secret_id, device_id)
);

create index if not exists workspace_secret_definitions_workspace_idx
  on public.workspace_secret_definitions(workspace_id, name);
create index if not exists workspace_secret_profile_grants_profile_idx
  on public.workspace_secret_profile_grants(workspace_id, profile_id);
create index if not exists workspace_secret_agent_grants_agent_idx
  on public.workspace_secret_agent_grants(workspace_id, agent_id);
create index if not exists workspace_secret_artifact_grants_artifact_idx
  on public.workspace_secret_artifact_grants(workspace_id, artifact_id);
create index if not exists workspace_secret_device_readiness_device_idx
  on public.workspace_secret_device_readiness(workspace_id, device_id, configured);

alter table public.workspace_secret_definitions enable row level security;
alter table public.workspace_secret_profile_grants enable row level security;
alter table public.workspace_secret_agent_grants enable row level security;
alter table public.workspace_secret_artifact_grants enable row level security;
alter table public.workspace_secret_device_readiness enable row level security;

-- Secret metadata and assignments are intentionally admin-only. Guest users
-- can invoke an assigned Mind action, but cannot enumerate workspace secrets.
create policy "workspace_secret_definitions_admin_all"
  on public.workspace_secret_definitions for all
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy "workspace_secret_profile_grants_admin_all"
  on public.workspace_secret_profile_grants for all
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy "workspace_secret_agent_grants_admin_all"
  on public.workspace_secret_agent_grants for all
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy "workspace_secret_artifact_grants_admin_all"
  on public.workspace_secret_artifact_grants for all
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
create policy "workspace_secret_device_readiness_admin_all"
  on public.workspace_secret_device_readiness for all
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));
