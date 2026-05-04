-- Billing addons: Stripe subscription state for recurring workspace charges.
alter table public.workspaces
  add column if not exists stripe_subscription_id text null,
  add column if not exists stripe_subscription_status text null,
  add column if not exists stripe_item_groovy_mac_id text null,
  add column if not exists stripe_item_kapso_allowlist_id text null,
  add column if not exists billing_groovy_mac_enabled boolean not null default false,
  add column if not exists billing_kapso_enabled boolean not null default false,
  add column if not exists billing_addons_updated_at timestamptz not null default now();

create index if not exists idx_workspaces_stripe_subscription_id
  on public.workspaces (stripe_subscription_id);
