create table if not exists public.aiyra_material_query_claims (
  conversation_id text primary key references public.aiyra_conversations(conversation_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_fingerprint text not null,
  normalized_query text not null,
  trace_id text not null,
  status text not null default 'running',
  response_text text null,
  error_text text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '45 seconds'),
  constraint aiyra_material_query_claims_status_check check (
    status in ('running', 'completed', 'failed')
  )
);

create index if not exists aiyra_material_query_claims_user_updated_idx
  on public.aiyra_material_query_claims (user_id, updated_at desc);

create index if not exists aiyra_material_query_claims_expires_idx
  on public.aiyra_material_query_claims (expires_at);

alter table public.aiyra_material_query_claims enable row level security;

drop policy if exists "aiyra_material_query_claims_select_own"
  on public.aiyra_material_query_claims;

create policy "aiyra_material_query_claims_select_own"
on public.aiyra_material_query_claims
for select
using (auth.uid() = user_id);
