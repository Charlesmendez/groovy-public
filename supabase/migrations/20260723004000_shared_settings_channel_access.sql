-- Shared settings and scoped team-chat access.
--
-- This migration is intentionally additive:
-- - existing workspace members keep their current access;
-- - existing channels remain workspace-visible;
-- - existing harness profiles inherit the current workspace-wide skill and
--   integration assignments until an admin explicitly customizes them.

-- ---------------------------------------------------------------------------
-- Mind-scoped capabilities
-- ---------------------------------------------------------------------------

alter table public.orchestrator_profiles
  add column if not exists inherit_workspace_skills boolean not null default true,
  add column if not exists inherit_workspace_integrations boolean not null default true;

-- Publishing must be explicit. Existing external profiles may predate these
-- columns, so do not let their defaults silently expose internal Markdown or
-- workspace integrations to public API/widget callers.
update public.orchestrator_profiles
set
  inherit_workspace_skills = false,
  inherit_workspace_integrations = false
where surface = 'external'
  and (
    inherit_workspace_skills = true
    or inherit_workspace_integrations = true
  );

alter table public.workspace_skill_assignments
  add column if not exists profile_id uuid
    references public.orchestrator_profiles(id) on delete cascade;

alter table public.workspace_skill_artifacts
  add column if not exists content_snapshot text,
  add column if not exists content_snapshot_truncated boolean not null default false,
  add column if not exists content_snapshot_updated_at timestamptz;

alter table public.workspace_skill_artifacts
  drop constraint if exists workspace_skill_artifacts_snapshot_size_check;
alter table public.workspace_skill_artifacts
  add constraint workspace_skill_artifacts_snapshot_size_check
  check (
    content_snapshot is null
    or octet_length(content_snapshot) <= 262144
  );

alter table public.workspace_skill_assignments
  drop constraint if exists workspace_skill_assignments_scope_check;

alter table public.workspace_skill_assignments
  add constraint workspace_skill_assignments_scope_check
  check (
    (scope = 'workspace' and agent_id is null and profile_id is null)
    or (scope = 'agent' and agent_id is not null and profile_id is null)
    or (scope = 'profile' and agent_id is null and profile_id is not null)
  );

drop index if exists public.workspace_skill_assignments_workspace_unique_idx;
drop index if exists public.workspace_skill_assignments_agent_unique_idx;

create unique index if not exists workspace_skill_assignments_workspace_unique_idx
  on public.workspace_skill_assignments(workspace_id, artifact_id, target)
  where agent_id is null and profile_id is null;

create unique index if not exists workspace_skill_assignments_agent_unique_idx
  on public.workspace_skill_assignments(workspace_id, artifact_id, agent_id, target)
  where agent_id is not null and profile_id is null;

create unique index if not exists workspace_skill_assignments_profile_unique_idx
  on public.workspace_skill_assignments(workspace_id, artifact_id, profile_id, target)
  where profile_id is not null and agent_id is null;

create index if not exists workspace_skill_assignments_profile_idx
  on public.workspace_skill_assignments(profile_id, enabled, updated_at desc)
  where profile_id is not null;

create or replace function public.is_valid_workspace_skill_assignment(
  p_workspace_id uuid,
  p_artifact_id uuid,
  p_agent_id uuid,
  p_profile_id uuid,
  p_scope text
)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select
    exists (
      select 1
      from public.workspace_skill_artifacts artifact
      where artifact.id = p_artifact_id
        and artifact.workspace_id = p_workspace_id
    )
    and (
      (
        p_scope = 'workspace'
        and p_agent_id is null
        and p_profile_id is null
      )
      or (
        p_scope = 'agent'
        and p_agent_id is not null
        and p_profile_id is null
        and exists (
          select 1
          from public.agents agent
          join public.workspace_members member
            on member.user_id = agent.user_id
           and member.workspace_id = p_workspace_id
          where agent.id = p_agent_id
        )
      )
      or (
        p_scope = 'profile'
        and p_agent_id is null
        and p_profile_id is not null
        and exists (
          select 1
          from public.orchestrator_profiles profile
          where profile.id = p_profile_id
            and (
              profile.workspace_id = p_workspace_id
              or (
                profile.workspace_id is null
                and exists (
                  select 1
                  from public.workspace_members member
                  where member.workspace_id = p_workspace_id
                    and member.user_id = profile.user_id
                    and member.role in ('admin', 'member')
                )
              )
            )
        )
      )
    );
$$;

drop policy if exists "workspace_skill_assignments_admin_write"
  on public.workspace_skill_assignments;
