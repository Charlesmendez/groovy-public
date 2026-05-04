import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type KapsoWebhookBody = {
  event?: string;
  data?: {
    phone_number_id?: string;
    customer?: { id?: string };
  };
};

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as KapsoWebhookBody | null;
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
    const message = err instanceof Error ? err.message : "Webhook error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
