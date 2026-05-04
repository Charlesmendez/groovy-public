-- FLOW: Cursor Cloud Agents configuration

-- =====================================
-- Cursor agent binding (agent->API key)
-- =====================================
create table if not exists public.cursor_agent_configs (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  cursor_api_key_enc text not null,  -- AES-256-GCM encrypted
  cursor_api_key_hash text not null, -- SHA-256 hash for lookup
  default_repository text null,      -- Default GitHub repo URL
  default_branch text null,          -- Default branch (e.g., main)
  auto_create_pr boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cursor_agent_configs_unique unique (user_id, agent_id)
);

create index if not exists cursor_agent_configs_user_idx
on public.cursor_agent_configs (user_id);

alter table public.cursor_agent_configs enable row level security;

drop policy if exists "cursor_agent_configs_select_own" on public.cursor_agent_configs;
drop policy if exists "cursor_agent_configs_insert_own" on public.cursor_agent_configs;
drop policy if exists "cursor_agent_configs_update_own" on public.cursor_agent_configs;
drop policy if exists "cursor_agent_configs_delete_own" on public.cursor_agent_configs;

create policy "cursor_agent_configs_select_own"
on public.cursor_agent_configs
for select
using (auth.uid() = user_id);

create policy "cursor_agent_configs_insert_own"
on public.cursor_agent_configs
for insert
with check (auth.uid() = user_id);

create policy "cursor_agent_configs_update_own"
on public.cursor_agent_configs
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "cursor_agent_configs_delete_own"
on public.cursor_agent_configs
for delete
using (auth.uid() = user_id);

-- =====================================
-- Cursor agent tasks (track cloud agent instances)
-- =====================================
create table if not exists public.cursor_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  cursor_agent_id text not null,     -- Cursor's bc_xxx ID
  name text null,
  status text not null default 'CREATING', -- CREATING, RUNNING, FINISHED, STOPPED, etc.
  repository text null,
  branch text null,
  branch_name text null,             -- Created branch name
  pr_url text null,
  agent_url text null,               -- URL to view in Cursor
  summary text null,
  prompt text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cursor_agent_tasks_agent_idx
on public.cursor_agent_tasks (agent_id, created_at desc);

create index if not exists cursor_agent_tasks_user_idx
on public.cursor_agent_tasks (user_id, created_at desc);

alter table public.cursor_agent_tasks enable row level security;

drop policy if exists "cursor_agent_tasks_select_own" on public.cursor_agent_tasks;
drop policy if exists "cursor_agent_tasks_insert_own" on public.cursor_agent_tasks;
drop policy if exists "cursor_agent_tasks_update_own" on public.cursor_agent_tasks;
drop policy if exists "cursor_agent_tasks_delete_own" on public.cursor_agent_tasks;

create policy "cursor_agent_tasks_select_own"
on public.cursor_agent_tasks
for select
using (auth.uid() = user_id);

create policy "cursor_agent_tasks_insert_own"
on public.cursor_agent_tasks
for insert
with check (auth.uid() = user_id);

create policy "cursor_agent_tasks_update_own"
on public.cursor_agent_tasks
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "cursor_agent_tasks_delete_own"
on public.cursor_agent_tasks
for delete
using (auth.uid() = user_id);
