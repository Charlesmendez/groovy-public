-- Standards-based Web Push for Team Chat.
--
-- Device subscriptions are private to each authenticated user. Notification
-- preferences are explicit per room (channel or DM); the absence of a row is
-- intentionally equivalent to "off" so a new device never becomes a
-- workspace-wide notification firehose.

create table if not exists public.web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  expiration_time bigint,
  device_label text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  unique (endpoint)
);

alter table public.web_push_subscriptions
  drop constraint if exists web_push_subscriptions_endpoint_length_check;
alter table public.web_push_subscriptions
  add constraint web_push_subscriptions_endpoint_length_check
  check (char_length(endpoint) between 16 and 2048);

alter table public.web_push_subscriptions
  drop constraint if exists web_push_subscriptions_key_length_check;
alter table public.web_push_subscriptions
  add constraint web_push_subscriptions_key_length_check
  check (
    char_length(p256dh) between 16 and 512
    and char_length(auth) between 8 and 256
  );

create index if not exists web_push_subscriptions_user_idx
  on public.web_push_subscriptions(user_id, updated_at desc);

create table if not exists public.chat_notification_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  mode text not null default 'off'
    check (mode in ('off', 'mentions', 'all')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, channel_id)
);

create index if not exists chat_notification_preferences_channel_idx
  on public.chat_notification_preferences(channel_id, mode, user_id);

alter table public.web_push_subscriptions enable row level security;
alter table public.chat_notification_preferences enable row level security;

drop policy if exists "web_push_subscriptions_select_own"
  on public.web_push_subscriptions;
create policy "web_push_subscriptions_select_own"
on public.web_push_subscriptions
for select
using (user_id = auth.uid());

drop policy if exists "web_push_subscriptions_insert_own"
  on public.web_push_subscriptions;
create policy "web_push_subscriptions_insert_own"
on public.web_push_subscriptions
for insert
with check (user_id = auth.uid());

drop policy if exists "web_push_subscriptions_update_own"
  on public.web_push_subscriptions;
create policy "web_push_subscriptions_update_own"
on public.web_push_subscriptions
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "web_push_subscriptions_delete_own"
  on public.web_push_subscriptions;
create policy "web_push_subscriptions_delete_own"
on public.web_push_subscriptions
for delete
using (user_id = auth.uid());

drop policy if exists "chat_notification_preferences_select_own"
  on public.chat_notification_preferences;
create policy "chat_notification_preferences_select_own"
on public.chat_notification_preferences
for select
using (
  user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
);

drop policy if exists "chat_notification_preferences_insert_own"
  on public.chat_notification_preferences;
create policy "chat_notification_preferences_insert_own"
on public.chat_notification_preferences
for insert
with check (
  user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
);

drop policy if exists "chat_notification_preferences_update_own"
  on public.chat_notification_preferences;
create policy "chat_notification_preferences_update_own"
on public.chat_notification_preferences
for update
using (
  user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
)
with check (
  user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
);

drop policy if exists "chat_notification_preferences_delete_own"
  on public.chat_notification_preferences;
create policy "chat_notification_preferences_delete_own"
on public.chat_notification_preferences
for delete
using (user_id = auth.uid());

comment on table public.web_push_subscriptions is
  'Per-device browser Web Push subscriptions. Endpoint and encryption keys are never exposed to other users.';
comment on table public.chat_notification_preferences is
  'Explicit per-user, per-room Chat notification policy. Missing rows mean off.';
