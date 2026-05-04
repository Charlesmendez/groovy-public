import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { syncWorkspaceAddonSubscriptionBestEffort } from "@/lib/billing/addons";

type AcceptBody = {
  token?: string;
};

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as AcceptBody | null;
    if (!body || typeof body.token !== "string" || !body.token.trim()) {
      return NextResponse.json({ error: "Invalid token" }, { status: 400 });
    }

    const admin = createSupabaseAdminClient();
    const { data: invite, error: inviteErr } = await admin
      .from("workspace_invites")
      .select("id, workspace_id, email, expires_at")
      .eq("token", body.token.trim())
      .single();
    if (inviteErr || !invite) {
      return NextResponse.json({ error: "Invite not found" }, { status: 404 });
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: "Invite expired" }, { status: 410 });
    }

    // Optional: enforce email match
    if (invite.email && user.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
      return NextResponse.json({ error: "Invite email does not match your account" }, { status: 403 });
    }

    const invitedWorkspaceId = String(invite.workspace_id);

    // Enforce single-workspace-per-user: if the user is already in a different workspace,
    // only allow auto-move if their current workspace is "personal" (they are the only member).
    const { data: memberships } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id);

    const currentMemberships = Array.isArray(memberships) ? memberships : [];

    // Already in the invited workspace? Make accept idempotent.
    if (currentMemberships.some((m) => String(m.workspace_id) === invitedWorkspaceId)) {
      await admin.from("workspace_invites").delete().eq("id", invite.id);
      return NextResponse.json({ success: true });
    }

    const otherMemberships = currentMemberships.filter((m) => String(m.workspace_id) !== invitedWorkspaceId);
    if (otherMemberships.length > 0) {
      for (const m of otherMemberships) {
        const wId = String(m.workspace_id);
        const { data: members } = await admin
          .from("workspace_members")
          .select("user_id")
          .eq("workspace_id", wId)
          .limit(2);

        const isPersonal =
          Array.isArray(members) &&
          members.length === 1 &&
          String(members[0]?.user_id || "") === String(user.id);

        if (!isPersonal) {
          return NextResponse.json(
            { error: "You're already in a workspace. Leave it before joining another." },
            { status: 409 }
          );
        }
      }

      // Personal workspace(s): remove old membership(s) so the user ends up in exactly one workspace.
      for (const m of otherMemberships) {
        const wId = String(m.workspace_id);
        await admin.from("workspace_members").delete().eq("workspace_id", wId).eq("user_id", user.id);
      }
    }

    // Join invited workspace
    await admin.from("workspace_members").upsert({
      workspace_id: invitedWorkspaceId,
      user_id: user.id,
      role: "member",
    });

    // Seed explicit agent ACL rows for agents already shared with this workspace.
    const { data: sharedAgentRows } = await admin
      .from("workspace_orchestrator_agents")
      .select("agent_id,created_by_user_id")
      .eq("workspace_id", invitedWorkspaceId);
    if (Array.isArray(sharedAgentRows) && sharedAgentRows.length > 0) {
      await admin.from("orchestrator_agent_members").upsert(
        sharedAgentRows
          .map((row) => {
            const agentId = String((row as { agent_id?: unknown }).agent_id || "").trim();
            if (!agentId) return null;
            const createdBy = String((row as { created_by_user_id?: unknown }).created_by_user_id || "").trim();
            return {
              agent_id: agentId,
              user_id: user.id,
              role: "viewer",
              created_by_user_id: createdBy || user.id,
              updated_at: new Date().toISOString(),
            };
          })
          .filter(
            (
              row
            ): row is {
              agent_id: string;
              user_id: string;
              role: "viewer";
              created_by_user_id: string;
              updated_at: string;
            } => row !== null
          ),
        { onConflict: "agent_id,user_id" }
      );
    }

    // Delete invite
    await admin
      .from("workspace_invites")
      .delete()
      .eq("id", invite.id);

    await syncWorkspaceAddonSubscriptionBestEffort({
      workspaceId: invitedWorkspaceId,
      userId: user.id,
      userEmail: user.email || null,
      admin,
      context: "invite_accept",
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to accept invite";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
