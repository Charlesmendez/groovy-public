-- FLOW: Local device connector + Claude Code terminals

create extension if not exists "pgcrypto";

-- =========
-- Devices
-- =========
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  public_key text null,
  created_at timestamptz not null default now(),
  last_seen timestamptz null
);

create index if not exists devices_user_id_idx on public.devices (user_id);

alter table public.devices enable row level security;

drop policy if exists "devices_select_own" on public.devices;
drop policy if exists "devices_insert_own" on public.devices;
drop policy if exists "devices_update_own" on public.devices;
drop policy if exists "devices_delete_own" on public.devices;

create policy "devices_select_own"
on public.devices
for select
using (auth.uid() = user_id);

create policy "devices_insert_own"
on public.devices
for insert
with check (auth.uid() = user_id);

create policy "devices_update_own"
on public.devices
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "devices_delete_own"
on public.devices
for delete
using (auth.uid() = user_id);

-- ===================
-- Device pairing codes
-- ===================
-- The web app creates these. The relay consumes them using service role.
create table if not exists public.device_pairing_codes (
  code text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  device_id uuid null references public.devices (id) on delete set null
);

create index if not exists device_pairing_codes_user_id_idx
on public.device_pairing_codes (user_id, created_at desc);

alter table public.device_pairing_codes enable row level security;

drop policy if exists "device_pairing_codes_select_own" on public.device_pairing_codes;
drop policy if exists "device_pairing_codes_insert_own" on public.device_pairing_codes;
drop policy if exists "device_pairing_codes_delete_own" on public.device_pairing_codes;

create policy "device_pairing_codes_select_own"
on public.device_pairing_codes
for select
using (auth.uid() = user_id);

create policy "device_pairing_codes_insert_own"
on public.device_pairing_codes
for insert
with check (auth.uid() = user_id);

create policy "device_pairing_codes_delete_own"
on public.device_pairing_codes
for delete
using (auth.uid() = user_id);

-- ===========
-- Workspaces
-- ===========
-- Note: for MVP we store `root_path` (absolute path) under RLS, so the UI can show it.
create table if not exists public.device_workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  label text not null,
  root_path text not null,
  policy jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_workspaces_unique_root unique (user_id, device_id, root_path)
);

create index if not exists device_workspaces_user_device_idx
on public.device_workspaces (user_id, device_id);

alter table public.device_workspaces enable row level security;

drop policy if exists "device_workspaces_select_own" on public.device_workspaces;
drop policy if exists "device_workspaces_insert_own" on public.device_workspaces;
drop policy if exists "device_workspaces_update_own" on public.device_workspaces;
drop policy if exists "device_workspaces_delete_own" on public.device_workspaces;

create policy "device_workspaces_select_own"
on public.device_workspaces
for select
using (auth.uid() = user_id);

create policy "device_workspaces_insert_own"
on public.device_workspaces
for insert
with check (auth.uid() = user_id);

create policy "device_workspaces_update_own"
on public.device_workspaces
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "device_workspaces_delete_own"
on public.device_workspaces
for delete
using (auth.uid() = user_id);

-- =====================================
-- Claude Code agent binding (agent->ws)
-- =====================================
create table if not exists public.claude_code_agent_configs (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  workspace_id uuid not null references public.device_workspaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint claude_code_agent_configs_unique unique (user_id, agent_id)
);

create index if not exists claude_code_agent_configs_user_device_idx
on public.claude_code_agent_configs (user_id, device_id);

alter table public.claude_code_agent_configs enable row level security;

drop policy if exists "claude_code_agent_configs_select_own" on public.claude_code_agent_configs;
drop policy if exists "claude_code_agent_configs_insert_own" on public.claude_code_agent_configs;
drop policy if exists "claude_code_agent_configs_update_own" on public.claude_code_agent_configs;
drop policy if exists "claude_code_agent_configs_delete_own" on public.claude_code_agent_configs;

create policy "claude_code_agent_configs_select_own"
on public.claude_code_agent_configs
for select
using (auth.uid() = user_id);

create policy "claude_code_agent_configs_insert_own"
on public.claude_code_agent_configs
for insert
with check (auth.uid() = user_id);

create policy "claude_code_agent_configs_update_own"
on public.claude_code_agent_configs
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "claude_code_agent_configs_delete_own"
on public.claude_code_agent_configs
for delete
using (auth.uid() = user_id);

