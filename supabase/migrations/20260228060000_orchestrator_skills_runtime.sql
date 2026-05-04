-- Persistent skills runtime:
-- - skill registry per agent with lifecycle states
-- - versioned skill source/runner
-- - scoped runtime state per agent/epoch/branch + skill version

create extension if not exists "pgcrypto";

create table if not exists public.orchestrator_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  slug text not null,
  name text not null,
  description text not null default '',
  lifecycle text not null default 'draft',
  runner text not null default 'code_cli_run',
  latest_version integer not null default 1,
  active_version_id uuid null,
  rollback_version_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orchestrator_skills_lifecycle_check
    check (lifecycle in ('draft', 'canary', 'stable', 'rollback', 'disabled')),
  constraint orchestrator_skills_runner_check
    check (runner in ('code_cli_run', 'terminal_exec')),
  constraint orchestrator_skills_latest_version_check
    check (latest_version >= 1),
  constraint orchestrator_skills_agent_slug_unique
    unique (agent_id, slug)
);

create index if not exists orchestrator_skills_user_agent_idx
  on public.orchestrator_skills (user_id, agent_id, updated_at desc);

create table if not exists public.orchestrator_skill_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  skill_id uuid not null references public.orchestrator_skills(id) on delete cascade,
  version integer not null,
  lifecycle text not null default 'draft',
  runner text not null default 'code_cli_run',
  source text not null,
  default_state jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orchestrator_skill_versions_lifecycle_check
    check (lifecycle in ('draft', 'canary', 'stable', 'rollback', 'archived')),
  constraint orchestrator_skill_versions_runner_check
    check (runner in ('code_cli_run', 'terminal_exec')),
  constraint orchestrator_skill_versions_skill_version_unique
    unique (skill_id, version)
);

create index if not exists orchestrator_skill_versions_skill_idx
  on public.orchestrator_skill_versions (skill_id, version desc);

create index if not exists orchestrator_skill_versions_user_agent_idx
  on public.orchestrator_skill_versions (user_id, agent_id, created_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_skills_active_version_fkey'
      and conrelid = 'public.orchestrator_skills'::regclass
  ) then
    alter table public.orchestrator_skills
      add constraint orchestrator_skills_active_version_fkey
      foreign key (active_version_id)
      references public.orchestrator_skill_versions(id)
      on delete set null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_skills_rollback_version_fkey'
      and conrelid = 'public.orchestrator_skills'::regclass
  ) then
    alter table public.orchestrator_skills
      add constraint orchestrator_skills_rollback_version_fkey
      foreign key (rollback_version_id)
      references public.orchestrator_skill_versions(id)
      on delete set null;
  end if;
end $$;

create table if not exists public.orchestrator_skill_runtime_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  skill_version_id uuid not null references public.orchestrator_skill_versions(id) on delete cascade,
  epoch_id uuid null references public.orchestrator_agent_epochs(id) on delete cascade,
  branch_id uuid null references public.orchestrator_branches(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orchestrator_skill_runtime_state_scope_unique
    unique (user_id, agent_id, skill_version_id, epoch_id, branch_id)
);

create index if not exists orchestrator_skill_runtime_state_scope_idx
  on public.orchestrator_skill_runtime_state (user_id, agent_id, epoch_id, branch_id, updated_at desc);

alter table public.orchestrator_skills enable row level security;
alter table public.orchestrator_skill_versions enable row level security;
alter table public.orchestrator_skill_runtime_state enable row level security;

drop policy if exists "orchestrator_skills_select_own" on public.orchestrator_skills;
drop policy if exists "orchestrator_skills_insert_own" on public.orchestrator_skills;
drop policy if exists "orchestrator_skills_update_own" on public.orchestrator_skills;
drop policy if exists "orchestrator_skills_delete_own" on public.orchestrator_skills;

create policy "orchestrator_skills_select_own"
on public.orchestrator_skills
for select
using (auth.uid() = user_id);

create policy "orchestrator_skills_insert_own"
on public.orchestrator_skills
for insert
with check (auth.uid() = user_id);

create policy "orchestrator_skills_update_own"
on public.orchestrator_skills
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "orchestrator_skills_delete_own"
on public.orchestrator_skills
for delete
using (auth.uid() = user_id);

drop policy if exists "orchestrator_skill_versions_select_own" on public.orchestrator_skill_versions;
drop policy if exists "orchestrator_skill_versions_insert_own" on public.orchestrator_skill_versions;
drop policy if exists "orchestrator_skill_versions_update_own" on public.orchestrator_skill_versions;
drop policy if exists "orchestrator_skill_versions_delete_own" on public.orchestrator_skill_versions;

create policy "orchestrator_skill_versions_select_own"
on public.orchestrator_skill_versions
for select
using (auth.uid() = user_id);

create policy "orchestrator_skill_versions_insert_own"
on public.orchestrator_skill_versions
for insert
with check (auth.uid() = user_id);

create policy "orchestrator_skill_versions_update_own"
on public.orchestrator_skill_versions
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "orchestrator_skill_versions_delete_own"
on public.orchestrator_skill_versions
for delete
using (auth.uid() = user_id);

drop policy if exists "orchestrator_skill_runtime_state_select_own" on public.orchestrator_skill_runtime_state;
drop policy if exists "orchestrator_skill_runtime_state_insert_own" on public.orchestrator_skill_runtime_state;
drop policy if exists "orchestrator_skill_runtime_state_update_own" on public.orchestrator_skill_runtime_state;
drop policy if exists "orchestrator_skill_runtime_state_delete_own" on public.orchestrator_skill_runtime_state;

create policy "orchestrator_skill_runtime_state_select_own"
on public.orchestrator_skill_runtime_state
for select
using (auth.uid() = user_id);

create policy "orchestrator_skill_runtime_state_insert_own"
on public.orchestrator_skill_runtime_state
for insert
with check (auth.uid() = user_id);

create policy "orchestrator_skill_runtime_state_update_own"
on public.orchestrator_skill_runtime_state
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "orchestrator_skill_runtime_state_delete_own"
on public.orchestrator_skill_runtime_state
for delete
using (auth.uid() = user_id);
