-- Coordinate expensive Gmail proxy work across browser windows and Vercel
-- instances. Client-side and module-local locks cannot protect a per-user
-- upstream quota once requests land on different serverless workers.

create table if not exists public.email_provider_runtime (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  request_scope text not null,
  lease_token uuid null,
  lease_expires_at timestamptz null,
  cached_payload jsonb null,
  cached_at timestamptz null,
  rate_limited_until timestamptz null,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider, request_scope),
  constraint email_provider_runtime_provider_check
    check (provider ~ '^[a-z0-9_-]{1,32}$'),
  constraint email_provider_runtime_scope_check
    check (char_length(request_scope) between 1 and 180)
);

create index if not exists email_provider_runtime_cleanup_idx
  on public.email_provider_runtime(updated_at);

alter table public.email_provider_runtime enable row level security;

-- Runtime rows contain short-lived response snapshots. Keep them behind the
-- functions below so a browser cannot forge a lease, cached response, or
-- provider cooldown. Only the service-role server may call them.
revoke all on table public.email_provider_runtime from public, anon, authenticated;

create or replace function public.claim_email_provider_request(
  p_user_id uuid,
  p_provider text,
  p_request_scope text,
  p_lease_token uuid,
  p_lease_ms integer default 65000,
  p_fresh_ms integer default 10000,
  p_serialize_provider boolean default false
)
returns table (
  acquired boolean,
  cached_payload jsonb,
  cached_at timestamptz,
  lease_expires_at timestamptz,
  rate_limited_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := p_user_id;
  v_now timestamptz := clock_timestamp();
  v_runtime public.email_provider_runtime%rowtype;
  v_gate public.email_provider_runtime%rowtype;
  v_cooldown timestamptz;
begin
  if v_user_id is null then
    raise exception 'A user id is required.' using errcode = '22023';
  end if;
  if p_provider is null or p_provider !~ '^[a-z0-9_-]{1,32}$' then
    raise exception 'Invalid email provider.';
  end if;
  if
    p_request_scope is null
    or char_length(p_request_scope) not between 1 and 180
    or p_request_scope like '__provider_%'
  then
    raise exception 'Invalid email request scope.';
  end if;
  if p_lease_token is null then
    raise exception 'A lease token is required.';
  end if;

  -- Cursor-scoped feed requests intentionally get their own short-lived rows
  -- so duplicate scroll requests coalesce and still honor the shared provider
  -- cooldown. Keep that namespace bounded without retaining response payloads
  -- after they are useful.
  delete from public.email_provider_runtime as runtime
  where runtime.user_id = v_user_id
    and runtime.provider = p_provider
    and runtime.request_scope not in (
      '__provider_gate__',
      '__provider_cooldown__'
    )
    and runtime.updated_at < v_now - interval '1 day'
    and (
      runtime.lease_expires_at is null
      or runtime.lease_expires_at <= v_now
    );

  select runtime.rate_limited_until
    into v_cooldown
  from public.email_provider_runtime as runtime
  where runtime.user_id = v_user_id
    and runtime.provider = p_provider
    and runtime.request_scope = '__provider_cooldown__';

  insert into public.email_provider_runtime (
    user_id,
    provider,
    request_scope,
    updated_at
  ) values (
    v_user_id,
    p_provider,
    p_request_scope,
    v_now
  )
  on conflict (user_id, provider, request_scope) do nothing;

  select runtime.*
    into v_runtime
  from public.email_provider_runtime as runtime
  where runtime.user_id = v_user_id
    and runtime.provider = p_provider
    and runtime.request_scope = p_request_scope
  for update;

  if v_cooldown is not null and v_cooldown > v_now then
    return query select
      false,
      v_runtime.cached_payload,
      v_runtime.cached_at,
      v_runtime.lease_expires_at,
      v_cooldown;
    return;
  end if;

  if
    v_runtime.cached_payload is not null
    and v_runtime.cached_at is not null
    and v_runtime.cached_at + make_interval(
      secs => greatest(0, least(300000, coalesce(p_fresh_ms, 0)))::double precision / 1000
    ) > v_now
  then
    return query select
      false,
      v_runtime.cached_payload,
      v_runtime.cached_at,
      v_runtime.lease_expires_at,
      null::timestamptz;
    return;
  end if;

  if coalesce(p_serialize_provider, false) then
    insert into public.email_provider_runtime (
      user_id,
      provider,
      request_scope,
      updated_at
    ) values (
      v_user_id,
      p_provider,
      '__provider_gate__',
      v_now
    )
    on conflict (user_id, provider, request_scope) do nothing;

    select runtime.*
      into v_gate
    from public.email_provider_runtime as runtime
    where runtime.user_id = v_user_id
      and runtime.provider = p_provider
      and runtime.request_scope = '__provider_gate__'
    for update;

    if
      v_gate.lease_token is not null
      and v_gate.lease_expires_at is not null
      and v_gate.lease_expires_at > v_now
      and v_gate.lease_token <> p_lease_token
    then
      return query select
        false,
        v_runtime.cached_payload,
        v_runtime.cached_at,
        v_gate.lease_expires_at,
        null::timestamptz;
      return;
    end if;
  end if;

  if
    v_runtime.lease_token is null
    or v_runtime.lease_expires_at is null
    or v_runtime.lease_expires_at <= v_now
  then
    if coalesce(p_serialize_provider, false) then
      update public.email_provider_runtime as runtime
      set lease_token = p_lease_token,
          lease_expires_at = v_now + make_interval(
            secs => greatest(1000, least(300000, coalesce(p_lease_ms, 65000)))::double precision / 1000
          ),
          updated_at = v_now
      where runtime.user_id = v_user_id
        and runtime.provider = p_provider
        and runtime.request_scope = '__provider_gate__';
    end if;
    update public.email_provider_runtime as runtime
    set lease_token = p_lease_token,
        lease_expires_at = v_now + make_interval(
          secs => greatest(1000, least(300000, coalesce(p_lease_ms, 65000)))::double precision / 1000
        ),
        updated_at = v_now
    where runtime.user_id = v_user_id
      and runtime.provider = p_provider
      and runtime.request_scope = p_request_scope
    returning runtime.* into v_runtime;

    return query select
      true,
      v_runtime.cached_payload,
      v_runtime.cached_at,
      v_runtime.lease_expires_at,
      null::timestamptz;
    return;
  end if;

  return query select
    false,
    v_runtime.cached_payload,
    v_runtime.cached_at,
    v_runtime.lease_expires_at,
    null::timestamptz;
end;
$$;

create or replace function public.complete_email_provider_request(
  p_user_id uuid,
  p_provider text,
  p_request_scope text,
  p_lease_token uuid,
  p_cached_payload jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := p_user_id;
  v_changed integer := 0;
begin
  if v_user_id is null then
    raise exception 'A user id is required.' using errcode = '22023';
  end if;
  update public.email_provider_runtime as runtime
  set lease_token = null,
      lease_expires_at = null,
      cached_payload = p_cached_payload,
      cached_at = case when p_cached_payload is null then null else clock_timestamp() end,
      updated_at = clock_timestamp()
  where runtime.user_id = v_user_id
    and runtime.provider = p_provider
    and runtime.request_scope = p_request_scope
    and runtime.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  update public.email_provider_runtime as runtime
  set lease_token = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where runtime.user_id = v_user_id
    and runtime.provider = p_provider
    and runtime.request_scope = '__provider_gate__'
    and runtime.lease_token = p_lease_token;
  return v_changed = 1;
end;
$$;

create or replace function public.fail_email_provider_request(
  p_user_id uuid,
  p_provider text,
  p_request_scope text,
  p_lease_token uuid,
  p_retry_after_ms integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := p_user_id;
  v_now timestamptz := clock_timestamp();
  v_changed integer := 0;
  v_retry_until timestamptz;
begin
  if v_user_id is null then
    raise exception 'A user id is required.' using errcode = '22023';
  end if;

  update public.email_provider_runtime as runtime
  set lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where runtime.user_id = v_user_id
    and runtime.provider = p_provider
    and runtime.request_scope = p_request_scope
    and runtime.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;

  update public.email_provider_runtime as runtime
  set lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where runtime.user_id = v_user_id
    and runtime.provider = p_provider
    and runtime.request_scope = '__provider_gate__'
    and runtime.lease_token = p_lease_token;

  if coalesce(p_retry_after_ms, 0) > 0 then
    v_retry_until := v_now + make_interval(
      secs => greatest(1000, least(300000, p_retry_after_ms))::double precision / 1000
    );
    insert into public.email_provider_runtime (
      user_id,
      provider,
      request_scope,
      rate_limited_until,
      updated_at
    ) values (
      v_user_id,
      p_provider,
      '__provider_cooldown__',
      v_retry_until,
      v_now
    )
    on conflict (user_id, provider, request_scope) do update
    set rate_limited_until = greatest(
          coalesce(public.email_provider_runtime.rate_limited_until, '-infinity'::timestamptz),
          excluded.rate_limited_until
        ),
        updated_at = excluded.updated_at;
  end if;

  return v_changed = 1;
end;
$$;

revoke all on function public.claim_email_provider_request(
  uuid, text, text, uuid, integer, integer, boolean
) from public, anon, authenticated;
revoke all on function public.complete_email_provider_request(
  uuid, text, text, uuid, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_email_provider_request(
  uuid, text, text, uuid, integer
) from public, anon, authenticated;

grant execute on function public.claim_email_provider_request(
  uuid, text, text, uuid, integer, integer, boolean
) to service_role;
grant execute on function public.complete_email_provider_request(
  uuid, text, text, uuid, jsonb
) to service_role;
grant execute on function public.fail_email_provider_request(
  uuid, text, text, uuid, integer
) to service_role;

create table if not exists public.email_mailbox_sync_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'gmail',
  connection_id text not null,
  history_id text null,
  history_page_token text null,
  sync_mode text not null default 'history',
  triage_policy_version integer not null default 0,
  last_full_sync_at timestamptz null,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider, connection_id),
  constraint email_mailbox_sync_state_provider_check
    check (provider = 'gmail'),
  constraint email_mailbox_sync_state_connection_check
    check (char_length(connection_id) between 1 and 256),
  constraint email_mailbox_sync_state_history_check
    check (history_id is null or history_id ~ '^[0-9]+$'),
  constraint email_mailbox_sync_state_page_token_check
    check (
      history_page_token is null
      or char_length(history_page_token) between 1 and 2048
    ),
  constraint email_mailbox_sync_state_mode_check
    check (sync_mode in ('history', 'full')),
  constraint email_mailbox_sync_state_policy_version_check
    check (triage_policy_version >= 0)
);

alter table public.email_mailbox_sync_state enable row level security;

-- This cursor determines what server-side triage has already consumed. Keep
-- it server-owned so browser clients cannot skip history or manufacture an
-- unbounded set of operational rows. Service-role routes bypass RLS.
revoke all on table public.email_mailbox_sync_state from public, anon, authenticated;
grant select, insert, update, delete
  on table public.email_mailbox_sync_state
  to service_role;
