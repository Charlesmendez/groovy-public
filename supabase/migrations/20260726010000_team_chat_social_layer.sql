-- Additive social collaboration primitives for Team Chat.
--
-- These tables deliberately reference the existing chat channel/message
-- boundaries instead of creating a second conversation model. Human profile
-- data is visible only to people who currently share a workspace. Every
-- message interaction also carries channel_id so RLS can authorize it without
-- exposing the underlying message through a security-definer shortcut.

create or replace function public.shares_workspace_with_user(other_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select
    auth.uid() = other_user_id
    or exists (
      select 1
      from public.workspace_members mine
      join public.workspace_members theirs
        on theirs.workspace_id = mine.workspace_id
      where mine.user_id = auth.uid()
        and theirs.user_id = other_user_id
    );
$$;

revoke all on function public.shares_workspace_with_user(uuid) from public;
grant execute on function public.shares_workspace_with_user(uuid)
  to authenticated;

create table if not exists public.chat_member_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_path text,
  status_emoji text,
  status_text text,
  status_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_member_profiles_display_name_check
    check (display_name is null or char_length(display_name) between 1 and 80),
  constraint chat_member_profiles_avatar_path_check
    check (
      avatar_path is null
      or (
        char_length(avatar_path) between 8 and 700
        and avatar_path like (user_id::text || '/avatars/%')
      )
    ),
  constraint chat_member_profiles_status_emoji_check
    check (status_emoji is null or char_length(status_emoji) between 1 and 24),
  constraint chat_member_profiles_status_text_check
    check (status_text is null or char_length(status_text) between 1 and 120)
);

alter table public.chat_member_profiles enable row level security;

drop policy if exists "chat_member_profiles_select_shared_workspace"
  on public.chat_member_profiles;
create policy "chat_member_profiles_select_shared_workspace"
on public.chat_member_profiles
for select
using (public.shares_workspace_with_user(user_id));

drop policy if exists "chat_member_profiles_insert_own"
  on public.chat_member_profiles;
create policy "chat_member_profiles_insert_own"
on public.chat_member_profiles
for insert
with check (user_id = auth.uid());

drop policy if exists "chat_member_profiles_update_own"
  on public.chat_member_profiles;
create policy "chat_member_profiles_update_own"
on public.chat_member_profiles
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "chat_member_profiles_delete_own"
  on public.chat_member_profiles;
create policy "chat_member_profiles_delete_own"
on public.chat_member_profiles
for delete
using (user_id = auth.uid());

create table if not exists public.chat_member_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  availability text not null default 'online'
    check (availability in ('online', 'away', 'dnd')),
  last_active_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_member_presence_active_idx
  on public.chat_member_presence(last_active_at desc);

alter table public.chat_member_presence enable row level security;

drop policy if exists "chat_member_presence_select_shared_workspace"
  on public.chat_member_presence;
create policy "chat_member_presence_select_shared_workspace"
on public.chat_member_presence
for select
using (public.shares_workspace_with_user(user_id));

drop policy if exists "chat_member_presence_insert_own"
  on public.chat_member_presence;
create policy "chat_member_presence_insert_own"
on public.chat_member_presence
for insert
with check (user_id = auth.uid());

drop policy if exists "chat_member_presence_update_own"
  on public.chat_member_presence;
create policy "chat_member_presence_update_own"
on public.chat_member_presence
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "chat_member_presence_delete_own"
  on public.chat_member_presence;
create policy "chat_member_presence_delete_own"
on public.chat_member_presence
for delete
using (user_id = auth.uid());

