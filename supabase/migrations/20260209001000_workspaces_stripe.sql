-- Stripe billing metadata for workspaces

alter table public.workspaces
  add column if not exists stripe_customer_id text null;

create index if not exists idx_workspaces_stripe_customer_id
  on public.workspaces (stripe_customer_id);

