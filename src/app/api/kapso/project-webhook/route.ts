import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createHmac, timingSafeEqual } from "crypto";

type KapsoWebhookBody = {
  event?: string;
  data?: {
    phone_number_id?: string;
    customer?: { id?: string };
  };
};

function getKapsoSignature(req: Request) {
  const sig = (req.headers.get("x-webhook-signature") || "").trim();
  if (!sig) return null;
  return sig.toLowerCase().startsWith("sha256=") ? sig.slice("sha256=".length).trim() : sig;
}

function verifyKapsoSignature(rawBody: string, signatureHex: string, secret: string) {
  const expectedHex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  try {
    const actual = Buffer.from(signatureHex, "hex");
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const secret = (process.env.KAPSO_WEBHOOK_SECRET || "").trim();
    const signatureHex = getKapsoSignature(req);
    if (!secret || !signatureHex || !verifyKapsoSignature(rawBody, signatureHex, secret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (JSON.parse(rawBody || "null") as KapsoWebhookBody | null) || null;
    if (!body?.event) return NextResponse.json({ ok: true });

    if (body.event === "whatsapp.phone_number.created") {
      const phoneNumberId = body.data?.phone_number_id;
      const customerId = body.data?.customer?.id;
      if (!phoneNumberId || !customerId) {
        return NextResponse.json({ ok: true });
      }

      const supabase = createSupabaseAdminClient();
      await supabase
        .from("workspace_company_whatsapp")
        .update({
          status: "active",
          phone_number_id: phoneNumberId,
          kapso_phone_number_id: phoneNumberId,
          updated_at: new Date().toISOString(),
        })
        .eq("kapso_customer_id", customerId);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[kapso-project-webhook] failed", err);
    return NextResponse.json({ error: "Webhook error" }, { status: 500 });
  }
}
