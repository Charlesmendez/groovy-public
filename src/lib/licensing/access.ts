import type { User } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getWorkspaceMembershipForUser,
} from "@/lib/billing/state";
import { isSelfHosted } from "@/lib/config/edition";

export const FREE_TRIAL_DAYS = 5;
export const FREE_TRIAL_DURATION_MS = FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000;

export type FreeTrialStatus = {
  status: "not_started" | "active" | "expired";
  eligible: boolean;
  startedAt: string | null;
  endsAt: string | null;
  remainingMs: number;
  daysRemaining: number;
};

export type ProductAccess = {
  hasAccess: boolean;
  accessStatus: "licensed" | "trial" | "trial_available" | "expired";
  licensed: boolean;
  trial: FreeTrialStatus;
  workspaceId: string | null;
  sponsored: boolean;
  sponsorUserId: string | null;
  workspaceOwnerRequired: boolean;
  joinedWorkspace: boolean;
};

export type CurrentLicenseAccess = {
  user: User;
  admin: ReturnType<typeof createSupabaseAdminClient>;
  workspaceId: string | null;
  membershipRole: "admin" | "member" | "guest" | null;
  license: Record<string, unknown> | null;
  canManageLicense: boolean;
};

export async function getCurrentLicenseAccess(): Promise<CurrentLicenseAccess | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;

  const admin = createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({ userId: user.id, admin });
  const workspaceId = membership?.workspace_id || null;

  const query = admin
    .from("licenses")
    .select("*")
    .order("valid_until", { ascending: false })
    .limit(1);
  const { data } = workspaceId
    ? await query.eq("workspace_id", workspaceId).maybeSingle()
    : await query.eq("user_id", user.id).maybeSingle();

  const license = data ? (data as Record<string, unknown>) : null;
  const canManageLicense =
    !!license &&
    (license.user_id === user.id ||
      (membership?.role === "admin" && !!workspaceId && license.workspace_id === workspaceId));

  return {
    user,
    admin,
    workspaceId,
    membershipRole: membership?.role || null,
    license,
    canManageLicense,
  };
}

export function isActiveLicense(license: Record<string, unknown> | null): boolean {
  if (!license) return false;
  const status = license.status;
  const validUntil =
    typeof license.valid_until === "string" ? new Date(license.valid_until).getTime() : 0;
  return (status === "active" || status === "past_due") && validUntil >= Date.now();
}

function trialStatusFromRow(
  row: Record<string, unknown> | null,
  eligible: boolean
): FreeTrialStatus {
  if (!row) {
    return {
      status: "not_started",
      eligible,
      startedAt: null,
      endsAt: null,
      remainingMs: 0,
      daysRemaining: 0,
    };
  }
  const startedAt = typeof row.started_at === "string" ? row.started_at : null;
  const endsAt = typeof row.ends_at === "string" ? row.ends_at : null;
  const endsAtMs = endsAt ? new Date(endsAt).getTime() : 0;
  const remainingMs = Number.isFinite(endsAtMs) ? Math.max(0, endsAtMs - Date.now()) : 0;
  return {
    status: remainingMs > 0 ? "active" : "expired",
    eligible: false,
    startedAt,
    endsAt,
    remainingMs,
    daysRemaining: remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 86_400_000)) : 0,
  };
}

export async function getFreeTrialStatus(args: {
  userId: string;
  admin?: ReturnType<typeof createSupabaseAdminClient>;
  eligible?: boolean;
}): Promise<FreeTrialStatus> {
  const admin = args.admin || createSupabaseAdminClient();
  const { data, error } = await admin
    .from("license_free_trials")
    .select("user_id,started_at,ends_at,converted_at")
    .eq("user_id", args.userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return trialStatusFromRow(
    data ? (data as Record<string, unknown>) : null,
    args.eligible !== false
  );
}

export async function startFreeTrial(args: {
  userId: string;
  admin?: ReturnType<typeof createSupabaseAdminClient>;
}): Promise<FreeTrialStatus> {
  const admin = args.admin || createSupabaseAdminClient();
  const existing = await getFreeTrialStatus({ userId: args.userId, admin });
  if (existing.status !== "not_started") return existing;

  const currentAccess = await getProductAccessForUser({ userId: args.userId, admin });
  if (currentAccess.joinedWorkspace) {
    throw new Error(
      "Switch to your own workspace before starting a personal Groovy trial.",
    );
  }
  if (currentAccess.licensed) {
    throw new Error("This account already has access through an active Groovy license.");
  }

  const { count: ownedLicenseCount, error: licenseError } = await admin
    .from("licenses")
    .select("id", { count: "exact", head: true })
    .eq("user_id", args.userId);
  if (licenseError) throw new Error(licenseError.message);
  if ((ownedLicenseCount || 0) > 0) {
    throw new Error("This account has already had a Groovy license and is not eligible for a new trial.");
  }

  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + FREE_TRIAL_DURATION_MS);
  const { error } = await admin.from("license_free_trials").upsert(
    {
      user_id: args.userId,
      started_at: startedAt.toISOString(),
      ends_at: endsAt.toISOString(),
      updated_at: startedAt.toISOString(),
    },
    { onConflict: "user_id", ignoreDuplicates: true }
  );
  if (error) throw new Error(error.message);
  return getFreeTrialStatus({ userId: args.userId, admin });
}

