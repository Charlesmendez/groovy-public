-- Bind schedules created from Team Chat to the originating channel.
--
-- The scheduler remains owned by its original user/device. channel_id is an
-- additive visibility/management scope used by the Team Chat server routes; it
-- does not broaden the existing scheduled_jobs RLS policies.

alter table public.scheduled_jobs
  add column if not exists channel_id uuid null
    references public.chat_channels(id) on delete set null;

create index if not exists scheduled_jobs_channel_updated_idx
  on public.scheduled_jobs(channel_id, updated_at desc)
  where channel_id is not null;

-- Recover schedules previously created from a Team Chat orchestrator session.
-- thread_key is text for external providers, so join through the UUID's text
-- representation instead of casting untrusted provider keys.
update public.scheduled_jobs as job
set channel_id = channel.id
from public.orchestrator_external_threads as thread
join public.chat_channels as channel
  on channel.id::text = thread.thread_key
where job.channel_id is null
  and channel.kind = 'channel'
  and thread.user_id = job.user_id
  and thread.provider in ('team_chat', 'team_chat_guest')
  and (
    job.session_id = thread.orchestrator_session_id
    or job.task ->> 'orchestrator_session_id' =
      thread.orchestrator_session_id::text
  );

comment on column public.scheduled_jobs.channel_id is
  'Optional Team Chat channel where this scheduled task was created and managed.';

-- Keep direct browser writes from attaching a personal job to an unrelated
-- private channel. Service-role scheduler writes still pass through the
-- server-side channel authorization path.
drop policy if exists "scheduled_jobs_insert_own" on public.scheduled_jobs;
drop policy if exists "scheduled_jobs_update_own" on public.scheduled_jobs;

create policy "scheduled_jobs_insert_own"
on public.scheduled_jobs
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.devices d
    where d.id = device_id and d.user_id = auth.uid()
  )
  and (
    target_agent_id is null
    or exists (
      select 1 from public.agents a
      where a.id = target_agent_id
        and a.user_id = auth.uid()
        and a.type = 'claude-code'
    )
  )
  and (
    channel_id is null
    or exists (
      select 1
      from public.chat_channels channel
      join public.workspace_members member
        on member.workspace_id = channel.workspace_id
       and member.user_id = auth.uid()
       and member.role in ('admin', 'member')
      where channel.id = channel_id
        and channel.kind = 'channel'
        and public.can_read_chat_channel(channel.id)
    )
  )
);

create policy "scheduled_jobs_update_own"
on public.scheduled_jobs
for update
using (auth.uid() = user_id)
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.devices d
    where d.id = device_id and d.user_id = auth.uid()
  )
  and (
    target_agent_id is null
    or exists (
      select 1 from public.agents a
      where a.id = target_agent_id
        and a.user_id = auth.uid()
        and a.type = 'claude-code'
    )
  )
  and (
    channel_id is null
    or exists (
      select 1
      from public.chat_channels channel
      join public.workspace_members member
        on member.workspace_id = channel.workspace_id
       and member.user_id = auth.uid()
       and member.role in ('admin', 'member')
      where channel.id = channel_id
        and channel.kind = 'channel'
        and public.can_read_chat_channel(channel.id)
    )
  )
);
