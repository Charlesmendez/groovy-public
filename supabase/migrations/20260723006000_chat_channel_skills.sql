-- Channel-scoped skills and instruction documents.
--
-- These assignments are additive to the selected Mind's capabilities. The
-- application runtime deliberately excludes them whenever a channel contains
-- workspace guests, so internal Markdown cannot cross that trust boundary.

create table if not exists public.chat_channel_skill_assignments (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null
    references public.chat_channels(id) on delete cascade,
  workspace_id uuid not null
    references public.workspaces(id) on delete cascade,
  artifact_id uuid not null
    references public.workspace_skill_artifacts(id) on delete cascade,
  added_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint chat_channel_skill_assignments_unique
    unique (channel_id, artifact_id)
);

create index if not exists chat_channel_skill_assignments_workspace_idx
  on public.chat_channel_skill_assignments(workspace_id, channel_id);

create index if not exists chat_channel_skill_assignments_artifact_idx
  on public.chat_channel_skill_assignments(artifact_id);

create or replace function public.is_valid_chat_channel_skill_assignment(
  p_channel_id uuid,
  p_workspace_id uuid,
  p_artifact_id uuid
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
    from public.chat_channels channel
    join public.workspace_skill_artifacts artifact
      on artifact.id = p_artifact_id
     and artifact.workspace_id = channel.workspace_id
    where channel.id = p_channel_id
      and channel.workspace_id = p_workspace_id
      and channel.kind = 'channel'
      and channel.is_archived = false
      and artifact.lifecycle = 'active'
      and (
        artifact.targets = '[]'::jsonb
        or
        artifact.targets @> '["all"]'::jsonb
        or artifact.targets @> '["flow"]'::jsonb
      )
  );
$$;

alter table public.chat_channel_skill_assignments enable row level security;

drop policy if exists "chat_channel_skills_select"
  on public.chat_channel_skill_assignments;
create policy "chat_channel_skills_select"
on public.chat_channel_skill_assignments
for select
using (
  public.is_workspace_member(workspace_id)
  and public.can_read_chat_channel(channel_id)
);

drop policy if exists "chat_channel_skills_insert"
  on public.chat_channel_skill_assignments;
create policy "chat_channel_skills_insert"
on public.chat_channel_skill_assignments
for insert
with check (
  added_by = auth.uid()
  and public.is_workspace_member(workspace_id)
  and public.can_manage_chat_channel(channel_id)
  and public.is_valid_chat_channel_skill_assignment(
    channel_id,
    workspace_id,
    artifact_id
  )
);

drop policy if exists "chat_channel_skills_delete"
  on public.chat_channel_skill_assignments;
create policy "chat_channel_skills_delete"
on public.chat_channel_skill_assignments
for delete
using (
  public.is_workspace_member(workspace_id)
  and public.can_manage_chat_channel(channel_id)
);
