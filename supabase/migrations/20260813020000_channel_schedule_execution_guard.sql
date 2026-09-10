-- Team Chat participants may create Mind/worker automations, but a channel
-- request must never become a shell command on the workspace owner's device.
-- Disable any legacy rows before enforcing the invariant for future writes.

update public.scheduled_jobs
set
  enabled = false,
  updated_at = now()
where channel_id is not null
  and coalesce(kind, '') <> 'orchestrator';

alter table public.scheduled_jobs
  drop constraint if exists scheduled_jobs_channel_kind_guard;

alter table public.scheduled_jobs
  add constraint scheduled_jobs_channel_kind_guard
  check (
    channel_id is null
    or coalesce(kind, '') = 'orchestrator'
  );

comment on constraint scheduled_jobs_channel_kind_guard
  on public.scheduled_jobs is
  'Team Chat schedules execute through a Mind or assigned worker, never as direct shell commands.';
