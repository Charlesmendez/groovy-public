import { NextResponse } from "next/server";
import { getCurrentLicenseAccess, hasResellerBillingLicense } from "@/lib/licensing/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  enabled?: boolean;
  markupType?: "percent" | "fixed" | "none";
  markupValue?: number;
  billingCurrency?: string;
};

function markupType(value: unknown): "percent" | "fixed" | "none" {
  return value === "fixed" || value === "none" || value === "percent" ? value : "percent";
}

function markupValue(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function GET() {
  const access = await getCurrentLicenseAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!access.canManageLicense || access.membershipRole !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  if (!hasResellerBillingLicense(access.license)) {
    return NextResponse.json({ error: "Enterprise reseller billing license required" }, { status: 403 });
  }

  const organizationId =
    typeof access.license?.organization_id === "string" ? access.license.organization_id : "";
  const { data, error } = await access.admin
    .from("reseller_billing_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    settings:
      data || {
        organization_id: organizationId,
        enabled: false,
        markup_type: "percent",
        markup_value: 0,
        billing_currency: "usd",
      },
  });
}

export async function POST(req: Request) {
  const access = await getCurrentLicenseAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!access.canManageLicense || access.membershipRole !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  if (!hasResellerBillingLicense(access.license)) {
    return NextResponse.json({ error: "Enterprise reseller billing license required" }, { status: 403 });
  }

  const organizationId =
    typeof access.license?.organization_id === "string" ? access.license.organization_id : "";
  if (!organizationId) return NextResponse.json({ error: "Missing organization" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const row = {
    organization_id: organizationId,
    enabled: body?.enabled === true,
    markup_type: markupType(body?.markupType),
    markup_value: markupValue(body?.markupValue),
    billing_currency:
      typeof body?.billingCurrency === "string" && body.billingCurrency.trim()
        ? body.billingCurrency.trim().toLowerCase().slice(0, 8)
        : "usd",
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await access.admin
    .from("reseller_billing_settings")
    .upsert(row, { onConflict: "organization_id" })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, settings: data });
}
