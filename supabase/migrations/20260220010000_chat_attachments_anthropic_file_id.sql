-- Bind Anthropic Files API IDs to persisted chat attachments.
-- This allows server-side ownership validation before container_upload.

alter table public.chat_attachments
  add column if not exists anthropic_file_id text;

create index if not exists chat_attachments_user_session_anthropic_idx
on public.chat_attachments (user_id, session_id, anthropic_file_id)
where anthropic_file_id is not null;
