/**
 * License gating helpers shared by update endpoints.
 *
 * Extracted (behavior-neutral) from /api/updates/check so that
 * /api/updates/desktop-feed can apply the exact same device-token →
 * active-license resolution when serving the Electron auto-update feed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getWorkspaceMembershipsForUser } from "@/lib/billing/state";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";

export type LicenseRow = Record<string, unknown>;

export function platformAliases(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (["macos", "mac", "darwin", "osx", "macos-arm64"].includes(normalized)) {
    return ["macos", "macos-arm64", "darwin"];
  }
  if (["windows", "win", "win32", "windows-x64"].includes(normalized)) {
    return ["windows", "windows-x64", "win32"];
  }
  return [value.trim()];
}

function versionParts(value: unknown): number[] {
  if (typeof value !== "string") return [];
  return value
    .replace(/^v/i, "")
    .split(/[.-]/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

export function compareVersions(a: unknown, b: unknown): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function licenseAllowsUpdates(row: LicenseRow): boolean {
  const status = row.status;
  const validUntil = typeof row.valid_until === "string" ? new Date(row.valid_until).getTime() : 0;
  return (status === "active" || status === "past_due") && validUntil >= Date.now();
}

function licenseSortMs(row: LicenseRow): number {
  const validUntil = typeof row.valid_until === "string" ? new Date(row.valid_until).getTime() : 0;
  const createdAt = typeof row.created_at === "string" ? new Date(row.created_at).getTime() : 0;
  return (Number.isFinite(validUntil) ? validUntil : 0) || (Number.isFinite(createdAt) ? createdAt : 0);
}

function isWorkspaceLicense(row: LicenseRow): boolean {
  return row.license_type === "enterprise" || row.license_type === "enterprise_reseller";
}

export function chooseLatestByScope(rows: LicenseRow[]): LicenseRow[] {
  const chosen = new Map<string, LicenseRow>();
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

export type DeviceTokenLicenses =
  | { ok: true; licenses: LicenseRow[] }
  | { ok: false; status: number; error: string };

/**
 * Resolve the licenses visible to the device identified by the request's
 * x-device-token header (personal + workspace scopes, newest per scope).
 */
export async function licensesForDeviceToken(args: {
  admin: SupabaseClient;
  req: Request;
}): Promise<DeviceTokenLicenses> {
  const token =
    args.req.headers.get("x-device-token") || args.req.headers.get("X-Device-Token") || "";
  if (!token.trim()) return { ok: false, status: 401, error: "missing_device_token" };

  const secret = process.env.RELAY_JWT_SECRET || "";
  const verified = verifyRelayDeviceToken(token, secret);
  if (!verified) return { ok: false, status: 401, error: "invalid_device_token" };

  const { data: device, error: deviceErr } = await args.admin
    .from("devices")
    .select("id,user_id")
    .eq("id", verified.deviceId)
    .eq("user_id", verified.userId)
    .maybeSingle();
  if (deviceErr) return { ok: false, status: 500, error: deviceErr.message };
  if (!device?.id) return { ok: false, status: 401, error: "device_not_found" };

  const memberships = await getWorkspaceMembershipsForUser({ userId: verified.userId, admin: args.admin });
  const workspaceIds = memberships.map((membership) => membership.workspace_id).filter(Boolean);
  const { data: personalRows, error: personalErr } = await args.admin
    .from("licenses")
    .select("id, organization_id, workspace_id, user_id, license_type, status, valid_until, fallback_allowed, created_at")
    .eq("user_id", verified.userId)
    .order("valid_until", { ascending: false });
  if (personalErr) return { ok: false, status: 500, error: personalErr.message };

  let workspaceRows: LicenseRow[] = [];
  if (workspaceIds.length > 0) {
    const { data, error } = await args.admin
      .from("licenses")
      .select("id, organization_id, workspace_id, user_id, license_type, status, valid_until, fallback_allowed, created_at")
      .in("workspace_id", workspaceIds)
      .order("valid_until", { ascending: false });
    if (error) return { ok: false, status: 500, error: error.message };
    workspaceRows = (data || []) as LicenseRow[];
  }

  return {
    ok: true,
    licenses: chooseLatestByScope([
      ...((personalRows || []) as LicenseRow[]),
      ...workspaceRows,
    ]),
  };
}

/** Distinct license types among the rows that currently allow updates. */
export function activeLicenseTypes(rows: LicenseRow[]): string[] {
  return Array.from(
    new Set(rows.filter(licenseAllowsUpdates).map((row) => String(row.license_type || "personal")))
  );
}
