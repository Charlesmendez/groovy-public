-- Skills are agent-owned. Only the owning user can mutate skill registry, versions, and runtime state.

drop policy if exists "orchestrator_skills_insert_own" on public.orchestrator_skills;
drop policy if exists "orchestrator_skills_update_own" on public.orchestrator_skills;
drop policy if exists "orchestrator_skills_delete_own" on public.orchestrator_skills;

create policy "orchestrator_skills_insert_own"
on public.orchestrator_skills
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skills.agent_id
      and a.user_id = auth.uid()
  )
);

create policy "orchestrator_skills_update_own"
on public.orchestrator_skills
for update
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skills.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skills.agent_id
      and a.user_id = auth.uid()
  )
);

create policy "orchestrator_skills_delete_own"
on public.orchestrator_skills
for delete
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skills.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_skill_versions_insert_own" on public.orchestrator_skill_versions;
drop policy if exists "orchestrator_skill_versions_update_own" on public.orchestrator_skill_versions;
drop policy if exists "orchestrator_skill_versions_delete_own" on public.orchestrator_skill_versions;

create policy "orchestrator_skill_versions_insert_own"
on public.orchestrator_skill_versions
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_versions.agent_id
      and a.user_id = auth.uid()
  )
);

create policy "orchestrator_skill_versions_update_own"
on public.orchestrator_skill_versions
for update
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_versions.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_versions.agent_id
      and a.user_id = auth.uid()
  )
);

create policy "orchestrator_skill_versions_delete_own"
on public.orchestrator_skill_versions
for delete
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_versions.agent_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "orchestrator_skill_runtime_state_insert_own" on public.orchestrator_skill_runtime_state;
drop policy if exists "orchestrator_skill_runtime_state_update_own" on public.orchestrator_skill_runtime_state;
drop policy if exists "orchestrator_skill_runtime_state_delete_own" on public.orchestrator_skill_runtime_state;

create policy "orchestrator_skill_runtime_state_insert_own"
on public.orchestrator_skill_runtime_state
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_runtime_state.agent_id
      and a.user_id = auth.uid()
  )
);

create policy "orchestrator_skill_runtime_state_update_own"
on public.orchestrator_skill_runtime_state
for update
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_runtime_state.agent_id
      and a.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_runtime_state.agent_id
      and a.user_id = auth.uid()
  )
);

create policy "orchestrator_skill_runtime_state_delete_own"
on public.orchestrator_skill_runtime_state
for delete
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.agents a
    where a.id = orchestrator_skill_runtime_state.agent_id
      and a.user_id = auth.uid()
  )
);
