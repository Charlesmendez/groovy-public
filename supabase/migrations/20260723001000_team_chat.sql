-- Workspace team chat: channels/DMs where humans, harness profiles, and
-- worker agents coexist. Human writes use the cookie-auth client and RLS;
-- orchestrator/agent/system writes are service-role only.

create table if not exists public.chat_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null default 'channel' check (kind in ('channel', 'dm')),
  name text not null,
  slug text not null,
  topic text,
  -- A channel binding is an authorization boundary. Require an explicit
  -- rebind before deleting the profile rather than silently widening the
  -- channel to the workspace/default operator profile.
  profile_id uuid references public.orchestrator_profiles(id) on delete restrict,
  orchestrator_mode text not null default 'mention'
    check (orchestrator_mode in ('mention', 'always', 'off')),
  is_archived boolean not null default false,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create index if not exists chat_channels_workspace_idx
  on public.chat_channels(workspace_id, is_archived, updated_at desc);

create table if not exists public.chat_channel_members (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.chat_channels(id) on delete cascade,
  member_type text not null check (member_type in ('user', 'agent', 'orchestrator')),
  user_id uuid references auth.users(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (
    (member_type = 'user' and user_id is not null and agent_id is null)
    or (member_type = 'agent' and agent_id is not null and user_id is null)
    or (member_type = 'orchestrator' and user_id is null and agent_id is null)
  )
);

create unique index if not exists chat_channel_members_user_idx
  on public.chat_channel_members(channel_id, user_id)
  where member_type = 'user';
create unique index if not exists chat_channel_members_agent_idx
  on public.chat_channel_members(channel_id, agent_id)
  where member_type = 'agent';
create unique index if not exists chat_channel_members_orchestrator_idx
  on public.chat_channel_members(channel_id)
  where member_type = 'orchestrator';

-- `chat_messages` already stores the legacy Files/AI chat sessions. Extend it
-- as a tagged union instead of relying on CREATE TABLE IF NOT EXISTS (which
-- would leave upgraded databases without any of the team-chat columns).
alter table public.chat_messages
  add column if not exists channel_id uuid
    references public.chat_channels(id) on delete cascade,
  add column if not exists author_type text,
  add column if not exists author_user_id uuid
    references auth.users(id) on delete set null,
  add column if not exists author_agent_id uuid
    references public.agents(id) on delete set null,
  add column if not exists profile_id uuid
    references public.orchestrator_profiles(id) on delete set null,
  add column if not exists reply_to_message_id uuid
    references public.chat_messages(id) on delete set null;

-- Team-chat rows do not have a legacy user/session/role tuple. Legacy rows keep
-- all three populated and continue to be protected by their existing policies.
alter table public.chat_messages
  alter column user_id drop not null,
  alter column session_id drop not null,
  alter column role drop not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.chat_messages'::regclass
      and conname = 'chat_messages_team_shape_check'
  ) then
    alter table public.chat_messages
      add constraint chat_messages_team_shape_check check (
        (
          channel_id is null
          and author_type is null
          and author_user_id is null
          and author_agent_id is null
          and reply_to_message_id is null
          and user_id is not null
          and session_id is not null
          and role is not null
        )
        or
        (
          channel_id is not null
          and user_id is null
          and session_id is null
          and role is null
          and char_length(content) between 1 and 40000
          and (
            (
              author_type = 'user'
              and author_user_id is not null
              and author_agent_id is null
            )
            or (
              author_type = 'agent'
              and author_agent_id is not null
              and author_user_id is null
            )
            or (
              author_type in ('orchestrator', 'system')
              and author_user_id is null
              and author_agent_id is null
            )
          )
        )
      );
  end if;
end $$;

create index if not exists chat_messages_channel_idx
  on public.chat_messages(channel_id, created_at);

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
    from public.chat_channel_members
    where channel_id = c_id
      and member_type = 'user'
      and user_id = auth.uid()
  );
