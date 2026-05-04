import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";
import { hashRequestValue, signedArtifactUrl } from "@/lib/downloads/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function licenseAllowsUpdates(row: Record<string, unknown>): boolean {
  const status = row.status;
  const validUntil = typeof row.valid_until === "string" ? new Date(row.valid_until).getTime() : 0;
  return (status === "active" || status === "past_due") && validUntil >= Date.now();
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({ userId: user.id, admin });
  const workspaceId = membership?.workspace_id || null;
  const { data: license } = workspaceId
    ? await admin
        .from("licenses")
        .select("id, organization_id, license_type, status, valid_until, fallback_allowed")
        .eq("workspace_id", workspaceId)
        .order("valid_until", { ascending: false })
        .limit(1)
        .maybeSingle()
    : await admin
        .from("licenses")
        .select("id, organization_id, license_type, status, valid_until, fallback_allowed")
        .eq("user_id", user.id)
        .order("valid_until", { ascending: false })
        .limit(1)
        .maybeSingle();

  if (!license) {
    return NextResponse.json({ licensed: false, downloads: [], sourceSnapshots: [] });
  }

  const licenseRow = license as Record<string, unknown>;
  const canReceiveUpdates = licenseAllowsUpdates(licenseRow);
  if (!canReceiveUpdates) {
    return NextResponse.json({
      licensed: true,
      canReceiveUpdates: false,
      licenseStatus: licenseRow.status,
      downloads: [],
      sourceSnapshots: [],
      message: "This license cannot access new downloads or source snapshots.",
    });
  }

  const licenseType = String(licenseRow.license_type || "personal");
  const [{ data: downloads }, { data: sourceSnapshots }] = await Promise.all([
    admin
      .from("downloads")
      .select("id, version, channel, platform, file_url, checksum, release_notes_url, created_at")
      .eq("is_active", true)
      .contains("license_type_allowed", [licenseType])
      .order("created_at", { ascending: false }),
    admin
      .from("source_snapshots")
      .select("id, version, channel, git_ref, archive_url, checksum, release_notes_url, public_mirror_after, created_at")
      .eq("is_active", true)
      .contains("license_type_allowed", [licenseType])
      .order("created_at", { ascending: false }),
  ]);

  const signedDownloads = await Promise.all(
    (downloads || []).map(async (download) => ({
      ...download,
      file_url: await signedArtifactUrl(admin, (download as Record<string, unknown>).file_url),
    }))
  );
  const signedSourceSnapshots = await Promise.all(
    (sourceSnapshots || []).map(async (snapshot) => ({
      ...snapshot,
      archive_url: await signedArtifactUrl(admin, (snapshot as Record<string, unknown>).archive_url),
    }))
  );

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    null;
  const userAgent = req.headers.get("user-agent");
  const organizationId =
    typeof licenseRow.organization_id === "string" ? licenseRow.organization_id : null;
  await Promise.all([
    ...signedDownloads.map((download) =>
      admin.from("download_events").insert({
        organization_id: organizationId,
        license_id: String(licenseRow.id),
        user_id: user.id,
        download_id: download.id,
        ip_hash: hashRequestValue(ip),
        user_agent_hash: hashRequestValue(userAgent),
      })
    ),
    ...signedSourceSnapshots.map((snapshot) =>
      admin.from("download_events").insert({
        organization_id: organizationId,
        license_id: String(licenseRow.id),
        user_id: user.id,
        source_snapshot_id: snapshot.id,
        ip_hash: hashRequestValue(ip),
        user_agent_hash: hashRequestValue(userAgent),
      })
    ),
  ]).catch(() => {});

  return NextResponse.json({
    licensed: true,
    canReceiveUpdates: true,
    licenseStatus: licenseRow.status,
    downloads: signedDownloads,
    sourceSnapshots: signedSourceSnapshots,
  });
}
