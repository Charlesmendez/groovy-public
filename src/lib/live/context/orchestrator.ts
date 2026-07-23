import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelMessage } from "ai";
import {
  type ConnectorExecute,
  runOrchestratorRound,
  type OrchestratorRoundResult,
} from "@/lib/orchestrator/runOrchestratorRound";
import {
  getOrCreateRuntimeSessionForAgent,
  resolveRuntimeScope,
} from "@/lib/orchestrator/runtimeGraph";
import { ensureOrchestratorRuntimeAgentId } from "@/lib/orchestrator/runtimeAgents";
import { detectConnectorPlatformFromUserAgent } from "@/lib/connector/platform";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";
import { decryptTelegramBotToken } from "@/lib/telegram/botToken";
import type { LiveTurnProgress } from "../turn";
import { getAppUrl } from "@/lib/config/appConfig";

const MAX_TOOL_RESULT_CHARS = 20_000;

export async function loadLiveOrchestratorContext(args: {
  supabase: SupabaseClient;
  userId: string;
  userEmail?: string | null;
  message: string;
  cookies?: string;
  userAgent?: string;
  progress?: LiveTurnProgress;
}): Promise<string> {
  const progress = args.progress ?? (() => undefined);
  const message = args.message.trim();
  if (!message) return "";

  const runtimeAgentId = await ensureOrchestratorRuntimeAgentId(args.supabase, args.userId);
  const runtimeSessionId = runtimeAgentId
    ? await getOrCreateRuntimeSessionForAgent({
        supabase: args.supabase,
        userId: args.userId,
        agentId: runtimeAgentId,
        title: "Live",
      })
    : null;
  const runtimeScope =
    runtimeAgentId && runtimeSessionId
      ? await resolveRuntimeScope({
          supabase: args.supabase,
          userId: args.userId,
          agentId: runtimeAgentId,
          sessionId: runtimeSessionId,
        }).catch(() => null)
      : null;
  const [deviceId, aiChatAgents, webPixelNames, filesAgent, telegramBotToken] = await Promise.all([
    resolveLatestDeviceId(args.supabase, args.userId),
    loadAiChatAgents(args.supabase, args.userId),
    loadWebPixelNames(args.supabase, args.userId),
    runtimeSessionId
      ? getOrCreateFilesAgentSession(args.supabase, args.userId, runtimeSessionId)
      : Promise.resolve(null),
    loadTelegramBotToken(args.supabase, args.userId),
  ]);

  await progress("asking the orchestrator what it can see");
  const baseHistory: ModelMessage[] = [{ role: "user", content: message }];
  const runRound = (opts?: {
    history?: ModelMessage[];
    toolResults?: Array<{ toolCallId: string; toolName: string; result: string }>;
    traceId?: string;
  }) =>
    runOrchestratorRound({
      supabase: args.supabase,
      userId: args.userId,
      userEmail: args.userEmail,
      appBaseUrl: getAppUrl(),
      history: opts?.history || baseHistory,
      message,
      memoryEnabled: true,
      cookies: args.cookies,
      traceId: opts?.traceId,
      toolResults: opts?.toolResults,
      orchestratorAgentId: runtimeScope?.agentId || runtimeAgentId || null,
      orchestratorSessionId: runtimeSessionId,
      branchCurrentTurnCount: runtimeScope?.branchTurnCount ?? null,
      branchActiveCount: runtimeScope?.activeBranchCount ?? null,
      deviceId,
      connectorPlatform: detectConnectorPlatformFromUserAgent(args.userAgent || ""),
      aiChatAgents,
      webPixelNames,
      filesAgent,
      telegramBotToken,
      maxSteps: 6,
      allowSynthesisAfterTool: true,
      onToolEvent: async (event) => {
        const verb =
          event.phase === "start" ? "using" : event.success === false ? "failed" : "finished";
        await progress(`${verb} ${event.toolName}`, event.success === false ? "warn" : "info");
      },
      onToolStream: async (event) => {
        const text = event.text.replace(/\s+/g, " ").trim();
        if (text) await progress(`${event.toolName}: ${text}`);
      },
    });

  let result = await runRound();
  let history = baseHistory;
  const MAX_CONNECTOR_ROUNDS = 12;

  for (let round = 0; result.kind === "needs_connector" && round < MAX_CONNECTOR_ROUNDS; round++) {
    if (!deviceId) break;

    await progress(connectorStatusMessage(result.connectorExecutes));
    const toolResults: Array<{ toolCallId: string; toolName: string; result: string }> = [];

    for (const execute of result.connectorExecutes) {
      let rpcResult: Record<string, unknown>;
      try {
        rpcResult = await callConnectorRpcViaRelay({
          userId: args.userId,
          deviceId,
          rpcType: execute.connectorType,
          payload: execute.connectorParams,
          timeoutMs: connectorTimeoutMs(execute),
        });
      } catch (error) {
        rpcResult = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      toolResults.push({
        toolCallId: execute.toolCallId,
        toolName: execute.toolName,
        result: JSON.stringify(rpcResult),
      });
    }

    history = [...history, toolResultsToHistoryMessage(toolResults)];
    await progress("continuing with the local tool results");
    result = await runRound({
      history,
      toolResults,
      traceId: result.traceId,
    });
  }

  return formatOrchestratorResult(result);
}

function connectorStatusMessage(connectorExecutes: ConnectorExecute[]): string {
  const preferred = connectorExecutes.find((execute) => asString(execute.message));
  if (preferred?.message) return preferred.message.trim();

  const first = connectorExecutes[0];
  if (!first) return "running local connector tools";
  if (first.connectorType === "terminal_step" || first.connectorType === "claude_run") {
    return "working in code";
  }
  if (first.connectorType === "terminal_exec") return "running a local terminal command";
  if (first.connectorType === "browser_task_run" || first.connectorType.startsWith("browser_")) {
    return "working in the browser";
  }
  if (first.connectorType.startsWith("file_")) return "checking local files";
  if (first.connectorType.startsWith("obsidian_")) return "checking obsidian";
  if (first.connectorType.startsWith("whatsapp_")) return "checking whatsapp";
  if (first.connectorType.startsWith("sqlite_")) return "querying a local database";
  if (first.connectorType.startsWith("linkdb_")) return "checking saved links";
  if (first.connectorType.startsWith("site_")) return "working on a local site";
  return `running ${first.connectorType}`;
}

function connectorTimeoutMs(execute: ConnectorExecute): number {
  const type = execute.connectorType;
  const params = execute.connectorParams || {};
  if (type === "browser_credential_request") return 120_000;
  if (type === "browser_task_run") return 9 * 60 * 1000;
  if (type === "terminal_exec") {
    const requested = Number(params.timeout_ms);
    if (Number.isFinite(requested) && requested > 0) {
      return Math.min(Math.max(30_000, requested + 10_000), 15 * 60 * 1000);
    }
    return 10 * 60 * 1000;
  }
  if (type === "terminal_step") {
    const requested = Number(params.max_wait_ms);
    if (Number.isFinite(requested) && requested > 0) {
      return Math.min(Math.max(30_000, requested + 10_000), 15 * 60 * 1000);
    }
    return 10 * 60 * 1000;
  }
  if (type === "claude_run") {
    const requested = Number(params.timeout_ms);
    if (Number.isFinite(requested) && requested > 0) {
      return Math.min(Math.max(30_000, requested + 10_000), 22 * 60 * 1000);
    }
    return 22 * 60 * 1000;
  }
  if (type === "site_dev_start") return 210_000;
  if (type === "site_deploy") return 240_000;
  if (type.startsWith("file_") || type.startsWith("obsidian_")) return 2 * 60 * 1000;
  if (type.startsWith("browser_")) return 3 * 60 * 1000;
  return 60_000;
}

function toolResultsToHistoryMessage(
  toolResults: Array<{ toolCallId: string; toolName: string; result: string }>
): ModelMessage {
  const resultsText = toolResults
    .map((result) => {
      const toolName = escapeToolAttr(result.toolName);
      const toolCallId = escapeToolAttr(result.toolCallId);
      let text = result.result;
      try {
        text = JSON.stringify(JSON.parse(result.result), null, 2);
      } catch {
        // Keep raw connector output.
      }
      if (text.length > MAX_TOOL_RESULT_CHARS) {
        text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
      }
      return `<tool_result name="${toolName}" tool_call_id="${toolCallId}">\n${text}\n</tool_result>`;
    })
    .join("\n\n");

  return {
    role: "user",
    content: `[SYSTEM: Tool execution results from the local connector]\n\n${resultsText}`,
  };
}

function escapeToolAttr(value: string): string {
  return String(value || "").replace(/["&<>]/g, (char) => {
    if (char === '"') return "&quot;";
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    return "&gt;";
  });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function resolveLatestDeviceId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const resolveOwnedDeviceId = async (candidateId: string | null): Promise<string | null> => {
    const id = asString(candidateId);
    if (!id) return null;
    try {
      const { data } = await supabase
        .from("devices")
        .select("id")
        .eq("user_id", userId)
        .eq("id", id)
        .limit(1)
        .maybeSingle();
      return asString((data as { id?: unknown } | null)?.id);
    } catch {
      return null;
    }
  };

  try {
    const { data: prefs } = await supabase
      .from("user_preferences")
      .select("onboarding_data")
      .eq("user_id", userId)
      .maybeSingle();
    const onboardingData =
      prefs?.onboarding_data && typeof prefs.onboarding_data === "object"
        ? (prefs.onboarding_data as Record<string, unknown>)
        : null;
    const preferredRaw = asString(onboardingData?.connectorDeviceId);
    const preferred = await resolveOwnedDeviceId(preferredRaw);
    if (preferred) return preferred;
  } catch {
    // ignore preference fallback failures
  }

  try {
    const { data: latest } = await supabase
      .from("devices")
      .select("id")
      .eq("user_id", userId)
      .order("last_seen", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return asString((latest as { id?: unknown } | null)?.id);
  } catch {
    return null;
  }
}

async function loadAiChatAgents(
  supabase: SupabaseClient,
  userId: string
): Promise<Array<{ id: string; name: string; systemPrompt?: string }>> {
  const { data } = await supabase
    .from("agents")
    .select("id, name, system_prompt")
    .eq("user_id", userId)
    .eq("type", "ai-chat")
    .order("created_at", { ascending: false });

  return (data || []).flatMap((row) => {
    const r = row as { id?: unknown; name?: unknown; system_prompt?: unknown };
    const id = asString(r.id);
    const name = asString(r.name);
    if (!id || !name) return [];
    const agent: { id: string; name: string; systemPrompt?: string } = {
      id,
      name,
    };
    const systemPrompt = asString(r.system_prompt);
    if (systemPrompt) agent.systemPrompt = systemPrompt;
    return [agent];
  });
}

async function loadWebPixelNames(supabase: SupabaseClient, userId: string): Promise<string[]> {
  try {
    const { data: pxRows } = await supabase
      .from("datagran_agent_configs")
      .select("provider, connection_id, agents!datagran_agent_configs_agent_id_fkey(name)")
      .eq("user_id", userId)
      .eq("provider", "web_pixel")
      .not("connection_id", "is", null)
      .limit(50);

    return (pxRows || [])
      .map((row) => {
        const agents = (row as { agents?: unknown }).agents;
        const agent = agents && typeof agents === "object" ? (agents as { name?: unknown }) : null;
        return asString(agent?.name);
      })
      .filter((name): name is string => !!name);
  } catch {
    return [];
  }
}

async function getOrCreateFilesAgentSession(
  supabase: SupabaseClient,
  userId: string,
  orchestratorSessionId: string
): Promise<{ agentId: string; sessionId: string } | null> {
  try {
    const { data: link } = await supabase
      .from("orchestrator_agent_sessions")
      .select("agent_session_id, chat_sessions!inner(agent_id)")
      .eq("user_id", userId)
      .eq("orchestrator_session_id", orchestratorSessionId)
      .eq("agent_type", "files")
      .maybeSingle();
    if (link) {
      const chatSession = (link as { chat_sessions?: unknown }).chat_sessions;
      const agent =
        chatSession && typeof chatSession === "object"
          ? (chatSession as { agent_id?: unknown })
          : null;
      const agentId = asString(agent?.agent_id);
      const sessionId = asString((link as { agent_session_id?: unknown }).agent_session_id);
      if (agentId && sessionId) return { agentId, sessionId };
    }
  } catch {
    // Missing link is fine; try to create one below.
  }

  try {
    const { data: filesAgent } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", userId)
      .eq("type", "files-agent")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const agentId = asString((filesAgent as { id?: unknown } | null)?.id);
    if (!agentId) return null;

    const { data: filesSession } = await supabase
      .from("chat_sessions")
      .insert({
        user_id: userId,
        agent_id: agentId,
        title: "Files: Live",
      })
      .select("id")
      .single();
    const sessionId = asString((filesSession as { id?: unknown } | null)?.id);
    if (!sessionId) return null;

    await supabase.from("orchestrator_agent_sessions").insert({
      user_id: userId,
      orchestrator_session_id: orchestratorSessionId,
      agent_type: "files",
      agent_id: agentId,
      agent_session_id: sessionId,
    });

    return { agentId, sessionId };
  } catch {
    return null;
  }
}

async function loadTelegramBotToken(
  supabase: SupabaseClient,
  userId: string
): Promise<string | undefined> {
  try {
    const { data } = await supabase
      .from("telegram_bot_configs")
      .select("bot_token_encrypted")
      .eq("user_id", userId)
      .maybeSingle();
    const encrypted = asString((data as { bot_token_encrypted?: unknown } | null)?.bot_token_encrypted);
    return encrypted ? decryptTelegramBotToken(encrypted) : undefined;
  } catch {
    return undefined;
  }
}

function formatOrchestratorResult(result: OrchestratorRoundResult): string {
  if (result.kind === "final") {
    return [result.text, result.toolOutputText ? `\nTool output:\n${result.toolOutputText}` : ""]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (result.kind === "needs_connector") {
    const tools = result.connectorExecutes
      .map((tool) => `${tool.toolName} (${tool.connectorType})`)
      .join(", ");
    return [
      result.partialText,
      `Connector execution still needed: ${tools || "unknown connector tool"}.`,
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (result.kind === "ui_open_code") {
    return [result.partialText, "The orchestrator requested a Code UI session."]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return [result.partialText, `Browser task requested: ${result.browserTask.task}`]
    .filter(Boolean)
    .join("\n")
    .trim();
}
