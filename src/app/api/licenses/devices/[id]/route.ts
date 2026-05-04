import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceMembershipsForUser } from "@/lib/billing/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing device id" }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createSupabaseAdminClient();
  const memberships = await getWorkspaceMembershipsForUser({ userId: user.id, admin });
  const membershipByWorkspace = new Map(memberships.map((membership) => [membership.workspace_id, membership]));

  const { data: device, error } = await admin
    .from("license_devices")
    .select("id, license_id, licenses!inner(id, user_id, workspace_id, status)")
    .eq("id", id)
    .maybeSingle();
  if (error || !device) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const license = Array.isArray((device as Record<string, unknown>).licenses)
    ? ((device as Record<string, unknown>).licenses as Record<string, unknown>[])[0]
    : ((device as Record<string, unknown>).licenses as Record<string, unknown> | null);
  const ownsLicense =
    license?.user_id === user.id ||
    (typeof license?.workspace_id === "string" &&
      membershipByWorkspace.get(license.workspace_id)?.role === "admin");
  if (!ownsLicense) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (license?.status !== "active" && license?.status !== "past_due") {
    return NextResponse.json(
      { error: "Device resets are available only for active licenses" },
      { status: 403 }
    );
  }

  const { error: updateErr } = await admin
    .from("license_devices")
    .update({ deactivated_at: new Date().toISOString() })
    .eq("id", id);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
