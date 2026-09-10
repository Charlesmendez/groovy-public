import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { getConfiguredAppUrl } from "@/lib/config/appConfig";
import { normalizeWorkspaceInviteEmail } from "@/lib/workspaceInvites";
import { sendTransactionalEmail } from "@/lib/email/resend";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";
import {
  normalizeWorkspaceAccessChannelIds,
  validateWorkspaceAccessChannels,
  type WorkspaceAccessRole,
} from "@/lib/workspaceAccess";

function safeOrigin() {
  const o = getConfiguredAppUrl() || "";
  return String(o || "").replace(/\/+$/, "");
}

async function sendWorkspaceInviteEmail(params: {
  toEmail: string;
  inviteUrl: string;
  workspaceName: string;
  inviterEmail: string | null;
}) {
  const subject = `You're invited to ${params.workspaceName} on Groovy`;
  const inviterLine = params.inviterEmail ? `Invited by: ${params.inviterEmail}\n\n` : "";
  const text = `${inviterLine}Join workspace: ${params.workspaceName}\n\nAccept invite:\n${params.inviteUrl}\n\nIf you don't have an account yet, sign up first with this email, then reopen the invite link.\n`;

  const htmlEsc = (s: string) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const html = `<div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;">
  <p>${params.inviterEmail ? `Invited by: <b>${htmlEsc(params.inviterEmail)}</b>` : "You're invited"}.</p>
  <p>Join workspace: <b>${htmlEsc(params.workspaceName)}</b></p>
  <p><a href="${htmlEsc(params.inviteUrl)}">Accept invite</a></p>
  <p style="color:#666;font-size:12px;">If you don't have an account yet, sign up first with this email, then reopen the invite link.</p>
</div>`;

  return sendTransactionalEmail({
    to: params.toEmail,
    subject,
    text,
    html,
  });
}

