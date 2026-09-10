-- Groovy Email workspace: per-mailbox identity, reusable snippets, and
-- durable feedback that teaches future triage decisions.

create table if not exists public.email_mailbox_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'gmail',
  connection_id text not null,
  display_name text not null,
  color text not null default '#22d3ee',
  is_default_sender boolean not null default false,
  included_in_unified boolean not null default true,
  ai_instructions text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_mailbox_preferences_provider_check
    check (provider in ('gmail')),
  constraint email_mailbox_preferences_color_check
    check (color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint email_mailbox_preferences_user_connection_unique
    unique (user_id, provider, connection_id)
);

create unique index if not exists email_mailbox_preferences_default_sender_idx
  on public.email_mailbox_preferences(user_id, provider)
  where is_default_sender = true;

create index if not exists email_mailbox_preferences_user_idx
  on public.email_mailbox_preferences(user_id, included_in_unified, created_at);

alter table public.email_mailbox_preferences enable row level security;

drop policy if exists "email_mailbox_preferences_select_own" on public.email_mailbox_preferences;
drop policy if exists "email_mailbox_preferences_insert_own" on public.email_mailbox_preferences;
drop policy if exists "email_mailbox_preferences_update_own" on public.email_mailbox_preferences;
drop policy if exists "email_mailbox_preferences_delete_own" on public.email_mailbox_preferences;

create policy "email_mailbox_preferences_select_own"
on public.email_mailbox_preferences for select
using (auth.uid() = user_id);

create policy "email_mailbox_preferences_insert_own"
on public.email_mailbox_preferences for insert
with check (auth.uid() = user_id);

create policy "email_mailbox_preferences_update_own"
on public.email_mailbox_preferences for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "email_mailbox_preferences_delete_own"
on public.email_mailbox_preferences for delete
using (auth.uid() = user_id);

create table if not exists public.email_snippets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  shortcut text null,
  mailbox_connection_ids jsonb not null default '[]'::jsonb,
  to_recipients jsonb not null default '[]'::jsonb,
  cc_recipients jsonb not null default '[]'::jsonb,
  bcc_recipients jsonb not null default '[]'::jsonb,
  subject text not null default '',
  body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_snippets_name_nonempty_check
    check (length(btrim(name)) > 0),
  constraint email_snippets_shortcut_format_check
    check (
      shortcut is null
      or shortcut = ''
      or shortcut ~ '^[A-Za-z0-9_-]{1,32}$'
    ),
  constraint email_snippets_mailbox_array_check
    check (jsonb_typeof(mailbox_connection_ids) = 'array'),
  constraint email_snippets_to_array_check
    check (jsonb_typeof(to_recipients) = 'array'),
  constraint email_snippets_cc_array_check
    check (jsonb_typeof(cc_recipients) = 'array'),
  constraint email_snippets_bcc_array_check
    check (jsonb_typeof(bcc_recipients) = 'array')
);

create unique index if not exists email_snippets_user_shortcut_unique_idx
  on public.email_snippets(user_id, lower(shortcut))
  where shortcut is not null and shortcut <> '';

create index if not exists email_snippets_user_updated_idx
  on public.email_snippets(user_id, updated_at desc);

alter table public.email_snippets enable row level security;

drop policy if exists "email_snippets_select_own" on public.email_snippets;
drop policy if exists "email_snippets_insert_own" on public.email_snippets;
drop policy if exists "email_snippets_update_own" on public.email_snippets;
drop policy if exists "email_snippets_delete_own" on public.email_snippets;

create policy "email_snippets_select_own"
on public.email_snippets for select
using (auth.uid() = user_id);

create policy "email_snippets_insert_own"
on public.email_snippets for insert
with check (auth.uid() = user_id);

create policy "email_snippets_update_own"
on public.email_snippets for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "email_snippets_delete_own"
on public.email_snippets for delete
using (auth.uid() = user_id);

create table if not exists public.email_classification_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'gmail',
  connection_id text not null,
  gmail_message_id text null,
  gmail_thread_id text null,
  action_id uuid null references public.inbox_actions(id) on delete set null,
  sender_email text null,
  sender_domain text null,
  previous_action text null,
  corrected_action text not null,
  scope text not null default 'mailbox',
  created_at timestamptz not null default now(),
  constraint email_classification_feedback_provider_check
    check (provider in ('gmail')),
  constraint email_classification_feedback_scope_check
    check (scope in ('mailbox', 'global')),
  constraint email_classification_feedback_action_check
    check (corrected_action in ('focus', 'inbox', 'noise', 'handled'))
);

create index if not exists email_classification_feedback_sender_idx
  on public.email_classification_feedback(
    user_id,
    connection_id,
    sender_email,
    created_at desc
  );

alter table public.email_classification_feedback enable row level security;

drop policy if exists "email_classification_feedback_select_own" on public.email_classification_feedback;
drop policy if exists "email_classification_feedback_insert_own" on public.email_classification_feedback;
drop policy if exists "email_classification_feedback_update_own" on public.email_classification_feedback;
drop policy if exists "email_classification_feedback_delete_own" on public.email_classification_feedback;

create policy "email_classification_feedback_select_own"
on public.email_classification_feedback for select
using (auth.uid() = user_id);

create policy "email_classification_feedback_insert_own"
on public.email_classification_feedback for insert
with check (auth.uid() = user_id);

create policy "email_classification_feedback_update_own"
on public.email_classification_feedback for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "email_classification_feedback_delete_own"
on public.email_classification_feedback for delete
using (auth.uid() = user_id);

alter table public.inbox_actions
  add column if not exists draft_cc jsonb null,
  add column if not exists draft_bcc jsonb null;

update public.inbox_actions
set draft_cc = metadata->'draft_cc'
where draft_cc is null
  and jsonb_typeof(metadata->'draft_cc') = 'array';
