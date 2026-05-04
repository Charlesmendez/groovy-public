import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveRuntimeScope } from "@/lib/orchestrator/runtimeGraph";

type RouteParams = { params: Promise<{ id: string }> };

type SendHandshakeBody = {
  fromSessionId?: string;
  partnerSessionId?: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

/**
 * POST /api/handshake/[id]/send
 * Sends a handshake message and mirrors it into the partner orchestrator session.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const handshakeId = typeof id === "string" ? id.trim() : "";
  if (!handshakeId) {
    return NextResponse.json({ error: "Handshake ID is required" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as SendHandshakeBody | null;
  const fromSessionId =
    typeof body?.fromSessionId === "string" ? body.fromSessionId.trim() : "";
  const partnerSessionId =
    typeof body?.partnerSessionId === "string" ? body.partnerSessionId.trim() : "";
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const metadata =
    body?.metadata && typeof body.metadata === "object" ? body.metadata : undefined;

  if (!fromSessionId || !content) {
    return NextResponse.json(
      { error: "fromSessionId and content are required" },
      { status: 400 }
    );
  }

  const { data: handshake, error: handshakeError } = await supabase
    .from("handshake_sessions")
    .select("id,pane_a_session_id,pane_b_session_id,status")
    .eq("id", handshakeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (handshakeError) {
    return NextResponse.json({ error: "Failed to load handshake" }, { status: 500 });
  }
  if (!handshake?.id) {
    return NextResponse.json({ error: "Handshake not found" }, { status: 404 });
  }
  if (handshake.status !== "active") {
    return NextResponse.json({ error: "Handshake is not active" }, { status: 409 });
  }

  const paneASessionId =
    typeof handshake.pane_a_session_id === "string" ? handshake.pane_a_session_id : "";
  const paneBSessionId =
    typeof handshake.pane_b_session_id === "string" ? handshake.pane_b_session_id : "";
  if (!paneASessionId || !paneBSessionId) {
    return NextResponse.json({ error: "Handshake session is invalid" }, { status: 500 });
  }

  let resolvedFromSessionId = fromSessionId;
  let toSessionId = "";

  // Prefer explicit partnerSessionId when provided by the client: this avoids
  // stale "current session" races flipping direction in multi-pane mode.
  if (partnerSessionId === paneASessionId) {
    toSessionId = paneASessionId;
    resolvedFromSessionId = paneBSessionId;
  } else if (partnerSessionId === paneBSessionId) {
    toSessionId = paneBSessionId;
    resolvedFromSessionId = paneASessionId;
  } else if (resolvedFromSessionId === paneASessionId) {
    toSessionId = paneBSessionId;
  } else if (resolvedFromSessionId === paneBSessionId) {
    toSessionId = paneASessionId;
  }
  if (!toSessionId) {
    return NextResponse.json(
      { error: "fromSessionId is not part of this handshake" },
      { status: 400 }
    );
  }

  const scope = await resolveRuntimeScope({
    supabase,
    userId: user.id,
    sessionId: toSessionId,
  });
  if (!scope) {
    return NextResponse.json({ error: "Failed to resolve runtime scope" }, { status: 500 });
  }
  const fromScope = await resolveRuntimeScope({
    supabase,
    userId: user.id,
    sessionId: resolvedFromSessionId,
  });

  const { data: titleRows } = await supabase
    .from("orchestrator_sessions")
    .select("id,title")
    .in("id", [resolvedFromSessionId, toSessionId]);
  const titleBySessionId = new Map<string, string>();
  for (const row of titleRows || []) {
    const sid = typeof row.id === "string" ? row.id.trim() : "";
    if (!sid) continue;
    const title =
      typeof row.title === "string" && row.title.trim() ? row.title.trim() : "Agent";
    titleBySessionId.set(sid, title);
  }
  const fromSessionTitle = titleBySessionId.get(resolvedFromSessionId) || "Agent";
  const toSessionTitle = titleBySessionId.get(toSessionId) || "Agent";

  const handshakeMetadataBase = {
    ...(metadata || {}),
    handshake: {
      handshakeId,
      fromSessionId: resolvedFromSessionId,
      toSessionId,
      fromSessionTitle,
      toSessionTitle,
    },
  };

  const { data: handshakeMessage, error: handshakeMessageError } = await supabase
    .from("handshake_messages")
    .insert({
      handshake_id: handshakeId,
      from_session_id: resolvedFromSessionId,
      to_session_id: toSessionId,
      content,
      metadata: handshakeMetadataBase,
    })
    .select("id,created_at")
    .single();
  if (handshakeMessageError) {
    return NextResponse.json({ error: "Failed to store handshake message" }, { status: 500 });
  }

  const traceId = `handshake:${handshakeId}:${handshakeMessage.id}`;
  const incomingMessageMetadata = {
    ...(metadata || {}),
    handshake: {
      handshakeId,
      fromSessionId: resolvedFromSessionId,
      toSessionId,
      fromSessionTitle,
      toSessionTitle,
      sourceTraceId: traceId,
      direction: "incoming",
    },
  };

  const { error: mirroredMessageError } = await supabase
    .from("orchestrator_messages")
    .insert({
      user_id: user.id,
      session_id: toSessionId,
      agent_id: scope.agentId,
      epoch_id: scope.epochId,
      branch_id: scope.branchId,
      role: "user",
      content,
      trace_id: traceId,
      metadata: incomingMessageMetadata,
    });
  if (mirroredMessageError) {
    return NextResponse.json(
      { error: "Failed to mirror handshake message into target session" },
      { status: 500 }
    );
  }

  // UI-only audit bubble in source session so sender sees "asked partner" in-chat.
  // This does not represent new user intent; it's strictly a visual handshake event.
  const outgoingUiContent = `Sent to ${toSessionTitle}`;
  const outgoingUiMetadata = {
    handshake: {
      handshakeId,
      fromSessionId: resolvedFromSessionId,
      toSessionId,
      fromSessionTitle,
      toSessionTitle,
      sourceTraceId: traceId,
      direction: "outgoing",
      uiOnly: true,
      originalContentLength: content.length,
    },
  };
  await supabase.from("orchestrator_messages").insert({
    user_id: user.id,
    session_id: resolvedFromSessionId,
    agent_id: fromScope?.agentId || null,
    epoch_id: fromScope?.epochId || null,
    branch_id: fromScope?.branchId || null,
    role: "assistant",
    content: outgoingUiContent,
    trace_id: `${traceId}:outgoing`,
    metadata: outgoingUiMetadata,
  });

  return NextResponse.json({
    ok: true,
    handshakeId,
    fromSessionId: resolvedFromSessionId,
    toSessionId,
    traceId,
    message: {
      id: handshakeMessage.id,
      createdAt: handshakeMessage.created_at,
      content,
    },
  });
}
