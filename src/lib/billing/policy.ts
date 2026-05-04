import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeUsageChargeType, type UsageChargeType } from "@/lib/billing/pricing";

export type TokenBillingPolicy = {
  tokenConsumptionBillingEnabled: boolean;
  resellerBillingEnabled: boolean;
  licenseId: string | null;
  licenseType: "personal" | "enterprise" | "enterprise_reseller" | null;
  status: string | null;
  reason: string;
};

export const TOKEN_BILLING_DISABLED_POLICY: TokenBillingPolicy = {
  tokenConsumptionBillingEnabled: false,
  resellerBillingEnabled: false,
  licenseId: null,
  licenseType: null,
  status: null,
  reason: "token_consumption_billing_disabled_by_default",
};

function isActiveForBilling(status: unknown): boolean {
  return status === "active" || status === "past_due";
}

function isWithinLicensedTerm(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= Date.now();
}

export async function resolveWorkspaceTokenBillingPolicy(args: {
  workspaceId?: string | null;
  admin?: SupabaseClient;
}): Promise<TokenBillingPolicy> {
  const workspaceId = args.workspaceId?.trim();
  if (!workspaceId) return TOKEN_BILLING_DISABLED_POLICY;

  try {
    const admin = args.admin || createSupabaseAdminClient();
    const { data, error } = await admin
      .from("licenses")
      .select(
        "id, license_type, status, reseller_billing_enabled, token_consumption_billing_enabled, valid_until"
      )
      .eq("workspace_id", workspaceId)
      .eq("reseller_billing_enabled", true)
      .eq("token_consumption_billing_enabled", true)
      .order("valid_until", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return TOKEN_BILLING_DISABLED_POLICY;
    const row = data as Record<string, unknown>;
    const status = typeof row.status === "string" ? row.status : null;
    const licenseType =
      row.license_type === "enterprise_reseller"
        ? "enterprise_reseller"
        : row.license_type === "enterprise"
          ? "enterprise"
          : row.license_type === "personal"
            ? "personal"
            : null;

    if (
      licenseType !== "enterprise_reseller" ||
      !isActiveForBilling(status) ||
      !isWithinLicensedTerm(row.valid_until) ||
      row.reseller_billing_enabled !== true ||
      row.token_consumption_billing_enabled !== true
    ) {
      return TOKEN_BILLING_DISABLED_POLICY;
    }

    return {
      tokenConsumptionBillingEnabled: true,
      resellerBillingEnabled: true,
      licenseId: typeof row.id === "string" ? row.id : null,
      licenseType,
      status,
      reason: "enterprise_reseller_license_allows_token_billing",
    };
  } catch {
    // Fail closed. A missing migration or transient DB issue must never enable billing.
    return TOKEN_BILLING_DISABLED_POLICY;
  }
}

export function coerceChargeTypeForTokenBillingPolicy(args: {
  requestedChargeType?: UsageChargeType | string | null;
  policy: TokenBillingPolicy;
}): UsageChargeType {
  if (!args.policy.tokenConsumptionBillingEnabled) return "no_charge";
  return normalizeUsageChargeType(args.requestedChargeType);
}

export function isTokenBillingAllowed(policy: TokenBillingPolicy): boolean {
  return policy.tokenConsumptionBillingEnabled && policy.resellerBillingEnabled;
}