create policy "workspace_skill_assignments_admin_write"
on public.workspace_skill_assignments
for all
using (public.is_workspace_admin(workspace_id))
with check (
  public.is_workspace_admin(workspace_id)
  and public.is_valid_workspace_skill_assignment(
    workspace_id,
    artifact_id,
    agent_id,
    profile_id,
    scope
  )
);

create table if not exists public.orchestrator_profile_integrations (
  profile_id uuid not null
    references public.orchestrator_profiles(id) on delete cascade,
  integration_agent_id uuid not null
    references public.agents(id) on delete cascade,
  workspace_id uuid not null
    references public.workspaces(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, integration_agent_id)
);

create index if not exists orchestrator_profile_integrations_workspace_idx
  on public.orchestrator_profile_integrations(workspace_id, profile_id);

create or replace function public.is_valid_profile_integration(
  p_profile_id uuid,
  p_integration_agent_id uuid,
  p_workspace_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.orchestrator_profiles p
    join public.workspaces w on w.id = p_workspace_id
    join public.agents a on a.id = p_integration_agent_id
    join public.datagran_agent_configs d on d.agent_id = a.id
    where p.id = p_profile_id
      and (
        p.workspace_id = p_workspace_id
        or (
          p.workspace_id is null
          and exists (
            select 1
            from public.workspace_members member
            where member.workspace_id = p_workspace_id
              and member.user_id = p.user_id
              and member.role in ('admin', 'member')
          )
        )
      )
      and a.user_id = w.billing_admin_user_id
      and d.user_id = w.billing_admin_user_id
  );
$$;

alter table public.orchestrator_profile_integrations enable row level security;

drop policy if exists "profile_integrations_select_member"
  on public.orchestrator_profile_integrations;
create policy "profile_integrations_select_member"
on public.orchestrator_profile_integrations
for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "profile_integrations_admin_write"
  on public.orchestrator_profile_integrations;
create policy "profile_integrations_admin_write"
on public.orchestrator_profile_integrations
for all
using (public.is_workspace_admin(workspace_id))
with check (
  public.is_workspace_admin(workspace_id)
  and public.is_valid_profile_integration(
    profile_id,
    integration_agent_id,
    workspace_id
  )
);

-- ---------------------------------------------------------------------------
-- Workspace guests and private channels
-- ---------------------------------------------------------------------------

alter table public.workspace_members
  drop constraint if exists workspace_members_role_check;
alter table public.workspace_members
  add constraint workspace_members_role_check
  check (role in ('admin', 'member', 'guest'));

-- A guest is a workspace identity for billing/invitation lifecycle purposes,
-- but is not an operator. Existing policies that call is_workspace_member()
-- therefore remain closed to guests.
create or replace function public.is_workspace_member(w_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.workspace_members
    where workspace_id = w_id
      and user_id = auth.uid()
      and role in ('admin', 'member')
  );
$$;

