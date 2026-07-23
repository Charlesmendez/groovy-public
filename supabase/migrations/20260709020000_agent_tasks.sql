-- Harness pivot: orchestrator-delegated tasks for worker agents.
-- One row per task the orchestrator (or a schedule / API caller) assigns to a
-- worker agent. The server-side task runner owns status transitions; the
-- dashboard subscribes via realtime.

create extension if not exists "pgcrypto";

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid null references public.workspaces (id) on delete set null,

  -- Orchestrator session that created the task (null for schedule/API sources).
  orchestrator_session_id uuid null references public.orchestrator_sessions (id) on delete set null,

  -- The worker agent that executes the task.
  agent_id uuid not null references public.agents (id) on delete cascade,

  status text not null default 'queued'
    check (status in ('queued', 'running', 'awaiting_approval', 'done', 'failed', 'canceled')),

  title text null,
  prompt text not null,
  -- Optional injected context block (e.g. from transfer_context).
  context text null,

  result_text text null,
  result_meta jsonb not null default '{}'::jsonb,
  error text null,

  -- Harness resume handle (claude --resume session id / codex thread id).
  harness_session_id text null,

  trace_id text null,
  turn_id text null,

  -- Where the task was requested from: dashboard, whatsapp_kapso, whatsapp_web,
  -- telegram, heartbeat, schedule, api.
  requested_channel text null,

  -- Notification targets, e.g. { "whatsapp_kapso": {"phoneNumberId": "...", "to": "..."},
  -- "whatsapp_web": {"threadKey": "..."}, "telegram": true, "dashboard": true }
  notify jsonb not null default '{}'::jsonb,

  -- Approval state, e.g. { "required": true, "alias": 3, "decided_by": "...",
  -- "decided_at": "..." }
  approval jsonb not null default '{}'::jsonb,

  -- Provenance: orchestrator tool call, scheduled job, or direct API.
  source text not null default 'orchestrator'
    check (source in ('orchestrator', 'schedule', 'api')),
  scheduled_job_id uuid null references public.scheduled_jobs (id) on delete set null,
  -- Stable connector-generated id for one logical scheduled occurrence. It
  -- survives transport retries so a successful worker edit is never repeated
  -- merely because the HTTP response was lost.
  scheduled_run_id text null,

  created_at timestamptz not null default now(),
  started_at timestamptz null,
  finished_at timestamptz null,
  updated_at timestamptz not null default now()
);

create index if not exists agent_tasks_user_created_idx
on public.agent_tasks (user_id, created_at desc);

create index if not exists agent_tasks_agent_created_idx
on public.agent_tasks (agent_id, created_at desc);

create index if not exists agent_tasks_session_idx
on public.agent_tasks (orchestrator_session_id)
where orchestrator_session_id is not null;

-- Reconciler scan: queued/running tasks that may have gone stale.
create index if not exists agent_tasks_open_status_idx
on public.agent_tasks (status, updated_at)
where status in ('queued', 'running', 'awaiting_approval');

-- A worker owns one persistent harness session and one working tree. Running
-- two tasks concurrently against it can interleave edits and corrupt resume
-- state, so claims are serialized per agent at the database boundary.
create unique index if not exists agent_tasks_one_running_per_agent_idx
on public.agent_tasks (agent_id)
where status = 'running';

create index if not exists agent_tasks_scheduled_job_idx
on public.agent_tasks (scheduled_job_id)
where scheduled_job_id is not null;

create unique index if not exists agent_tasks_scheduled_run_unique_idx
on public.agent_tasks (scheduled_job_id, scheduled_run_id)
where scheduled_job_id is not null and scheduled_run_id is not null;

alter table public.agent_tasks enable row level security;

drop policy if exists "agent_tasks_select_own" on public.agent_tasks;
drop policy if exists "agent_tasks_insert_own" on public.agent_tasks;
drop policy if exists "agent_tasks_update_own" on public.agent_tasks;
drop policy if exists "agent_tasks_delete_own" on public.agent_tasks;

create policy "agent_tasks_select_own"
on public.agent_tasks
for select
using (auth.uid() = user_id);

create policy "agent_tasks_insert_own"
on public.agent_tasks
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.agents a
    where a.id = agent_id and a.user_id = auth.uid() and a.type = 'claude-code'
  )
  and (
    orchestrator_session_id is null
    or exists (
      select 1 from public.orchestrator_sessions s
      where s.id = orchestrator_session_id and s.user_id = auth.uid()
    )
  )
  and (
    scheduled_job_id is null
    or exists (
      select 1 from public.scheduled_jobs j
      where j.id = scheduled_job_id and j.user_id = auth.uid()
    )
  )
);

create policy "agent_tasks_update_own"
on public.agent_tasks
for update
using (auth.uid() = user_id)
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.agents a
    where a.id = agent_id and a.user_id = auth.uid() and a.type = 'claude-code'
  )
  and (
    orchestrator_session_id is null
    or exists (
      select 1 from public.orchestrator_sessions s
      where s.id = orchestrator_session_id and s.user_id = auth.uid()
    )
  )
  and (
    scheduled_job_id is null
    or exists (
      select 1 from public.scheduled_jobs j
      where j.id = scheduled_job_id and j.user_id = auth.uid()
    )
  )
);

create policy "agent_tasks_delete_own"
on public.agent_tasks
for delete
using (auth.uid() = user_id);

-- Realtime: the dashboard side rail subscribes to task status changes.
alter table public.agent_tasks replica identity full;
alter publication supabase_realtime add table public.agent_tasks;
