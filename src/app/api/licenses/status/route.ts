import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceMembershipsForUser, type MembershipRow } from "@/lib/billing/state";
import { signLicensePayload } from "@/lib/licensing/server";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LICENSE_SELECT =
  "*, license_devices(id, device_hash, device_name, platform, app_version, activated_at, last_seen_at, deactivated_at)";

type LicenseRow = Record<string, unknown>;

function validUntilMs(row: LicenseRow): number {
  const validUntil = typeof row.valid_until === "string" ? new Date(row.valid_until).getTime() : 0;
  return Number.isFinite(validUntil) ? validUntil : 0;
}

function licenseSortMs(row: LicenseRow): number {
  return validUntilMs(row) || Date.parse(String(row.created_at || "")) || 0;
}

function isWorkspaceLicense(row: LicenseRow): boolean {
  return row.license_type === "enterprise" || row.license_type === "enterprise_reseller";
}

function isActiveishStatus(status: unknown): boolean {
  return status === "active" || status === "past_due";
}

function canManageLicense(args: {
  row: LicenseRow;
  userId: string;
  membershipByWorkspace: Map<string, MembershipRow>;
}): boolean {
  if (args.row.user_id === args.userId) return true;
  const workspaceId = typeof args.row.workspace_id === "string" ? args.row.workspace_id : "";
  return !!workspaceId && args.membershipByWorkspace.get(workspaceId)?.role === "admin";
}

function decryptVisibleLicenseKey(row: LicenseRow, canManage: boolean): string | null {
  if (!canManage || typeof row.license_key_enc !== "string" || !row.license_key_enc.trim()) {
    return null;
  }
  try {
    return decryptLlmApiKey(row.license_key_enc);
  } catch {
    return null;
  }
}

function buildEntitlement(args: {
  row: LicenseRow;
  userId: string;
  membershipByWorkspace: Map<string, MembershipRow>;
  workspaceNameById: Map<string, string>;
}) {
  const row = args.row;
  const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id : null;
  const scope = isWorkspaceLicense(row) ? "workspace" : "personal";
  const membership = workspaceId ? args.membershipByWorkspace.get(workspaceId) : null;
  const canManage = canManageLicense({
    row,
    userId: args.userId,
    membershipByWorkspace: args.membershipByWorkspace,
  });

  return {
    licensed: true,
    scope,
    workspaceId,
    workspaceName: workspaceId ? args.workspaceNameById.get(workspaceId) || null : null,
    role: membership?.role || null,
    license: signLicensePayload(row),
    licenseKey: decryptVisibleLicenseKey(row, canManage),
    devices: canManage && Array.isArray(row.license_devices) ? row.license_devices : [],
    canManageLicense: canManage,
  };
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const memberships = await getWorkspaceMembershipsForUser({ userId: user.id, admin });
  const workspaceIds = memberships.map((membership) => membership.workspace_id).filter(Boolean);
  const membershipByWorkspace = new Map(memberships.map((membership) => [membership.workspace_id, membership]));
  const workspaceId = workspaceIds[0] || null;

  const workspaceNameById = new Map<string, string>();
  if (workspaceIds.length > 0) {
    const { data: workspaceRows } = await admin
      .from("workspaces")
      .select("id, name")
      .in("id", workspaceIds);
    for (const row of workspaceRows || []) {
      const id = String((row as Record<string, unknown>).id || "");
      const name = String((row as Record<string, unknown>).name || "").trim();
      if (id && name) workspaceNameById.set(id, name);
    }
  }

  const { data: personalRows, error: personalErr } = await admin
    .from("licenses")
    .select(LICENSE_SELECT)
    .eq("user_id", user.id)
    .order("valid_until", { ascending: false });
  if (personalErr) return NextResponse.json({ error: personalErr.message }, { status: 500 });

  let workspaceRows: unknown[] = [];
  if (workspaceIds.length > 0) {
    const { data, error } = await admin
      .from("licenses")
      .select(LICENSE_SELECT)
      .in("workspace_id", workspaceIds)
      .order("valid_until", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    workspaceRows = data || [];
  }

  const chosenByScope = new Map<string, LicenseRow>();
  const addRow = (row: LicenseRow) => {
    const workspaceLicense = isWorkspaceLicense(row);
    const workspaceIdForRow = typeof row.workspace_id === "string" ? row.workspace_id : "";
    const key = workspaceLicense
      ? `workspace:${workspaceIdForRow || String(row.id || "")}`
      : "personal";
    const existing = chosenByScope.get(key);
    if (!existing || licenseSortMs(row) > licenseSortMs(existing)) {
      chosenByScope.set(key, row);
    }
  };

  for (const row of personalRows || []) addRow(row as LicenseRow);
  for (const row of workspaceRows) addRow(row as LicenseRow);

  const rows = Array.from(chosenByScope.values()).sort((a, b) => {
    const aScope = isWorkspaceLicense(a) ? 0 : 1;
    const bScope = isWorkspaceLicense(b) ? 0 : 1;
    if (aScope !== bScope) return aScope - bScope;
    return licenseSortMs(b) - licenseSortMs(a);
  });

  const entitlements = rows.map((row) =>
    buildEntitlement({
      row,
      userId: user.id,
      membershipByWorkspace,
      workspaceNameById,
    })
  );

  if (entitlements.length === 0) {
    return NextResponse.json({
      licensed: false,
      status: "unlicensed",
      workspaceId,
      licenses: [],
    });
  }

  const primary =
    entitlements.find((entry) => entry.scope === "workspace" && isActiveishStatus(entry.license.payload?.status)) ||
    entitlements.find((entry) => entry.scope === "personal" && isActiveishStatus(entry.license.payload?.status)) ||
    entitlements[0];

  return NextResponse.json({
    licensed: true,
    workspaceId: primary.workspaceId || workspaceId,
    license: primary.license,
    licenseKey: primary.licenseKey,
    devices: primary.devices,
    canManageLicense: primary.canManageLicense,
    licenses: entitlements,
  });
}
