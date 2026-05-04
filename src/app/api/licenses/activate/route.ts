import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { activateLicenseDevice, findLicenseByKey } from "@/lib/licensing/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ActivateBody = {
  licenseKey?: string;
  deviceHash?: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
};

function hashIp(req: Request): string | null {
  const raw =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "";
  if (!raw) return null;
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ActivateBody | null;
  const licenseKey = typeof body?.licenseKey === "string" ? body.licenseKey.trim() : "";
  const deviceHash = typeof body?.deviceHash === "string" ? body.deviceHash.trim() : "";
  if (!licenseKey || !deviceHash) {
    return NextResponse.json(
      { error: "licenseKey and deviceHash are required" },
      { status: 400 }
    );
  }

  const admin = createSupabaseAdminClient();
  const licenseRow = await findLicenseByKey({ licenseKey, admin });
  if (!licenseRow) {
    return NextResponse.json({ error: "Invalid license key" }, { status: 404 });
  }

  const result = await activateLicenseDevice({
    licenseRow,
    deviceHash,
    deviceName: body?.deviceName || null,
    platform: body?.platform || null,
    appVersion: body?.appVersion || null,
    admin,
  });

  try {
    await admin.from("license_checks").insert({
      license_id: String(licenseRow.id),
      device_id: result.ok ? result.activationId : null,
      app_version: body?.appVersion || null,
      ip_hash: hashIp(req),
      result: result.ok ? "activated" : result.reason,
    });
  } catch {
    // Non-fatal audit failure.
  }

  if (!result.ok) {
    const status = result.reason === "device_limit_reached" ? 409 : 403;
    return NextResponse.json({ error: result.reason }, { status });
  }

  return NextResponse.json({
    ok: true,
    activationId: result.activationId,
    activationToken: result.activationToken,
    license: result.signedLicense,
  });
}
