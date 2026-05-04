alter table public.connector_aiyra_voice_health
  add column if not exists muted boolean not null default false,
  add column if not exists configured_mic_name text null,
  add column if not exists resolved_device_name text null,
  add column if not exists mic_selection_fallback_reason text null,
  add column if not exists mic_input_level real null,
  add column if not exists mic_input_updated_at timestamptz null;

alter table public.connector_aiyra_voice_health
  drop constraint if exists connector_aiyra_voice_health_mic_input_level_check;

alter table public.connector_aiyra_voice_health
  add constraint connector_aiyra_voice_health_mic_input_level_check check (
    mic_input_level is null or (mic_input_level >= 0 and mic_input_level <= 1)
  );
