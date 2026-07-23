import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { isSelfHosted } from "@/lib/config/edition";

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

type Body = {
  phone_e164?: string;
};

export async function GET() {
  if (isSelfHosted()) {
    return NextResponse.json(
      { error: "Company WhatsApp is unavailable in the self-hosted edition" },
      { status: 404 },
    );
  }
  try {
    const user = await getAuthedUser();
    const admin = createSupabaseAdminClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .single();
    if (!membership) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    if (membership.role === "guest") {
      return NextResponse.json(
        { error: "Workspace settings are not available to channel guests" },
        { status: 403 },
      );
    }

    const { data } = await admin
      .from("workspace_member_phones")
      .select("phone_e164, verified_at, verification_code")
      .eq("workspace_id", membership.workspace_id)
      .eq("user_id", user.id)
      .single();
    return NextResponse.json({ phone: data || null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load phone";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  if (isSelfHosted()) {
    return NextResponse.json(
      { error: "Company WhatsApp is unavailable in the self-hosted edition" },
      { status: 404 },
    );
  }
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
    if (!membership) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    if (membership.role === "guest") {
      return NextResponse.json(
        { error: "Workspace settings are not available to channel guests" },
        { status: 403 },
      );
    }

    const code = generateCode();
    const { data, error } = await admin
      .from("workspace_member_phones")
      .upsert({
        workspace_id: membership.workspace_id,
        user_id: user.id,
        phone_e164: body.phone_e164.trim(),
        verification_code: code,
        verified_at: null,
        updated_at: new Date().toISOString(),
      })
      .select("phone_e164, verified_at, verification_code")
      .single();
    if (error || !data) {
      return NextResponse.json({ error: error?.message || "Failed to save phone" }, { status: 500 });
    }
    return NextResponse.json({ phone: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save phone";
    const status = message === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
