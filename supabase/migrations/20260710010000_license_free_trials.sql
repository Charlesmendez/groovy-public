-- Server-authoritative, one-time free trials. Users can read their own trial
-- window, but only trusted server code may create or mutate it.
create table if not exists public.license_free_trials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  converted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint license_free_trials_window_check check (ends_at > started_at)
);

alter table public.license_free_trials enable row level security;

drop policy if exists "license_free_trials_select_own" on public.license_free_trials;
create policy "license_free_trials_select_own"
on public.license_free_trials for select
using (auth.uid() = user_id);

create index if not exists license_free_trials_ends_at_idx
on public.license_free_trials (ends_at);
