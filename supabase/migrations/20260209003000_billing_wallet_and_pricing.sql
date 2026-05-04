-- Billing wallet + transparent pricing split (model cost + Groovy fee)
create extension if not exists "pgcrypto";

alter table public.workspaces
  add column if not exists stripe_default_payment_method_id text null,
  add column if not exists billing_currency text not null default 'usd',
  add column if not exists billing_free_credit_usd_remaining numeric(12,6) not null default 20,
  add column if not exists billing_paid_credit_usd_balance numeric(12,6) not null default 0,
  add column if not exists billing_initial_topup_completed boolean not null default false,
  add column if not exists billing_auto_topup_enabled boolean not null default true,
  add column if not exists billing_auto_topup_amount_usd numeric(12,2) not null default 10,
  add column if not exists billing_monthly_limit_usd numeric(12,2) null,
  add column if not exists billing_updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspaces_billing_currency_check'
  ) then
    alter table public.workspaces
      add constraint workspaces_billing_currency_check
      check (billing_currency = 'usd');
  end if;
end $$;

create index if not exists idx_workspaces_stripe_default_payment_method_id
  on public.workspaces (stripe_default_payment_method_id);

alter table public.billing_usage_events
  add column if not exists model_cost_usd numeric(12,6) null,
  add column if not exists groovy_fee_usd numeric(12,6) null,
  add column if not exists total_charge_usd numeric(12,6) null,
  add column if not exists fee_rate_bps integer not null default 1000;

create table if not exists public.billing_wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid null references auth.users (id) on delete set null,
  kind text not null check (
    kind in (
      'free_grant',
      'usage_debit',
      'manual_topup',
      'auto_topup',
      'adjustment',
      'reversal'
    )
  ),
  -- Positive for credit movements (topups), negative for debits.
  amount_usd numeric(12,6) not null,
  model_cost_usd numeric(12,6) null,
  groovy_fee_usd numeric(12,6) null,
  total_charge_usd numeric(12,6) null,
  fee_rate_bps integer not null default 1000,
  stripe_invoice_id text null,
  stripe_payment_intent_id text null,
  stripe_invoice_status text null,
  trace_id text null,
  turn_id text null,
  source text null,
  span_id text not null default 'main',
  idempotency_key text null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_billing_wallet_ledger_workspace_created
  on public.billing_wallet_ledger (workspace_id, created_at desc);

create unique index if not exists uniq_billing_wallet_ledger_idempotency_key
  on public.billing_wallet_ledger (idempotency_key)
  where idempotency_key is not null;

create unique index if not exists uniq_billing_wallet_ledger_usage_event
  on public.billing_wallet_ledger (workspace_id, trace_id, source, span_id, kind)
  where kind = 'usage_debit' and trace_id is not null and source is not null;

alter table public.billing_wallet_ledger enable row level security;

drop policy if exists "billing_wallet_ledger_select_member" on public.billing_wallet_ledger;
create policy "billing_wallet_ledger_select_member"
on public.billing_wallet_ledger for select
using (public.is_workspace_member(workspace_id));
