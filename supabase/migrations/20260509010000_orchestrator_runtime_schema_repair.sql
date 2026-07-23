-- Repair Orchestrator runtime schema drift seen in production.
--
-- The Orchestrator skill registry writes validation metadata to
-- orchestrator_skill_versions. Some deployed databases have the older
-- 20260228060000 table shape without these columns, which causes PostgREST
-- errors such as:
--   column orchestrator_skill_versions.validation_status does not exist
--
-- Reassert the missing hidden-branch and skill-validation fields from the
-- runtime normalization migration, then explicitly ask PostgREST to reload its
-- schema cache.

-- Hidden parallel worker branch metadata.
alter table public.orchestrator_branches
  add column if not exists branch_kind text default 'interactive';

update public.orchestrator_branches
set branch_kind = 'interactive'
where branch_kind is null
  or branch_kind not in ('interactive', 'worker');

alter table public.orchestrator_branches
  alter column branch_kind set default 'interactive',
  alter column branch_kind set not null;

alter table public.orchestrator_branches
  add column if not exists goal text null;

alter table public.orchestrator_branches
  add column if not exists result_summary text null;

alter table public.orchestrator_branches
  add column if not exists result_payload jsonb default '{}'::jsonb;

update public.orchestrator_branches
set result_payload = '{}'::jsonb
where result_payload is null;

alter table public.orchestrator_branches
  alter column result_payload set default '{}'::jsonb,
  alter column result_payload set not null;

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
      and conrelid = 'public.orchestrator_branches'::regclass
  ) then
    alter table public.orchestrator_branches
      add constraint orchestrator_branches_branch_kind_check
      check (branch_kind in ('interactive', 'worker'));
  end if;
end $$;

create index if not exists orchestrator_branches_user_agent_epoch_kind_idx
  on public.orchestrator_branches (user_id, agent_id, epoch_id, branch_kind, updated_at desc);

-- Skill draft validation metadata.
alter table public.orchestrator_skill_versions
  add column if not exists validation_status text default 'unvalidated';

update public.orchestrator_skill_versions
set validation_status = 'unvalidated'
where validation_status is null
  or validation_status not in ('unvalidated', 'requested', 'passed', 'failed');

alter table public.orchestrator_skill_versions
  alter column validation_status set default 'unvalidated',
  alter column validation_status set not null;

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

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_skill_versions_validation_status_check'
      and conrelid = 'public.orchestrator_skill_versions'::regclass
  ) then
    alter table public.orchestrator_skill_versions
      add constraint orchestrator_skill_versions_validation_status_check
      check (validation_status in ('unvalidated', 'requested', 'passed', 'failed'));
  end if;
end $$;

create index if not exists orchestrator_skill_versions_validation_idx
  on public.orchestrator_skill_versions (user_id, agent_id, validation_status, updated_at desc);

notify pgrst, 'reload schema';