create table if not exists public.chat_typing_indicators (
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_root_message_id uuid references public.chat_messages(id) on delete cascade,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists chat_typing_indicators_scope_idx
  on public.chat_typing_indicators(
    channel_id,
    user_id,
    coalesce(thread_root_message_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
create index if not exists chat_typing_indicators_expiry_idx
  on public.chat_typing_indicators(channel_id, expires_at);

alter table public.chat_typing_indicators enable row level security;

drop policy if exists "chat_typing_indicators_select"
  on public.chat_typing_indicators;
create policy "chat_typing_indicators_select"
on public.chat_typing_indicators
for select
using (public.can_read_chat_channel(channel_id));

drop policy if exists "chat_typing_indicators_insert_own"
  on public.chat_typing_indicators;
create policy "chat_typing_indicators_insert_own"
on public.chat_typing_indicators
for insert
with check (
  user_id = auth.uid()
  and public.can_write_chat_channel(channel_id)
);

drop policy if exists "chat_typing_indicators_update_own"
  on public.chat_typing_indicators;
create policy "chat_typing_indicators_update_own"
on public.chat_typing_indicators
for update
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and public.can_write_chat_channel(channel_id)
);

drop policy if exists "chat_typing_indicators_delete_own"
  on public.chat_typing_indicators;
create policy "chat_typing_indicators_delete_own"
on public.chat_typing_indicators
for delete
using (user_id = auth.uid());

create or replace function public.enforce_chat_typing_thread_channel()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  actual_channel_id uuid;
  actual_thread_root_id uuid;
begin
  if new.thread_root_message_id is null then
    return new;
  end if;

  select channel_id, thread_root_message_id
    into actual_channel_id, actual_thread_root_id
  from public.chat_messages
  where id = new.thread_root_message_id;

  if actual_channel_id is null then
    raise exception 'Thread root does not exist'
      using errcode = '23503';
  end if;
  if actual_channel_id is distinct from new.channel_id
     or actual_thread_root_id is not null then
    raise exception 'Typing activity must reference a root message in its channel'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_typing_indicators_thread_guard
  on public.chat_typing_indicators;
create trigger chat_typing_indicators_thread_guard
before insert or update of channel_id, thread_root_message_id
on public.chat_typing_indicators
for each row
execute function public.enforce_chat_typing_thread_channel();

revoke all on function public.enforce_chat_typing_thread_channel()
  from public;

create table if not exists public.chat_message_reactions (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  constraint chat_message_reactions_emoji_check
    check (char_length(emoji) between 1 and 24),
  unique (message_id, user_id, emoji)
);

create index if not exists chat_message_reactions_channel_idx
  on public.chat_message_reactions(channel_id, message_id, created_at);

create table if not exists public.chat_saved_messages (
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

create index if not exists chat_saved_messages_user_idx
  on public.chat_saved_messages(user_id, created_at desc);

create table if not exists public.chat_channel_pins (
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  pinned_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (channel_id, message_id)
);

create index if not exists chat_channel_pins_channel_idx
  on public.chat_channel_pins(channel_id, created_at desc);

create or replace function public.enforce_chat_social_message_channel()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  actual_channel_id uuid;
begin
  select channel_id
    into actual_channel_id
  from public.chat_messages
  where id = new.message_id;

  if actual_channel_id is null then
    raise exception 'Message does not belong to Team Chat'
      using errcode = '23503';
  end if;
  if actual_channel_id is distinct from new.channel_id then
    raise exception 'Message and interaction must belong to the same channel'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_message_reactions_channel_guard
  on public.chat_message_reactions;
create trigger chat_message_reactions_channel_guard
before insert or update of channel_id, message_id
on public.chat_message_reactions
for each row
execute function public.enforce_chat_social_message_channel();

drop trigger if exists chat_saved_messages_channel_guard
  on public.chat_saved_messages;
create trigger chat_saved_messages_channel_guard
before insert or update of channel_id, message_id
on public.chat_saved_messages
for each row
execute function public.enforce_chat_social_message_channel();

drop trigger if exists chat_channel_pins_channel_guard
  on public.chat_channel_pins;
create trigger chat_channel_pins_channel_guard
before insert or update of channel_id, message_id
on public.chat_channel_pins
for each row
execute function public.enforce_chat_social_message_channel();

revoke all on function public.enforce_chat_social_message_channel()
  from public;

alter table public.chat_message_reactions enable row level security;
alter table public.chat_saved_messages enable row level security;
alter table public.chat_channel_pins enable row level security;

drop policy if exists "chat_message_reactions_select"
  on public.chat_message_reactions;
create policy "chat_message_reactions_select"
on public.chat_message_reactions
for select
using (public.can_read_chat_channel(channel_id));

drop policy if exists "chat_message_reactions_insert_own"
  on public.chat_message_reactions;
create policy "chat_message_reactions_insert_own"
on public.chat_message_reactions
for insert
with check (
  user_id = auth.uid()
  and public.can_write_chat_channel(channel_id)
);

drop policy if exists "chat_message_reactions_delete_own"
  on public.chat_message_reactions;
create policy "chat_message_reactions_delete_own"
on public.chat_message_reactions
for delete
using (user_id = auth.uid());

drop policy if exists "chat_saved_messages_select_own"
  on public.chat_saved_messages;
create policy "chat_saved_messages_select_own"
on public.chat_saved_messages
for select
using (
  user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
);

drop policy if exists "chat_saved_messages_insert_own"
  on public.chat_saved_messages;
create policy "chat_saved_messages_insert_own"
on public.chat_saved_messages
for insert
with check (
  user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
);

drop policy if exists "chat_saved_messages_delete_own"
  on public.chat_saved_messages;
create policy "chat_saved_messages_delete_own"
on public.chat_saved_messages
for delete
using (user_id = auth.uid());

drop policy if exists "chat_channel_pins_select"
  on public.chat_channel_pins;
create policy "chat_channel_pins_select"
on public.chat_channel_pins
for select
using (public.can_read_chat_channel(channel_id));

drop policy if exists "chat_channel_pins_insert"
  on public.chat_channel_pins;
create policy "chat_channel_pins_insert"
on public.chat_channel_pins
for insert
with check (
  pinned_by = auth.uid()
  and public.can_write_chat_channel(channel_id)
);

drop policy if exists "chat_channel_pins_delete"
  on public.chat_channel_pins;
create policy "chat_channel_pins_delete"
on public.chat_channel_pins
for delete
using (
  pinned_by = auth.uid()
  or public.can_manage_chat_channel(channel_id)
);

create table if not exists public.chat_huddles (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  started_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'ended')),
  title text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint chat_huddles_title_check
    check (title is null or char_length(title) between 1 and 120),
  constraint chat_huddles_end_state_check
    check (
      (status = 'active' and ended_at is null)
      or (status = 'ended' and ended_at is not null)
    )
);

create unique index if not exists chat_huddles_one_active_per_channel_idx
  on public.chat_huddles(channel_id)
  where status = 'active';
create index if not exists chat_huddles_channel_idx
  on public.chat_huddles(channel_id, started_at desc);

create or replace function public.enforce_chat_huddle_identity()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  channel_archived boolean;
begin
  if tg_op = 'INSERT' then
    select is_archived
      into channel_archived
    from public.chat_channels
    where id = new.channel_id;
    if channel_archived then
      raise exception 'Archived channels cannot start huddles'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.channel_id is distinct from old.channel_id
     or new.started_by is distinct from old.started_by
     or new.started_at is distinct from old.started_at then
    raise exception 'A huddle cannot move or change its starter'
      using errcode = '23514';
  end if;
  if old.status = 'ended' and new.status is distinct from old.status then
    raise exception 'An ended huddle cannot be reopened'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_huddles_identity_guard
  on public.chat_huddles;
create trigger chat_huddles_identity_guard
before insert or update of channel_id, started_by, started_at, status
on public.chat_huddles
for each row
execute function public.enforce_chat_huddle_identity();

revoke all on function public.enforce_chat_huddle_identity()
  from public;

create table if not exists public.chat_huddle_participants (
  huddle_id uuid not null references public.chat_huddles(id) on delete cascade,
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  muted boolean not null default true,
  camera_on boolean not null default false,
  screen_sharing boolean not null default false,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (huddle_id, user_id)
);

create index if not exists chat_huddle_participants_active_idx
  on public.chat_huddle_participants(huddle_id, joined_at)
  where left_at is null;

create table if not exists public.chat_huddle_signals (
  id uuid primary key default gen_random_uuid(),
  huddle_id uuid not null references public.chat_huddles(id) on delete cascade,
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  signal_type text not null check (signal_type in ('offer', 'answer', 'ice')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint chat_huddle_signals_distinct_peers_check
    check (sender_user_id <> recipient_user_id),
  constraint chat_huddle_signals_payload_size_check
    check (octet_length(payload::text) <= 131072)
);

create index if not exists chat_huddle_signals_recipient_idx
  on public.chat_huddle_signals(
    huddle_id,
    recipient_user_id,
    created_at
  );

create or replace function public.can_read_chat_huddle(target_huddle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.chat_huddles huddle
    where huddle.id = target_huddle_id
      and public.can_read_chat_channel(huddle.channel_id)
  );
$$;

revoke all on function public.can_read_chat_huddle(uuid) from public;
grant execute on function public.can_read_chat_huddle(uuid)
  to authenticated;

create or replace function public.enforce_chat_huddle_channel()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  actual_channel_id uuid;
  huddle_status text;
begin
  select channel_id, status
    into actual_channel_id, huddle_status
  from public.chat_huddles
  where id = new.huddle_id;

  if actual_channel_id is null then
    raise exception 'Huddle does not exist'
      using errcode = '23503';
  end if;
  if actual_channel_id is distinct from new.channel_id then
    raise exception 'Huddle activity must stay inside its channel'
      using errcode = '23514';
  end if;
  if huddle_status <> 'active' then
    raise exception 'This huddle has ended'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_huddle_participants_channel_guard
  on public.chat_huddle_participants;
create trigger chat_huddle_participants_channel_guard
before insert or update of huddle_id, channel_id
on public.chat_huddle_participants
for each row
execute function public.enforce_chat_huddle_channel();

drop trigger if exists chat_huddle_signals_channel_guard
  on public.chat_huddle_signals;
create trigger chat_huddle_signals_channel_guard
before insert or update of huddle_id, channel_id
on public.chat_huddle_signals
for each row
execute function public.enforce_chat_huddle_channel();

revoke all on function public.enforce_chat_huddle_channel()
  from public;

create or replace function public.enforce_chat_huddle_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  active_participant_count integer;
  channel_archived boolean;
begin
  if new.left_at is not null
     or (tg_op = 'UPDATE' and old.left_at is null) then
    return new;
  end if;

  select is_archived
    into channel_archived
  from public.chat_channels
  where id = new.channel_id;
  if channel_archived then
    raise exception 'Archived channels cannot add huddle participants'
      using errcode = 'P0001';
  end if;

  -- Serialize first joins for one huddle so concurrent tabs cannot overflow
  -- the small peer-to-peer mesh.
  perform pg_advisory_xact_lock(
    hashtextextended(new.huddle_id::text, 0)
  );
  select count(*)
    into active_participant_count
  from public.chat_huddle_participants
  where huddle_id = new.huddle_id
    and left_at is null;

  if active_participant_count >= 8 then
    raise exception 'This huddle is full (8 people maximum)'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_huddle_participants_capacity_guard
  on public.chat_huddle_participants;
create trigger chat_huddle_participants_capacity_guard
before insert or update of left_at
on public.chat_huddle_participants
for each row
execute function public.enforce_chat_huddle_capacity();

revoke all on function public.enforce_chat_huddle_capacity()
  from public;

alter table public.chat_huddles enable row level security;
alter table public.chat_huddle_participants enable row level security;
alter table public.chat_huddle_signals enable row level security;

drop policy if exists "chat_huddles_select"
  on public.chat_huddles;
create policy "chat_huddles_select"
on public.chat_huddles
for select
using (public.can_read_chat_channel(channel_id));

drop policy if exists "chat_huddles_insert"
  on public.chat_huddles;
create policy "chat_huddles_insert"
on public.chat_huddles
for insert
with check (
  started_by = auth.uid()
  and public.can_write_chat_channel(channel_id)
);

drop policy if exists "chat_huddles_update"
  on public.chat_huddles;
create policy "chat_huddles_update"
on public.chat_huddles
for update
using (
  started_by = auth.uid()
  or public.can_manage_chat_channel(channel_id)
)
with check (
  (
    started_by = auth.uid()
    and public.can_write_chat_channel(channel_id)
  )
  or public.can_manage_chat_channel(channel_id)
);

drop policy if exists "chat_huddle_participants_select"
  on public.chat_huddle_participants;
create policy "chat_huddle_participants_select"
on public.chat_huddle_participants
for select
using (public.can_read_chat_channel(channel_id));

drop policy if exists "chat_huddle_participants_insert_own"
  on public.chat_huddle_participants;
create policy "chat_huddle_participants_insert_own"
on public.chat_huddle_participants
for insert
with check (
  user_id = auth.uid()
  and public.can_write_chat_channel(channel_id)
);

drop policy if exists "chat_huddle_participants_update_own"
  on public.chat_huddle_participants;
create policy "chat_huddle_participants_update_own"
on public.chat_huddle_participants
for update
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
);

drop policy if exists "chat_huddle_participants_delete_own"
  on public.chat_huddle_participants;
create policy "chat_huddle_participants_delete_own"
on public.chat_huddle_participants
for delete
using (user_id = auth.uid());

drop policy if exists "chat_huddle_signals_select_recipient"
  on public.chat_huddle_signals;
create policy "chat_huddle_signals_select_recipient"
on public.chat_huddle_signals
for select
using (
  recipient_user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
);

drop policy if exists "chat_huddle_signals_insert_sender"
  on public.chat_huddle_signals;
create policy "chat_huddle_signals_insert_sender"
on public.chat_huddle_signals
for insert
with check (
  sender_user_id = auth.uid()
  and public.can_read_chat_huddle(huddle_id)
  and exists (
    select 1
    from public.chat_huddle_participants sender
    where sender.huddle_id = chat_huddle_signals.huddle_id
      and sender.user_id = auth.uid()
      and sender.left_at is null
  )
  and exists (
    select 1
    from public.chat_huddle_participants recipient
    where recipient.huddle_id = chat_huddle_signals.huddle_id
      and recipient.user_id = chat_huddle_signals.recipient_user_id
      and recipient.left_at is null
  )
);

drop policy if exists "chat_huddle_signals_delete_peer"
  on public.chat_huddle_signals;
create policy "chat_huddle_signals_delete_peer"
on public.chat_huddle_signals
for delete
using (
  sender_user_id = auth.uid()
  or recipient_user_id = auth.uid()
);

do $$
begin
  alter publication supabase_realtime add table public.chat_member_profiles;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.chat_member_presence;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.chat_typing_indicators;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.chat_message_reactions;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.chat_channel_pins;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.chat_huddles;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.chat_huddle_participants;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.chat_huddle_signals;
exception
  when duplicate_object then null;
end $$;

comment on table public.chat_member_profiles is
  'Workspace-visible human identity and custom status for Team Chat.';
comment on table public.chat_member_presence is
  'Ephemeral availability heartbeat. Clients treat stale rows as offline.';
comment on table public.chat_typing_indicators is
  'Short-lived per-room and per-thread typing state.';
comment on table public.chat_message_reactions is
  'Per-user emoji reactions on Team Chat messages.';
comment on table public.chat_saved_messages is
  'Private per-user saved-message list.';
comment on table public.chat_channel_pins is
  'Room-visible pinned Team Chat messages.';
comment on table public.chat_huddles is
  'Small, channel-scoped browser audio/video huddles.';
comment on table public.chat_huddle_signals is
  'Short-lived WebRTC signaling addressed to one active huddle participant.';
