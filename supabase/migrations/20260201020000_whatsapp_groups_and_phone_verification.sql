-- WhatsApp group claims + phone verification
create table if not exists public.workspace_whatsapp_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider text not null default 'whatsapp_web',
  group_name text not null,
  group_id text null,
  created_by_user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider, group_name)
);

alter table public.workspace_whatsapp_groups enable row level security;

drop policy if exists "workspace_whatsapp_groups_select_member" on public.workspace_whatsapp_groups;
create policy "workspace_whatsapp_groups_select_member"
on public.workspace_whatsapp_groups for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_whatsapp_groups_insert_admin" on public.workspace_whatsapp_groups;
create policy "workspace_whatsapp_groups_insert_admin"
on public.workspace_whatsapp_groups for insert
with check (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_whatsapp_groups_delete_admin" on public.workspace_whatsapp_groups;
create policy "workspace_whatsapp_groups_delete_admin"
on public.workspace_whatsapp_groups for delete
using (public.is_workspace_admin(workspace_id));

alter table public.workspace_member_phones
  add column if not exists verification_code text null;
