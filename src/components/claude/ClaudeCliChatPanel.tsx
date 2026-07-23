"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Send,
  Loader2,
  AlertTriangle,
  FolderOpen,
  Trash2,
  ArrowLeft,
  ListChecks,
  Terminal,
  FileText,
  Pencil,
  Search,
  Brain,
  RefreshCw,
  Square,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useRelay, type RelayMessage } from "@/hooks/useRelay";
import { DiffCardList, extractDiffs, type ParsedDiff } from "@/components/code/DiffCard";
import { FormattedMessageContent } from "@/components/common/FormattedMessageContent";
import { ActiveCapabilitiesPanel } from "@/components/skills/ActiveCapabilitiesPanel";
import {
  buildRuntimeClaudeSlashCommands,
  CLAUDE_SLASH_COMMANDS,
  CODEX_SLASH_COMMANDS,
  commandAcceptsArguments,
  dedupeClaudeSlashCommands,
  filterClaudeSlashCommands,
  type ClaudeSlashCommand,
} from "@/lib/claude/slashCommands";
import {
  inferCodeAgentResultModel,
  recordCodeAgentUsageBestEffort,
  type CodeAgentBillingContext,
} from "@/lib/claude/codeAgentUsage";

// Helper to extract filename from a diff string
function extractFilenameFromDiff(diff: string): string {
  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const match = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (match && match[1] !== "/dev/null") return match[1];
    } else if (line.startsWith("--- ")) {
      const match = line.match(/^--- (?:a\/)?(.+)$/);
      if (match && match[1] !== "/dev/null") return match[1];
    }
  }
  return "file";
}

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  diffs?: ParsedDiff[];
  model?: string;
  costUsd?: number;
  durationMs?: number;
  createdAt: Date;
};

function parseRawClaudeDiffs(rawDiffs?: string[]): ParsedDiff[] {
  return (rawDiffs || []).map((diff) => ({
    filename: extractFilenameFromDiff(diff),
    content: diff,
    additions: (diff.match(/^\+[^+]/gm) || []).length,
    deletions: (diff.match(/^-[^-]/gm) || []).length,
  }));
}

function createAssistantMessage({
  content,
  rawDiffs,
  errorMessage,
  model,
  costUsd,
  durationMs,
}: {
  content?: string;
  rawDiffs?: string[];
  errorMessage?: string;
  model?: string;
  costUsd?: number;
  durationMs?: number;
}): Message {
  const baseContent = typeof content === "string" ? content.trim() : "";
  const composedContent = errorMessage
    ? baseContent
      ? `${baseContent}\n\nError: ${errorMessage}`
      : `Error: ${errorMessage}`
    : baseContent || ((rawDiffs?.length || 0) > 0 ? "Completed. See file changes below." : "Completed.");
  const { cleanContent, diffs: textDiffs } = extractDiffs(composedContent);
  const streamDiffs = parseRawClaudeDiffs(rawDiffs);
  const allDiffs = streamDiffs.length > 0 ? streamDiffs : textDiffs;

  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role: "assistant",
    content: cleanContent || composedContent,
    diffs: allDiffs.length > 0 ? allDiffs : undefined,
    model,
    costUsd,
    durationMs,
    createdAt: new Date(),
  };
}

type DbCodeMessageRow = {
  id: string;
  role: string;
  content: string;
  diffs: unknown;
  model: unknown;
  cost_usd: unknown;
  duration_ms: unknown;
  created_at: string;
};

function dbNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function mapDbCodeMessages(rows: DbCodeMessageRow[] | null | undefined): Message[] {
  const messages = (rows || []).map((m) => ({
    id: m.id,
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
    diffs: Array.isArray(m.diffs) ? (m.diffs as ParsedDiff[]) : undefined,
    model: typeof m.model === "string" ? m.model : undefined,
    costUsd: dbNumber(m.cost_usd),
    durationMs: dbNumber(m.duration_ms),
    createdAt: new Date(m.created_at),
  } satisfies Message));

  return messages.reduce<Message[]>((acc, msg) => {
    const last = acc[acc.length - 1];
    if (
      last?.role === "assistant" &&
      msg.role === "assistant" &&
      last.content.trim() === msg.content.trim()
    ) {
      acc[acc.length - 1] = {
        ...last,
        diffs: (last.diffs?.length || 0) > 0 ? last.diffs : msg.diffs,
        model: last.model || msg.model,
        costUsd: last.costUsd ?? msg.costUsd,
        durationMs: last.durationMs ?? msg.durationMs,
      };
      return acc;
    }
    acc.push(msg);
    return acc;
  }, []);
}

type ClaudeCodeConfig = {
  deviceId: string;
  workspaceId: string | null;
  rootPath?: string;
  codeCliProvider?: "claude" | "codex";
};

export type CodeHandshakeContext = {
  handshakeId: string;
  selfSessionId: string;
  partnerSessionId: string;
  partnerName: string;
  selfName?: string | null;
};

type ClaudeRunProgressMsg = {
  type: "claude_run_progress";
  request_id: string;
  content?: string;
  event_type?: "assistant" | "tool_use";
  tool_name?: string;
  tool_input?: string;
};

type ActiveToolCall = {
  id: string;
  toolName: string;
  summary: string;
  startedAt: number;
};

type RestoredInflightState = {
  requestId: string;
  startedAt: number;
  baselineMessageCount: number | null;
};

type ClaudeRunResultMsg = {
  type: "claude_run_result";
  request_id: string;
  ok: boolean;
  result?: string;
  error?: string;
  session_id?: string;
  model?: string;
  cost_usd?: number;
  total_cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  usage?: unknown;
  duration_ms?: number;
  diffs?: string[]; // Raw diff strings from Claude CLI
  timed_out?: boolean;
  aborted?: boolean;
  partial?: boolean;
  exit_code?: number | null;
  signal?: string | null;
  has_result_event?: boolean;
};

const CONNECTOR_CLAUDE_RUN_TIMEOUT_MS = 20 * 60 * 1000;
const CLAUDE_RUN_TIMEOUT_MS = CONNECTOR_CLAUDE_RUN_TIMEOUT_MS + 120_000;
const CLAUDE_RUN_PROGRESS_TIMEOUT_MS = CLAUDE_RUN_TIMEOUT_MS;
const MAX_RESTORED_INFLIGHT_AGE_MS = CLAUDE_RUN_TIMEOUT_MS + 60_000;
const SLASH_COMMAND_DISCOVERY_CONNECTOR_TIMEOUT_MS = 45_000;
const SLASH_COMMAND_DISCOVERY_TIMEOUT_MS =
  SLASH_COMMAND_DISCOVERY_CONNECTOR_TIMEOUT_MS + 10_000;
const CONNECTOR_WARNING_DELAY_MS = 2_500;
const SLASH_COMMAND_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
const CLAUDE_SLASH_DISCOVERY_COMPAT_PROMPT = "__GROOVY_DISCOVER_SLASH_COMMANDS__";
const CLAUDE_SLASH_DISCOVERY_RESULT_PREFIX = "__GROOVY_SLASH_COMMANDS__:";
const CLAUDE_TIMEOUT_CONTINUE_PROMPT =
  "Continue from where you left off. Do not repeat completed tool calls or duplicate file edits. Finish the current task and return the final answer directly.";
const HANDSHAKE_SEND_MARKER = "HANDSHAKE_SEND_REQUEST:";

function isTimeoutErrorMessage(value: string | null | undefined) {
  return typeof value === "string" && /timed out|time limit/i.test(value);
}

function appendIfNotDuplicate(prev: Message[], msg: Message): Message[] {
  const last = prev[prev.length - 1];
  if (last?.role === "assistant" && last.content === msg.content) {
    if (msg.diffs?.length && !last.diffs?.length) {
      return [
        ...prev.slice(0, -1),
        {
          ...last,
          diffs: msg.diffs,
          model: last.model || msg.model,
          costUsd: last.costUsd ?? msg.costUsd,
          durationMs: last.durationMs ?? msg.durationMs,
        },
      ];
    }
    return prev;
  }
  return [...prev, msg];
}

function buildCodePanelHandshakePrompt(prompt: string, handshake: CodeHandshakeContext): string {
  const selfName = (handshake.selfName || "this Code agent").trim() || "this Code agent";
  const partnerName = handshake.partnerName.trim() || "the connected partner agent";
  return [
    "[GROOVY HANDSHAKE CONTEXT]",
    `You are currently acting as "${selfName}".`,
    `You are connected to another agent session: "${partnerName}".`,
    `The user may ask you to pass an explanation, implementation plan, status update, or request to "${partnerName}".`,
    `If the user asks you to communicate with "${partnerName}", prepare that message and include exactly one final section in this format:`,
    `${HANDSHAKE_SEND_MARKER}`,
    `<message for ${partnerName}>`,
    "Only include that section when the user requested a partner handoff. For implementation handoffs, include the actual task, constraints, and acceptance criteria so the partner can do the work without asking for the original prompt.",
    `Identity rules: "${partnerName}" is your partner, not your identity. Do not claim to be "${partnerName}".`,
    "[END GROOVY HANDSHAKE CONTEXT]",
    "",
    "User request:",
    prompt,
  ].join("\n");
}

