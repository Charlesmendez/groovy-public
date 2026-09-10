-- Allow ordinary, private files in Team Chat while retaining the existing
-- channel-scoped authorization boundary and short-lived download URLs.

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
      'audio/x-wav',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/rtf',
      'application/zip',
      'application/json',
      'text/plain',
      'text/csv',
      'text/markdown'
    )
  );

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
    or
    (
      kind = 'file'
      and mime_type not like 'image/%'
      and mime_type not like 'audio/%'
      and duration_ms is null
    )
  );

alter table public.chat_message_attachments
  drop constraint if exists chat_message_attachments_position_check;

alter table public.chat_message_attachments
  add constraint chat_message_attachments_position_check
  check (position between 0 and 4);

comment on column public.chat_message_attachments.kind is
  'Presentation kind for a private Team Chat attachment: image, file, or voice.';
