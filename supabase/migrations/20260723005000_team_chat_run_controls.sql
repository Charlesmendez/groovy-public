-- Durable Team Chat run controls. A visible channel member may inspect active
-- work, but only the server-side control route mutates run state. The active
-- request polls this row and aborts its model/tool loop when another member
-- requests a stop or redirect.

create table if not exists public.chat_orchestrator_runs (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  orchestrator_session_id uuid references public.orchestrator_sessions(id) on delete set null,
  profile_id uuid references public.orchestrator_profiles(id) on delete set null,
  trace_id text not null,
  status text not null default 'running'
    check (
      status in (
        'running',
        'stop_requested',
        'redirect_requested',
        'finalizing',
        'stopped',
        'completed',
        'failed'
      )
    ),
  started_by uuid references auth.users(id) on delete set null,
  control_requested_by uuid references auth.users(id) on delete set null,
  redirect_content text,
  started_at timestamptz not null default now(),
  control_requested_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    redirect_content is null
    or char_length(redirect_content) between 1 and 4000
  )
);

create unique index if not exists chat_orchestrator_runs_one_active_channel_idx
  on public.chat_orchestrator_runs(channel_id)
  where status in ('running', 'stop_requested', 'redirect_requested');

create index if not exists chat_orchestrator_runs_channel_started_idx
  on public.chat_orchestrator_runs(channel_id, started_at desc);

create index if not exists agent_tasks_requested_channel_status_idx
  on public.agent_tasks(requested_channel, status, created_at)
  where requested_channel is not null
    and status in ('queued', 'running', 'awaiting_approval');

alter table public.chat_orchestrator_runs enable row level security;

drop policy if exists "chat_orchestrator_runs_select" on public.chat_orchestrator_runs;
create policy "chat_orchestrator_runs_select"
  on public.chat_orchestrator_runs
  for select
  using (public.can_read_chat_channel(channel_id));

-- Writes are service-role only. A channel member must use the authenticated
-- control route, which rechecks channel visibility before changing a run.

do $$
begin
  alter publication supabase_realtime add table public.chat_orchestrator_runs;
exception
  when duplicate_object then null;
end $$;

-- Cancel an agent task without replacing result_meta. The relay request id is
-- written by the task runner shortly before dispatch, so a read/modify/write
-- from the control route could otherwise erase the process handle and make a
-- real cancellation impossible.
create or replace function public.cancel_team_chat_agent_task(
  p_task_id uuid,
  p_requested_channel text,
  p_controlled_by uuid
)
returns table (
  user_id uuid,
  agent_id uuid,
  previous_status text,
  result_meta jsonb
)
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_previous_status text;
begin
  select task.status
  into v_previous_status
  from public.agent_tasks task
  where task.id = p_task_id
    and task.requested_channel = p_requested_channel
    and task.status in ('queued', 'running', 'awaiting_approval')
  for update;

  if v_previous_status is null then
    return;
  end if;

  return query
  update public.agent_tasks task
  set status = 'canceled',
      error = 'stopped_by_team_member',
      result_meta =
        coalesce(task.result_meta, '{}'::jsonb)
        || jsonb_build_object(
          'stopped_by_team_member', p_controlled_by,
          'stopped_at', now()
        ),
      finished_at = now(),
      updated_at = now()
  where task.id = p_task_id
    and task.requested_channel = p_requested_channel
    and task.status = v_previous_status
  returning
    task.user_id,
    task.agent_id,
    v_previous_status,
    task.result_meta;
end;
$$;

revoke all on function public.cancel_team_chat_agent_task(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_team_chat_agent_task(uuid, text, uuid)
  to service_role;
