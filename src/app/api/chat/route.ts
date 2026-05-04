import { NextResponse } from "next/server";
import { generateText, streamText, type ModelMessage } from "ai";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveChatModel, supportsExtendedThinking, type ProviderId } from "@/lib/ai/modelResolver";
import { embedText, embeddingToVectorLiteral } from "@/lib/ai/embeddings";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";
import {
  completeAgentTrace,
  createAgentTrace,
} from "@/lib/traces/agentTraces";
import {
  formatPreferenceForPrompt,
  loadMemoryWithPlanner,
  loadPreferenceMemoryContext,
  maybeStoreConversation,
  formatMemoryForPrompt,
} from "@/lib/memory/groovyMemory";
import { getOrCreateWorkspaceIdForUser } from "@/lib/billing/workspace";
import { insertBillingUsageEventBestEffort } from "@/lib/billing/events";
import { preflightGroovyUsage, settleGroovyUsageDebitBestEffort } from "@/lib/billing/guard";
import { usageChargeTypeForKeyMode } from "@/lib/billing/pricing";

type IncomingMessage = {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: Array<{ mediaType: string; base64: string }>;
};

type PostBody = {
  agentId?: unknown;
  sessionId?: unknown;
  messages?: unknown;
};

function toStringOrEmpty(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const role = v.role;
  const content = v.content;
  const okRole =
    role === "system" || role === "user" || role === "assistant" || role === "tool";
  // images is optional
  const images = v.images;
  const okImages = images === undefined || (Array.isArray(images) && images.every(
    (img) => img && typeof img === "object" && typeof (img as Record<string, unknown>).base64 === "string"
  ));
  return okRole && typeof content === "string" && okImages;
}

