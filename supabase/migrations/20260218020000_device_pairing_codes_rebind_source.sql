-- Allow pairing-code flow to explicitly request schedule migration
-- from one prior connector device to the newly paired connector.
alter table if exists public.device_pairing_codes
  add column if not exists rebind_from_device_id uuid null
    references public.devices (id)
    on delete set null;

