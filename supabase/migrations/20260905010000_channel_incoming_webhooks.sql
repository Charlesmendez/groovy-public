-- Incoming URLs are write-only credentials for exactly one channel. Secrets
-- and delivery are server-only; ordinary clients cannot query these tables.
create table public.chat_incoming_webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  token_enc text not null,
  enabled boolean not null default true,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_received_at timestamptz,
  message_count bigint not null default 0,
  rate_window timestamptz not null default now(),
  rate_count integer not null default 0
);

create index chat_incoming_webhooks_workspace_idx
  on public.chat_incoming_webhooks(workspace_id, created_at desc);
alter table public.chat_incoming_webhooks enable row level security;
revoke all on public.chat_incoming_webhooks from public, anon, authenticated;
grant all on public.chat_incoming_webhooks to service_role;

create unique index chat_messages_webhook_event_idx
  on public.chat_messages ((metadata->>'webhook_id'), (metadata->>'webhook_event_id'))
  where author_type = 'system' and metadata->>'kind' = 'incoming_webhook'
    and metadata->>'webhook_event_id' is not null;

-- A single transaction authenticates, checks current permissions, rate-limits,
-- deduplicates retries, inserts the message, and records successful delivery.
-- Locking the webhook also makes pause/revoke/rotation effective on commit.
create function public.deliver_chat_incoming_webhook(
  p_token_hash text,
  p_text text,
  p_event_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  hook public.chat_incoming_webhooks%rowtype;
  msg public.chat_messages%rowtype;
  delivered_at timestamptz := clock_timestamp();
begin
  select * into hook from public.chat_incoming_webhooks
    where token_hash = p_token_hash for update;
  if not found or hook.revoked_at is not null then
    return jsonb_build_object('error', 'webhook_not_found');
  end if;
  if not hook.enabled then
    return jsonb_build_object('error', 'webhook_paused');
  end if;
  -- A webhook loses its authority if its creator leaves or can no longer
  -- manage the channel. The user's currently selected workspace is irrelevant.
  if not exists (
    select 1 from public.chat_channels c
    join public.workspace_members m on m.workspace_id = c.workspace_id
      and m.user_id = hook.created_by
    where c.id = hook.channel_id and c.workspace_id = hook.workspace_id
      and c.kind = 'channel' and not c.is_archived
      and (m.role = 'admin' or (m.role = 'member' and c.created_by = hook.created_by))
  ) then
    return jsonb_build_object('error', 'channel_unavailable');
  end if;
  if p_text is null or char_length(btrim(p_text)) not between 1 and 40000 then
    return jsonb_build_object('error', 'invalid_text');
  end if;
  if p_event_id is not null and (char_length(p_event_id) not between 1 and 128
    or p_event_id !~ '^[!-~]+$') then
    return jsonb_build_object('error', 'invalid_idempotency_key');
  end if;
  if p_event_id is not null then
    select * into msg from public.chat_messages
      where author_type = 'system' and metadata->>'kind' = 'incoming_webhook'
        and metadata->>'webhook_id' = hook.id::text
        and metadata->>'webhook_event_id' = p_event_id;
    if found then
      if msg.content is distinct from p_text then
        return jsonb_build_object('error', 'idempotency_conflict');
      end if;
      return jsonb_build_object('message_id', msg.id, 'channel_id', hook.channel_id,
        'name', hook.name, 'created_at', msg.created_at, 'duplicate', true);
    end if;
  end if;
  if hook.rate_window <= delivered_at - interval '1 minute' then
    hook.rate_window := delivered_at;
    hook.rate_count := 0;
  end if;
  if hook.rate_count >= 60 then
    return jsonb_build_object('error', 'rate_limited', 'retry_after',
      greatest(1, ceil(extract(epoch from hook.rate_window + interval '1 minute' - delivered_at))));
  end if;
  insert into public.chat_messages(channel_id, author_type, content, metadata)
    values (hook.channel_id, 'system', p_text, jsonb_strip_nulls(jsonb_build_object(
      'kind', 'incoming_webhook', 'webhook_id', hook.id,
      'webhook_name', hook.name, 'author_name', hook.name, 'webhook_event_id', p_event_id
    ))) returning * into msg;
  update public.chat_incoming_webhooks set
    last_received_at = msg.created_at, message_count = message_count + 1,
    rate_window = hook.rate_window, rate_count = hook.rate_count + 1
    where id = hook.id;
  return jsonb_build_object('message_id', msg.id, 'channel_id', hook.channel_id,
    'name', hook.name, 'created_at', msg.created_at, 'duplicate', false);
end;
$$;

revoke all on function public.deliver_chat_incoming_webhook(text, text, text)
  from public, anon, authenticated;
grant execute on function public.deliver_chat_incoming_webhook(text, text, text)
  to service_role;
