import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getOrCreateRuntimeSessionForAgent,
  resolveRuntimeScope,
} from "@/lib/orchestrator/runtimeGraph";
import { rehomeScheduledJobsForDeletedAgent } from "@/lib/orchestrator/scheduledJobLifecycle";

type AgentConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  runtimeSessionId: string | null;
  agentId: string;
  shared?: boolean;
};

async function resolveAgentIdFromConversationId(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  conversationId: string
): Promise<string | null> {
  const id = conversationId.trim();
  if (!id) return null;

  const { data: directAgent } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", userId)
    .eq("type", "orchestrator-runtime")
    .eq("id", id)
    .maybeSingle();
  if (typeof directAgent?.id === "string" && directAgent.id) {
    return directAgent.id;
  }

  const { data: runtime } = await supabase
    .from("orchestrator_session_runtime")
    .select("agent_id")
    .eq("user_id", userId)
    .eq("session_id", id)
    .maybeSingle();
  if (typeof runtime?.agent_id === "string" && runtime.agent_id) {
    return runtime.agent_id;
  }

  const { data: session } = await supabase
    .from("orchestrator_sessions")
    .select("id,title")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!session?.id) return null;

  const title =
    typeof session.title === "string" && session.title.trim()
      ? session.title.trim()
      : "Groovy Agent";
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
    sessionId: id,
    agentId: String(createdAgent.id),
  });
  return String(createdAgent.id);
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: member } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();
  const { data: sharedRows } = member?.workspace_id
    ? await supabase
        .from("workspace_orchestrator_sessions")
        .select("session_id")
        .eq("workspace_id", member.workspace_id)
    : { data: [] as { session_id: string }[] };
  const sharedIds = (sharedRows || [])
    .map((row) => String(row.session_id || ""))
    .filter((id): id is string => id.length > 0);
  const { data: sharedAgentRows } = member?.workspace_id
    ? await supabase
        .from("workspace_orchestrator_agents")
        .select("agent_id")
        .eq("workspace_id", member.workspace_id)
    : { data: [] as { agent_id: string }[] };
  const sharedAgentIds = (sharedAgentRows || [])
    .map((row) => String((row as { agent_id?: unknown }).agent_id || ""))
    .filter((id): id is string => id.length > 0);
  if (sharedAgentIds.length > 0) {
    const { data: runtimeRows } = await supabase
      .from("orchestrator_session_runtime")
      .select("session_id,agent_id")
      .eq("user_id", user.id)
      .in("agent_id", sharedAgentIds);
    const runtimeByAgent = new Map<string, string>();
    for (const row of runtimeRows || []) {
      const aid = String((row as { agent_id?: unknown }).agent_id || "");
      const sid = String((row as { session_id?: unknown }).session_id || "");
      if (aid && sid && !runtimeByAgent.has(aid)) runtimeByAgent.set(aid, sid);
    }
    for (const agentId of sharedAgentIds) {
      const mappedSessionId =
        runtimeByAgent.get(agentId) ||
        (await getOrCreateRuntimeSessionForAgent({
          supabase,
          userId: user.id,
          agentId,
          title: "Shared Agent",
        }));
      if (mappedSessionId) {
        sharedIds.push(mappedSessionId);
      }
    }
  }
  const sharedIdSet = new Set(sharedIds);
  const sharedFilter = sharedIds.length > 0 ? `,id.in.(${sharedIds.join(",")})` : "";
  const { data: sessionRows, error } = await supabase
    .from("orchestrator_sessions")
    .select(
      `
      id,
      user_id,
      title,
      created_at,
      updated_at,
      orchestrator_messages(count)
    `
    )
    .or(`user_id.eq.${user.id}${sharedFilter}`)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("[orchestrator-agents] list sessions error:", error);
    return NextResponse.json({ error: "Failed to load conversations" }, { status: 500 });
  }

  const sessionIds = (sessionRows || []).map((row) => String(row.id || "")).filter(Boolean);
  const runtimeBySession = new Map<string, { agentId: string }>();
  if (sessionIds.length > 0) {
    const { data: runtimeRows } = await supabase
      .from("orchestrator_session_runtime")
      .select("session_id,agent_id")
      .eq("user_id", user.id)
      .in("session_id", sessionIds);
    for (const row of runtimeRows || []) {
      const sid = String((row as { session_id?: unknown }).session_id || "");
      const aid = String((row as { agent_id?: unknown }).agent_id || "");
      if (!sid || !aid) continue;
      runtimeBySession.set(sid, { agentId: aid });
    }
  }

  const sessions: AgentConversation[] = (sessionRows || []).map((row) => {
    const sid = String(row.id || "");
    const runtime = runtimeBySession.get(sid);
    const relationValue = row.orchestrator_messages as unknown;
    const relationCount = Array.isArray(relationValue)
      ? Number(
          (
            relationValue[0] as
              | {
                  count?: unknown;
                }
              | undefined
          )?.count
        )
      : Number((relationValue as { count?: unknown } | null)?.count);
    const messageCount = Number.isFinite(relationCount)
      ? Math.max(0, Math.trunc(relationCount))
      : 0;
    return {
      id: sid,
      title:
        typeof row.title === "string" && row.title.trim() ? row.title.trim() : "Groovy Agent",
      createdAt: String(row.created_at || ""),
      updatedAt: String(row.updated_at || ""),
      messageCount,
      runtimeSessionId: sid,
      agentId: runtime?.agentId || "",
      shared: sharedIdSet.has(sid),
    };
  });

  return NextResponse.json({ sessions });
}

