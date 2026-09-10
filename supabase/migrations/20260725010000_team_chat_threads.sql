-- Durable Team Chat threads.
--
-- reply_to_message_id remains the causal/quoted-message relationship used by
-- existing channel messages. thread_root_message_id is the conversation
-- boundary used to keep thread replies out of the main channel timeline.

alter table public.chat_messages
  add column if not exists thread_root_message_id uuid
    references public.chat_messages(id) on delete cascade;

alter table public.chat_messages
  drop constraint if exists chat_messages_thread_requires_channel;

alter table public.chat_messages
  add constraint chat_messages_thread_requires_channel check (
    thread_root_message_id is null
    or (
      channel_id is not null
      and thread_root_message_id is distinct from id
    )
  );

create index if not exists chat_messages_thread_idx
  on public.chat_messages(channel_id, thread_root_message_id, created_at)
  where thread_root_message_id is not null;

-- RLS protects the message row itself, but a self-referencing foreign key does
-- not prove that its root belongs to the same visible channel. Enforce that
-- invariant below RLS so direct PostgREST inserts cannot create cross-channel
-- thread associations.
create or replace function public.enforce_chat_message_thread_root()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  root_channel_id uuid;
  nested_root_id uuid;
begin
  if new.thread_root_message_id is null then
    return new;
  end if;

  select channel_id, thread_root_message_id
    into root_channel_id, nested_root_id
  from public.chat_messages
  where id = new.thread_root_message_id;

  if root_channel_id is null then
    raise exception 'Thread root does not exist'
      using errcode = '23503';
  end if;
  if root_channel_id is distinct from new.channel_id then
    raise exception 'Thread root must belong to the same channel'
      using errcode = '23514';
  end if;
  if nested_root_id is not null then
    raise exception 'Thread replies must reference the top-level root'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists chat_messages_enforce_thread_root
  on public.chat_messages;
create trigger chat_messages_enforce_thread_root
before insert or update of channel_id, thread_root_message_id
on public.chat_messages
for each row
execute function public.enforce_chat_message_thread_root();

revoke all on function public.enforce_chat_message_thread_root() from public;

alter table public.chat_orchestrator_runs
  add column if not exists thread_root_message_id uuid
    references public.chat_messages(id) on delete set null;

create index if not exists chat_orchestrator_runs_thread_idx
  on public.chat_orchestrator_runs(
    channel_id,
    thread_root_message_id,
    started_at desc
  )
  where thread_root_message_id is not null;
