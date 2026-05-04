import { NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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

function generatePairingCode() {
  const raw = randomBytes(8).toString("hex").toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function sha256Hex(s: string) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * POST /api/admin/hosted-macs/pairing-code
 * Generate a pairing code for a hosted Mac request's user
 */
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const user = await getAuthedUser();
    if (!isAllowedEmail(user.email)) {
      logWarn("hosted_mac.pairing_code.forbidden", { user_id: user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as { request_id?: string } | null;
    if (!body?.request_id) {
      logWarn("hosted_mac.pairing_code.missing_request_id", { user_id: user.id });
      return NextResponse.json({ error: "Missing request_id" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();

    // Get the requesting user from the hosted mac request
    const { data: request } = await supabase
      .from("hosted_mac_requests")
      .select("requested_by_user_id")
      .eq("id", body.request_id)
      .single();

    if (!request?.requested_by_user_id) {
      logWarn("hosted_mac.pairing_code.request_not_found", {
        request_id: body.request_id,
        user_id: user.id,
      });
      return NextResponse.json({ error: "Request not found" }, { status: 404 });
    }

    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min for hosted Macs
    const codeHash = sha256Hex(code);

    const { error: insertError } = await supabase.from("device_pairing_codes").insert({
      code,
      code_hash: codeHash,
      user_id: request.requested_by_user_id,
      expires_at: expiresAt,
    });

    if (insertError) {
      logError("hosted_mac.pairing_code.insert_failed", {
        request_id: body.request_id,
        requested_by_user_id: request.requested_by_user_id,
        error: insertError.message,
        duration_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    logInfo("hosted_mac.pairing_code.ok", {
      request_id: body.request_id,
      requested_by_user_id: request.requested_by_user_id,
      expires_at: expiresAt,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ code, expires_at: expiresAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate pairing code";
    logError("hosted_mac.pairing_code.error", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
