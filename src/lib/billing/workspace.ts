import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

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

  // Fast path: existing membership
  const { data: memberships, error: mErr } = await admin
    .from("workspace_members")
    .select("workspace_id, created_at")
    .eq("user_id", args.userId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (mErr) {
    console.warn("[billing] workspace_members lookup failed:", mErr.message);
    // Avoid mis-attributing usage if membership lookup fails transiently.
    // Caller can retry on the next request.
    return null;
  } else if (memberships && memberships.length > 0) {
    const wsId = (memberships[0] as { workspace_id?: unknown }).workspace_id;
    return typeof wsId === "string" && wsId ? wsId : null;
  }

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
  const { data, error } = await admin
    .from("workspace_members")
    .select("role")
    .eq("user_id", args.userId)
    .eq("role", "guest")
    .limit(1)
    .maybeSingle();
  if (error) {
    // Fail closed for entry points that cannot otherwise constrain a guest to
    // an explicitly granted channel.
    throw new Error(error.message);
  }
  return data?.role === "guest";
}
