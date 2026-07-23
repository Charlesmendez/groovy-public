-- Harness pivot: optional worker-agent target for scheduled jobs.
-- NULL = legacy behavior (orchestrator round). Distinct from agent_id, which
-- remains the orchestrator runtime owner / transcript scope — do not conflate.
-- FK on delete set null gives transactional fallback-to-orchestrator when a
-- worker agent is deleted.

alter table public.scheduled_jobs
  add column if not exists target_agent_id uuid null
    references public.agents (id) on delete set null;

create index if not exists scheduled_jobs_target_agent_idx
on public.scheduled_jobs (target_agent_id)
where target_agent_id is not null;

-- Heartbeat jobs are never worker-targeted (also guarded in the app layer).
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'scheduled_jobs_heartbeat_no_target_check'
  ) then
    alter table public.scheduled_jobs
      add constraint scheduled_jobs_heartbeat_no_target_check
      check (
        target_agent_id is null
        or (task ->> 'type') is distinct from 'heartbeat_v1'
      );
  end if;
end $$;

-- Preserve the existing own-row RLS semantics while preventing a browser
-- client from targeting an agent owned by a different user.
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
);
