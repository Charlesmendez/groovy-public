import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getOrCreateRuntimeSessionForAgent,
  resolveRuntimeScope,
} from "@/lib/orchestrator/runtimeGraph";

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function resolveAgentIdFromConversation(args: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  userId: string;
  conversationId: string;
}): Promise<string | null> {
  const { supabase, userId, conversationId } = args;

  const { data: directAgent } = await supabase
    .from("agents")
    .select("id,type")
    .eq("id", conversationId)
    .eq("type", "orchestrator-runtime")
    .maybeSingle();
  if (typeof directAgent?.id === "string" && directAgent.id) return directAgent.id;

  const { data: runtimeMap } = await supabase
    .from("orchestrator_session_runtime")
    .select("agent_id")
    .eq("session_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (typeof runtimeMap?.agent_id === "string" && runtimeMap.agent_id) return runtimeMap.agent_id;

  const { data: session } = await supabase
    .from("orchestrator_sessions")
    .select("id,title")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!session?.id) return null;

  const title = asTrimmed(session.title) || "Groovy Agent";
  const { data: createdAgent } = await supabase
    .from("agents")
    .insert({
      user_id: userId,
      type: "orchestrator-runtime",
      name: title,
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
    })
    .select("id")
    .single();
  if (!createdAgent?.id) return null;

  await resolveRuntimeScope({
    supabase,
    userId,
    sessionId: conversationId,
    agentId: String(createdAgent.id),
  });

  return String(createdAgent.id);
}

type Body = {
  sessionId?: string;
  conversationId?: string;
  agentId?: string;
};

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const requestedAgentId = asTrimmed(body.agentId);
  const conversationId = asTrimmed(body.conversationId || body.sessionId);

  let agentId = requestedAgentId;
  if (!agentId && conversationId) {
    agentId =
      (await resolveAgentIdFromConversation({
        supabase,
        userId: user.id,
        conversationId,
      })) || "";
  }
  if (!agentId) {
    return NextResponse.json({ error: "agentId or conversationId required" }, { status: 400 });
  }

  const { data: agent } = await supabase
    .from("agents")
    .select("id,user_id,name,type")
    .eq("id", agentId)
    .eq("type", "orchestrator-runtime")
    .maybeSingle();
  if (!agent?.id) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();
  if (!membership?.workspace_id) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  const workspaceId = String(membership.workspace_id);

  let runtimeSessionId: string | null = null;
  if (conversationId) {
    const { data: existingSession } = await supabase
      .from("orchestrator_sessions")
      .select("id")
      .eq("id", conversationId)
      .maybeSingle();
    runtimeSessionId =
      typeof existingSession?.id === "string" && existingSession.id
        ? existingSession.id
        : null;
  }
  if (!runtimeSessionId) {
    runtimeSessionId = await getOrCreateRuntimeSessionForAgent({
      supabase,
      userId: user.id,
      agentId,
      title: asTrimmed(agent.name) || "Groovy Agent",
    });
  }

  const { error: shareAgentErr } = await supabase
    .from("workspace_orchestrator_agents")
    .insert({
      workspace_id: workspaceId,
      agent_id: agentId,
      created_by_user_id: user.id,
    });
  if (shareAgentErr && shareAgentErr.code !== "23505") {
    const msg = String(shareAgentErr.message || "");
    if (shareAgentErr.code === "42501" || /row-level security/i.test(msg)) {
      return NextResponse.json(
        { error: "You are not allowed to share this agent" },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: shareAgentErr.message || "Failed to share agent" },
      { status: 500 }
    );
  }

  if (runtimeSessionId) {
    const { error: shareSessionErr } = await supabase
      .from("workspace_orchestrator_sessions")
      .insert({
        workspace_id: workspaceId,
        session_id: runtimeSessionId,
        created_by_user_id: user.id,
      });
    if (shareSessionErr && shareSessionErr.code !== "23505") {
      return NextResponse.json(
        { error: shareSessionErr.message || "Failed to share runtime session" },
        { status: 500 }
      );
    }
  }

  const { data: memberRows } = await supabase
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId);
  const ownerUserId = asTrimmed((agent as { user_id?: unknown }).user_id);
  if (Array.isArray(memberRows) && memberRows.length > 0) {
    const { error: memberAclErr } = await supabase.from("orchestrator_agent_members").upsert(
      memberRows
        .map((row) => {
          const memberUserId = asTrimmed((row as { user_id?: unknown }).user_id);
          if (!memberUserId) return null;
          return {
            agent_id: agentId,
            user_id: memberUserId,
            role: memberUserId === ownerUserId ? "owner" : "viewer",
            created_by_user_id: user.id,
            updated_at: new Date().toISOString(),
          };
        })
        .filter(
          (
            row
          ): row is {
            agent_id: string;
            user_id: string;
            role: "owner" | "viewer";
            created_by_user_id: string;
            updated_at: string;
          } => row !== null
        ),
      { onConflict: "agent_id,user_id" }
    );
    if (memberAclErr) {
      console.warn("[orchestrator-agents/share] failed to seed orchestrator_agent_members", {
        workspaceId,
        agentId,
        error: memberAclErr.message,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    shared: true,
    workspaceId,
    agentId,
    runtimeSessionId: runtimeSessionId || null,
  });
}
