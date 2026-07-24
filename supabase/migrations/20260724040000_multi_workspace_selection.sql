-- A user may own a personal workspace and participate in any number of shared
-- workspaces. The selected workspace is a user preference, never a client-
-- supplied authorization boundary: APIs must still validate membership.
alter table public.user_preferences
  add column if not exists active_workspace_id uuid null
    references public.workspaces(id) on delete set null;

create index if not exists user_preferences_active_workspace_idx
  on public.user_preferences(active_workspace_id)
  where active_workspace_id is not null;

comment on column public.user_preferences.active_workspace_id is
  'The workspace currently selected by this user. Server code validates a current workspace_members row before using it.';
