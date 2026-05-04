import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { syncWorkspaceAddonSubscriptionBestEffort } from "@/lib/billing/addons";

type Body = {
  phone_e164?: string;
  user_id?: string;
};

export async function GET() {
  try {
    const user = await getAuthedUser();
    const admin = createSupabaseAdminClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (!membership) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    const { data, error } = await admin
      .from("workspace_whatsapp_allowlist")
      .select("workspace_id, phone_e164, user_id, created_at")
      .eq("workspace_id", membership.workspace_id)
      .order("created_at", { ascending: false });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ allowlist: data || [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load allowlist";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getAuthedUser();
    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body?.phone_e164) {
      return NextResponse.json({ error: "phone_e164 required" }, { status: 400 });
    }
    const admin = createSupabaseAdminClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (!membership) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role !== "admin") {
      return NextResponse.json({ error: "Only admins can update allowlist" }, { status: 403 });
    }
    const { data, error } = await admin
      .from("workspace_whatsapp_allowlist")
      .upsert({
        workspace_id: membership.workspace_id,
        phone_e164: body.phone_e164,
        user_id: body.user_id || null,
        created_by_user_id: user.id,
      })
      .select("workspace_id, phone_e164, user_id, created_at")
      .single();
    if (error || !data) {
      return NextResponse.json({ error: error?.message || "Failed to add" }, { status: 500 });
    }
    await syncWorkspaceAddonSubscriptionBestEffort({
      workspaceId: membership.workspace_id,
      userId: user.id,
      userEmail: user.email || null,
      admin,
      context: "allowlist_post",
    });
    return NextResponse.json({ entry: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update allowlist";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await getAuthedUser();
    const { searchParams } = new URL(req.url);
    const phone = searchParams.get("phone");
    if (!phone) {
      return NextResponse.json({ error: "phone required" }, { status: 400 });
    }
    const admin = createSupabaseAdminClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (!membership) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    if (membership.role !== "admin") {
      return NextResponse.json({ error: "Only admins can update allowlist" }, { status: 403 });
    }
    await admin
      .from("workspace_whatsapp_allowlist")
      .delete()
      .eq("workspace_id", membership.workspace_id)
      .eq("phone_e164", phone);
    await syncWorkspaceAddonSubscriptionBestEffort({
      workspaceId: membership.workspace_id,
      userId: user.id,
      userEmail: user.email || null,
      admin,
      context: "allowlist_delete",
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to remove";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
