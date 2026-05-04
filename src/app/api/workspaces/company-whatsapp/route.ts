import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { createKapsoCustomer, createKapsoSetupLink } from "@/lib/whatsapp/kapso";
import { logError, logInfo, logWarn } from "@/lib/observability/log";
import { syncWorkspaceAddonSubscription } from "@/lib/billing/addons";

type Body = {
  action?: "request" | "update" | "setup_link";
  kapso_phone_number_id?: string;
};

export async function GET() {
  const startedAt = Date.now();
  try {
    const user = await getAuthedUser();
    const admin = createSupabaseAdminClient();
    const { data: membership, error: memberErr } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (memberErr || !membership) {
      logWarn("kapso.company_whatsapp.get.no_workspace", { user_id: user.id });
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    const { data, error } = await admin
      .from("workspace_company_whatsapp")
      .select("*")
      .eq("workspace_id", membership.workspace_id)
      .single();
    if (error && error.code !== "PGRST116") {
      logError("kapso.company_whatsapp.get.db_error", {
        user_id: user.id,
        workspace_id: membership.workspace_id,
        error: error.message,
        duration_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    logInfo("kapso.company_whatsapp.get.ok", {
      user_id: user.id,
      workspace_id: membership.workspace_id,
      has_row: !!data,
      status: data?.status ? String(data.status) : null,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ companyWhatsapp: data || null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load company WhatsApp";
    const status = message === "Unauthorized" ? 401 : 500;
    logError("kapso.company_whatsapp.get.error", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as Body | null;
    const admin = createSupabaseAdminClient();
    const { data: membership, error: memberErr } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (memberErr || !membership) {
      logWarn("kapso.company_whatsapp.post.no_workspace", { user_id: user.id });
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role !== "admin") {
      logWarn("kapso.company_whatsapp.post.forbidden_not_admin", {
        user_id: user.id,
        workspace_id: membership.workspace_id,
        action: body?.action || null,
      });
      return NextResponse.json({ error: "Only admins can manage company WhatsApp" }, { status: 403 });
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      workspace_id: membership.workspace_id,
      updated_at: now,
    };
    if (body?.action === "setup_link") {
      logInfo("kapso.company_whatsapp.setup_link.start", {
        user_id: user.id,
        workspace_id: membership.workspace_id,
      });
      const addonSync = await syncWorkspaceAddonSubscription({
        workspaceId: membership.workspace_id,
        userId: user.id,
        userEmail: user.email || null,
        enableKapsoAllowlist: true,
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
        logWarn("kapso.company_whatsapp.setup_link.billing_blocked", {
          user_id: user.id,
          workspace_id: membership.workspace_id,
          reason: addonSync.reason,
          message: addonSync.message,
          duration_ms: Date.now() - startedAt,
        });
        return NextResponse.json(
          { error: addonSync.message, code: addonSync.reason },
          { status }
        );
      }

      const { data: workspace } = await admin
        .from("workspaces")
        .select("id, name")
        .eq("id", membership.workspace_id)
        .single();

      const { data: existing } = await admin
        .from("workspace_company_whatsapp")
        .select("*")
        .eq("workspace_id", membership.workspace_id)
        .single();

      let kapsoCustomerId = existing?.kapso_customer_id as string | null;
      if (!kapsoCustomerId) {
        const created = await createKapsoCustomer({
          name: workspace?.name || `Workspace ${membership.workspace_id}`,
          externalCustomerId: membership.workspace_id,
        });
        kapsoCustomerId =
          (created?.data?.id as string | undefined) ||
          (created?.id as string | undefined) ||
          null;
      }
      if (!kapsoCustomerId) {
        logError("kapso.company_whatsapp.setup_link.create_customer_failed", {
          workspace_id: membership.workspace_id,
          user_id: user.id,
          duration_ms: Date.now() - startedAt,
        });
        return NextResponse.json({ error: "Failed to create Kapso customer" }, { status: 500 });
      }

      const setup = await createKapsoSetupLink({
        customerId: kapsoCustomerId,
        connectionTypes: ["dedicated"],
        provisionPhoneNumber: true,
      });
      const setupLinkId =
        (setup?.data?.id as string | undefined) ||
        (setup?.setup_link?.id as string | undefined) ||
        null;
      const setupLinkUrl =
        (setup?.data?.url as string | undefined) ||
        (setup?.setup_link?.url as string | undefined) ||
        (setup?.url as string | undefined) ||
        null;

      updates.status = "pending";
      updates.kapso_customer_id = kapsoCustomerId;
      if (setupLinkId) updates.setup_link_id = setupLinkId;
      if (setupLinkUrl) updates.setup_link_url = setupLinkUrl;

      const { data, error } = await admin
        .from("workspace_company_whatsapp")
        .upsert(updates, { onConflict: "workspace_id" })
        .select("*")
        .single();
      if (error || !data) {
        logError("kapso.company_whatsapp.setup_link.save_failed", {
          workspace_id: membership.workspace_id,
          user_id: user.id,
          kapso_customer_id: kapsoCustomerId,
          setup_link_id: setupLinkId,
          error: error?.message || "save_failed",
          duration_ms: Date.now() - startedAt,
        });
        return NextResponse.json({ error: error?.message || "Failed to save setup link" }, { status: 500 });
      }
      logInfo("kapso.company_whatsapp.setup_link.ok", {
        workspace_id: membership.workspace_id,
        user_id: user.id,
        kapso_customer_id: kapsoCustomerId,
        setup_link_id: setupLinkId,
        setup_link_url_present: !!setupLinkUrl,
        duration_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ companyWhatsapp: data, setupLinkUrl });
    }

    if (body?.action === "request") {
      updates.status = "pending";
    }
    if (typeof body?.kapso_phone_number_id === "string" && body.kapso_phone_number_id.trim()) {
      updates.kapso_phone_number_id = body.kapso_phone_number_id.trim();
      updates.status = "active";
    }

    const { data, error } = await admin
      .from("workspace_company_whatsapp")
      .upsert(updates, { onConflict: "workspace_id" })
      .select("*")
      .single();
    if (error || !data) {
      logError("kapso.company_whatsapp.post.save_failed", {
        workspace_id: membership.workspace_id,
        user_id: user.id,
        action: body?.action || null,
        error: error?.message || "save_failed",
        duration_ms: Date.now() - startedAt,
      });
      return NextResponse.json({ error: error?.message || "Failed to update company WhatsApp" }, { status: 500 });
    }
    logInfo("kapso.company_whatsapp.post.ok", {
      workspace_id: membership.workspace_id,
      user_id: user.id,
      action: body?.action || null,
      status: data?.status ? String(data.status) : null,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ companyWhatsapp: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update company WhatsApp";
    const status = message === "Unauthorized" ? 401 : 500;
    logError("kapso.company_whatsapp.post.error", {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status });
  }
}
