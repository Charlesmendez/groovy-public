import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { isGroovyAdminEmail } from "@/lib/admin/access";
import { buildStorageReference } from "@/lib/downloads/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  kind?: "download" | "source_snapshot";
  version?: string;
  channel?: "stable" | "beta" | "dev" | "enterprise";
  platform?: string;
  fileUrl?: string;
  archiveUrl?: string;
  storageBucket?: string | null;
  storagePath?: string | null;
  checksum?: string | null;
  releaseNotesUrl?: string | null;
  gitRef?: string | null;
  licenseTypeAllowed?: string[];
  publicMirrorAfter?: string | null;
  isActive?: boolean;
};

function allowedTypes(value: unknown): string[] {
  const fallback = ["personal", "enterprise", "enterprise_reseller"];
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.filter(
    (v): v is string =>
      v === "personal" || v === "enterprise" || v === "enterprise_reseller"
  );
  return cleaned.length ? cleaned : fallback;
}

function channel(value: unknown): "stable" | "beta" | "dev" | "enterprise" {
  return value === "beta" || value === "dev" || value === "enterprise" ? value : "stable";
}

export async function GET() {
  const user = await getAuthedUser();
  if (!isGroovyAdminEmail(user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const admin = createSupabaseAdminClient();
  const [{ data: downloads }, { data: sourceSnapshots }] = await Promise.all([
    admin
      .from("downloads")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("source_snapshots")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  return NextResponse.json({ downloads: downloads || [], sourceSnapshots: sourceSnapshots || [] });
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!isGroovyAdminEmail(user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const version = typeof body.version === "string" ? body.version.trim() : "";
  if (!version) return NextResponse.json({ error: "version is required" }, { status: 400 });

  const admin = createSupabaseAdminClient();
  if (body.kind === "source_snapshot") {
    const archiveUrl =
      (typeof body.archiveUrl === "string" ? body.archiveUrl.trim() : "") ||
      buildStorageReference(body.storageBucket, body.storagePath) ||
      "";
    if (!archiveUrl) return NextResponse.json({ error: "archiveUrl is required" }, { status: 400 });
    const { data, error } = await admin
      .from("source_snapshots")
      .insert({
        version,
        channel: channel(body.channel),
        git_ref: body.gitRef || null,
        archive_url: archiveUrl,
        checksum: body.checksum || null,
        release_notes_url: body.releaseNotesUrl || null,
        license_type_allowed: allowedTypes(body.licenseTypeAllowed),
        public_mirror_after: body.publicMirrorAfter || null,
        is_active: body.isActive !== false,
      })
      .select("*")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, sourceSnapshot: data });
  }

  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  const fileUrl =
    (typeof body.fileUrl === "string" ? body.fileUrl.trim() : "") ||
    buildStorageReference(body.storageBucket, body.storagePath) ||
    "";
  if (!platform || !fileUrl) {
    return NextResponse.json({ error: "platform and fileUrl are required" }, { status: 400 });
  }
  const { data, error } = await admin
    .from("downloads")
    .insert({
      version,
      channel: channel(body.channel),
      platform,
      file_url: fileUrl,
      checksum: body.checksum || null,
      release_notes_url: body.releaseNotesUrl || null,
      license_type_allowed: allowedTypes(body.licenseTypeAllowed),
      is_active: body.isActive !== false,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, download: data });
}
