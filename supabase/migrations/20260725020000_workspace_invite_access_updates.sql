-- Allow admins to change a pending invitation's role and channel grants in one
-- transaction. The application validates guest-safe Mind configuration before
-- calling this service-role-only function; the database still enforces invite
-- ownership and channel/workspace integrity.
create or replace function public.update_workspace_invite_access(
  p_workspace_id uuid,
  p_invite_id uuid,
  p_role text,
  p_channel_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_channel_ids uuid[];
begin
  if p_role not in ('member', 'guest') then
    raise exception 'Invitation role must be member or guest';
  end if;

  select coalesce(array_agg(distinct requested.channel_id), array[]::uuid[])
    into v_channel_ids
  from unnest(coalesce(p_channel_ids, array[]::uuid[]))
    as requested(channel_id);

  if p_role = 'guest' and cardinality(v_channel_ids) = 0 then
    raise exception 'Channel guests must be invited to at least one channel';
  end if;

  if exists (
    select 1
    from unnest(v_channel_ids) as requested(channel_id)
    left join public.chat_channels channel
      on channel.id = requested.channel_id
     and channel.workspace_id = p_workspace_id
     and channel.kind = 'channel'
     and channel.is_archived = false
    where channel.id is null
  ) then
    raise exception 'One or more selected channels are invalid';
  end if;

  if p_role = 'guest' and exists (
    select 1
    from unnest(v_channel_ids) as requested(channel_id)
    join public.chat_channels channel
      on channel.id = requested.channel_id
     and channel.workspace_id = p_workspace_id
    left join public.orchestrator_profiles profile
      on profile.id = channel.profile_id
     and profile.workspace_id = p_workspace_id
    where channel.orchestrator_mode <> 'off'
      and (
        profile.id is null
        or profile.surface is distinct from 'external'
        or profile.authorization_stance is distinct from 'restricted'
        or profile.memory_scope is distinct from 'profile'
        or profile.inherit_workspace_skills is distinct from false
        or profile.inherit_workspace_integrations is distinct from false
      )
  ) then
    raise exception 'One or more selected channels is not guest-safe';
  end if;

  update public.workspace_invites
  set role = p_role
  where id = p_invite_id
    and workspace_id = p_workspace_id;

  if not found then
    raise exception 'Invite not found';
  end if;

  delete from public.workspace_invite_channels
  where invite_id = p_invite_id
    and workspace_id = p_workspace_id;

  insert into public.workspace_invite_channels (
    invite_id,
    channel_id,
    workspace_id
  )
  select
    p_invite_id,
    requested.channel_id,
    p_workspace_id
  from unnest(v_channel_ids) as requested(channel_id);
end;
$$;

revoke all on function public.update_workspace_invite_access(
  uuid,
  uuid,
  text,
  uuid[]
) from public;

grant execute on function public.update_workspace_invite_access(
  uuid,
  uuid,
  text,
  uuid[]
) to service_role;

-- Change an accepted non-admin user's role and explicit channel grants
-- together. Converting to guest also removes internal agent ACLs that came
-- from this workspace unless another workspace still grants the user operator
-- access to the same agent.
create or replace function public.update_workspace_member_access(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_user_id uuid,
  p_role text,
  p_channel_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
set row_security = off
as $$
declare
  v_channel_ids uuid[];
  v_current_role text;
begin
  if not exists (
    select 1
    from public.workspace_members
    where workspace_id = p_workspace_id
      and user_id = p_actor_user_id
      and role = 'admin'
  ) then
    raise exception 'Admin access required';
  end if;

  if p_actor_user_id = p_user_id then
    raise exception 'Cannot change your own access';
  end if;

  if p_role not in ('member', 'guest') then
    raise exception 'Member role must be member or guest';
  end if;

  select role
    into v_current_role
  from public.workspace_members
  where workspace_id = p_workspace_id
    and user_id = p_user_id
  for update;

  if not found then
    raise exception 'Member not found';
  end if;

  if v_current_role = 'admin' then
    raise exception 'Cannot change another admin''s access';
  end if;

  select coalesce(array_agg(distinct requested.channel_id), array[]::uuid[])
    into v_channel_ids
  from unnest(coalesce(p_channel_ids, array[]::uuid[]))
    as requested(channel_id);

  if p_role = 'guest' and cardinality(v_channel_ids) = 0 then
    raise exception 'Channel guests must have access to at least one channel';
  end if;

  if exists (
    select 1
    from unnest(v_channel_ids) as requested(channel_id)
    left join public.chat_channels channel
      on channel.id = requested.channel_id
     and channel.workspace_id = p_workspace_id
     and channel.kind = 'channel'
     and channel.is_archived = false
    where channel.id is null
  ) then
    raise exception 'One or more selected channels are invalid';
  end if;

  if p_role = 'guest' and exists (
    select 1
    from unnest(v_channel_ids) as requested(channel_id)
    join public.chat_channels channel
      on channel.id = requested.channel_id
     and channel.workspace_id = p_workspace_id
    left join public.orchestrator_profiles profile
      on profile.id = channel.profile_id
     and profile.workspace_id = p_workspace_id
    where channel.orchestrator_mode <> 'off'
      and (
        profile.id is null
        or profile.surface is distinct from 'external'
        or profile.authorization_stance is distinct from 'restricted'
        or profile.memory_scope is distinct from 'profile'
        or profile.inherit_workspace_skills is distinct from false
        or profile.inherit_workspace_integrations is distinct from false
      )
  ) then
    raise exception 'One or more selected channels is not guest-safe';
  end if;

  update public.workspace_members
  set role = p_role
  where workspace_id = p_workspace_id
    and user_id = p_user_id;

  delete from public.chat_channel_members target_channel_member
  using public.chat_channels channel
  where target_channel_member.channel_id = channel.id
    and channel.workspace_id = p_workspace_id
    and target_channel_member.member_type = 'user'
    and target_channel_member.user_id = p_user_id
    and (
      (
        channel.kind = 'channel'
        and not (target_channel_member.channel_id = any(v_channel_ids))
      )
      or (
        p_role = 'guest'
        and channel.kind <> 'channel'
      )
    );

  insert into public.chat_channel_members (
    channel_id,
    member_type,
    user_id,
    agent_id,
    added_by
  )
  select
    requested.channel_id,
    'user',
    p_user_id,
    null,
    p_actor_user_id
  from unnest(v_channel_ids) as requested(channel_id)
  where not exists (
    select 1
    from public.chat_channel_members existing
    where existing.channel_id = requested.channel_id
      and existing.member_type = 'user'
      and existing.user_id = p_user_id
  );

  if p_role = 'guest' then
    update public.workspace_orchestrator_requests
    set
      status = 'cancelled',
      cancelled_at = coalesce(cancelled_at, now()),
      updated_at = now()
    where workspace_id = p_workspace_id
      and (
        requested_by_user_id = p_user_id
        or requested_user_id = p_user_id
      )
      and status in ('pending', 'running');

    delete from public.orchestrator_agent_members member_acl
    using public.workspace_orchestrator_agents shared_agent
    where shared_agent.workspace_id = p_workspace_id
      and shared_agent.agent_id = member_acl.agent_id
      and member_acl.user_id = p_user_id
      and member_acl.role = 'viewer'
      and not exists (
        select 1
        from public.workspace_orchestrator_agents other_shared_agent
        join public.workspace_members other_membership
          on other_membership.workspace_id =
            other_shared_agent.workspace_id
         and other_membership.user_id = p_user_id
         and other_membership.role in ('admin', 'member')
        where other_shared_agent.agent_id = member_acl.agent_id
          and other_shared_agent.workspace_id <> p_workspace_id
      );
  else
    insert into public.orchestrator_agent_members (
      agent_id,
      user_id,
      role,
      created_by_user_id,
      updated_at
    )
    select
      shared_agent.agent_id,
      p_user_id,
      'viewer',
      shared_agent.created_by_user_id,
      now()
    from public.workspace_orchestrator_agents shared_agent
    where shared_agent.workspace_id = p_workspace_id
    on conflict (agent_id, user_id) do nothing;
  end if;
end;
$$;

revoke all on function public.update_workspace_member_access(
  uuid,
  uuid,
  uuid,
  text,
  uuid[]
) from public;

grant execute on function public.update_workspace_member_access(
  uuid,
  uuid,
  uuid,
  text,
  uuid[]
) to service_role;

-- Remove workspace-seeded viewer ACLs that may predate guest filtering.
delete from public.orchestrator_agent_members member_acl
using public.workspace_orchestrator_agents shared_agent,
  public.workspace_members guest_membership
where shared_agent.workspace_id = guest_membership.workspace_id
  and guest_membership.role = 'guest'
  and shared_agent.agent_id = member_acl.agent_id
  and guest_membership.user_id = member_acl.user_id
  and member_acl.role = 'viewer'
  and not exists (
    select 1
    from public.workspace_orchestrator_agents other_shared_agent
    join public.workspace_members other_membership
      on other_membership.workspace_id = other_shared_agent.workspace_id
     and other_membership.user_id = member_acl.user_id
     and other_membership.role in ('admin', 'member')
    where other_shared_agent.agent_id = member_acl.agent_id
  );

-- Guest membership must never unlock workspace-level agents, sessions,
-- messages, or activity. Guest-safe channel Minds are exposed through the
-- channel boundary instead.
drop policy if exists "agents_select_shared_acl" on public.agents;
create policy "agents_select_shared_acl"
on public.agents
for select
using (
  exists (
    select 1
    from public.workspace_orchestrator_agents shared_agent
    join public.workspace_members membership
      on membership.workspace_id = shared_agent.workspace_id
    where shared_agent.agent_id = agents.id
      and membership.user_id = auth.uid()
      and membership.role in ('admin', 'member')
  )
  or exists (
    select 1
    from public.orchestrator_agent_members member_acl
    where member_acl.agent_id = agents.id
      and member_acl.user_id = auth.uid()
  )
);

drop policy if exists "Workspace members can view sessions shared by agent ACL"
  on public.orchestrator_sessions;
create policy "Workspace members can view sessions shared by agent ACL"
on public.orchestrator_sessions
for select
using (
  exists (
    select 1
    from public.orchestrator_session_runtime runtime
    join public.workspace_orchestrator_agents shared_agent
      on shared_agent.agent_id = runtime.agent_id
    join public.workspace_members membership
      on membership.workspace_id = shared_agent.workspace_id
    where runtime.session_id = orchestrator_sessions.id
      and membership.user_id = auth.uid()
      and membership.role in ('admin', 'member')
  )
  or exists (
    select 1
    from public.orchestrator_session_runtime runtime
    join public.orchestrator_agent_members member_acl
      on member_acl.agent_id = runtime.agent_id
    where runtime.session_id = orchestrator_sessions.id
      and member_acl.user_id = auth.uid()
  )
);

drop policy if exists "Workspace members can view shared orchestrator messages by agent ACL"
  on public.orchestrator_messages;
create policy "Workspace members can view shared orchestrator messages by agent ACL"
on public.orchestrator_messages
for select
using (
  agent_id is not null
  and (
    exists (
      select 1
      from public.workspace_orchestrator_agents shared_agent
      join public.workspace_members membership
        on membership.workspace_id = shared_agent.workspace_id
      where shared_agent.agent_id = orchestrator_messages.agent_id
        and membership.user_id = auth.uid()
        and membership.role in ('admin', 'member')
    )
    or exists (
      select 1
      from public.orchestrator_agent_members member_acl
      where member_acl.agent_id = orchestrator_messages.agent_id
        and member_acl.user_id = auth.uid()
    )
  )
);

drop policy if exists "Workspace members can view shared orchestrator sessions"
  on public.orchestrator_sessions;
create policy "Workspace members can view shared orchestrator sessions"
on public.orchestrator_sessions
for select
using (
  exists (
    select 1
    from public.workspace_orchestrator_sessions shared_session
    join public.workspace_members membership
      on membership.workspace_id = shared_session.workspace_id
    where shared_session.session_id = orchestrator_sessions.id
      and membership.user_id = auth.uid()
      and membership.role in ('admin', 'member')
  )
);

drop policy if exists "Workspace members can view shared orchestrator messages"
  on public.orchestrator_messages;
create policy "Workspace members can view shared orchestrator messages"
on public.orchestrator_messages
for select
using (
  exists (
    select 1
    from public.workspace_orchestrator_sessions shared_session
    join public.workspace_members membership
      on membership.workspace_id = shared_session.workspace_id
    where shared_session.session_id = orchestrator_messages.session_id
      and membership.user_id = auth.uid()
      and membership.role in ('admin', 'member')
  )
);

drop policy if exists "Workspace members can view shared activity"
  on public.activity_log;
create policy "Workspace members can view shared activity"
on public.activity_log
for select
using (
  exists (
    select 1
    from public.workspace_orchestrator_sessions shared_session
    join public.workspace_members membership
      on membership.workspace_id = shared_session.workspace_id
    where shared_session.session_id = activity_log.session_id
      and membership.user_id = auth.uid()
      and membership.role in ('admin', 'member')
  )
);

drop policy if exists "workspace_orch_requests_select"
  on public.workspace_orchestrator_requests;
create policy "workspace_orch_requests_select"
on public.workspace_orchestrator_requests
for select
using (
  public.is_workspace_member(workspace_id)
  and (
    auth.uid() = requested_by_user_id
    or auth.uid() = requested_user_id
    or public.is_workspace_admin(workspace_id)
  )
);

drop policy if exists "workspace_orch_requests_insert"
  on public.workspace_orchestrator_requests;
create policy "workspace_orch_requests_insert"
on public.workspace_orchestrator_requests
for insert
with check (
  auth.uid() = requested_by_user_id
  and public.is_workspace_member(workspace_id)
  and exists (
    select 1
    from public.workspace_members target_membership
    where target_membership.workspace_id =
      workspace_orchestrator_requests.workspace_id
      and target_membership.user_id =
        workspace_orchestrator_requests.requested_user_id
      and target_membership.role in ('admin', 'member')
  )
  and (
    (
      session_id is not null
      and exists (
        select 1
        from public.workspace_orchestrator_sessions shared_session
        where shared_session.workspace_id =
          workspace_orchestrator_requests.workspace_id
          and shared_session.session_id =
            workspace_orchestrator_requests.session_id
      )
    )
    or (
      agent_id is not null
      and exists (
        select 1
        from public.workspace_orchestrator_agents shared_agent
        where shared_agent.workspace_id =
          workspace_orchestrator_requests.workspace_id
          and shared_agent.agent_id =
            workspace_orchestrator_requests.agent_id
      )
    )
  )
);

drop policy if exists "workspace_orch_requests_update_requested"
  on public.workspace_orchestrator_requests;
create policy "workspace_orch_requests_update_requested"
on public.workspace_orchestrator_requests
for update
using (
  auth.uid() = requested_user_id
  and public.is_workspace_member(workspace_id)
)
with check (
  auth.uid() = requested_user_id
  and public.is_workspace_member(workspace_id)
);

drop policy if exists "workspace_orch_requests_update_requester"
  on public.workspace_orchestrator_requests;
create policy "workspace_orch_requests_update_requester"
on public.workspace_orchestrator_requests
for update
using (
  auth.uid() = requested_by_user_id
  and public.is_workspace_member(workspace_id)
)
with check (
  auth.uid() = requested_by_user_id
  and public.is_workspace_member(workspace_id)
);
