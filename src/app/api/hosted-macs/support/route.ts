import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { logError, logInfo, logWarn, safeTextPreview } from "@/lib/observability/log";

type Action = "restart" | "update";

type Body = {
  action?: Action;
  note?: string;
};

async function notifySlack(payload: Record<string, unknown>) {
  const webhook = process.env.HOSTED_MACS_SLACK_WEBHOOK_URL;
  if (!webhook) return;
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

async function getWorkspaceMembership(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string
) {
  const { data } = await admin
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", userId)
    .limit(1)
    .single();
  return data || null;
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as Body | null;
    const action = body?.action;
    if (action !== "restart" && action !== "update") {
      logWarn("hosted_mac.support.invalid_action", { user_id: user.id, action: body?.action || null });
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const admin = createSupabaseAdminClient();
    const membership = await getWorkspaceMembership(admin, user.id);
    if (!membership) {
      logWarn("hosted_mac.support.no_workspace", { user_id: user.id });
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role !== "admin") {
      logWarn("hosted_mac.support.forbidden_not_admin", {
        user_id: user.id,
        workspace_id: membership.workspace_id,
        action,
      });
      return NextResponse.json(
        { error: "Only workspace admins can request changes to Groovy Mac" },
        { status: 403 }
      );
    }

    const { data: reqs } = await admin
      .from("hosted_mac_requests")
      .select("id,status,status_detail,workspace_id")
      .eq("workspace_id", membership.workspace_id)
      .order("created_at", { ascending: false })
      .limit(1);

    const request = reqs?.[0] || null;
    if (!request) {
      logWarn("hosted_mac.support.no_request", { workspace_id: membership.workspace_id, user_id: user.id });
      return NextResponse.json({ error: "No Groovy Mac request found" }, { status: 404 });
    }

    // Best-effort: include device_id (if already paired)
    const { data: hostedDevice } = await admin
      .from("hosted_devices")
      .select("device_id")
      .eq("request_id", request.id)
      .limit(1)
      .maybeSingle();

    const deviceId = hostedDevice?.device_id ? String(hostedDevice.device_id) : null;
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";

    logInfo("hosted_mac.support.requested", {
      action,
      workspace_id: membership.workspace_id,
      request_id: request.id,
      request_status: request.status,
      device_id: deviceId,
      user_id: user.id,
      note_preview: note ? safeTextPreview(note, 120) : null,
    });

    await notifySlack({
      text: `Groovy Mac: user requested ${action}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*Groovy Mac: user requested ${action}*` },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Workspace:*\n${membership.workspace_id}` },
            { type: "mrkdwn", text: `*Requester:*\n${user.email || user.id}` },
            { type: "mrkdwn", text: `*Request ID:*\n${request.id}` },
            { type: "mrkdwn", text: `*Current status:*\n${request.status}` },
            { type: "mrkdwn", text: `*Device ID:*\n${deviceId || "not paired yet"}` },
          ],
        },
        ...(note
          ? [
              {
                type: "section",
                text: { type: "mrkdwn", text: `*Note:*\n${note}` },
              },
            ]
          : []),
      ],
    });

    // Optional: store a status_detail hint for visibility in UI.
    await admin
      .from("hosted_mac_requests")
      .update({
        status_detail:
          action === "restart"
            ? "User requested restart"
            : "User requested connector update",
        updated_at: new Date().toISOString(),
      })
      .eq("id", request.id);

    logInfo("hosted_mac.support.ok", {
      action,
      workspace_id: membership.workspace_id,
      request_id: request.id,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed";
    const status = message === "Unauthorized" ? 401 : 500;
    logError("hosted_mac.support.error", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status });
  }
}

