-- FLOW: Obsidian agent configs (local vault integration)

create extension if not exists "pgcrypto";

-- =====================================
-- Obsidian agent configs (agent->vault + delegate claude-code agent)
-- =====================================
create table if not exists public.obsidian_agent_configs (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  vault_workspace_id uuid not null references public.device_workspaces (id) on delete cascade,
  claude_code_agent_id uuid not null references public.agents (id) on delete cascade,
  vault_label text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint obsidian_agent_configs_unique unique (user_id, agent_id)
);

create index if not exists obsidian_agent_configs_user_idx
on public.obsidian_agent_configs (user_id);

create index if not exists obsidian_agent_configs_device_idx
on public.obsidian_agent_configs (device_id);

alter table public.obsidian_agent_configs enable row level security;

drop policy if exists "obsidian_agent_configs_select_own" on public.obsidian_agent_configs;
drop policy if exists "obsidian_agent_configs_insert_own" on public.obsidian_agent_configs;
drop policy if exists "obsidian_agent_configs_update_own" on public.obsidian_agent_configs;
drop policy if exists "obsidian_agent_configs_delete_own" on public.obsidian_agent_configs;

create policy "obsidian_agent_configs_select_own"
on public.obsidian_agent_configs
for select
using (auth.uid() = user_id);

create policy "obsidian_agent_configs_insert_own"
on public.obsidian_agent_configs
for insert
with check (auth.uid() = user_id);

create policy "obsidian_agent_configs_update_own"
on public.obsidian_agent_configs
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "obsidian_agent_configs_delete_own"
on public.obsidian_agent_configs
for delete
using (auth.uid() = user_id);

