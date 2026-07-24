import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getWorkspaceMembershipForUser,
  getWorkspaceMembershipsForUser,
  setActiveWorkspaceForUser,
} from "@/lib/billing/state";

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

export type WorkspaceOption = {
  id: string;
  name: string;
  role: WorkspaceRole;
  isOwner: boolean;
  isActive: boolean;
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
  const membership = await getWorkspaceMembershipForUser({
    userId: user.id,
    admin,
  });

  if (membership) {
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

  await setActiveWorkspaceForUser({
    userId: user.id,
    workspaceId: created.id,
    admin,
  });

  return {
    id: created.id,
    name: created.name,
    billing_admin_user_id: created.billing_admin_user_id,
    role: "admin",
    members: [{ user_id: user.id, role: "admin", email: user.email }],
  };
}

export async function listWorkspacesForUser(args?: {
  userId?: string;
}): Promise<{
  activeWorkspaceId: string | null;
  workspaces: WorkspaceOption[];
}> {
  const user = args?.userId
    ? { id: args.userId }
    : await getAuthedUser();
  const admin = createSupabaseAdminClient();
  const activeMembership = await getWorkspaceMembershipForUser({
    userId: user.id,
    admin,
  });
  const memberships = await getWorkspaceMembershipsForUser({
    userId: user.id,
    admin,
  });
  if (memberships.length === 0) {
    return { activeWorkspaceId: null, workspaces: [] };
  }

  const workspaceIds = memberships.map((membership) => membership.workspace_id);
  const { data: workspaceRows, error } = await admin
    .from("workspaces")
    .select("id,name,billing_admin_user_id")
    .in("id", workspaceIds);
  if (error) throw new Error(error.message);

  const membershipByWorkspace = new Map(
    memberships.map((membership) => [membership.workspace_id, membership]),
  );
  const workspaces = (workspaceRows || [])
    .map((row) => {
      const id = String(row.id);
      const membership = membershipByWorkspace.get(id);
      if (!membership) return null;
      return {
        id,
        name: String(row.name || "Workspace"),
        role: membership.role,
        isOwner: String(row.billing_admin_user_id) === user.id,
        isActive: id === activeMembership?.workspace_id,
      } satisfies WorkspaceOption;
    })
    .filter((workspace): workspace is WorkspaceOption => workspace !== null)
    .sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return {
    activeWorkspaceId: activeMembership?.workspace_id || null,
    workspaces,
  };
}
