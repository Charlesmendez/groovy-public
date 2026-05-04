-- Aiyra voice runtime configuration + conversation binding for delegated material queries.

create table if not exists public.user_aiyra_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  api_key_enc text null,
  api_key_hash text null,
  persona_prompt text null,
  voice_id text null,
  wake_word text not null default 'hey groovy',
  wake_sensitivity real not null default 0.5,
  idle_timeout_ms integer not null default 12000,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_aiyra_settings_key_pair_check check (
    (api_key_enc is null and api_key_hash is null) or
    (api_key_enc is not null and api_key_hash is not null)
  ),
  constraint user_aiyra_settings_wake_sensitivity_check check (
    wake_sensitivity >= 0 and wake_sensitivity <= 1
  ),
  constraint user_aiyra_settings_idle_timeout_check check (
    idle_timeout_ms >= 2000 and idle_timeout_ms <= 120000
  )
);

create table if not exists public.aiyra_conversations (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  orchestrator_session_id uuid not null references public.orchestrator_sessions(id) on delete cascade,
  device_id uuid null references public.devices(id) on delete set null,
  channel_mode text not null default 'mic_main',
  account_id text null,
  key_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aiyra_conversations_channel_mode_check check (
    channel_mode in ('mic_main', 'twilio_main')
  )
);

create index if not exists aiyra_conversations_user_device_mode_idx
  on public.aiyra_conversations (user_id, device_id, channel_mode, updated_at desc);

create index if not exists aiyra_conversations_user_updated_idx
  on public.aiyra_conversations (user_id, updated_at desc);

alter table public.user_aiyra_settings enable row level security;
alter table public.aiyra_conversations enable row level security;

drop policy if exists "user_aiyra_settings_select_own" on public.user_aiyra_settings;
drop policy if exists "user_aiyra_settings_insert_own" on public.user_aiyra_settings;
drop policy if exists "user_aiyra_settings_update_own" on public.user_aiyra_settings;
drop policy if exists "user_aiyra_settings_delete_own" on public.user_aiyra_settings;

create policy "user_aiyra_settings_select_own"
on public.user_aiyra_settings
for select
using (auth.uid() = user_id);

create policy "user_aiyra_settings_insert_own"
on public.user_aiyra_settings
for insert
with check (auth.uid() = user_id);

create policy "user_aiyra_settings_update_own"
on public.user_aiyra_settings
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "user_aiyra_settings_delete_own"
on public.user_aiyra_settings
for delete
using (auth.uid() = user_id);

drop policy if exists "aiyra_conversations_select_own" on public.aiyra_conversations;
drop policy if exists "aiyra_conversations_insert_own" on public.aiyra_conversations;
drop policy if exists "aiyra_conversations_update_own" on public.aiyra_conversations;
drop policy if exists "aiyra_conversations_delete_own" on public.aiyra_conversations;

create policy "aiyra_conversations_select_own"
on public.aiyra_conversations
for select
using (auth.uid() = user_id);

create policy "aiyra_conversations_insert_own"
on public.aiyra_conversations
for insert
with check (auth.uid() = user_id);

create policy "aiyra_conversations_update_own"
on public.aiyra_conversations
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "aiyra_conversations_delete_own"
on public.aiyra_conversations
for delete
using (auth.uid() = user_id);
