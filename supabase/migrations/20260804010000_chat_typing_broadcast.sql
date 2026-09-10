-- Typing indicators are latency-sensitive and ephemeral. Postgres Changes can
-- lag or miss a short-lived update while a client reconnects, so broadcast the
-- same authorized row through a private channel. The existing table remains
-- the source of truth and reconnect fallback.

drop policy if exists "chat_typing_broadcast_receive"
  on realtime.messages;
create policy "chat_typing_broadcast_receive"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and public.can_read_chat_channel(
    substring(
      (select realtime.topic())
      from '^chat-typing:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
    )::uuid
  )
);

create or replace function public.broadcast_chat_typing_indicator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'channel_id', new.channel_id,
      'user_id', new.user_id,
      'thread_root_message_id', new.thread_root_message_id,
      'expires_at', new.expires_at,
      'updated_at', new.updated_at
    ),
    'typing',
    'chat-typing:' || new.channel_id::text,
    true
  );
  return new;
end;
$$;

revoke all on function public.broadcast_chat_typing_indicator()
  from public;

drop trigger if exists chat_typing_indicators_broadcast
  on public.chat_typing_indicators;
create trigger chat_typing_indicators_broadcast
after insert or update
on public.chat_typing_indicators
for each row
execute function public.broadcast_chat_typing_indicator();
