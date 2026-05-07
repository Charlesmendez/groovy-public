import { NextResponse } from "next/server";
import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceMembershipsForUser } from "@/lib/billing/state";
import { toChunkedStorageReference } from "@/lib/downloads/artifacts";
import { verifyArtifactDownloadToken } from "@/lib/downloads/artifactToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ManifestChunk = {
  path: string;
  size?: number;
  checksum?: string | null;
};

type ChunkedManifest = {
  filename: string;
  contentType: string;
  size: number;
  checksum?: string | null;
  chunks: ManifestChunk[];
};

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

function safeFilename(value: unknown): string {
  const cleaned = String(value || "download")
    .replace(/["\r\n\\/]/g, "_")
    .trim()
    .slice(0, 180);
  return cleaned || "download";
}

function normalizeChecksum(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const hex = trimmed.replace(/^sha256:/, "");
  return /^[a-f0-9]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

function sha256Checksum(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseManifest(value: unknown): ChunkedManifest | null {
  const manifest = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!manifest) return null;
  const chunks = Array.isArray(manifest.chunks)
    ? manifest.chunks
        .map((chunk): ManifestChunk | null => {
          const item = chunk && typeof chunk === "object" ? (chunk as Record<string, unknown>) : null;
          const path = typeof item?.path === "string" ? item.path.trim().replace(/^\/+/, "") : "";
          const size = typeof item?.size === "number" && Number.isFinite(item.size) ? item.size : undefined;
          const checksum = normalizeChecksum(item?.checksum);
          return path ? { path, size, checksum } : null;
        })
        .filter((chunk): chunk is ManifestChunk => !!chunk)
    : [];
  const size = typeof manifest.size === "number" && Number.isFinite(manifest.size) ? manifest.size : 0;
  if (!chunks.length || size <= 0) return null;
  if (chunks.every((chunk) => typeof chunk.size === "number")) {
    const chunkSizeTotal = chunks.reduce((total, chunk) => total + (chunk.size || 0), 0);
    if (chunkSizeTotal !== size) return null;
  }
  return {
    filename: safeFilename(manifest.filename),
    contentType:
      typeof manifest.contentType === "string" && manifest.contentType.trim()
        ? manifest.contentType.trim()
        : "application/octet-stream",
    size,
    checksum: normalizeChecksum(manifest.checksum),
    chunks,
  };
}

async function activeLicenseTypesForSession(admin: SupabaseClient): Promise<string[] | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return null;

  const memberships = await getWorkspaceMembershipsForUser({ userId: user.id, admin });
  const workspaceIds = memberships.map((membership) => membership.workspace_id).filter(Boolean);
  const { data: personalRows, error: personalErr } = await admin
    .from("licenses")
    .select("id, workspace_id, user_id, license_type, status, valid_until, created_at")
    .eq("user_id", user.id)
    .order("valid_until", { ascending: false });
  if (personalErr) throw new Error(personalErr.message);

  let workspaceRows: Record<string, unknown>[] = [];
  if (workspaceIds.length > 0) {
    const { data, error } = await admin
      .from("licenses")
      .select("id, workspace_id, user_id, license_type, status, valid_until, created_at")
      .in("workspace_id", workspaceIds)
      .order("valid_until", { ascending: false });
    if (error) throw new Error(error.message);
    workspaceRows = (data || []) as Record<string, unknown>[];
  }

  const activeRows = chooseLatestByScope([
    ...((personalRows || []) as Record<string, unknown>[]),
    ...workspaceRows,
  ]).filter(licenseAllowsUpdates);
  return Array.from(new Set(activeRows.map((row) => String(row.license_type || "personal"))));
}

async function activeLicenseTypesForRequest(
  req: Request,
  admin: SupabaseClient
): Promise<{ authenticated: boolean; licenseTypes: string[] }> {
  const url = new URL(req.url);
  const refValue = url.searchParams.get("ref")?.trim() || "";
  const token = url.searchParams.get("token")?.trim();
  if (token) {
    const verified = verifyArtifactDownloadToken(token, refValue);
    return {
      authenticated: true,
      licenseTypes: verified.ok ? verified.licenseTypes : [],
    };
  }

  const licenseTypes = await activeLicenseTypesForSession(admin);
  return {
    authenticated: licenseTypes !== null,
    licenseTypes: licenseTypes || [],
  };
}

function rowAllowsLicenseType(row: Record<string, unknown>, licenseTypes: string[]): boolean {
  const allowed = Array.isArray(row.license_type_allowed)
    ? row.license_type_allowed.filter((value): value is string => typeof value === "string")
    : [];
  return licenseTypes.some((licenseType) => allowed.includes(licenseType));
}

async function chunkedRefIsAllowed(args: {
  admin: SupabaseClient;
  refValue: string;
  licenseTypes: string[];
}): Promise<boolean> {
  const [downloadRows, snapshotRows] = await Promise.all([
    args.admin
      .from("downloads")
      .select("id, license_type_allowed")
      .eq("is_active", true)
      .eq("file_url", args.refValue),
    args.admin
      .from("source_snapshots")
      .select("id, license_type_allowed")
      .eq("is_active", true)
      .eq("archive_url", args.refValue),
  ]);
  if (downloadRows.error) throw new Error(downloadRows.error.message);
  if (snapshotRows.error) throw new Error(snapshotRows.error.message);
  const rows = [
    ...((downloadRows.data || []) as Record<string, unknown>[]),
    ...((snapshotRows.data || []) as Record<string, unknown>[]),
  ];
  return rows.some((row) => rowAllowsLicenseType(row, args.licenseTypes));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const refValue = url.searchParams.get("ref")?.trim() || "";
  const ref = toChunkedStorageReference(refValue);
  if (!ref) return NextResponse.json({ error: "Invalid artifact reference" }, { status: 400 });

  const admin = createSupabaseAdminClient();
  try {
    const auth = await activeLicenseTypesForRequest(req, admin);
    if (!auth.authenticated) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!auth.licenseTypes.length) {
      return NextResponse.json({ error: "License cannot access this artifact" }, { status: 403 });
    }

    const allowed = await chunkedRefIsAllowed({
      admin,
      refValue,
      licenseTypes: auth.licenseTypes,
    });
    if (!allowed) return NextResponse.json({ error: "Artifact not found" }, { status: 404 });

    const manifestDownload = await admin.storage.from(ref.bucket).download(ref.path);
    if (manifestDownload.error || !manifestDownload.data) {
      return NextResponse.json({ error: "Artifact manifest not found" }, { status: 404 });
    }
    const manifest = parseManifest(JSON.parse(await manifestDownload.data.text()));
    if (!manifest) return NextResponse.json({ error: "Invalid artifact manifest" }, { status: 500 });

    let nextChunkIndex = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = manifest.chunks[nextChunkIndex];
          if (!chunk) {
            controller.close();
            return;
          }

          nextChunkIndex += 1;
          const chunkDownload = await admin.storage.from(ref.bucket).download(chunk.path);
          if (chunkDownload.error || !chunkDownload.data) {
            throw new Error(chunkDownload.error?.message || `Missing chunk ${chunk.path}`);
          }
          const bytes = new Uint8Array(await chunkDownload.data.arrayBuffer());
          if (typeof chunk.size === "number" && bytes.byteLength !== chunk.size) {
            throw new Error(`Chunk size mismatch for ${chunk.path}`);
          }
          if (chunk.checksum && sha256Checksum(bytes) !== chunk.checksum) {
            throw new Error(`Chunk checksum mismatch for ${chunk.path}`);
          }
          controller.enqueue(bytes);
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${manifest.filename}"; filename*=UTF-8''${encodeURIComponent(manifest.filename)}`,
        "Content-Length": String(manifest.size),
        "Content-Type": manifest.contentType,
        "X-Content-Type-Options": "nosniff",
        ...(manifest.checksum ? { "X-Groovy-Checksum": manifest.checksum } : {}),
      },
    });
  } catch (err) {
    console.error("[downloads/artifact] failed", err);
    return NextResponse.json({ error: "Unable to download artifact" }, { status: 500 });
  }
}
