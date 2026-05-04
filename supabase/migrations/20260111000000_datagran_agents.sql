-- FLOW: Datagran integration agents

-- =====================================
-- Datagran agent configs (agent->connection)
-- =====================================
create table if not exists public.datagran_agent_configs (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  datagran_api_key_enc text not null,
  datagran_api_key_hash text not null,
  provider text not null check (provider in (
    'facebook_ads', 'facebook_leads', 'instagram', 'google_ads', 
    'linkedin_ads', 'google_drive', 'tiktok', 'postgres', 'firecrawl'
  )),
  connection_id text null,
  end_user_external_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint datagran_agent_configs_unique unique (user_id, agent_id)
);

create index if not exists datagran_agent_configs_user_idx
on public.datagran_agent_configs (user_id);

create index if not exists datagran_agent_configs_connection_idx
on public.datagran_agent_configs (connection_id);

alter table public.datagran_agent_configs enable row level security;

drop policy if exists "datagran_agent_configs_select_own" on public.datagran_agent_configs;
drop policy if exists "datagran_agent_configs_insert_own" on public.datagran_agent_configs;
drop policy if exists "datagran_agent_configs_update_own" on public.datagran_agent_configs;
drop policy if exists "datagran_agent_configs_delete_own" on public.datagran_agent_configs;

create policy "datagran_agent_configs_select_own"
on public.datagran_agent_configs
for select
using (auth.uid() = user_id);

create policy "datagran_agent_configs_insert_own"
on public.datagran_agent_configs
for insert
with check (auth.uid() = user_id);

create policy "datagran_agent_configs_update_own"
on public.datagran_agent_configs
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "datagran_agent_configs_delete_own"
on public.datagran_agent_configs
for delete
using (auth.uid() = user_id);
