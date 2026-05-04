import Stripe from "stripe";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordWorkspaceTopupCredit } from "@/lib/billing/guard";
import { GROOVY_FEE_RATE, GROOVY_FEE_RATE_BPS } from "@/lib/billing/pricing";

function parseMoney(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function parseKind(value: unknown): "manual_topup" | "auto_topup" | null {
  return value === "manual_topup" || value === "auto_topup" ? value : null;
}

function splitAmountDefault(amountUsd: number): { modelCostUsd: number; groovyFeeUsd: number } {
  const modelCostUsd = Math.round(((amountUsd / (1 + GROOVY_FEE_RATE)) + Number.EPSILON) * 100) / 100;
  const groovyFeeUsd = Math.round((amountUsd - modelCostUsd + Number.EPSILON) * 100) / 100;
  return { modelCostUsd, groovyFeeUsd };
}

export async function handleTopupInvoicePaid(invoice: Stripe.Invoice) {
  const invoiceId = typeof invoice.id === "string" ? invoice.id : "";
  if (!invoiceId) return;

  const admin = createSupabaseAdminClient();
  await admin
    .from("billing_wallet_ledger")
    .update({
      stripe_invoice_status: invoice.status || "paid",
      stripe_payment_intent_id: null,
    })
    .eq("stripe_invoice_id", invoiceId);

  const metadata = invoice.metadata || {};
  const kind = parseKind(metadata.billing_kind);
  const workspaceId = (metadata.workspace_id || "").trim();
  const userId = (metadata.user_id || "").trim();
  if (!kind || !workspaceId || !userId) return;

  const amountUsd = parseMoney((invoice.total || 0) / 100);
  if (!amountUsd) return;
  const fallback = splitAmountDefault(amountUsd);
  const modelCostUsd = parseMoney(metadata.model_cost_usd) || fallback.modelCostUsd;
  const groovyFeeUsd = parseMoney(metadata.groovy_fee_usd) || fallback.groovyFeeUsd;
  const feeRateBpsRaw = Number(metadata.fee_rate_bps || String(GROOVY_FEE_RATE_BPS));
  const feeRateBps = Number.isFinite(feeRateBpsRaw) && feeRateBpsRaw > 0 ? Math.round(feeRateBpsRaw) : GROOVY_FEE_RATE_BPS;

  await recordWorkspaceTopupCredit({
    workspaceId,
    userId,
    amountUsd,
    modelCostUsd,
    groovyFeeUsd,
    feeRateBps,
    kind,
    source: "stripe_webhook",
    stripeInvoiceId: invoiceId,
    stripePaymentIntentId: null,
    stripeInvoiceStatus: invoice.status || "paid",
    idempotencyKey:
      (metadata.billing_idempotency_key || "").trim() ||
      `stripe:webhook:invoice:${invoiceId}`,
  });
}

export async function handleTopupInvoiceFailed(invoice: Stripe.Invoice) {
  const invoiceId = typeof invoice.id === "string" ? invoice.id : "";
  if (!invoiceId) return;
  const admin = createSupabaseAdminClient();
  await admin
    .from("billing_wallet_ledger")
    .update({
      stripe_invoice_status: invoice.status || "open",
    })
    .eq("stripe_invoice_id", invoiceId);
}
