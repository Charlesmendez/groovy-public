import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createAgentTrace, ingestAgentTraceToDatagranBestEffort } from "@/lib/traces/agentTraces";

type PostBody = {
  agentId?: unknown;
  prompt?: unknown;
};

function toStringOrEmpty(v: unknown) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const agentId = toStringOrEmpty(body.agentId).trim();
  const prompt = toStringOrEmpty(body.prompt).trim();
  if (!agentId || !prompt) {
    return NextResponse.json(
      { error: "Missing agentId or prompt" },
      { status: 400 }
    );
  }

  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id,name,type,flag_key,provider,model")
    .eq("id", agentId)
    .single();

  if (agentError || !agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const trace = await createAgentTrace(supabase, {
    userId: user.id,
    agentId,
    sessionId: null,
    agentName: String(agent.name || "Agent"),
    agentType: String(agent.type || "unknown"),
    flagKey: (agent as unknown as { flag_key?: string | null }).flag_key || null,
    provider: (agent as unknown as { provider?: string | null }).provider || null,
    model: (agent as unknown as { model?: string | null }).model || null,
    prompt,
    metadata: { source: "client" },
  });

  if (trace.traceId) {
    // Fire-and-forget: don't block response waiting for Datagran
    ingestAgentTraceToDatagranBestEffort(supabase, {
      userId: user.id,
      traceId: trace.traceId,
      createdAtIso: trace.createdAtIso,
      agentName: String(agent.name || "Agent"),
      agentType: String(agent.type || "unknown"),
      flagKey: (agent as unknown as { flag_key?: string | null }).flag_key || null,
      provider: (agent as unknown as { provider?: string | null }).provider || null,
      model: (agent as unknown as { model?: string | null }).model || null,
      sessionId: null,
      prompt,
      response: null,
      metadata: { source: "client" },
    });
  }

  return NextResponse.json({ success: true });
}

