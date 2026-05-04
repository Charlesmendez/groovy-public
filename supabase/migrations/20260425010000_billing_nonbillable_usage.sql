-- Track how measured usage is charged.
-- Groovy-key rows charge model pass-through + 20% fee.
-- External-key/local-login rows charge only the 20% Groovy fee, using provider
-- model pricing as the cost basis.

alter table public.billing_usage_events
  add column if not exists billable boolean not null default true,
  add column if not exists charge_type text not null default 'groovy_key';

update public.billing_usage_events
set charge_type = case when billable is false then 'no_charge' else 'groovy_key' end
where charge_type is null or charge_type not in ('groovy_key', 'external_key_fee', 'no_charge');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'billing_usage_events_charge_type_check'
      and conrelid = 'public.billing_usage_events'::regclass
  ) then
    alter table public.billing_usage_events
      add constraint billing_usage_events_charge_type_check
      check (charge_type in ('groovy_key', 'external_key_fee', 'no_charge'));
  end if;
end $$;

alter table public.billing_wallet_ledger
  add column if not exists charge_type text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'billing_wallet_ledger_charge_type_check'
      and conrelid = 'public.billing_wallet_ledger'::regclass
  ) then
    alter table public.billing_wallet_ledger
      add constraint billing_wallet_ledger_charge_type_check
      check (
        charge_type is null
        or charge_type in ('groovy_key', 'external_key_fee', 'no_charge')
      );
  end if;
end $$;

create index if not exists idx_billing_usage_events_workspace_billable_unsent
on public.billing_usage_events (workspace_id, stripe_sent_at, created_at)
where billable is true and stripe_sent_at is null;

create index if not exists idx_billing_usage_events_workspace_charge_type_created
on public.billing_usage_events (workspace_id, charge_type, created_at desc);

create index if not exists idx_billing_wallet_ledger_workspace_charge_type_created
on public.billing_wallet_ledger (workspace_id, charge_type, created_at desc);

alter table public.billing_usage_events
  alter column fee_rate_bps set default 2000;

alter table public.billing_wallet_ledger
  alter column fee_rate_bps set default 2000;
