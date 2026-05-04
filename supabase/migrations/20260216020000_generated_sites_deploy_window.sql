-- Backfill-safe migration for deploy rate-limit rolling window fields.
-- Safe to run even if columns already exist.

alter table public.generated_sites
  add column if not exists deploy_count_window int not null default 0;

alter table public.generated_sites
  add column if not exists deploy_window_started_at timestamptz not null default now();