export async function GET() {
  try {
    const user = await getAuthedUser();
    const admin = createSupabaseAdminClient();

    const membership = await getWorkspaceMembershipForUser({
      userId: user.id,
      admin,
    });
    if (!membership) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role !== "admin") {
      return NextResponse.json({ error: "Only admins can view invites" }, { status: 403 });
    }

    const { data: invites, error } = await admin
      .from("workspace_invites")
      .select("id, email, token, role, expires_at, created_at")
      .eq("workspace_id", membership.workspace_id)
      .order("created_at", { ascending: false });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const inviteIds = (invites || []).map((invite) => String(invite.id));
    const { data: channelLinks, error: linkError } = inviteIds.length
      ? await admin
          .from("workspace_invite_channels")
          .select("invite_id,channel_id,chat_channels!inner(name)")
          .in("invite_id", inviteIds)
      : { data: [], error: null };
    if (linkError) {
      return NextResponse.json({ error: linkError.message }, { status: 500 });
    }
    const channelsByInvite = new Map<
      string,
      Array<{ id: string; name: string }>
    >();
    for (const link of channelLinks || []) {
      const relation = Array.isArray(link.chat_channels)
        ? link.chat_channels[0]
        : link.chat_channels;
      const entry = {
        id: String(link.channel_id),
        name:
          relation && typeof relation === "object" && "name" in relation
            ? String((relation as { name?: unknown }).name || "Channel")
            : "Channel",
      };
      const inviteId = String(link.invite_id);
      channelsByInvite.set(inviteId, [
        ...(channelsByInvite.get(inviteId) || []),
        entry,
      ]);
    }
    return NextResponse.json({
      invites: (invites || []).map((invite) => ({
        ...invite,
        channels: channelsByInvite.get(String(invite.id)) || [],
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load invites";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

type InviteBody = {
  email?: string;
  role?: WorkspaceAccessRole;
  channelIds?: string[];
};

type PatchInviteBody = {
  inviteId?: unknown;
  action?: unknown;
  role?: unknown;
  channelIds?: unknown;
};

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as InviteBody | null;
    const inviteEmail = normalizeWorkspaceInviteEmail(body?.email);
    if (!body || !inviteEmail) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }
    const role = body.role === "guest" ? "guest" : "member";
    const requestedChannelIds = normalizeWorkspaceAccessChannelIds(
      body.channelIds,
    );

    const admin = createSupabaseAdminClient();
    const membership = await getWorkspaceMembershipForUser({
      userId: user.id,
      admin,
    });
    if (!membership) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role !== "admin") {
      return NextResponse.json({ error: "Only admins can invite" }, { status: 403 });
    }

    const { data: ws } = await admin
      .from("workspaces")
      .select("id, name")
      .eq("id", membership.workspace_id)
      .single();
    const workspaceName = ws?.name ? String(ws.name) : "Workspace";
    const channelValidation = await validateWorkspaceAccessChannels({
      admin,
      workspaceId: String(membership.workspace_id),
      role,
      channelIds: requestedChannelIds,
    });
    if (!channelValidation.ok) {
      return NextResponse.json(
        { error: channelValidation.error },
        { status: channelValidation.status },
      );
    }
    const selectedChannels = channelValidation.channels;

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();

    const { data: invite, error } = await admin
      .from("workspace_invites")
      .insert({
        workspace_id: membership.workspace_id,
        email: inviteEmail,
        token,
        role,
        expires_at: expiresAt,
      })
      .select("id, email, token, role, expires_at, created_at")
      .single();
    if (error || !invite) {
      return NextResponse.json({ error: error?.message || "Failed to create invite" }, { status: 500 });
    }
    if (requestedChannelIds.length) {
      const { error: linkError } = await admin
        .from("workspace_invite_channels")
        .insert(
          requestedChannelIds.map((channelId) => ({
            invite_id: invite.id,
            channel_id: channelId,
            workspace_id: membership.workspace_id,
          })),
        );
      if (linkError) {
        await admin.from("workspace_invites").delete().eq("id", invite.id);
        return NextResponse.json({ error: linkError.message }, { status: 500 });
      }
    }

    const origin = safeOrigin();
    const inviteUrl = origin ? `${origin}/invite/${invite.token}` : `/invite/${invite.token}`;

    let emailSent = false;
    let emailError: string | null = null;
    if (!origin) {
      emailError = "App URL is not configured for invitation delivery";
    } else {
      try {
        const emailRes = await sendWorkspaceInviteEmail({
          toEmail: String(invite.email),
          inviteUrl,
          workspaceName,
          inviterEmail: user.email || null,
        });
        emailSent = emailRes.ok === true;
        emailError = emailSent
          ? null
          : (emailRes as { error?: string }).error || "Failed to send";
      } catch (e) {
        emailSent = false;
        emailError = e instanceof Error ? e.message : "Failed to send";
      }
    }

    return NextResponse.json({
      invite: {
        ...invite,
        channels: (selectedChannels || []).map((channel) => ({
          id: channel.id,
          name: channel.name,
        })),
      },
      inviteUrl,
      emailSent,
      emailError,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create invite";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as
      | PatchInviteBody
      | null;
    const inviteId =
      typeof body?.inviteId === "string" ? body.inviteId.trim() : "";
    if (!inviteId) {
      return NextResponse.json(
        { error: "inviteId required" },
        { status: 400 },
      );
    }

    const admin = createSupabaseAdminClient();
    const membership = await getWorkspaceMembershipForUser({
      userId: user.id,
      admin,
    });
    if (!membership) {
      return NextResponse.json(
        { error: "Workspace not found" },
        { status: 404 },
      );
    }
    if (membership.role !== "admin") {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 },
      );
    }

    const { data: storedInvite, error: inviteError } = await admin
      .from("workspace_invites")
      .select("id,workspace_id,email,token,role,expires_at,created_at")
      .eq("id", inviteId)
      .eq("workspace_id", membership.workspace_id)
      .maybeSingle();
    if (inviteError) {
      return NextResponse.json(
        { error: inviteError.message },
        { status: 500 },
      );
    }
    if (!storedInvite) {
      return NextResponse.json(
        { error: "Invite not found" },
        { status: 404 },
      );
    }

    const action =
      body?.action === undefined || body.action === "resend"
        ? "resend"
        : body.action === "update_access"
          ? "update_access"
          : null;
    if (!action) {
      return NextResponse.json(
        { error: "Unsupported invitation action" },
        { status: 400 },
      );
    }

    if (action === "update_access") {
      if (body?.role !== "member" && body?.role !== "guest") {
        return NextResponse.json(
          { error: "Invitation role must be member or guest" },
          { status: 400 },
        );
      }
      const nextRole: WorkspaceAccessRole = body.role;
      const requestedChannelIds = normalizeWorkspaceAccessChannelIds(
        body.channelIds,
      );
      const channelValidation = await validateWorkspaceAccessChannels({
        admin,
        workspaceId: String(membership.workspace_id),
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
        "update_workspace_invite_access",
        {
          p_workspace_id: membership.workspace_id,
          p_invite_id: inviteId,
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

      return NextResponse.json({
        ok: true,
        invite: {
          id: storedInvite.id,
          email: storedInvite.email,
          token: storedInvite.token,
          role: nextRole,
          expires_at: storedInvite.expires_at,
          created_at: storedInvite.created_at,
          channels: channelValidation.channels.map((channel) => ({
            id: channel.id,
            name: channel.name,
          })),
        },
      });
    }

    let invite = storedInvite;
    const expiresAtMs = new Date(String(storedInvite.expires_at)).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      const { data: refreshedInvite, error: refreshError } = await admin
        .from("workspace_invites")
        .update({
          expires_at: new Date(
            Date.now() + 1000 * 60 * 60 * 24 * 7,
          ).toISOString(),
        })
        .eq("id", inviteId)
        .eq("workspace_id", membership.workspace_id)
        .select("id,workspace_id,email,token,role,expires_at,created_at")
        .maybeSingle();
      if (refreshError || !refreshedInvite) {
        return NextResponse.json(
          { error: refreshError?.message || "Failed to refresh invitation" },
          { status: 500 },
        );
      }
      invite = refreshedInvite;
    }

    const { data: workspace, error: workspaceError } = await admin
      .from("workspaces")
      .select("name")
      .eq("id", membership.workspace_id)
      .maybeSingle();
    if (workspaceError) {
      return NextResponse.json(
        { error: workspaceError.message },
        { status: 500 },
      );
    }
    if (!workspace) {
      return NextResponse.json(
        { error: "Workspace not found" },
        { status: 404 },
      );
    }

    const origin = safeOrigin();
    if (!origin) {
      return NextResponse.json(
        { error: "App URL is not configured for invitation delivery" },
        { status: 503 },
      );
    }
    const inviteUrl = `${origin}/invite/${invite.token}`;
    const delivery = await sendWorkspaceInviteEmail({
      toEmail: String(invite.email),
      inviteUrl,
      workspaceName: String(workspace.name || "Workspace"),
      inviterEmail: user.email || null,
    });
    if (!delivery.ok) {
      return NextResponse.json(
        { error: delivery.error, emailSent: false, inviteUrl },
        { status: delivery.code === "not_configured" ? 503 : 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      emailSent: true,
      inviteUrl,
      invite: {
        id: invite.id,
        email: invite.email,
        token: invite.token,
        role: invite.role,
        expires_at: invite.expires_at,
        created_at: invite.created_at,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update invitation";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : 500 },
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as {
      inviteId?: unknown;
    } | null;
    const inviteId =
      typeof body?.inviteId === "string" ? body.inviteId.trim() : "";
    if (!inviteId) {
      return NextResponse.json({ error: "inviteId required" }, { status: 400 });
    }
    const admin = createSupabaseAdminClient();
    const membership = await getWorkspaceMembershipForUser({
      userId: user.id,
      admin,
    });
    if (!membership || membership.role !== "admin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    const { data, error } = await admin
      .from("workspace_invites")
      .delete()
      .eq("id", inviteId)
      .eq("workspace_id", membership.workspace_id)
      .select("id")
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "Invite not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to cancel invite";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : 500 },
    );
  }
}
