-- FLOW: AI Chat agents + sessions + document grounding

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- =====================
-- Flags (per-user keys)
-- =====================
create table if not exists public.flags (
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  label text not null,
  bg text not null,
  border text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.flags enable row level security;

drop policy if exists "flags_select_own" on public.flags;
drop policy if exists "flags_insert_own" on public.flags;
drop policy if exists "flags_update_own" on public.flags;
drop policy if exists "flags_delete_own" on public.flags;

create policy "flags_select_own"
on public.flags
for select
using (auth.uid() = user_id);

create policy "flags_insert_own"
on public.flags
for insert
with check (auth.uid() = user_id);

create policy "flags_update_own"
on public.flags
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "flags_delete_own"
on public.flags
for delete
using (auth.uid() = user_id);

-- =========
-- Agents
-- =========
create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null,
  name text not null,
  flag_key text null,
  provider text null,
  model text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agents_flag_fk foreign key (user_id, flag_key)
    references public.flags (user_id, key)
    on update cascade
    on delete set null
);

create index if not exists agents_user_id_idx on public.agents (user_id);
create index if not exists agents_user_type_idx on public.agents (user_id, type);

alter table public.agents enable row level security;

drop policy if exists "agents_select_own" on public.agents;
drop policy if exists "agents_insert_own" on public.agents;
drop policy if exists "agents_update_own" on public.agents;
drop policy if exists "agents_delete_own" on public.agents;

create policy "agents_select_own"
on public.agents
for select
using (auth.uid() = user_id);

create policy "agents_insert_own"
on public.agents
for insert
with check (auth.uid() = user_id);

create policy "agents_update_own"
on public.agents
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "agents_delete_own"
on public.agents
for delete
using (auth.uid() = user_id);

-- =============
-- Chat sessions
-- =============
create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_sessions_user_agent_idx on public.chat_sessions (user_id, agent_id);

alter table public.chat_sessions enable row level security;

drop policy if exists "chat_sessions_select_own" on public.chat_sessions;
drop policy if exists "chat_sessions_insert_own" on public.chat_sessions;
drop policy if exists "chat_sessions_update_own" on public.chat_sessions;
drop policy if exists "chat_sessions_delete_own" on public.chat_sessions;

create policy "chat_sessions_select_own"
on public.chat_sessions
for select
using (auth.uid() = user_id);

create policy "chat_sessions_insert_own"
on public.chat_sessions
for insert
with check (auth.uid() = user_id);

create policy "chat_sessions_update_own"
on public.chat_sessions
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "chat_sessions_delete_own"
on public.chat_sessions
for delete
using (auth.uid() = user_id);

-- ============
-- Chat messages
-- ============
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists chat_messages_user_session_created_idx
on public.chat_messages (user_id, session_id, created_at);

alter table public.chat_messages enable row level security;

drop policy if exists "chat_messages_select_own" on public.chat_messages;
drop policy if exists "chat_messages_insert_own" on public.chat_messages;
drop policy if exists "chat_messages_update_own" on public.chat_messages;
drop policy if exists "chat_messages_delete_own" on public.chat_messages;

create policy "chat_messages_select_own"
on public.chat_messages
for select
using (auth.uid() = user_id);

create policy "chat_messages_insert_own"
on public.chat_messages
for insert
with check (auth.uid() = user_id);

create policy "chat_messages_update_own"
on public.chat_messages
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "chat_messages_delete_own"
on public.chat_messages
for delete
using (auth.uid() = user_id);

-- =================
-- Chat attachments
-- =================
create table if not exists public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now(),
  constraint chat_attachments_no_images check (mime_type not like 'image/%')
);

create index if not exists chat_attachments_user_session_idx
on public.chat_attachments (user_id, session_id);

alter table public.chat_attachments enable row level security;

drop policy if exists "chat_attachments_select_own" on public.chat_attachments;
drop policy if exists "chat_attachments_insert_own" on public.chat_attachments;
drop policy if exists "chat_attachments_delete_own" on public.chat_attachments;

create policy "chat_attachments_select_own"
on public.chat_attachments
for select
using (auth.uid() = user_id);

create policy "chat_attachments_insert_own"
on public.chat_attachments
for insert
with check (auth.uid() = user_id);

create policy "chat_attachments_delete_own"
on public.chat_attachments
for delete
using (auth.uid() = user_id);

-- =========================
-- Document chunks (pgvector)
-- =========================
create table if not exists public.chat_doc_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  attachment_id uuid not null references public.chat_attachments (id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_doc_chunks_user_session_idx
on public.chat_doc_chunks (user_id, session_id);

-- ivfflat requires ANALYZE and enough rows to be effective; ok for production.
create index if not exists chat_doc_chunks_embedding_idx
on public.chat_doc_chunks
using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table public.chat_doc_chunks enable row level security;

drop policy if exists "chat_doc_chunks_select_own" on public.chat_doc_chunks;
drop policy if exists "chat_doc_chunks_insert_own" on public.chat_doc_chunks;
drop policy if exists "chat_doc_chunks_delete_own" on public.chat_doc_chunks;

create policy "chat_doc_chunks_select_own"
on public.chat_doc_chunks
for select
using (auth.uid() = user_id);

create policy "chat_doc_chunks_insert_own"
on public.chat_doc_chunks
for insert
with check (auth.uid() = user_id);

create policy "chat_doc_chunks_delete_own"
on public.chat_doc_chunks
for delete
using (auth.uid() = user_id);

-- =========================
-- Vector search RPC helper
-- =========================
create or replace function public.match_chat_doc_chunks(
  p_session_id uuid,
  p_embedding vector(1536),
  p_match_count int default 8
)
returns table (
  content text,
  attachment_id uuid,
  similarity float
)
language sql
stable
as $$
  select
    c.content,
    c.attachment_id,
    1 - (c.embedding <=> p_embedding) as similarity
  from public.chat_doc_chunks c
  where c.user_id = auth.uid()
    and c.session_id = p_session_id
  order by c.embedding <=> p_embedding
  limit p_match_count;
$$;

-- =========================
-- Storage bucket for uploads
-- =========================
insert into storage.buckets (id, name, public)
values ('chat_uploads', 'chat_uploads', false)
on conflict (id) do nothing;

-- Policies: store objects at path: {user_id}/{session_id}/{uuid}-{filename}
drop policy if exists "chat_uploads_select_own" on storage.objects;
drop policy if exists "chat_uploads_insert_own" on storage.objects;
drop policy if exists "chat_uploads_delete_own" on storage.objects;

create policy "chat_uploads_select_own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'chat_uploads'
  and auth.uid()::text = split_part(name, '/', 1)
);

create policy "chat_uploads_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'chat_uploads'
  and auth.uid()::text = split_part(name, '/', 1)
);

create policy "chat_uploads_delete_own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'chat_uploads'
  and auth.uid()::text = split_part(name, '/', 1)
);

