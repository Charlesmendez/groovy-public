import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { logError, logInfo, logWarn } from "@/lib/observability/log";
import { syncWorkspaceAddonSubscription } from "@/lib/billing/addons";
import { isSelfHosted } from "@/lib/config/edition";

type RequestBody = {
  requested_provider?: string;
  requested_region?: string;
  notes?: string;
};

async function getWorkspaceMembership(admin: ReturnType<typeof createSupabaseAdminClient>, userId: string) {
  const { data, error } = await admin
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", userId)
    .limit(1)
    .single();
  if (error || !data) return null;
  return data;
}

export async function GET() {
  if (isSelfHosted()) {
    return NextResponse.json(
      { error: "Groovy-hosted Macs are unavailable in the self-hosted edition" },
      { status: 404 },
    );
  }
  const startedAt = Date.now();
  try {
    const user = await getAuthedUser();
    const admin = createSupabaseAdminClient();
    const membership = await getWorkspaceMembership(admin, user.id);
    if (!membership) {
      logWarn("hosted_mac.request.get.no_workspace", { user_id: user.id });
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role === "guest") {
      return NextResponse.json(
        { error: "Workspace settings are not available to channel guests" },
        { status: 403 },
      );
    }

    const { data: reqs, error } = await admin
      .from("hosted_mac_requests")
      .select("*")
      .eq("workspace_id", membership.workspace_id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const request = reqs?.[0] || null;

    let device: { device_id: string; last_seen: string | null; online: boolean } | null = null;
    if (request?.id) {
      const { data: hostedDevice } = await admin
        .from("hosted_devices")
        .select("device_id, devices(last_seen)")
        .eq("request_id", request.id)
        .limit(1)
        .maybeSingle();

      const deviceId = hostedDevice?.device_id ? String(hostedDevice.device_id) : "";
      const lastSeen =
        hostedDevice?.devices && typeof hostedDevice.devices === "object"
          ? // @ts-expect-error supabase nested select typing
            (hostedDevice.devices.last_seen as string | null) || null
          : null;
      const online =
        !!lastSeen && Date.now() - new Date(lastSeen).getTime() < 90_000; // ~1.5m grace

      if (deviceId) {
        device = { device_id: deviceId, last_seen: lastSeen, online };
      }
    }

    logInfo("hosted_mac.request.get.ok", {
      user_id: user.id,
      workspace_id: membership.workspace_id,
      has_request: !!request,
      request_id: request?.id ? String(request.id) : null,
      request_status: request?.status ? String(request.status) : null,
      device_id: device?.device_id || null,
      device_online: device?.online ?? null,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ request, device });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load request";
    const status = message === "Unauthorized" ? 401 : 500;
    logError("hosted_mac.request.get.error", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  if (isSelfHosted()) {
    return NextResponse.json(
      { error: "Groovy-hosted Macs are unavailable in the self-hosted edition" },
      { status: 404 },
    );
  }
  const startedAt = Date.now();
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as RequestBody | null;
    const admin = createSupabaseAdminClient();
    const membership = await getWorkspaceMembership(admin, user.id);
    if (!membership) {
      logWarn("hosted_mac.request.post.no_workspace", { user_id: user.id });
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role !== "admin") {
      logWarn("hosted_mac.request.post.forbidden_not_admin", {
        user_id: user.id,
        workspace_id: membership.workspace_id,
      });
      return NextResponse.json({ error: "Only admins can request a Groovy Mac" }, { status: 403 });
    }

    const addonSync = await syncWorkspaceAddonSubscription({
      workspaceId: membership.workspace_id,
      userId: user.id,
      userEmail: user.email || null,
      enableGroovyMac: true,
      enforcePaymentSuccess: true,
      admin,
    });
    if (!addonSync.ok) {
      const status =
        addonSync.reason === "card_required"
          ? 400
          : addonSync.reason === "payment_failed"
            ? 402
            : 500;
      const level = addonSync.reason === "stripe_error" ? logError : logWarn;
      level("hosted_mac.request.post.billing_blocked", {
        user_id: user.id,
        workspace_id: membership.workspace_id,
        reason: addonSync.reason,
        message: addonSync.message,
        duration_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        {
          error: addonSync.message,
          code: addonSync.reason,
        },
        { status }
      );
    }

    const { data: request, error } = await admin
      .from("hosted_mac_requests")
      .insert({
        workspace_id: membership.workspace_id,
        requested_by_user_id: user.id,
        status: "waiting_for_credentials",
        requested_provider: body?.requested_provider || null,
        requested_region: body?.requested_region || null,
        notes: body?.notes || null,
      })
      .select("*")
      .single();
    if (error || !request) {
      logError("hosted_mac.request.post.insert_failed", {
        user_id: user.id,
        workspace_id: membership.workspace_id,
        error: error?.message || "insert_failed",
        duration_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ error: error?.message || "Failed to create request" }, { status: 500 });
    }

    logInfo("hosted_mac.request.post.created", {
      user_id: user.id,
      workspace_id: membership.workspace_id,
      request_id: request.id,
      requested_provider: body?.requested_provider || null,
      requested_region: body?.requested_region || null,
      duration_ms: Date.now() - startedAt,
    });

    const webhook = process.env.HOSTED_MACS_SLACK_WEBHOOK_URL;
    if (webhook) {
      fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `New Groovy Mac request`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*New Groovy Mac request*`,
              },
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Workspace:*\n${membership.workspace_id}` },
                { type: "mrkdwn", text: `*Requester:*\n${user.email || user.id}` },
                { type: "mrkdwn", text: `*Request ID:*\n${request.id}` },
                { type: "mrkdwn", text: `*Status:*\n${request.status}` },
              ],
            },
          ],
        }),
      }).catch(() => {});
    }

    return NextResponse.json({ request });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create request";
    const status = message === "Unauthorized" ? 401 : 500;
    logError("hosted_mac.request.post.error", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status });
  }
}
