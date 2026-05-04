alter table public.user_aiyra_settings
add column if not exists tts_speed real null;

alter table public.user_aiyra_settings
drop constraint if exists user_aiyra_settings_tts_speed_check;

alter table public.user_aiyra_settings
add constraint user_aiyra_settings_tts_speed_check
check (tts_speed is null or (tts_speed >= 0.5 and tts_speed <= 2.0));
