-- Upready integration: flow user -> upready user link + one-time email confirmation tokens

create table if not exists public.upready_account_links (
  flow_user_id uuid primary key references auth.users (id) on delete cascade,
  upready_user_id uuid not null unique,
  upready_email text not null,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists upready_account_links_upready_user_idx
  on public.upready_account_links (upready_user_id);

create index if not exists upready_account_links_updated_idx
  on public.upready_account_links (updated_at desc);

alter table public.upready_account_links enable row level security;

drop policy if exists "upready_account_links_select_own" on public.upready_account_links;
drop policy if exists "upready_account_links_insert_own" on public.upready_account_links;
drop policy if exists "upready_account_links_update_own" on public.upready_account_links;
drop policy if exists "upready_account_links_delete_own" on public.upready_account_links;

create policy "upready_account_links_select_own"
on public.upready_account_links
for select
using (auth.uid() = flow_user_id);

create policy "upready_account_links_insert_own"
on public.upready_account_links
for insert
with check (auth.uid() = flow_user_id);

create policy "upready_account_links_update_own"
on public.upready_account_links
for update
using (auth.uid() = flow_user_id)
with check (auth.uid() = flow_user_id);

create policy "upready_account_links_delete_own"
on public.upready_account_links
for delete
using (auth.uid() = flow_user_id);

create table if not exists public.upready_link_tokens (
  id uuid primary key default gen_random_uuid(),
  flow_user_id uuid not null references auth.users (id) on delete cascade,
  upready_user_id uuid not null,
  upready_email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint upready_link_tokens_expiry_check check (expires_at > created_at)
);

create index if not exists upready_link_tokens_flow_user_idx
  on public.upready_link_tokens (flow_user_id, created_at desc);

create index if not exists upready_link_tokens_email_idx
  on public.upready_link_tokens (upready_email, created_at desc);

alter table public.upready_link_tokens enable row level security;

drop policy if exists "upready_link_tokens_select_own" on public.upready_link_tokens;
drop policy if exists "upready_link_tokens_insert_own" on public.upready_link_tokens;
drop policy if exists "upready_link_tokens_delete_own" on public.upready_link_tokens;

create policy "upready_link_tokens_select_own"
on public.upready_link_tokens
for select
using (auth.uid() = flow_user_id);

create policy "upready_link_tokens_insert_own"
on public.upready_link_tokens
for insert
with check (auth.uid() = flow_user_id);

create policy "upready_link_tokens_delete_own"
on public.upready_link_tokens
for delete
using (auth.uid() = flow_user_id);
