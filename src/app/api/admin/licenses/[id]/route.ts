import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getAuthedUser } from "@/lib/workspaces";
import { isGroovyAdminEmail } from "@/lib/admin/access";
import { signLicensePayload } from "@/lib/licensing/server";
import type { GroovyLicenseStatus } from "@/lib/licensing/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  status?: GroovyLicenseStatus;
  validUntil?: string;
  resellerBillingEnabled?: boolean;
  tokenConsumptionBillingEnabled?: boolean;
  maxUsers?: number | null;
  maxAgents?: number | null;
  maxEnvironments?: number | null;
  maxDevices?: number | null;
  features?: string[];
};

function status(value: unknown): GroovyLicenseStatus | null {
  return value === "active" ||
    value === "past_due" ||
    value === "expired" ||
    value === "canceled" ||
    value === "suspended" ||
    value === "terminated"
    ? value
    : null;
}

function dateIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthedUser();
  if (!isGroovyAdminEmail(user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!id || !body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const admin = createSupabaseAdminClient();
  const { data: current, error: currentErr } = await admin
    .from("licenses")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (currentErr) return NextResponse.json({ error: currentErr.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: "License not found" }, { status: 404 });

  const row = current as Record<string, unknown>;
  const next: Record<string, unknown> = { ...row };
  const nextStatus = status(body.status);
  if (nextStatus) next.status = nextStatus;
  const nextValidUntil = dateIso(body.validUntil);
  if (nextValidUntil) next.valid_until = nextValidUntil;

  for (const [bodyKey, rowKey] of [
    ["maxUsers", "max_users"],
    ["maxAgents", "max_agents"],
    ["maxEnvironments", "max_environments"],
    ["maxDevices", "max_devices"],
  ] as const) {
    const value = numberOrNull(body[bodyKey]);
    if (value !== undefined) next[rowKey] = value;
  }

  if (Array.isArray(body.features)) {
    next.features = body.features.filter((feature) => typeof feature === "string" && feature.trim());
  }

  const resellerEnabled =
    row.license_type === "enterprise_reseller" && body.resellerBillingEnabled === true;
  if (typeof body.resellerBillingEnabled === "boolean") {
    next.reseller_billing_enabled = resellerEnabled;
  }
  if (typeof body.tokenConsumptionBillingEnabled === "boolean") {
    next.token_consumption_billing_enabled =
      row.license_type === "enterprise_reseller" &&
      resellerEnabled &&
      body.tokenConsumptionBillingEnabled === true;
  }

  next.signed_license_payload = signLicensePayload(next);
  next.updated_at = new Date().toISOString();

  const { data: updated, error } = await admin
    .from("licenses")
    .update(next)
    .eq("id", id)
    .select("id, license_type, status, valid_until, reseller_billing_enabled, token_consumption_billing_enabled, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from("license_admin_audit_events").insert({
    actor_user_id: user.id,
    organization_id: typeof row.organization_id === "string" ? row.organization_id : null,
    license_id: id,
    action: "license.updated",
    payload: body,
  });

  return NextResponse.json({ ok: true, license: updated });
}
