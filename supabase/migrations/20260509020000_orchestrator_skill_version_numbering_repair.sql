-- Repair skill version numbering across historical schema variants.
--
-- Older runtime code and the dashboard API expect orchestrator_skill_versions
-- to have a per-skill integer version, lifecycle, and metadata. A later
-- CREATE TABLE IF NOT EXISTS shape omitted some of those columns for fresh or
-- drifted environments. This migration makes the table compatible with both
-- runtime paths and provides a default for legacy app deployments that still
-- insert the first draft version without an explicit version value.

alter table public.orchestrator_skill_versions
  add column if not exists version integer;

with version_stats as (
  select
    id,
    skill_id,
    version,
    created_at,
    count(*) over (partition by skill_id, version) as duplicate_count
  from public.orchestrator_skill_versions
),
numbered as (
  select
    id,
    row_number() over (
      partition by skill_id
      order by
        case when version is null then 1 else 0 end,
        version nulls last,
        created_at,
        id
    )::integer as repaired_version,
    bool_or(version is null or duplicate_count > 1) over (partition by skill_id) as skill_needs_repair
  from version_stats
)
update public.orchestrator_skill_versions v
set version = numbered.repaired_version
from numbered
where v.id = numbered.id
  and numbered.skill_needs_repair;

alter table public.orchestrator_skill_versions
  alter column version set default 1,
  alter column version set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_skill_versions_skill_version_unique'
      and conrelid = 'public.orchestrator_skill_versions'::regclass
  ) then
    alter table public.orchestrator_skill_versions
      add constraint orchestrator_skill_versions_skill_version_unique
      unique (skill_id, version);
  end if;
end $$;

alter table public.orchestrator_skill_versions
  add column if not exists lifecycle text default 'draft';

update public.orchestrator_skill_versions
set lifecycle = 'draft'
where lifecycle is null
  or lifecycle not in ('draft', 'canary', 'stable', 'rollback', 'archived');

alter table public.orchestrator_skill_versions
  alter column lifecycle set default 'draft',
  alter column lifecycle set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orchestrator_skill_versions_lifecycle_check'
      and conrelid = 'public.orchestrator_skill_versions'::regclass
  ) then
    alter table public.orchestrator_skill_versions
      add constraint orchestrator_skill_versions_lifecycle_check
      check (lifecycle in ('draft', 'canary', 'stable', 'rollback', 'archived'));
  end if;
end $$;

alter table public.orchestrator_skill_versions
  add column if not exists metadata jsonb default '{}'::jsonb;

update public.orchestrator_skill_versions
set metadata = '{}'::jsonb
where metadata is null;

alter table public.orchestrator_skill_versions
  alter column metadata set default '{}'::jsonb,
  alter column metadata set not null;

create index if not exists orchestrator_skill_versions_skill_idx
  on public.orchestrator_skill_versions (skill_id, version desc);

notify pgrst, 'reload schema';
