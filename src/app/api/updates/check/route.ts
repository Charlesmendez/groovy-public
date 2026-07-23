import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { findLicenseByKey } from "@/lib/licensing/server";
import { signedArtifactUrl, toChunkedStorageReference } from "@/lib/downloads/artifacts";
import { createArtifactDownloadToken } from "@/lib/downloads/artifactToken";
import {
  compareVersions,
  licenseAllowsUpdates,
  licensesForDeviceToken,
  platformAliases,
} from "@/lib/updates/licenseGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  licenseKey?: string;
  platform?: string;
  currentVersion?: string;
  channel?: "stable" | "beta" | "dev" | "enterprise";
};

function channel(value: unknown): "stable" | "beta" | "dev" | "enterprise" {
  return value === "beta" || value === "dev" || value === "enterprise" ? value : "stable";
}

async function downloadableArtifactUrl(args: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  req: Request;
  value: unknown;
  licenseTypes: string[];
}): Promise<string | null> {
  if (typeof args.value !== "string" || !args.value.trim()) return null;
  if (toChunkedStorageReference(args.value)) {
    const url = new URL("/api/downloads/artifact", args.req.url);
    url.searchParams.set("ref", args.value.trim());
    url.searchParams.set(
      "token",
      createArtifactDownloadToken({
        ref: args.value.trim(),
        licenseTypes: args.licenseTypes,
      })
    );
    return url.toString();
  }
  return signedArtifactUrl(args.admin, args.value);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  const licenseKey = typeof body?.licenseKey === "string" ? body.licenseKey.trim() : "";
  const platform = typeof body?.platform === "string" ? body.platform.trim() : "";
  if (!platform) {
    return NextResponse.json({ error: "platform is required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  let licenseRows: Record<string, unknown>[] = [];
  if (licenseKey) {
    const license = await findLicenseByKey({ licenseKey, admin });
    if (!license) return NextResponse.json({ error: "Invalid license key" }, { status: 404 });
    licenseRows = [license];
  } else {
    const resolved = await licensesForDeviceToken({ admin, req });
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    licenseRows = resolved.licenses;
  }

  if (licenseRows.length === 0) {
    return NextResponse.json({ updateAvailable: false, reason: "no_license" });
  }

  const activeLicenses = licenseRows.filter(licenseAllowsUpdates);
  if (activeLicenses.length === 0) {
    return NextResponse.json({
      updateAvailable: false,
      reason: "license_not_eligible_for_updates",
    });
  }

  const licenseTypes = Array.from(
    new Set(activeLicenses.map((row) => String(row.license_type || "personal")))
  );
  const responses = await Promise.all(
    licenseTypes.map((licenseType) =>
      admin
        .from("downloads")
        .select("id, version, channel, platform, file_url, checksum, release_notes_url, created_at")
        .eq("is_active", true)
        .in("platform", platformAliases(platform))
        .eq("channel", channel(body?.channel))
        .contains("license_type_allowed", [licenseType])
        .order("created_at", { ascending: false })
        .limit(20)
    )
  );
  const error = responses.find((response) => response.error)?.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const data = responses.flatMap((response) => (response.data || []) as Record<string, unknown>[]);
  const latest = data
    .sort((a, b) => compareVersions(b.version, a.version))
    .at(0);
  if (!latest) return NextResponse.json({ updateAvailable: false, reason: "no_download" });

  const updateAvailable = compareVersions(latest.version, body?.currentVersion) > 0;
  return NextResponse.json({
    updateAvailable,
    latest: {
      ...latest,
      file_url: updateAvailable
        ? await downloadableArtifactUrl({
            admin,
            req,
            value: latest.file_url,
            licenseTypes,
          })
        : null,
    },
  });
}