function extractHandshakeSendRequest(text: string): {
  displayText: string;
  handoffText: string;
} {
  const markerIndex = text.indexOf(HANDSHAKE_SEND_MARKER);
  if (markerIndex < 0) {
    return { displayText: text, handoffText: "" };
  }

  const displayText = text.slice(0, markerIndex).trim();
  let handoffText = text.slice(markerIndex + HANDSHAKE_SEND_MARKER.length).trim();
  handoffText = handoffText
    .replace(/^```(?:text|markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return {
    displayText,
    handoffText,
  };
}

function hasFreshSlashCommandCache(commands: string[] | null, syncedAt: number | null) {
  return (
    Array.isArray(commands) &&
    commands.length > 0 &&
    typeof syncedAt === "number" &&
    Number.isFinite(syncedAt) &&
    Date.now() - syncedAt < SLASH_COMMAND_DISCOVERY_CACHE_TTL_MS
  );
}

function parseCompatSlashCommandResult(value: unknown): string[] {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text.startsWith(CLAUDE_SLASH_DISCOVERY_RESULT_PREFIX)) return [];
  try {
    const parsed = JSON.parse(text.slice(CLAUDE_SLASH_DISCOVERY_RESULT_PREFIX.length));
    return Array.isArray(parsed?.commands)
      ? parsed.commands.filter((command: unknown): command is string => typeof command === "string")
      : [];
  } catch {
    return [];
  }
}

export function ClaudeCliChatPanel({
  agentId,
  agentName,
  codeCliProvider: codeCliProviderOverride,
  onBack,
  onPlans,
  embedded = false,
  queuedPrompt,
  onQueuedPromptHandled,
  handshake,
  sharedRelay,
}: {
  agentId: string;
  agentName?: string;
  codeCliProvider?: "claude" | "codex";
  onBack?: () => void;
  onPlans?: () => void;
  embedded?: boolean;
  queuedPrompt?: { id: string; content: string } | null;
  onQueuedPromptHandled?: (id: string) => void;
  handshake?: CodeHandshakeContext | null;
  /**
   * Optional shared relay connection. The harness grid embeds many panels at
   * once — without this each panel opens its own websocket to the relay.
   */
  sharedRelay?: ReturnType<typeof useRelay>;
}) {
  const supabase = getSupabaseBrowserClient();
  const ownRelay = useRelay({ enabled: !sharedRelay });
  const relay = sharedRelay ?? ownRelay;
  const relaySubscribe = relay.subscribe;
  const relaySend = relay.send;
  const relayReconnect = relay.reconnect;
  const relayStatus = relay.status;
  const relayIsChecking = relay.isChecking;

  // Config state
  const [config, setConfig] = useState<ClaudeCodeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showConnectorWarning, setShowConnectorWarning] = useState(false);
  const codeCliProvider: "claude" | "codex" =
    codeCliProviderOverride || config?.codeCliProvider || "claude";
  const providerLabel = codeCliProvider === "codex" ? "Codex" : "Claude Code";

  // Thread state
  const [cliSessionId, setCliSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [onlineDeviceIds, setOnlineDeviceIds] = useState<Set<string>>(new Set());

  // Persist in-flight request so the loader survives page reload / mobile sleep.
  const inflightStorageKey = `groovy_claude_run_inflight_${agentId}`;

  // Eagerly read persisted in-flight state during render (before any effects run)
  // so that currentRequestIdRef is set before the relay subscription fires.
  const restoredInflight = useMemo<RestoredInflightState | null>(() => {
    try {
      const raw = typeof window !== "undefined" ? sessionStorage.getItem(inflightStorageKey) : null;
      if (!raw) {
        console.log("[ClaudeCliChat] mount: no persisted inflight state");
        return null;
      }
      const { requestId, startedAt, baselineMessageCount } = JSON.parse(raw);
      const ageMs = Date.now() - startedAt;
      if (
        typeof requestId === "string" &&
        typeof startedAt === "number" &&
        Number.isFinite(startedAt) &&
        ageMs < MAX_RESTORED_INFLIGHT_AGE_MS
      ) {
        console.log("[ClaudeCliChat] mount: RESTORED inflight requestId=%s ageMs=%d", requestId, ageMs);
        return {
          requestId,
          startedAt,
          baselineMessageCount:
            typeof baselineMessageCount === "number" && Number.isFinite(baselineMessageCount)
              ? baselineMessageCount
              : null,
        };
      }
      // Stale — clean up
      console.log("[ClaudeCliChat] mount: stale inflight (ageMs=%d), discarding", ageMs);
      sessionStorage.removeItem(inflightStorageKey);
    } catch { /* ignore */ }
    return null;
  }, [inflightStorageKey]);

  // Input state
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(restoredInflight !== null);
  const [streamingContent, setStreamingContent] = useState("");
  const [activeTools, setActiveTools] = useState<ActiveToolCall[]>([]);
  const [planMode, setPlanMode] = useState(false);
  const [timeoutRetrySessionId, setTimeoutRetrySessionId] = useState<string | null>(null);
  const [runtimeSlashCommandNames, setRuntimeSlashCommandNames] = useState<string[] | null>(null);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [slashCommandsError, setSlashCommandsError] = useState<string | null>(null);
  const [slashCommandsSyncedAt, setSlashCommandsSyncedAt] = useState<number | null>(null);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);

  // Refs
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const toolActivityScrollRef = useRef<HTMLDivElement>(null);
  const thinkingScrollRef = useRef<HTMLDivElement>(null);
  const currentRequestIdRef = useRef<string | null>(restoredInflight?.requestId ?? null);
  const streamingContentRef = useRef("");
  const requestTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutRetryAttemptedRef = useRef(false);
  const slashCommandsRequestIdRef = useRef<string | null>(null);
  const slashCommandsRequestModeRef = useRef<"compat_run" | null>(null);
  const slashCommandsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slashCommandsDiscoveryKeyRef = useRef("");
  const processedResultIdsRef = useRef<Set<string>>(new Set());
  const lastHandledQueuedPromptIdRef = useRef<string | null>(null);
  const billingByRequestIdRef = useRef<Map<string, CodeAgentBillingContext>>(new Map());
  // Stable refs for callbacks/values used in the visibilitychange handler —
  // avoids tearing down and re-registering the listener when cliSessionId changes.
  const failInflightRequestRef = useRef<(message: string) => void>(() => {});
  const armRequestTimeoutRef = useRef<(requestId: string, timeoutMs: number, source: string) => void>(() => {});
  const clearInflightRef = useRef<() => void>(() => {});
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  const supabaseRef = useRef(supabase);
  supabaseRef.current = supabase;
  const relayReconnectRef = useRef(relayReconnect);
  relayReconnectRef.current = relayReconnect;
  const sendingRef = useRef(sending);
  sendingRef.current = sending;

  const persistInflight = useCallback((requestId: string, baselineMessageCount?: number | null) => {
    console.log("[ClaudeCliChat] persistInflight requestId=%s", requestId);
    try {
      sessionStorage.setItem(
        inflightStorageKey,
        JSON.stringify({
          requestId,
          startedAt: Date.now(),
          baselineMessageCount:
            typeof baselineMessageCount === "number" && Number.isFinite(baselineMessageCount)
              ? baselineMessageCount
              : null,
        })
      );
    } catch { /* quota / private mode */ }
  }, [inflightStorageKey]);
  const clearInflight = useCallback(() => {
    console.log("[ClaudeCliChat] clearInflight");
    try { sessionStorage.removeItem(inflightStorageKey); } catch { /* ignore */ }
  }, [inflightStorageKey]);

  const sendRunCancel = useCallback((requestId: string | null) => {
    const targetRequestId = typeof requestId === "string" ? requestId.trim() : "";
    if (!targetRequestId) return false;
    return relaySend({
      type: "claude_run_cancel",
      request_id: `cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      target_request_id: targetRequestId,
      agent_id: agentId,
      ...(config?.deviceId ? { device_id: config.deviceId } : {}),
      ...(cliSessionId ? { session_id: cliSessionId } : {}),
      cancel_all_for_agent: false,
    });
  }, [agentId, cliSessionId, config?.deviceId, relaySend]);

  const failInflightRequest = useCallback((message: string) => {
    console.error("[ClaudeCliChat] failInflightRequest: %s streamingContentLen=%d",
      message, streamingContentRef.current.length);

    sendRunCancel(currentRequestIdRef.current);

    const failedMsg = createAssistantMessage({
      content: streamingContentRef.current,
      errorMessage: message,
    });
    setMessages((prev) => appendIfNotDuplicate(prev, failedMsg));

    if (requestTimeoutRef.current) {
      clearTimeout(requestTimeoutRef.current);
      requestTimeoutRef.current = null;
    }
    currentRequestIdRef.current = null;
    clearInflight();
    setSending(false);
    setStreamingContent("");
    streamingContentRef.current = "";
    setActiveTools([]);
    if (isTimeoutErrorMessage(message) && cliSessionId) {
      setTimeoutRetrySessionId(cliSessionId);
    } else {
      setTimeoutRetrySessionId(null);
    }
    setError(message);
  }, [clearInflight, cliSessionId, sendRunCancel]);

  const armRequestTimeout = useCallback((requestId: string, timeoutMs: number, source: string) => {
    if (requestTimeoutRef.current) {
      clearTimeout(requestTimeoutRef.current);
    }
    requestTimeoutRef.current = setTimeout(() => {
      if (currentRequestIdRef.current === requestId) {
        console.log("[ClaudeCliChat] %s timeout fired for requestId=%s", source, requestId);
        failInflightRequest(`${providerLabel} hit the time limit before finishing.`);
      }
    }, timeoutMs);
  }, [failInflightRequest, providerLabel]);

  // Keep stable refs in sync with latest callback versions (for visibilitychange handler)
  failInflightRequestRef.current = failInflightRequest;
  armRequestTimeoutRef.current = armRequestTimeout;
  clearInflightRef.current = clearInflight;

  const startClaudeRunRequest = useCallback(
    async ({
      prompt,
      sessionId,
      baselineMessageCount,
    }: {
      prompt: string;
      sessionId?: string | null;
      baselineMessageCount?: number | null;
    }) => {
      const res = await fetch("/api/claude-cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          prompt,
          sessionId: sessionId || undefined,
          timeoutMs: CONNECTOR_CLAUDE_RUN_TIMEOUT_MS,
          planMode,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to prepare request");
      }

      const requestId = String(data.payload.request_id);
      if (data.billing && typeof data.billing === "object") {
        billingByRequestIdRef.current.set(requestId, data.billing as CodeAgentBillingContext);
      }
      const sent = relaySend(data.payload);
      console.log(
        "[ClaudeCliChat] sending claude_run requestId=%s relayStatus=%s sent=%s",
        requestId,
        relayStatus,
        sent
      );
      if (!sent) {
        billingByRequestIdRef.current.delete(requestId);
        failInflightRequest("Relay connection dropped before the request reached the connector. Reconnecting...");
        relayReconnect();
        return false;
      }

      currentRequestIdRef.current = requestId;
      persistInflight(requestId, baselineMessageCount);
      armRequestTimeout(requestId, CLAUDE_RUN_TIMEOUT_MS, "startClaudeRunRequest");
      return true;
    },
    [
      agentId,
      planMode,
      relaySend,
      relayStatus,
      failInflightRequest,
      relayReconnect,
      persistInflight,
      armRequestTimeout,
    ]
  );

  const slashCommandsCacheKey = useMemo(() => {
    if (!config?.deviceId) return "";
    return `groovy_${codeCliProvider}_slash_commands_${config.deviceId}_${config.rootPath || "home"}`;
  }, [codeCliProvider, config?.deviceId, config?.rootPath]);

  const slashCommandsDiscoveryKey = useMemo(() => {
    if (!config?.deviceId) return "";
    return `${codeCliProvider}:${config.deviceId}:${config.rootPath || "home"}`;
  }, [codeCliProvider, config?.deviceId, config?.rootPath]);

  const availableSlashCommands = useMemo(() => {
    const LOCAL_COMMANDS: ClaudeSlashCommand[] = [
      {
        command: "/clear",
        usage: "/clear",
        summary: "Clear conversation history and start a new session",
        aliases: ["/reset", "/new"],
        kind: "built_in",
        source: "runtime",
      },
      {
        command: "/new",
        usage: "/new",
        summary: "Clear conversation history and start a new session",
        aliases: ["/reset"],
        kind: "built_in",
        source: "runtime",
      },
      {
        command: "/copy",
        usage: "/copy",
        summary: "Copy the latest assistant response from this panel",
        aliases: [],
        kind: "built_in",
        source: "runtime",
      },
      {
        command: "/status",
        usage: "/status",
        summary: "Show this panel's connector and session status",
        aliases: [],
        kind: "built_in",
        source: "runtime",
      },
      {
        command: "/help",
        usage: "/help",
        summary: "Show available commands",
        aliases: [],
        kind: "built_in",
        source: "runtime",
      },
    ];
    const docsCommands = codeCliProvider === "codex" ? CODEX_SLASH_COMMANDS : CLAUDE_SLASH_COMMANDS;
    const runtimeCommands =
      codeCliProvider === "codex"
        ? []
        : buildRuntimeClaudeSlashCommands(runtimeSlashCommandNames || []);
    const runtimeNames = new Set(runtimeCommands.map((c) => c.command));
    const localNames = new Set(LOCAL_COMMANDS.map((c) => c.command));
    const docsOnly = docsCommands.filter(
      (c) => !runtimeNames.has(c.command) && !localNames.has(c.command)
    );
    return dedupeClaudeSlashCommands([...LOCAL_COMMANDS, ...runtimeCommands, ...docsOnly]);
  }, [codeCliProvider, runtimeSlashCommandNames]);

  const slashCommandsSource =
    codeCliProvider === "codex"
      ? "docs"
      : runtimeSlashCommandNames && runtimeSlashCommandNames.length > 0
        ? "runtime"
        : "unsynced";

  const isConnectorOnline = useMemo(() => {
    if (!config?.deviceId) return false;
    return relayStatus === "ready" && onlineDeviceIds.has(config.deviceId);
  }, [relayStatus, onlineDeviceIds, config?.deviceId]);

  useEffect(() => {
    if (embedded) {
      setShowConnectorWarning(false);
      return;
    }
    if (loading || !config?.deviceId || isConnectorOnline) {
      setShowConnectorWarning(false);
      return;
    }

    const relaySettled =
      relayStatus === "ready" ||
      relayStatus === "error" ||
      (!relayIsChecking && relayStatus === "disconnected");
    if (!relaySettled || relayIsChecking) {
      setShowConnectorWarning(false);
      return;
    }

    const timeoutId = setTimeout(() => {
      setShowConnectorWarning(true);
    }, CONNECTOR_WARNING_DELAY_MS);
    return () => clearTimeout(timeoutId);
  }, [config?.deviceId, embedded, isConnectorOnline, loading, relayIsChecking, relayStatus]);

  const handleTimeoutContinue = useCallback(
    async (sessionIdOverride?: string | null) => {
      const retrySessionId = sessionIdOverride || timeoutRetrySessionId || cliSessionId;
      if (!retrySessionId || currentRequestIdRef.current || !config || !isConnectorOnline) return false;

      timeoutRetryAttemptedRef.current = true;
      setTimeoutRetrySessionId(retrySessionId);
      setSending(true);
      setError(null);
      setStreamingContent("");
      streamingContentRef.current = "";
      setActiveTools([]);

      try {
        return await startClaudeRunRequest({
          prompt: CLAUDE_TIMEOUT_CONTINUE_PROMPT,
          sessionId: retrySessionId,
          baselineMessageCount: messages.length,
        });
      } catch (e) {
        console.error("[ClaudeCliChat] handleTimeoutContinue error:", e);
        clearInflight();
        setSending(false);
        setError(e instanceof Error ? e.message : "Failed to continue Claude run");
        return false;
      }
    },
    [
      timeoutRetrySessionId,
      cliSessionId,
      config,
      isConnectorOnline,
      messages.length,
      startClaudeRunRequest,
      clearInflight,
    ]
  );
  const applySlashCommandSyncSuccess = useCallback(
    (commands: string[], discoveredAt?: string | null) => {
      slashCommandsRequestIdRef.current = null;
      slashCommandsRequestModeRef.current = null;
      const syncedAt = discoveredAt ? Date.parse(discoveredAt) : Date.now();
      setRuntimeSlashCommandNames(commands);
      setSlashCommandsSyncedAt(Number.isFinite(syncedAt) ? syncedAt : Date.now());
      setSlashCommandsError(null);
      setSlashCommandsLoading(false);
      if (slashCommandsCacheKey) {
        try {
          sessionStorage.setItem(
            slashCommandsCacheKey,
            JSON.stringify({
              commands,
              syncedAt: Number.isFinite(syncedAt) ? syncedAt : Date.now(),
            })
          );
        } catch {
          // Ignore cache failures.
        }
      }
    },
    [slashCommandsCacheKey]
  );

  const requestCompatSlashCommands = useCallback(async () => {
    if (codeCliProvider === "codex") return false;
    if (!config?.deviceId || !isConnectorOnline) return false;
    if (slashCommandsRequestModeRef.current === "compat_run") return false;

    setSlashCommandsLoading(true);
    setSlashCommandsError("Falling back to compatibility slash-command sync...");

    if (slashCommandsTimeoutRef.current) {
      clearTimeout(slashCommandsTimeoutRef.current);
      slashCommandsTimeoutRef.current = null;
    }

    try {
      const res = await fetch("/api/claude-cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          prompt: CLAUDE_SLASH_DISCOVERY_COMPAT_PROMPT,
          timeoutMs: SLASH_COMMAND_DISCOVERY_CONNECTOR_TIMEOUT_MS,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data?.ok || !data?.payload?.request_id) {
        throw new Error(data?.error || "Failed to start compatibility slash-command sync");
      }

      const requestId = String(data.payload.request_id);
      console.log("[ClaudeCliChat] slash discovery compat prepared", {
        requestId,
        deviceId: typeof data?.payload?.device_id === "string" ? data.payload.device_id : null,
      });
      slashCommandsRequestIdRef.current = requestId;
      slashCommandsRequestModeRef.current = "compat_run";
      const sent = relaySend({
        ...data.payload,
        persist_result: false,
      });
      console.log("[ClaudeCliChat] slash discovery compat relay send", {
        requestId,
        sent,
      });
      if (!sent) {
        throw new Error("Relay send dropped before compatibility discovery reached the connector.");
      }

      slashCommandsTimeoutRef.current = setTimeout(() => {
        if (slashCommandsRequestIdRef.current !== requestId) return;
        slashCommandsRequestIdRef.current = null;
        slashCommandsRequestModeRef.current = null;
        setRuntimeSlashCommandNames([]);
        setSlashCommandsSyncedAt(null);
        setSlashCommandsLoading(false);
        setSlashCommandsError("Timed out syncing commands from installed Claude.");
      }, SLASH_COMMAND_DISCOVERY_TIMEOUT_MS);

      return true;
    } catch (e) {
      slashCommandsRequestIdRef.current = null;
      slashCommandsRequestModeRef.current = null;
      if (slashCommandsTimeoutRef.current) {
        clearTimeout(slashCommandsTimeoutRef.current);
        slashCommandsTimeoutRef.current = null;
      }
      setRuntimeSlashCommandNames([]);
      setSlashCommandsSyncedAt(null);
      setSlashCommandsLoading(false);
      setSlashCommandsError(
        e instanceof Error ? e.message : "Failed to start compatibility slash-command sync."
      );
      return true;
    }
  }, [agentId, codeCliProvider, config?.deviceId, isConnectorOnline, relaySend]);

  useEffect(() => {
    if (!restoredInflight) return;

    let cancelled = false;
    let pollTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let expiredRecoveryAttempts = 0;

    currentRequestIdRef.current = restoredInflight.requestId;
    setSending(true);
    setError(null);

    const elapsedMs = Date.now() - restoredInflight.startedAt;
    const remainingMs = CLAUDE_RUN_TIMEOUT_MS - elapsedMs;
    const expiredAtRestore = remainingMs <= 0;
    if (!expiredAtRestore) {
      armRequestTimeout(restoredInflight.requestId, remainingMs, "restored inflight");
    }

    const pollForRecoveredResult = async () => {
      if (cancelled) return;
      if (currentRequestIdRef.current !== restoredInflight.requestId) return;

      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user && !cancelled) {
          const { data: thread } = await supabase
            .from("claude_code_cli_threads")
            .select("claude_session_id")
            .eq("user_id", user.id)
            .eq("claude_code_agent_id", agentId)
            .maybeSingle();
          if (thread?.claude_session_id) {
            setCliSessionId(thread.claude_session_id);
          }

          const { data: msgs } = await supabase
            .from("claude_code_cli_messages")
            .select("id, role, content, diffs, model, cost_usd, duration_ms, created_at")
            .eq("user_id", user.id)
            .eq("claude_code_agent_id", agentId)
            .order("created_at", { ascending: true });

          if (msgs && !cancelled) {
            const hasDbAdvancedPastBaseline =
              restoredInflight.baselineMessageCount == null
                ? true
                : msgs.length > restoredInflight.baselineMessageCount;
            const lastDbMsg = msgs[msgs.length - 1];
            if (lastDbMsg?.role === "assistant" && hasDbAdvancedPastBaseline) {
              setMessages(mapDbCodeMessages(msgs));
              if (requestTimeoutRef.current) {
                clearTimeout(requestTimeoutRef.current);
                requestTimeoutRef.current = null;
              }
              currentRequestIdRef.current = null;
              clearInflight();
              setSending(false);
              setStreamingContent("");
              streamingContentRef.current = "";
              setActiveTools([]);
              setError(null);
              return;
            }
          }
        }
      } catch (e) {
        console.warn("[ClaudeCliChat] restored inflight DB poll failed:", e);
      }

      if (!cancelled && currentRequestIdRef.current === restoredInflight.requestId) {
        if (expiredAtRestore) {
          expiredRecoveryAttempts += 1;
          if (expiredRecoveryAttempts >= 5) {
            failInflightRequest("Claude request timed out before a final result arrived.");
            return;
          }
        }
        pollTimeoutId = setTimeout(() => void pollForRecoveredResult(), 4_000);
      }
    };

    pollTimeoutId = setTimeout(() => void pollForRecoveredResult(), 1_500);
    return () => {
      cancelled = true;
      if (pollTimeoutId) clearTimeout(pollTimeoutId);
    };
  }, [restoredInflight, agentId, supabase, armRequestTimeout, failInflightRequest, clearInflight]);

  useEffect(() => {
    return () => {
      if (requestTimeoutRef.current) {
        clearTimeout(requestTimeoutRef.current);
        requestTimeoutRef.current = null;
      }
      if (slashCommandsTimeoutRef.current) {
        clearTimeout(slashCommandsTimeoutRef.current);
        slashCommandsTimeoutRef.current = null;
      }
    };
  }, []);

  // Recover from mobile sleep/wake: when the user backgrounds the PWA (especially
  // on iOS home-screen apps), setTimeout timers are suspended and the relay WebSocket
  // can look "open" even though the page JS missed all progress while it was frozen.
  // When the user returns, we need to:
  // 1. Force a fresh relay connection if Claude is still in flight.
  // 2. Check if the in-flight request timed out while we were asleep.
  // 3. Re-arm the timeout with the remaining time (since the browser froze the timer).
  // 4. Reload messages + session_id from DB in case the connector finished while we were away.
  // 5. Even without an in-flight request, refresh messages in case state drifted.
  useEffect(() => {
    let lastHiddenAt = 0;
    let lastWakeAt = 0;
    let wakeTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const reloadMessagesFromDb = async (
      pendingRequestId: string | null,
      attempt = 1,
      opts?: { failIfStillMissing?: boolean }
    ) => {
      const scheduleRetry = () => {
        if (
          pendingRequestId &&
          currentRequestIdRef.current === pendingRequestId &&
          attempt < 5
        ) {
          retryTimeoutId = setTimeout(
            () => void reloadMessagesFromDb(pendingRequestId, attempt + 1, opts),
            3_500
          );
          return true;
        }
        return false;
      };

      try {
        // If the request was already resolved (e.g. relay delivered the result on the
        // new connection while we were waiting), bail out so we don't overwrite state.
        if (pendingRequestId && currentRequestIdRef.current !== pendingRequestId) return;

        const sb = supabaseRef.current;
        const { data: { user } } = await sb.auth.getUser();
        if (!user) {
          if (!scheduleRetry() && opts?.failIfStillMissing && pendingRequestId && currentRequestIdRef.current === pendingRequestId) {
            failInflightRequestRef.current("Claude request timed out while the app was in the background.");
          }
          return;
        }
        const { data: thread } = await sb
          .from("claude_code_cli_threads")
          .select("claude_session_id")
          .eq("user_id", user.id)
          .eq("claude_code_agent_id", agentIdRef.current)
          .maybeSingle();
        if (thread?.claude_session_id) {
          setCliSessionId(thread.claude_session_id);
        }
        const { data: msgs } = await sb
          .from("claude_code_cli_messages")
          .select("id, role, content, diffs, model, cost_usd, duration_ms, created_at")
          .eq("user_id", user.id)
          .eq("claude_code_agent_id", agentIdRef.current)
          .order("created_at", { ascending: true });

        if (!msgs) {
          if (!scheduleRetry() && opts?.failIfStillMissing && pendingRequestId && currentRequestIdRef.current === pendingRequestId) {
            failInflightRequestRef.current("Claude request timed out while the app was in the background.");
          }
          return;
        }

        const dbMessages = mapDbCodeMessages(msgs);

        if (pendingRequestId && currentRequestIdRef.current === pendingRequestId) {
          let hasDbAdvancedPastBaseline = true;
          try {
            const raw = sessionStorage.getItem(`groovy_claude_run_inflight_${agentIdRef.current}`);
            if (raw) {
              const parsed = JSON.parse(raw) as { baselineMessageCount?: unknown };
              if (
                typeof parsed.baselineMessageCount === "number" &&
                Number.isFinite(parsed.baselineMessageCount)
              ) {
                hasDbAdvancedPastBaseline = msgs.length > parsed.baselineMessageCount;
              }
            }
          } catch {
            // Ignore parse failures and fall back to the role-only heuristic.
          }

          // In-flight: check if the DB has a completed result
          const lastDbMsg = msgs[msgs.length - 1];
          if (lastDbMsg?.role === "assistant" && hasDbAdvancedPastBaseline) {
            console.log("[ClaudeCliChat] DB has result from backgrounded request, recovering");
            setMessages(dbMessages);
            if (requestTimeoutRef.current) {
              clearTimeout(requestTimeoutRef.current);
              requestTimeoutRef.current = null;
            }
            currentRequestIdRef.current = null;
            clearInflightRef.current();
            setSending(false);
            setStreamingContent("");
            streamingContentRef.current = "";
            setActiveTools([]);
            setError(null);
          } else if (!scheduleRetry() && opts?.failIfStillMissing && currentRequestIdRef.current === pendingRequestId) {
            failInflightRequestRef.current("Claude request timed out while the app was in the background.");
          }
        } else if (!pendingRequestId) {
          // No in-flight request — just refresh messages to catch anything we missed
          console.log("[ClaudeCliChat] wake refresh (no in-flight), syncing messages from DB");
          setMessages(dbMessages);
        }
      } catch (e) {
        console.warn("[ClaudeCliChat] wake-from-sleep DB reload failed:", e);
        if (!scheduleRetry() && opts?.failIfStillMissing && pendingRequestId && currentRequestIdRef.current === pendingRequestId) {
          failInflightRequestRef.current("Claude request timed out while the app was in the background.");
        }
      }
    };

    const handleWake = (source: string) => {
      if (document.visibilityState !== "visible") return;

      const now = Date.now();
      const sleepDurationMs = lastHiddenAt ? now - lastHiddenAt : 0;
      const pendingRequestId = currentRequestIdRef.current;
      const hasInflightRequest = !!pendingRequestId || sendingRef.current;
      // Skip idle tab flickers, but never skip wake recovery for an in-flight Claude run.
      if (sleepDurationMs < 5_000 && !hasInflightRequest) return;

      // Debounce: visibilitychange, pageshow, and focus can all fire within
      // milliseconds on a single wake.  Only run the recovery logic once.
      if (now - lastWakeAt < 2_000) return;
      lastWakeAt = now;
      if (wakeTimeoutId) {
        clearTimeout(wakeTimeoutId);
        wakeTimeoutId = null;
      }
      if (retryTimeoutId) {
        clearTimeout(retryTimeoutId);
        retryTimeoutId = null;
      }
      console.log("[ClaudeCliChat] woke from sleep", {
        source,
        sleepDurationMs,
        requestId: pendingRequestId,
        hasInflightRequest,
      });

      if (hasInflightRequest) {
        console.log("[ClaudeCliChat] forcing relay reconnect after wake", {
          source,
          requestId: pendingRequestId,
        });
        relayReconnectRef.current();
      }

      if (pendingRequestId) {
        // Read inflightStorageKey from ref-backed agentId (stable pattern)
        const storageKey = `groovy_claude_run_inflight_${agentIdRef.current}`;

        // Check if the request has exceeded its timeout window
        let startedAt: number | null = null;
        try {
          const raw = sessionStorage.getItem(storageKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (typeof parsed.startedAt === "number") startedAt = parsed.startedAt;
          }
        } catch { /* ignore */ }

        const elapsedMs = startedAt ? Date.now() - startedAt : Infinity;

        if (elapsedMs >= CLAUDE_RUN_TIMEOUT_MS) {
          wakeTimeoutId = setTimeout(
            () => void reloadMessagesFromDb(pendingRequestId, 1, { failIfStillMissing: true }),
            1_500
          );
          return;
        }

        // Re-arm the timeout with the remaining time.  The relay now persists
        // results for offline browsers, so the DB reload retries below will
        // recover them.  Progress messages on the reconnected WebSocket also
        // reset this timeout to the full duration.
        const remainingMs = CLAUDE_RUN_TIMEOUT_MS - elapsedMs;
        armRequestTimeoutRef.current(pendingRequestId, remainingMs, "wake-from-sleep");
      }

      // Reload messages from DB after a short delay: the connector may have finished
      // and persisted the result while we were asleep.  If a result row exists, the
      // relay subscription will never deliver it (the WebSocket reconnected to a fresh
      // stream), so we need to pull from the DB.
      wakeTimeoutId = setTimeout(() => void reloadMessagesFromDb(pendingRequestId), 1500);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        lastHiddenAt = Date.now();
        return;
      }
      handleWake("visibilitychange");
    };

    // pageshow fires when iOS PWA is restored from the app switcher (bfcache).
    const handlePageShow = (e: PageTransitionEvent) => {
      handleWake(e.persisted ? "pageshow-persisted" : "pageshow");
    };

    // focus fires on some Android WebViews / PWAs that skip visibilitychange.
    const handleFocus = () => {
      handleWake("focus");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handleFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleFocus);
      if (wakeTimeoutId) clearTimeout(wakeTimeoutId);
      if (retryTimeoutId) clearTimeout(retryTimeoutId);
    };
  }, []); // stable — reads from refs

  // Keep outer message scrolling stable while live output streams inside the
  // working card. The inner tool/thinking panes handle token-level scrolling.
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length]);

  useEffect(() => {
    if (!sending) return;
    const el = messagesScrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [sending]);

  // Auto-scroll tool activity to the newest tool event.
  useEffect(() => {
    const el = toolActivityScrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTools]);

  // Auto-scroll thinking section to bottom as content streams in
  useEffect(() => {
    const el = thinkingScrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [streamingContent]);

  // Auto-resize textarea height (handles both typing and programmatic clears like send)
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.max(44, Math.min(textarea.scrollHeight + 2, 120))}px`;
  }, [input]);

  // Load config
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // Get agent config
        const { data: configData, error: configErr } = await supabase
          .from("claude_code_agent_configs")
          .select("device_id, workspace_id, code_cli_provider")
          .eq("agent_id", agentId)
          .single();

        if (configErr || !configData) {
          throw new Error("Code session not configured");
        }

        const workspaceId =
          typeof (configData as { workspace_id?: unknown } | null)?.workspace_id === "string"
            ? String((configData as { workspace_id: string }).workspace_id)
            : null;

        // Get workspace details for root path (optional)
        const workspace =
          workspaceId
            ? (
                await supabase
                  .from("device_workspaces")
                  .select("root_path")
                  .eq("id", workspaceId)
                  .single()
              ).data
            : null;

        if (cancelled) return;

        setConfig({
          deviceId: configData.device_id,
          workspaceId,
          rootPath: workspace?.root_path || undefined,
          codeCliProvider:
            (configData as { code_cli_provider?: unknown }).code_cli_provider === "codex"
              ? "codex"
              : "claude",
        });
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load config");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [agentId, supabase]);

  // Load thread and messages
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    setLoadingMessages(true);

    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user || cancelled) return;

        // Get or create thread
        const { data: thread } = await supabase
          .from("claude_code_cli_threads")
          .select("claude_session_id")
          .eq("user_id", user.id)
          .eq("claude_code_agent_id", agentId)
          .single();

        if (thread?.claude_session_id) {
          setCliSessionId(thread.claude_session_id);
        }

        // Load messages
        const { data: msgs } = await supabase
          .from("claude_code_cli_messages")
          .select("id, role, content, diffs, model, cost_usd, duration_ms, created_at")
          .eq("user_id", user.id)
          .eq("claude_code_agent_id", agentId)
          .order("created_at", { ascending: true });

        if (cancelled) return;

        if (msgs) {
          setMessages(mapDbCodeMessages(msgs));
        }
      } catch (e) {
        console.error("[ClaudeCliChatPanel] Error loading messages:", e);
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    })();

    return () => { cancelled = true; };
  }, [agentId, config, supabase]);

  // Reload messages when handshake code path writes new entries externally.
  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ agentId?: string }>).detail;
      if (detail?.agentId !== agentId) return;
      (async () => {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) return;
          const { data: msgs } = await supabase
            .from("claude_code_cli_messages")
            .select("id, role, content, diffs, model, cost_usd, duration_ms, created_at")
            .eq("user_id", user.id)
            .eq("claude_code_agent_id", agentId)
            .order("created_at", { ascending: true });
          if (msgs) {
            setMessages(mapDbCodeMessages(msgs));
          }
          const { data: thread } = await supabase
            .from("claude_code_cli_threads")
            .select("claude_session_id")
            .eq("user_id", user.id)
            .eq("claude_code_agent_id", agentId)
            .maybeSingle();
          if (thread?.claude_session_id) {
            setCliSessionId(thread.claude_session_id);
          }
        } catch { /* ignore */ }
      })();
    };
    window.addEventListener("groovy:claude-cli-refresh", handler);
    return () => window.removeEventListener("groovy:claude-cli-refresh", handler);
  }, [agentId, supabase]);

  // Save thread session_id
  const saveThreadSessionId = useCallback(async (sessionId: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { error } = await supabase
        .from("claude_code_cli_threads")
        .upsert({
          user_id: user.id,
          claude_code_agent_id: agentId,
          claude_session_id: sessionId,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: "user_id,claude_code_agent_id",
        });
      
      if (error) {
        console.error("[ClaudeCliChatPanel] Error saving session_id:", error);
      }
    } catch (e) {
      console.error("[ClaudeCliChatPanel] Error saving session_id:", e);
    }
  }, [agentId, supabase]);

  const loadLatestThreadSessionId = useCallback(async (): Promise<{
    loaded: boolean;
    sessionId: string | null;
  }> => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { loaded: false, sessionId: null };

      const { data: thread } = await supabase
        .from("claude_code_cli_threads")
        .select("claude_session_id")
        .eq("user_id", user.id)
        .eq("claude_code_agent_id", agentId)
        .maybeSingle();

      const sessionId =
        typeof thread?.claude_session_id === "string" && thread.claude_session_id.trim()
          ? thread.claude_session_id.trim()
          : null;
      if (sessionId !== cliSessionId) {
        setCliSessionId(sessionId);
      }
      return { loaded: true, sessionId };
    } catch (e) {
      console.warn("[ClaudeCliChatPanel] Failed to load latest session_id:", e);
      return { loaded: false, sessionId: null };
    }
  }, [agentId, cliSessionId, supabase]);

  // Persist message to DB
  const persistMessage = useCallback(async (msg: Message): Promise<string | null> => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;

      // Don't set id - let the database generate the UUID
      const { data, error } = await supabase
        .from("claude_code_cli_messages")
        .insert({
          user_id: user.id,
          claude_code_agent_id: agentId,
          role: msg.role,
          content: msg.content,
          diffs: msg.diffs || null,
          model: msg.model || null,
          cost_usd: msg.costUsd || null,
          duration_ms: msg.durationMs || null,
        })
        .select("id")
        .single();
      
      if (error) {
        console.error("[ClaudeCliChatPanel] Error persisting message:", error);
        return null;
      }
      return typeof data?.id === "string" ? data.id : null;
    } catch (e) {
      console.error("[ClaudeCliChatPanel] Error persisting message:", e);
      return null;
    }
  }, [agentId, supabase]);

  const deletePersistedMessage = useCallback(async (messageId: string | null) => {
    const id = typeof messageId === "string" ? messageId.trim() : "";
    if (!id) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { error } = await supabase
        .from("claude_code_cli_messages")
        .delete()
        .eq("id", id)
        .eq("user_id", user.id)
        .eq("claude_code_agent_id", agentId);

      if (error) {
        console.error("[ClaudeCliChatPanel] Error deleting failed message:", error);
      }
    } catch (e) {
      console.error("[ClaudeCliChatPanel] Error deleting failed message:", e);
    }
  }, [agentId, supabase]);

  const sendHandshakeHandoff = useCallback(
    async (content: string) => {
      const handoffText = content.trim();
      if (!handoffText || !handshake?.handshakeId || !handshake.selfSessionId) return;

      const res = await fetch(
        `/api/handshake/${encodeURIComponent(handshake.handshakeId)}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromSessionId: handshake.selfSessionId,
            partnerSessionId: handshake.partnerSessionId || undefined,
            content: handoffText,
            metadata: {
              code_handshake_handoff: true,
              code_agent_id: agentId,
              code_agent_name: agentName || null,
            },
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        ok?: boolean;
        handshakeId?: string;
        fromSessionId?: string;
        toSessionId?: string;
        traceId?: string;
        message?: { content?: string };
      } | null;

      if (!res.ok) {
        throw new Error(data?.error || `Handshake send failed (${res.status})`);
      }

      if (
        typeof window !== "undefined" &&
        data?.ok === true &&
        typeof data.traceId === "string" &&
        data.traceId.trim() &&
        typeof data.toSessionId === "string" &&
        data.toSessionId.trim()
      ) {
        window.dispatchEvent(
          new CustomEvent("groovy:handshake-message-sent", {
            detail: {
              handshakeId: data.handshakeId || handshake.handshakeId,
              fromSessionId: data.fromSessionId || handshake.selfSessionId,
              toSessionId: data.toSessionId,
              traceId: data.traceId,
              content: data.message?.content || handoffText,
            },
          })
        );
      }
    },
    [agentId, agentName, handshake]
  );

  // Subscribe to relay messages
  useEffect(() => {
    const unsub = relaySubscribe((msg: RelayMessage) => {
      if (msg.type === "device_online") {
        const deviceId = String(msg.device_id || "");
        if (deviceId) {
          setOnlineDeviceIds((prev) => {
            if (prev.has(deviceId)) return prev;
            const next = new Set(prev);
            next.add(deviceId);
            return next;
          });
        }
        return;
      }

      if (msg.type === "device_offline") {
        const deviceId = String(msg.device_id || "");
        if (deviceId) {
          setOnlineDeviceIds((prev) => {
            if (!prev.has(deviceId)) return prev;
            const next = new Set(prev);
            next.delete(deviceId);
            return next;
          });
        }
        if (
          deviceId &&
          config?.deviceId &&
          deviceId === config.deviceId &&
          slashCommandsRequestIdRef.current
        ) {
          if (slashCommandsTimeoutRef.current) {
            clearTimeout(slashCommandsTimeoutRef.current);
            slashCommandsTimeoutRef.current = null;
          }
          slashCommandsRequestIdRef.current = null;
          slashCommandsRequestModeRef.current = null;
          slashCommandsDiscoveryKeyRef.current = "";
          setSlashCommandsLoading(false);
          setSlashCommandsError("Configured device went offline while syncing Claude commands.");
        }
        if (deviceId && config?.deviceId && deviceId === config.deviceId && currentRequestIdRef.current) {
          failInflightRequest("Configured device went offline while Claude Code was running.");
        }
        return;
      }

      if (msg.type === "error") {
        const relayError = String(msg.error || "Relay error");
        const errorMessage =
          relayError === "device_not_online"
            ? "Configured device is offline. Start the connector for this device, or recreate this code agent with the currently connected device."
            : relayError;
        // Fail fast when relay rejects the request (e.g. device_not_online).
        if (currentRequestIdRef.current) {
          failInflightRequest(errorMessage);
        } else {
          setError(errorMessage);
        }
        return;
      }

      if (msg.type === "claude_run_progress") {
        const progress = msg as unknown as ClaudeRunProgressMsg;
        if (
          slashCommandsRequestModeRef.current === "compat_run" &&
          slashCommandsRequestIdRef.current &&
          progress.request_id === slashCommandsRequestIdRef.current
        ) {
          return;
        }
      }

      if (msg.type === "claude_run_result") {
        const compatResult = msg as unknown as ClaudeRunResultMsg;
        if (
          slashCommandsRequestModeRef.current === "compat_run" &&
          slashCommandsRequestIdRef.current &&
          compatResult.request_id === slashCommandsRequestIdRef.current
        ) {
          if (slashCommandsTimeoutRef.current) {
            clearTimeout(slashCommandsTimeoutRef.current);
            slashCommandsTimeoutRef.current = null;
          }

          const commands = parseCompatSlashCommandResult(compatResult.result);
          if (compatResult.ok && commands.length > 0) {
            console.log("[ClaudeCliChat] slash discovery compat result", {
              requestId: compatResult.request_id,
              commandsCount: commands.length,
            });
            applySlashCommandSyncSuccess(commands);
          } else {
            slashCommandsRequestIdRef.current = null;
            slashCommandsRequestModeRef.current = null;
            setSlashCommandsLoading(false);
            setRuntimeSlashCommandNames([]);
            setSlashCommandsSyncedAt(null);
            setSlashCommandsError(
              compatResult.error ||
                "Compatibility slash-command sync did not return any commands."
            );
          }
          return;
        }
      }

      const requestId = currentRequestIdRef.current;
      if (!requestId) {
        const msgType = (msg as { type?: string }).type;
        if (msgType === "claude_run_progress" || msgType === "claude_run_result") {
          console.log("[ClaudeCliChat] received %s but no currentRequestId — dropped", msgType);
        }
        return;
      }

      // Progress event - streaming content or tool_use
      if ((msg as { type?: string }).type === "claude_run_progress") {
        const progress = msg as unknown as ClaudeRunProgressMsg;
        if (progress.request_id !== requestId) return;

        if (progress.event_type === "tool_use" && progress.tool_name) {
          const nextToolName = progress.tool_name.trim();
          const nextSummary = typeof progress.tool_input === "string" ? progress.tool_input.trim() : "";
          // Tool call event — add to active tools list (keep last 8) and suppress
          // duplicate consecutive events so repeated stream chunks do not spam the UI.
          setActiveTools((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.toolName === nextToolName && last.summary === nextSummary) {
              return prev;
            }
            return [
              ...prev.slice(-7),
              {
                id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                toolName: nextToolName,
                summary: nextSummary,
                startedAt: Date.now(),
              },
            ];
          });
        } else if (progress.content) {
          console.log("[ClaudeCliChat] claude_run_progress matched requestId=%s, contentLen=%d", requestId, progress.content.length);
          streamingContentRef.current += progress.content;
          setStreamingContent(streamingContentRef.current);
        }

        // Reset timeout — we're still receiving data (for both event types).
        // Keep the full connector timeout here: Codex/Claude may run a long
        // shell/build step without emitting more progress, and starting a
        // browser-side resume while the original connector job is still active
        // can leave the panel stuck in a stale "working" state.
        armRequestTimeout(requestId, CLAUDE_RUN_PROGRESS_TIMEOUT_MS, "progress");
      }

      // Result event - final response
      if ((msg as { type?: string }).type === "claude_run_result") {
        const result = msg as unknown as ClaudeRunResultMsg;
        if (result.request_id !== requestId) {
          console.log("[ClaudeCliChat] claude_run_result requestId mismatch: got=%s expected=%s", result.request_id, requestId);
          return;
        }
        if (processedResultIdsRef.current.has(result.request_id)) {
          console.log("[ClaudeCliChat] claude_run_result already processed requestId=%s — skipped", result.request_id);
          return;
        }
        processedResultIdsRef.current.add(result.request_id);
        if (processedResultIdsRef.current.size > 50) {
          const first = processedResultIdsRef.current.values().next().value;
          if (first) processedResultIdsRef.current.delete(first);
        }

        console.log("[ClaudeCliChat] claude_run_result matched requestId=%s ok=%s model=%s resultLen=%d streamingLen=%d error=%s timedOut=%s partial=%s hasResultEvent=%s",
          requestId, result.ok,
          result.model || "(none)",
          typeof result.result === "string" ? result.result.length : 0,
          streamingContentRef.current.length,
          result.error || "(none)",
          result.timed_out === true,
          result.partial === true,
          result.has_result_event ?? false);

        // Clear timeout — request completed normally
        if (requestTimeoutRef.current) {
          clearTimeout(requestTimeoutRef.current);
          requestTimeoutRef.current = null;
        }

        currentRequestIdRef.current = null;
        clearInflight();
        setSending(false);
        setActiveTools([]);

        const billingContext = billingByRequestIdRef.current.get(result.request_id) || null;
        billingByRequestIdRef.current.delete(result.request_id);
        recordCodeAgentUsageBestEffort({
          agentId,
          requestId: result.request_id,
          billing: billingContext,
          result: { ...result, ok: result.ok === true },
        });

        if (result.ok) {
          const rawResult = typeof result.result === "string" ? result.result : "";

          const discoveredCommands = parseCompatSlashCommandResult(rawResult);
          if (discoveredCommands.length > 0) {
            applySlashCommandSyncSuccess(discoveredCommands);
          } else {
            const fallbackContent =
              rawResult.trim() ||
              streamingContentRef.current.trim() ||
              ((result.diffs?.length || 0) > 0
                ? "Completed. See file changes below."
                : "Completed.");
            console.log("[ClaudeCliChat] ok=true rawResultLen=%d fallbackLen=%d diffsCount=%d",
              rawResult.length, fallbackContent.length, result.diffs?.length || 0);
            const responseText = rawResult || fallbackContent;
            const handshakeSend =
              handshake?.handshakeId && responseText
                ? extractHandshakeSendRequest(responseText)
                : { displayText: responseText, handoffText: "" };
            const displayContent =
              handshakeSend.displayText.trim() ||
              (handshakeSend.handoffText
                ? `Prepared a handoff for ${handshake?.partnerName || "the connected partner agent"}.`
                : fallbackContent);
            const reportedModel = inferCodeAgentResultModel({
              model: typeof result.model === "string" ? result.model : null,
              billing: billingContext,
            });
            const assistantMsg = createAssistantMessage({
              content: displayContent,
              rawDiffs: result.diffs,
              model: reportedModel || undefined,
              costUsd: result.cost_usd,
              durationMs: result.duration_ms,
            });
            setMessages((prev) => appendIfNotDuplicate(prev, assistantMsg));
            if (handshakeSend.handoffText) {
              void sendHandshakeHandoff(handshakeSend.handoffText).catch((err) => {
                setError(
                  err instanceof Error
                    ? err.message
                    : "Failed to send handoff to connected partner agent"
                );
              });
            }
          }

          setTimeoutRetrySessionId(null);
          timeoutRetryAttemptedRef.current = false;
          setStreamingContent("");
          streamingContentRef.current = "";
          if (result.session_id) {
            setCliSessionId(result.session_id);
            void saveThreadSessionId(result.session_id);
          }

        } else {
          // Error response — surface as both an error banner AND a visible message
          // so the user sees what happened even if the error banner is off-screen.
          const errorMsg =
            result.error ||
            (result.timed_out
              ? `${providerLabel} hit the time limit before finishing.`
              : `${providerLabel} CLI failed`);
          const rawResult = typeof result.result === "string" ? result.result : "";
          const timedOut = result.timed_out === true || isTimeoutErrorMessage(errorMsg);
          const retrySessionId = result.session_id || cliSessionId || null;
          const canContinueRetry = timedOut && !!retrySessionId;
          const willAutoContinue = canContinueRetry && !timeoutRetryAttemptedRef.current;
          console.error("[ClaudeCliChat] claude_run_result ok=false error=%s model=%s streamingContentLen=%d rawResultLen=%d diffsCount=%d timedOut=%s partial=%s exitCode=%s signal=%s hasResultEvent=%s",
            errorMsg,
            result.model || "(none)",
            streamingContentRef.current.length,
            rawResult.length,
            result.diffs?.length || 0,
            timedOut,
            result.partial === true,
            result.exit_code ?? "(none)",
            result.signal || "(none)",
            result.has_result_event ?? false);

          const errorAssistantMsg = createAssistantMessage({
            content: rawResult || streamingContentRef.current,
            rawDiffs: result.diffs,
            model: inferCodeAgentResultModel({
              model: typeof result.model === "string" ? result.model : null,
              billing: billingContext,
            }) || undefined,
            errorMessage: willAutoContinue
              ? `${errorMsg}\n\nAttempting to continue from the same ${providerLabel} session...`
              : errorMsg,
          });
          setMessages((prev) => appendIfNotDuplicate(prev, errorAssistantMsg));
          if (result.session_id) {
            setCliSessionId(result.session_id);
            void saveThreadSessionId(result.session_id);
          }

          setStreamingContent("");
          streamingContentRef.current = "";
          setTimeoutRetrySessionId(canContinueRetry ? retrySessionId : null);

          if (willAutoContinue) {
            setError(`${providerLabel} hit the time limit. Continuing from the same session...`);
            void handleTimeoutContinue(retrySessionId);
            return;
          }

          setError(errorMsg);
        }
      }
    });

    return () => unsub();
  }, [
    relaySubscribe,
    persistMessage,
    saveThreadSessionId,
    clearInflight,
    config?.deviceId,
    failInflightRequest,
    armRequestTimeout,
    applySlashCommandSyncSuccess,
    requestCompatSlashCommands,
    cliSessionId,
    handleTimeoutContinue,
    agentId,
    providerLabel,
    handshake,
    sendHandshakeHandoff,
  ]);

  useEffect(() => {
    if (!slashCommandsCacheKey) {
      setRuntimeSlashCommandNames(null);
      setSlashCommandsSyncedAt(null);
      setSlashCommandsError(null);
      slashCommandsDiscoveryKeyRef.current = "";
      return;
    }

    slashCommandsDiscoveryKeyRef.current = "";
    try {
      const raw =
        typeof window !== "undefined" ? sessionStorage.getItem(slashCommandsCacheKey) : null;
      if (!raw) {
        setRuntimeSlashCommandNames(null);
        setSlashCommandsSyncedAt(null);
        return;
      }
      const parsed = JSON.parse(raw);
      const commands = Array.isArray(parsed?.commands)
        ? parsed.commands.filter((value: unknown): value is string => typeof value === "string")
        : [];
      const syncedAt = Number(parsed?.syncedAt);
      setRuntimeSlashCommandNames(commands.length > 0 ? commands : null);
      setSlashCommandsSyncedAt(Number.isFinite(syncedAt) ? syncedAt : null);
    } catch {
      setRuntimeSlashCommandNames(null);
      setSlashCommandsSyncedAt(null);
    }
  }, [slashCommandsCacheKey]);

  const requestLiveSlashCommands = useCallback(async (force = false) => {
    if (codeCliProvider === "codex") return;
    if (!config?.deviceId || !isConnectorOnline) return;
    if (!force && slashCommandsLoading) return;
    if (!force && hasFreshSlashCommandCache(runtimeSlashCommandNames, slashCommandsSyncedAt)) {
      return;
    }
    void requestCompatSlashCommands();
  }, [
    config?.deviceId,
    codeCliProvider,
    isConnectorOnline,
    runtimeSlashCommandNames,
    slashCommandsLoading,
    slashCommandsSyncedAt,
    requestCompatSlashCommands,
  ]);

  const slashMatch = useMemo(() => {
    const trimmed = input.trimStart();
    return trimmed.match(/^\/([a-zA-Z0-9_-]*)(?:\s+([^\n]*))?$/);
  }, [input]);

  const slashQuery = slashMatch?.[1] ?? "";
  const slashHasArgs = slashMatch ? slashMatch[2] !== undefined : false;
  const slashCommands = useMemo(
    () => (slashMatch ? filterClaudeSlashCommands(availableSlashCommands, slashQuery) : []),
    [slashMatch, availableSlashCommands, slashQuery]
  );

  const isSlashMenuOpen = Boolean(slashMatch);
  const activeSlashCommand =
    slashCommands.length > 0 ? slashCommands[Math.min(slashSelectedIndex, slashCommands.length - 1)] : null;

  useEffect(() => {
    if (!slashCommandsDiscoveryKey || !isConnectorOnline || !isSlashMenuOpen) return;
    if (hasFreshSlashCommandCache(runtimeSlashCommandNames, slashCommandsSyncedAt)) {
      slashCommandsDiscoveryKeyRef.current = slashCommandsDiscoveryKey;
      return;
    }
    if (slashCommandsDiscoveryKeyRef.current === slashCommandsDiscoveryKey) return;
    slashCommandsDiscoveryKeyRef.current = slashCommandsDiscoveryKey;
    void requestLiveSlashCommands();
  }, [
    isConnectorOnline,
    isSlashMenuOpen,
    requestLiveSlashCommands,
    runtimeSlashCommandNames,
    slashCommandsDiscoveryKey,
    slashCommandsSyncedAt,
  ]);

  useEffect(() => {
    if (isSlashMenuOpen || slashCommandsLoading) return;
    slashCommandsDiscoveryKeyRef.current = "";
    slashCommandsRequestModeRef.current = null;
  }, [isSlashMenuOpen, slashCommandsLoading]);

  useEffect(() => {
    setSlashSelectedIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (!slashCommands.length) {
      setSlashSelectedIndex(0);
      return;
    }
    if (slashSelectedIndex >= slashCommands.length) {
      setSlashSelectedIndex(0);
    }
  }, [slashSelectedIndex, slashCommands.length]);

  const applySlashCommand = useCallback((command: ClaudeSlashCommand) => {
    const leadingWhitespace = input.match(/^\s*/)?.[0] ?? "";
    const existingArgs = slashMatch?.[2] ? ` ${slashMatch[2]}` : "";
    const nextValue = `${leadingWhitespace}${command.command}${
      existingArgs || (commandAcceptsArguments(command.usage) ? " " : "")
    }`;
    setInput(nextValue);
    setSlashSelectedIndex(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextValue.length, nextValue.length);
    });
  }, [input, slashMatch]);

  // Clear conversation
  const handleClear = useCallback(async () => {
    if (!confirm("Clear conversation history? This cannot be undone.")) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      await supabase
        .from("claude_code_cli_messages")
        .delete()
        .eq("user_id", user.id)
        .eq("claude_code_agent_id", agentId);

      await supabase
        .from("claude_code_cli_threads")
        .update({ claude_session_id: null, updated_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .eq("claude_code_agent_id", agentId);

      setMessages([]);
      setCliSessionId(null);
      setTimeoutRetrySessionId(null);
      timeoutRetryAttemptedRef.current = false;
    } catch (e) {
      console.error("[ClaudeCliChatPanel] Error clearing:", e);
    }
  }, [agentId, supabase]);

  const runPrompt = useCallback(
    async (promptRaw: string, opts?: { clearInput?: boolean; errorPrefix?: string }) => {
      if (sending || !config) return false;

      const prompt = promptRaw.trim();
      if (!prompt) return false;

      const localSlashMatch = prompt.match(/^\/([a-zA-Z0-9_-]+)(?:\s|$)/);
      const localCommand = localSlashMatch ? localSlashMatch[1].toLowerCase() : "";

      if (localCommand === "clear" || localCommand === "reset" || localCommand === "new") {
        if (opts?.clearInput) setInput("");
        void handleClear();
        return true;
      }
      if (localCommand === "copy") {
        if (opts?.clearInput) setInput("");
        const latestAssistant = [...messages].reverse().find((msg) => msg.role === "assistant");
        const textToCopy = latestAssistant?.content?.trim() || "";
        if (!textToCopy) {
          setError("No assistant response is available to copy yet.");
          return true;
        }
        try {
          await navigator.clipboard.writeText(textToCopy);
          setError(null);
        } catch {
          setError("Unable to copy the latest response from this browser.");
        }
        return true;
      }
      if (localCommand === "status") {
        if (opts?.clearInput) setInput("");
        const lastReportedModel =
          [...messages].reverse().find((msg) => msg.role === "assistant" && msg.model)?.model || null;
        const statusMsg: Message = {
          id: `msg-${Date.now()}-status`,
          role: "assistant",
          content: [
            "**Code session status:**",
            "",
            `- Provider: ${codeCliProvider === "codex" ? "Codex" : "Claude Code"}`,
            `- Connector: ${isConnectorOnline ? "online" : "offline"}`,
            `- Workspace: ${config.rootPath || "not configured"}`,
            `- CLI session: ${cliSessionId ? cliSessionId : "not started"}`,
            `- Last connector-reported model: ${lastReportedModel || "not reported yet"}`,
          ].join("\n"),
          createdAt: new Date(),
        };
        setMessages((prev) => [...prev, statusMsg]);
        return true;
      }
      if ((localCommand === "exit" || localCommand === "quit") && codeCliProvider === "codex") {
        if (opts?.clearInput) setInput("");
        if (onBack) {
          onBack();
        } else {
          setError("This embedded panel cannot exit the surrounding page.");
        }
        return true;
      }
      if (localCommand === "help") {
        if (opts?.clearInput) setInput("");
        const cliCommands = availableSlashCommands.filter(
          (c) => !["/clear", "/new", "/copy", "/status", "/help"].includes(c.command)
        );
        const providerLabel = codeCliProvider === "codex" ? "Codex" : "Claude";
        const helpMsg: Message = {
          id: `msg-${Date.now()}-help`,
          role: "assistant",
          content: [
            "**Available commands:**",
            "",
            "**Local (handled in panel):**",
            "- `/clear` — Clear conversation and start a new session",
            "- `/new` — Clear conversation and start a new session",
            "- `/copy` — Copy the latest assistant response",
            "- `/status` — Show connector and session status",
            "- `/help` — Show available commands",
            "",
            codeCliProvider === "codex"
              ? "**Codex CLI commands from official docs:**"
              : "**Claude headless commands:**",
            cliCommands.length > 0
              ? cliCommands
                  .map((c) => `- \`${c.command}\` — ${c.summary}`)
                  .join("\n")
              : "_(syncing...)_",
            ...(codeCliProvider === "codex"
              ? [
                  "",
                  `Note: Flow sends ${providerLabel} commands to the connector. Commands with Codex headless CLI equivalents run there directly.`,
                ]
              : []),
          ].join("\n"),
          createdAt: new Date(),
        };
        setMessages((prev) => [...prev, helpMsg]);
        return true;
      }

      if (!embedded && !isConnectorOnline) {
        setError(
          "Configured device is offline. Start the connector for this device, or recreate this code agent with the currently connected device."
        );
        return false;
      }

      timeoutRetryAttemptedRef.current = false;
      setTimeoutRetrySessionId(null);

      const userMsg: Message = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "user",
        content: prompt,
        createdAt: new Date(),
      };

      let persistedUserMessageId: string | null = null;
      persistedUserMessageId = await persistMessage(userMsg);
      const displayUserMsg = persistedUserMessageId
        ? { ...userMsg, id: persistedUserMessageId }
        : userMsg;

      if (opts?.clearInput) setInput("");
      setSending(true);
      setError(null);
      setStreamingContent("");
      streamingContentRef.current = "";
      setActiveTools([]);
      setMessages((prev) =>
        prev.some((msg) => msg.id === displayUserMsg.id) ? prev : [...prev, displayUserMsg]
      );

      try {
        const latestThreadSession = await loadLatestThreadSessionId();
        const sessionIdForRun = latestThreadSession.loaded
          ? latestThreadSession.sessionId
          : cliSessionId;
        const effectivePrompt =
          handshake?.handshakeId && handshake.selfSessionId
            ? buildCodePanelHandshakePrompt(prompt, {
                ...handshake,
                selfName: handshake.selfName || agentName || "Code agent",
              })
            : prompt;
        const runStarted = await startClaudeRunRequest({
          prompt: effectivePrompt,
          sessionId: sessionIdForRun,
          baselineMessageCount: messages.length,
        });
        if (!runStarted) {
          await deletePersistedMessage(persistedUserMessageId);
          setMessages((prev) => prev.filter((msg) => msg.id !== displayUserMsg.id));
          if (opts?.clearInput) {
            setInput((current) => current || prompt);
          }
          return false;
        }
        return true;
      } catch (e) {
        console.log("[ClaudeCliChat] runPrompt error:", e);
        clearInflight();
        setSending(false);
        setTimeoutRetrySessionId(null);
        await deletePersistedMessage(persistedUserMessageId);
        setMessages((prev) => prev.filter((msg) => msg.id !== displayUserMsg.id));
        if (opts?.clearInput) {
          setInput((current) => current || prompt);
        }
        setError(e instanceof Error ? e.message : opts?.errorPrefix || "Failed to send message");
        return false;
      }
    },
    [
      sending,
      config,
      isConnectorOnline,
      handleClear,
      onBack,
      availableSlashCommands,
      codeCliProvider,
      persistMessage,
      deletePersistedMessage,
      loadLatestThreadSessionId,
      startClaudeRunRequest,
      cliSessionId,
      messages,
      clearInflight,
      handshake,
      agentName,
      embedded,
    ]
  );

  // Send message
  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    await runPrompt(input.trim(), { clearInput: true, errorPrefix: "Failed to send message" });
  }, [input, runPrompt]);

  const handleStop = useCallback(() => {
    const requestId = currentRequestIdRef.current;
    if (!requestId) return;

    sendRunCancel(requestId);

    // Always add a stopped message so the user sees feedback
    const partial = streamingContentRef.current;
    const msg = createAssistantMessage({
      content: partial || undefined,
      errorMessage: "Task stopped by user.",
    });
    setMessages((prev) => [...prev, msg]);

    if (requestTimeoutRef.current) {
      clearTimeout(requestTimeoutRef.current);
      requestTimeoutRef.current = null;
    }
    currentRequestIdRef.current = null;
    timeoutRetryAttemptedRef.current = true;
    setTimeoutRetrySessionId(null);
    clearInflight();
    setSending(false);
    setStreamingContent("");
    streamingContentRef.current = "";
    setActiveTools([]);
    setError(null);
  }, [clearInflight, sendRunCancel]);

  useEffect(() => {
    if (!queuedPrompt?.id || !queuedPrompt.content) return;
    if (lastHandledQueuedPromptIdRef.current === queuedPrompt.id) return;
    if (sending || !config || (!embedded && !isConnectorOnline)) return;

    lastHandledQueuedPromptIdRef.current = queuedPrompt.id;
    void runPrompt(queuedPrompt.content, { errorPrefix: "Failed to execute plan" }).then((ok) => {
      if (ok) {
        onQueuedPromptHandled?.(queuedPrompt.id);
        return;
      }
      lastHandledQueuedPromptIdRef.current = null;
    });
  }, [queuedPrompt, sending, config, embedded, isConnectorOnline, runPrompt, onQueuedPromptHandled]);

  // Handle Enter key
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isSlashMenuOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        setInput("");
        setSlashSelectedIndex(0);
        return;
      }
      if (slashCommands.length === 0) {
        if (e.key === "Tab") {
          e.preventDefault();
          return;
        }
      }
      if (e.key === "ArrowDown") {
        if (slashCommands.length === 0) return;
        e.preventDefault();
        setSlashSelectedIndex((current) => Math.min(current + 1, slashCommands.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        if (slashCommands.length === 0) return;
        e.preventDefault();
        setSlashSelectedIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (activeSlashCommand) applySlashCommand(activeSlashCommand);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && activeSlashCommand) {
        const exactSlashMatch = activeSlashCommand.command.slice(1).toLowerCase() === slashQuery.toLowerCase();
        if (slashQuery && !slashHasArgs && !exactSlashMatch) {
          e.preventDefault();
          applySlashCommand(activeSlashCommand);
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const isMobile = window.matchMedia("(pointer: coarse)").matches;
      if (!isMobile) {
        e.preventDefault();
        handleSend();
      }
    }
  }, [activeSlashCommand, applySlashCommand, handleSend, isSlashMenuOpen, slashCommands.length, slashHasArgs, slashQuery]);

  // Loading state
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4">
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin mb-3" />
        <p className="text-sm text-zinc-400">Loading code session...</p>
      </div>
    );
  }

  // Error state
  if (!config) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-4">
        <AlertTriangle className="w-8 h-8 text-amber-400 mb-3" />
        <p className="text-sm text-zinc-300 mb-1">Session not configured</p>
        <p className="text-xs text-zinc-500">{error || "Please set up a workspace for this code session."}</p>
      </div>
    );
  }

  const canUseInput = !sending && (embedded || isConnectorOnline);
  const canSendInput = !!input.trim() && !sending && (embedded || isConnectorOnline);
  const promptPlaceholder =
    isConnectorOnline || embedded
      ? `Ask ${codeCliProvider === "codex" ? "Codex" : "Claude Code"}... (\`/\` for commands)`
      : showConnectorWarning
        ? "Connector offline..."
        : "Checking connector...";
  const emptyStateHint =
    isConnectorOnline || embedded
      ? "Send a message to start coding"
      : relay.status !== "ready"
        ? "Connect the Groovy Connector to start"
        : "Configured device is offline";

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-col">
      {/* Header */}
      {!embedded && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 bg-zinc-900/50">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-white truncate">
                {agentName || "Code Session"}
              </h3>
              <span className={`shrink-0 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                codeCliProvider === "codex"
                  ? "bg-green-500/20 text-green-400"
                  : "bg-orange-500/20 text-orange-400"
              }`}>
                {codeCliProvider === "codex" ? "Codex" : "Claude"}
              </span>
            </div>
            {config.rootPath && (
              <div className="flex items-center gap-1 text-xs text-zinc-500 truncate">
                <FolderOpen className="w-3 h-3 shrink-0" />
                <span className="truncate">{config.rootPath}</span>
              </div>
            )}
          </div>
          {onPlans && (
            <button
              onClick={onPlans}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-cyan-400 hover:bg-cyan-500/10 transition-colors"
              title="Browse plans"
            >
              <FileText className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={handleClear}
            disabled={messages.length === 0}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 disabled:hover:text-zinc-500 disabled:hover:bg-transparent transition-colors"
            title="Clear conversation"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}

      <ActiveCapabilitiesPanel
        agentId={agentId}
        target={codeCliProvider}
        deviceId={config.deviceId}
        autoPreflight={isConnectorOnline}
      />

      {/* Messages */}
      <div ref={messagesScrollRef} className="flex-1 overflow-y-auto p-3 space-y-4">
        {loadingMessages ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 text-zinc-500 animate-spin" />
          </div>
        ) : messages.length === 0 && !streamingContent ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-zinc-500 text-sm mb-2">No messages yet</div>
            <div className="text-zinc-600 text-xs">
              {emptyStateHint}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] min-w-0 rounded-xl px-3 py-2 overflow-hidden ${
                  msg.role === "user"
                    ? "bg-cyan-500/20 text-cyan-50"
                    : "bg-zinc-800 text-zinc-200"
                }`}>
                  <FormattedMessageContent
                    content={msg.content}
                    className="text-sm space-y-2"
                    textClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                  />
                  
                  {/* Diff cards for assistant messages */}
                  {msg.role === "assistant" && msg.diffs && msg.diffs.length > 0 && (
                    <DiffCardList diffs={msg.diffs} />
                  )}

                  {/* Connector-reported run metadata for assistant messages */}
                  {msg.role === "assistant" && (msg.model || msg.costUsd || msg.durationMs) && (
                    <div className="mt-2 pt-2 border-t border-white/10 flex items-center gap-3 text-[10px] text-zinc-500">
                      {msg.model && <span title="Connector-reported model">{msg.model}</span>}
                      {msg.durationMs && <span>{(msg.durationMs / 1000).toFixed(1)}s</span>}
                      {msg.costUsd && <span>${msg.costUsd.toFixed(4)}</span>}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Rich working container — tool activity + thinking */}
            {(streamingContent || sending) && (
              <div className="flex justify-start">
                <div className="flex max-h-80 w-full max-w-[92%] min-w-0 flex-col overflow-hidden rounded-xl border border-cyan-500/20 bg-zinc-950/80 [overflow-anchor:none]">
                  {/* Header */}
                  <div className="flex shrink-0 items-center gap-2 border-b border-white/5 bg-cyan-500/5 px-3 py-2">
                    <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin shrink-0" />
                    <span className="text-xs font-medium text-cyan-400">Working...</span>
                  </div>

                  {/* Tool Activity */}
                  {activeTools.length > 0 && (
                    <div className="min-h-0 shrink-0 border-b border-white/5 px-3 py-2">
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Tool Activity</div>
                      <div ref={toolActivityScrollRef} className="max-h-28 space-y-2 overflow-y-auto pr-1">
                        {activeTools.map((tool) => {
                          const Icon = tool.toolName === "Bash" ? Terminal
                            : tool.toolName === "Read" ? FileText
                            : tool.toolName === "Edit" ? Pencil
                            : tool.toolName === "Write" ? FileText
                            : tool.toolName === "Grep" || tool.toolName === "Glob" ? Search
                            : tool.toolName === "Task" ? Brain
                            : Terminal;
                          const isCommandLike =
                            tool.toolName === "Bash" ||
                            tool.summary.startsWith("$ ") ||
                            tool.summary.includes("\n$ ");
                          return (
                            <div
                              key={tool.id}
                              className="rounded-lg border border-white/5 bg-black/20 px-2.5 py-2"
                            >
                              <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                                <Icon className="w-3 h-3 shrink-0 text-zinc-500" />
                                <span className="font-medium text-zinc-300">{tool.toolName}</span>
                              </div>
                              {tool.summary && (
                                <div
                                  className={`mt-1.5 break-words overflow-hidden ${
                                    isCommandLike
                                      ? "font-mono text-[11px] text-cyan-200/85 whitespace-pre-wrap"
                                      : "text-[11px] text-zinc-500 whitespace-pre-wrap"
                                  }`}
                                  style={{ overflowWrap: "anywhere" }}
                                >
                                  {tool.summary}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Thinking text */}
                  {streamingContent && (
                    <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
                      <div className="shrink-0 text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Thinking</div>
                      <div ref={thinkingScrollRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
                        <FormattedMessageContent
                          content={streamingContent}
                          className="text-xs text-zinc-400 space-y-2"
                          textClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-2 bg-red-500/10 border-t border-red-500/20">
          <div className="flex items-center gap-2 text-xs text-red-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
            {timeoutRetrySessionId && !sending && (
              <button
                onClick={() => void handleTimeoutContinue(timeoutRetrySessionId)}
                className="ml-auto text-red-300/80 hover:text-red-200"
              >
                Continue
              </button>
            )}
            <button
              onClick={() => setError(null)}
              className={`${timeoutRetrySessionId && !sending ? "" : "ml-auto "}text-red-400/70 hover:text-red-400`}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Connector status warning */}
      {!embedded && showConnectorWarning && !isConnectorOnline && (
        <div className="px-3 py-2 bg-amber-500/10 border-t border-amber-500/20">
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>
              {relayStatus !== "ready"
                ? "Connector not connected. Start the Groovy Connector to send messages."
                : "Configured device is offline. Start the connector for this device, or recreate this code agent with the currently connected device."}
            </span>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="min-w-0 border-t border-white/10 bg-zinc-900/50 p-3">
        <div className="flex min-w-0 items-end gap-2">
          {/* Plan mode toggle */}
          <button
            onClick={() => setPlanMode(!planMode)}
            className={`p-2.5 rounded-xl transition-colors shrink-0 ${
              planMode
                ? "bg-violet-500/20 text-violet-400 border border-violet-500/30"
                : "bg-white/5 text-zinc-500 hover:text-zinc-300 hover:bg-white/10"
            }`}
            title={
              planMode
                ? codeCliProvider === "codex"
                  ? "Plan mode enabled - Codex will create a plan without coding"
                  : "Plan mode enabled - Claude will plan before coding"
                : "Enable plan mode"
            }
          >
            <ListChecks className="w-5 h-5" />
          </button>
          <div className="relative min-w-0 flex-1">
            {isSlashMenuOpen && (
              <div className="absolute inset-x-0 bottom-full z-20 mb-1 overflow-hidden rounded-lg border border-white/10 bg-zinc-950/95 shadow-2xl backdrop-blur">
                {/* Compact header */}
                <div className="flex items-center gap-2 border-b border-white/[0.06] px-2.5 py-1.5">
                  <span className="text-[11px] font-medium text-zinc-400">
                    {slashCommandsLoading && runtimeSlashCommandNames === null
                      ? "Syncing commands..."
                      : slashCommands.length > 0
                        ? `${slashCommands.length} command${slashCommands.length === 1 ? "" : "s"}`
                        : "No matches"}
                  </span>
                  {slashCommandsLoading && <Loader2 className="h-3 w-3 animate-spin text-cyan-400" />}
                  <div className="flex-1" />
                  {slashCommandsSource === "runtime" && (
                    <span className="text-[10px] text-zinc-600">live</span>
                  )}
                  {slashCommandsSource === "docs" && (
                    <span className="text-[10px] text-zinc-600">docs</span>
                  )}
                  {codeCliProvider !== "codex" && (
                    <button
                      type="button"
                      onClick={() => void requestLiveSlashCommands(true)}
                      disabled={!isConnectorOnline || slashCommandsLoading}
                      className="rounded p-0.5 text-zinc-500 transition hover:text-white disabled:opacity-40"
                      title="Refresh"
                    >
                      <RefreshCw className={`h-3 w-3 ${slashCommandsLoading ? "animate-spin" : ""}`} />
                    </button>
                  )}
                </div>
                {slashCommandsError && (
                  <div className="border-b border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
                    {slashCommandsError}
                  </div>
                )}
                {/* Command list */}
                <div className="max-h-[min(20rem,50vh)] overflow-y-auto py-1">
                  {slashCommands.length === 0 ? (
                    <div className="px-3 py-4 text-center text-xs text-zinc-500">
                      {slashCommandsLoading && runtimeSlashCommandNames === null
                        ? `Syncing supported ${codeCliProvider === "codex" ? "Codex" : "Claude"} commands...`
                        : "No matching commands"}
                    </div>
                  ) : (
                    slashCommands.map((command, index) => {
                      const isActive = index === slashSelectedIndex;
                      const tooltipText = [
                        command.command,
                        command.usage !== command.command ? command.usage : "",
                        command.summary,
                      ]
                        .filter(Boolean)
                        .join("\n");
                      return (
                        <button
                          key={`${command.kind}:${command.command}`}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => applySlashCommand(command)}
                          title={tooltipText}
                          className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left transition-colors ${
                            isActive
                              ? "bg-cyan-500/15 text-white"
                              : "text-zinc-300 hover:bg-white/[0.06]"
                          }`}
                        >
                          <span className="shrink-0 font-mono text-[13px] text-cyan-300">
                            {command.command}
                          </span>
                          <span className="min-w-0 truncate text-[11px] text-zinc-500">
                            {command.summary}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
                {/* Footer hints */}
                <div className="flex items-center gap-3 border-t border-white/[0.06] px-2.5 py-1 text-[10px] text-zinc-600">
                  <span className="hidden sm:inline"><kbd className="font-mono text-zinc-500">Tab</kbd> complete</span>
                  <span className="hidden sm:inline"><kbd className="font-mono text-zinc-500">↑↓</kbd> navigate</span>
                  <span className="hidden sm:inline"><kbd className="font-mono text-zinc-500">Esc</kbd> close</span>
                  <span className="sm:hidden">Tap to select</span>
                </div>
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              wrap="soft"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={promptPlaceholder}
              disabled={!canUseInput}
              rows={1}
              className="block min-h-11 max-h-[120px] w-full max-w-full resize-none overflow-x-hidden whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm leading-5 text-white outline-none [overflow-wrap:anywhere] placeholder-zinc-500 focus:border-cyan-500/50 disabled:opacity-50"
            />
          </div>
          {sending ? (
            <button
              onClick={handleStop}
              className="p-2.5 rounded-xl bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors shrink-0"
              title="Stop task"
            >
              <Square className="w-5 h-5" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSendInput}
              className="p-2.5 rounded-xl bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-50 disabled:hover:bg-cyan-500/20 transition-colors shrink-0"
            >
              <Send className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
