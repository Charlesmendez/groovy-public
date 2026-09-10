-- Server-backed composer recovery makes Groovy drafts available across the
-- desktop, mobile web app, and installed Home Screen app. Gmail remains the
-- delivery authority; this table stores the editable Groovy representation,
-- including attachment paths that cannot be reconstructed from another
-- browser's localStorage.

create table if not exists public.email_composer_drafts (
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id text not null,
  gmail_draft_id text not null,
  local_id text not null,
  action_id text null,
  gmail_thread_id text null,
  gmail_source_message_id text null,
  to_recipients text not null default '',
  cc_recipients text not null default '',
  bcc_recipients text not null default '',
  subject text not null default '',
  body text not null default '',
  body_html text null,
  attachments jsonb not null default '[]'::jsonb,
  in_reply_to text null,
  references_header text null,
  ai_generated boolean not null default false,
  untouched boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, connection_id, gmail_draft_id),
  constraint email_composer_drafts_attachments_array_check
    check (jsonb_typeof(attachments) = 'array'),
  constraint email_composer_drafts_local_id_length_check
    check (length(local_id) between 1 and 180)
);

create index if not exists email_composer_drafts_user_updated_idx
  on public.email_composer_drafts(user_id, updated_at desc);

alter table public.email_composer_drafts enable row level security;

drop policy if exists "email_composer_drafts_select_own"
  on public.email_composer_drafts;
drop policy if exists "email_composer_drafts_insert_own"
  on public.email_composer_drafts;
drop policy if exists "email_composer_drafts_update_own"
  on public.email_composer_drafts;
drop policy if exists "email_composer_drafts_delete_own"
  on public.email_composer_drafts;

create policy "email_composer_drafts_select_own"
on public.email_composer_drafts for select
using (auth.uid() = user_id);

create policy "email_composer_drafts_insert_own"
on public.email_composer_drafts for insert
with check (auth.uid() = user_id);

create policy "email_composer_drafts_update_own"
on public.email_composer_drafts for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "email_composer_drafts_delete_own"
on public.email_composer_drafts for delete
using (auth.uid() = user_id);
