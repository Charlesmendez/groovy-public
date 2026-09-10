-- Email actions are mutated from desktop, mobile, heartbeat execution and send
-- completion paths. Merge metadata inside Postgres so concurrent writers do
-- not replace one another's queue/read/draft fields with stale JSON snapshots.

create or replace function public.apply_email_workspace_action_mutation(
  p_action_id uuid,
  p_user_id uuid,
  p_metadata_patch jsonb default '{}'::jsonb,
  p_changed_at timestamptz default now(),
  p_expected_status text default null,
  p_status text default null,
  p_executed_at timestamptz default null,
  p_close_active_siblings boolean default false,
  p_correction_cutoff timestamptz default null
)
returns table (
  action_id uuid,
  action_updated_at timestamptz,
  closed_sibling_count bigint
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_action public.inbox_actions%rowtype;
  v_changed_at timestamptz := coalesce(p_changed_at, now());
  v_cutoff timestamptz;
  v_closed_sibling_count bigint := 0;
  v_effective_patch jsonb := coalesce(p_metadata_patch, '{}'::jsonb);
  v_existing_timestamp timestamptz;
  v_incoming_timestamp timestamptz;
  v_placement_applied boolean := true;
  v_correction record;
  v_candidate_at timestamptz;
  v_latest_at timestamptz := '-infinity'::timestamptz;
  v_latest_row_updated_at timestamptz := '-infinity'::timestamptz;
  v_latest_view text := '';
begin
  if p_action_id is null or p_user_id is null then
    raise exception 'Email action id and user id are required.';
  end if;
  if jsonb_typeof(v_effective_patch) <> 'object' then
    raise exception 'Email action metadata patch must be a JSON object.';
  end if;
  if p_status is not null and p_status not in (
    'pending',
    'approved',
    'executing',
    'done',
    'rejected',
    'failed'
  ) then
    raise exception 'Invalid email action status: %', p_status;
  end if;
  if p_expected_status is not null and p_expected_status not in (
    'pending',
    'approved',
    'executing',
    'done',
    'rejected',
    'failed'
  ) then
    raise exception 'Invalid expected email action status: %', p_expected_status;
  end if;

  select target.*
  into v_action
  from public.inbox_actions as target
  where target.id = p_action_id
    and target.user_id = p_user_id
    and (
      p_expected_status is null
      or target.status = p_expected_status
    )
  for update;

  if not found then
    raise exception 'Email action not found or status changed.';
  end if;

  -- Queue placement and read state are independent timestamped dimensions.
  -- A delayed request may still merge unrelated metadata, but it must not
  -- replace a newer correction for either dimension.
  if v_effective_patch ? 'email_workspace_corrected_at' then
    begin
      v_incoming_timestamp := (
        v_effective_patch->>'email_workspace_corrected_at'
      )::timestamptz;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        v_incoming_timestamp := null;
    end;
    begin
      v_existing_timestamp := (
        v_action.metadata->>'email_workspace_corrected_at'
      )::timestamptz;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        v_existing_timestamp := null;
    end;
    if
      v_incoming_timestamp is null
      or (
        v_existing_timestamp is not null
        and v_incoming_timestamp < v_existing_timestamp
      )
    then
      v_effective_patch := v_effective_patch
        - 'email_workspace_override_view'
        - 'email_workspace_corrected_at'
        - 'email_workspace_user_action';
      v_placement_applied := false;
    end if;
  end if;

  v_existing_timestamp := null;
  v_incoming_timestamp := null;
  if v_effective_patch ? 'email_workspace_read_changed_at' then
    begin
      v_incoming_timestamp := (
        v_effective_patch->>'email_workspace_read_changed_at'
      )::timestamptz;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        v_incoming_timestamp := null;
    end;
    begin
      v_existing_timestamp := (
        v_action.metadata->>'email_workspace_read_changed_at'
      )::timestamptz;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        v_existing_timestamp := null;
    end;
    if
      v_incoming_timestamp is null
      or (
        v_existing_timestamp is not null
        and v_incoming_timestamp < v_existing_timestamp
      )
    then
      v_effective_patch := v_effective_patch
        - 'email_workspace_unread'
        - 'email_workspace_read_changed_at';
    end if;
  end if;

  update public.inbox_actions as target
  set
    status = coalesce(p_status, target.status),
    executed_at = case
      when p_executed_at is not null then p_executed_at
      else target.executed_at
    end,
    metadata = coalesce(target.metadata, '{}'::jsonb) || v_effective_patch,
    updated_at = greatest(target.updated_at, v_changed_at)
  where target.id = p_action_id
    and target.user_id = p_user_id
  returning target.* into v_action;

  if p_close_active_siblings and v_placement_applied then
    -- The selected marker is not necessarily the conversation's newest
    -- marker. A delayed Done at T1 must not close actions after a different
    -- row moved the conversation back to Focus/Inbox at T2.
    for v_correction in
      select
        correction.metadata->>'email_workspace_override_view' as target_view,
        correction.metadata->>'email_workspace_corrected_at' as corrected_at,
        correction.updated_at
      from public.inbox_actions as correction
      where correction.user_id = v_action.user_id
        and correction.provider = v_action.provider
        and correction.connection_id = v_action.connection_id
        and (
          (
            v_action.gmail_thread_id is not null
            and correction.gmail_thread_id = v_action.gmail_thread_id
          )
          or (
            v_action.gmail_thread_id is null
            and correction.gmail_message_id = v_action.gmail_message_id
          )
        )
        and correction.metadata->>'email_workspace_override_view'
          in ('focus', 'inbox', 'noise', 'handled')
    loop
      begin
        v_candidate_at := v_correction.corrected_at::timestamptz;
      exception
        when invalid_datetime_format or datetime_field_overflow then
          continue;
      end;
      if v_candidate_at < coalesce(v_action.received_at, v_action.created_at) then
        continue;
      end if;
      if
        v_candidate_at > v_latest_at
        or (
          v_candidate_at = v_latest_at
          and v_correction.updated_at > v_latest_row_updated_at
        )
      then
        v_latest_at := v_candidate_at;
        v_latest_row_updated_at := v_correction.updated_at;
        v_latest_view := v_correction.target_view;
      end if;
    end loop;

  end if;

  if
    p_close_active_siblings
    and v_placement_applied
    and v_latest_view in ('handled', 'noise')
  then
    v_cutoff := coalesce(p_correction_cutoff, v_changed_at);
    update public.inbox_actions as sibling
    set
      status = 'done',
      executed_at = coalesce(sibling.executed_at, v_changed_at),
      updated_at = greatest(sibling.updated_at, v_changed_at)
    where sibling.id <> v_action.id
      and sibling.user_id = v_action.user_id
      and sibling.provider = v_action.provider
      and sibling.connection_id = v_action.connection_id
      and (
        (
          v_action.gmail_thread_id is not null
          and sibling.gmail_thread_id = v_action.gmail_thread_id
        )
        or (
          v_action.gmail_thread_id is null
          and sibling.gmail_message_id = v_action.gmail_message_id
        )
      )
      and sibling.status in ('pending', 'approved', 'executing', 'failed')
      and not coalesce(sibling.metadata, '{}'::jsonb)
        @> '{"email_tracking_record":true}'::jsonb
      and coalesce(sibling.received_at, sibling.created_at) <= v_cutoff;
    get diagnostics v_closed_sibling_count = row_count;
  end if;

  return query
  select v_action.id, v_action.updated_at, v_closed_sibling_count;
end;
$$;

revoke all on function public.apply_email_workspace_action_mutation(
  uuid,
  uuid,
  jsonb,
  timestamptz,
  text,
  text,
  timestamptz,
  boolean,
  timestamptz
) from public, anon;
grant execute on function public.apply_email_workspace_action_mutation(
  uuid,
  uuid,
  jsonb,
  timestamptz,
  text,
  text,
  timestamptz,
  boolean,
  timestamptz
) to authenticated, service_role;

-- Pending action acquisition must honor a conversation-level Done/Noise
-- marker even when that marker lives on another historical action row. Compare
-- provider receipt time, not insertion time, so a later reply reopens Focus.
create or replace function public.try_acquire_inbox_action_execution(
  p_action_id uuid,
  p_user_id uuid,
  p_changed_at timestamptz default now()
)
returns setof public.inbox_actions
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_target public.inbox_actions%rowtype;
  v_correction record;
  v_candidate_at timestamptz;
  v_latest_at timestamptz := '-infinity'::timestamptz;
  v_latest_row_updated_at timestamptz := '-infinity'::timestamptz;
  v_latest_view text := '';
begin
  select target.*
  into v_target
  from public.inbox_actions as target
  where target.id = p_action_id
    and target.user_id = p_user_id
    and target.status = 'pending'
  for update;

  if not found then
    return;
  end if;

  -- Pick the latest applicable placement, not merely any historical Done.
  -- A later explicit move back to Focus/Inbox reverses an older correction.
  for v_correction in
    select
      correction.metadata->>'email_workspace_override_view' as target_view,
      correction.metadata->>'email_workspace_corrected_at' as corrected_at,
      correction.updated_at
    from public.inbox_actions as correction
    where correction.user_id = v_target.user_id
      and correction.provider = v_target.provider
      and correction.connection_id = v_target.connection_id
      and (
        (
          v_target.gmail_thread_id is not null
          and correction.gmail_thread_id = v_target.gmail_thread_id
        )
        or (
          v_target.gmail_thread_id is null
          and correction.gmail_message_id = v_target.gmail_message_id
        )
      )
      and correction.metadata->>'email_workspace_override_view'
        in ('focus', 'inbox', 'noise', 'handled')
  loop
    begin
      v_candidate_at := v_correction.corrected_at::timestamptz;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        continue;
    end;
    if v_candidate_at < coalesce(v_target.received_at, v_target.created_at) then
      continue;
    end if;
    if
      v_candidate_at > v_latest_at
      or (
        v_candidate_at = v_latest_at
        and v_correction.updated_at > v_latest_row_updated_at
      )
    then
      v_latest_at := v_candidate_at;
      v_latest_row_updated_at := v_correction.updated_at;
      v_latest_view := v_correction.target_view;
    end if;
  end loop;

  if v_latest_view in ('handled', 'noise') then
    return;
  end if;

  return query
  update public.inbox_actions as target
  set
    status = 'executing',
    updated_at = greatest(target.updated_at, coalesce(p_changed_at, now()))
  where target.id = p_action_id
    and target.user_id = p_user_id
    and target.status = 'pending'
  returning target.*;
end;
$$;

revoke all on function public.try_acquire_inbox_action_execution(
  uuid,
  uuid,
  timestamptz
) from public, anon;
grant execute on function public.try_acquire_inbox_action_execution(
  uuid,
  uuid,
  timestamptz
) to authenticated, service_role;

-- A heartbeat insert can race a user correction: the newly inserted pending
-- draft is already covered by Done/Noise, but still owns the partial unique
-- draft-per-thread index. Close those rows in one scoped transaction after
-- rechecking the conversation's latest placement. A later Focus/Inbox marker
-- reverses an older Done/Noise marker and leaves the row pending.
create or replace function public.close_covered_pending_inbox_actions(
  p_action_ids uuid[],
  p_user_id uuid,
  p_changed_at timestamptz default now()
)
returns table (
  action_id uuid,
  action_updated_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_target public.inbox_actions%rowtype;
  v_correction record;
  v_changed_at timestamptz := coalesce(p_changed_at, now());
  v_candidate_at timestamptz;
  v_latest_at timestamptz;
  v_latest_row_updated_at timestamptz;
  v_latest_view text;
begin
  if p_user_id is null then
    raise exception 'Email action user id is required.';
  end if;
  if coalesce(cardinality(p_action_ids), 0) = 0 then
    return;
  end if;
  if cardinality(p_action_ids) > 500 then
    raise exception 'At most 500 pending email actions may be closed at once.';
  end if;

  -- Deterministic ordering keeps concurrent batched cleanup calls from
  -- acquiring the same action locks in opposite orders.
  for v_target in
    select target.*
    from public.inbox_actions as target
    where target.user_id = p_user_id
      and target.status = 'pending'
      and target.id = any(p_action_ids)
    order by target.id
    for update
  loop
    v_latest_at := '-infinity'::timestamptz;
    v_latest_row_updated_at := '-infinity'::timestamptz;
    v_latest_view := '';

    for v_correction in
      select
        correction.metadata->>'email_workspace_override_view' as target_view,
        correction.metadata->>'email_workspace_corrected_at' as corrected_at,
        correction.updated_at
      from public.inbox_actions as correction
      where correction.user_id = v_target.user_id
        and correction.provider = v_target.provider
        and correction.connection_id = v_target.connection_id
        and (
          (
            v_target.gmail_thread_id is not null
            and correction.gmail_thread_id = v_target.gmail_thread_id
          )
          or (
            v_target.gmail_thread_id is null
            and correction.gmail_message_id = v_target.gmail_message_id
          )
        )
        and correction.metadata->>'email_workspace_override_view'
          in ('focus', 'inbox', 'noise', 'handled')
    loop
      begin
        v_candidate_at := v_correction.corrected_at::timestamptz;
      exception
        when invalid_datetime_format or datetime_field_overflow then
          continue;
      end;
      if v_candidate_at < coalesce(v_target.received_at, v_target.created_at) then
        continue;
      end if;
      if
        v_candidate_at > v_latest_at
        or (
          v_candidate_at = v_latest_at
          and v_correction.updated_at > v_latest_row_updated_at
        )
      then
        v_latest_at := v_candidate_at;
        v_latest_row_updated_at := v_correction.updated_at;
        v_latest_view := v_correction.target_view;
      end if;
    end loop;

    if v_latest_view in ('handled', 'noise') then
      update public.inbox_actions as target
      set
        status = 'done',
        executed_at = coalesce(target.executed_at, v_changed_at),
        updated_at = greatest(target.updated_at, v_changed_at)
      where target.id = v_target.id
        and target.user_id = p_user_id
        and target.status = 'pending'
      returning target.id, target.updated_at
      into action_id, action_updated_at;
      if found then
        return next;
      end if;
    end if;
  end loop;
end;
$$;

revoke all on function public.close_covered_pending_inbox_actions(
  uuid[],
  uuid,
  timestamptz
) from public, anon;
grant execute on function public.close_covered_pending_inbox_actions(
  uuid[],
  uuid,
  timestamptz
) to authenticated, service_role;
