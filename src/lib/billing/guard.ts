import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  computeUsageChargeBreakdown,
  normalizeUsageChargeType,
  type UsageChargeType,
} from "@/lib/billing/pricing";
import { normalizeTokenUsage } from "@/lib/billing/usage";
import { createAndPayTopupInvoice, type TopupChargeKind } from "@/lib/billing/stripe";
import { getBillingWorkspaceState, getMonthlyUsageSpendUsd } from "@/lib/billing/state";
import {
  coerceChargeTypeForTokenBillingPolicy,
  resolveWorkspaceTokenBillingPolicy,
} from "@/lib/billing/policy";

function toFiniteNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function roundUsd(n: number): number {
  return Math.round((n + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function getMinimumBalanceBeforeRunUsd(): number {
  const v = Number(process.env.BILLING_MIN_BALANCE_BEFORE_RUN_USD || "0.5");
  return Number.isFinite(v) && v > 0 ? v : 0.5;
}

export type BillingBlockReason =
  | "limit_reached"
  | "initial_purchase_required"
  | "insufficient_balance"
  | "card_required"
  | "payment_failed";

export type BillingPreflightResult =
  | {
      allowed: true;
      monthSpendUsd: number;
      availableBalanceUsd: number;
      monthlyLimitUsd: number | null;
    }
  | {
      allowed: false;
      reason: BillingBlockReason;
      message: string;
      monthSpendUsd: number;
      availableBalanceUsd: number;
      monthlyLimitUsd: number | null;
    };

function blockedMessage(reason: BillingBlockReason): string {
  switch (reason) {
    case "limit_reached":
      return "Monthly billing limit reached. Increase your limit to continue using paid Groovy usage.";
    case "initial_purchase_required":
      return "Your free credits are used. Add a card and complete the initial $10 purchase to continue.";
    case "insufficient_balance":
      return "Insufficient balance. Add funds to continue using paid Groovy usage.";
    case "card_required":
      return "Add a payment method first to continue using paid Groovy usage.";
    case "payment_failed":
      return "Automatic charge failed. Update your payment method or add funds manually.";
    default:
      return "Billing blocked this request.";
  }
}

export async function recordWorkspaceTopupCredit(args: {
  workspaceId: string;
  userId: string;
  amountUsd: number;
  modelCostUsd: number;
  groovyFeeUsd: number;
  feeRateBps: number;
  kind: TopupChargeKind;
  source: string;
  stripeInvoiceId: string;
  stripePaymentIntentId: string | null;
  stripeInvoiceStatus: string;
  idempotencyKey: string;
}): Promise<void> {
  const admin = createSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const roundedAmount = roundUsd(args.amountUsd);
  if (!(roundedAmount > 0)) throw new Error("Topup amount must be positive");

  const { data: existing } = await admin
    .from("billing_wallet_ledger")
    .select("id")
    .eq("idempotency_key", args.idempotencyKey)
    .maybeSingle();
  if (existing?.id) return;

  const { data: ws, error: wsErr } = await admin
    .from("workspaces")
    .select("billing_paid_credit_usd_balance")
    .eq("id", args.workspaceId)
    .single();
  if (wsErr || !ws) throw new Error(wsErr?.message || "Workspace not found");

  const currentPaid = toFiniteNumber(
    (ws as Record<string, unknown>).billing_paid_credit_usd_balance,
    0
  );
  const nextPaid = roundUsd(currentPaid + roundedAmount);

  const { error: upErr } = await admin
    .from("workspaces")
    .update({
      billing_paid_credit_usd_balance: nextPaid,
      billing_initial_topup_completed: true,
      billing_updated_at: nowIso,
    })
    .eq("id", args.workspaceId);
  if (upErr) throw new Error(upErr.message);

  const { error: insertErr } = await admin.from("billing_wallet_ledger").insert({
    workspace_id: args.workspaceId,
    user_id: args.userId,
    kind: args.kind,
    amount_usd: roundedAmount,
    model_cost_usd: roundUsd(args.modelCostUsd),
    groovy_fee_usd: roundUsd(args.groovyFeeUsd),
    total_charge_usd: roundedAmount,
    fee_rate_bps: args.feeRateBps,
    stripe_invoice_id: args.stripeInvoiceId,
    stripe_payment_intent_id: args.stripePaymentIntentId,
    stripe_invoice_status: args.stripeInvoiceStatus,
    source: args.source,
    idempotency_key: args.idempotencyKey,
    meta: {
      topup_kind: args.kind,
      source: args.source,
    },
  });

  if (insertErr && !insertErr.message.toLowerCase().includes("duplicate")) {
    throw new Error(insertErr.message);
  }
}

export async function preflightGroovyUsage(args: {
  workspaceId: string;
  userId: string;
  userEmail?: string | null;
  traceId: string;
  source: string;
  minimumRequiredUsd?: number;
}): Promise<BillingPreflightResult> {
  const tokenBillingPolicy = await resolveWorkspaceTokenBillingPolicy({
    workspaceId: args.workspaceId,
  });
  if (!tokenBillingPolicy.tokenConsumptionBillingEnabled) {
    return {
      allowed: true,
      monthSpendUsd: 0,
      availableBalanceUsd: 0,
      monthlyLimitUsd: null,
    };
  }

  const state = await getBillingWorkspaceState({
    workspaceId: args.workspaceId,
    userId: args.userId,
  });
  if (!state) {
    return {
      allowed: true,
      monthSpendUsd: 0,
      availableBalanceUsd: 0,
      monthlyLimitUsd: null,
    };
  }

  const monthSpendUsd = await getMonthlyUsageSpendUsd({
    workspaceId: args.workspaceId,
  }).catch(() => 0);

  if (
    typeof state.monthlyLimitUsd === "number" &&
    state.monthlyLimitUsd > 0 &&
    monthSpendUsd >= state.monthlyLimitUsd
  ) {
    return {
      allowed: false,
      reason: "limit_reached",
      message: blockedMessage("limit_reached"),
      monthSpendUsd,
      availableBalanceUsd: state.availableBalanceUsd,
      monthlyLimitUsd: state.monthlyLimitUsd,
    };
  }

  const minimumRequiredUsd =
    typeof args.minimumRequiredUsd === "number" && args.minimumRequiredUsd > 0
      ? args.minimumRequiredUsd
      : getMinimumBalanceBeforeRunUsd();

  if (
    state.freeCreditUsdRemaining <= 0 &&
    state.paidCreditUsdBalance <= 0 &&
    !state.initialTopupCompleted
  ) {
    return {
      allowed: false,
      reason: "initial_purchase_required",
      message: blockedMessage("initial_purchase_required"),
      monthSpendUsd,
      availableBalanceUsd: state.availableBalanceUsd,
      monthlyLimitUsd: state.monthlyLimitUsd,
    };
  }

  if (state.availableBalanceUsd >= minimumRequiredUsd) {
    return {
      allowed: true,
      monthSpendUsd,
      availableBalanceUsd: state.availableBalanceUsd,
      monthlyLimitUsd: state.monthlyLimitUsd,
    };
  }

  // Monthly limit users must top up manually so they stay in full control.
  if (typeof state.monthlyLimitUsd === "number" && state.monthlyLimitUsd > 0) {
    return {
      allowed: false,
      reason: "insufficient_balance",
      message: blockedMessage("insufficient_balance"),
      monthSpendUsd,
      availableBalanceUsd: state.availableBalanceUsd,
      monthlyLimitUsd: state.monthlyLimitUsd,
    };
  }
  if (!state.autoTopupEnabled) {
    return {
      allowed: false,
      reason: "insufficient_balance",
      message: blockedMessage("insufficient_balance"),
      monthSpendUsd,
      availableBalanceUsd: state.availableBalanceUsd,
      monthlyLimitUsd: state.monthlyLimitUsd,
    };
  }

  const topupAmountUsd =
    state.autoTopupAmountUsd > 0 ? state.autoTopupAmountUsd : 10;
  const idempotencyKey = `wallet:auto_topup:${args.workspaceId}:${args.traceId}`;
  const topup = await createAndPayTopupInvoice({
    workspaceId: args.workspaceId,
    userId: args.userId,
    userEmail: args.userEmail,
    amountUsd: topupAmountUsd,
    kind: "auto_topup",
    idempotencyKey,
    source: args.source,
  });

  if (!topup.ok) {
    const reason: BillingBlockReason =
      topup.reason === "card_required"
        ? "card_required"
        : topup.reason === "payment_failed"
          ? "payment_failed"
          : "payment_failed";
    return {
      allowed: false,
      reason,
      message: blockedMessage(reason),
      monthSpendUsd,
      availableBalanceUsd: state.availableBalanceUsd,
      monthlyLimitUsd: state.monthlyLimitUsd,
    };
  }

  await recordWorkspaceTopupCredit({
    workspaceId: args.workspaceId,
    userId: args.userId,
    amountUsd: topup.amountUsd,
    modelCostUsd: topup.modelCostUsd,
    groovyFeeUsd: topup.groovyFeeUsd,
    feeRateBps: topup.feeRateBps,
    kind: "auto_topup",
    source: args.source,
    stripeInvoiceId: topup.invoiceId,
    stripePaymentIntentId: topup.paymentIntentId,
    stripeInvoiceStatus: topup.invoiceStatus,
    idempotencyKey,
  });

  const refreshedState = await getBillingWorkspaceState({
    workspaceId: args.workspaceId,
    userId: args.userId,
  });
  return {
    allowed: true,
    monthSpendUsd,
    availableBalanceUsd: refreshedState?.availableBalanceUsd ?? state.availableBalanceUsd,
    monthlyLimitUsd: refreshedState?.monthlyLimitUsd ?? state.monthlyLimitUsd,
  };
}

export async function settleGroovyUsageDebitBestEffort(args: {
  workspaceId: string;
  userId: string;
  traceId: string;
  turnId: string;
  source: string;
  spanId?: string;
  model?: string | null;
  usage?: unknown | null;
  modelCostUsdOverride?: number | null;
  chargeType?: UsageChargeType | string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const tokenBillingPolicy = await resolveWorkspaceTokenBillingPolicy({
    workspaceId: args.workspaceId,
  });
  if (!tokenBillingPolicy.tokenConsumptionBillingEnabled) return;

  const normalized = args.usage ? normalizeTokenUsage(args.usage) : null;
  const chargeType = coerceChargeTypeForTokenBillingPolicy({
    requestedChargeType: normalizeUsageChargeType(args.chargeType),
    policy: tokenBillingPolicy,
  });
  if (chargeType === "no_charge") return;
  const breakdown = computeUsageChargeBreakdown({
    model: args.model || null,
    usage: normalized ?? args.usage,
    modelCostUsdOverride: args.modelCostUsdOverride || null,
    chargeType,
  });
  if (!breakdown) return;

  const admin = createSupabaseAdminClient();
  const spanId = args.spanId || "main";
  const { data: existing } = await admin
    .from("billing_wallet_ledger")
    .select("id")
    .eq("workspace_id", args.workspaceId)
    .eq("trace_id", args.traceId)
    .eq("source", args.source)
    .eq("span_id", spanId)
    .eq("kind", "usage_debit")
    .maybeSingle();
  if (existing?.id) return;

  const { data: ws, error: wsErr } = await admin
    .from("workspaces")
    .select("billing_free_credit_usd_remaining, billing_paid_credit_usd_balance")
    .eq("id", args.workspaceId)
    .single();
  if (wsErr || !ws) return;

  let free = roundUsd(
    toFiniteNumber((ws as Record<string, unknown>).billing_free_credit_usd_remaining, 0)
  );
  let paid = roundUsd(
    toFiniteNumber((ws as Record<string, unknown>).billing_paid_credit_usd_balance, 0)
  );

  let remaining = breakdown.totalChargeUsd;
  const freeUsed = Math.min(free, remaining);
  free = roundUsd(free - freeUsed);
  remaining = roundUsd(remaining - freeUsed);
  paid = roundUsd(paid - remaining);

  await admin
    .from("workspaces")
    .update({
      billing_free_credit_usd_remaining: free,
      billing_paid_credit_usd_balance: paid,
      billing_updated_at: new Date().toISOString(),
    })
    .eq("id", args.workspaceId);

  await admin.from("billing_wallet_ledger").insert({
    workspace_id: args.workspaceId,
    user_id: args.userId,
    kind: "usage_debit",
    amount_usd: -breakdown.totalChargeUsd,
    model_cost_usd: breakdown.modelCostUsd,
    groovy_fee_usd: breakdown.groovyFeeUsd,
    total_charge_usd: breakdown.totalChargeUsd,
    fee_rate_bps: breakdown.feeRateBps,
    charge_type: breakdown.chargeType,
    trace_id: args.traceId,
    turn_id: args.turnId,
    source: args.source,
    span_id: spanId,
    idempotency_key: `wallet:usage:${args.workspaceId}:${args.traceId}:${args.source}:${spanId}`,
    meta: {
      ...(args.meta || {}),
      inputTokens: breakdown.inputTokens,
      outputTokens: breakdown.outputTokens,
      totalTokens: breakdown.totalTokens,
      modelPriceKey: breakdown.modelPriceKey,
      chargeType: breakdown.chargeType,
      ...(typeof normalized?.noCacheInputTokens === "number"
        ? { noCacheInputTokens: normalized.noCacheInputTokens }
        : {}),
      ...(typeof normalized?.cacheReadInputTokens === "number"
        ? { cacheReadInputTokens: normalized.cacheReadInputTokens }
        : {}),
      ...(typeof normalized?.cacheWriteInputTokens === "number"
        ? { cacheWriteInputTokens: normalized.cacheWriteInputTokens }
        : {}),
    },
  });

  const availableAfterDebit = roundUsd(free + paid);
  const minimumBalanceBeforeRunUsd = getMinimumBalanceBeforeRunUsd();
  if (availableAfterDebit >= minimumBalanceBeforeRunUsd) return;

  const postDebitTraceId = `postdebit:${args.workspaceId}:${args.traceId}:${args.source}:${spanId}`;
  try {
    const refill = await preflightGroovyUsage({
      workspaceId: args.workspaceId,
      userId: args.userId,
      traceId: postDebitTraceId,
      source: `${args.source}_post_debit`,
      minimumRequiredUsd: minimumBalanceBeforeRunUsd,
    });
    if (!refill.allowed) {
      console.warn("[billing] post-debit auto-topup blocked", {
        workspaceId: args.workspaceId,
        userId: args.userId,
        reason: refill.reason,
        source: args.source,
        traceId: args.traceId,
        spanId,
        availableBalanceUsd: refill.availableBalanceUsd,
        monthlyLimitUsd: refill.monthlyLimitUsd,
        monthSpendUsd: refill.monthSpendUsd,
      });
    }
  } catch (error) {
    console.warn("[billing] post-debit auto-topup preflight failed", {
      workspaceId: args.workspaceId,
      userId: args.userId,
      source: args.source,
      traceId: args.traceId,
      spanId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
