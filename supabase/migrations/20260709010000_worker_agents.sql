-- Harness pivot: worker agent config extensions + per-worker data integrations.
-- Worker agent = agents.type='claude-code' + a claude_code_agent_configs row.

-- Per-agent model override (harness model, e.g. a specific Claude/Codex model).
-- Intentionally NOT agents.model — that column carries the ai-chat LLM semantic.
alter table public.claude_code_agent_configs
  add column if not exists model text null,
  add column if not exists emoji text null,
  add column if not exists color text null;

-- =====================================
-- Worker agent <-> Datagran integrations
-- =====================================
-- Attaches a user's existing Datagran integration agents (agents.type='datagran')
-- to a worker agent so the task runner can scope data access per worker.
create table if not exists public.worker_agent_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  datagran_agent_id uuid not null references public.agents (id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  constraint worker_agent_integrations_unique unique (agent_id, datagran_agent_id)
);

create index if not exists worker_agent_integrations_user_idx
on public.worker_agent_integrations (user_id);

create index if not exists worker_agent_integrations_agent_idx
on public.worker_agent_integrations (agent_id);

alter table public.worker_agent_integrations enable row level security;

drop policy if exists "worker_agent_integrations_select_own" on public.worker_agent_integrations;
drop policy if exists "worker_agent_integrations_insert_own" on public.worker_agent_integrations;
drop policy if exists "worker_agent_integrations_update_own" on public.worker_agent_integrations;
drop policy if exists "worker_agent_integrations_delete_own" on public.worker_agent_integrations;

create policy "worker_agent_integrations_select_own"
on public.worker_agent_integrations
for select
using (auth.uid() = user_id);

create policy "worker_agent_integrations_insert_own"
on public.worker_agent_integrations
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.agents a
    where a.id = agent_id and a.user_id = auth.uid() and a.type = 'claude-code'
  )
  and exists (
    select 1 from public.agents d
    where d.id = datagran_agent_id and d.user_id = auth.uid() and d.type = 'datagran'
  )
);

create policy "worker_agent_integrations_update_own"
on public.worker_agent_integrations
for update
using (auth.uid() = user_id)
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.agents a
    where a.id = agent_id and a.user_id = auth.uid() and a.type = 'claude-code'
  )
  and exists (
    select 1 from public.agents d
    where d.id = datagran_agent_id and d.user_id = auth.uid() and d.type = 'datagran'
  )
);

create policy "worker_agent_integrations_delete_own"
on public.worker_agent_integrations
for delete
using (auth.uid() = user_id);

-- The harness creates worker bindings from the browser. The legacy policy only
-- checked the denormalized user_id, which allowed a malicious authenticated
-- client to reference another user's agent/device/workspace UUID. Keep direct
-- browser creation, but require every referenced row to share the owner.
drop policy if exists "claude_code_agent_configs_insert_own" on public.claude_code_agent_configs;
drop policy if exists "claude_code_agent_configs_update_own" on public.claude_code_agent_configs;

create policy "claude_code_agent_configs_insert_own"
on public.claude_code_agent_configs
for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.agents a
    where a.id = agent_id and a.user_id = auth.uid() and a.type = 'claude-code'
  )
  and exists (
    select 1 from public.devices d
    where d.id = device_id and d.user_id = auth.uid()
  )
  and (
    workspace_id is null
    or exists (
      select 1 from public.device_workspaces w
      where w.id = workspace_id
        and w.user_id = auth.uid()
        and w.device_id = device_id
    )
  )
);

create policy "claude_code_agent_configs_update_own"
on public.claude_code_agent_configs
for update
using (auth.uid() = user_id)
with check (
  auth.uid() = user_id
  and exists (
    select 1 from public.agents a
    where a.id = agent_id and a.user_id = auth.uid() and a.type = 'claude-code'
  )
  and exists (
    select 1 from public.devices d
    where d.id = device_id and d.user_id = auth.uid()
  )
  and (
    workspace_id is null
    or exists (
      select 1 from public.device_workspaces w
      where w.id = workspace_id
        and w.user_id = auth.uid()
        and w.device_id = device_id
    )
  )
);
