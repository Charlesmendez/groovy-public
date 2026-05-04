import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureOrchestratorRuntimeAgentId } from "@/lib/orchestrator/runtimeAgents";
import { resolveRuntimeScope, rotateAgentEpoch } from "@/lib/orchestrator/runtimeGraph";

type Body = {
  sessionId?: string;
  agentId?: string;
  reason?: string;
};

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  const sessionId = asString(body?.sessionId);
  const requestedAgentId = asString(body?.agentId);
  const reason = asString(body?.reason) || "clear_conversation";

  let agentId = requestedAgentId;
  if (!agentId) {
    const scope = await resolveRuntimeScope({
      supabase,
      userId: user.id,
      sessionId,
      agentId: null,
    });
    agentId = scope?.agentId || null;
  }
  if (!agentId) {
    agentId = await ensureOrchestratorRuntimeAgentId(supabase, user.id);
  }
  if (!agentId) {
    return NextResponse.json({ error: "Failed to resolve runtime agent" }, { status: 500 });
  }

  const rotated = await rotateAgentEpoch({
    supabase,
    userId: user.id,
    agentId,
    sessionId,
    reason,
  });
  if (!rotated) {
    return NextResponse.json({ error: "Failed to rotate epoch" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    runtime: {
      agentId: rotated.agentId,
      epochId: rotated.epochId,
      branchId: rotated.branchId,
    },
  });
}
