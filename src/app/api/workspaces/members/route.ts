import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";
import { syncWorkspaceAddonSubscriptionBestEffort } from "@/lib/billing/addons";
import {
  normalizeWorkspaceAccessChannelIds,
  validateWorkspaceAccessChannels,
  type WorkspaceAccessRole,
} from "@/lib/workspaceAccess";

type Action = "leave" | "remove" | "update_access";

type Body = {
  action?: Action;
  userId?: string;
  role?: unknown;
  channelIds?: unknown;
};

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as Body | null;
    const action = body?.action;

    const admin = createSupabaseAdminClient();
    const membership = await getWorkspaceMembershipForUser({
      userId: user.id,
      admin,
    });

    if (!membership) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    const workspaceId = String(membership.workspace_id);
    const myRole = String(membership.role || "");

    if (
      action !== undefined &&
      action !== "leave" &&
      action !== "remove" &&
      action !== "update_access"
    ) {
      return NextResponse.json(
        { error: "Unsupported member action" },
        { status: 400 },
      );
    }

    if (action === "update_access") {
      if (myRole !== "admin") {
        return NextResponse.json(
          { error: "Only admins can change member access" },
          { status: 403 },
        );
      }
      const targetUserId = String(body?.userId || "").trim();
      if (!targetUserId) {
        return NextResponse.json(
          { error: "userId required" },
          { status: 400 },
        );
      }
      if (targetUserId === String(user.id)) {
        return NextResponse.json(
          { error: "Cannot change your own access" },
          { status: 400 },
        );
      }
      if (body?.role !== "member" && body?.role !== "guest") {
        return NextResponse.json(
          { error: "Member role must be member or guest" },
          { status: 400 },
        );
      }
      const nextRole: WorkspaceAccessRole = body.role;

      const { data: target, error: targetError } = await admin
        .from("workspace_members")
        .select("user_id,role")
        .eq("workspace_id", workspaceId)
        .eq("user_id", targetUserId)
        .maybeSingle();
      if (targetError) {
        return NextResponse.json(
          { error: targetError.message },
          { status: 500 },
        );
      }
      if (!target) {
        return NextResponse.json(
          { error: "Member not found" },
          { status: 404 },
        );
      }
      if (String(target.role) === "admin") {
        return NextResponse.json(
          { error: "Cannot change another admin's access" },
          { status: 409 },
        );
      }

      const requestedChannelIds = normalizeWorkspaceAccessChannelIds(
        body.channelIds,
      );
      const channelValidation = await validateWorkspaceAccessChannels({
        admin,
        workspaceId,
        role: nextRole,
        channelIds: requestedChannelIds,
      });
      if (!channelValidation.ok) {
        return NextResponse.json(
          { error: channelValidation.error },
          { status: channelValidation.status },
        );
      }

      const { error: updateError } = await admin.rpc(
        "update_workspace_member_access",
        {
          p_workspace_id: workspaceId,
          p_actor_user_id: user.id,
          p_user_id: targetUserId,
          p_role: nextRole,
          p_channel_ids: requestedChannelIds,
        },
      );
      if (updateError) {
        return NextResponse.json(
          { error: updateError.message },
          { status: 500 },
        );
      }

      await syncWorkspaceAddonSubscriptionBestEffort({
        workspaceId,
        userId: user.id,
        userEmail: user.email || null,
        admin,
        context: "members_update_access",
      });

      return NextResponse.json({
        ok: true,
        member: {
          user_id: targetUserId,
          role: nextRole,
          channels: channelValidation.channels.map((channel) => ({
            id: channel.id,
            name: channel.name,
          })),
        },
      });
    }

    if (action === "remove") {
      if (myRole !== "admin") {
        return NextResponse.json({ error: "Only admins can remove members" }, { status: 403 });
      }
      const targetUserId = String(body?.userId || "").trim();
      if (!targetUserId) {
        return NextResponse.json({ error: "userId required" }, { status: 400 });
      }
      if (targetUserId === String(user.id)) {
        return NextResponse.json({ error: "Cannot remove yourself" }, { status: 400 });
      }

      const { data: target } = await admin
        .from("workspace_members")
        .select("user_id, role")
        .eq("workspace_id", workspaceId)
        .eq("user_id", targetUserId)
        .single();
      if (!target) {
        return NextResponse.json({ error: "Member not found" }, { status: 404 });
      }
      if (String(target.role) === "admin") {
        return NextResponse.json({ error: "Cannot remove another admin" }, { status: 409 });
      }

      const { data: workspaceChannels } = await admin
        .from("chat_channels")
        .select("id")
        .eq("workspace_id", workspaceId);
      const channelIds = (workspaceChannels || []).map((channel) =>
        String(channel.id),
      );
      if (channelIds.length) {
        await admin
          .from("chat_channel_members")
          .delete()
          .eq("member_type", "user")
          .eq("user_id", targetUserId)
          .in("channel_id", channelIds);
      }
      await admin
        .from("workspace_members")
        .delete()
        .eq("workspace_id", workspaceId)
        .eq("user_id", targetUserId);
      await syncWorkspaceAddonSubscriptionBestEffort({
        workspaceId,
        userId: user.id,
        userEmail: user.email || null,
        admin,
        context: "members_remove",
      });
      return NextResponse.json({ ok: true });
    }

    // Default: leave (also used by admins, but protect last admin)
    if (myRole === "admin") {
      const { count } = await admin
        .from("workspace_members")
        .select("user_id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("role", "admin");

      if (!count || count < 2) {
        return NextResponse.json(
          { error: "You are the last admin. Transfer admin rights before leaving." },
          { status: 409 }
        );
      }
    }

    const { data: workspaceChannels } = await admin
      .from("chat_channels")
      .select("id")
      .eq("workspace_id", workspaceId);
    const channelIds = (workspaceChannels || []).map((channel) =>
      String(channel.id),
    );
    if (channelIds.length) {
      await admin
        .from("chat_channel_members")
        .delete()
        .eq("member_type", "user")
        .eq("user_id", user.id)
        .in("channel_id", channelIds);
    }
    await admin
      .from("workspace_members")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id);
    await syncWorkspaceAddonSubscriptionBestEffort({
      workspaceId,
      userId: user.id,
      userEmail: user.email || null,
      admin,
      context: "members_leave",
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
