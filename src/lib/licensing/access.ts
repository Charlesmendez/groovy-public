import type { User } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";

export type CurrentLicenseAccess = {
  user: User;
  admin: ReturnType<typeof createSupabaseAdminClient>;
  workspaceId: string | null;
  membershipRole: "admin" | "member" | null;
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

export function hasResellerBillingLicense(license: Record<string, unknown> | null): boolean {
  return (
    isActiveLicense(license) &&
    license?.license_type === "enterprise_reseller" &&
    license.reseller_billing_enabled === true &&
    license.token_consumption_billing_enabled === true
  );
}
