import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  hashActivationToken,
  sha256Hex,
  signEnvelope,
} from "@/lib/licensing/signing";
import type {
  GroovyActivationPayload,
  GroovyLicensePayload,
  GroovyLicenseStatus,
  GroovyLicenseType,
  GroovySignedEnvelope,
} from "@/lib/licensing/types";

const PERSONAL_OFFLINE_CHECK_DAYS = 30;
const PERSONAL_GRACE_DAYS = 14;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && !!v.trim())
    : [];
}

function normalizeLicenseType(value: unknown): GroovyLicenseType | null {
  return value === "personal" || value === "enterprise" || value === "enterprise_reseller"
    ? value
    : null;
}

function normalizeLicenseStatus(value: unknown): GroovyLicenseStatus | null {
  return value === "active" ||
    value === "past_due" ||
    value === "expired" ||
    value === "canceled" ||
    value === "suspended" ||
    value === "terminated"
    ? value
    : null;
}

export function generateLicenseKey(prefix = "groovy"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function licenseKeyHash(licenseKey: string): string {
  return sha256Hex(licenseKey.trim());
}

export function buildLicensePayload(row: Record<string, unknown>): GroovyLicensePayload {
  const licenseType = normalizeLicenseType(row.license_type) || "personal";
  const status = normalizeLicenseStatus(row.status) || "active";
  return {
    license_id: String(row.id),
    license_type: licenseType,
    status,
    customer_email: asString(row.customer_email),
    customer_name: asString(row.customer_name),
    valid_from: asString(row.valid_from) || new Date().toISOString(),
    valid_until: asString(row.valid_until) || new Date().toISOString(),
    fallback_allowed: asBool(row.fallback_allowed),
    max_devices: asNumber(row.max_devices),
    max_users: asNumber(row.max_users),
    max_agents: asNumber(row.max_agents),
    max_environments: asNumber(row.max_environments),
    production_environments: asNumber(row.production_environments),
    production_agents: asNumber(row.production_agents),
    reseller_billing_enabled: asBool(row.reseller_billing_enabled),
    token_consumption_billing_enabled: asBool(row.token_consumption_billing_enabled),
    features: asStringArray(row.features),
  };
}

export function signLicensePayload(row: Record<string, unknown>) {
  return signEnvelope("groovy-license", buildLicensePayload(row));
}

export async function findLicenseByKey(args: {
  licenseKey: string;
  admin?: SupabaseClient;
}): Promise<Record<string, unknown> | null> {
  const hash = licenseKeyHash(args.licenseKey);
  const admin = args.admin || createSupabaseAdminClient();
  const { data, error } = await admin
    .from("licenses")
    .select("*")
    .eq("license_key_hash", hash)
    .maybeSingle();
  if (error || !data) return null;
  return data as Record<string, unknown>;
}

export function canActivateLicense(row: Record<string, unknown>): {
  ok: boolean;
  reason?: string;
} {
  const status = normalizeLicenseStatus(row.status);
  if (status === "terminated" || status === "suspended") return { ok: false, reason: status };
  if (status === "expired" || status === "canceled") return { ok: false, reason: status };
  const validUntil = asString(row.valid_until);
  if (validUntil && new Date(validUntil).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

export async function activateLicenseDevice(args: {
  licenseRow: Record<string, unknown>;
  deviceHash: string;
  deviceName?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  admin?: SupabaseClient;
}): Promise<{
  ok: true;
  activationId: string;
  activationToken: GroovySignedEnvelope<GroovyActivationPayload>;
  signedLicense: GroovySignedEnvelope<GroovyLicensePayload>;
} | {
  ok: false;
  reason: string;
}> {
  const admin = args.admin || createSupabaseAdminClient();
  const licenseId = String(args.licenseRow.id || "");
  if (!licenseId) return { ok: false, reason: "missing_license_id" };

  const activationAllowed = canActivateLicense(args.licenseRow);
  if (!activationAllowed.ok) return { ok: false, reason: activationAllowed.reason || "not_active" };

  const maxDevices = asNumber(args.licenseRow.max_devices);
  const { data: existing } = await admin
    .from("license_devices")
    .select("id")
    .eq("license_id", licenseId)
    .eq("device_hash", args.deviceHash)
    .is("deactivated_at", null)
    .maybeSingle();

  let activationId = asString((existing as Record<string, unknown> | null)?.id);
  if (!activationId) {
    if (typeof maxDevices === "number" && maxDevices > 0) {
      const { count, error: countErr } = await admin
        .from("license_devices")
        .select("id", { count: "exact", head: true })
        .eq("license_id", licenseId)
        .is("deactivated_at", null);
      if (countErr) return { ok: false, reason: "device_count_failed" };
      if ((count || 0) >= maxDevices) return { ok: false, reason: "device_limit_reached" };
    }

    const { data: inserted, error: insertErr } = await admin
      .from("license_devices")
      .insert({
        license_id: licenseId,
        device_hash: args.deviceHash,
        device_name: args.deviceName || null,
        platform: args.platform || null,
        app_version: args.appVersion || null,
      })
      .select("id")
      .single();
    if (insertErr || !inserted) return { ok: false, reason: "device_insert_failed" };
    activationId = String((inserted as Record<string, unknown>).id);
  } else {
    await admin
      .from("license_devices")
      .update({
        device_name: args.deviceName || null,
        platform: args.platform || null,
        app_version: args.appVersion || null,
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", activationId);
  }

  const licenseType = normalizeLicenseType(args.licenseRow.license_type) || "personal";
  const status = normalizeLicenseStatus(args.licenseRow.status) || "active";
  const now = new Date();
  const validUntil = asString(args.licenseRow.valid_until) || addDays(now, PERSONAL_OFFLINE_CHECK_DAYS).toISOString();
  const activationPayload: GroovyActivationPayload = {
    license_id: licenseId,
    license_type: licenseType,
    status,
    device_activation_id: activationId,
    device_hash: args.deviceHash,
    valid_until: validUntil,
    grace_until:
      licenseType === "personal"
        ? addDays(new Date(validUntil), PERSONAL_GRACE_DAYS).toISOString()
        : validUntil,
    issued_at: now.toISOString(),
    app_version: args.appVersion || null,
  };
  const activationToken = signEnvelope("groovy-activation", activationPayload);
  await admin
    .from("license_devices")
    .update({ activation_token_hash: hashActivationToken(activationToken) })
    .eq("id", activationId);

  return {
    ok: true,
    activationId,
    activationToken,
    signedLicense: signLicensePayload(args.licenseRow),
  };
}
