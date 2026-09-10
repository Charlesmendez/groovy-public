-- Keep branch capacity and turn counters correct when several orchestrator
-- requests arrive at the same time.

create or replace function public.increment_orchestrator_branch_turn_count(
  p_user_id uuid,
  p_branch_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_turn_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and auth.uid() is distinct from p_user_id
  then
    raise exception 'Not authorized';
  end if;

  update public.orchestrator_branches
  set turn_count = turn_count + 1,
      updated_at = now()
  where id = p_branch_id
    and user_id = p_user_id
  returning turn_count into v_turn_count;

  return v_turn_count;
end;
$$;

create or replace function public.spawn_orchestrator_worker_branches(
  p_user_id uuid,
  p_agent_id uuid,
  p_epoch_id uuid,
  p_parent_branch_id uuid,
  p_max_branches integer,
  p_tasks jsonb
)
returns table(branch_id uuid, title text, goal text)
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_active_count integer;
  v_available_slots integer;
  v_next_ordinal integer;
  v_task jsonb;
  v_goal text;
  v_title text;
  v_branch_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and auth.uid() is distinct from p_user_id
  then
    raise exception 'Not authorized';
  end if;

  if jsonb_typeof(p_tasks) <> 'array' then
    return;
  end if;

  -- Serialize capacity checks for one agent epoch. Without this lock, two
  -- parallel fan-out calls can both observe the same free slots and exceed the
  -- configured branch limit.
  perform pg_advisory_xact_lock(
    hashtextextended(
      p_user_id::text || ':' || p_agent_id::text || ':' || p_epoch_id::text,
      0
    )
  );

  perform 1
  from public.orchestrator_branches
  where id = p_parent_branch_id
    and user_id = p_user_id
    and agent_id = p_agent_id
    and epoch_id = p_epoch_id
    and status = 'active';
  if not found then
    raise exception 'Active parent branch not found';
  end if;

  select count(*)::integer
  into v_active_count
  from public.orchestrator_branches
  where user_id = p_user_id
    and agent_id = p_agent_id
    and epoch_id = p_epoch_id
    and status = 'active';

  v_available_slots :=
    greatest(0, greatest(1, least(coalesce(p_max_branches, 1), 12)) - v_active_count);
  if v_available_slots = 0 then
    return;
  end if;

  select count(*)::integer + 1
  into v_next_ordinal
  from public.orchestrator_branches
  where user_id = p_user_id
    and agent_id = p_agent_id
    and epoch_id = p_epoch_id;

  for v_task in
    select value
    from jsonb_array_elements(p_tasks)
    with ordinality as requested(value, position)
    order by position
    limit v_available_slots
  loop
    v_goal := btrim(coalesce(v_task ->> 'goal', ''));
    if v_goal = '' then
      continue;
    end if;
    v_title := left(
      coalesce(
        nullif(btrim(coalesce(v_task ->> 'title', '')), ''),
        'worker-' || v_next_ordinal::text
      ),
      80
    );

    insert into public.orchestrator_branches (
      user_id,
      agent_id,
      epoch_id,
      parent_branch_id,
      name,
      status,
      branch_kind,
      turn_count,
      goal,
      fork_reason
    )
    values (
      p_user_id,
      p_agent_id,
      p_epoch_id,
      p_parent_branch_id,
      v_title,
      'active',
      'worker',
      0,
      v_goal,
      'runtime_branch_parallel'
    )
    returning id into v_branch_id;

    branch_id := v_branch_id;
    title := v_title;
    goal := v_goal;
    return next;
    v_next_ordinal := v_next_ordinal + 1;
  end loop;
end;
$$;

revoke all on function public.increment_orchestrator_branch_turn_count(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.spawn_orchestrator_worker_branches(
  uuid, uuid, uuid, uuid, integer, jsonb
) from public, anon, authenticated;

grant execute on function public.increment_orchestrator_branch_turn_count(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.spawn_orchestrator_worker_branches(
  uuid, uuid, uuid, uuid, integer, jsonb
) to authenticated, service_role;
