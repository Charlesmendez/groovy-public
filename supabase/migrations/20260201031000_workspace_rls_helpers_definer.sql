-- Avoid RLS recursion when checking workspace membership
create or replace function public.is_workspace_member(w_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = w_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_admin(w_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
set row_security = off
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = w_id and user_id = auth.uid() and role = 'admin'
  );
$$;
