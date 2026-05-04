import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type ActivityInput = {
  agent: string;
  action: string;
  detail?: string;
  status?: string;
  traceId?: string;
  sessionId?: string; // Orchestrator session ID
  agentId?: string | null; // Orchestrator runtime agent ID
  metadata?: Record<string, unknown>;
};

// Validate UUID format
function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

/**
 * GET /api/activity - Load recent activity for the user
 */
export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
  const since = url.searchParams.get("since"); // ISO timestamp

  let query = supabase
    .from("activity_log")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (since) {
    query = query.gte("created_at", since);
  }

  const { data: activities, error } = await query;

  if (error) {
    console.error("[activity] Load error:", error);
    return NextResponse.json({ error: "Failed to load activity" }, { status: 500 });
  }

  return NextResponse.json({ 
    activities: activities || [],
    count: activities?.length || 0,
  });
}

/**
 * POST /api/activity - Save activity events
 */
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Handle single activity or batch
  const activities: ActivityInput[] = Array.isArray(body.activities) 
    ? body.activities 
    : body.activity 
      ? [body.activity]
      : [];

  if (activities.length === 0) {
    return NextResponse.json({ error: "No activities provided" }, { status: 400 });
  }

  // Insert activities
  const rows = activities.map((a) => {
    const existingMetadata =
      a.metadata && typeof a.metadata === "object" ? a.metadata : undefined;
    const metadata =
      a.agentId && typeof a.agentId === "string" && a.agentId.trim()
        ? { ...(existingMetadata || {}), orchestrator_agent_id: a.agentId.trim() }
        : existingMetadata;
    return {
      user_id: user.id,
      agent: a.agent || "system",
      action: a.action || "Unknown",
      detail: a.detail?.slice(0, 500),
      status: a.status || "complete",
      trace_id: a.traceId,
      // Only set session_id if it's a valid UUID
      session_id: a.sessionId && isValidUUID(a.sessionId) ? a.sessionId : null,
      metadata,
    };
  });

  const { error } = await supabase.from("activity_log").insert(rows);

  if (error) {
    console.error("[activity] Insert error:", error);
    return NextResponse.json({ error: "Failed to save activity" }, { status: 500 });
  }

  return NextResponse.json({ saved: rows.length });
}

/**
 * DELETE /api/activity - Clear activity (optional)
 */
export async function DELETE() {
  const supabase = await createSupabaseServerClient();
  
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("activity_log")
    .delete()
    .eq("user_id", user.id);

  if (error) {
    console.error("[activity] Delete error:", error);
    return NextResponse.json({ error: "Failed to clear activity" }, { status: 500 });
  }

  return NextResponse.json({ cleared: true });
}
