-- Scheduled jobs (local execution via Groovy Connector)
-- v1: basic schedules + cancel-next-run + run history

create extension if not exists "pgcrypto";

-- =================
-- Scheduled jobs
-- =================
create table if not exists public.scheduled_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,

  -- Human-friendly
  name text not null default 'Scheduled task',

  -- Execution
  command text not null,
  cwd text null,

  -- Schedule specification (connector interprets in local time)
  -- Supported shapes (v1):
  -- - {"type":"once","run_at":"2026-01-26T18:30:00-06:00"}
  -- - {"type":"daily","hour":7,"minute":30}
  -- - {"type":"weekly","weekday":1,"hour":7,"minute":30}  -- 0=Sun..6=Sat
  -- - {"type":"interval_minutes","minutes":15}
  schedule jsonb not null,

  enabled boolean not null default true,
  skip_next_run boolean not null default false,

  last_run_at timestamptz null,
  last_status text null, -- success | error | skipped
  last_exit_code integer null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scheduled_jobs_user_device_updated_idx
  on public.scheduled_jobs (user_id, device_id, updated_at desc);

create index if not exists scheduled_jobs_device_enabled_idx
  on public.scheduled_jobs (device_id, enabled);

alter table public.scheduled_jobs enable row level security;

drop policy if exists "scheduled_jobs_select_own" on public.scheduled_jobs;
drop policy if exists "scheduled_jobs_insert_own" on public.scheduled_jobs;
drop policy if exists "scheduled_jobs_update_own" on public.scheduled_jobs;
drop policy if exists "scheduled_jobs_delete_own" on public.scheduled_jobs;

create policy "scheduled_jobs_select_own"
on public.scheduled_jobs
for select
using (auth.uid() = user_id);

create policy "scheduled_jobs_insert_own"
on public.scheduled_jobs
for insert
with check (auth.uid() = user_id);

create policy "scheduled_jobs_update_own"
on public.scheduled_jobs
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "scheduled_jobs_delete_own"
on public.scheduled_jobs
for delete
using (auth.uid() = user_id);

-- =====================
-- Scheduled job run log
-- =====================
create table if not exists public.scheduled_job_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  job_id uuid not null references public.scheduled_jobs (id) on delete cascade,

  status text not null, -- success | error | skipped
  exit_code integer null,

  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  duration_ms integer null,

  stdout text null,
  stderr text null,
  error text null,

  created_at timestamptz not null default now()
);

create index if not exists scheduled_job_runs_user_created_idx
  on public.scheduled_job_runs (user_id, created_at desc);

create index if not exists scheduled_job_runs_job_created_idx
  on public.scheduled_job_runs (job_id, created_at desc);

alter table public.scheduled_job_runs enable row level security;

drop policy if exists "scheduled_job_runs_select_own" on public.scheduled_job_runs;
drop policy if exists "scheduled_job_runs_insert_own" on public.scheduled_job_runs;

create policy "scheduled_job_runs_select_own"
on public.scheduled_job_runs
for select
using (auth.uid() = user_id);

create policy "scheduled_job_runs_insert_own"
on public.scheduled_job_runs
for insert
with check (auth.uid() = user_id);

