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
      .select("id, workspace_id, email, role, expires_at")
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
    const invitedRole = invite.role === "guest" ? "guest" : "member";
    const { data: inviteChannels, error: inviteChannelsError } = await admin
      .from("workspace_invite_channels")
      .select("channel_id")
      .eq("invite_id", invite.id)
      .eq("workspace_id", invitedWorkspaceId);
    if (inviteChannelsError) {
      return NextResponse.json(
        { error: inviteChannelsError.message },
        { status: 500 },
      );
    }
    const invitedChannelIds = (inviteChannels || []).map((row) =>
      String(row.channel_id),
    );
    if (invitedRole === "guest" && invitedChannelIds.length === 0) {
      return NextResponse.json(
        { error: "This guest invitation has no channel access" },
        { status: 409 },
      );
    }

    // Enforce single-workspace-per-user: if the user is already in a different workspace,
    // only allow auto-move if their current workspace is "personal" (they are the only member).
    const { data: memberships } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id);

    const currentMemberships = Array.isArray(memberships) ? memberships : [];

    const existingInvitedMembership = currentMemberships.find(
      (membership) =>
        String(membership.workspace_id) === invitedWorkspaceId,
    );

    const otherMemberships = currentMemberships.filter(
      (m) => String(m.workspace_id) !== invitedWorkspaceId,
    );
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

    }

    // Join the workspace. Never downgrade an existing operator to guest.
    const effectiveRole =
      existingInvitedMembership?.role === "admin" ||
      existingInvitedMembership?.role === "member"
        ? existingInvitedMembership.role
        : invitedRole;
    const { error: membershipWriteError } = await admin
      .from("workspace_members")
      .upsert({
      workspace_id: invitedWorkspaceId,
      user_id: user.id,
      role: effectiveRole,
    });
    if (membershipWriteError) {
      return NextResponse.json(
        { error: membershipWriteError.message },
        { status: 500 },
      );
    }

    const newlyAddedChannelIds: string[] = [];
    const removedOldMemberships: Array<{
      workspace_id: string;
      role: string;
    }> = [];
    const rollbackNewJoin = async () => {
      if (newlyAddedChannelIds.length) {
        await admin
          .from("chat_channel_members")
          .delete()
          .eq("member_type", "user")
          .eq("user_id", user.id)
          .in("channel_id", newlyAddedChannelIds);
      }
      if (existingInvitedMembership) {
        await admin
          .from("workspace_members")
          .update({ role: existingInvitedMembership.role })
          .eq("workspace_id", invitedWorkspaceId)
          .eq("user_id", user.id);
      } else {
        await admin
          .from("workspace_members")
          .delete()
          .eq("workspace_id", invitedWorkspaceId)
          .eq("user_id", user.id);
      }
      if (removedOldMemberships.length) {
        await admin.from("workspace_members").upsert(
          removedOldMemberships.map((membership) => ({
            workspace_id: membership.workspace_id,
            user_id: user.id,
            role: membership.role,
          })),
        );
      }
    };

    if (invitedChannelIds.length) {
      const { data: existingChannelMemberships, error: existingChannelError } =
        await admin
          .from("chat_channel_members")
          .select("channel_id")
          .eq("member_type", "user")
          .eq("user_id", user.id)
          .in("channel_id", invitedChannelIds);
      if (existingChannelError) {
        await rollbackNewJoin();
        return NextResponse.json(
          { error: existingChannelError.message },
          { status: 500 },
        );
      }
      const existingChannelIds = new Set(
        (existingChannelMemberships || []).map((row) =>
          String(row.channel_id),
        ),
      );
      const missingChannelIds = invitedChannelIds.filter(
        (channelId) => !existingChannelIds.has(channelId),
      );
      if (missingChannelIds.length) {
        const { error: channelMembershipError } = await admin
          .from("chat_channel_members")
          .insert(
            missingChannelIds.map((channelId) => ({
              channel_id: channelId,
              member_type: "user",
              user_id: user.id,
              agent_id: null,
              added_by: null,
            })),
          );
        if (channelMembershipError) {
          await rollbackNewJoin();
          return NextResponse.json(
            { error: channelMembershipError.message },
            { status: 500 },
          );
        }
        newlyAddedChannelIds.push(...missingChannelIds);
      }
    }

    // Only remove the old personal workspace after the new membership and all
    // requested channel grants have succeeded. This keeps a transient write
    // failure from stranding the user without either workspace.
    const oldChannelIdsToClean: string[] = [];
    for (const membership of otherMemberships) {
      const oldWorkspaceId = String(membership.workspace_id);
      const { data: oldWorkspaceChannels, error: oldChannelsError } =
        await admin
          .from("chat_channels")
          .select("id")
          .eq("workspace_id", oldWorkspaceId);
      if (oldChannelsError) {
        await rollbackNewJoin();
        return NextResponse.json(
          { error: oldChannelsError.message },
          { status: 500 },
        );
      }
      const oldChannelIds = (oldWorkspaceChannels || []).map((channel) =>
        String(channel.id),
      );
      oldChannelIdsToClean.push(...oldChannelIds);
      const { error: oldMembershipDeleteError } = await admin
        .from("workspace_members")
        .delete()
        .eq("workspace_id", oldWorkspaceId)
        .eq("user_id", user.id);
      if (oldMembershipDeleteError) {
        await rollbackNewJoin();
        return NextResponse.json(
          { error: oldMembershipDeleteError.message },
          { status: 500 },
        );
      }
      removedOldMemberships.push({
        workspace_id: oldWorkspaceId,
        role: String(membership.role),
      });
    }
    if (oldChannelIdsToClean.length) {
      const { error: oldChannelMembershipError } = await admin
        .from("chat_channel_members")
        .delete()
        .eq("member_type", "user")
        .eq("user_id", user.id)
        .in("channel_id", oldChannelIdsToClean);
      if (oldChannelMembershipError) {
        // The membership removal already revoked access because is_channel_member
        // also requires a current workspace identity. Leave only inert cleanup
        // rows instead of rolling back a completed, secure workspace move.
        console.warn(
          "[workspace-invite] stale channel membership cleanup failed",
          oldChannelMembershipError.message,
        );
      }
    }

    // Seed explicit agent ACL rows for agents already shared with this workspace.
    const { data: sharedAgentRows } =
      effectiveRole === "guest"
        ? { data: [] }
        : await admin
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

    if (!existingInvitedMembership) {
      await syncWorkspaceAddonSubscriptionBestEffort({
        workspaceId: invitedWorkspaceId,
        userId: user.id,
        userEmail: user.email || null,
        admin,
        context: "invite_accept",
      });
    }

    return NextResponse.json({
      success: true,
      role: effectiveRole,
      channelIds: invitedChannelIds,
      destination: effectiveRole === "guest" ? "/chat" : "/dashboard",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to accept invite";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
