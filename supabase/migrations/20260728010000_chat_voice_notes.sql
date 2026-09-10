-- Extend the existing private Team Chat attachment boundary with voice notes.
-- The browser still never receives storage paths: the authorized attachment
-- route verifies channel membership before issuing a short-lived signed URL.

alter table public.chat_message_attachments
  add column if not exists kind text not null default 'image',
  add column if not exists duration_ms integer;

alter table public.chat_message_attachments
  drop constraint if exists chat_message_attachments_mime_type_check;

alter table public.chat_message_attachments
  add constraint chat_message_attachments_mime_type_check
  check (
    mime_type in (
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'audio/webm',
      'audio/ogg',
      'audio/mp4',
      'audio/mpeg',
      'audio/wav',
      'audio/x-wav'
    )
  );

alter table public.chat_message_attachments
  drop constraint if exists chat_message_attachments_size_bytes_check;

alter table public.chat_message_attachments
  add constraint chat_message_attachments_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 12582912);

alter table public.chat_message_attachments
  drop constraint if exists chat_message_attachments_kind_check;

alter table public.chat_message_attachments
  add constraint chat_message_attachments_kind_check
  check (
    (
      kind = 'image'
      and mime_type like 'image/%'
      and duration_ms is null
    )
    or
    (
      kind = 'voice'
      and mime_type like 'audio/%'
      and duration_ms between 250 and 600000
    )
  );

comment on column public.chat_message_attachments.kind is
  'Presentation kind for a private Team Chat attachment: image or voice.';

comment on column public.chat_message_attachments.duration_ms is
  'Client-measured voice-note duration, bounded again by the Chat API.';
