-- Provider-neutral Connector voice health shared by private and public builds.

create table if not exists public.connector_voice_health (
  device_id uuid primary key references public.devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'none',
  status text not null default 'unknown',
  listening boolean not null default false,
  active boolean not null default false,
  wake_word text null,
  detail text null,
  metrics jsonb not null default '{}'::jsonb,
  last_healthy_at timestamptz null,
  last_failure_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connector_voice_health_provider_check check (
    provider ~ '^[a-z0-9_]{1,64}$'
  ),
  constraint connector_voice_health_status_check check (
    status in ('healthy', 'degraded', 'recovering', 'disabled', 'unknown')
  )
);

alter table public.connector_voice_health enable row level security;

drop policy if exists "connector_voice_health_select_own" on public.connector_voice_health;
create policy "connector_voice_health_select_own" on public.connector_voice_health
for select using (auth.uid() = user_id);
