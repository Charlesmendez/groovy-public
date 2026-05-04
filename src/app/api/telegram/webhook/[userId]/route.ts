import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runOrchestratorRound } from "@/lib/orchestrator/runOrchestratorRound";
import {
  getOrCreateRuntimeSessionForAgent,
  incrementBranchTurnCount,
  resolveRuntimeScope,
} from "@/lib/orchestrator/runtimeGraph";
import { sendTelegramText, sendTelegramChatAction, createTelegramForumTopic } from "@/lib/telegram/client";
import {
  verifyTelegramWebhook,
  parseTelegramUpdate,
  buildTelegramThreadKey,
  shouldProcessMessage,
  extractMessageText,
} from "@/lib/telegram/webhook";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";
import { logError, logInfo, logWarn } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PROVIDER = "telegram";

async function getOrCreateSessionId(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  args: { userId: string; provider: string; threadKey: string; threadName?: string | null },
) {
  const { data: existing } = await supabase
    .from("orchestrator_external_threads")
    .select("orchestrator_session_id, orchestrator_agent_id")
    .eq("user_id", args.userId)
    .eq("provider", args.provider)
    .eq("thread_key", args.threadKey)
    .limit(1);

  const first = Array.isArray(existing) && existing.length > 0
    ? (existing[0] as Record<string, unknown>)
    : null;
  const sid = first ? (first.orchestrator_session_id as string | null) : null;
  if (sid) return sid;

  const { data: session, error: sessionErr } = await supabase
    .from("orchestrator_sessions")
    .insert({ user_id: args.userId, title: args.threadName || "Telegram" })
    .select("id")
    .single();
  if (sessionErr || !session?.id) throw new Error("Failed to create session");

  await supabase.from("orchestrator_external_threads").insert({
    user_id: args.userId,
    provider: args.provider,
    thread_key: args.threadKey,
    thread_name: args.threadName || null,
    orchestrator_session_id: session.id,
    updated_at: new Date().toISOString(),
  });
  return session.id as string;
}

