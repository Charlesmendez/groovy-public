alter table public.connector_aiyra_voice_health
  add column if not exists low_mic_gain_detected boolean not null default false,
  add column if not exists low_mic_gain_at timestamptz null,
  add column if not exists low_mic_gain_message text null,
  add column if not exists low_mic_gain_max_energy_observed real null,
  add column if not exists low_mic_gain_threshold real null;

alter table public.connector_aiyra_voice_health
  drop constraint if exists connector_aiyra_voice_health_low_mic_gain_max_energy_observed_check;

alter table public.connector_aiyra_voice_health
  add constraint connector_aiyra_voice_health_low_mic_gain_max_energy_observed_check check (
    low_mic_gain_max_energy_observed is null or low_mic_gain_max_energy_observed >= 0
  );

alter table public.connector_aiyra_voice_health
  drop constraint if exists connector_aiyra_voice_health_low_mic_gain_threshold_check;

alter table public.connector_aiyra_voice_health
  add constraint connector_aiyra_voice_health_low_mic_gain_threshold_check check (
    low_mic_gain_threshold is null or low_mic_gain_threshold >= 0
  );
