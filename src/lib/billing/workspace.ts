import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  getWorkspaceMembershipForUser,
  setActiveWorkspaceForUser,
} from "@/lib/billing/state";

function defaultWorkspaceName(email?: string | null) {
  if (!email) return "My Workspace";
  const base = email.split("@")[0]?.trim() || "My Workspace";
  return `${base}'s Workspace`;
}

/**
 * Resolve the workspace_id to bill usage under for a user.
 * Uses the service role client (bypasses RLS) so it works in cookie-less contexts
 * (e.g. WhatsApp device-token auth, scheduler).
 */
export async function getOrCreateWorkspaceIdForUser(args: {
  userId: string;
  email?: string | null;
  supabaseAdmin?: SupabaseClient;
}): Promise<string | null> {
  const admin = args.supabaseAdmin || createSupabaseAdminClient();

  const membership = await getWorkspaceMembershipForUser({
    userId: args.userId,
    admin,
  });
  if (membership) return membership.workspace_id;

  // Create workspace + membership (admin bypasses RLS)
  const wsName = defaultWorkspaceName(args.email);
  const { data: created, error: cErr } = await admin
    .from("workspaces")
    .insert({ name: wsName, billing_admin_user_id: args.userId })
    .select("id")
    .single();

  if (cErr || !created?.id) {
    console.warn("[billing] workspace create failed:", cErr?.message || "no id");
    return null;
  }

  const wsId = String(created.id);

  const { error: mmErr } = await admin.from("workspace_members").insert({
    workspace_id: wsId,
    user_id: args.userId,
    role: "admin",
  });

  if (mmErr) {
    // Best-effort: return workspace id anyway for debugging; but billing inserts may fail if user isn't a member.
    console.warn("[billing] workspace_members insert failed:", mmErr.message);
  }

  await setActiveWorkspaceForUser({
    userId: args.userId,
    workspaceId: wsId,
    admin,
  }).catch((error) => {
    console.warn(
      "[billing] active workspace preference write failed:",
      error instanceof Error ? error.message : String(error),
    );
  });

  return wsId;
}

/**
 * Resolve the account that owns workspace-scoped credentials and integration
 * records. The caller remains the billing/audit actor; this id is only the
 * shared capability namespace.
 */
export async function getWorkspaceCapabilityOwnerUserId(args: {
  workspaceId: string;
  supabaseAdmin?: SupabaseClient;
}): Promise<string | null> {
  const admin = args.supabaseAdmin || createSupabaseAdminClient();
  const { data, error } = await admin
    .from("workspaces")
    .select("billing_admin_user_id")
    .eq("id", args.workspaceId)
    .maybeSingle();
  if (error) {
    console.warn("[workspace] capability owner lookup failed:", error.message);
    return null;
  }
  return typeof data?.billing_admin_user_id === "string" &&
    data.billing_admin_user_id
    ? data.billing_admin_user_id
    : null;
}

export async function isChannelGuestUser(args: {
  userId: string;
  supabaseAdmin?: SupabaseClient;
}): Promise<boolean> {
  const admin = args.supabaseAdmin || createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({
    userId: args.userId,
    admin,
  });
  return membership?.role === "guest";
}
