import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type BillingWorkspaceState = {
  workspaceId: string;
  role: "admin" | "member";
  stripeCustomerId: string | null;
  stripeDefaultPaymentMethodId: string | null;
  currency: string;
  freeCreditUsdRemaining: number;
  paidCreditUsdBalance: number;
  initialTopupCompleted: boolean;
  autoTopupEnabled: boolean;
  autoTopupAmountUsd: number;
  monthlyLimitUsd: number | null;
  availableBalanceUsd: number;
};

function toFiniteNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function roundUsd(n: number): number {
  return Math.round((n + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export type MembershipRow = { workspace_id: string; role: "admin" | "member" };

export async function getWorkspaceMembershipsForUser(args: {
  userId: string;
  admin?: SupabaseClient;
}): Promise<MembershipRow[]> {
  const admin = args.admin || createSupabaseAdminClient();
  const { data, error } = await admin
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", args.userId);
  if (error || !Array.isArray(data)) return [];
  return data
    .map((row) => ({
      workspace_id: String((row as Record<string, unknown>).workspace_id || ""),
      role:
        (row as Record<string, unknown>).role === "admin"
          ? ("admin" as const)
          : ("member" as const),
    }))
    .filter((row) => row.workspace_id);
}

export async function getWorkspaceMembershipForUser(args: {
  userId: string;
  admin?: SupabaseClient;
}): Promise<MembershipRow | null> {
  const memberships = await getWorkspaceMembershipsForUser(args);
  return memberships[0] || null;
}

export async function getBillingWorkspaceState(args: {
  workspaceId: string;
  userId: string;
  admin?: SupabaseClient;
}): Promise<BillingWorkspaceState | null> {
  const admin = args.admin || createSupabaseAdminClient();

  const { data: membership } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", args.workspaceId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (!membership) return null;

  const role = membership.role === "admin" ? "admin" : "member";
  const { data, error } = await admin
    .from("workspaces")
    .select(
      [
        "stripe_customer_id",
        "stripe_default_payment_method_id",
        "billing_currency",
        "billing_free_credit_usd_remaining",
        "billing_paid_credit_usd_balance",
        "billing_initial_topup_completed",
        "billing_auto_topup_enabled",
        "billing_auto_topup_amount_usd",
        "billing_monthly_limit_usd",
      ].join(",")
    )
    .eq("id", args.workspaceId)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as unknown as Record<string, unknown>;
  const free = roundUsd(
    toFiniteNumber(row.billing_free_credit_usd_remaining)
  );
  const paid = roundUsd(
    toFiniteNumber(row.billing_paid_credit_usd_balance)
  );

  return {
    workspaceId: args.workspaceId,
    role,
    stripeCustomerId:
      typeof row.stripe_customer_id === "string"
        ? (row.stripe_customer_id as string)
        : null,
    stripeDefaultPaymentMethodId:
      typeof row.stripe_default_payment_method_id === "string"
        ? (row.stripe_default_payment_method_id as string)
        : null,
    currency:
      typeof row.billing_currency === "string" &&
      (row.billing_currency as string).trim()
        ? String(row.billing_currency)
        : "usd",
    freeCreditUsdRemaining: free,
    paidCreditUsdBalance: paid,
    initialTopupCompleted:
      row.billing_initial_topup_completed === true,
    autoTopupEnabled:
      row.billing_auto_topup_enabled !== false,
    autoTopupAmountUsd: roundUsd(
      toFiniteNumber(row.billing_auto_topup_amount_usd, 10)
    ),
    monthlyLimitUsd: (() => {
      const v = toFiniteNumber(row.billing_monthly_limit_usd, NaN);
      return Number.isFinite(v) ? roundUsd(v) : null;
    })(),
    availableBalanceUsd: roundUsd(free + paid),
  };
}

export function currentMonthRange(now = new Date()): { fromIso: string; toIso: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const from = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

export async function getMonthlyUsageSpendUsd(args: {
  workspaceId: string;
  now?: Date;
  admin?: SupabaseClient;
}): Promise<number> {
  const admin = args.admin || createSupabaseAdminClient();
  const { fromIso, toIso } = currentMonthRange(args.now);
  const PAGE_SIZE = 2000;

  let offset = 0;
  let total = 0;
  while (true) {
    const { data, error } = await admin
      .from("billing_wallet_ledger")
      .select("total_charge_usd")
      .eq("workspace_id", args.workspaceId)
      .eq("kind", "usage_debit")
      .gte("created_at", fromIso)
      .lt("created_at", toIso)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);

    const rows = (data || []) as Array<Record<string, unknown>>;
    if (rows.length === 0) break;

    for (const row of rows) {
      total += toFiniteNumber(row.total_charge_usd, 0);
    }
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return roundUsd(total);
}
