import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";

export async function requireWorkspaceSecretAdmin() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  const admin = createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({ userId: user.id, admin });
  if (!membership || membership.role === "guest") {
    throw Object.assign(new Error("Workspace not found"), { status: 404 });
  }
  if (membership.role !== "admin") {
    throw Object.assign(new Error("Admin access required"), { status: 403 });
  }
  return { admin, user, workspaceId: membership.workspace_id };
}

export function workspaceSecretError(error: unknown, fallback: string) {
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? Number((error as { status: number }).status) : 500;
  return { status, message: error instanceof Error ? error.message : fallback };
}
