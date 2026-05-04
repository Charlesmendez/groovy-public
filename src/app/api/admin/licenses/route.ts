import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import {
  generateLicenseKey,
  licenseKeyHash,
  signLicensePayload,
} from "@/lib/licensing/server";
import { encryptLlmApiKey } from "@/lib/crypto/llmKey";
import { isGroovyAdminEmail } from "@/lib/admin/access";
import type { GroovyLicenseType, GroovyLicenseStatus } from "@/lib/licensing/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeLicenseType(value: unknown): GroovyLicenseType {
  return value === "enterprise" || value === "enterprise_reseller" || value === "personal"
    ? value
    : "personal";
}

function normalizeStatus(value: unknown): GroovyLicenseStatus {
  return value === "past_due" ||
    value === "expired" ||
    value === "canceled" ||
    value === "suspended" ||
    value === "terminated" ||
    value === "active"
    ? value
    : "active";
}

function asDateIso(value: unknown, fallback: Date): string {
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return fallback.toISOString();
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

async function getOrCreateOrganization(args: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  name: string;
  type: GroovyLicenseType;
  userId?: string | null;
  workspaceId?: string | null;
}): Promise<string> {
  if (args.workspaceId) {
    const { data: existing, error: existingErr } = await args.admin
      .from("organizations")
      .select("id")
      .eq("workspace_id", args.workspaceId)
      .maybeSingle();
    if (existingErr) throw new Error(existingErr.message);
    if (existing?.id) {
      await args.admin
        .from("organizations")
        .update({
          name: args.name,
          type: args.type,
          owner_user_id: args.userId || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      return String(existing.id);
    }
  }

  const { data: org, error: orgErr } = await args.admin
    .from("organizations")
    .insert({
      name: args.name,
      type: args.type,
      owner_user_id: args.userId || null,
      workspace_id: args.workspaceId || null,
    })
    .select("id")
    .single();
  if (orgErr || !org) throw new Error(orgErr?.message || "Failed to create organization");
  return String((org as Record<string, unknown>).id);
}

type CreateLicenseBody = {
  organizationName?: string;
  organizationType?: GroovyLicenseType;
  workspaceId?: string | null;
  userId?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  licenseType?: GroovyLicenseType;
  status?: GroovyLicenseStatus;
  validFrom?: string;
  validUntil?: string;
  fallbackAllowed?: boolean;
  maxDevices?: number | null;
  maxUsers?: number | null;
  maxAgents?: number | null;
  maxEnvironments?: number | null;
  productionEnvironments?: number | null;
  productionAgents?: number | null;
  resellerBillingEnabled?: boolean;
  tokenConsumptionBillingEnabled?: boolean;
  features?: string[];
  metadata?: Record<string, unknown>;
};

export async function GET() {
  const user = await getAuthedUser();
  if (!isGroovyAdminEmail(user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("licenses")
    .select("id, organization_id, workspace_id, user_id, license_type, status, customer_email, customer_name, valid_from, valid_until, fallback_allowed, reseller_billing_enabled, token_consumption_billing_enabled, features, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ licenses: data || [] });
}

export async function POST(req: Request) {
  const user = await getAuthedUser();
  if (!isGroovyAdminEmail(user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as CreateLicenseBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const licenseType = normalizeLicenseType(body.licenseType || body.organizationType);
  const status = normalizeStatus(body.status);
  const now = new Date();
  const validFrom = asDateIso(body.validFrom, now);
  const validUntil = asDateIso(
    body.validUntil,
    new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()))
  );
  const licenseKey = generateLicenseKey(
    licenseType === "personal"
      ? "groovy_personal"
      : licenseType === "enterprise_reseller"
        ? "groovy_reseller"
        : "groovy_enterprise"
  );
  const licenseId = randomUUID();
  const admin = createSupabaseAdminClient();

  const orgName =
    body.organizationName ||
    body.customerName ||
    body.customerEmail ||
    (licenseType === "personal" ? "Personal Organization" : "Enterprise Organization");
  let organizationId: string;
  try {
    organizationId = await getOrCreateOrganization({
      admin,
      name: orgName,
      type: licenseType,
      userId: body.userId || null,
      workspaceId: body.workspaceId || null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create organization" },
      { status: 500 }
    );
  }

  const row = {
    id: licenseId,
    organization_id: organizationId,
    workspace_id: body.workspaceId || null,
    user_id: body.userId || null,
    license_type: licenseType,
    status,
    customer_email: body.customerEmail || null,
    customer_name: body.customerName || orgName,
    license_key_hash: licenseKeyHash(licenseKey),
    valid_from: validFrom,
    valid_until: validUntil,
    fallback_allowed: body.fallbackAllowed === true || licenseType !== "personal",
    max_devices: asNumber(body.maxDevices) ?? (licenseType === "personal" ? 2 : null),
    max_users: asNumber(body.maxUsers),
    max_agents: asNumber(body.maxAgents),
    max_environments: asNumber(body.maxEnvironments),
    production_environments: asNumber(body.productionEnvironments),
    production_agents: asNumber(body.productionAgents),
    reseller_billing_enabled: licenseType === "enterprise_reseller" && body.resellerBillingEnabled === true,
    token_consumption_billing_enabled:
      licenseType === "enterprise_reseller" &&
      body.resellerBillingEnabled === true &&
      body.tokenConsumptionBillingEnabled === true,
    features: Array.isArray(body.features) ? body.features : [],
    metadata: body.metadata || {},
  };
  const signed = signLicensePayload(row);

  const { data: license, error: licenseErr } = await admin
    .from("licenses")
    .insert({
      ...row,
      license_key_enc: encryptLlmApiKey(licenseKey),
      signed_license_payload: signed,
    })
    .select("id, license_type, status, customer_email, customer_name, valid_from, valid_until")
    .single();
  if (licenseErr || !license) {
    return NextResponse.json({ error: licenseErr?.message || "Failed to create license" }, { status: 500 });
  }

  await admin.from("license_admin_audit_events").insert({
    actor_user_id: user.id,
    organization_id: organizationId,
    license_id: licenseId,
    action: "license.created",
    payload: {
      licenseType,
      status,
      validFrom,
      validUntil,
      resellerBillingEnabled: row.reseller_billing_enabled,
      tokenConsumptionBillingEnabled: row.token_consumption_billing_enabled,
    },
  });

  return NextResponse.json({
    ok: true,
    license,
    licenseKey,
    signedLicense: signed,
  });
}
