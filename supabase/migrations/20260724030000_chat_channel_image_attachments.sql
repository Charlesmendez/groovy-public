-- Private image attachments for Team Chat. Objects remain in the existing
-- private chat_uploads bucket; this table is the channel-scoped authorization
-- record used before issuing a short-lived signed URL.

create table if not exists public.chat_message_attachments (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null
    references public.chat_channels(id) on delete cascade,
  message_id uuid not null
    references public.chat_messages(id) on delete cascade,
  uploaded_by uuid references auth.users(id) on delete set null,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 2097152),
  position smallint not null check (position between 0 and 2),
  created_at timestamptz not null default now()
);

create index if not exists chat_message_attachments_message_idx
  on public.chat_message_attachments(message_id, created_at);

create index if not exists chat_message_attachments_channel_idx
  on public.chat_message_attachments(channel_id, created_at);

create unique index if not exists chat_message_attachments_position_idx
  on public.chat_message_attachments(message_id, position);

alter table public.chat_message_attachments enable row level security;

-- Writes happen only through the authorized Team Chat API after its user
-- message insert has passed chat_messages RLS. There is intentionally no
-- browser select/insert/update/delete policy; even storage paths stay
-- server-only. The delivery route first checks chat_channels with the user's
-- RLS session, then resolves the attachment with the service client.
