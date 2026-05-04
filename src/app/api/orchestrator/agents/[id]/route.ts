import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getOrCreateRuntimeSessionForAgent,
  resolveRuntimeScope,
} from "@/lib/orchestrator/runtimeGraph";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/orchestrator/agents/[id] - Get agent runtime conversation
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const supabase = await createSupabaseServerClient();
  const { id: conversationId } = await params;

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let runtimeSessionId: string | null = null;
  let runtimeAgentId: string | null = null;
  let activeEpochId: string | null = null;
  let responseTitle = "Groovy Agent";
  let responseCreatedAt = "";
  let responseUpdatedAt = "";

  // Conversation IDs are runtime session IDs in the new UI.
  // Keep compatibility: if an agent ID is passed, resolve/create a runtime session.
  const { data: sessionRow } = await supabase
    .from("orchestrator_sessions")
    .select("id,title,created_at,updated_at")
    .eq("id", conversationId)
    .maybeSingle();

  if (sessionRow?.id) {
    runtimeSessionId = String(sessionRow.id);
    responseTitle =
      typeof sessionRow.title === "string" && sessionRow.title.trim()
        ? sessionRow.title.trim()
        : "Groovy Agent";
    responseCreatedAt = String(sessionRow.created_at || "");
    responseUpdatedAt = String(sessionRow.updated_at || "");
  } else {
    const { data: agent } = await supabase
      .from("agents")
      .select("id,name")
      .eq("id", conversationId)
      .eq("user_id", user.id)
      .eq("type", "orchestrator-runtime")
      .maybeSingle();
    if (!agent?.id) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    runtimeAgentId = String(agent.id);
    responseTitle =
      typeof agent.name === "string" && agent.name.trim() ? agent.name.trim() : "Groovy Agent";
    runtimeSessionId = await getOrCreateRuntimeSessionForAgent({
      supabase,
      userId: user.id,
      agentId: runtimeAgentId,
      title: responseTitle,
    });
    if (!runtimeSessionId) {
      return NextResponse.json({ error: "Failed to resolve conversation" }, { status: 500 });
    }

    const { data: createdSession } = await supabase
      .from("orchestrator_sessions")
      .select("title,created_at,updated_at")
      .eq("id", runtimeSessionId)
      .maybeSingle();
    responseTitle =
      typeof createdSession?.title === "string" && createdSession.title.trim()
        ? createdSession.title.trim()
        : responseTitle;
    responseCreatedAt = String((createdSession as { created_at?: unknown } | null)?.created_at || "");
    responseUpdatedAt = String((createdSession as { updated_at?: unknown } | null)?.updated_at || "");
  }

  const { data: runtimeMap } = await supabase
    .from("orchestrator_session_runtime")
    .select("agent_id,active_epoch_id")
    .eq("session_id", runtimeSessionId)
    .eq("user_id", user.id)
    .maybeSingle();
  runtimeAgentId =
    typeof (runtimeMap as { agent_id?: unknown } | null)?.agent_id === "string"
      ? ((runtimeMap as { agent_id?: string }).agent_id as string)
      : runtimeAgentId;
  activeEpochId =
    typeof (runtimeMap as { active_epoch_id?: unknown } | null)?.active_epoch_id === "string"
      ? ((runtimeMap as { active_epoch_id?: string }).active_epoch_id as string)
      : null;

  // For owned sessions opened through an agent ID, ensure runtime scope exists.
  if (!activeEpochId && runtimeAgentId) {
    const scope = await resolveRuntimeScope({
      supabase,
      userId: user.id,
      sessionId: runtimeSessionId,
      agentId: runtimeAgentId,
    });
    activeEpochId = scope?.epochId || null;
    runtimeAgentId = scope?.agentId || runtimeAgentId;
  }

  // Shared workspace conversations are collaborative threads.
  // Do not epoch-scope them by per-user runtime rows, or teammate messages can disappear.
  const { data: sharedSessionRow } = await supabase
    .from("workspace_orchestrator_sessions")
    .select("id")
    .eq("session_id", runtimeSessionId)
    .limit(1)
    .maybeSingle();
  const isWorkspaceShared = !!sharedSessionRow;

  let useEpochScope = false;
  if (!isWorkspaceShared && activeEpochId) {
    const { count } = await supabase
      .from("orchestrator_messages")
      .select("id", { count: "exact", head: true })
      .eq("session_id", runtimeSessionId)
      .not("epoch_id", "is", null);
    useEpochScope = Number.isFinite(Number(count)) && Number(count) > 0;
  }

  let epochCountForAgent = 0;
  if (runtimeAgentId) {
    const { count } = await supabase
      .from("orchestrator_agent_epochs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("agent_id", runtimeAgentId);
    epochCountForAgent = Number.isFinite(Number(count)) ? Number(count) : 0;
  }

  let messageQuery = supabase
    .from("orchestrator_messages")
    .select("*")
    .eq("session_id", runtimeSessionId)
    .order("created_at", { ascending: true });
  if (!isWorkspaceShared && useEpochScope && activeEpochId) {
    if (epochCountForAgent > 1) {
      messageQuery = messageQuery.eq("epoch_id", activeEpochId);
    } else {
      messageQuery = messageQuery.or(`epoch_id.is.null,epoch_id.eq.${activeEpochId}`);
    }
  }
  const { data: messages } = await messageQuery;

  let activities: Array<{
    id: string;
    agent: string;
    action: string;
    detail: string | null;
    status: string;
    metadata: unknown;
    created_at: string;
  }> = [];
  if (runtimeSessionId) {
    const { data: activityRows } = await supabase
      .from("activity_log")
      .select("*")
      .eq("session_id", runtimeSessionId)
      .order("created_at", { ascending: true });
    activities = (activityRows || []) as typeof activities;
  }

  return NextResponse.json({
    session: {
      id: runtimeSessionId || conversationId,
      title: responseTitle,
      createdAt: responseCreatedAt,
      updatedAt: responseUpdatedAt,
      runtimeSessionId,
      agentId: runtimeAgentId || "",
    },
    messages: (messages || []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      traceId: m.trace_id,
      metadata: m.metadata,
      timestamp: m.created_at,
      created_at: m.created_at,
    })),
    activities: activities.map((a) => ({
      id: a.id,
      agent: a.agent,
      action: a.action,
      detail: a.detail,
      status: a.status,
      metadata: a.metadata,
      timestamp: a.created_at,
      created_at: a.created_at,
    })),
  });
}
