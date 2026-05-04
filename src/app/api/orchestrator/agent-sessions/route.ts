import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * GET /api/orchestrator/agent-sessions?orchestratorSessionId=...&agentType=files
 * POST /api/orchestrator/agent-sessions  { orchestratorSessionId, agentType }
 *
 * Currently used to link an orchestrator session to a Files agent chat_session.
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
  const orchestratorSessionId = searchParams.get("orchestratorSessionId") || "";
  const agentType = (searchParams.get("agentType") || "").toLowerCase();

  if (!orchestratorSessionId || !agentType) {
    return NextResponse.json(
      { error: "Missing orchestratorSessionId or agentType" },
      { status: 400 }
    );
  }

  const { data: row, error } = await supabase
    .from("orchestrator_agent_sessions")
    .select("agent_type, agent_id, agent_session_id")
    .eq("user_id", user.id)
    .eq("orchestrator_session_id", orchestratorSessionId)
    .eq("agent_type", agentType)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!row) {
    return NextResponse.json({ ok: true, session: null });
  }

  return NextResponse.json({
    ok: true,
    session: {
      agentType: row.agent_type,
      agentId: row.agent_id,
      agentSessionId: row.agent_session_id,
    },
  });
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const orchestratorSessionId =
    typeof body.orchestratorSessionId === "string" ? body.orchestratorSessionId : "";
  const agentType = typeof body.agentType === "string" ? body.agentType.toLowerCase() : "";

  if (!orchestratorSessionId || !agentType) {
    return NextResponse.json(
      { error: "Missing orchestratorSessionId or agentType" },
      { status: 400 }
    );
  }

  // Verify orchestrator session is visible to user (owned OR workspace-shared via RLS)
  const { data: orchSession } = await supabase
    .from("orchestrator_sessions")
    .select("id, title")
    .eq("id", orchestratorSessionId)
    .single();

  if (!orchSession) {
    return NextResponse.json({ error: "Orchestrator session not found" }, { status: 404 });
  }

  // If already exists, return it
  const { data: existing } = await supabase
    .from("orchestrator_agent_sessions")
    .select("agent_type, agent_id, agent_session_id")
    .eq("user_id", user.id)
    .eq("orchestrator_session_id", orchestratorSessionId)
    .eq("agent_type", agentType)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({
      ok: true,
      session: {
        agentType: existing.agent_type,
        agentId: existing.agent_id,
        agentSessionId: existing.agent_session_id,
      },
    });
  }

  if (agentType !== "files") {
    return NextResponse.json({ error: "Unsupported agentType" }, { status: 400 });
  }

  // Choose default Files agent for this user (first created)
  const { data: filesAgent } = await supabase
    .from("agents")
    .select("id, name")
    .eq("user_id", user.id)
    .eq("type", "files-agent")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!filesAgent?.id) {
    return NextResponse.json(
      { error: "No Files agent configured. Create one in Settings first." },
      { status: 400 }
    );
  }

  // Create agent-specific chat session
  const { data: createdChatSession, error: chatErr } = await supabase
    .from("chat_sessions")
    .insert({
      user_id: user.id,
      agent_id: filesAgent.id,
      title: orchSession.title ? `Files: ${orchSession.title}` : "Files session",
    })
    .select("id")
    .single();

  if (chatErr || !createdChatSession?.id) {
    return NextResponse.json({ error: chatErr?.message || "Failed to create files session" }, { status: 500 });
  }

  const { error: linkErr } = await supabase.from("orchestrator_agent_sessions").insert({
    user_id: user.id,
    orchestrator_session_id: orchestratorSessionId,
    agent_type: "files",
    agent_id: filesAgent.id,
    agent_session_id: createdChatSession.id,
  });

  if (linkErr) {
    return NextResponse.json({ error: linkErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    session: {
      agentType: "files",
      agentId: filesAgent.id,
      agentSessionId: createdChatSession.id,
    },
  });
}

