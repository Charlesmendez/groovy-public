/**
 * GET /api/updates/desktop-feed/<path> — electron-updater "generic" feed for
 * Groovy Desktop (macOS arm64).
 *
 * Auth: the Electron shell sends the connector's device token in the
 * x-device-token header. It is verified and license-gated with the exact same
 * logic as /api/updates/check (see @/lib/updates/licenseGate). Unpaired or
 * unlicensed clients get an empty 204 (electron-updater treats it as "no
 * update"; we never leak artifact URLs to them).
 *
 * Storage design (kept deliberately simple; must match
 * scripts/publish-connector-downloads.mjs --desktop-* flags):
 *  - Each desktop release lives in ONE storage directory, e.g.
 *      desktop/releases/<version>/macos-desktop/
 *    containing chunked uploads of the DMG and ZIP (each with its own
 *    `<filename>.manifest.json` + `.part-NNNN` chunks) plus the
 *    electron-builder `latest-mac.yml` stored as a PLAIN storage object in the
 *    same directory. The `downloads` table has no metadata column, so the yml
 *    is stored "next to the artifacts" and its location is derived from the
 *    row's file_url — no schema change needed.
 *  - The `downloads` row for platform 'macos-desktop' (channel 'stable')
 *    points its file_url at the DMG's chunked manifest
 *    (supabase-chunked://<bucket>/<dir>/<dmg>.manifest.json). A sibling row
 *    with platform 'macos-desktop-zip' points at the ZIP manifest so
 *    /api/downloads/artifact license checks pass for the ZIP too.
 *  - This route resolves the newest active 'macos-desktop' row the caller's
 *    licenses allow, downloads `<dir>/latest-mac.yml`, and rewrites every
 *    `url:` / `path:` filename inside the yml into an absolute
 *    short filename-based URLs under this route. Artifact requests repeat the
 *    device/license check and are streamed through /api/downloads/artifact
 *    internally. Keeping refs/tokens out of the public URL is required because
 *    electron-updater uses the URL as a temporary filename on macOS.
 *
 * Only the feed and its latest ZIP/DMG filenames are served.
 */

import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { toChunkedStorageReference } from "@/lib/downloads/artifacts";
import { createArtifactDownloadToken } from "@/lib/downloads/artifactToken";
import { GET as serveArtifact } from "@/app/api/downloads/artifact/route";
import {
  activeLicenseTypes,
  compareVersions,
  licensesForDeviceToken,
} from "@/lib/updates/licenseGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DESKTOP_PLATFORM = "macos-desktop";
const DESKTOP_CHANNEL = "stable";
const FEED_FILENAME = "latest-mac.yml";

function rewriteFeedYaml(args: {
  yml: string;
  req: Request;
  bucket: string;
  dir: string;
  licenseTypes: string[];
}): string {
  const artifactUrl = (filename: string): string => {
    const url = new URL(
      `/api/updates/desktop-feed/${encodeURIComponent(filename)}`,
      args.req.url
    );
    return url.toString();
  };

  // electron-builder yml lines look like "  - url: Groovy-0.1.0-arm64-mac.zip"
  // and "path: Groovy-0.1.0-arm64-mac.zip". Rewrite bare filenames only —
  // values that are already absolute URLs are left untouched.
  return args.yml
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*(?:-\s*)?(?:url|path):\s*)(.+?)\s*$/);
      if (!match) return line;
      const value = match[2];
      if (/^https?:\/\//i.test(value) || value.includes("/")) return line;
      return `${match[1]}"${artifactUrl(value)}"`;
    })
    .join("\n");
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: pathParts } = await params;
  const requestedPath = (pathParts || []).join("/");
  const isFeedRequest = requestedPath === FEED_FILENAME;
  const isArtifactRequest = /^Groovy-[0-9A-Za-z.-]+-arm64(?:-mac)?\.(?:zip|dmg)$/.test(
    requestedPath
  );
  if (!isFeedRequest && !isArtifactRequest) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const admin = createSupabaseAdminClient();
  const resolved = await licensesForDeviceToken({ admin, req });
  if (!resolved.ok) {
    if (resolved.status >= 500) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    // Unpaired / unknown device: quietly report "nothing to update".
    return new Response(null, { status: 204 });
  }

  const licenseTypes = activeLicenseTypes(resolved.licenses);
  if (licenseTypes.length === 0) {
    return new Response(null, { status: 204 });
  }

  const responses = await Promise.all(
    licenseTypes.map((licenseType) =>
      admin
        .from("downloads")
        .select("id, version, channel, platform, file_url, created_at")
        .eq("is_active", true)
        .eq("platform", DESKTOP_PLATFORM)
        .eq("channel", DESKTOP_CHANNEL)
        .contains("license_type_allowed", [licenseType])
        .order("created_at", { ascending: false })
        .limit(20)
    )
  );
  const queryError = responses.find((response) => response.error)?.error;
  if (queryError) return NextResponse.json({ error: queryError.message }, { status: 500 });

  const rows = responses.flatMap((response) => (response.data || []) as Record<string, unknown>[]);
  const latest = rows.sort((a, b) => compareVersions(b.version, a.version)).at(0);
  if (!latest) return new Response(null, { status: 204 });

  const manifestRef = toChunkedStorageReference(latest.file_url);
  if (!manifestRef) {
    return NextResponse.json({ error: "invalid_desktop_download_row" }, { status: 500 });
  }
  const dir = manifestRef.path.split("/").slice(0, -1).join("/");
  if (isArtifactRequest) {
    const version = String(latest.version || "");
    const allowedFilenames = new Set([
      `Groovy-${version}-arm64-mac.zip`,
      `Groovy-${version}-arm64.dmg`,
    ]);
    if (!allowedFilenames.has(requestedPath)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const ref = `supabase-chunked://${manifestRef.bucket}/${dir}/${requestedPath}.manifest.json`;
    const internalUrl = new URL("/api/downloads/artifact", req.url);
    internalUrl.searchParams.set("ref", ref);
    internalUrl.searchParams.set(
      "token",
      createArtifactDownloadToken({ ref, licenseTypes, ttlSeconds: 60 * 60 })
    );
    return serveArtifact(new Request(internalUrl, { method: "GET" }));
  }

  const ymlPath = dir ? `${dir}/${FEED_FILENAME}` : FEED_FILENAME;

  const ymlDownload = await admin.storage.from(manifestRef.bucket).download(ymlPath);
  if (ymlDownload.error || !ymlDownload.data) {
    return NextResponse.json({ error: "feed_manifest_not_found" }, { status: 404 });
  }

  const rewritten = rewriteFeedYaml({
    yml: await ymlDownload.data.text(),
    req,
    bucket: manifestRef.bucket,
    dir,
    licenseTypes,
  });

  return new Response(rewritten, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/yaml; charset=utf-8",
    },
  });
}
