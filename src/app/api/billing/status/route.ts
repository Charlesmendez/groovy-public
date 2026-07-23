import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  getBillingWorkspaceState,
  getMonthlyUsageSpendUsd,
  getWorkspaceMembershipForUser,
} from "@/lib/billing/state";
import {
  GROOVY_MAC_MIN_SEATS,
  GROOVY_MAC_SEAT_PRICE_USD,
  KAPSO_ALLOWLIST_PRICE_USD,
  getWorkspaceAddonSummary,
} from "@/lib/billing/addons";
import { resolveWorkspaceTokenBillingPolicy } from "@/lib/billing/policy";
import { isSelfHosted } from "@/lib/config/edition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRICING_EXPLANATION =
  "Groovy does not charge a percentage over token usage by default. Connect your own model provider keys; token usage shown here is analytics and cost estimation unless an enterprise reseller license explicitly enables token-consumption billing.";
const ADDON_PRICING_EXPLANATION =
  "Recurring addons: Groovy Mac is $15 per workspace member/month (minimum 10 seats). Kapso Company WhatsApp is $2 per allowlisted phone/month.";

export async function GET() {
  if (isSelfHosted()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({
    userId: user.id,
    admin,
  });
  if (!membership) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const state = await getBillingWorkspaceState({
    workspaceId: membership.workspace_id,
    userId: user.id,
    admin,
  });
  if (!state) {
    return NextResponse.json({ error: "Workspace billing not found" }, { status: 404 });
  }
  const monthSpendUsd = await getMonthlyUsageSpendUsd({
    workspaceId: membership.workspace_id,
    admin,
  }).catch(() => 0);
  const addonSummary = await getWorkspaceAddonSummary({
    workspaceId: membership.workspace_id,
    admin,
  }).catch(() => null);
  const tokenBillingPolicy = await resolveWorkspaceTokenBillingPolicy({
    workspaceId: membership.workspace_id,
    admin,
  });

  // Fetch card details from Stripe if a payment method is on file
  let cardBrand: string | null = null;
  let cardLast4: string | null = null;
  if (state.stripeDefaultPaymentMethodId) {
    try {
      const { getStripeServerClient } = await import("@/lib/billing/stripe");
      const stripe = getStripeServerClient();
      const pm = await stripe.paymentMethods.retrieve(state.stripeDefaultPaymentMethodId);
      cardBrand = pm.card?.brand ?? null;
      cardLast4 = pm.card?.last4 ?? null;
    } catch {
      // non-fatal — just show "Card on file" without details
    }
  }

  return NextResponse.json({
    workspaceId: membership.workspace_id,
    role: state.role,
    cardOnFile: !!state.stripeDefaultPaymentMethodId,
    cardBrand,
    cardLast4,
    stripeCustomerId: state.stripeCustomerId,
    balances: {
      freeCreditUsdRemaining: state.freeCreditUsdRemaining,
      paidCreditUsdBalance: state.paidCreditUsdBalance,
      availableBalanceUsd: state.availableBalanceUsd,
    },
    policy: {
      initialTopupCompleted: state.initialTopupCompleted,
      autoTopupEnabled: state.autoTopupEnabled,
      autoTopupAmountUsd: state.autoTopupAmountUsd,
      monthlyLimitUsd: state.monthlyLimitUsd,
      monthSpendUsd,
    },
    pricing: {
      model: "provider-configured",
      modelPassThrough: false,
      groovyFeeRatePercent: tokenBillingPolicy.tokenConsumptionBillingEnabled ? 20 : 0,
      externalKeyFeeRatePercent: tokenBillingPolicy.tokenConsumptionBillingEnabled ? 20 : 0,
      explanation: PRICING_EXPLANATION,
      addonsExplanation: ADDON_PRICING_EXPLANATION,
      tokenConsumptionBillingEnabled: tokenBillingPolicy.tokenConsumptionBillingEnabled,
      resellerBillingEnabled: tokenBillingPolicy.resellerBillingEnabled,
      billingPolicyReason: tokenBillingPolicy.reason,
    },
    addons: addonSummary
      ? {
          groovyMac: {
            enabled: addonSummary.groovyMacEnabled,
            memberCount: addonSummary.memberCount,
            billedSeats: addonSummary.groovyMacSeats,
            minSeats: GROOVY_MAC_MIN_SEATS,
            unitPriceUsd: GROOVY_MAC_SEAT_PRICE_USD,
            monthlyUsd: addonSummary.groovyMacMonthlyUsd,
          },
          kapsoAllowlist: {
            enabled: addonSummary.kapsoEnabled,
            allowlistedUsers: addonSummary.kapsoAllowlistCount,
            unitPriceUsd: KAPSO_ALLOWLIST_PRICE_USD,
            monthlyUsd: addonSummary.kapsoMonthlyUsd,
          },
          recurringMonthlyUsd: addonSummary.recurringMonthlyUsd,
        }
      : null,
    pricingHints: {
      groovyMac: {
        unitPriceUsd: GROOVY_MAC_SEAT_PRICE_USD,
        minSeats: GROOVY_MAC_MIN_SEATS,
      },
      kapsoAllowlist: {
        unitPriceUsd: KAPSO_ALLOWLIST_PRICE_USD,
      },
    },
  });
}

type PatchBody = {
  monthlyLimitUsd?: number | null;
  autoTopupEnabled?: boolean;
  autoTopupAmountUsd?: number;
};

export async function PATCH(req: Request) {
  if (isSelfHosted()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({
    userId: user.id,
    admin,
  });
  if (!membership) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (membership.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as PatchBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {
    billing_updated_at: new Date().toISOString(),
  };

  if ("monthlyLimitUsd" in body) {
    if (body.monthlyLimitUsd === null) {
      updates.billing_monthly_limit_usd = null;
    } else if (
      typeof body.monthlyLimitUsd === "number" &&
      Number.isFinite(body.monthlyLimitUsd) &&
      body.monthlyLimitUsd > 0
    ) {
      updates.billing_monthly_limit_usd = Math.round(body.monthlyLimitUsd * 100) / 100;
    } else {
      return NextResponse.json({ error: "monthlyLimitUsd must be null or a positive number" }, { status: 400 });
    }
  }

  if ("autoTopupEnabled" in body) {
    updates.billing_auto_topup_enabled = body.autoTopupEnabled === true;
  }
  if ("autoTopupAmountUsd" in body) {
    if (
      typeof body.autoTopupAmountUsd !== "number" ||
      !Number.isFinite(body.autoTopupAmountUsd) ||
      body.autoTopupAmountUsd <= 0
    ) {
      return NextResponse.json({ error: "autoTopupAmountUsd must be a positive number" }, { status: 400 });
    }
    updates.billing_auto_topup_amount_usd = Math.round(body.autoTopupAmountUsd * 100) / 100;
  }

  const { error } = await admin
    .from("workspaces")
    .update(updates)
    .eq("id", membership.workspace_id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

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
    policy: {
      initialTopupCompleted: state?.initialTopupCompleted ?? false,
      autoTopupEnabled: state?.autoTopupEnabled ?? true,
      autoTopupAmountUsd: state?.autoTopupAmountUsd ?? 10,
      monthlyLimitUsd: state?.monthlyLimitUsd ?? null,
      monthSpendUsd,
    },
  });
}
