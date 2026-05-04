-- Handshake: Agent-to-agent communication sessions
-- Allows two orchestrator sessions (panes) to collaborate by exchanging messages.

create table if not exists public.handshake_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pane_a_session_id uuid not null references public.orchestrator_sessions(id) on delete cascade,
  pane_b_session_id uuid not null references public.orchestrator_sessions(id) on delete cascade,
  status text not null default 'active',
  metadata jsonb null,
  created_at timestamptz not null default now(),
  closed_at timestamptz null,
  constraint handshake_sessions_status_check check (status in ('active', 'closed')),
  constraint handshake_sessions_unique_active_pair unique (pane_a_session_id, pane_b_session_id)
);

create index if not exists handshake_sessions_user_id_idx on public.handshake_sessions (user_id);
create index if not exists handshake_sessions_pane_a_idx on public.handshake_sessions (pane_a_session_id);
create index if not exists handshake_sessions_pane_b_idx on public.handshake_sessions (pane_b_session_id);
create index if not exists handshake_sessions_status_idx on public.handshake_sessions (status) where status = 'active';

alter table public.handshake_sessions enable row level security;

drop policy if exists "handshake_sessions_select_own" on public.handshake_sessions;
drop policy if exists "handshake_sessions_insert_own" on public.handshake_sessions;
drop policy if exists "handshake_sessions_update_own" on public.handshake_sessions;
drop policy if exists "handshake_sessions_delete_own" on public.handshake_sessions;

create policy "handshake_sessions_select_own"
on public.handshake_sessions for select using (auth.uid() = user_id);

create policy "handshake_sessions_insert_own"
on public.handshake_sessions for insert with check (auth.uid() = user_id);

create policy "handshake_sessions_update_own"
on public.handshake_sessions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "handshake_sessions_delete_own"
on public.handshake_sessions for delete using (auth.uid() = user_id);

-- Handshake messages: inter-agent communication log
create table if not exists public.handshake_messages (
  id uuid primary key default gen_random_uuid(),
  handshake_id uuid not null references public.handshake_sessions(id) on delete cascade,
  from_session_id uuid not null,
  to_session_id uuid not null,
  content text not null,
  metadata jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists handshake_messages_handshake_id_idx on public.handshake_messages (handshake_id);
create index if not exists handshake_messages_created_at_idx on public.handshake_messages (handshake_id, created_at);

alter table public.handshake_messages enable row level security;

-- RLS via join to parent handshake_sessions
drop policy if exists "handshake_messages_select_own" on public.handshake_messages;
drop policy if exists "handshake_messages_insert_own" on public.handshake_messages;

create policy "handshake_messages_select_own"
on public.handshake_messages for select using (
  exists (
    select 1 from public.handshake_sessions hs
    where hs.id = handshake_id and hs.user_id = auth.uid()
  )
);

create policy "handshake_messages_insert_own"
on public.handshake_messages for insert with check (
  exists (
    select 1 from public.handshake_sessions hs
    where hs.id = handshake_id and hs.user_id = auth.uid()
  )
);
