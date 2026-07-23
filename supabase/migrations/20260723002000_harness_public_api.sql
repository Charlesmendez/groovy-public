-- Public harness API + widget authentication. API keys are stored as SHA-256
-- hashes only; plaintext is returned once by the management route.

create table if not exists public.harness_api_keys (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.orchestrator_profiles(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  kind text not null check (kind in ('secret', 'publishable')),
  scopes jsonb not null default '["threads:read","threads:write"]'::jsonb,
  rate_limit_per_minute integer not null default 60
    check (rate_limit_per_minute between 1 and 10000),
  allowed_origins jsonb not null default '[]'::jsonb,
  request_count bigint not null default 0,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists harness_api_keys_profile_idx
  on public.harness_api_keys(profile_id, created_at desc);

create or replace function public.prevent_harness_api_key_rebinding()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.profile_id is distinct from old.profile_id
    or new.owner_user_id is distinct from old.owner_user_id
    or new.workspace_id is distinct from old.workspace_id
    or new.key_prefix is distinct from old.key_prefix
    or new.key_hash is distinct from old.key_hash
    or new.kind is distinct from old.kind
  then
    raise exception 'Harness API key identity fields are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists harness_api_keys_prevent_rebinding
  on public.harness_api_keys;
create trigger harness_api_keys_prevent_rebinding
before update on public.harness_api_keys
for each row execute function public.prevent_harness_api_key_rebinding();

create table if not exists public.external_participants (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.orchestrator_profiles(id) on delete cascade,
  external_id text not null,
  display_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(profile_id, external_id)
);

alter table public.orchestrator_external_threads
  add column if not exists external_participant_id uuid
    references public.external_participants(id) on delete set null;
alter table public.orchestrator_external_threads
  add column if not exists api_key_id uuid
    references public.harness_api_keys(id) on delete set null;

create index if not exists orchestrator_external_threads_api_key_idx
  on public.orchestrator_external_threads(api_key_id, created_at desc)
  where api_key_id is not null;

create table if not exists public.harness_api_rate_limits (
  key_id uuid not null references public.harness_api_keys(id) on delete cascade,
  bucket_start timestamptz not null,
  request_count integer not null default 0,
  primary key (key_id, bucket_start)
);

create index if not exists harness_api_rate_limits_bucket_idx
  on public.harness_api_rate_limits(bucket_start);

create table if not exists public.orchestrator_turn_locks (
  session_id uuid primary key references public.orchestrator_sessions(id) on delete cascade,
  lock_token uuid not null,
  expires_at timestamptz not null
);

create or replace function public.acquire_orchestrator_turn_lock(
  p_session_id uuid,
  p_lock_token uuid,
  p_ttl_seconds integer default 780
)
returns boolean
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_token uuid;
begin
  insert into public.orchestrator_turn_locks(session_id, lock_token, expires_at)
  values (
    p_session_id,
    p_lock_token,
    now() + make_interval(secs => greatest(30, least(800, p_ttl_seconds)))
  )
  on conflict (session_id) do update
    set lock_token = excluded.lock_token,
        expires_at = excluded.expires_at
    where public.orchestrator_turn_locks.expires_at < now()
  returning lock_token into v_token;
  return v_token = p_lock_token;
end;
$$;

create or replace function public.release_orchestrator_turn_lock(
  p_session_id uuid,
  p_lock_token uuid
)
returns void
language sql
security definer
set search_path = public
set row_security = off
as $$
  delete from public.orchestrator_turn_locks
  where session_id = p_session_id and lock_token = p_lock_token;
$$;

revoke all on function public.acquire_orchestrator_turn_lock(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_orchestrator_turn_lock(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.acquire_orchestrator_turn_lock(uuid, uuid, integer)
  to service_role;
grant execute on function public.release_orchestrator_turn_lock(uuid, uuid)
  to service_role;

-- Atomic shared-session resolution used by team chat and public API entry
-- points. It prevents concurrent first messages from creating two sessions
-- for the same external thread.
create or replace function public.get_or_create_orchestrator_external_thread(
  p_user_id uuid,
  p_provider text,
  p_thread_key text,
  p_thread_name text default null,
  p_profile_id uuid default null,
  p_external_participant_id uuid default null,
  p_api_key_id uuid default null
)
returns table(thread_id uuid, session_id uuid)
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_thread_id uuid;
  v_session_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    p_user_id::text || ':' || p_provider || ':' || p_thread_key,
    0
  ));

  select id, orchestrator_session_id
  into v_thread_id, v_session_id
  from public.orchestrator_external_threads
  where user_id = p_user_id
    and provider = p_provider
    and thread_key = p_thread_key
  limit 1;

  if v_thread_id is null then
    insert into public.orchestrator_sessions(user_id, title, profile_id)
    values (
      p_user_id,
      coalesce(nullif(p_thread_name, ''), 'External harness thread'),
      p_profile_id
    )
    returning id into v_session_id;

    insert into public.orchestrator_external_threads(
      user_id,
      provider,
      thread_key,
      thread_name,
      orchestrator_session_id,
      profile_id,
      external_participant_id,
      api_key_id,
      updated_at
    )
    values (
      p_user_id,
      p_provider,
      p_thread_key,
      p_thread_name,
      v_session_id,
      p_profile_id,
      p_external_participant_id,
      p_api_key_id,
      now()
    )
    returning id into v_thread_id;
  else
    update public.orchestrator_external_threads
    set thread_name = coalesce(p_thread_name, thread_name),
        -- Callers resolve the current binding before invoking this RPC. Apply
        -- it exactly so a Team Chat channel can be rebound—or explicitly
        -- returned to its default profile—without retaining stale authority.
        profile_id = p_profile_id,
        external_participant_id = coalesce(external_participant_id, p_external_participant_id),
        api_key_id = coalesce(api_key_id, p_api_key_id),
        updated_at = now()
    where id = v_thread_id;

    update public.orchestrator_sessions
    set profile_id = p_profile_id,
        updated_at = now()
    where id = v_session_id;
  end if;

  return query select v_thread_id, v_session_id;
end;
$$;

revoke all on function public.get_or_create_orchestrator_external_thread(
  uuid, text, text, text, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.get_or_create_orchestrator_external_thread(
  uuid, text, text, text, uuid, uuid, uuid
) to service_role;

create or replace function public.consume_harness_api_rate_limit(
  p_key_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_count integer;
begin
  insert into public.harness_api_rate_limits(key_id, bucket_start, request_count)
  values (p_key_id, v_bucket, 1)
  on conflict (key_id, bucket_start)
  do update set request_count = public.harness_api_rate_limits.request_count + 1
  returning request_count into v_count;

  delete from public.harness_api_rate_limits
  where bucket_start < now() - interval '2 hours';

  update public.harness_api_keys
  set last_used_at = now(), request_count = request_count + 1
  where id = p_key_id;

  return jsonb_build_object(
    'allowed', v_count <= greatest(1, p_limit),
    'count', v_count,
    'limit', greatest(1, p_limit),
    'remaining', greatest(0, greatest(1, p_limit) - v_count),
    'reset_at', extract(epoch from (v_bucket + interval '1 minute'))::bigint
  );
end;
$$;

revoke all on function public.consume_harness_api_rate_limit(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.consume_harness_api_rate_limit(uuid, integer)
  to service_role;

alter table public.harness_api_keys enable row level security;
alter table public.external_participants enable row level security;
alter table public.harness_api_rate_limits enable row level security;
alter table public.orchestrator_turn_locks enable row level security;

revoke all on table public.harness_api_rate_limits
  from public, anon, authenticated;
revoke all on table public.orchestrator_turn_locks
  from public, anon, authenticated;

drop policy if exists "harness_api_keys_select" on public.harness_api_keys;
create policy "harness_api_keys_select" on public.harness_api_keys
  for select using (
    owner_user_id = auth.uid()
    or (workspace_id is not null and public.is_workspace_admin(workspace_id))
  );

drop policy if exists "harness_api_keys_insert" on public.harness_api_keys;
create policy "harness_api_keys_insert" on public.harness_api_keys
  for insert with check (
    owner_user_id = auth.uid()
    and exists (
      select 1
      from public.orchestrator_profiles p
      where p.id = harness_api_keys.profile_id
        and p.surface = 'external'
        and p.authorization_stance = 'restricted'
        and p.memory_scope = 'profile'
        and p.workspace_id is not distinct from harness_api_keys.workspace_id
        and (
          (
            p.workspace_id is null
            and p.user_id = auth.uid()
          )
          or (
            p.workspace_id is not null
            and public.is_workspace_admin(p.workspace_id)
          )
        )
    )
  );

drop policy if exists "harness_api_keys_update" on public.harness_api_keys;
create policy "harness_api_keys_update" on public.harness_api_keys
  for update using (
    owner_user_id = auth.uid()
    or (workspace_id is not null and public.is_workspace_admin(workspace_id))
  ) with check (
    exists (
      select 1
      from public.orchestrator_profiles p
      where p.id = harness_api_keys.profile_id
        and p.surface = 'external'
        and p.authorization_stance = 'restricted'
        and p.memory_scope = 'profile'
        and p.workspace_id is not distinct from harness_api_keys.workspace_id
        and (
          (
            p.workspace_id is null
            and p.user_id = auth.uid()
            and harness_api_keys.owner_user_id = auth.uid()
          )
          or (
            p.workspace_id is not null
            and public.is_workspace_admin(p.workspace_id)
          )
        )
    )
  );

drop policy if exists "harness_api_keys_delete" on public.harness_api_keys;
create policy "harness_api_keys_delete" on public.harness_api_keys
  for delete using (
    owner_user_id = auth.uid()
    or (workspace_id is not null and public.is_workspace_admin(workspace_id))
  );

drop policy if exists "external_participants_select" on public.external_participants;
create policy "external_participants_select" on public.external_participants
  for select using (
    exists (
      select 1 from public.orchestrator_profiles p
      where p.id = profile_id
        and (
          p.user_id = auth.uid()
          or (p.workspace_id is not null and public.is_workspace_member(p.workspace_id))
        )
    )
  );
