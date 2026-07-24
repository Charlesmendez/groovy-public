-- A channel's worker roster is an execution authorization boundary. Channel
-- creators may still manage ordinary members, but only workspace admins may
-- add or remove worker agents. API checks mirror this policy; RLS is the final
-- boundary for direct PostgREST clients.
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
      m_type <> 'agent'
      or exists (
        select 1
        from public.chat_channels c
        where c.id = c_id
          and public.is_workspace_admin(c.workspace_id)
      )
    )
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
