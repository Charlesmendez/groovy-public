create or replace function public.record_workspace_topup_credit_atomic(
  p_workspace_id uuid,
  p_user_id uuid,
  p_kind text,
  p_amount_usd numeric,
  p_model_cost_usd numeric,
  p_groovy_fee_usd numeric,
  p_fee_rate_bps integer,
  p_stripe_invoice_id text,
  p_stripe_payment_intent_id text,
  p_stripe_invoice_status text,
  p_source text,
  p_idempotency_key text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted_id uuid;
begin
  if p_amount_usd <= 0 then
    raise exception 'Topup amount must be positive';
  end if;

  perform 1
  from public.workspaces
  where id = p_workspace_id
  for update;

  if not found then
    raise exception 'Workspace not found';
  end if;

  insert into public.billing_wallet_ledger (
    workspace_id,
    user_id,
    kind,
    amount_usd,
    model_cost_usd,
    groovy_fee_usd,
    total_charge_usd,
    fee_rate_bps,
    stripe_invoice_id,
    stripe_payment_intent_id,
    stripe_invoice_status,
    source,
    idempotency_key,
    meta
  )
  values (
    p_workspace_id,
    p_user_id,
    p_kind,
    round(p_amount_usd, 6),
    round(coalesce(p_model_cost_usd, 0), 6),
    round(coalesce(p_groovy_fee_usd, 0), 6),
    round(p_amount_usd, 6),
    coalesce(p_fee_rate_bps, 0),
    p_stripe_invoice_id,
    p_stripe_payment_intent_id,
    p_stripe_invoice_status,
    p_source,
    p_idempotency_key,
    jsonb_build_object('topup_kind', p_kind, 'source', p_source)
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_inserted_id;

  if v_inserted_id is null then
    return;
  end if;

  update public.workspaces
  set
    billing_paid_credit_usd_balance = round(coalesce(billing_paid_credit_usd_balance, 0) + p_amount_usd, 6),
    billing_initial_topup_completed = true,
    billing_updated_at = now()
  where id = p_workspace_id;
end;
$$;

create or replace function public.settle_workspace_usage_debit_atomic(
  p_workspace_id uuid,
  p_user_id uuid,
  p_trace_id text,
  p_turn_id text,
  p_source text,
  p_span_id text,
  p_amount_usd numeric,
  p_model_cost_usd numeric,
  p_groovy_fee_usd numeric,
  p_fee_rate_bps integer,
  p_charge_type text,
  p_meta jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_free numeric(12,6);
  v_paid numeric(12,6);
  v_remaining numeric(12,6);
  v_free_used numeric(12,6);
  v_inserted_id uuid;
begin
  if p_amount_usd <= 0 then
    return null;
  end if;

  select
    billing_free_credit_usd_remaining,
    billing_paid_credit_usd_balance
  into v_free, v_paid
  from public.workspaces
  where id = p_workspace_id
  for update;

  if not found then
    return null;
  end if;

  if exists (
    select 1
    from public.billing_wallet_ledger
    where workspace_id = p_workspace_id
      and trace_id = p_trace_id
      and source = p_source
      and span_id = coalesce(p_span_id, 'main')
      and kind = 'usage_debit'
  ) then
    return jsonb_build_object('inserted', false, 'free', v_free, 'paid', v_paid);
  end if;

  v_remaining := round(p_amount_usd, 6);
  v_free_used := least(coalesce(v_free, 0), v_remaining);
  v_free := round(coalesce(v_free, 0) - v_free_used, 6);
  v_remaining := round(v_remaining - v_free_used, 6);
  v_paid := round(coalesce(v_paid, 0) - v_remaining, 6);

  insert into public.billing_wallet_ledger (
    workspace_id,
    user_id,
    kind,
    amount_usd,
    model_cost_usd,
    groovy_fee_usd,
    total_charge_usd,
    fee_rate_bps,
    charge_type,
    trace_id,
    turn_id,
    source,
    span_id,
    idempotency_key,
    meta
  )
  values (
    p_workspace_id,
    p_user_id,
    'usage_debit',
    -round(p_amount_usd, 6),
    round(coalesce(p_model_cost_usd, 0), 6),
    round(coalesce(p_groovy_fee_usd, 0), 6),
    round(p_amount_usd, 6),
    coalesce(p_fee_rate_bps, 0),
    p_charge_type,
    p_trace_id,
    p_turn_id,
    p_source,
    coalesce(p_span_id, 'main'),
    'wallet:usage:' || p_workspace_id::text || ':' || coalesce(p_trace_id, '') || ':' || coalesce(p_source, '') || ':' || coalesce(p_span_id, 'main'),
    coalesce(p_meta, '{}'::jsonb)
  )
  on conflict (workspace_id, trace_id, source, span_id, kind) where kind = 'usage_debit' and trace_id is not null and source is not null do nothing
  returning id into v_inserted_id;

  if v_inserted_id is null then
    return jsonb_build_object('inserted', false, 'free', v_free, 'paid', v_paid);
  end if;

  update public.workspaces
  set
    billing_free_credit_usd_remaining = v_free,
    billing_paid_credit_usd_balance = v_paid,
    billing_updated_at = now()
  where id = p_workspace_id;

  return jsonb_build_object('inserted', true, 'free', v_free, 'paid', v_paid);
end;
$$;

grant execute on function public.record_workspace_topup_credit_atomic(
  uuid, uuid, text, numeric, numeric, numeric, integer, text, text, text, text, text
) to service_role;

grant execute on function public.settle_workspace_usage_debit_atomic(
  uuid, uuid, text, text, text, text, numeric, numeric, numeric, integer, text, jsonb
) to service_role;
