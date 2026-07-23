import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createHmac, timingSafeEqual } from "crypto";
import { logError, logInfo, logWarn } from "@/lib/observability/log";
import { isSelfHosted } from "@/lib/config/edition";

/**
 * POST /api/whatsapp/kapso/phone-connected
 * Kapso project webhook for `whatsapp.phone_number.created` events.
 * This is the reliable server-to-server notification when a customer completes setup.
 */

type WebhookPayload = {
  event?: string;
  data?: {
    phone_number_id?: string;
    customer?: { id?: string };
    project?: { id?: string };
    display_phone_number?: string;
    business_account_id?: string;
  };
};

function getKapsoSignature(req: Request) {
  const sig = (req.headers.get("x-webhook-signature") || "").trim();
  if (!sig) return null;
  if (sig.toLowerCase().startsWith("sha256=")) return sig.slice("sha256=".length).trim();
  return sig;
}

function verifyKapsoSignature(args: { rawBody: string; signatureHex: string; secret: string }) {
  const expectedHex = createHmac("sha256", args.secret)
    .update(args.rawBody, "utf8")
    .digest("hex");
  try {
    const a = Buffer.from(args.signatureHex, "hex");
    const b = Buffer.from(expectedHex, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (isSelfHosted()) {
    return NextResponse.json(
      { error: "Kapso webhooks are unavailable in the self-hosted edition" },
      { status: 404 },
    );
  }
  const startedAt = Date.now();
  try {
    const rawBody = await req.text();
    const signatureHex = getKapsoSignature(req);
    const webhookEvent = (req.headers.get("x-webhook-event") || "").trim() || null;
    const idempotencyKey = (req.headers.get("x-idempotency-key") || "").trim() || null;
    const payloadVersion = (req.headers.get("x-webhook-payload-version") || "").trim() || null;
    if (!signatureHex) {
      logWarn("kapso.phone_connected.missing_signature", { webhook_event: webhookEvent, idempotency_key: idempotencyKey });
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }
    const secret = (process.env.KAPSO_WEBHOOK_SECRET || "").trim();
    if (!secret) {
      logError("kapso.phone_connected.misconfigured_missing_secret", {
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
      });
      return NextResponse.json({ error: "Missing KAPSO_WEBHOOK_SECRET" }, { status: 500 });
    }
    const valid = verifyKapsoSignature({ rawBody, signatureHex, secret });
    if (!valid) {
      logWarn("kapso.phone_connected.invalid_signature", { webhook_event: webhookEvent, idempotency_key: idempotencyKey });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const body = (JSON.parse(rawBody || "null") as WebhookPayload | null) || null;
    if (!body) {
      logWarn("kapso.phone_connected.invalid_payload", { webhook_event: webhookEvent, idempotency_key: idempotencyKey });
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    // Only handle phone_number.created events
    if (body.event !== "whatsapp.phone_number.created") {
      logInfo("kapso.phone_connected.ignored_event", {
        event: body.event || null,
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
        payload_version: payloadVersion,
        duration_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ ok: true, ignored: true });
    }

    const phoneNumberId = body.data?.phone_number_id;
    const kapsoCustomerId = body.data?.customer?.id;
    const displayPhoneNumber = body.data?.display_phone_number;
    const businessAccountId = body.data?.business_account_id;

    if (!kapsoCustomerId) {
      logWarn("kapso.phone_connected.missing_customer_id", {
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
      });
      return NextResponse.json({ error: "Missing customer ID" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();

    // Find workspace by Kapso customer ID
    const { data: row } = await supabase
      .from("workspace_company_whatsapp")
      .select("workspace_id")
      .eq("kapso_customer_id", kapsoCustomerId)
      .single();

    if (!row?.workspace_id) {
      logWarn("kapso.phone_connected.unknown_customer", {
        kapso_customer_id: kapsoCustomerId,
        phone_number_id: phoneNumberId || null,
        webhook_event: webhookEvent,
        idempotency_key: idempotencyKey,
      });
      return NextResponse.json({ error: "Unknown customer" }, { status: 404 });
    }

    const updates: Record<string, unknown> = {
      status: "active",
      updated_at: new Date().toISOString(),
    };
    if (phoneNumberId) {
      updates.phone_number_id = phoneNumberId;
      updates.kapso_phone_number_id = phoneNumberId;
    }
    if (displayPhoneNumber) updates.display_phone_number = displayPhoneNumber;
    if (businessAccountId) updates.business_account_id = businessAccountId;

    await supabase
      .from("workspace_company_whatsapp")
      .update(updates)
      .eq("workspace_id", row.workspace_id);

    logInfo("kapso.phone_connected.ok", {
      workspace_id: row.workspace_id,
      kapso_customer_id: kapsoCustomerId,
      phone_number_id: phoneNumberId || null,
      display_phone_number_present: !!displayPhoneNumber,
      business_account_id_present: !!businessAccountId,
      webhook_event: webhookEvent,
      idempotency_key: idempotencyKey,
      payload_version: payloadVersion,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook error";
    logError("kapso.phone_connected.error", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
