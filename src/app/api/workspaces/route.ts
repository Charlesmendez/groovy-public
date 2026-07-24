import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  getAuthedUser,
  getOrCreateWorkspaceForUser,
  listWorkspacesForUser,
} from "@/lib/workspaces";
import {
  getWorkspaceMembershipForUser,
  setActiveWorkspaceForUser,
} from "@/lib/billing/state";
import { normalizeWorkspaceInviteEmail } from "@/lib/workspaceInvites";

export const dynamic = "force-dynamic";

type PendingInvite = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: "member" | "guest";
  expiresAt: string;
  channels: Array<{ id: string; name: string }>;
};

async function pendingInvitesForUser(args: {
  email: string | null | undefined;
}): Promise<PendingInvite[]> {
  const email = normalizeWorkspaceInviteEmail(args.email);
  if (!email) return [];

  const admin = createSupabaseAdminClient();
  const { data: inviteRows, error: inviteError } = await admin
    .from("workspace_invites")
    .select("id,workspace_id,role,expires_at,created_at")
    .eq("email", email)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (inviteError) throw new Error(inviteError.message);
  if (!inviteRows?.length) return [];

  const workspaceIds = Array.from(
    new Set(inviteRows.map((invite) => String(invite.workspace_id))),
  );
  const inviteIds = inviteRows.map((invite) => String(invite.id));
  const [{ data: workspaceRows, error: workspaceError }, channelResult] =
    await Promise.all([
      admin.from("workspaces").select("id,name").in("id", workspaceIds),
      admin
        .from("workspace_invite_channels")
        .select("invite_id,channel_id,chat_channels!inner(name)")
        .in("invite_id", inviteIds),
    ]);
  if (workspaceError) throw new Error(workspaceError.message);
  if (channelResult.error) throw new Error(channelResult.error.message);

  const workspaceNameById = new Map(
    (workspaceRows || []).map((workspace) => [
      String(workspace.id),
      String(workspace.name || "Workspace"),
    ]),
  );
  const channelsByInviteId = new Map<
    string,
    Array<{ id: string; name: string }>
  >();
  for (const row of channelResult.data || []) {
    const relation = Array.isArray(row.chat_channels)
      ? row.chat_channels[0]
      : row.chat_channels;
    const inviteId = String(row.invite_id);
    channelsByInviteId.set(inviteId, [
      ...(channelsByInviteId.get(inviteId) || []),
      {
        id: String(row.channel_id),
        name:
          relation && typeof relation === "object" && "name" in relation
            ? String(
                (relation as { name?: unknown }).name || "Private channel",
              )
            : "Private channel",
      },
    ]);
  }

  return inviteRows.map((invite) => ({
    id: String(invite.id),
    workspaceId: String(invite.workspace_id),
    workspaceName:
      workspaceNameById.get(String(invite.workspace_id)) || "Workspace",
    role: invite.role === "guest" ? "guest" : "member",
    expiresAt: String(invite.expires_at),
    channels: channelsByInviteId.get(String(invite.id)) || [],
  }));
}

export async function GET() {
  try {
    const user = await getAuthedUser();
    // Accounts without any membership get their initial personal workspace.
    // Existing memberships are never replaced.
    const admin = createSupabaseAdminClient();
    const existingMembership = await getWorkspaceMembershipForUser({
      userId: user.id,
      admin,
    });
    if (!existingMembership) {
      await getOrCreateWorkspaceForUser();
    }
    const [directory, pendingInvites] = await Promise.all([
      listWorkspacesForUser({ userId: user.id }),
      pendingInvitesForUser({ email: user.email }),
    ]);
    return NextResponse.json({ ...directory, pendingInvites });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load workspaces";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as {
      activeWorkspaceId?: unknown;
      createWorkspace?: unknown;
    } | null;
    const admin = createSupabaseAdminClient();
    if (body?.createWorkspace === true) {
      const { data: ownedWorkspace, error: ownedWorkspaceError } = await admin
        .from("workspaces")
        .select("id,name,billing_admin_user_id")
        .eq("billing_admin_user_id", user.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (ownedWorkspaceError) throw new Error(ownedWorkspaceError.message);

      let workspace = ownedWorkspace;
      if (!workspace) {
        const accountName =
          user.email?.split("@")[0]?.trim() || "My";
        const { data: createdWorkspace, error: workspaceCreateError } =
          await admin
            .from("workspaces")
            .insert({
              name:
                accountName === "My"
                  ? "My Workspace"
                  : `${accountName}'s Workspace`,
              billing_admin_user_id: user.id,
            })
            .select("id,name,billing_admin_user_id")
            .single();
        if (workspaceCreateError || !createdWorkspace) {
          throw new Error(
            workspaceCreateError?.message || "Could not create workspace",
          );
        }
        const { error: membershipCreateError } = await admin
          .from("workspace_members")
          .insert({
            workspace_id: createdWorkspace.id,
            user_id: user.id,
            role: "admin",
          });
        if (membershipCreateError) {
          await admin
            .from("workspaces")
            .delete()
            .eq("id", createdWorkspace.id);
          throw new Error(membershipCreateError.message);
        }
        workspace = createdWorkspace;
      }

      const membership = await setActiveWorkspaceForUser({
        userId: user.id,
        workspaceId: String(workspace.id),
        admin,
      });
      if (!membership) {
        throw new Error("Could not select your workspace");
      }
      return NextResponse.json({
        workspace: {
          id: String(workspace.id),
          name: String(workspace.name || "My Workspace"),
          role: membership.role,
          isOwner: true,
          isActive: true,
        },
      });
    }

    const activeWorkspaceId =
      typeof body?.activeWorkspaceId === "string"
        ? body.activeWorkspaceId.trim()
        : "";
    if (!activeWorkspaceId) {
      return NextResponse.json(
        { error: "activeWorkspaceId is required" },
        { status: 400 },
      );
    }

    const membership = await setActiveWorkspaceForUser({
      userId: user.id,
      workspaceId: activeWorkspaceId,
      admin,
    });
    if (!membership) {
      return NextResponse.json(
        { error: "You do not have access to that workspace" },
        { status: 403 },
      );
    }

    const { data: workspace, error } = await admin
      .from("workspaces")
      .select("id,name,billing_admin_user_id")
      .eq("id", activeWorkspaceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!workspace) {
      return NextResponse.json(
        { error: "Workspace not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      workspace: {
        id: String(workspace.id),
        name: String(workspace.name || "Workspace"),
        role: membership.role,
        isOwner: String(workspace.billing_admin_user_id) === user.id,
        isActive: true,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to switch workspace";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : 500 },
    );
  }
}