create or replace function public.is_workspace_identity(w_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.workspace_members
    where workspace_id = w_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_guest(w_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.workspace_members
    where workspace_id = w_id
      and user_id = auth.uid()
      and role = 'guest'
  );
$$;

create or replace function public.is_channel_member(c_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.chat_channel_members cm
    join public.chat_channels c on c.id = cm.channel_id
    join public.workspace_members wm
      on wm.workspace_id = c.workspace_id
     and wm.user_id = auth.uid()
    where cm.channel_id = c_id
      and cm.member_type = 'user'
      and cm.user_id = auth.uid()
  );
$$;

alter table public.chat_channels
  add column if not exists visibility text not null default 'workspace';

alter table public.chat_channels
  drop constraint if exists chat_channels_visibility_check;
alter table public.chat_channels
  add constraint chat_channels_visibility_check
  check (visibility in ('workspace', 'private'));

create index if not exists chat_channels_visibility_idx
  on public.chat_channels(workspace_id, visibility, is_archived, updated_at desc);

alter table public.workspace_invites
  add column if not exists role text not null default 'member';

alter table public.workspace_invites
  drop constraint if exists workspace_invites_role_check;
alter table public.workspace_invites
  add constraint workspace_invites_role_check
  check (role in ('member', 'guest'));

create table if not exists public.workspace_invite_channels (
  invite_id uuid not null
    references public.workspace_invites(id) on delete cascade,
  channel_id uuid not null
    references public.chat_channels(id) on delete cascade,
  workspace_id uuid not null
    references public.workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (invite_id, channel_id)
);

create index if not exists workspace_invite_channels_workspace_idx
  on public.workspace_invite_channels(workspace_id, invite_id);

create or replace function public.is_valid_invite_channel(
  p_invite_id uuid,
  p_channel_id uuid,
  p_workspace_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.workspace_invites i
    join public.chat_channels c on c.id = p_channel_id
    where i.id = p_invite_id
      and i.workspace_id = p_workspace_id
      and c.workspace_id = p_workspace_id
      and c.kind = 'channel'
      and c.is_archived = false
  );
$$;

alter table public.workspace_invite_channels enable row level security;

drop policy if exists "workspace_invite_channels_admin"
  on public.workspace_invite_channels;
create policy "workspace_invite_channels_admin"
on public.workspace_invite_channels
for all
using (public.is_workspace_admin(workspace_id))
with check (
  public.is_workspace_admin(workspace_id)
  and public.is_valid_invite_channel(invite_id, channel_id, workspace_id)
);

create or replace function public.can_read_chat_channel(c_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.chat_channels c
    where c.id = c_id
      and (
        public.is_channel_member(c.id)
        or (
          c.kind = 'channel'
          and c.created_by = auth.uid()
          and public.is_workspace_identity(c.workspace_id)
        )
        or (
          c.kind = 'channel'
          and public.is_workspace_admin(c.workspace_id)
        )
        or (
          c.kind = 'channel'
          and c.visibility = 'workspace'
          and public.is_workspace_member(c.workspace_id)
        )
      )
  );
$$;

create or replace function public.can_write_chat_channel(c_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select public.can_read_chat_channel(c_id);
$$;

create or replace function public.can_manage_chat_channel(c_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1
    from public.chat_channels c
    where c.id = c_id
      and (
        public.is_workspace_admin(c.workspace_id)
        or (
          c.created_by = auth.uid()
          and public.is_workspace_member(c.workspace_id)
        )
      )
  );
$$;

create or replace function public.can_manage_chat_channel_member(
  c_id uuid,
  m_type text,
  m_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select
    public.can_manage_chat_channel(c_id)
    and (
      m_type <> 'user'
      or m_user_id is null
      or not exists (
        select 1
        from public.chat_channels c
        join public.workspace_members wm
          on wm.workspace_id = c.workspace_id
         and wm.user_id = m_user_id
        where c.id = c_id
          and wm.role = 'guest'
      )
      or exists (
        select 1
        from public.chat_channels c
        where c.id = c_id
          and public.is_workspace_admin(c.workspace_id)
      )
    );
$$;

drop policy if exists "chat_channels_select" on public.chat_channels;
create policy "chat_channels_select"
on public.chat_channels
for select
using (public.can_read_chat_channel(id));

drop policy if exists "chat_channels_update" on public.chat_channels;
create policy "chat_channels_update"
on public.chat_channels
for update
using (
  public.is_workspace_admin(workspace_id)
  or (
    created_by = auth.uid()
    and public.is_workspace_member(workspace_id)
  )
)
with check (
  public.is_workspace_member(workspace_id)
  and (
    public.is_workspace_admin(workspace_id)
    or created_by = auth.uid()
  )
  and public.is_valid_chat_channel_profile(workspace_id, profile_id)
);

drop policy if exists "chat_channels_delete" on public.chat_channels;
create policy "chat_channels_delete"
on public.chat_channels
for delete
using (
  public.is_workspace_admin(workspace_id)
  or (
    created_by = auth.uid()
    and public.is_workspace_member(workspace_id)
  )
);

drop policy if exists "chat_messages_insert_user" on public.chat_messages;
create policy "chat_messages_insert_user"
on public.chat_messages
for insert
with check (
  public.can_write_chat_channel(channel_id)
  and author_type = 'user'
  and author_user_id = auth.uid()
  and author_agent_id is null
  and profile_id is null
);

drop policy if exists "chat_channel_members_insert"
  on public.chat_channel_members;
create policy "chat_channel_members_insert"
on public.chat_channel_members
for insert
with check (
  public.is_valid_chat_channel_member(
    channel_id,
    member_type,
    user_id,
    agent_id
  )
  and public.can_manage_chat_channel_member(
    channel_id,
    member_type,
    user_id
  )
);

drop policy if exists "chat_channel_members_delete"
  on public.chat_channel_members;
create policy "chat_channel_members_delete"
on public.chat_channel_members
for delete
using (
  (member_type = 'user' and user_id = auth.uid())
  or public.can_manage_chat_channel_member(
    channel_id,
    member_type,
    user_id
  )
);
