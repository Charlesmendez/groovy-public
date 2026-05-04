import { NextResponse } from "next/server";
import { getCurrentLicenseAccess } from "@/lib/licensing/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function asLimit(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: Request) {
  const access = await getCurrentLicenseAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!access.canManageLicense || access.membershipRole !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  const license = access.license;
  if (!license || (license.license_type !== "enterprise" && license.license_type !== "enterprise_reseller")) {
    return NextResponse.json({ error: "Enterprise license required" }, { status: 403 });
  }

  const workspaceId = access.workspaceId;
  const admin = access.admin;
  const now = new Date().toISOString();

  const [
    activeUsers,
    sharedAgents,
    usageEvents,
    toolEvents,
    devices,
  ] = await Promise.all([
    workspaceId
      ? admin
          .from("workspace_members")
          .select("user_id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
      : Promise.resolve({ count: 1 }),
    workspaceId
      ? admin
          .from("workspace_orchestrator_agents")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
      : admin
          .from("agents")
          .select("id", { count: "exact", head: true })
          .eq("user_id", access.user.id),
    workspaceId
      ? admin
          .from("billing_usage_events")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
      : Promise.resolve({ count: 0 }),
    workspaceId
      ? admin
          .from("billing_tool_events")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
      : Promise.resolve({ count: 0 }),
    admin
      .from("license_devices")
      .select("id", { count: "exact", head: true })
      .eq("license_id", String(license.id))
      .is("deactivated_at", null),
  ]);

  const payload = {
    generatedAt: now,
    licenseId: license.id,
    licenseType: license.license_type,
    status: license.status,
    validUntil: license.valid_until,
    workspaceId,
    usage: {
      activeUsers: activeUsers.count || 0,
      activeDevices: devices.count || 0,
      sharedOrOwnedAgents: sharedAgents.count || 0,
      productionEnvironmentsObserved: workspaceId ? 1 : 0,
      usageEventCount: usageEvents.count || 0,
      toolEventCount: toolEvents.count || 0,
    },
    limits: {
      maxUsers: asLimit(license.max_users),
      maxAgents: asLimit(license.max_agents ?? license.production_agents),
      maxEnvironments: asLimit(license.max_environments ?? license.production_environments),
      maxDevices: asLimit(license.max_devices),
    },
  };

  await admin.from("usage_reports").insert({
    organization_id: typeof license.organization_id === "string" ? license.organization_id : null,
    license_id: String(license.id),
    workspace_id: workspaceId,
    report_type: "enterprise_true_up",
    payload,
    created_by_user_id: access.user.id,
  });

  const format = new URL(req.url).searchParams.get("format");
  if (format === "csv") {
    const rows = [
      ["metric", "value", "limit"],
      ["active_users", payload.usage.activeUsers, payload.limits.maxUsers],
      ["active_devices", payload.usage.activeDevices, payload.limits.maxDevices],
      ["shared_or_owned_agents", payload.usage.sharedOrOwnedAgents, payload.limits.maxAgents],
      ["production_environments_observed", payload.usage.productionEnvironmentsObserved, payload.limits.maxEnvironments],
      ["usage_events", payload.usage.usageEventCount, ""],
      ["tool_events", payload.usage.toolEventCount, ""],
    ];
    return new NextResponse(rows.map((row) => row.map(csvEscape).join(",")).join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="groovy-enterprise-usage-${String(license.id).slice(0, 8)}.csv"`,
      },
    });
  }

  return NextResponse.json({ ok: true, report: payload });
}
