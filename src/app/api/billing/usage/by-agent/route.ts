/**
 * Per-agent usage breakdown for the usage dashboard.
 * GET ?days=30
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildAgentUsageReport } from "@/lib/billing/agentUsageReport";

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
  const days = Number(new URL(req.url).searchParams.get("days")) || 30;
  const report = await buildAgentUsageReport({ userId: user.id, days });
  return NextResponse.json(report);
}
