import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { applyPendingInboxActionSilencePolicy } from "@/lib/inbox/actions";
import {
  getOrCreateRuntimeSessionForAgent,
  resolveRuntimeScope,
  incrementBranchTurnCount,
} from "@/lib/orchestrator/runtimeGraph";

/**
 * POST /api/orchestrator/messages - Save a message to a session
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

  const { sessionId: sessionIdRaw, role, content, traceId, metadata, agentId: requestedAgentIdRaw } = body;
  let sessionId =
    typeof sessionIdRaw === "string" && sessionIdRaw.trim() ? sessionIdRaw.trim() : null;
  const requestedAgentId =
    typeof requestedAgentIdRaw === "string" && requestedAgentIdRaw.trim()
      ? requestedAgentIdRaw.trim()
      : null;
  const normalizedRole = typeof role === "string" ? role.trim().toLowerCase() : "";
  const normalizedTraceId =
    typeof traceId === "string" && traceId.trim() ? traceId.trim() : null;
  const messageText = typeof content === "string" ? content : String(content || "");

  if ((!sessionId && !requestedAgentId) || !role || !content) {
    return NextResponse.json(
      { error: "agentId or sessionId, role, and content required" },
      { status: 400 }
    );
  }
  if (normalizedRole !== "user" && normalizedRole !== "assistant") {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  if (sessionId) {
    const { data: session } = await supabase
      .from("orchestrator_sessions")
      .select("id")
      .eq("id", sessionId)
      .single();
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
  } else if (requestedAgentId) {
    sessionId = await getOrCreateRuntimeSessionForAgent({
      supabase,
      userId: user.id,
      agentId: requestedAgentId,
      title: "Groovy Agent",
    });
  }

  const runtimeScope = await resolveRuntimeScope({
    supabase,
    userId: user.id,
    sessionId: sessionId || null,
    agentId: requestedAgentId,
  });
  if (!runtimeScope) {
    return NextResponse.json({ error: "Failed to resolve runtime scope" }, { status: 500 });
  }

  // Best-effort idempotency: avoid duplicate writes when both server-side and
  // client-side persistence race to save the same assistant response.
  if (sessionId && normalizedTraceId) {
    const { data: existingByTrace, error: existingByTraceError } = await supabase
      .from("orchestrator_messages")
      .select("id")
      .eq("user_id", user.id)
      .eq("session_id", sessionId)
      .eq("role", normalizedRole)
      .eq("trace_id", normalizedTraceId)
      .limit(1);
    if (!existingByTraceError && Array.isArray(existingByTrace) && existingByTrace.length > 0) {
      return NextResponse.json({ saved: true, deduped: true, id: existingByTrace[0].id });
    }
  }

  // Insert message
  const { error } = await supabase
    .from("orchestrator_messages")
    .insert({
      user_id: user.id,
      session_id: sessionId,
      agent_id: runtimeScope.agentId,
      epoch_id: runtimeScope.epochId,
      branch_id: runtimeScope.branchId,
      role: normalizedRole,
      content: messageText,
      trace_id: normalizedTraceId,
      metadata: metadata && typeof metadata === "object" ? metadata : undefined,
    });

  if (error) {
    console.error("[messages] Insert error:", error);
    return NextResponse.json({ error: "Failed to save message" }, { status: 500 });
  }

  if (normalizedRole === "user") {
    try {
      await incrementBranchTurnCount({
        supabase,
        userId: user.id,
        branchId: runtimeScope.branchId,
      });
    } catch (turnErr) {
      console.warn("[runtime-graph] failed to increment branch turn count:", turnErr);
    }
  }
  if (normalizedRole === "user" && messageText.trim()) {
    try {
      const supabaseAdmin = createSupabaseAdminClient();
      const sweep = await applyPendingInboxActionSilencePolicy({
        supabase: supabaseAdmin,
        userId: user.id,
        agentId: runtimeScope.agentId,
        messageText,
      });
      if (sweep.cancelledCount > 0) {
        console.log("[inbox-actions] auto-cancelled pending actions after inactivity", {
          userId: user.id,
          agentId: runtimeScope.agentId,
          cancelledCount: sweep.cancelledCount,
          threshold: sweep.threshold,
        });
      }
    } catch (sweepError) {
      console.warn("[inbox-actions] silence policy sweep failed:", sweepError);
    }
  }

  return NextResponse.json({ saved: true });
}
