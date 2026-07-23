import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import { logError, logInfo, logWarn } from "@/lib/observability/log";
import { isSelfHosted } from "@/lib/config/edition";

type Body = {
  request_id?: string;
};

/**
 * Called by the connector running on a hosted Mac after it pairs.
 * Auth is via X-Device-Token (relay JWT). This lets us associate:
 * hosted_mac_requests -> hosted_devices (workspace_id, request_id, device_id)
 * and update request status.
 */
export async function POST(req: Request) {
  if (isSelfHosted()) {
    return NextResponse.json(
      { error: "Groovy-hosted Macs are unavailable in the self-hosted edition" },
      { status: 404 },
    );
  }
  const startedAt = Date.now();
  try {
    const deviceToken = req.headers.get("x-device-token") || "";
    if (!deviceToken) {
      logWarn("hosted_mac.register_device.missing_device_token");
      return NextResponse.json({ error: "Missing X-Device-Token" }, { status: 401 });
    }
    const secret = process.env.RELAY_JWT_SECRET || "";
    if (!secret) {
      logError("hosted_mac.register_device.misconfigured_missing_secret");
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    }

    const verified = verifyRelayDeviceToken(deviceToken, secret);
    if (!verified) {
      logWarn("hosted_mac.register_device.invalid_device_token");
      return NextResponse.json({ error: "Invalid device token" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body?.request_id) {
      logWarn("hosted_mac.register_device.missing_request_id", {
        device_id: verified.deviceId,
        user_id: verified.userId,
      });
      return NextResponse.json({ error: "Missing request_id" }, { status: 400 });
    }

    const admin = createSupabaseAdminClient();
    const { data: request } = await admin
      .from("hosted_mac_requests")
      .select("id, workspace_id, requested_by_user_id, status")
      .eq("id", body.request_id)
      .single();

    if (!request) {
      logWarn("hosted_mac.register_device.request_not_found", {
        request_id: body.request_id,
        device_id: verified.deviceId,
        user_id: verified.userId,
      });
      return NextResponse.json({ error: "Request not found" }, { status: 404 });
    }

    // Only allow the device that paired under the requesting user to bind itself.
    if (String(request.requested_by_user_id) !== String(verified.userId)) {
      logWarn("hosted_mac.register_device.forbidden_user_mismatch", {
        request_id: request.id,
        workspace_id: request.workspace_id,
        requested_by_user_id: request.requested_by_user_id,
        device_user_id: verified.userId,
        device_id: verified.deviceId,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Upsert hosted device mapping (enables workspace members to use it).
    await admin
      .from("hosted_devices")
      .upsert(
        {
          workspace_id: request.workspace_id,
          request_id: request.id,
          device_id: verified.deviceId,
        },
        { onConflict: "workspace_id,device_id" }
      );

    // Flip status so the UI can show "online" as soon as it pairs.
    await admin
      .from("hosted_mac_requests")
      .update({
        status: "connector_online",
        status_detail: "Connector paired and connected",
        updated_at: new Date().toISOString(),
      })
      .eq("id", request.id);

    logInfo("hosted_mac.register_device.ok", {
      request_id: request.id,
      workspace_id: request.workspace_id,
      device_id: verified.deviceId,
      user_id: verified.userId,
      prev_status: request.status,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: true, device_id: verified.deviceId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to register device";
    logError("hosted_mac.register_device.error", {
      duration_ms: Date.now() - startedAt,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