type PostBody = {
  title?: string;
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

  const body = (await req.json().catch(() => ({}))) as PostBody;
  const title =
    typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Groovy Agent";

  const { data: agent, error } = await supabase
    .from("agents")
    .insert({
      user_id: user.id,
      type: "orchestrator-runtime",
      name: title,
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
    })
    .select("id,name,created_at,updated_at")
    .single();

  if (error || !agent?.id) {
    console.error("[orchestrator-agents] create error:", error);
    return NextResponse.json({ error: "Failed to create agent" }, { status: 500 });
  }

  const agentId = String(agent.id);
  const runtimeSessionId = await getOrCreateRuntimeSessionForAgent({
    supabase,
    userId: user.id,
    agentId,
    title,
  });
  await resolveRuntimeScope({
    supabase,
    userId: user.id,
    sessionId: runtimeSessionId,
    agentId,
  });
  if (!runtimeSessionId) {
    return NextResponse.json({ error: "Failed to initialize agent runtime" }, { status: 500 });
  }

  return NextResponse.json({
    session: {
      id: runtimeSessionId,
      title: String(agent.name || title),
      createdAt: String(agent.created_at || new Date().toISOString()),
      updatedAt: String(agent.updated_at || new Date().toISOString()),
      messageCount: 0,
      runtimeSessionId,
      agentId,
    },
  });
}

type PatchBody = {
  id?: string;
  title?: string;
};

export async function PATCH(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as PatchBody;
  const conversationId = typeof body.id === "string" ? body.id.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!conversationId || !title) {
    return NextResponse.json({ error: "id and title required" }, { status: 400 });
  }
  const agentId = await resolveAgentIdFromConversationId(supabase, user.id, conversationId);
  if (!agentId) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("agents")
    .update({
      name: title,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agentId)
    .eq("user_id", user.id);
  if (error) {
    console.error("[orchestrator-agents] rename error:", error);
    return NextResponse.json({ error: "Failed to rename agent" }, { status: 500 });
  }

  const runtimeSessionId = await getOrCreateRuntimeSessionForAgent({
    supabase,
    userId: user.id,
    agentId,
    title,
  });
  if (runtimeSessionId) {
    await supabase
      .from("orchestrator_sessions")
      .update({ title, updated_at: new Date().toISOString() })
      .eq("id", runtimeSessionId)
      .eq("user_id", user.id);
  }

  return NextResponse.json({ updated: true });
}

export async function DELETE(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const conversationId = String(searchParams.get("id") || "").trim();
  if (!conversationId) {
    return NextResponse.json({ error: "Agent ID required" }, { status: 400 });
  }
  const agentId = await resolveAgentIdFromConversationId(supabase, user.id, conversationId);
  if (!agentId) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const { data: runtimeRows } = await supabase
    .from("orchestrator_session_runtime")
    .select("session_id")
    .eq("user_id", user.id)
    .eq("agent_id", agentId);
  const runtimeSessionIds = (runtimeRows || [])
    .map((row) => String((row as { session_id?: unknown }).session_id || ""))
    .filter(Boolean);

  try {
    await rehomeScheduledJobsForDeletedAgent({
      supabase,
      userId: user.id,
      deletedAgentId: agentId,
    });
  } catch (error) {
    console.error("[orchestrator-agents] schedule rehome error:", error);
    return NextResponse.json({ error: "Failed to preserve scheduled jobs for this agent" }, { status: 500 });
  }

  const { error } = await supabase
    .from("agents")
    .delete()
    .eq("id", agentId)
    .eq("user_id", user.id);
  if (error) {
    console.error("[orchestrator-agents] delete error:", error);
    return NextResponse.json({ error: "Failed to delete agent" }, { status: 500 });
  }

  if (runtimeSessionIds.length > 0) {
    await supabase
      .from("orchestrator_sessions")
      .delete()
      .eq("user_id", user.id)
      .in("id", runtimeSessionIds);
  }

  return NextResponse.json({ deleted: true });
}
