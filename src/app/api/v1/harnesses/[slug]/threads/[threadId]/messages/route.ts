import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  authenticateHarnessApiRequest,
  corsHeaders,
  type HarnessApiKeyAuth,
  PublicApiAuthError,
  rateLimitHeaders,
} from "@/lib/publicApi/auth";
import { filterExternalHarnessOutput } from "@/lib/publicApi/outputFilter";
import { verifyHarnessThreadToken } from "@/lib/publicApi/threadToken";
import { runOrchestratorRound } from "@/lib/orchestrator/runOrchestratorRound";
import { acquireTurnLock } from "@/lib/teamChat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;
type Params = { params: Promise<{ slug: string; threadId: string }> };

type ThreadContext = {
  id: string;
  sessionId: string;
  participantId: string | null;
  participantName: string | null;
  participantExternalId: string | null;
};

async function getOrCreateFilesAgentSession(args: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  ownerUserId: string;
  orchestratorSessionId: string;
}): Promise<{ agentId: string; sessionId: string } | null> {
  const { admin, ownerUserId, orchestratorSessionId } = args;
  const { data: existing } = await admin
    .from("orchestrator_agent_sessions")
    .select("agent_id,agent_session_id")
    .eq("user_id", ownerUserId)
    .eq("orchestrator_session_id", orchestratorSessionId)
    .eq("agent_type", "files")
    .maybeSingle();
  if (existing?.agent_id && existing.agent_session_id) {
    return {
      agentId: String(existing.agent_id),
      sessionId: String(existing.agent_session_id),
    };
  }

  const { data: filesAgent } = await admin
    .from("agents")
    .select("id")
    .eq("user_id", ownerUserId)
    .eq("type", "files-agent")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!filesAgent?.id) return null;

  const { data: filesSession, error: sessionError } = await admin
    .from("chat_sessions")
    .insert({
      user_id: ownerUserId,
      agent_id: filesAgent.id,
      title: "Files: Public harness",
    })
    .select("id")
    .single();
  if (sessionError || !filesSession?.id) {
    throw new Error(sessionError?.message || "Could not create Files agent session");
  }

  const { error: linkError } = await admin
    .from("orchestrator_agent_sessions")
    .insert({
      user_id: ownerUserId,
      orchestrator_session_id: orchestratorSessionId,
      agent_type: "files",
      agent_id: filesAgent.id,
      agent_session_id: filesSession.id,
    });
  if (linkError) {
    // A concurrent first message may have created the link. Remove the unused
    // session and reuse the winner instead of failing the public turn.
    await admin.from("chat_sessions").delete().eq("id", filesSession.id);
    const { data: raced } = await admin
      .from("orchestrator_agent_sessions")
      .select("agent_id,agent_session_id")
      .eq("user_id", ownerUserId)
      .eq("orchestrator_session_id", orchestratorSessionId)
      .eq("agent_type", "files")
      .maybeSingle();
    if (raced?.agent_id && raced.agent_session_id) {
      return {
        agentId: String(raced.agent_id),
        sessionId: String(raced.agent_session_id),
      };
    }
    throw new Error(linkError.message);
  }
  return {
    agentId: String(filesAgent.id),
    sessionId: String(filesSession.id),
  };
}

function modelHistory(rows: Array<{ role?: unknown; content?: unknown }>): ModelMessage[] {
  return rows
    .filter(
      (row) =>
        (row.role === "user" || row.role === "assistant") &&
        typeof row.content === "string",
    )
    .map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content as string,
    }));
}

function publicMessageContent(content: string): string {
  return content.replace(/^\[From external user(?::[^\]]+)?\]\n/i, "");
}

async function loadThread(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  auth: HarnessApiKeyAuth,
  threadId: string,
): Promise<ThreadContext | null> {
  const { data: thread } = await admin
    .from("orchestrator_external_threads")
    .select("id,orchestrator_session_id,external_participant_id")
    .eq("id", threadId)
    .eq("provider", "api")
    .eq("api_key_id", auth.key.id)
    .eq("profile_id", auth.profile.id)
    .maybeSingle();
  if (!thread) return null;
  const { data: participant } = thread.external_participant_id
    ? await admin
        .from("external_participants")
        .select("id,display_name,external_id")
        .eq("id", thread.external_participant_id)
        .eq("profile_id", auth.profile.id)
        .maybeSingle()
    : { data: null };
  return {
    id: String(thread.id),
    sessionId: String(thread.orchestrator_session_id),
    participantId: participant?.id ? String(participant.id) : null,
    participantName: participant?.display_name
      ? String(participant.display_name)
      : null,
    participantExternalId: participant?.external_id
      ? String(participant.external_id)
      : null,
  };
}

