import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  getBillingWorkspaceState,
  getMonthlyUsageSpendUsd,
  getWorkspaceMembershipForUser,
} from "@/lib/billing/state";
import { createAndPayTopupInvoice } from "@/lib/billing/stripe";
import { recordWorkspaceTopupCredit } from "@/lib/billing/guard";
import { resolveWorkspaceTokenBillingPolicy } from "@/lib/billing/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOPUP_AMOUNT_USD = 10;

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({ userId: user.id, admin });
  if (!membership) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (membership.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  const tokenBillingPolicy = await resolveWorkspaceTokenBillingPolicy({
    workspaceId: membership.workspace_id,
    admin,
  });
  if (!tokenBillingPolicy.tokenConsumptionBillingEnabled) {
    return NextResponse.json(
      {
        error:
          "Token-consumption billing is disabled for this workspace. Normal Groovy licenses do not require wallet top-ups.",
        code: "token_consumption_billing_disabled",
      },
      { status: 403 }
    );
  }

  const idempotencyHeader = (req.headers.get("idempotency-key") || "").trim();
  const opId = idempotencyHeader || `manual-topup:${membership.workspace_id}:${randomUUID()}`;
  const charge = await createAndPayTopupInvoice({
    workspaceId: membership.workspace_id,
    userId: user.id,
    userEmail: user.email || null,
    amountUsd: TOPUP_AMOUNT_USD,
    kind: "manual_topup",
    idempotencyKey: opId,
    source: "manual_topup_api",
  });

  if (!charge.ok) {
    const status =
      charge.reason === "card_required"
        ? 400
        : charge.reason === "payment_failed"
          ? 402
          : 500;
    return NextResponse.json(
      {
        error: charge.message,
        code: charge.reason,
        invoiceId: charge.invoiceId,
        invoiceStatus: charge.invoiceStatus,
      },
      { status }
    );
  }

  await recordWorkspaceTopupCredit({
    workspaceId: membership.workspace_id,
    userId: user.id,
    amountUsd: charge.amountUsd,
    modelCostUsd: charge.modelCostUsd,
    groovyFeeUsd: charge.groovyFeeUsd,
    feeRateBps: charge.feeRateBps,
    kind: "manual_topup",
    source: "manual_topup_api",
    stripeInvoiceId: charge.invoiceId,
    stripePaymentIntentId: charge.paymentIntentId,
    stripeInvoiceStatus: charge.invoiceStatus,
    idempotencyKey: opId,
  });

  const state = await getBillingWorkspaceState({
    workspaceId: membership.workspace_id,
    userId: user.id,
    admin,
  });
  const monthSpendUsd = await getMonthlyUsageSpendUsd({
    workspaceId: membership.workspace_id,
    admin,
  }).catch(() => 0);

  return NextResponse.json({
    ok: true,
    invoice: {
      id: charge.invoiceId,
      status: charge.invoiceStatus,
      amountUsd: charge.amountUsd,
      modelCostUsd: charge.modelCostUsd,
      groovyFeeUsd: charge.groovyFeeUsd,
    },
    balances: {
      freeCreditUsdRemaining: state?.freeCreditUsdRemaining ?? 0,
      paidCreditUsdBalance: state?.paidCreditUsdBalance ?? 0,
      availableBalanceUsd: state?.availableBalanceUsd ?? 0,
    },
    policy: {
      monthlyLimitUsd: state?.monthlyLimitUsd ?? null,
      monthSpendUsd,
      initialTopupCompleted: state?.initialTopupCompleted ?? false,
    },
  });
}
