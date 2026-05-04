-- Hidden parallel worker branches + skill registry normalization.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Branch metadata needed by the runtime branch worker flow.
-- ---------------------------------------------------------------------------
alter table public.orchestrator_branches
  add column if not exists branch_kind text not null default 'interactive';

alter table public.orchestrator_branches
  add column if not exists goal text null;

alter table public.orchestrator_branches
  add column if not exists result_summary text null;

alter table public.orchestrator_branches
  add column if not exists result_payload jsonb not null default '{}'::jsonb;

alter table public.orchestrator_branches
  add column if not exists completed_at timestamptz null;

alter table public.orchestrator_branches
  add column if not exists fork_reason text null;

alter table public.orchestrator_branches
  add column if not exists merge_reason text null;

alter table public.orchestrator_branches
  add column if not exists abort_reason text null;

alter table public.orchestrator_branches
  add column if not exists budget_limit_hit text null;

alter table public.orchestrator_branches
  add column if not exists budget_hit_at timestamptz null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_branches_branch_kind_check'
  ) then
    alter table public.orchestrator_branches
      add constraint orchestrator_branches_branch_kind_check
      check (branch_kind in ('interactive', 'worker'));
  end if;
end $$;

create index if not exists orchestrator_branches_user_agent_epoch_kind_idx
  on public.orchestrator_branches (user_id, agent_id, epoch_id, branch_kind, updated_at desc);

-- ---------------------------------------------------------------------------
-- Skill registry tables. The runtime already assumes these tables exist.
-- ---------------------------------------------------------------------------
create table if not exists public.orchestrator_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  slug text not null,
  name text not null,
  description text not null default '',
  lifecycle text not null default 'draft',
  runner text not null,
  active_version_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orchestrator_skills_slug_unique unique (user_id, agent_id, slug),
  constraint orchestrator_skills_lifecycle_check
    check (lifecycle in ('draft', 'canary', 'stable', 'rollback', 'disabled')),
  constraint orchestrator_skills_runner_check
    check (runner in ('code_cli_run', 'terminal_exec'))
);

create table if not exists public.orchestrator_skill_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  skill_id uuid not null references public.orchestrator_skills(id) on delete cascade,
  runner text not null,
  source text not null,
  default_state jsonb not null default '{}'::jsonb,
  validation_status text not null default 'unvalidated',
  validation_task text null,
  validation_token text null,
  validation_output_preview text null,
  validation_requested_at timestamptz null,
  validated_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orchestrator_skill_versions_runner_check
    check (runner in ('code_cli_run', 'terminal_exec')),
  constraint orchestrator_skill_versions_validation_status_check
    check (validation_status in ('unvalidated', 'requested', 'passed', 'failed'))
);

create table if not exists public.orchestrator_skill_runtime_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  skill_version_id uuid not null references public.orchestrator_skill_versions(id) on delete cascade,
  epoch_id uuid not null references public.orchestrator_agent_epochs(id) on delete cascade,
  branch_id uuid not null references public.orchestrator_branches(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, agent_id, skill_version_id, epoch_id, branch_id)
);

alter table public.orchestrator_skills
  add column if not exists active_version_id uuid null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_skills_active_version_fk'
  ) then
    alter table public.orchestrator_skills
      add constraint orchestrator_skills_active_version_fk
      foreign key (active_version_id)
      references public.orchestrator_skill_versions(id)
      on delete set null;
  end if;
end $$;

alter table public.orchestrator_skill_versions
  add column if not exists validation_status text not null default 'unvalidated';

alter table public.orchestrator_skill_versions
  add column if not exists validation_task text null;

alter table public.orchestrator_skill_versions
  add column if not exists validation_token text null;

alter table public.orchestrator_skill_versions
  add column if not exists validation_output_preview text null;

alter table public.orchestrator_skill_versions
  add column if not exists validation_requested_at timestamptz null;

alter table public.orchestrator_skill_versions
  add column if not exists validated_at timestamptz null;

create index if not exists orchestrator_skills_user_agent_lifecycle_idx
  on public.orchestrator_skills (user_id, agent_id, lifecycle, updated_at desc);

create index if not exists orchestrator_skill_versions_skill_created_idx
  on public.orchestrator_skill_versions (skill_id, created_at desc);

create index if not exists orchestrator_skill_versions_validation_idx
  on public.orchestrator_skill_versions (user_id, agent_id, validation_status, updated_at desc);

alter table public.orchestrator_skills enable row level security;
alter table public.orchestrator_skill_versions enable row level security;
alter table public.orchestrator_skill_runtime_state enable row level security;

drop policy if exists "orchestrator_skills_select_own" on public.orchestrator_skills;
create policy "orchestrator_skills_select_own"
on public.orchestrator_skills
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_skills_insert_own" on public.orchestrator_skills;
create policy "orchestrator_skills_insert_own"
on public.orchestrator_skills
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skills.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_skills_update_own" on public.orchestrator_skills;
create policy "orchestrator_skills_update_own"
on public.orchestrator_skills
for update
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skills.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skills.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_skills_delete_own" on public.orchestrator_skills;
create policy "orchestrator_skills_delete_own"
on public.orchestrator_skills
for delete
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skills.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_skill_versions_select_own" on public.orchestrator_skill_versions;
create policy "orchestrator_skill_versions_select_own"
on public.orchestrator_skill_versions
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_skill_versions_insert_own" on public.orchestrator_skill_versions;
create policy "orchestrator_skill_versions_insert_own"
on public.orchestrator_skill_versions
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_versions.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_skill_versions_update_own" on public.orchestrator_skill_versions;
create policy "orchestrator_skill_versions_update_own"
on public.orchestrator_skill_versions
for update
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_versions.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_versions.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_skill_versions_delete_own" on public.orchestrator_skill_versions;
create policy "orchestrator_skill_versions_delete_own"
on public.orchestrator_skill_versions
for delete
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_versions.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_skill_runtime_state_select_own" on public.orchestrator_skill_runtime_state;
create policy "orchestrator_skill_runtime_state_select_own"
on public.orchestrator_skill_runtime_state
for select
using (auth.uid() = user_id);

drop policy if exists "orchestrator_skill_runtime_state_insert_own" on public.orchestrator_skill_runtime_state;
create policy "orchestrator_skill_runtime_state_insert_own"
on public.orchestrator_skill_runtime_state
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_runtime_state.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_skill_runtime_state_update_own" on public.orchestrator_skill_runtime_state;
create policy "orchestrator_skill_runtime_state_update_own"
on public.orchestrator_skill_runtime_state
for update
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_runtime_state.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_runtime_state.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_skill_runtime_state_delete_own" on public.orchestrator_skill_runtime_state;
create policy "orchestrator_skill_runtime_state_delete_own"
on public.orchestrator_skill_runtime_state
for delete
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_runtime_state.agent_id
      and a.user_id = auth.uid()
  )
);
