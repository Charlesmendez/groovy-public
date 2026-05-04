-- SECURITY HARDENING
-- 1) Pairing codes: add hashed column so plaintext is not required at rest
-- 2) Device workspaces: add encrypted root path columns for at-rest privacy

-- ============ Pairing codes ============
alter table if exists public.device_pairing_codes
  add column if not exists code_hash text;

create index if not exists device_pairing_codes_code_hash_idx
  on public.device_pairing_codes (code_hash);

-- ============ Workspaces (encrypted root path) ============
alter table if exists public.device_workspaces
  add column if not exists root_path_enc text,
  add column if not exists root_path_iv text,
  add column if not exists root_path_tag text;

-- Note: keep existing root_path for backwards compatibility; new writes should prefer *_enc fields.

