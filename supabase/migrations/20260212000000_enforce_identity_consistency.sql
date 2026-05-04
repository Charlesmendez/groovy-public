-- Prevent cross-account drift between integrations/schedules and their owners.
-- This migration also repairs legacy mismatches discovered in production.

-- 1) Datagran configs must be owned by the same user as their agent.
update public.datagran_agent_configs dac
set
  user_id = a.user_id,
  end_user_external_id = 'flow_' || a.user_id::text,
  updated_at = now()
from public.agents a
where a.id = dac.agent_id
  and (
    dac.user_id is distinct from a.user_id
    or dac.end_user_external_id is distinct from ('flow_' || a.user_id::text)
  );

-- 2) Scheduled jobs must be owned by the same user as their device.
update public.scheduled_jobs sj
set
  user_id = d.user_id,
  updated_at = now()
from public.devices d
where d.id = sj.device_id
  and sj.user_id is distinct from d.user_id;

-- 3) Scheduled run rows should mirror the owning job identity.
update public.scheduled_job_runs r
set
  user_id = sj.user_id,
  device_id = sj.device_id
from public.scheduled_jobs sj
where sj.id = r.job_id
  and (
    r.user_id is distinct from sj.user_id
    or r.device_id is distinct from sj.device_id
  );

-- Composite uniqueness used by composite foreign keys below.
create unique index if not exists agents_user_id_id_uq
  on public.agents (user_id, id);

create unique index if not exists devices_user_id_id_uq
  on public.devices (user_id, id);

create unique index if not exists scheduled_jobs_user_id_id_uq
  on public.scheduled_jobs (user_id, id);

create unique index if not exists scheduled_jobs_device_id_id_uq
  on public.scheduled_jobs (device_id, id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'datagran_agent_configs_user_agent_fk'
  ) then
    alter table public.datagran_agent_configs
      add constraint datagran_agent_configs_user_agent_fk
      foreign key (user_id, agent_id)
      references public.agents (user_id, id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'datagran_agent_configs_external_id_matches_user_chk'
  ) then
    alter table public.datagran_agent_configs
      add constraint datagran_agent_configs_external_id_matches_user_chk
      check (end_user_external_id = ('flow_' || user_id::text));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'scheduled_jobs_user_device_fk'
  ) then
    alter table public.scheduled_jobs
      add constraint scheduled_jobs_user_device_fk
      foreign key (user_id, device_id)
      references public.devices (user_id, id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'scheduled_job_runs_user_device_fk'
  ) then
    alter table public.scheduled_job_runs
      add constraint scheduled_job_runs_user_device_fk
      foreign key (user_id, device_id)
      references public.devices (user_id, id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'scheduled_job_runs_user_job_fk'
  ) then
    alter table public.scheduled_job_runs
      add constraint scheduled_job_runs_user_job_fk
      foreign key (user_id, job_id)
      references public.scheduled_jobs (user_id, id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'scheduled_job_runs_device_job_fk'
  ) then
    alter table public.scheduled_job_runs
      add constraint scheduled_job_runs_device_job_fk
      foreign key (device_id, job_id)
      references public.scheduled_jobs (device_id, id)
      on delete cascade;
  end if;
end $$;
