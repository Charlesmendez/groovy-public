import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceMembershipsForUser } from "@/lib/billing/state";
import { hashRequestValue, signedArtifactUrl } from "@/lib/downloads/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function licenseAllowsUpdates(row: Record<string, unknown>): boolean {
  const status = row.status;
  const validUntil = typeof row.valid_until === "string" ? new Date(row.valid_until).getTime() : 0;
  return (status === "active" || status === "past_due") && validUntil >= Date.now();
}

function licenseSortMs(row: Record<string, unknown>): number {
  const validUntil = typeof row.valid_until === "string" ? new Date(row.valid_until).getTime() : 0;
  const createdAt = typeof row.created_at === "string" ? new Date(row.created_at).getTime() : 0;
  return (Number.isFinite(validUntil) ? validUntil : 0) || (Number.isFinite(createdAt) ? createdAt : 0);
}

function isWorkspaceLicense(row: Record<string, unknown>): boolean {
  return row.license_type === "enterprise" || row.license_type === "enterprise_reseller";
}

function chooseLatestByScope(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const chosen = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const workspaceLicense = isWorkspaceLicense(row);
    const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id : "";
    const key = workspaceLicense ? `workspace:${workspaceId || String(row.id || "")}` : "personal";
    const existing = chosen.get(key);
    if (!existing || licenseSortMs(row) > licenseSortMs(existing)) {
      chosen.set(key, row);
    }
  }
  return Array.from(chosen.values()).sort((a, b) => licenseSortMs(b) - licenseSortMs(a));
}

function uniqueById<T extends Record<string, unknown>>(rows: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    const id = String(row.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(row);
  }
  return unique;
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createSupabaseAdminClient();
  const memberships = await getWorkspaceMembershipsForUser({ userId: user.id, admin });
  const workspaceIds = memberships.map((membership) => membership.workspace_id).filter(Boolean);
  const { data: personalRows, error: personalErr } = await admin
    .from("licenses")
    .select("id, organization_id, workspace_id, user_id, license_type, status, valid_until, fallback_allowed, created_at")
    .eq("user_id", user.id)
    .order("valid_until", { ascending: false });
  if (personalErr) return NextResponse.json({ error: personalErr.message }, { status: 500 });

  let workspaceRows: Record<string, unknown>[] = [];
  if (workspaceIds.length > 0) {
    const { data, error } = await admin
      .from("licenses")
      .select("id, organization_id, workspace_id, user_id, license_type, status, valid_until, fallback_allowed, created_at")
      .in("workspace_id", workspaceIds)
      .order("valid_until", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    workspaceRows = (data || []) as Record<string, unknown>[];
  }

  const licenseRows = chooseLatestByScope([
    ...((personalRows || []) as Record<string, unknown>[]),
    ...workspaceRows,
  ]);

  if (licenseRows.length === 0) {
    return NextResponse.json({ licensed: false, downloads: [], sourceSnapshots: [] });
  }

  const activeLicenses = licenseRows.filter(licenseAllowsUpdates);
  if (activeLicenses.length === 0) {
    const mostRecent = licenseRows[0] || {};
    return NextResponse.json({
      licensed: true,
      canReceiveUpdates: false,
      licenseStatus: mostRecent.status,
      downloads: [],
      sourceSnapshots: [],
      message: "This license cannot access new downloads or source snapshots.",
    });
  }

  const licenseTypes = Array.from(
    new Set(activeLicenses.map((row) => String(row.license_type || "personal")))
  );
  const downloadResponses = await Promise.all(
    licenseTypes.map((licenseType) =>
      admin
        .from("downloads")
        .select("id, version, channel, platform, file_url, checksum, release_notes_url, created_at")
        .eq("is_active", true)
        .contains("license_type_allowed", [licenseType])
        .order("created_at", { ascending: false })
    )
  );
  const snapshotResponses = await Promise.all(
    licenseTypes.map((licenseType) =>
      admin
        .from("source_snapshots")
        .select("id, version, channel, git_ref, archive_url, checksum, release_notes_url, public_mirror_after, created_at")
        .eq("is_active", true)
        .contains("license_type_allowed", [licenseType])
        .order("created_at", { ascending: false })
    )
  );

  const downloadError = downloadResponses.find((response) => response.error)?.error;
  const snapshotError = snapshotResponses.find((response) => response.error)?.error;
  if (downloadError || snapshotError) {
    return NextResponse.json({ error: downloadError?.message || snapshotError?.message }, { status: 500 });
  }

  const downloads = uniqueById(
    downloadResponses.flatMap((response) => (response.data || []) as Record<string, unknown>[])
  );
  const sourceSnapshots = uniqueById(
    snapshotResponses.flatMap((response) => (response.data || []) as Record<string, unknown>[])
  );

  const signedDownloads = await Promise.all(
    downloads.map(async (download) => ({
      ...download,
      file_url: await signedArtifactUrl(admin, (download as Record<string, unknown>).file_url),
    }))
  );
  const signedSourceSnapshots = await Promise.all(
    sourceSnapshots.map(async (snapshot) => ({
      ...snapshot,
      archive_url: await signedArtifactUrl(admin, (snapshot as Record<string, unknown>).archive_url),
    }))
  );

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    null;
  const userAgent = req.headers.get("user-agent");
  const licenseRow = activeLicenses[0] || licenseRows[0] || {};
  const organizationId =
    typeof licenseRow.organization_id === "string" ? licenseRow.organization_id : null;
  await Promise.all([
    ...signedDownloads.map((download) =>
      admin.from("download_events").insert({
        organization_id: organizationId,
        license_id: String(licenseRow.id),
        user_id: user.id,
        download_id: String((download as Record<string, unknown>).id),
        ip_hash: hashRequestValue(ip),
        user_agent_hash: hashRequestValue(userAgent),
      })
    ),
    ...signedSourceSnapshots.map((snapshot) =>
      admin.from("download_events").insert({
        organization_id: organizationId,
        license_id: String(licenseRow.id),
        user_id: user.id,
        source_snapshot_id: String((snapshot as Record<string, unknown>).id),
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