function hasContent(value: unknown): value is { content: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.content === "string" && v.content.trim().length > 0;
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestTraceId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const billingWorkspaceId = await getOrCreateWorkspaceIdForUser({
    userId: user.id,
    email: user.email || null,
    supabaseAdmin: admin,
  }).catch(() => null);

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const agentId = toStringOrEmpty(body.agentId);
  const sessionId = toStringOrEmpty(body.sessionId);
  const messagesRaw = body.messages;
  const messages = Array.isArray(messagesRaw)
    ? messagesRaw.filter(isIncomingMessage)
    : [];

  if (!agentId || !sessionId || !Array.isArray(messagesRaw)) {
    return NextResponse.json(
      { error: "Missing agentId, sessionId, or messages" },
      { status: 400 }
    );
  }

  const lastUserMessage = [...messages].reverse().find((m) => m?.role === "user");
  const userText = lastUserMessage?.content?.toString?.() || "";
  const userImages = lastUserMessage?.images || [];

  // Load agent config (provider/model) for this user.
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select(
      "id, provider, model, name, type, flag_key, reasoning_effort, system_prompt"
    )
    .eq("id", agentId)
    .single();

  if (agentError || !agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (agent.type !== "ai-chat") {
    return NextResponse.json(
      { error: "Agent type does not support chat" },
      { status: 400 }
    );
  }

  const provider = (agent.provider || "openai") as ProviderId;
  const modelName = agent.model || "gpt-4o";
  const cookie = req.headers.get("cookie") || "";
  const resolved = await resolveKeys(user.id, supabase, cookie);
  const keyMode =
    ((resolved.keyModes as Record<string, "groovy" | "user">)[provider] as "groovy" | "user" | undefined) ||
    resolved.globalMode;
  const usageChargeType = usageChargeTypeForKeyMode(keyMode);

  let traceId: string | null = requestTraceId;

  console.log("[chat/route] agent:", {
    id: agent.id,
    provider,
    model: modelName,
    keyMode,
  });

  let decryptedApiKey: string | null = null;
  if (keyMode === "user") {
    decryptedApiKey = ((resolved.userKeys as Record<string, string | undefined>)[provider] as string | undefined) || null;
    if (!decryptedApiKey) {
      return NextResponse.json(
        {
          error: `Missing ${provider} API key. Add your provider key in Settings → API Keys.`,
        },
        { status: 400 }
      );
    }
  } else {
    // Groovy mode: verify server has the required env var
    const { getGroovyApiKey } = await import("@/lib/ai/modelResolver");
    const groovyKey = getGroovyApiKey(provider);
    if (!groovyKey) {
      return NextResponse.json(
        { error: `Server provider API key for ${provider} is not configured.` },
        { status: 500 }
      );
    }
    // decryptedApiKey stays null - resolveChatModel will use env var
  }

  if (billingWorkspaceId) {
    const preflight = await preflightGroovyUsage({
      workspaceId: billingWorkspaceId,
      userId: user.id,
      userEmail: user.email || null,
      traceId: requestTraceId,
      source: "chat_route",
    });
    if (!preflight.allowed) {
      return NextResponse.json(
        {
          error: preflight.message,
          code: preflight.reason,
          billing: {
            monthSpendUsd: preflight.monthSpendUsd,
            monthlyLimitUsd: preflight.monthlyLimitUsd,
            availableBalanceUsd: preflight.availableBalanceUsd,
          },
        },
        { status: 402 }
      );
    }
  }

  // Persist latest user message (best-effort).
  if (userText.trim() || userImages.length > 0) {
    // Check if this is the first message (to set session title)
    const { count } = await supabase
      .from("chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId);

    const messageMetadata: Record<string, unknown> = { agent_id: agentId };
    if (userImages.length > 0) {
      messageMetadata.images = userImages;
    }

    await supabase.from("chat_messages").insert({
      user_id: user.id,
      session_id: sessionId,
      role: "user",
      content: userText || "[image]",
      metadata: messageMetadata,
    });

    const trace = await createAgentTrace(supabase, {
      userId: user.id,
      agentId,
      sessionId,
      agentName: agent.name,
      agentType: agent.type,
      flagKey: (agent as unknown as { flag_key?: string | null }).flag_key || null,
      provider,
      model: modelName,
      prompt: userText || "[image]",
      metadata: {
        images: userImages.length > 0 ? userImages.map((i) => ({ mediaType: i.mediaType })) : undefined,
      },
    });
    traceId = trace.traceId;

    // If first message, update session title from user text
    const updateData: { updated_at: string; title?: string } = {
      updated_at: new Date().toISOString(),
    };
    if (count === 0) {
      // Truncate to ~50 chars for title
      const title = userText.length > 50 
        ? userText.slice(0, 47).trim() + "…" 
        : userText;
      updateData.title = title;
    }

    await supabase
      .from("chat_sessions")
      .update(updateData)
      .eq("id", sessionId);
  }

  // Retrieve relevant document chunks for grounding (RAG).
  let contextBlock = "";
  try {
    if (userText.trim()) {
      console.log("[chat/route] RAG: embedding user query...");
      const embedding =
        provider === "openai"
          ? await embedText(userText, { apiKey: keyMode === "user" ? decryptedApiKey || undefined : undefined })
          : // Don't silently fall back to server OPENAI_API_KEY when user is using a different provider key.
            await embedText(userText, { apiKey: null });
      console.log("[chat/route] RAG: embedding length:", embedding.length);
      if (embedding.length) {
        const vector = embeddingToVectorLiteral(embedding);
        const { data: matches, error: matchError } = await supabase.rpc("match_chat_doc_chunks", {
          p_session_id: sessionId,
          p_embedding: vector,
          p_match_count: 8,
        });
        const matchCount = Array.isArray(matches) ? matches.length : 0;
        console.log(
          "[chat/route] RAG: matches found:",
          matchCount,
          "error:",
          matchError?.message || "none"
        );

        if (matchCount === 0) {
          // Debug: distinguish "no chunks exist" vs "chunks exist but similarity search yields none"
          const { count, error: countErr } = await supabase
            .from("chat_doc_chunks")
            .select("id", { count: "exact", head: true })
            .eq("session_id", sessionId);
          console.log("[chat/route] RAG: chunk row count for session:", count ?? null, "error:", countErr?.message || "none");

          // Fallback: if chunks exist but vector search returned nothing, include excerpts from the latest uploaded attachment.
          // This keeps the UX working even if pgvector RPC behaves unexpectedly.
          if ((count || 0) > 0) {
            const { data: latestAttachment } = await supabase
              .from("chat_attachments")
              .select("id, file_name, created_at")
              .eq("session_id", sessionId)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            const latestId = (latestAttachment as { id?: string } | null)?.id;
            if (latestId) {
              const { data: fallbackChunks } = await supabase
                .from("chat_doc_chunks")
                .select("content, chunk_index")
                .eq("session_id", sessionId)
                .eq("attachment_id", latestId)
                .order("chunk_index", { ascending: true })
                .limit(8);

              if (Array.isArray(fallbackChunks) && fallbackChunks.length > 0) {
                const excerpts = fallbackChunks
                  .filter(hasContent)
                  .map((c, idx: number) => `(${idx + 1}) ${c.content}`)
                  .join("\n\n");
                const fname =
                  (latestAttachment as { file_name?: string } | null)?.file_name || "latest upload";
                contextBlock = `\n\nDocument context (latest upload: ${fname}):\n${excerpts}\n`;
                console.log("[chat/route] RAG: using fallback context from latest attachment");
              }
            }
          }
        }

        if (Array.isArray(matches) && matchCount > 0) {
          const excerpts = matches
            .filter(hasContent)
            .map((m, idx: number) => `(${idx + 1}) ${m.content}`)
            .join("\n\n");

          contextBlock = `\n\nDocument context (excerpts):\n${excerpts}\n`;
          console.log("[chat/route] RAG: context block length:", contextBlock.length);
        }
      }
    }
  } catch (ragErr) {
    // If retrieval fails, proceed without context but log the error.
    console.error("[chat/route] RAG retrieval error:", ragErr);
  }

  // Load memory context using AI-driven planner
  let memoryContext = "";
  let preferenceContext = "";
  let memoryConnectionId: string | null = null;
  const isNewSession = messages.length <= 2;

  try {
    // Build recent history for planner
    const recentHistory = messages.slice(-4).map((m) => ({
      role: String(m.role),
      content: m.content,
    }));

    const memoryResult = await loadMemoryWithPlanner(
      user.id,
      {
        userMessage: userText,
        recentHistory,
        isNewSession,
      },
      {
        userEmail: user.email || undefined,
        maxContextChars: 2000,
        llmApiKey: decryptedApiKey || undefined,
        supabase,
      }
    );

    memoryContext = memoryResult.context;
    memoryConnectionId = memoryResult.connectionId;

    console.log("[chat/route] Memory loaded:", {
      questions: memoryResult.questions,
      totalChars: memoryResult.totalChars,
      isNewSession,
    });

    if (memoryConnectionId) {
      const preferenceResult = await loadPreferenceMemoryContext(memoryConnectionId, {
        maxContextChars: 1600,
      });
      preferenceContext = preferenceResult.context;
      console.log("[chat/route] Preference memory loaded:", {
        question: preferenceResult.question,
        chars: preferenceResult.chars,
        hasContent: preferenceResult.context.length > 0,
      });
    }
  } catch (memErr) {
    console.error("[chat/route] Memory loading error:", memErr);
  }

  // Format memory for system prompt
  const memoryBlock = formatMemoryForPrompt(memoryContext);
  const preferenceBlock = formatPreferenceForPrompt(preferenceContext, { channel: "interactive" });

  // Build system prompt: use custom if provided, otherwise default
  const customSystemPrompt = typeof agent.system_prompt === "string" && agent.system_prompt.trim()
    ? agent.system_prompt.trim()
    : null;
  
  const defaultSystemPrompt = `You are an AI assistant embedded in a command-center UI.

- Be concise, actionable, and structured.
- If the user asks about uploaded documents, use the provided document context.
- If the answer is not in the document context, say so and ask a targeted follow-up.`;

  const ragInstructions = contextBlock
    ? `\n\nWhen the user asks about uploaded documents, use the following context to answer:${contextBlock}`
    : "";

  // Combine all context sources
  const system = customSystemPrompt
    ? `${customSystemPrompt}${memoryBlock}${preferenceBlock}${ragInstructions}`
    : `${defaultSystemPrompt}${memoryBlock}${preferenceBlock}${contextBlock}`;

  const modelOpts = keyMode === "user" ? { apiKey: decryptedApiKey || undefined } : undefined;
  console.log("[chat/route] calling resolveChatModel:", { provider, modelName, hasApiKey: !!modelOpts?.apiKey });
  const model = resolveChatModel(provider, modelName, modelOpts);

  const modelMessages: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      // Check if message has images
      if (m.images && m.images.length > 0) {
        // Build multipart content with images first, then text
        const contentParts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> = [];
        for (const img of m.images) {
          contentParts.push({
            type: "image",
            image: img.base64,
            mimeType: img.mediaType as `image/${string}`,
          });
        }
        if (m.content) {
          contentParts.push({ type: "text", text: m.content });
        }
        modelMessages.push({ role: "user", content: contentParts });
      } else {
        modelMessages.push({ role: "user", content: m.content });
      }
    } else if (m.role === "assistant") {
      modelMessages.push({ role: "assistant", content: m.content });
    }
  }

  // Special-case: this model can return image files, so use generateText instead of streamText.
  const isImageModel = provider === "google" && modelName === "gemini-3-pro-image-preview";
  if (isImageModel) {
    const result = await generateText({
      model,
      system,
      messages: modelMessages,
    });
    const billingTraceId = traceId || requestTraceId;
    const billingTurnId = billingTraceId;
    const usage = (result as unknown as { usage?: unknown }).usage;
    if (billingWorkspaceId) {
      insertBillingUsageEventBestEffort({
        workspaceId: billingWorkspaceId,
        userId: user.id,
        turnId: billingTurnId,
        traceId: billingTraceId,
        source: "chat_agent",
        spanId: "image",
        provider,
        model: modelName,
        usage,
        billable: true,
        chargeType: usageChargeType,
        meta: {
          agentId,
          isImageModel: true,
        },
      });
      await settleGroovyUsageDebitBestEffort({
        workspaceId: billingWorkspaceId,
        userId: user.id,
        traceId: billingTraceId,
        turnId: billingTurnId,
        source: "chat_agent",
        spanId: "image",
        model: modelName,
        usage,
        chargeType: usageChargeType,
        meta: {
          agentId,
          isImageModel: true,
        },
      }).catch(() => {});
    }

    const files = (result.files || []).slice(0, 6).map((f) => ({
      mediaType: f.mediaType,
      base64: f.base64,
    }));

    const text = result.text || "";
    await supabase.from("chat_messages").insert({
      user_id: user.id,
      session_id: sessionId,
      role: "assistant",
      content: text || "[generated image]",
      metadata: {
        agent_id: agentId,
        provider,
        model: modelName,
        files,
      },
    });

    if (traceId && (text || files.length > 0)) {
      const responseText = text || "[generated image]";
      await completeAgentTrace(supabase, { traceId, response: responseText });
      // AI-decided memory storage (async, don't block response)
      if (memoryConnectionId) {
        maybeStoreConversation(
          memoryConnectionId,
          userText || "[image]",
          responseText,
          memoryContext,
          { llmApiKey: decryptedApiKey || undefined }
        ).then((result) => {
          if (result.stored) {
            console.log("[chat/route] Memory stored:", result.label, result.memoryNote?.slice(0, 50));
          }
        }).catch(() => {});
      }
    }

    await supabase
      .from("chat_sessions")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", sessionId);

    return NextResponse.json({ text, files });
  }

  // Build provider options for reasoning effort (OpenAI & Anthropic)
  // Only send thinking param for models that support extended thinking
  const reasoningEffort = agent.reasoning_effort as string | null;
  const canUseThinking = supportsExtendedThinking(provider, modelName);

  const result = streamText({
    model,
    system,
    messages: modelMessages,
    providerOptions: reasoningEffort && reasoningEffort !== "none" && canUseThinking
      ? provider === "openai"
        ? { openai: { reasoningEffort: reasoningEffort as "low" | "medium" | "high" } }
        : provider === "anthropic"
          ? { anthropic: { thinking: { type: "adaptive" } } }
          : undefined
      : undefined,
    onFinish: async ({ text, usage }) => {
      if (!text?.trim()) return;
      const billingTraceId = traceId || requestTraceId;
      const billingTurnId = billingTraceId;
      if (billingWorkspaceId) {
        insertBillingUsageEventBestEffort({
          workspaceId: billingWorkspaceId,
          userId: user.id,
          turnId: billingTurnId,
          traceId: billingTraceId,
          source: "chat_agent",
          spanId: "stream",
          provider,
          model: modelName,
          usage,
          billable: true,
          chargeType: usageChargeType,
          meta: {
            agentId,
            isImageModel: false,
          },
        });
        await settleGroovyUsageDebitBestEffort({
          workspaceId: billingWorkspaceId,
          userId: user.id,
          traceId: billingTraceId,
          turnId: billingTurnId,
          source: "chat_agent",
          spanId: "stream",
          model: modelName,
          usage,
          chargeType: usageChargeType,
          meta: {
            agentId,
            isImageModel: false,
          },
        }).catch(() => {});
      }
      await supabase.from("chat_messages").insert({
        user_id: user.id,
        session_id: sessionId,
        role: "assistant",
        content: text,
        metadata: {
          agent_id: agentId,
          provider,
          model: modelName,
        },
      });

      if (traceId) {
        await completeAgentTrace(supabase, { traceId, response: text });
        // AI-decided memory storage (async, don't block response)
        if (memoryConnectionId) {
          maybeStoreConversation(
            memoryConnectionId,
            userText || "[image]",
            text,
            memoryContext,
            { llmApiKey: decryptedApiKey || undefined }
          ).then((result) => {
            if (result.stored) {
              console.log("[chat/route] Memory stored:", result.label, result.memoryNote?.slice(0, 50));
            }
          }).catch(() => {});
        }
      }

      await supabase
        .from("chat_sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", sessionId);
    },
  });

  return result.toTextStreamResponse();
}
