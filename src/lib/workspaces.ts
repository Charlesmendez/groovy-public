import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const MEMBER_EMAIL_LOOKUP_CONCURRENCY = 8;

export type WorkspaceRole = "admin" | "member" | "guest";

export function isWorkspaceOperatorRole(
  role: string | null | undefined,
): role is "admin" | "member" {
  return role === "admin" || role === "member";
}

export type WorkspaceMember = {
  user_id: string;
  role: WorkspaceRole;
  email?: string | null;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  billing_admin_user_id: string;
  role: WorkspaceRole;
  members: WorkspaceMember[];
};

function defaultWorkspaceName(email?: string | null) {
  if (!email) return "My Workspace";
  const base = email.split("@")[0]?.trim() || "My Workspace";
  return `${base}'s Workspace`;
}

export async function getAuthedUser() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) {
    throw new Error("Unauthorized");
  }
  return data.user;
}

export async function getOrCreateWorkspaceForUser(): Promise<WorkspaceInfo> {
  const user = await getAuthedUser();
  const admin = createSupabaseAdminClient();

  const { data: memberships, error: memberErr } = await admin
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", user.id)
    .limit(1);

  if (memberErr) {
    throw new Error(memberErr.message);
  }

  if (memberships && memberships.length > 0) {
    const membership = memberships[0];
    const { data: workspace, error: wsErr } = await admin
      .from("workspaces")
      .select("id, name, billing_admin_user_id")
      .eq("id", membership.workspace_id)
      .single();
    if (wsErr || !workspace) throw new Error(wsErr?.message || "Workspace not found");

    const { data: members } = await admin
      .from("workspace_members")
      .select("user_id, role")
      .eq("workspace_id", workspace.id);

    const memberList: WorkspaceMember[] = [];
    if (Array.isArray(members)) {
      for (let i = 0; i < members.length; i += MEMBER_EMAIL_LOOKUP_CONCURRENCY) {
        const chunk = await Promise.all(
          members.slice(i, i + MEMBER_EMAIL_LOOKUP_CONCURRENCY).map(async (m) => {
            let email: string | null = null;
            try {
              const { data } = await admin.auth.admin.getUserById(m.user_id);
              email = data.user?.email || null;
            } catch {
              email = null;
            }
            return { ...m, email };
          })
        );
        memberList.push(...chunk);
      }
    }

    return {
      id: workspace.id,
      name: workspace.name,
      billing_admin_user_id: workspace.billing_admin_user_id,
      role: membership.role,
      members: memberList,
    };
  }

  const workspaceName = defaultWorkspaceName(user.email);
  const { data: created, error: createErr } = await admin
    .from("workspaces")
    .insert({
      name: workspaceName,
      billing_admin_user_id: user.id,
    })
    .select("id, name, billing_admin_user_id")
    .single();

  if (createErr || !created) {
    throw new Error(createErr?.message || "Failed to create workspace");
  }

  const { error: memberCreateErr } = await admin
    .from("workspace_members")
    .insert({
      workspace_id: created.id,
      user_id: user.id,
      role: "admin",
    });
  if (memberCreateErr) throw new Error(memberCreateErr.message);

  return {
    id: created.id,
    name: created.name,
    billing_admin_user_id: created.billing_admin_user_id,
    role: "admin",
    members: [{ user_id: user.id, role: "admin", email: user.email }],
  };
}
