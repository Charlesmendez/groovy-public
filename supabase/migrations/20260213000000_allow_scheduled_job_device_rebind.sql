-- Allow scheduled_jobs.device_id to be updated (rebind) while keeping
-- scheduled_job_runs consistent with the owning job identity.
--
-- The identity-consistency migration added:
--   scheduled_job_runs(device_id, job_id) -> scheduled_jobs(device_id, id)
-- but without ON UPDATE CASCADE, so rebinding a job's device_id fails.

-- Safety: ensure referenced uniqueness exists (required for composite FK).
create unique index if not exists scheduled_jobs_device_id_id_uq
  on public.scheduled_jobs (device_id, id);

-- Repair any legacy drift before enforcing the FK.
update public.scheduled_job_runs r
set device_id = sj.device_id
from public.scheduled_jobs sj
where sj.id = r.job_id
  and r.device_id is distinct from sj.device_id;

do $$
declare
  updtype "char";
  deltype "char";
begin
  select c.confupdtype, c.confdeltype
  into updtype, deltype
  from pg_constraint c
  where c.conname = 'scheduled_job_runs_device_job_fk'
  limit 1;

  -- confupdtype/confdeltype:
  -- a = no action, r = restrict, c = cascade, n = set null, d = set default
  if updtype is null then
    alter table public.scheduled_job_runs
      add constraint scheduled_job_runs_device_job_fk
      foreign key (device_id, job_id)
      references public.scheduled_jobs (device_id, id)
      on update cascade
      on delete cascade;
  elsif updtype <> 'c' or deltype <> 'c' then
    alter table public.scheduled_job_runs
      drop constraint scheduled_job_runs_device_job_fk;

    alter table public.scheduled_job_runs
      add constraint scheduled_job_runs_device_job_fk
      foreign key (device_id, job_id)
      references public.scheduled_jobs (device_id, id)
      on update cascade
      on delete cascade;
  end if;
end $$;