$$;

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
        (c.kind = 'channel' and public.is_workspace_member(c.workspace_id))
        or public.is_channel_member(c.id)
      )
  );
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
        c.created_by = auth.uid()
        or public.is_workspace_admin(c.workspace_id)
      )
  );
$$;

create or replace function public.is_valid_chat_channel_member(
  c_id uuid,
  m_type text,
  m_user_id uuid,
  m_agent_id uuid
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
    from public.chat_channels c
    join public.workspaces w on w.id = c.workspace_id
    where c.id = c_id
      and (
        (
          m_type = 'user'
          and m_user_id is not null
          and exists (
            select 1 from public.workspace_members wm
            where wm.workspace_id = c.workspace_id
              and wm.user_id = m_user_id
          )
        )
        or (
          m_type = 'agent'
          and m_agent_id is not null
          and exists (
            select 1 from public.agents a
            where a.id = m_agent_id
              and a.user_id = w.billing_admin_user_id
          )
        )
        or (m_type = 'orchestrator' and m_user_id is null and m_agent_id is null)
      )
  );
$$;

create or replace function public.is_valid_chat_channel_profile(
  p_workspace_id uuid,
  p_profile_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select
    p_profile_id is null
    or exists (
      select 1
      from public.orchestrator_profiles p
      where p.id = p_profile_id
        and p.workspace_id = p_workspace_id
    );
$$;

alter table public.chat_channels enable row level security;
alter table public.chat_channel_members enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "chat_channels_select" on public.chat_channels;
create policy "chat_channels_select" on public.chat_channels
  for select using (
    (kind = 'channel' and public.is_workspace_member(workspace_id))
    or public.is_channel_member(id)
  );

drop policy if exists "chat_channels_insert" on public.chat_channels;
create policy "chat_channels_insert" on public.chat_channels
  for insert with check (
    public.is_workspace_member(workspace_id)
    and created_by = auth.uid()
    and public.is_valid_chat_channel_profile(workspace_id, profile_id)
  );

drop policy if exists "chat_channels_update" on public.chat_channels;
create policy "chat_channels_update" on public.chat_channels
  for update using (
    public.is_workspace_admin(workspace_id) or created_by = auth.uid()
  ) with check (
    public.is_workspace_member(workspace_id)
    and (public.is_workspace_admin(workspace_id) or created_by = auth.uid())
    and public.is_valid_chat_channel_profile(workspace_id, profile_id)
  );

drop policy if exists "chat_channels_delete" on public.chat_channels;
create policy "chat_channels_delete" on public.chat_channels
  for delete using (
    public.is_workspace_admin(workspace_id) or created_by = auth.uid()
  );

drop policy if exists "chat_channel_members_select" on public.chat_channel_members;
create policy "chat_channel_members_select" on public.chat_channel_members
  for select using (public.can_read_chat_channel(channel_id));

drop policy if exists "chat_channel_members_insert" on public.chat_channel_members;
create policy "chat_channel_members_insert" on public.chat_channel_members
  for insert with check (
    public.is_valid_chat_channel_member(channel_id, member_type, user_id, agent_id)
    and public.can_manage_chat_channel(channel_id)
  );

drop policy if exists "chat_channel_members_delete" on public.chat_channel_members;
create policy "chat_channel_members_delete" on public.chat_channel_members
  for delete using (
    (member_type = 'user' and user_id = auth.uid())
    or public.can_manage_chat_channel(channel_id)
  );

drop policy if exists "chat_messages_select" on public.chat_messages;
create policy "chat_messages_select" on public.chat_messages
  for select using (public.can_read_chat_channel(channel_id));

drop policy if exists "chat_messages_insert_user" on public.chat_messages;
create policy "chat_messages_insert_user" on public.chat_messages
  for insert with check (
    public.is_channel_member(channel_id)
    and author_type = 'user'
    and author_user_id = auth.uid()
    and author_agent_id is null
    and profile_id is null
  );

do $$
begin
  alter publication supabase_realtime add table public.chat_messages;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.chat_channels;
exception
  when duplicate_object then null;
end $$;
