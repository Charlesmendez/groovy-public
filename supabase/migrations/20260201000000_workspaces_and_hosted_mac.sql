-- Teams/workspaces + hosted Mac provisioning + WhatsApp modes
create extension if not exists "pgcrypto";

-- ============
-- Workspaces
-- ============
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  billing_admin_user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null,
  token text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ====================
-- Hosted Mac requests
-- ====================
create table if not exists public.hosted_mac_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  requested_by_user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'requested',
  status_detail text null,
  error text null,
  requested_provider text null,
  requested_region text null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hosted_mac_assignments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.hosted_mac_requests (id) on delete cascade,
  provider text not null,
  hostname text not null,
  ssh_port int not null default 22,
  ssh_user text not null,
  ssh_private_key_enc text null,
  ssh_password_enc text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hosted_devices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  request_id uuid not null references public.hosted_mac_requests (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (workspace_id, device_id)
);

-- ===================
-- Workspace WhatsApp
-- ===================
-- Member phone linking (used for Personal WhatsApp author mapping and DM allowlists)
create table if not exists public.workspace_member_phones (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  phone_e164 text not null,
  verified_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  unique (workspace_id, phone_e164)
);

-- Company WhatsApp via Kapso (per workspace)
create table if not exists public.workspace_company_whatsapp (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  status text not null default 'pending',
  kapso_phone_number_id text null,
  webhook_secret text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Allowlist for Kapso DMs (optional mapping to user_id)
create table if not exists public.workspace_whatsapp_allowlist (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  phone_e164 text not null,
  user_id uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  created_by_user_id uuid not null references auth.users (id) on delete cascade,
  primary key (workspace_id, phone_e164)
);

-- ============
-- RLS helpers
-- ============
create or replace function public.is_workspace_member(w_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = w_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_admin(w_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = w_id and user_id = auth.uid() and role = 'admin'
  );
$$;

-- ============
-- RLS policies
-- ============
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.hosted_mac_requests enable row level security;
alter table public.hosted_mac_assignments enable row level security;
alter table public.hosted_devices enable row level security;
alter table public.workspace_member_phones enable row level security;
alter table public.workspace_company_whatsapp enable row level security;
alter table public.workspace_whatsapp_allowlist enable row level security;

-- Workspaces
drop policy if exists "workspaces_select_member" on public.workspaces;
create policy "workspaces_select_member"
on public.workspaces for select
using (public.is_workspace_member(id));

drop policy if exists "workspaces_insert_admin" on public.workspaces;
create policy "workspaces_insert_admin"
on public.workspaces for insert
with check (auth.uid() = billing_admin_user_id);

drop policy if exists "workspaces_update_admin" on public.workspaces;
create policy "workspaces_update_admin"
on public.workspaces for update
using (public.is_workspace_admin(id))
with check (public.is_workspace_admin(id));

-- Workspace members
drop policy if exists "workspace_members_select_member" on public.workspace_members;
create policy "workspace_members_select_member"
on public.workspace_members for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_members_insert_admin" on public.workspace_members;
create policy "workspace_members_insert_admin"
on public.workspace_members for insert
with check (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_members_update_admin" on public.workspace_members;
create policy "workspace_members_update_admin"
on public.workspace_members for update
using (public.is_workspace_admin(workspace_id))
with check (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_members_delete_admin" on public.workspace_members;
create policy "workspace_members_delete_admin"
on public.workspace_members for delete
using (public.is_workspace_admin(workspace_id));

-- Workspace invites (admin-only via API; select allowed for admins)
drop policy if exists "workspace_invites_select_admin" on public.workspace_invites;
create policy "workspace_invites_select_admin"
on public.workspace_invites for select
using (public.is_workspace_admin(workspace_id));

-- Hosted Mac requests
drop policy if exists "hosted_mac_requests_select_member" on public.hosted_mac_requests;
create policy "hosted_mac_requests_select_member"
on public.hosted_mac_requests for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "hosted_mac_requests_insert_admin" on public.hosted_mac_requests;
create policy "hosted_mac_requests_insert_admin"
on public.hosted_mac_requests for insert
with check (public.is_workspace_admin(workspace_id));

drop policy if exists "hosted_mac_requests_update_admin" on public.hosted_mac_requests;
create policy "hosted_mac_requests_update_admin"
on public.hosted_mac_requests for update
using (public.is_workspace_admin(workspace_id))
with check (public.is_workspace_admin(workspace_id));

-- Hosted Mac assignments (admin-only)
drop policy if exists "hosted_mac_assignments_select_admin" on public.hosted_mac_assignments;
create policy "hosted_mac_assignments_select_admin"
on public.hosted_mac_assignments for select
using (exists (
  select 1 from public.hosted_mac_requests r
  where r.id = request_id and public.is_workspace_admin(r.workspace_id)
));

drop policy if exists "hosted_mac_assignments_insert_admin" on public.hosted_mac_assignments;
create policy "hosted_mac_assignments_insert_admin"
on public.hosted_mac_assignments for insert
with check (exists (
  select 1 from public.hosted_mac_requests r
  where r.id = request_id and public.is_workspace_admin(r.workspace_id)
));

drop policy if exists "hosted_mac_assignments_update_admin" on public.hosted_mac_assignments;
create policy "hosted_mac_assignments_update_admin"
on public.hosted_mac_assignments for update
using (exists (
  select 1 from public.hosted_mac_requests r
  where r.id = request_id and public.is_workspace_admin(r.workspace_id)
))
with check (exists (
  select 1 from public.hosted_mac_requests r
  where r.id = request_id and public.is_workspace_admin(r.workspace_id)
));

-- Hosted devices
drop policy if exists "hosted_devices_select_member" on public.hosted_devices;
create policy "hosted_devices_select_member"
on public.hosted_devices for select
using (public.is_workspace_member(workspace_id));

-- Workspace member phones
drop policy if exists "workspace_member_phones_select_member" on public.workspace_member_phones;
create policy "workspace_member_phones_select_member"
on public.workspace_member_phones for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_member_phones_insert_self" on public.workspace_member_phones;
create policy "workspace_member_phones_insert_self"
on public.workspace_member_phones for insert
with check (auth.uid() = user_id and public.is_workspace_member(workspace_id));

drop policy if exists "workspace_member_phones_update_self" on public.workspace_member_phones;
create policy "workspace_member_phones_update_self"
on public.workspace_member_phones for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Company WhatsApp
drop policy if exists "workspace_company_whatsapp_select_member" on public.workspace_company_whatsapp;
create policy "workspace_company_whatsapp_select_member"
on public.workspace_company_whatsapp for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_company_whatsapp_update_admin" on public.workspace_company_whatsapp;
create policy "workspace_company_whatsapp_update_admin"
on public.workspace_company_whatsapp for update
using (public.is_workspace_admin(workspace_id))
with check (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_company_whatsapp_insert_admin" on public.workspace_company_whatsapp;
create policy "workspace_company_whatsapp_insert_admin"
on public.workspace_company_whatsapp for insert
with check (public.is_workspace_admin(workspace_id));

-- Kapso allowlist
drop policy if exists "workspace_whatsapp_allowlist_select_member" on public.workspace_whatsapp_allowlist;
create policy "workspace_whatsapp_allowlist_select_member"
on public.workspace_whatsapp_allowlist for select
using (public.is_workspace_member(workspace_id));

drop policy if exists "workspace_whatsapp_allowlist_insert_admin" on public.workspace_whatsapp_allowlist;
create policy "workspace_whatsapp_allowlist_insert_admin"
on public.workspace_whatsapp_allowlist for insert
with check (public.is_workspace_admin(workspace_id));

drop policy if exists "workspace_whatsapp_allowlist_delete_admin" on public.workspace_whatsapp_allowlist;
create policy "workspace_whatsapp_allowlist_delete_admin"
on public.workspace_whatsapp_allowlist for delete
using (public.is_workspace_admin(workspace_id));
