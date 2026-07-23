create table if not exists public.scheduled_job_cloud_locks (
  job_id uuid primary key references public.scheduled_jobs(id) on delete cascade,
  lock_token uuid not null,
  expires_at timestamptz not null
);

alter table public.scheduled_job_cloud_locks enable row level security;

create or replace function public.acquire_scheduled_job_cloud_lock(
  p_job_id uuid,
  p_lock_token uuid,
  p_ttl_seconds integer default 800
)
returns boolean
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_token uuid;
begin
  insert into public.scheduled_job_cloud_locks(job_id, lock_token, expires_at)
  values (
    p_job_id,
    p_lock_token,
    now() + make_interval(secs => greatest(30, least(800, p_ttl_seconds)))
  )
  on conflict (job_id) do update
    set lock_token = excluded.lock_token,
        expires_at = excluded.expires_at
    where public.scheduled_job_cloud_locks.expires_at < now()
  returning lock_token into v_token;
  return v_token = p_lock_token;
end;
$$;

create or replace function public.release_scheduled_job_cloud_lock(
  p_job_id uuid,
  p_lock_token uuid
)
returns void
language sql
security definer
set search_path = public
set row_security = off
as $$
  delete from public.scheduled_job_cloud_locks
  where job_id = p_job_id and lock_token = p_lock_token;
$$;

revoke all on table public.scheduled_job_cloud_locks from public, anon, authenticated;
revoke all on function public.acquire_scheduled_job_cloud_lock(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_scheduled_job_cloud_lock(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.acquire_scheduled_job_cloud_lock(uuid, uuid, integer)
  to service_role;
grant execute on function public.release_scheduled_job_cloud_lock(uuid, uuid)
  to service_role;
