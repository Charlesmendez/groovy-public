/**
 * Per-agent usage breakdown for the usage dashboard.
 * GET ?days=30
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildAgentUsageReport } from "@/lib/billing/agentUsageReport";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({
    userId: user.id,
    admin,
  });
  if (!membership) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }
  if (membership.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const url = new URL(req.url);
  const from = url.searchParams.get("from") || undefined;
  const to = url.searchParams.get("to") || undefined;
  const teamMemberId = (url.searchParams.get("teamMemberId") || "").trim() || null;
  if (from && !Number.isFinite(new Date(from).getTime())) {
    return NextResponse.json({ error: "Invalid 'from' date" }, { status: 400 });
  }
  if (to && !Number.isFinite(new Date(to).getTime())) {
    return NextResponse.json({ error: "Invalid 'to' date" }, { status: 400 });
  }
  if (teamMemberId) {
    const { data: selectedMember } = await admin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", membership.workspace_id)
      .eq("user_id", teamMemberId)
      .maybeSingle();
    if (!selectedMember) {
      return NextResponse.json(
        { error: "Team member is not in this workspace" },
        { status: 400 },
      );
    }
  }

  const days = Number(url.searchParams.get("days")) || 30;
  const report = await buildAgentUsageReport({
    userId: user.id,
    workspaceId: membership.workspace_id,
    teamMemberId,
    from,
    to,
    days,
  });
  return NextResponse.json(report);
}
