import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { findLicenseByKey } from "@/lib/licensing/server";
import { signedArtifactUrl } from "@/lib/downloads/artifacts";

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

function versionParts(value: unknown): number[] {
  if (typeof value !== "string") return [];
  return value
    .replace(/^v/i, "")
    .split(/[.-]/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function compareVersions(a: unknown, b: unknown): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function licenseAllowsUpdates(row: Record<string, unknown>): boolean {
  const status = row.status;
  const validUntil = typeof row.valid_until === "string" ? new Date(row.valid_until).getTime() : 0;
  return (status === "active" || status === "past_due") && validUntil >= Date.now();
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  const licenseKey = typeof body?.licenseKey === "string" ? body.licenseKey.trim() : "";
  const platform = typeof body?.platform === "string" ? body.platform.trim() : "";
  if (!licenseKey || !platform) {
    return NextResponse.json({ error: "licenseKey and platform are required" }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const license = await findLicenseByKey({ licenseKey, admin });
  if (!license) return NextResponse.json({ error: "Invalid license key" }, { status: 404 });
  if (!licenseAllowsUpdates(license)) {
    return NextResponse.json({
      updateAvailable: false,
      reason: "license_not_eligible_for_updates",
    });
  }

  const licenseType = String(license.license_type || "personal");
  const { data, error } = await admin
    .from("downloads")
    .select("id, version, channel, platform, file_url, checksum, release_notes_url, created_at")
    .eq("is_active", true)
    .eq("platform", platform)
    .eq("channel", channel(body?.channel))
    .contains("license_type_allowed", [licenseType])
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const latest = (data || [])
    .sort((a, b) => compareVersions(b.version, a.version))
    .at(0);
  if (!latest) return NextResponse.json({ updateAvailable: false, reason: "no_download" });

  const updateAvailable = compareVersions(latest.version, body?.currentVersion) > 0;
  return NextResponse.json({
    updateAvailable,
    latest: {
      ...latest,
      file_url: updateAvailable ? await signedArtifactUrl(admin, latest.file_url) : null,
    },
  });
}
