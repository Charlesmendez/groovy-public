-- Durable per-user read cursors for Team Chat. Unread counts are computed on
-- the server so they survive refreshes, desktop restarts, and mobile sleep.

create table if not exists public.chat_channel_read_states (
  channel_id uuid not null
    references public.chat_channels(id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create index if not exists chat_channel_read_states_user_idx
  on public.chat_channel_read_states(user_id, updated_at desc);

alter table public.chat_channel_read_states enable row level security;

drop policy if exists "chat_channel_read_states_select_own"
  on public.chat_channel_read_states;
create policy "chat_channel_read_states_select_own"
on public.chat_channel_read_states
for select
using (
  user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
);

drop policy if exists "chat_channel_read_states_insert_own"
  on public.chat_channel_read_states;
create policy "chat_channel_read_states_insert_own"
on public.chat_channel_read_states
for insert
with check (
  user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
);

drop policy if exists "chat_channel_read_states_update_own"
  on public.chat_channel_read_states;
create policy "chat_channel_read_states_update_own"
on public.chat_channel_read_states
for update
using (
  user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
)
with check (
  user_id = auth.uid()
  and public.can_read_chat_channel(channel_id)
);

-- Do not turn all historical messages into unread messages when this feature
-- ships. New workspace/channel members without a cursor still begin at the
-- moment they gained access (handled in chat_channel_unread_counts below).
insert into public.chat_channel_read_states (
  channel_id,
  user_id,
  last_read_at,
  created_at,
  updated_at
)
select distinct
  channel.id,
  member.user_id,
  now(),
  now(),
  now()
from public.chat_channels as channel
join public.workspace_members as member
  on member.workspace_id = channel.workspace_id
where
  (
    channel.kind = 'channel'
    and channel.visibility = 'workspace'
    and member.role in ('admin', 'member')
  )
  or (
    channel.kind = 'channel'
    and member.role = 'admin'
  )
  or channel.created_by = member.user_id
  or exists (
    select 1
    from public.chat_channel_members as channel_member
    where channel_member.channel_id = channel.id
      and channel_member.member_type = 'user'
      and channel_member.user_id = member.user_id
  )
on conflict (channel_id, user_id) do nothing;

create or replace function public.mark_chat_channel_read(
  p_channel_id uuid
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  read_at timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not public.can_read_chat_channel(p_channel_id) then
    raise exception 'Channel not found or inaccessible'
      using errcode = '42501';
  end if;

  insert into public.chat_channel_read_states as read_state (
    channel_id,
    user_id,
    last_read_at,
    created_at,
    updated_at
  )
  values (
    p_channel_id,
    auth.uid(),
    read_at,
    read_at,
    read_at
  )
  on conflict (channel_id, user_id)
  do update set
    last_read_at = greatest(
      read_state.last_read_at,
      excluded.last_read_at
    ),
    updated_at = excluded.updated_at
  returning last_read_at into read_at;

  return read_at;
end;
$$;

create or replace function public.chat_channel_unread_counts(
  p_channel_ids uuid[]
)
returns table (
  channel_id uuid,
  unread_count bigint
)
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  with requested as (
    select distinct unnest(
      coalesce(p_channel_ids, array[]::uuid[])
    ) as channel_id
  ),
  accessible as (
    select
      channel.id as channel_id,
      coalesce(
        read_state.last_read_at,
        case
          when (
            channel.kind = 'channel'
            and channel.visibility = 'workspace'
            and workspace_member.role in ('admin', 'member')
          ) then greatest(channel.created_at, workspace_member.created_at)
          when (
            channel.kind = 'channel'
            and workspace_member.role = 'admin'
          ) then greatest(channel.created_at, workspace_member.created_at)
          when (
            channel.kind = 'channel'
            and channel.created_by = auth.uid()
          ) then channel.created_at
          else greatest(
            channel.created_at,
            coalesce(channel_member.created_at, channel.created_at)
          )
        end
      ) as unread_after
    from requested
    join public.chat_channels as channel
      on channel.id = requested.channel_id
    left join public.chat_channel_read_states as read_state
      on read_state.channel_id = channel.id
     and read_state.user_id = auth.uid()
    left join public.workspace_members as workspace_member
      on workspace_member.workspace_id = channel.workspace_id
     and workspace_member.user_id = auth.uid()
    left join public.chat_channel_members as channel_member
      on channel_member.channel_id = channel.id
     and channel_member.member_type = 'user'
     and channel_member.user_id = auth.uid()
    where public.can_read_chat_channel(channel.id)
  )
  select
    accessible.channel_id,
    count(message.id)::bigint as unread_count
  from accessible
  left join public.chat_messages as message
    on message.channel_id = accessible.channel_id
   and message.created_at > accessible.unread_after
   and (
     message.author_type <> 'user'
     or message.author_user_id is distinct from auth.uid()
   )
  group by accessible.channel_id;
$$;

revoke all on function public.chat_channel_unread_counts(uuid[]) from public;
grant execute
  on function public.chat_channel_unread_counts(uuid[])
  to authenticated;

revoke all on function public.mark_chat_channel_read(uuid) from public;
grant execute
  on function public.mark_chat_channel_read(uuid)
  to authenticated;
