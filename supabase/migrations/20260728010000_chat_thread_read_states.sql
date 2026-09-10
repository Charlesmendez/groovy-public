-- Durable per-user read cursors for participated Team Chat threads. A user
-- participates by authoring the root message or by replying in the thread.

create table if not exists public.chat_thread_read_states (
  thread_root_message_id uuid not null
    references public.chat_messages(id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (thread_root_message_id, user_id)
);

create index if not exists chat_thread_read_states_user_idx
  on public.chat_thread_read_states(user_id, updated_at desc);

alter table public.chat_thread_read_states enable row level security;

drop policy if exists "chat_thread_read_states_select_own"
  on public.chat_thread_read_states;
create policy "chat_thread_read_states_select_own"
on public.chat_thread_read_states
for select
using (
  user_id = auth.uid()
  and exists (
    select 1
    from public.chat_messages as root
    where root.id = chat_thread_read_states.thread_root_message_id
      and root.thread_root_message_id is null
      and public.can_read_chat_channel(root.channel_id)
  )
);

drop policy if exists "chat_thread_read_states_insert_own"
  on public.chat_thread_read_states;
create policy "chat_thread_read_states_insert_own"
on public.chat_thread_read_states
for insert
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.chat_messages as root
    where root.id = chat_thread_read_states.thread_root_message_id
      and root.thread_root_message_id is null
      and public.can_read_chat_channel(root.channel_id)
  )
);

drop policy if exists "chat_thread_read_states_update_own"
  on public.chat_thread_read_states;
create policy "chat_thread_read_states_update_own"
on public.chat_thread_read_states
for update
using (
  user_id = auth.uid()
  and exists (
    select 1
    from public.chat_messages as root
    where root.id = chat_thread_read_states.thread_root_message_id
      and root.thread_root_message_id is null
      and public.can_read_chat_channel(root.channel_id)
  )
)
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.chat_messages as root
    where root.id = chat_thread_read_states.thread_root_message_id
      and root.thread_root_message_id is null
      and public.can_read_chat_channel(root.channel_id)
  )
);

-- Existing conversations should appear in Threads without turning every old
-- reply into an unread notification at launch.
insert into public.chat_thread_read_states (
  thread_root_message_id,
  user_id,
  last_read_at,
  created_at,
  updated_at
)
select distinct
  participant.thread_root_message_id,
  participant.user_id,
  now(),
  now(),
  now()
from (
  select
    root.id as thread_root_message_id,
    root.author_user_id as user_id
  from public.chat_messages as root
  where root.thread_root_message_id is null
    and root.author_type = 'user'
    and root.author_user_id is not null
    and exists (
      select 1
      from public.chat_messages as reply
      where reply.thread_root_message_id = root.id
    )

  union

  select
    reply.thread_root_message_id,
    reply.author_user_id
  from public.chat_messages as reply
  where reply.thread_root_message_id is not null
    and reply.author_type = 'user'
    and reply.author_user_id is not null
) as participant
on conflict (thread_root_message_id, user_id) do nothing;
