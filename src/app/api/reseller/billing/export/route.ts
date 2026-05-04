import { NextResponse } from "next/server";
import { getCurrentLicenseAccess, hasResellerBillingLicense } from "@/lib/licensing/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UsageRow = {
  id: string;
  created_at: string;
  user_id: string | null;
  source: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  model_cost_usd: number | null;
  total_charge_usd: number | null;
  meta: Record<string, unknown> | null;
};

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function finiteNumber(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function customerIdFor(row: UsageRow, fallback: string | null): string {
  const meta = row.meta || {};
  for (const key of ["resellerCustomerId", "externalCustomerId", "customerId", "workspaceCustomerId"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback || "unknown";
}

function markupAmount(baseCost: number, settings: Record<string, unknown> | null): number {
  if (!settings?.enabled) return 0;
  const type = settings.markup_type;
  const value = finiteNumber(settings.markup_value);
  if (type === "none") return 0;
  if (type === "fixed") return value;
  return baseCost * (value / 100);
}

export async function GET(req: Request) {
  const access = await getCurrentLicenseAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!access.canManageLicense || access.membershipRole !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  if (!hasResellerBillingLicense(access.license)) {
    return NextResponse.json({ error: "Enterprise reseller billing license required" }, { status: 403 });
  }
  if (!access.workspaceId) return NextResponse.json({ error: "Workspace required" }, { status: 400 });

  const url = new URL(req.url);
  const now = Date.now();
  const from = new Date(url.searchParams.get("from") || now - 30 * 24 * 60 * 60 * 1000);
  const to = new Date(url.searchParams.get("to") || now);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
  }

  const organizationId =
    typeof access.license?.organization_id === "string" ? access.license.organization_id : "";
  const { data: settings } = await access.admin
    .from("reseller_billing_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const { data, error } = await access.admin
    .from("billing_usage_events")
    .select(
      "id, created_at, user_id, source, provider, model, input_tokens, output_tokens, total_tokens, model_cost_usd, total_charge_usd, meta"
    )
    .eq("workspace_id", access.workspaceId)
    .gte("created_at", from.toISOString())
    .lte("created_at", to.toISOString())
    .order("created_at", { ascending: true })
    .limit(10000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const events = ((data || []) as UsageRow[]).map((row) => {
    const baseCost = finiteNumber(row.model_cost_usd);
    const markup = markupAmount(baseCost, settings as Record<string, unknown> | null);
    return {
      eventId: row.id,
      timestamp: row.created_at,
      customerId: customerIdFor(row, access.workspaceId),
      userId: row.user_id,
      source: row.source,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens || 0,
      outputTokens: row.output_tokens || 0,
      totalTokens: row.total_tokens || 0,
      providerCostUsd: baseCost,
      markupUsd: Math.round((markup + Number.EPSILON) * 1_000_000) / 1_000_000,
      billableAmountUsd: Math.round((baseCost + markup + Number.EPSILON) * 1_000_000) / 1_000_000,
    };
  });

  if (url.searchParams.get("format") === "csv") {
    const rows = [
      [
        "event_id",
        "timestamp",
        "customer_id",
        "provider",
        "model",
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "provider_cost_usd",
        "markup_usd",
        "billable_amount_usd",
      ],
      ...events.map((event) => [
        event.eventId,
        event.timestamp,
        event.customerId,
        event.provider,
        event.model,
        event.inputTokens,
        event.outputTokens,
        event.totalTokens,
        event.providerCostUsd,
        event.markupUsd,
        event.billableAmountUsd,
      ]),
    ];
    return new NextResponse(rows.map((row) => row.map(csvEscape).join(",")).join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="groovy-reseller-billing-${String(access.license?.id).slice(0, 8)}.csv"`,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    range: { from: from.toISOString(), to: to.toISOString() },
    settings: settings || null,
    events,
  });
}
