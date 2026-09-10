-- Gmail profile lookup is otherwise serialized in front of the first thread
-- open and send after a cold start. The address is stable connection identity,
-- so retain the last verified value and refresh it during advisory health sync.

alter table public.email_mailbox_preferences
  add column if not exists email_address text null;