function requireWidgetThreadToken(
  req: Request,
  auth: HarnessApiKeyAuth,
  threadId: string,
): void {
  if (auth.key.kind !== "publishable") return;
  const token = req.headers.get("x-harness-thread-token") || "";
  if (
    !verifyHarnessThreadToken({
      token,
      threadId,
      keyId: auth.key.id,
      requestOrigin: auth.requestOrigin,
    })
  ) {
    throw new PublicApiAuthError("Invalid thread token", 401, "invalid_thread_token");
  }
}

async function executeMessage(args: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  auth: HarnessApiKeyAuth;
  thread: ThreadContext;
  content: string;
}): Promise<{ id: string; role: "assistant"; content: string; createdAt: string; traceId: string }> {
  const traceId = randomUUID();
  const speaker = (
    args.thread.participantName ||
    args.thread.participantExternalId ||
    "anonymous"
  )
    .replace(/[\r\n[\]]+/g, " ")
    .trim()
    .slice(0, 300) || "anonymous";
  const attributed = `[From external user: ${speaker}]\n${args.content}`;
  const lock = await acquireTurnLock(args.admin, args.thread.sessionId);
  if (!lock) {
    throw new PublicApiAuthError(
      "This thread is already processing another message",
      409,
      "thread_busy",
    );
  }
  let userMessageId: string | null = null;
  let completed = false;
  try {
    const { data: prior, error: historyError } = await args.admin
      .from("orchestrator_messages")
      .select("role,content")
      .eq("session_id", args.thread.sessionId)
      .contains("metadata", {
        provider: "api",
        external_thread_id: args.thread.id,
      })
      .order("created_at", { ascending: false })
      .limit(100);
    if (historyError) throw new Error(historyError.message);

    const { data: userMessage, error: userMessageError } = await args.admin
      .from("orchestrator_messages")
      .insert({
        session_id: args.thread.sessionId,
        user_id: args.auth.key.ownerUserId,
        role: "user",
        content: attributed,
        trace_id: traceId,
        metadata: {
          provider: "api",
          external_thread_id: args.thread.id,
          external_participant_id: args.thread.participantId,
        },
      })
      .select("id")
      .single();
    if (userMessageError || !userMessage) {
      throw new Error(userMessageError?.message || "Could not save message");
    }
    userMessageId = String(userMessage.id);

    const { data: owner } = await args.admin.auth.admin.getUserById(
      args.auth.key.ownerUserId,
    );
    const externalProfile = {
      ...args.auth.profile,
      surface: "external" as const,
      authorizationStance: "restricted" as const,
      memoryScope: "profile" as const,
    };
    const filesAgent = await getOrCreateFilesAgentSession({
      admin: args.admin,
      ownerUserId: args.auth.key.ownerUserId,
      orchestratorSessionId: args.thread.sessionId,
    });
    const result = await runOrchestratorRound({
      supabase: args.admin,
      userId: args.auth.key.ownerUserId,
      userEmail: owner.user?.email || null,
      history: modelHistory([...(prior || [])].reverse()),
      message: attributed,
      orchestratorSessionId: args.thread.sessionId,
      profile: externalProfile,
      sourceProvider: "api",
      // Publishable clients can choose externalId values, so profile- or
      // participant-scoped memory would permit cross-customer replay. A public
      // thread gets its own durable memory namespace instead.
      memoryScopeId: args.thread.id,
      deviceId: null,
      filesAgent,
      traceId,
      memoryEnabled: true,
    });
    if (result.kind !== "final") {
      throw new Error("Public harness requested an unavailable connector capability");
    }
    const content = filterExternalHarnessOutput(result.text.trim() || "Done.");
    const createdAt = new Date().toISOString();
    const { data: saved, error } = await args.admin
      .from("orchestrator_messages")
      .insert({
        session_id: args.thread.sessionId,
        user_id: args.auth.key.ownerUserId,
        role: "assistant",
        content,
        trace_id: traceId,
        metadata: {
          provider: "api",
          external_thread_id: args.thread.id,
          external_participant_id: args.thread.participantId,
        },
      })
      .select("id,created_at")
      .single();
    if (error || !saved) throw new Error(error?.message || "Could not save response");
    completed = true;
    return {
      id: String(saved.id),
      role: "assistant",
      content,
      createdAt: String(saved.created_at || createdAt),
      traceId,
    };
  } catch (error) {
    // A failed public turn should be retryable without leaving a hidden,
    // duplicate user message in the harness history.
    if (userMessageId && !completed) {
      await args.admin
        .from("orchestrator_messages")
        .delete()
        .eq("id", userMessageId)
        .eq("session_id", args.thread.sessionId)
        .eq("role", "user");
    }
    throw error;
  } finally {
    await lock.release();
  }
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(req),
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    },
  });
}

