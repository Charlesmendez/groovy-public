-- Map external threads (e.g. WhatsApp group) -> Claude Code sessions (agents)
-- This enables WhatsApp @code sessions to show up in the dashboard Code agent.

create table if not exists public.claude_code_external_threads (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  thread_key text not null,
  thread_name text null,
  claude_code_agent_id uuid not null references public.agents (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider, thread_key)
);

create index if not exists claude_code_external_threads_user_provider_idx
on public.claude_code_external_threads (user_id, provider, thread_key);

alter table public.claude_code_external_threads enable row level security;

drop policy if exists "claude_code_external_threads_select_own" on public.claude_code_external_threads;
drop policy if exists "claude_code_external_threads_insert_own" on public.claude_code_external_threads;
drop policy if exists "claude_code_external_threads_update_own" on public.claude_code_external_threads;
drop policy if exists "claude_code_external_threads_delete_own" on public.claude_code_external_threads;

create policy "claude_code_external_threads_select_own"
on public.claude_code_external_threads
for select
using (auth.uid() = user_id);

create policy "claude_code_external_threads_insert_own"
on public.claude_code_external_threads
for insert
with check (auth.uid() = user_id);

create policy "claude_code_external_threads_update_own"
on public.claude_code_external_threads
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "claude_code_external_threads_delete_own"
on public.claude_code_external_threads
for delete
using (auth.uid() = user_id);

