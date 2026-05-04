-- Persist the latest connector-reported Aiyra voice runtime snapshot so
-- dashboards can query live-ish runtime status without depending on relay memory.

create table if not exists public.connector_aiyra_voice_health (
  device_id uuid primary key references public.devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'unknown',
  reason text null,
  detail text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_healthy_at timestamptz null,
  last_failure_at timestamptz null,
  listening boolean not null default false,
  active boolean not null default false,
  wake_word text null,
  wake_sensitivity real not null default 0,
  idle_timeout_ms integer not null default 0,
  wake_hits integer not null default 0,
  wake_suppressed integer not null default 0,
  missed_reports integer not null default 0,
  false_trigger_reports integer not null default 0,
  session_count integer not null default 0,
  session_error_count integer not null default 0,
  reconnect_attempt_count integer not null default 0,
  last_session_duration_ms integer not null default 0,
  last_metric_event text null,
  last_metric_at timestamptz null,
  constraint connector_aiyra_voice_health_status_check check (
    status in ('healthy', 'degraded', 'recovering', 'disabled', 'unknown')
  ),
  constraint connector_aiyra_voice_health_wake_sensitivity_check check (
    wake_sensitivity >= 0 and wake_sensitivity <= 1
  ),
  constraint connector_aiyra_voice_health_idle_timeout_ms_check check (
    idle_timeout_ms >= 0
  ),
  constraint connector_aiyra_voice_health_wake_hits_check check (
    wake_hits >= 0
  ),
  constraint connector_aiyra_voice_health_wake_suppressed_check check (
    wake_suppressed >= 0
  ),
  constraint connector_aiyra_voice_health_missed_reports_check check (
    missed_reports >= 0
  ),
  constraint connector_aiyra_voice_health_false_trigger_reports_check check (
    false_trigger_reports >= 0
  ),
  constraint connector_aiyra_voice_health_session_count_check check (
    session_count >= 0
  ),
  constraint connector_aiyra_voice_health_session_error_count_check check (
    session_error_count >= 0
  ),
  constraint connector_aiyra_voice_health_reconnect_attempt_count_check check (
    reconnect_attempt_count >= 0
  ),
  constraint connector_aiyra_voice_health_last_session_duration_ms_check check (
    last_session_duration_ms >= 0
  )
);

create index if not exists connector_aiyra_voice_health_user_updated_idx
  on public.connector_aiyra_voice_health (user_id, updated_at desc);

create index if not exists connector_aiyra_voice_health_status_updated_idx
  on public.connector_aiyra_voice_health (status, updated_at desc);

alter table public.connector_aiyra_voice_health enable row level security;

drop policy if exists "connector_aiyra_voice_health_select_own"
  on public.connector_aiyra_voice_health;

create policy "connector_aiyra_voice_health_select_own"
on public.connector_aiyra_voice_health
for select
using (auth.uid() = user_id);
