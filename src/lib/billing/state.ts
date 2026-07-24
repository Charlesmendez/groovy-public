import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type BillingWorkspaceState = {
  workspaceId: string;
  role: "admin" | "member" | "guest";
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

export type MembershipRow = {
  workspace_id: string;
  role: "admin" | "member" | "guest";
  created_at?: string | null;
};

function isMissingActiveWorkspaceColumn(error: {
  code?: string;
  message?: string;
} | null): boolean {
  return (
    error?.code === "PGRST204" ||
    String(error?.message || "").includes("active_workspace_id")
  );
}

function activeWorkspaceIdFromPreferences(
  preferences: Record<string, unknown> | null,
): string {
  if (typeof preferences?.active_workspace_id === "string") {
    return preferences.active_workspace_id;
  }
  const onboardingData =
    preferences?.onboarding_data &&
    typeof preferences.onboarding_data === "object" &&
    !Array.isArray(preferences.onboarding_data)
      ? (preferences.onboarding_data as Record<string, unknown>)
      : null;
  return typeof onboardingData?.activeWorkspaceId === "string"
    ? onboardingData.activeWorkspaceId
    : "";
}

async function loadActiveWorkspacePreference(args: {
  userId: string;
  admin: SupabaseClient;
}): Promise<Record<string, unknown> | null> {
  const primary = await args.admin
    .from("user_preferences")
    .select("active_workspace_id,onboarding_data")
    .eq("user_id", args.userId)
    .maybeSingle();
  if (!primary.error) {
    return (primary.data as Record<string, unknown> | null) || null;
  }
  if (!isMissingActiveWorkspaceColumn(primary.error)) {
    throw new Error(primary.error.message);
  }

  const fallback = await args.admin
    .from("user_preferences")
    .select("onboarding_data")
    .eq("user_id", args.userId)
    .maybeSingle();
  if (fallback.error) throw new Error(fallback.error.message);
  return (fallback.data as Record<string, unknown> | null) || null;
}

async function writeActiveWorkspacePreference(args: {
  userId: string;
  workspaceId: string;
  admin: SupabaseClient;
}): Promise<void> {
  const now = new Date().toISOString();
  const primary = await args.admin.from("user_preferences").upsert(
    {
      user_id: args.userId,
      active_workspace_id: args.workspaceId,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );
  if (!primary.error) return;
  if (!isMissingActiveWorkspaceColumn(primary.error)) {
    throw new Error(primary.error.message);
  }

  const { data: stored, error: readError } = await args.admin
    .from("user_preferences")
    .select("onboarding_data")
    .eq("user_id", args.userId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  const onboardingData =
    stored?.onboarding_data &&
    typeof stored.onboarding_data === "object" &&
    !Array.isArray(stored.onboarding_data)
      ? (stored.onboarding_data as Record<string, unknown>)
      : {};
  const { error: fallbackError } = await args.admin
    .from("user_preferences")
    .upsert(
      {
        user_id: args.userId,
        onboarding_data: {
          ...onboardingData,
          activeWorkspaceId: args.workspaceId,
        },
        updated_at: now,
      },
      { onConflict: "user_id" },
    );
  if (fallbackError) throw new Error(fallbackError.message);
}

export async function getWorkspaceMembershipsForUser(args: {
  userId: string;
  admin?: SupabaseClient;
}): Promise<MembershipRow[]> {
  const admin = args.admin || createSupabaseAdminClient();
  const { data, error } = await admin
    .from("workspace_members")
    .select("workspace_id, role, created_at")
    .eq("user_id", args.userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => ({
      workspace_id: String((row as Record<string, unknown>).workspace_id || ""),
      role:
        (row as Record<string, unknown>).role === "admin"
          ? ("admin" as const)
          : (row as Record<string, unknown>).role === "guest"
            ? ("guest" as const)
            : ("member" as const),
      created_at:
        typeof (row as Record<string, unknown>).created_at === "string"
          ? String((row as Record<string, unknown>).created_at)
          : null,
    }))
    .filter((row) => row.workspace_id);
}

/**
 * Resolve the user's selected workspace. The preference is only honored when
 * the user still has a membership, so deleting/revoking a membership cannot
 * leave behind an authorization shortcut.
 */
export async function getWorkspaceMembershipForUser(args: {
  userId: string;
  admin?: SupabaseClient;
}): Promise<MembershipRow | null> {
  const admin = args.admin || createSupabaseAdminClient();
  const memberships = await getWorkspaceMembershipsForUser({
    userId: args.userId,
    admin,
  });
  if (memberships.length === 0) return null;

  let preferences: Record<string, unknown> | null = null;
  try {
    preferences = await loadActiveWorkspacePreference({
      userId: args.userId,
      admin,
    });
  } catch (preferenceError) {
    console.warn(
      "[workspace] active workspace preference lookup failed:",
      preferenceError instanceof Error
        ? preferenceError.message
        : String(preferenceError),
    );
  }
  const preferredWorkspaceId =
    activeWorkspaceIdFromPreferences(preferences);
  const preferred = memberships.find(
    (membership) => membership.workspace_id === preferredWorkspaceId,
  );
  if (preferred) return preferred;

  const workspaceIds = memberships.map((membership) => membership.workspace_id);
  const { data: workspaceRows, error: workspaceError } = await admin
    .from("workspaces")
    .select("id,billing_admin_user_id")
    .in("id", workspaceIds);
  if (workspaceError) {
    console.warn(
      "[workspace] owned workspace lookup failed:",
      workspaceError.message,
    );
  }
  const ownedWorkspaceIds = new Set(
    (workspaceRows || [])
      .filter(
        (row) =>
          String(
            (row as Record<string, unknown>).billing_admin_user_id || "",
          ) === args.userId,
      )
      .map((row) => String((row as Record<string, unknown>).id || "")),
  );
  const fallback =
    memberships.find((membership) =>
      ownedWorkspaceIds.has(membership.workspace_id),
    ) || memberships[0];

  try {
    await writeActiveWorkspacePreference({
      userId: args.userId,
      workspaceId: fallback.workspace_id,
      admin,
    });
  } catch (preferenceWriteError) {
    console.warn(
      "[workspace] active workspace preference repair failed:",
      preferenceWriteError instanceof Error
        ? preferenceWriteError.message
        : String(preferenceWriteError),
    );
  }
  return fallback;
}

export async function setActiveWorkspaceForUser(args: {
  userId: string;
  workspaceId: string;
  admin?: SupabaseClient;
}): Promise<MembershipRow | null> {
  const admin = args.admin || createSupabaseAdminClient();
  const { data: membership, error: membershipError } = await admin
    .from("workspace_members")
    .select("workspace_id,role,created_at")
    .eq("user_id", args.userId)
    .eq("workspace_id", args.workspaceId)
    .maybeSingle();
  if (membershipError) throw new Error(membershipError.message);
  if (!membership) return null;

  await writeActiveWorkspacePreference({
    userId: args.userId,
    workspaceId: args.workspaceId,
    admin,
  });

  return {
    workspace_id: String(membership.workspace_id),
    role:
      membership.role === "admin"
        ? "admin"
        : membership.role === "guest"
          ? "guest"
          : "member",
    created_at:
      typeof membership.created_at === "string"
        ? membership.created_at
        : null,
  };
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

  const role =
    membership.role === "admin"
      ? "admin"
      : membership.role === "guest"
        ? "guest"
        : "member";
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
