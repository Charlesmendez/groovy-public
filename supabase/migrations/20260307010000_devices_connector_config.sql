alter table public.devices
add column if not exists connector_config jsonb not null default '{}'::jsonb;
