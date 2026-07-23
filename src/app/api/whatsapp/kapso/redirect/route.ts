import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { logError, logInfo, logWarn } from "@/lib/observability/log";
import { isSelfHosted } from "@/lib/config/edition";

export async function GET(req: Request) {
  if (isSelfHosted()) {
    return NextResponse.json(
      { error: "Kapso redirects are unavailable in the self-hosted edition" },
      { status: 404 },
    );
  }
  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(req.url);
    const setupLinkId = searchParams.get("setup_link_id");
    const status = searchParams.get("status");

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
      // The redirect is browser-controlled. The signed Kapso webhook is the only
      // trusted source for phone number IDs and active status.
      status: "pending",
      updated_at: new Date().toISOString(),
    };

    await supabase
      .from("workspace_company_whatsapp")
      .update(updates)
      .eq("workspace_id", row.workspace_id);

    logInfo("kapso.redirect.ok", {
      workspace_id: row.workspace_id,
      setup_link_id: setupLinkId,
      status,
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
    return NextResponse.json({ error: "Failed to handle redirect" }, { status: 500 });
  }
}
