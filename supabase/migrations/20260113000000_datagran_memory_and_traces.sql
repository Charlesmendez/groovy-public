-- FLOW: Datagran unified memory + agent traces

create extension if not exists "pgcrypto";

-- ==========================================
-- Datagran memory config (per user, global)
-- ==========================================
create table if not exists public.datagran_memory_configs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  datagran_api_key_enc text not null,
  datagran_api_key_hash text not null,
  end_user_external_id text not null,
  connection_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists datagran_memory_configs_user_idx
on public.datagran_memory_configs (user_id);

create index if not exists datagran_memory_configs_connection_idx
on public.datagran_memory_configs (connection_id);

alter table public.datagran_memory_configs enable row level security;

drop policy if exists "datagran_memory_configs_select_own" on public.datagran_memory_configs;
drop policy if exists "datagran_memory_configs_insert_own" on public.datagran_memory_configs;
drop policy if exists "datagran_memory_configs_update_own" on public.datagran_memory_configs;
drop policy if exists "datagran_memory_configs_delete_own" on public.datagran_memory_configs;

create policy "datagran_memory_configs_select_own"
on public.datagran_memory_configs
for select
using (auth.uid() = user_id);

create policy "datagran_memory_configs_insert_own"
on public.datagran_memory_configs
for insert
with check (auth.uid() = user_id);

create policy "datagran_memory_configs_update_own"
on public.datagran_memory_configs
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "datagran_memory_configs_delete_own"
on public.datagran_memory_configs
for delete
using (auth.uid() = user_id);

-- ==================
-- Agent interaction traces
-- ==================
create table if not exists public.agent_traces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  agent_id uuid null references public.agents (id) on delete set null,
  session_id uuid null references public.chat_sessions (id) on delete set null,
  agent_name text not null,
  agent_type text not null,
  flag_key text null,
  provider text null,
  model text null,
  prompt text not null,
  response text null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null,
  datagran_compiled_memory_id text null,
  datagran_trace_id text null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists agent_traces_user_created_idx
on public.agent_traces (user_id, created_at desc);

create index if not exists agent_traces_user_agent_created_idx
on public.agent_traces (user_id, agent_id, created_at desc);

alter table public.agent_traces enable row level security;

drop policy if exists "agent_traces_select_own" on public.agent_traces;
drop policy if exists "agent_traces_insert_own" on public.agent_traces;
drop policy if exists "agent_traces_update_own" on public.agent_traces;
drop policy if exists "agent_traces_delete_own" on public.agent_traces;

create policy "agent_traces_select_own"
on public.agent_traces
for select
using (auth.uid() = user_id);

create policy "agent_traces_insert_own"
on public.agent_traces
for insert
with check (auth.uid() = user_id);

create policy "agent_traces_update_own"
on public.agent_traces
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "agent_traces_delete_own"
on public.agent_traces
for delete
using (auth.uid() = user_id);