export async function GET(req: Request, { params }: Params) {
  const { slug, threadId } = await params;
  const admin = createSupabaseAdminClient();
  try {
    const auth = await authenticateHarnessApiRequest({
      req,
      admin,
      slug,
      requiredScope: "threads:read",
    });
    requireWidgetThreadToken(req, auth, threadId);
    const thread = await loadThread(admin, auth, threadId);
    if (!thread) {
      return NextResponse.json(
        { error: { code: "thread_not_found", message: "Thread not found" } },
        { status: 404, headers: { ...rateLimitHeaders(auth), ...corsHeaders(req, auth) } },
      );
    }
    const { data, error } = await admin
      .from("orchestrator_messages")
      .select("id,role,content,trace_id,created_at")
      .eq("session_id", thread.sessionId)
      .contains("metadata", {
        provider: "api",
        external_thread_id: thread.id,
      })
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return NextResponse.json(
      {
        data: [...(data || [])].reverse().map((message) => ({
          id: message.id,
          role: message.role,
          content:
            message.role === "user"
              ? publicMessageContent(message.content)
              : filterExternalHarnessOutput(message.content),
          traceId: message.trace_id,
          createdAt: message.created_at,
        })),
      },
      { headers: { ...rateLimitHeaders(auth), ...corsHeaders(req, auth) } },
    );
  } catch (error) {
    if (error instanceof PublicApiAuthError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: { ...error.headers, ...corsHeaders(req) } },
      );
    }
    return NextResponse.json(
      { error: { code: "history_failed", message: "Could not load history" } },
      { status: 500, headers: corsHeaders(req) },
    );
  }
}

export async function POST(req: Request, { params }: Params) {
  const { slug, threadId } = await params;
  const admin = createSupabaseAdminClient();
  try {
    const auth = await authenticateHarnessApiRequest({
      req,
      admin,
      slug,
      requiredScope: "threads:write",
    });
    requireWidgetThreadToken(req, auth, threadId);
    const thread = await loadThread(admin, auth, threadId);
    if (!thread) {
      return NextResponse.json(
        { error: { code: "thread_not_found", message: "Thread not found" } },
        { status: 404, headers: { ...rateLimitHeaders(auth), ...corsHeaders(req, auth) } },
      );
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content || content.length > 20000) {
      return NextResponse.json(
        { error: { code: "invalid_content", message: "content must be 1-20000 characters" } },
        { status: 400, headers: { ...rateLimitHeaders(auth), ...corsHeaders(req, auth) } },
      );
    }

    if ((req.headers.get("accept") || "").includes("text/event-stream")) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(`event: status\ndata: ${JSON.stringify({ status: "working" })}\n\n`),
          );
          void executeMessage({ admin, auth, thread, content })
            .then((message) => {
              controller.enqueue(
                encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
              );
              controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
              controller.close();
            })
            .catch((error) => {
              const payload =
                error instanceof PublicApiAuthError
                  ? { code: error.code, message: error.message }
                  : { code: "message_failed", message: "Could not complete message" };
              controller.enqueue(
                encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`),
              );
              controller.close();
            });
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          ...rateLimitHeaders(auth),
          ...corsHeaders(req, auth),
        },
      });
    }

    const message = await executeMessage({ admin, auth, thread, content });
    return NextResponse.json(
      { data: message },
      { status: 201, headers: { ...rateLimitHeaders(auth), ...corsHeaders(req, auth) } },
    );
  } catch (error) {
    if (error instanceof PublicApiAuthError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: { ...error.headers, ...corsHeaders(req) } },
      );
    }
    console.error("[public-harness] message_failed", {
      slug,
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        error: {
          code: "message_failed",
          message: "Could not complete message",
        },
      },
      { status: 500, headers: corsHeaders(req) },
    );
  }
}
