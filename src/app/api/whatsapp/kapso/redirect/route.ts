import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { logError, logInfo, logWarn } from "@/lib/observability/log";

export async function GET(req: Request) {
  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(req.url);
    const setupLinkId = searchParams.get("setup_link_id");
    const status = searchParams.get("status");
    const phoneNumberId = searchParams.get("phone_number_id");
    const businessAccountId = searchParams.get("business_account_id");
    const provisionedPhoneNumberId = searchParams.get("provisioned_phone_number_id");
    const displayPhoneNumber = searchParams.get("display_phone_number");

    if (!setupLinkId || !status) {
      logWarn("kapso.redirect.missing_params", {
        setup_link_id_present: !!setupLinkId,
        status_present: !!status,
      });
      return NextResponse.json({ error: "missing params" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { data: row } = await supabase
      .from("workspace_company_whatsapp")
      .select("workspace_id")
      .eq("setup_link_id", setupLinkId)
      .single();

    if (!row?.workspace_id) {
      logWarn("kapso.redirect.setup_link_not_found", {
        setup_link_id: setupLinkId,
        status,
      });
      return NextResponse.json({ error: "setup link not found" }, { status: 404 });
    }

    const updates: Record<string, unknown> = {
      status: status === "completed" ? "active" : "pending",
      updated_at: new Date().toISOString(),
    };
    if (phoneNumberId) {
      updates.phone_number_id = phoneNumberId;
      updates.kapso_phone_number_id = phoneNumberId;
    }
    if (businessAccountId) updates.business_account_id = businessAccountId;
    if (provisionedPhoneNumberId) updates.provisioned_phone_number_id = provisionedPhoneNumberId;
    if (displayPhoneNumber) updates.display_phone_number = decodeURIComponent(displayPhoneNumber);

    await supabase
      .from("workspace_company_whatsapp")
      .update(updates)
      .eq("workspace_id", row.workspace_id);

    logInfo("kapso.redirect.ok", {
      workspace_id: row.workspace_id,
      setup_link_id: setupLinkId,
      status,
      phone_number_id_present: !!phoneNumberId,
      business_account_id_present: !!businessAccountId,
      provisioned_phone_number_id_present: !!provisionedPhoneNumberId,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to handle redirect";
    logError("kapso.redirect.error", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
