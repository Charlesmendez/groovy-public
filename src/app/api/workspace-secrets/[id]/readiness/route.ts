import { NextResponse } from "next/server";
import { requireWorkspaceSecretAdmin, workspaceSecretError } from "@/lib/workspace-secrets/context";
export const runtime = "nodejs";
type Params = { params: Promise<{ id: string }> };
export async function PUT(req: Request, { params }: Params) {
  try {
    const { id } = await params; const { admin, user, workspaceId } = await requireWorkspaceSecretAdmin();
    const body = await req.json().catch(() => null) as { deviceId?: unknown; configured?: unknown } | null;
    const deviceId = String(body?.deviceId || ""); const configured = body?.configured === true;
    const { data: device } = await admin.from("devices").select("id").eq("id", deviceId).eq("user_id", user.id).maybeSingle();
    const { data: secret } = await admin.from("workspace_secret_definitions").select("id").eq("id", id).eq("workspace_id", workspaceId).maybeSingle();
    if (!device || !secret) return NextResponse.json({ error: "Secret or device not found" }, { status: 404 });
    const now = new Date().toISOString();
    const { error } = await admin.from("workspace_secret_device_readiness").upsert({ workspace_id: workspaceId, secret_id: id, device_id: deviceId, configured, configured_at: configured ? now : null, updated_at: now }, { onConflict: "secret_id,device_id" });
    if (error) throw error; return NextResponse.json({ ok: true });
  } catch (error) { const out = workspaceSecretError(error, "Failed to update readiness"); return NextResponse.json({ error: out.message }, { status: out.status }); }
}
