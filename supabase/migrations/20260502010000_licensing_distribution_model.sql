-- Groovy source-available licensing and distribution model.
create extension if not exists "pgcrypto";

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'personal'
    check (type in ('personal', 'enterprise', 'enterprise_reseller')),
  owner_user_id uuid null references auth.users (id) on delete set null,
  workspace_id uuid null references public.workspaces (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists organizations_workspace_id_unique
on public.organizations (workspace_id)
where workspace_id is not null;

create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations (id) on delete cascade,
  workspace_id uuid null references public.workspaces (id) on delete cascade,
  user_id uuid null references auth.users (id) on delete set null,
  license_type text not null
    check (license_type in ('personal', 'enterprise', 'enterprise_reseller')),
  status text not null default 'active'
    check (status in ('active', 'past_due', 'expired', 'canceled', 'suspended', 'terminated')),
  customer_email text null,
  customer_name text null,
  license_key_hash text not null unique,
  license_key_enc text null,
  signed_license_payload jsonb not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  fallback_allowed boolean not null default false,
  max_devices integer null,
  max_users integer null,
  max_agents integer null,
  max_environments integer null,
  production_environments integer null,
  production_agents integer null,
  reseller_billing_enabled boolean not null default false,
  token_consumption_billing_enabled boolean not null default false,
  features text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists licenses_workspace_status_idx
on public.licenses (workspace_id, status, valid_until desc);

create index if not exists licenses_org_status_idx
on public.licenses (organization_id, status, valid_until desc);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations (id) on delete cascade,
  license_id uuid null references public.licenses (id) on delete set null,
  workspace_id uuid null references public.workspaces (id) on delete cascade,
  stripe_customer_id text null,
  stripe_subscription_id text null unique,
  stripe_price_id text null,
  status text not null default 'incomplete',
  current_period_start timestamptz null,
  current_period_end timestamptz null,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.license_devices (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.licenses (id) on delete cascade,
  device_hash text not null,
  device_name text null,
  platform text null,
  app_version text null,
  activation_token_hash text null,
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  deactivated_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists license_devices_license_active_idx
on public.license_devices (license_id, deactivated_at, last_seen_at desc);

create unique index if not exists license_devices_active_device_unique
on public.license_devices (license_id, device_hash)
where deactivated_at is null;

create table if not exists public.downloads (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  channel text not null default 'stable'
    check (channel in ('stable', 'beta', 'dev', 'enterprise')),
  platform text not null,
  file_url text not null,
  checksum text null,
  release_notes_url text null,
  license_type_allowed text[] not null default array['personal','enterprise','enterprise_reseller'],
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  channel text not null default 'stable'
    check (channel in ('stable', 'beta', 'dev', 'enterprise')),
  git_ref text null,
  archive_url text not null,
  checksum text null,
  release_notes_url text null,
  license_type_allowed text[] not null default array['personal','enterprise','enterprise_reseller'],
  public_mirror_after timestamptz null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.download_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations (id) on delete set null,
  license_id uuid null references public.licenses (id) on delete set null,
  user_id uuid null references auth.users (id) on delete set null,
  download_id uuid null references public.downloads (id) on delete set null,
  source_snapshot_id uuid null references public.source_snapshots (id) on delete set null,
  ip_hash text null,
  user_agent_hash text null,
  created_at timestamptz not null default now()
);

create table if not exists public.license_checks (
  id uuid primary key default gen_random_uuid(),
  license_id uuid null references public.licenses (id) on delete set null,
  device_id uuid null references public.license_devices (id) on delete set null,
  app_version text null,
  ip_hash text null,
  checked_at timestamptz not null default now(),
  result text not null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.enterprise_contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  license_id uuid null references public.licenses (id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'expired', 'terminated')),
  contract_start timestamptz null,
  contract_end timestamptz null,
  source_access_included boolean not null default false,
  support_tier text null,
  reseller_authorized boolean not null default false,
  terms_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations (id) on delete cascade,
  license_id uuid null references public.licenses (id) on delete set null,
  workspace_id uuid null references public.workspaces (id) on delete cascade,
  report_type text not null default 'enterprise_true_up',
  period_start timestamptz null,
  period_end timestamptz null,
  payload jsonb not null default '{}'::jsonb,
  created_by_user_id uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.provider_usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations (id) on delete cascade,
  workspace_id uuid null references public.workspaces (id) on delete cascade,
  provider text null,
  model text null,
  input_tokens integer null,
  output_tokens integer null,
  total_tokens integer null,
  estimated_cost numeric(12, 6) null,
  agent_id uuid null,
  workflow_id uuid null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.reseller_customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  external_customer_id text not null,
  name text null,
  status text not null default 'active'
    check (status in ('active', 'inactive', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_customer_id)
);

create table if not exists public.reseller_billing_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  enabled boolean not null default false,
  markup_type text not null default 'percent'
    check (markup_type in ('percent', 'fixed', 'none')),
  markup_value numeric(12, 6) not null default 0,
  billing_currency text not null default 'usd',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

create table if not exists public.reseller_billing_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  reseller_customer_id uuid null references public.reseller_customers (id) on delete set null,
  provider_usage_event_id uuid null references public.provider_usage_events (id) on delete set null,
  base_cost numeric(12, 6) not null default 0,
  markup_amount numeric(12, 6) not null default 0,
  billable_amount numeric(12, 6) not null default 0,
  export_status text not null default 'pending'
    check (export_status in ('pending', 'exported', 'failed', 'ignored')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.license_admin_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid null references auth.users (id) on delete set null,
  organization_id uuid null references public.organizations (id) on delete set null,
  license_id uuid null references public.licenses (id) on delete set null,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.security_advisories (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  severity text not null default 'medium'
    check (severity in ('low', 'medium', 'high', 'critical')),
  affected_versions text[] not null default '{}',
  patched_versions text[] not null default '{}',
  summary text not null,
  advisory_url text null,
  published_at timestamptz not null default now(),
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.organizations enable row level security;
alter table public.licenses enable row level security;
alter table public.subscriptions enable row level security;
alter table public.license_devices enable row level security;
alter table public.downloads enable row level security;
alter table public.source_snapshots enable row level security;
alter table public.download_events enable row level security;
alter table public.license_checks enable row level security;
alter table public.enterprise_contracts enable row level security;
alter table public.usage_reports enable row level security;
alter table public.provider_usage_events enable row level security;
alter table public.reseller_customers enable row level security;
alter table public.reseller_billing_settings enable row level security;
alter table public.reseller_billing_events enable row level security;
alter table public.license_admin_audit_events enable row level security;
alter table public.security_advisories enable row level security;

drop policy if exists "organizations_select_workspace_member" on public.organizations;
create policy "organizations_select_workspace_member"
on public.organizations for select
using (
  owner_user_id = auth.uid()
  or (workspace_id is not null and public.is_workspace_member(workspace_id))
);

drop policy if exists "licenses_select_workspace_member" on public.licenses;
drop policy if exists "licenses_select_owner_or_workspace_admin" on public.licenses;
create policy "licenses_select_owner_or_workspace_admin"
on public.licenses for select
using (
  user_id = auth.uid()
  or (workspace_id is not null and public.is_workspace_admin(workspace_id))
);

drop policy if exists "subscriptions_select_workspace_admin" on public.subscriptions;
create policy "subscriptions_select_workspace_admin"
on public.subscriptions for select
using (workspace_id is not null and public.is_workspace_admin(workspace_id));

drop policy if exists "license_devices_select_workspace_member" on public.license_devices;
drop policy if exists "license_devices_select_owner_or_workspace_admin" on public.license_devices;
create policy "license_devices_select_owner_or_workspace_admin"
on public.license_devices for select
using (
  exists (
    select 1 from public.licenses l
    where l.id = license_id
      and (
        l.user_id = auth.uid()
        or (l.workspace_id is not null and public.is_workspace_admin(l.workspace_id))
      )
  )
);

drop policy if exists "downloads_select_authenticated" on public.downloads;

drop policy if exists "source_snapshots_select_authenticated" on public.source_snapshots;

drop policy if exists "enterprise_contracts_select_workspace_admin" on public.enterprise_contracts;
create policy "enterprise_contracts_select_workspace_admin"
on public.enterprise_contracts for select
using (
  exists (
    select 1
    from public.organizations o
    where o.id = organization_id
      and o.workspace_id is not null
      and public.is_workspace_admin(o.workspace_id)
  )
);

drop policy if exists "security_advisories_select_public" on public.security_advisories;
create policy "security_advisories_select_public"
on public.security_advisories for select
using (is_public = true);
