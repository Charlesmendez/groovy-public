import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { applyPendingInboxActionSilencePolicy, executeInboxCommand } from "@/lib/inbox/actions";
import { resolveRuntimeScope } from "@/lib/orchestrator/runtimeGraph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  sessionId?: string;
  agentId?: string;
  command?: string;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  const sessionId = asString(body?.sessionId);
  const requestedAgentId = asString(body?.agentId);
  const command = asString(body?.command);
  if (!command || (!sessionId && !requestedAgentId)) {
    return NextResponse.json({ ok: false, error: "command and sessionId/agentId are required" }, { status: 400 });
  }

  const supabaseServer = await createSupabaseServerClient();
  const { data: authData, error: authErr } = await supabaseServer.auth.getUser();
  if (authErr || !authData.user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const userId = authData.user.id;
  const supabase = createSupabaseAdminClient();
  if (sessionId) {
    const { data: session } = await supabase
      .from("orchestrator_sessions")
      .select("id,user_id")
      .eq("id", sessionId)
      .maybeSingle();
    const ownerId = asString((session as { user_id?: unknown } | null)?.user_id);
    if (!ownerId || ownerId !== userId) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
  }
  if (requestedAgentId) {
    const { data: ownedAgent } = await supabase
      .from("agents")
      .select("id,user_id")
      .eq("id", requestedAgentId)
      .maybeSingle();
    const ownerId = asString((ownedAgent as { user_id?: unknown } | null)?.user_id);
    if (!ownerId || ownerId !== userId) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
  }

  const scope = await resolveRuntimeScope({
    supabase,
    userId,
    sessionId,
    agentId: requestedAgentId,
  });
  const agentId = scope?.agentId || requestedAgentId || null;
  if (!agentId) {
    return NextResponse.json({ ok: false, error: "Failed to resolve runtime agent" }, { status: 500 });
  }

  try {
    await applyPendingInboxActionSilencePolicy({
      supabase,
      userId,
      agentId,
      messageText: command,
    });
  } catch (sweepErr) {
    console.warn("[inbox-actions] silence policy sweep failed in command route:", sweepErr);
  }

  const result = await executeInboxCommand({
    supabase,
    userId,
    agentId,
    text: command,
  });
  if (!result.handled) {
    return NextResponse.json({ ok: true, handled: false, reply: "" });
  }
  const connectorExecutes = Array.isArray(result.connectorExecutes) ? result.connectorExecutes : [];
  const followupText = typeof result.followupText === "string" ? result.followupText.trim() : "";
  if (connectorExecutes.length > 0) {
    return NextResponse.json({
      ok: true,
      handled: true,
      kind: "needs_connector",
      reply: result.reply,
      statusMessage: result.statusMessage || "Completing unsubscribe locally...",
      connectorExecutes,
      completeAfterConnector: true,
      ...(followupText ? { followupText } : {}),
    });
  }
  return NextResponse.json({
    ok: true,
    handled: true,
    kind: "final",
    reply: result.reply,
    ...(followupText ? { followupText } : {}),
  });
}

