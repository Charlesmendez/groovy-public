-- Workspace cells: admin-defined objective tracking around an existing agent.
-- A cell can have one or more humans, references an existing workspace-visible agent,
-- and stores AI-generated KR/framework data plus cached signal classifications.

create extension if not exists "pgcrypto";

create table if not exists public.workspace_cells (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  name text not null,
  objective text not null,
  objective_summary text null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'paused', 'archived')),
  privacy_mode text not null default 'workspace'
    check (privacy_mode in ('workspace', 'admin_only')),
  okr_generation_version text null,
  framework jsonb not null default '{}'::jsonb,
  analytics_cache jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, agent_id)
);

create index if not exists idx_workspace_cells_workspace_updated
  on public.workspace_cells(workspace_id, updated_at desc);

create index if not exists idx_workspace_cells_owner
  on public.workspace_cells(owner_user_id, updated_at desc);

create table if not exists public.workspace_cell_members (
  cell_id uuid not null references public.workspace_cells(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member'
    check (role in ('leader', 'member')),
  weight numeric null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (cell_id, user_id)
);

create index if not exists idx_workspace_cell_members_user
  on public.workspace_cell_members(user_id, updated_at desc);

create table if not exists public.workspace_cell_key_results (
  id uuid primary key default gen_random_uuid(),
  cell_id uuid not null references public.workspace_cells(id) on delete cascade,
  position integer not null default 0,
  label text not null,
  description text null,
  measurement_mode text not null default 'computed'
    check (measurement_mode in ('computed', 'hybrid', 'manual')),
  evaluation_method text null,
  target_value text null,
  direction text not null default 'increase'
    check (direction in ('increase', 'decrease', 'maintain', 'binary')),
  status text not null default 'not_enough_signal'
    check (status in ('on_track', 'at_risk', 'off_track', 'not_enough_signal')),
  confidence numeric null,
  evaluation_cache jsonb not null default '{}'::jsonb,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_workspace_cell_key_results_cell_position
  on public.workspace_cell_key_results(cell_id, position asc, created_at asc);

create table if not exists public.workspace_cell_signal_classifications (
  id uuid primary key default gen_random_uuid(),
  cell_id uuid not null references public.workspace_cells(id) on delete cascade,
  artifact_type text not null,
  artifact_id text not null,
  user_id uuid null references auth.users(id) on delete set null,
  source text not null,
  content_hash text not null,
  classification jsonb not null default '{}'::jsonb,
  classified_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cell_id, artifact_type, artifact_id)
);

create index if not exists idx_workspace_cell_signal_classifications_cell_user
  on public.workspace_cell_signal_classifications(cell_id, user_id, updated_at desc);

create index if not exists idx_workspace_cell_signal_classifications_artifact
  on public.workspace_cell_signal_classifications(artifact_type, artifact_id);

alter table public.workspace_cells enable row level security;
alter table public.workspace_cell_members enable row level security;
alter table public.workspace_cell_key_results enable row level security;
alter table public.workspace_cell_signal_classifications enable row level security;

drop policy if exists "workspace_cells_select_member" on public.workspace_cells;
create policy "workspace_cells_select_member"
on public.workspace_cells
for select
using (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_cells_insert_admin" on public.workspace_cells;
create policy "workspace_cells_insert_admin"
on public.workspace_cells
for insert
with check (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_cells_update_admin" on public.workspace_cells;
create policy "workspace_cells_update_admin"
on public.workspace_cells
for update
using (public.is_workspace_admin(workspace_id))
with check (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_cells_delete_admin" on public.workspace_cells;
create policy "workspace_cells_delete_admin"
on public.workspace_cells
for delete
using (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_cell_members_select_member" on public.workspace_cell_members;
create policy "workspace_cell_members_select_member"
on public.workspace_cell_members
for select
using (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_members.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);

drop policy if exists "workspace_cell_members_insert_admin" on public.workspace_cell_members;
create policy "workspace_cell_members_insert_admin"
on public.workspace_cell_members
for insert
with check (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_members.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);

drop policy if exists "workspace_cell_members_update_admin" on public.workspace_cell_members;
create policy "workspace_cell_members_update_admin"
on public.workspace_cell_members
for update
using (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_members.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
)
with check (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_members.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);

drop policy if exists "workspace_cell_members_delete_admin" on public.workspace_cell_members;
create policy "workspace_cell_members_delete_admin"
on public.workspace_cell_members
for delete
using (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_members.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);

drop policy if exists "workspace_cell_key_results_select_member" on public.workspace_cell_key_results;
create policy "workspace_cell_key_results_select_member"
on public.workspace_cell_key_results
for select
using (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_key_results.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);

drop policy if exists "workspace_cell_key_results_insert_admin" on public.workspace_cell_key_results;
create policy "workspace_cell_key_results_insert_admin"
on public.workspace_cell_key_results
for insert
with check (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_key_results.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);

drop policy if exists "workspace_cell_key_results_update_admin" on public.workspace_cell_key_results;
create policy "workspace_cell_key_results_update_admin"
on public.workspace_cell_key_results
for update
using (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_key_results.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
)
with check (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_key_results.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);

drop policy if exists "workspace_cell_key_results_delete_admin" on public.workspace_cell_key_results;
create policy "workspace_cell_key_results_delete_admin"
on public.workspace_cell_key_results
for delete
using (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_key_results.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);

drop policy if exists "workspace_cell_signal_classifications_select_member" on public.workspace_cell_signal_classifications;
create policy "workspace_cell_signal_classifications_select_member"
on public.workspace_cell_signal_classifications
for select
using (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_signal_classifications.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);

drop policy if exists "workspace_cell_signal_classifications_insert_admin" on public.workspace_cell_signal_classifications;
create policy "workspace_cell_signal_classifications_insert_admin"
on public.workspace_cell_signal_classifications
for insert
with check (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_signal_classifications.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);

drop policy if exists "workspace_cell_signal_classifications_update_admin" on public.workspace_cell_signal_classifications;
create policy "workspace_cell_signal_classifications_update_admin"
on public.workspace_cell_signal_classifications
for update
using (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_signal_classifications.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
)
with check (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_signal_classifications.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);

drop policy if exists "workspace_cell_signal_classifications_delete_admin" on public.workspace_cell_signal_classifications;
create policy "workspace_cell_signal_classifications_delete_admin"
on public.workspace_cell_signal_classifications
for delete
using (
  exists (
    select 1
    from public.workspace_cells wc
    where wc.id = workspace_cell_signal_classifications.cell_id
      and public.is_workspace_admin(wc.workspace_id)
  )
);
