import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";
import { signLicensePayload } from "@/lib/licensing/server";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({ userId: user.id, admin });
  const workspaceId = membership?.workspace_id || null;

  const query = admin
    .from("licenses")
    .select(
      "*, license_devices(id, device_hash, device_name, platform, app_version, activated_at, last_seen_at, deactivated_at)"
    )
    .order("valid_until", { ascending: false })
    .limit(1);

  const { data, error } = workspaceId
    ? await query.eq("workspace_id", workspaceId).maybeSingle()
    : await query.eq("user_id", user.id).maybeSingle();

  if (error || !data) {
    return NextResponse.json({
      licensed: false,
      status: "unlicensed",
      workspaceId,
    });
  }

  const row = data as Record<string, unknown>;
  const canManageLicense =
    row.user_id === user.id ||
    (membership?.role === "admin" && workspaceId && row.workspace_id === workspaceId);
  let licenseKey: string | null = null;
  if (canManageLicense && typeof row.license_key_enc === "string" && row.license_key_enc.trim()) {
    try {
      licenseKey = decryptLlmApiKey(row.license_key_enc);
    } catch {
      licenseKey = null;
    }
  }
  return NextResponse.json({
    licensed: true,
    workspaceId,
    license: signLicensePayload(row),
    licenseKey,
    devices: canManageLicense && Array.isArray(row.license_devices) ? row.license_devices : [],
    canManageLicense,
  });
}
