import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { syncWorkspaceAddonSubscriptionBestEffort } from "@/lib/billing/addons";
import { setActiveWorkspaceForUser } from "@/lib/billing/state";
import {
  GUEST_SAFE_MIND_REQUIREMENT,
  isGuestSafeMind,
} from "@/lib/chat/guestMind";

type AcceptBody = {
  token?: string;
  inviteId?: string;
};

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as AcceptBody | null;
    const token =
      typeof body?.token === "string" ? body.token.trim() : "";
    const inviteId =
      typeof body?.inviteId === "string" ? body.inviteId.trim() : "";
    if (!token && !inviteId) {
      return NextResponse.json(
        { error: "Invitation reference required" },
        { status: 400 },
      );
    }

    const admin = createSupabaseAdminClient();
    let inviteQuery = admin
      .from("workspace_invites")
      .select("id, workspace_id, email, role, expires_at");
    inviteQuery = token
      ? inviteQuery.eq("token", token)
      : inviteQuery.eq("id", inviteId);
    const { data: invite, error: inviteErr } = await inviteQuery.single();
    if (inviteErr || !invite) {
      return NextResponse.json({ error: "Invite not found" }, { status: 404 });
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      return NextResponse.json({ error: "Invite expired" }, { status: 410 });
    }

    // Invitations are email-bound. Fail closed when the authenticated account
    // has no email instead of allowing possession of the link alone.
    if (
      invite.email &&
      (!user.email ||
        invite.email.trim().toLowerCase() !== user.email.trim().toLowerCase())
    ) {
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
    if (invitedRole === "guest") {
      const { data: channels, error: channelsError } = await admin
        .from("chat_channels")
        .select("id,name,profile_id,orchestrator_mode")
        .eq("workspace_id", invitedWorkspaceId)
        .in("id", invitedChannelIds);
      if (channelsError) {
        return NextResponse.json(
          { error: channelsError.message },
          { status: 500 },
        );
      }
      if ((channels || []).length !== invitedChannelIds.length) {
        return NextResponse.json(
          { error: "One or more invited channels are no longer available" },
          { status: 409 },
        );
      }
      const channelsWithMind = (channels || []).filter(
        (channel) => channel.orchestrator_mode !== "off",
      );
      const profileIds = Array.from(
        new Set(
          channelsWithMind
            .map((channel) => String(channel.profile_id || ""))
            .filter(Boolean),
        ),
      );
      const { data: profiles, error: profilesError } = profileIds.length
        ? await admin
            .from("orchestrator_profiles")
            .select(
              "id,workspace_id,surface,authorization_stance,memory_scope,inherit_workspace_skills,inherit_workspace_integrations",
            )
            .eq("workspace_id", invitedWorkspaceId)
            .in("id", profileIds)
        : { data: [], error: null };
      if (profilesError) {
        return NextResponse.json(
          { error: profilesError.message },
          { status: 500 },
        );
      }
      const safeProfileIds = new Set(
        (profiles || [])
          .filter((profile) => isGuestSafeMind(profile))
          .map((profile) => String(profile.id)),
      );
      const invalidChannels = channelsWithMind.filter(
        (channel) =>
          !channel.profile_id ||
          !safeProfileIds.has(String(channel.profile_id)),
      );
      if (invalidChannels.length > 0) {
        return NextResponse.json(
          {
            error: `${GUEST_SAFE_MIND_REQUIREMENT} Ask a workspace admin to configure ${invalidChannels
              .map((channel) => `#${channel.name}`)
              .join(", ")} before accepting this invite.`,
          },
          { status: 409 },
        );
      }
    }

    const { data: memberships, error: membershipsError } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id);
    if (membershipsError) {
      return NextResponse.json(
        { error: membershipsError.message },
        { status: 500 },
      );
    }

    const currentMemberships = Array.isArray(memberships) ? memberships : [];

    const existingInvitedMembership = currentMemberships.find(
      (membership) =>
        String(membership.workspace_id) === invitedWorkspaceId,
    );

    // Joining a workspace does not remove the user's personal workspace or any
    // other memberships. The newly joined workspace becomes active.
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

    try {
      const selectedMembership = await setActiveWorkspaceForUser({
        userId: user.id,
        workspaceId: invitedWorkspaceId,
        admin,
      });
      if (!selectedMembership) {
        throw new Error("The new workspace membership could not be selected");
      }
    } catch (selectionError) {
      await rollbackNewJoin();
      return NextResponse.json(
        {
          error:
            selectionError instanceof Error
              ? selectionError.message
              : "Failed to select workspace",
        },
        { status: 500 },
      );
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
            const agentId = String(
              (row as { agent_id?: unknown }).agent_id || "",
            ).trim();
            if (!agentId) return null;
            const createdBy = String(
              (row as { created_by_user_id?: unknown }).created_by_user_id ||
                "",
            ).trim();
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
              row,
            ): row is {
              agent_id: string;
              user_id: string;
              role: "viewer";
              created_by_user_id: string;
              updated_at: string;
            } => row !== null,
          ),
        { onConflict: "agent_id,user_id" },
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
      workspaceId: invitedWorkspaceId,
      channelIds: invitedChannelIds,
      destination: "/chat",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to accept invite";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
