-- Scheduled jobs v2: support orchestrator tasks (not just shell commands)

-- scheduled_jobs: allow non-shell tasks
alter table if exists public.scheduled_jobs
  add column if not exists kind text not null default 'shell',
  add column if not exists task jsonb null;

-- Allow orchestrator jobs without a shell command
alter table if exists public.scheduled_jobs
  alter column command drop not null;

-- Basic sanity: only allow known kinds
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'scheduled_jobs_kind_check'
  ) then
    alter table public.scheduled_jobs
      add constraint scheduled_jobs_kind_check
      check (kind in ('shell', 'orchestrator'));
  end if;
end $$;