export async function POST(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const startedAt = Date.now();
  const { userId } = await params;

  try {
    const supabase = createSupabaseAdminClient();

    const { data: botConfig } = await supabase
      .from("telegram_bot_configs")
      .select("bot_token_encrypted, bot_username, webhook_secret")
      .eq("user_id", userId)
      .single();

    if (!botConfig) {
      logWarn("telegram.webhook.no_config", { user_id: userId });
      return NextResponse.json({ error: "No bot config" }, { status: 404 });
    }

    if (!verifyTelegramWebhook(req, botConfig.webhook_secret)) {
      logWarn("telegram.webhook.invalid_secret", { user_id: userId });
      return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const parsed = parseTelegramUpdate(body);
    if (!parsed) {
      return NextResponse.json({ ok: true });
    }

    const botToken = botConfig.bot_token_encrypted;
    const botUsername = botConfig.bot_username;

    logInfo("telegram.webhook.received", {
      user_id: userId,
      chat_id: parsed.chatId,
      chat_type: parsed.chatType,
      message_thread_id: parsed.messageThreadId,
      from_user: parsed.fromUser?.username || parsed.fromUser?.first_name,
      text_len: parsed.text.length,
      command: parsed.command,
      is_forum: parsed.isForum,
    });

    if (parsed.fromUser) {
      await supabase.from("telegram_known_contacts").upsert(
        {
          user_id: userId,
          telegram_user_id: parsed.fromUser.id,
          telegram_username: parsed.fromUser.username || null,
          first_name: parsed.fromUser.first_name,
          last_name: parsed.fromUser.last_name || null,
          ...(parsed.chatType === "private" ? { dm_chat_id: parsed.chatId } : {}),
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "user_id,telegram_user_id" },
      );
    }

    if (parsed.command === "/start" && parsed.chatType === "private") {
      await sendTelegramText({
        botToken,
        chatId: parsed.chatId,
        text: "Welcome to Groovy! Send me a message and I'll help you out.",
      });
      logInfo("telegram.webhook.start", { user_id: userId, chat_id: parsed.chatId });
      return NextResponse.json({ ok: true });
    }

    if (parsed.command === "/register" && parsed.chatType !== "private") {
      await supabase.from("telegram_groups").upsert(
        {
          user_id: userId,
          telegram_chat_id: parsed.chatId,
          group_name: parsed.chatTitle || null,
          is_forum: parsed.isForum,
          registered_at: new Date().toISOString(),
        },
        { onConflict: "user_id,telegram_chat_id" },
      );
      const replyText = parsed.isForum
        ? `Groovy is now active in ${parsed.chatTitle || "this group"}. I'll create topic threads for each conversation. Mention @${botUsername} to talk to me.`
        : `Groovy is now active in ${parsed.chatTitle || "this group"}. Mention @${botUsername} to talk to me.`;
      await sendTelegramText({
        botToken,
        chatId: parsed.chatId,
        text: replyText,
        messageThreadId: parsed.messageThreadId ?? undefined,
      });
      logInfo("telegram.webhook.register", {
        user_id: userId,
        chat_id: parsed.chatId,
        group_name: parsed.chatTitle,
        is_forum: parsed.isForum,
      });
      return NextResponse.json({ ok: true });
    }

    if (parsed.command === "/new") {
      const threadKey = buildTelegramThreadKey(parsed.chatId, parsed.messageThreadId);
      await Promise.all([
        supabase
          .from("orchestrator_external_threads")
          .delete()
          .eq("user_id", userId)
          .eq("provider", PROVIDER)
          .eq("thread_key", threadKey),
        supabase
          .from("claude_code_external_threads")
          .delete()
          .eq("user_id", userId)
          .eq("provider", PROVIDER)
          .eq("thread_key", threadKey),
      ]);
      await sendTelegramText({
        botToken,
        chatId: parsed.chatId,
        text: "New Groovy session started.",
        messageThreadId: parsed.messageThreadId ?? undefined,
      });
      return NextResponse.json({ ok: true });
    }

    if (parsed.command === "/code") {
      const codePrompt = (parsed.commandPayload || "").trim();

      const sendReply = (text: string) =>
        sendTelegramText({
          botToken,
          chatId: parsed.chatId,
          text,
          messageThreadId: parsed.messageThreadId ?? undefined,
        });

      if (!codePrompt) {
        await sendReply("Usage: /code <prompt>\nExample: /code fix the failing tests in src/utils");
        return NextResponse.json({ ok: true });
      }

      try {
        const [{ data: devices }, resolved] = await Promise.all([
          supabase
            .from("devices")
            .select("id")
            .eq("user_id", userId)
            .order("last_seen", { ascending: false, nullsFirst: false })
            .limit(1),
          resolveKeys(userId, supabase, ""),
        ]);
        const deviceId = devices?.[0]?.id;
        if (!deviceId) {
          await sendReply("No Groovy Connector online. Start your connector first, then try again.");
          return NextResponse.json({ ok: true });
        }

        const useCliToken = !!resolved.claudeCliToken;
        const anthropicMode = resolved.keyModes.anthropic || resolved.globalMode;
        const apiKey = useCliToken
          ? null
          : anthropicMode === "user"
            ? resolved.userKeys.anthropic || null
            : process.env.ANTHROPIC_API_KEY || null;

        if (!apiKey && !resolved.claudeCliToken) {
          await sendReply("No API key or CLI token configured. Add your Anthropic key in Settings.");
          return NextResponse.json({ ok: true });
        }

        const threadKey = buildTelegramThreadKey(parsed.chatId, parsed.messageThreadId);

        let codeAgentId: string | null = null;
        const { data: threadMap } = await supabase
          .from("claude_code_external_threads")
          .select("claude_code_agent_id")
          .eq("user_id", userId)
          .eq("provider", PROVIDER)
          .eq("thread_key", threadKey)
          .limit(1);
        const existingAgent = Array.isArray(threadMap) && threadMap.length > 0 ? (threadMap[0] as Record<string, unknown>) : null;
        codeAgentId = existingAgent ? (existingAgent.claude_code_agent_id as string | null) : null;

        if (!codeAgentId) {
          const { data: agentRow, error: agentErr } = await supabase
            .from("agents")
            .insert({
              user_id: userId,
              type: "claude-code",
              name: `Telegram Code (${new Date().toLocaleString()})`,
              flag_key: null,
              provider: null,
              model: null,
            })
            .select("id")
            .single();
          if (agentErr || !agentRow?.id) throw new Error("Failed to create code agent");
          codeAgentId = agentRow.id as string;

          await supabase.from("claude_code_external_threads").upsert(
            {
              user_id: userId,
              provider: PROVIDER,
              thread_key: threadKey,
              thread_name: null,
              claude_code_agent_id: codeAgentId,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id,provider,thread_key" },
          );
        }

        let cliSessionId: string | null = null;
        const { data: cliThread } = await supabase
          .from("claude_code_cli_threads")
          .select("claude_session_id")
          .eq("user_id", userId)
          .eq("claude_code_agent_id", codeAgentId)
          .maybeSingle();
        const rawSid = (cliThread as Record<string, unknown> | null)?.claude_session_id;
        cliSessionId = typeof rawSid === "string" && rawSid.trim() ? rawSid.trim() : null;

        await sendTelegramChatAction({
          botToken,
          chatId: parsed.chatId,
          action: "typing",
          messageThreadId: parsed.messageThreadId ?? undefined,
        }).catch(() => {});

        logInfo("telegram.webhook.code_run.start", {
          user_id: userId,
          chat_id: parsed.chatId,
          prompt_len: codePrompt.length,
          device_id: deviceId,
          agent_id: codeAgentId,
          has_session: !!cliSessionId,
        });

        const rpcResult = await callConnectorRpcViaRelay({
          userId,
          deviceId,
          rpcType: "claude_run",
          payload: {
            prompt: codePrompt,
            cwd: "~",
            ...(useCliToken
              ? { cli_token: resolved.claudeCliToken }
              : { api_key: apiKey }),
            allowed_tools: "Read,Edit,Bash,Write",
            timeout_ms: 4 * 60 * 1000,
            ...(cliSessionId ? { session_id: cliSessionId } : {}),
          },
          timeoutMs: 270_000,
        });

        const rawReturnedSid = rpcResult.session_id;
        const returnedSessionId =
          typeof rawReturnedSid === "string" && rawReturnedSid.trim()
            ? rawReturnedSid.trim()
            : null;
        if (returnedSessionId && codeAgentId && returnedSessionId !== cliSessionId) {
          await supabase
            .from("claude_code_cli_threads")
            .upsert(
              {
                user_id: userId,
                claude_code_agent_id: codeAgentId,
                claude_session_id: returnedSessionId,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "user_id,claude_code_agent_id" },
            );
        }

        const resultText =
          typeof rpcResult.result === "string"
            ? rpcResult.result
            : typeof (rpcResult.result as Record<string, unknown>)?.result === "string"
              ? String((rpcResult.result as Record<string, unknown>).result)
              : rpcResult.ok
                ? "(completed with no output)"
                : String(rpcResult.error || "Code run failed");

        const MAX_TELEGRAM_CHARS = 4096;
        const safeReply =
          resultText.length > MAX_TELEGRAM_CHARS
            ? `${resultText.slice(0, MAX_TELEGRAM_CHARS - 20)}\n...(truncated)`
            : resultText;

        await sendReply(safeReply || "(no output)");

        logInfo("telegram.webhook.code_run.done", {
          user_id: userId,
          chat_id: parsed.chatId,
          ok: !!rpcResult.ok,
          result_len: resultText.length,
          duration_ms: Date.now() - startedAt,
          session_id: returnedSessionId?.slice(0, 8) || null,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Code run failed";
        logError("telegram.webhook.code_run.error", {
          user_id: userId,
          chat_id: parsed.chatId,
          error: errMsg,
          duration_ms: Date.now() - startedAt,
        });
        await sendReply(`Code run failed: ${errMsg}`).catch((replyErr) => {
          logWarn("telegram.webhook.code_run.error_reply_failed", {
            user_id: userId,
            chat_id: parsed.chatId,
            error: replyErr instanceof Error ? replyErr.message : "unknown",
          });
        });
      }
      return NextResponse.json({ ok: true });
    }

    if (!shouldProcessMessage(parsed, botUsername)) {
      return NextResponse.json({ ok: true });
    }

    const userText = extractMessageText(parsed, botUsername);
    if (!userText) {
      return NextResponse.json({ ok: true });
    }

    await sendTelegramChatAction({
      botToken,
      chatId: parsed.chatId,
      action: "typing",
      messageThreadId: parsed.messageThreadId ?? undefined,
    }).catch(() => {});

    const threadKey = buildTelegramThreadKey(parsed.chatId, parsed.messageThreadId);
    const threadName = parsed.chatTitle
      ? parsed.messageThreadId
        ? `${parsed.chatTitle} (topic)`
        : parsed.chatTitle
      : parsed.chatType === "private"
        ? `Telegram DM`
        : "Telegram";

    const sessionId = await getOrCreateSessionId(supabase, {
      userId,
      provider: PROVIDER,
      threadKey,
      threadName,
    });

    const runtimeScope = await resolveRuntimeScope({
      supabase,
      userId,
      sessionId,
      agentId: null,
    });

    if (runtimeScope?.agentId) {
      await supabase.from("orchestrator_external_threads").upsert(
        {
          user_id: userId,
          provider: PROVIDER,
          thread_key: threadKey,
          thread_name: threadName,
          orchestrator_session_id: sessionId,
          orchestrator_agent_id: runtimeScope.agentId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider,thread_key" },
      );
    }

    let historyQuery = supabase
      .from("orchestrator_messages")
      .select("role, content")
      .eq("session_id", sessionId);
    if (runtimeScope?.epochId) historyQuery = historyQuery.eq("epoch_id", runtimeScope.epochId);
    const { data: historyRows } = await historyQuery
      .order("created_at", { ascending: true })
      .limit(50);
    const history = Array.isArray(historyRows)
      ? historyRows.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
      : [];

    await supabase.from("orchestrator_messages").insert({
      session_id: sessionId,
      user_id: userId,
      agent_id: runtimeScope?.agentId || null,
      epoch_id: runtimeScope?.epochId || null,
      branch_id: runtimeScope?.branchId || null,
      role: "user",
      content: userText,
      metadata: { provider: PROVIDER, threadKey, telegramChatId: parsed.chatId },
    });

    if (runtimeScope?.branchId) {
      await incrementBranchTurnCount({
        supabase,
        userId,
        branchId: runtimeScope.branchId,
      }).catch(() => undefined);
    }

    logInfo("telegram.webhook.orchestrator_round.start", {
      user_id: userId,
      session_id: sessionId,
      chat_id: parsed.chatId,
      thread_key: threadKey,
    });

    const round = await runOrchestratorRound({
      supabase,
      userId,
      appBaseUrl: new URL(req.url).origin,
      history: [...history, { role: "user", content: userText }],
      message: userText,
      orchestratorAgentId: runtimeScope?.agentId || null,
      orchestratorSessionId: sessionId,
      branchCurrentTurnCount: runtimeScope?.branchTurnCount ?? null,
      branchActiveCount: runtimeScope?.activeBranchCount ?? null,
      telegramBotToken: botToken,
    });

    const runtimeScopeAfterRound = await resolveRuntimeScope({
      supabase,
      userId,
      sessionId,
      agentId: runtimeScope?.agentId || null,
    }).catch(() => runtimeScope);

    logInfo("telegram.webhook.orchestrator_round.done", {
      user_id: userId,
      session_id: sessionId,
      kind: round.kind,
      duration_ms: Date.now() - startedAt,
    });

    if (round.kind === "final") {
      const replyText = typeof round.text === "string" ? round.text.trim() : "";

      await supabase.from("orchestrator_messages").insert({
        session_id: sessionId,
        user_id: userId,
        agent_id: runtimeScopeAfterRound?.agentId || runtimeScope?.agentId || null,
        epoch_id: runtimeScopeAfterRound?.epochId || runtimeScope?.epochId || null,
        branch_id: runtimeScopeAfterRound?.branchId || runtimeScope?.branchId || null,
        role: "assistant",
        content: replyText || "(no response)",
        metadata: { provider: PROVIDER, threadKey, telegramChatId: parsed.chatId },
      });

      if (replyText) {
        const MAX_TELEGRAM_CHARS = 4096;
        const safeReply =
          replyText.length > MAX_TELEGRAM_CHARS
            ? `${replyText.slice(0, MAX_TELEGRAM_CHARS - 20)}\n...(truncated)`
            : replyText;

        await sendTelegramText({
          botToken,
          chatId: parsed.chatId,
          text: safeReply,
          messageThreadId: parsed.messageThreadId ?? undefined,
        });
      }
    }

    if (round.kind === "needs_connector") {
      await sendTelegramText({
        botToken,
        chatId: parsed.chatId,
        text: "Working on it...",
        messageThreadId: parsed.messageThreadId ?? undefined,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook error";
    logError("telegram.webhook.error", {
      user_id: userId,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