export async function getProductAccessForUser(args: {
  userId: string;
  workspaceId?: string | null;
  admin?: ReturnType<typeof createSupabaseAdminClient>;
}): Promise<ProductAccess> {
  if (isSelfHosted()) {
    return {
      hasAccess: true,
      accessStatus: "licensed",
      licensed: true,
      trial: trialStatusFromRow(null, false),
      workspaceId: null,
      sponsored: false,
      sponsorUserId: null,
      workspaceOwnerRequired: false,
      joinedWorkspace: false,
    };
  }
  const admin = args.admin || createSupabaseAdminClient();
  const requestedWorkspaceId =
    typeof args.workspaceId === "string" && args.workspaceId.trim()
      ? args.workspaceId.trim()
      : null;
  let membership;
  if (requestedWorkspaceId) {
    const { data, error } = await admin
      .from("workspace_members")
      .select("workspace_id,role")
      .eq("user_id", args.userId)
      .eq("workspace_id", requestedWorkspaceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new Error("Workspace membership not found");
    }
    membership = data;
  } else {
    membership = await getWorkspaceMembershipForUser({
      userId: args.userId,
      admin,
    });
  }
  const workspaceId = membership?.workspace_id || null;
  const { data: workspace, error: workspaceLookupError } = workspaceId
    ? await admin
        .from("workspaces")
        .select("billing_admin_user_id")
        .eq("id", workspaceId)
        .maybeSingle()
    : { data: null, error: null };
  if (workspaceLookupError) throw new Error(workspaceLookupError.message);
  const workspaceOwnerId =
    typeof workspace?.billing_admin_user_id === "string"
      ? workspace.billing_admin_user_id
      : null;
  const isJoinedWorkspace =
    !!workspaceOwnerId && workspaceOwnerId !== args.userId;

  const [personalResult, workspaceResult, ownerPersonalResult] = await Promise.all([
    admin
      .from("licenses")
      .select("status,valid_until,license_type")
      .eq("user_id", args.userId)
      .eq("license_type", "personal"),
    workspaceId
      ? admin
          .from("licenses")
          .select("status,valid_until,license_type")
          .eq("workspace_id", workspaceId)
      : Promise.resolve({ data: [], error: null }),
    isJoinedWorkspace
      ? admin
          .from("licenses")
          .select("status,valid_until,license_type")
          .eq("user_id", workspaceOwnerId)
          .eq("license_type", "personal")
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (personalResult.error) throw new Error(personalResult.error.message);
  if (workspaceResult.error) throw new Error(workspaceResult.error.message);
  if (ownerPersonalResult.error) throw new Error(ownerPersonalResult.error.message);

  const workspaceLicensed = (
    (workspaceResult.data || []) as Array<Record<string, unknown>>
  ).some((license) => isActiveLicense(license));
  const ownerPersonallyLicensed = (
    (ownerPersonalResult.data || []) as Array<Record<string, unknown>>
  ).some((license) => isActiveLicense(license));
  const personallyLicensed = (
    (personalResult.data || []) as Array<Record<string, unknown>>
  ).some((license) => isActiveLicense(license));

  if (workspaceLicensed || ownerPersonallyLicensed) {
    return {
      hasAccess: true,
      accessStatus: "licensed",
      licensed: true,
      trial: trialStatusFromRow(null, false),
      workspaceId,
      sponsored: isJoinedWorkspace,
      sponsorUserId: isJoinedWorkspace ? workspaceOwnerId : null,
      workspaceOwnerRequired: false,
      joinedWorkspace: isJoinedWorkspace,
    };
  }

  if (isJoinedWorkspace && workspaceOwnerId) {
    const ownerTrial = await getFreeTrialStatus({
      userId: workspaceOwnerId,
      admin,
      eligible: false,
    });
    if (ownerTrial.status === "active") {
      return {
        hasAccess: true,
        accessStatus: "licensed",
        licensed: true,
        trial: trialStatusFromRow(null, false),
        workspaceId,
        sponsored: true,
        sponsorUserId: workspaceOwnerId,
        workspaceOwnerRequired: false,
        joinedWorkspace: true,
      };
    }
  }

  if (personallyLicensed) {
    return {
      hasAccess: true,
      accessStatus: "licensed",
      licensed: true,
      trial: trialStatusFromRow(null, false),
      workspaceId,
      sponsored: false,
      sponsorUserId: null,
      workspaceOwnerRequired: false,
      joinedWorkspace: isJoinedWorkspace,
    };
  }

  const trial = await getFreeTrialStatus({
    userId: args.userId,
    admin,
    // A member should never be prompted to start a personal trial merely to
    // enter somebody else's workspace. They can switch to their own workspace
    // when they want to start personal access.
    eligible:
      !isJoinedWorkspace &&
      !personallyLicensed &&
      personalResult.data?.length === 0,
  });
  if (trial.status === "active") {
    return {
      hasAccess: true,
      accessStatus: "trial",
      licensed: false,
      trial,
      workspaceId,
      sponsored: false,
      sponsorUserId: null,
      workspaceOwnerRequired: false,
      joinedWorkspace: isJoinedWorkspace,
    };
  }
  if (trial.status === "not_started" && trial.eligible) {
    return {
      hasAccess: false,
      accessStatus: "trial_available",
      licensed: false,
      trial,
      workspaceId,
      sponsored: false,
      sponsorUserId: null,
      workspaceOwnerRequired: false,
      joinedWorkspace: false,
    };
  }
  return {
    hasAccess: false,
    accessStatus: "expired",
    licensed: false,
    trial,
    workspaceId,
    sponsored: false,
    sponsorUserId: null,
    workspaceOwnerRequired: isJoinedWorkspace,
    joinedWorkspace: isJoinedWorkspace,
  };
}

export function hasResellerBillingLicense(license: Record<string, unknown> | null): boolean {
  return (
    isActiveLicense(license) &&
    license?.license_type === "enterprise_reseller" &&
    license.reseller_billing_enabled === true &&
    license.token_consumption_billing_enabled === true
  );
}
