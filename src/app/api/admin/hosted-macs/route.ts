import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { encryptLlmApiKey } from "@/lib/crypto/llmKey";
import { getAuthedUser } from "@/lib/workspaces";
import { logError, logInfo, logWarn } from "@/lib/observability/log";

function isAllowedEmail(email?: string | null) {
  const allowlist = process.env.HOSTED_MAC_ADMIN_EMAILS || "";
  if (!email || !allowlist.trim()) return false;
  const allowed = allowlist
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}

async function notifySlack(payload: Record<string, unknown>) {
  const webhook = process.env.HOSTED_MACS_SLACK_WEBHOOK_URL;
  if (!webhook) return;
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

export async function GET() {
  const startedAt = Date.now();
  try {
    const user = await getAuthedUser();
    if (!isAllowedEmail(user.email)) {
      logWarn("hosted_mac.admin.get.forbidden", { user_id: user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const admin = createSupabaseAdminClient();
    const { data: requests, error } = await admin
      .from("hosted_mac_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const requestIds = (requests || []).map((r) => r.id);
    const { data: assignments } = requestIds.length
      ? await admin
          .from("hosted_mac_assignments")
          .select("id, request_id, provider, hostname, ssh_port, ssh_user, created_at, updated_at")
          .in("request_id", requestIds)
      : { data: [] as unknown[] };

    logInfo("hosted_mac.admin.get.ok", {
      user_id: user.id,
      requests_count: (requests || []).length,
      assignments_count: (assignments || []).length,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ requests: requests || [], assignments: assignments || [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load admin requests";
    const status = message === "Unauthorized" ? 401 : 500;
    logError("hosted_mac.admin.get.error", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status });
  }
}

type UpsertBody = {
  request_id?: string;
  provider?: string;
  hostname?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_private_key?: string;
  ssh_password?: string;
  mark_status?: string;
  device_id?: string;
};

export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const user = await getAuthedUser();
    if (!isAllowedEmail(user.email)) {
      logWarn("hosted_mac.admin.post.forbidden", { user_id: user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const body = (await req.json().catch(() => null)) as UpsertBody | null;
    if (!body || !body.request_id) {
      logWarn("hosted_mac.admin.post.missing_request_id", { user_id: user.id });
      return NextResponse.json({ error: "Missing request_id" }, { status: 400 });
    }
    if (!body.provider || !body.hostname || !body.ssh_user) {
      logWarn("hosted_mac.admin.post.missing_fields", {
        user_id: user.id,
        request_id: body.request_id,
        has_provider: !!body.provider,
        has_hostname: !!body.hostname,
        has_ssh_user: !!body.ssh_user,
      });
      return NextResponse.json({ error: "Missing provider/hostname/ssh_user" }, { status: 400 });
    }

    const admin = createSupabaseAdminClient();
    const payload: Record<string, unknown> = {
      request_id: body.request_id,
      provider: body.provider,
      hostname: body.hostname,
      ssh_port: typeof body.ssh_port === "number" ? body.ssh_port : 22,
      ssh_user: body.ssh_user,
      updated_at: new Date().toISOString(),
    };
    if (typeof body.ssh_private_key === "string" && body.ssh_private_key.trim()) {
      payload.ssh_private_key_enc = encryptLlmApiKey(body.ssh_private_key.trim());
    }
    if (typeof body.ssh_password === "string" && body.ssh_password.trim()) {
      payload.ssh_password_enc = encryptLlmApiKey(body.ssh_password.trim());
    }

    const { data: existing } = await admin
      .from("hosted_mac_assignments")
      .select("id")
      .eq("request_id", body.request_id)
      .limit(1);

    const upsert = existing && existing.length > 0 ? "update" : "insert";
    const { data: assignment, error } =
      upsert === "insert"
        ? await admin
            .from("hosted_mac_assignments")
            .insert(payload)
            .select("id, request_id, provider, hostname, ssh_port, ssh_user, created_at, updated_at")
            .single()
        : await admin
            .from("hosted_mac_assignments")
            .update(payload)
            .eq("request_id", body.request_id)
            .select("id, request_id, provider, hostname, ssh_port, ssh_user, created_at, updated_at")
            .single();

    if (error || !assignment) {
      logError("hosted_mac.admin.post.save_assignment_failed", {
        user_id: user.id,
        request_id: body.request_id,
        provider: body.provider,
        hostname: body.hostname,
        ssh_port: typeof body.ssh_port === "number" ? body.ssh_port : 22,
        ssh_user: body.ssh_user,
        has_private_key: !!(body.ssh_private_key && body.ssh_private_key.trim()),
        has_password: !!(body.ssh_password && body.ssh_password.trim()),
        error: error?.message || "save_failed",
        duration_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ error: error?.message || "Failed to save assignment" }, { status: 500 });
    }

    if (body.mark_status) {
      await admin
        .from("hosted_mac_requests")
        .update({ status: body.mark_status, updated_at: new Date().toISOString() })
        .eq("id", body.request_id);
      await notifySlack({
        text: `Groovy Mac status updated: ${body.mark_status}`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Groovy Mac status updated*` },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Request ID:*\n${body.request_id}` },
              { type: "mrkdwn", text: `*Status:*\n${body.mark_status}` },
            ],
          },
        ],
      });
      logInfo("hosted_mac.admin.post.mark_status", {
        user_id: user.id,
        request_id: body.request_id,
        status: body.mark_status,
      });
    }

    if (typeof body.device_id === "string" && body.device_id.trim()) {
      const { data: reqRow } = await admin
        .from("hosted_mac_requests")
        .select("workspace_id")
        .eq("id", body.request_id)
        .single();
      if (reqRow?.workspace_id) {
        await admin
          .from("hosted_devices")
          .upsert({
            workspace_id: reqRow.workspace_id,
            request_id: body.request_id,
            device_id: body.device_id.trim(),
          }, { onConflict: "workspace_id,device_id" });
      }
      logInfo("hosted_mac.admin.post.bound_device", {
        user_id: user.id,
        request_id: body.request_id,
        device_id: body.device_id.trim(),
        workspace_id: reqRow?.workspace_id || null,
      });
    }

    logInfo("hosted_mac.admin.post.ok", {
      user_id: user.id,
      request_id: body.request_id,
      provider: body.provider,
      hostname: body.hostname,
      ssh_port: typeof body.ssh_port === "number" ? body.ssh_port : 22,
      ssh_user: body.ssh_user,
      upsert: existing && existing.length > 0 ? "update" : "insert",
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ assignment });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save assignment";
    const status = message === "Unauthorized" ? 401 : 500;
    logError("hosted_mac.admin.post.error", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status });
  }
}
