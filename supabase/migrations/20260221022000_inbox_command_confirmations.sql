-- Persist pending inbox-action confirmations per session.
-- This enables users to reply with natural confirmation language (not necessarily "confirm")
-- after the assistant previews an implicit/bulk approve/reject selection.

create table if not exists public.inbox_command_confirmations (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.orchestrator_sessions(id) on delete cascade,
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  consumed_at timestamptz null,
  primary key (user_id, session_id),
  constraint inbox_command_confirmations_status_check
    check (status in ('pending', 'consumed', 'cancelled'))
);

create index if not exists inbox_command_confirmations_user_status_idx
  on public.inbox_command_confirmations(user_id, status, updated_at desc);

alter table public.inbox_command_confirmations enable row level security;

drop policy if exists "inbox_command_confirmations_select_own" on public.inbox_command_confirmations;
drop policy if exists "inbox_command_confirmations_insert_own" on public.inbox_command_confirmations;
drop policy if exists "inbox_command_confirmations_update_own" on public.inbox_command_confirmations;
drop policy if exists "inbox_command_confirmations_delete_own" on public.inbox_command_confirmations;

create policy "inbox_command_confirmations_select_own"
on public.inbox_command_confirmations
for select
using (auth.uid() = user_id);

create policy "inbox_command_confirmations_insert_own"
on public.inbox_command_confirmations
for insert
with check (auth.uid() = user_id);

create policy "inbox_command_confirmations_update_own"
on public.inbox_command_confirmations
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "inbox_command_confirmations_delete_own"
on public.inbox_command_confirmations
for delete
using (auth.uid() = user_id);

