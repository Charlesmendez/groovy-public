-- External thread mapping for orchestrator (e.g., WhatsApp group -> orchestrator session)

create table if not exists public.orchestrator_external_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  thread_key text not null,
  thread_name text null,
  orchestrator_session_id uuid not null references public.orchestrator_sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orchestrator_external_threads_provider_key_unique unique (user_id, provider, thread_key)
);

create index if not exists orchestrator_external_threads_user_idx
  on public.orchestrator_external_threads(user_id, provider, updated_at desc);

alter table public.orchestrator_external_threads enable row level security;

drop policy if exists "orchestrator_external_threads_select_own" on public.orchestrator_external_threads;
drop policy if exists "orchestrator_external_threads_insert_own" on public.orchestrator_external_threads;
drop policy if exists "orchestrator_external_threads_update_own" on public.orchestrator_external_threads;
drop policy if exists "orchestrator_external_threads_delete_own" on public.orchestrator_external_threads;

create policy "orchestrator_external_threads_select_own"
on public.orchestrator_external_threads
for select
using (auth.uid() = user_id);

create policy "orchestrator_external_threads_insert_own"
on public.orchestrator_external_threads
for insert
with check (auth.uid() = user_id);

create policy "orchestrator_external_threads_update_own"
on public.orchestrator_external_threads
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "orchestrator_external_threads_delete_own"
on public.orchestrator_external_threads
for delete
using (auth.uid() = user_id);

