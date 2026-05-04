import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * GET /api/orchestrator/agent-sessions/list?agentType=files[&orchestratorSessionId=...]
 * Lists orchestrator-linked agent sessions (not all agent chat_sessions).
 */
export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const agentType = String(searchParams.get("agentType") || "").toLowerCase();
  const orchestratorSessionId = String(searchParams.get("orchestratorSessionId") || "");

  if (!agentType) {
    return NextResponse.json({ error: "Missing agentType" }, { status: 400 });
  }

  let q = supabase
    .from("orchestrator_agent_sessions")
    .select("orchestrator_session_id, agent_id, agent_session_id, created_at")
    .eq("user_id", user.id)
    .eq("agent_type", agentType)
    .order("created_at", { ascending: false })
    .limit(200);

  if (orchestratorSessionId) {
    q = q.eq("orchestrator_session_id", orchestratorSessionId);
  }

  const { data: links, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const agentSessionIds = Array.from(
    new Set((links || []).map((l) => String(l.agent_session_id || "")).filter(Boolean))
  );

  // Load titles for those chat sessions
  const { data: chatSessions, error: csErr } = await supabase
    .from("chat_sessions")
    .select("id, title, updated_at, created_at")
    .in("id", agentSessionIds);
  if (csErr) {
    return NextResponse.json({ error: csErr.message }, { status: 500 });
  }

  const byId = new Map(
    (chatSessions || []).map((s) => [
      String(s.id),
      {
        id: String(s.id),
        title: typeof s.title === "string" ? s.title : "",
        updatedAt: String((s.updated_at || "") as string),
        createdAt: String((s.created_at || "") as string),
      },
    ])
  );

  const result = (links || [])
    .map((l) => {
      const sid = String(l.agent_session_id || "");
      const meta = byId.get(sid);
      return {
        orchestratorSessionId: String(l.orchestrator_session_id || ""),
        agentId: String(l.agent_id || ""),
        agentSessionId: sid,
        title: meta?.title || "",
        updatedAt: meta?.updatedAt || "",
        createdAt: meta?.createdAt || "",
      };
    })
    // de-dupe in case of historical duplicates (shouldn't happen, but safe)
    .filter(
      (v, idx, arr) =>
        v.agentSessionId && arr.findIndex((x) => x.agentSessionId === v.agentSessionId) === idx
    );

  return NextResponse.json({ ok: true, sessions: result });
}

