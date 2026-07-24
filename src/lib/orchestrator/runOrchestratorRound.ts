import { streamText, stepCountIs, type ModelMessage } from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveChatModel,
  type ProviderId,
  getAnthropicContextProviderOptions,
  getModelContextBudget,
  getOrchestratorAgentSdkFallbackModel,
} from "@/lib/ai/modelResolver";
import { resolveKeys, buildToolApiKeys } from "@/lib/keys/resolveKeyMode";
import { resolveOrchestratorModelOverride } from "@/lib/orchestrator/orchestratorModel";
import { buildOrchestratorRuntimeIdentityPrompt } from "@/lib/orchestrator/runtimeIdentity";
import { scheduleAfterResponse } from "@/lib/runtime/afterResponse";
import { listWorkerAgents } from "@/lib/orchestrator/agentTasks";
import { parseInput, getToolsForRouting, type AgentType } from "@/lib/orchestrator/router";
import { createExecutableTools } from "@/lib/orchestrator/executableTools";
import { getProductAccessForUser } from "@/lib/licensing/access";
import { runAgentSdkOrchestrator } from "@/lib/orchestrator/agentSdkRuntime";
import {
  getGroovyMemoryConnection,
  formatDurableLearningConfirmation,
  maybeStoreConversation,
  storeDurableLearning,
} from "@/lib/memory/groovyMemory";
import {
  maybeCompactMessages,
  modelMessageToCompactable,
  compactableToModelMessage,
} from "@/lib/orchestrator/compaction";
import { buildDurableContextHistory } from "@/lib/orchestrator/durableContext";
import { reconcileCurrentUserMessage } from "@/lib/orchestrator/durableContextMerge";
import type { ToolExecutionContext } from "@/lib/orchestrator/toolExecutor";
import { resolveHarnessProfile, type HarnessProfile } from "@/lib/orchestrator/harnessProfiles";
import {
  buildOrchestratorPrompt,
} from "@/lib/orchestrator/promptKernel";
import { buildChannelInstructionPromptBlock } from "@/lib/teamChat";
import {
  buildToolPolicyExecutionContext,
  filterAgentRoster,
  isToolAllowed,
} from "@/lib/orchestrator/toolPolicy";
import {
  getOrCreateWorkspaceIdForUser,
  getWorkspaceCapabilityOwnerUserId,
  isChannelGuestUser,
} from "@/lib/billing/workspace";
import {
  insertBillingToolEventsBestEffort,
  insertBillingUsageEventBestEffort,
} from "@/lib/billing/events";
import { estimateTokensFromCostUsd, normalizeTokenUsage } from "@/lib/billing/usage";
import { preflightGroovyUsage, settleGroovyUsageDebitBestEffort } from "@/lib/billing/guard";
import {
  usageChargeTypeForKeyMode,
} from "@/lib/billing/pricing";
import type { ConnectorClientPlatform } from "@/lib/connector/platform";
import { createHash } from "crypto";
import {
  loadBranchControllerSettings,
  type BranchControllerSettings,
} from "@/lib/orchestrator/branchController";
import {
  resolveRuntimeScope,
  type RuntimeScope,
} from "@/lib/orchestrator/runtimeGraph";
import { loadActiveSkillRuntimeTools } from "@/lib/orchestrator/skillsRuntime";
import {
  buildExtensionCatalogPromptBlock,
  buildExtensionPromptBlock,
  listExtensionsForUser,
  loadInstalledExtensionRuntimeTools,
  selectRelevantExtensionRuntimeTools,
} from "@/lib/extensions/registry";
import {
  buildAssignedSkillsPromptContextForUser,
  preflightAgentSkillsForUser,
} from "@/lib/skills-manager/service";
import {
  addAnthropicNativeWebSearchTool,
  getAnthropicAgentSdkBuiltinTools,
  isAnthropicNativeWebSearchEnabled,
  isWebSearchToolName,
} from "@/lib/orchestrator/anthropicWebSearch";

export type ConnectorExecute = {
  toolCallId: string;
  toolName: string;
  agent: string;
  connectorType: string;
  connectorParams: Record<string, unknown>;
  message?: string;
};

export type UiOpenCode = {
  toolCallId: string;
  toolName: string;
  agentId?: string;
  name?: string;
  requestedName?: string;
};

export type BrowserTask = {
  toolCallId: string;
  toolName: string;
  task: string;
  startUrl?: string;
  message?: string;
};

export type GeneratedFileRef = {
  name: string;
  mediaType: string;
  url?: string;
  storage_path?: string;
  file_id?: string;
  filename?: string;
  mime_type?: string;
};

export type OrchestratorRoundResult =
  | {
      kind: "final";
      traceId: string;
      text: string;
      toolOutputText?: string;
      files?: Array<{ mediaType: string; base64: string; filename?: string | null }>;
      generatedFiles?: GeneratedFileRef[];
      toolCallsExecuted: string[];
    }
  | {
      kind: "needs_connector";
      traceId: string;
      partialText: string;
      toolCallsExecuted: string[];
      connectorExecutes: ConnectorExecute[];
    }
  | {
      kind: "ui_open_code";
      traceId: string;
      partialText: string;
      toolCallsExecuted: string[];
      uiOpenCode: UiOpenCode;
    }
  | {
      kind: "browser_task";
      traceId: string;
      partialText: string;
      toolCallsExecuted: string[];
      browserTask: BrowserTask;
    };

type ToolResultInput = {
  toolCallId: string;
  toolName: string;
  result: string;
};

export type FileInput = {
  mediaType: string;
  base64: string;
  filename?: string | null;
};

export type FilesAgentSession = {
  agentId: string;
  sessionId: string;
};

export type RunOrchestratorRoundArgs = {
  supabase: SupabaseClient;
  userId: string;
  userEmail?: string | null;
  // Stable id for one user "turn" (UI send / WhatsApp message) across connector round-trips
  turnId?: string;
  /**
   * Base URL (origin) for internal API calls (e.g. http://localhost:3001).
   * Keeps behavior consistent with the dashboard orchestrator route.
   */
  appBaseUrl?: string;
  // For connector tools (browser/files/obsidian)
  deviceId?: string | null;
  // Optional originating Aiyra conversation id when the turn came from a live runtime.
  sourceConversationId?: string | null;
  connectorPlatform?: ConnectorClientPlatform;
  obsidianVaultPath?: string | null;
  // Code mode (WhatsApp @code relay)
  codeMode?: boolean;
  codeTerminalId?: string | null;
  codeWorkspaceRootPath?: string | null;
  // Persisted session history (already includes latest user message if any)
  history: ModelMessage[];
  // Agent runtime scope (agent-centric ownership for schedules/messages/compaction telemetry)
  orchestratorAgentId?: string | null;
  orchestratorSessionId?: string | null;
  modelOverride?: {
    provider: "anthropic" | "openai";
    model: string;
    reasoningEffort: string | null;
  } | null;
  /**
   * Harness profile ("Mind") for this turn — controls the identity block of
   * the system prompt (and, once resolution lands, model/tool policy/roster).
   * null/undefined = built-in Groovy default, byte-identical to pre-profile
   * behavior.
   */
  profile?: HarnessProfile | null;
  /** Surface/provider that originated this turn (dashboard, team_chat, api, …). */
  sourceProvider?: string;
  /** Stable external thread key used to enforce the thread's sticky Mind binding. */
  sourceThreadKey?: string | null;
  /**
   * Optional durable-memory namespace narrower than the selected profile.
   * Public API threads use this to prevent memory from crossing customer
   * conversations while keeping the profile as the capability boundary.
   */
  memoryScopeId?: string | null;
  /**
   * Additive channel-scoped skill or instruction artifacts. Callers must
   * enforce their own participant trust boundary before providing these ids;
   * artifact workspace, lifecycle, and target are revalidated during loading.
   */
  additionalSkillArtifactIds?: string[];
  /**
   * Optional workspace-authored operating brief for a Team Chat channel.
   * Prompt context cannot widen the resolved profile or executor tool policy.
   */
  channelInstructions?: string | null;
  /**
   * Authoritative, freshly resolved channel participants for this turn.
   * Historical summaries never supply membership or authorization state.
   */
  channelParticipantContext?: string | null;
  // Notification targets + channel recorded on agent tasks created this turn
  // (assign_task) so the task runner can ping the requesting channel.
  taskNotifyTargets?: import("@/lib/orchestrator/agentTasks").AgentTaskNotifyTargets;
  taskRequestedChannel?: string | null;
  /**
   * Optional caller-enforced worker roster. Team Chat passes the channel's
   * selected agent ids so the Mind cannot discover or delegate to any other
   * workspace worker.
   */
  allowedAgentIds?: string[];
  /**
   * `replace` makes the caller roster authoritative instead of intersecting it
   * with the Mind default. Reserved for entry points such as Team Chat that
   * enforce their own durable, admin-managed roster.
   */
  agentRosterMode?: "intersect" | "replace";
  // Optional branch runtime stats for branch-controller enforcement.
  branchCurrentTurnCount?: number | null;
  branchActiveCount?: number | null;
  // Optional explicit settings override.
  branchControllerSettings?: BranchControllerSettings | null;
  // Optional explicit runtime scope override for hidden worker branches.
  runtimeScopeOverride?: RuntimeScope | null;
  branchRole?: "main" | "worker";
  branchGoal?: string | null;
  // If message is empty, routing will use last user message from history
  message: string;
  memoryEnabled?: boolean;
  // Tool results from connector execution
  toolResults?: ToolResultInput[];
  // Forward cookies when calling sub-agents (datagran/files-agent)
  cookies?: string;
  // A fixed trace id (optional) so multiple rounds share it
  traceId?: string;
  /** Optional caller-owned controller for real model/tool-loop cancellation. */
  abortController?: AbortController;
  // User's AI chat agents for delegation
  aiChatAgents?: Array<{ id: string; name: string; systemPrompt?: string }>;
  // Web pixel names (as shown in dashboard) so the model can choose the right pixelName
  // for provider="web_pixel" queries.
  webPixelNames?: string[];
  // Attached files (images, documents) from WhatsApp or other sources
  files?: FileInput[];
  // Linked Files agent session (enables files_agent_request tool)
  filesAgent?: FilesAgentSession | null;
  // Device token for server-side sub-agent auth in WhatsApp mode
  deviceToken?: string;
  // Telegram bot token for server-side Telegram tool execution
  telegramBotToken?: string;
  // Bypass directAgent detection (for scheduled jobs that contain schedule keywords but need all tools)
  bypassDirectAgent?: boolean;
  // Scheduled mode: allows automatic WhatsApp sends without confirmation (user pre-approved via schedule)
  scheduledMode?: boolean;
  // Optional per-round soft deadline for scheduled serverless runs.
  scheduledHardDeadlineAtMs?: number;
  // Optional per-task timeout override for slow data_query calls.
  scheduledDataQueryTimeoutMs?: number;
  // Connector local timezone (IANA), used for scheduled/date-sensitive jobs.
  localTimezone?: string;
  // Override the default step budget (number of tool-calling rounds).
  maxSteps?: number;
  // If false, stop at the configured tool step budget without reserving an extra
  // synthesis step for the model.
  allowSynthesisAfterTool?: boolean;
  // Optional tool progress stream for external callers (voice, polling routes, etc.).
  onToolStream?: (data: { toolName: string; text: string }) => void;
  onAssistantTextDelta?: (data: { text: string }) => void;
  onToolEvent?: (data: {
    phase: "start" | "end";
    toolName: string;
    agent?: string;
    success?: boolean;
    error?: string;
  }) => void;
};

function sanitizeMessages(input: ModelMessage[]): ModelMessage[] {
  return input
    .map((m) => {
      if (typeof m.content === "string") {
        const trimmed = m.content.trim();
        return trimmed ? { ...m, content: trimmed } : null;
      }
      if (Array.isArray(m.content)) {
        type TextPart = { type: "text"; text: string };
        type UnknownPart = Record<string, unknown>;
        const parts = m.content
          .map((p) => {
            const part = p as UnknownPart;
            if (part.type === "text" && typeof part.text === "string") {
              const t = part.text.trim();
              if (!t) return null;
              const next: TextPart = { type: "text", text: t };
              return next;
            }
            return p;
          })
          .filter((p): p is NonNullable<typeof p> => p != null);
        if (parts.length === 0) return null;
        return { ...m, content: parts as unknown as ModelMessage["content"] };
      }
      return m;
    })
    .filter(Boolean) as ModelMessage[];
}

function modelMessageTextForExtensionSelection(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const candidate =
        part && typeof part === "object" && !Array.isArray(part)
          ? (part as Record<string, unknown>)
          : null;
      return candidate?.type === "text" && typeof candidate.text === "string"
        ? candidate.text.trim()
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function buildExtensionSelectionRecentTexts(history: ModelMessage[]): string[] {
  return history
    .slice(-6)
    .map((message) => modelMessageTextForExtensionSelection(message.content))
    .filter(Boolean)
    .slice(-4);
}

function lastUserText(history: ModelMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user") continue;
    if (typeof m.content !== "string") continue;
    const t = m.content.trim();
    if (t) return t;
  }
  return "";
}

function explicitlyRequiresScheduledBrowser(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;

  const hasBrowserSection =
    /(?:^|\n)\s*(?:={1,3}\s*)?(?:step\s+\d+\s*[:.)—-]\s*)?(?:\*\*)?browser(?:\*\*)?\b/im.test(
      normalized
    );
  if (hasBrowserSection) return true;

  const explicitlyDisablesBrowser =
    /\b(?:do not|don't|never|without)\s+(?:use|using|open|launch)?\s*(?:the\s+)?browser\b/i.test(
      normalized
    );
  if (explicitlyDisablesBrowser) return false;

  return (
    /\b(?:browser agent|computer browser|interactive browser|browser automation)\b/i.test(
      normalized
    ) ||
    /\b(?:use|using|via|through|open|launch|navigate|access)\b[\s\S]{0,80}\bbrowser\b/i.test(
      normalized
    )
  );
}

function firstHttpUrl(text: string): string | undefined {
  const match = text.match(/\bhttps?:\/\/[^\s<>"')\]]+/i);
  return match?.[0]?.replace(/[.,;:!?]+$/, "") || undefined;
}

function buildScheduledBrowserPrerequisiteTask(task: string): string {
  return [
    "Complete the browser-dependent prerequisite in this scheduled task now using the interactive browser.",
    "Work only on browser actions and return concrete observations/data needed by later steps.",
    "Do not run database, filesystem, terminal, or messaging steps; the orchestrator will handle them after your result.",
    "Do not claim success or no results unless the website was actually opened and inspected.",
    "",
    "SCHEDULED TASK:",
    task,
  ].join("\n");
}

function isLikelySiteWorkflow(args: {
  routingText: string;
  history: ModelMessage[];
  toolResults: ToolResultInput[];
  directAgent: AgentType | null;
}): boolean {
  if (args.directAgent === "pages") return true;

  const historyUserText = args.history
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .slice(-4)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  const toolText = args.toolResults
    .map((tr) => `${tr.toolName}\n${typeof tr.result === "string" ? tr.result : ""}`)
    .join("\n");
  const corpus = `${args.routingText}\n${historyUserText}\n${toolText}`.toLowerCase();

  if (corpus.includes(".groovy/sites/")) return true;
  if (args.toolResults.some((tr) => tr.toolName.startsWith("site_"))) return true;

  const hasSiteNoun = /\b(site|website|web page|landing page)\b/i.test(corpus);
  const hasSiteAction = /\b(create|build|generate|edit|publish|deploy|preview)\b/i.test(corpus);
  const hasNextOrVercel = /\b(next\.?js|vercel)\b/i.test(corpus);

  return (hasSiteNoun && hasSiteAction) || (hasNextOrVercel && hasSiteNoun && hasSiteAction);
}

// Hard cap for individual tool results to prevent prompt explosion (target ~2k tokens per result)
const TOOL_RESULT_MAX_CHARS = 8000;

function toolResultsToUserMessage(toolResults: ToolResultInput[]): ModelMessage | null {
  const safe = (toolResults || []).filter(
    (tr) => typeof tr?.toolCallId === "string" && typeof tr?.toolName === "string" && typeof tr?.result === "string"
  );
  if (safe.length === 0) return null;

  type ParsedEntry = {
    toolName: string;
    parsed: Record<string, unknown> | null;
  };
  const parsedEntries: ParsedEntry[] = safe.map((tr) => {
    try {
      const parsed = JSON.parse(tr.result);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { toolName: tr.toolName, parsed: parsed as Record<string, unknown> };
      }
    } catch {
      // ignore parse failures
    }
    return { toolName: tr.toolName, parsed: null };
  });

  const looksLikeSiteWorkflow =
    safe.some((tr) => tr.toolName === "site_dev") ||
    safe.some((tr) => tr.toolName === "code_cli_run" && tr.result.includes(".groovy/sites/"));

  const siteDevStarted = parsedEntries.some(({ toolName, parsed }) => {
    if (toolName !== "site_dev" || !parsed) return false;
    const candidates: Array<Record<string, unknown>> = [parsed];
    const nested = parsed.result;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      candidates.push(nested as Record<string, unknown>);
    }
    return candidates.some((c) => c.ok === true && Number(c.port) > 0);
  });

  const codeCliWriteDetected = parsedEntries.some(({ toolName, parsed }) => {
    if (toolName !== "code_cli_run" || !parsed || parsed.ok !== true) return false;
    const diffs = Array.isArray(parsed.diffs) ? parsed.diffs : [];
    return diffs.length > 0;
  });

  const codeCliOnlyRound =
    safe.length > 0 && safe.every((tr) => tr.toolName === "code_cli_run");
  const terminalExecCount = safe.filter((tr) => tr.toolName === "terminal_exec").length;
  const terminalLoopDetected = looksLikeSiteWorkflow && terminalExecCount >= 2;

  const resultsText = safe
    .map((tr) => {
      try {
        const parsed = JSON.parse(tr.result);
        let text = JSON.stringify(parsed, null, 2);
        if (text.length > TOOL_RESULT_MAX_CHARS) {
          text = text.slice(0, TOOL_RESULT_MAX_CHARS) + "\n...[truncated]";
        }
        return `<tool_result name="${tr.toolName}" tool_call_id="${tr.toolCallId}">\n${text}\n</tool_result>`;
      } catch {
        let text = tr.result;
        if (text.length > TOOL_RESULT_MAX_CHARS) {
          text = text.slice(0, TOOL_RESULT_MAX_CHARS) + "\n...[truncated]";
        }
        return `<tool_result name="${tr.toolName}" tool_call_id="${tr.toolCallId}">\n${text}\n</tool_result>`;
      }
    })
    .join("\n\n");

  const siteDirective =
    looksLikeSiteWorkflow && siteDevStarted
      ? `\n\nCRITICAL NEXT ACTION:\n` +
        `- site_dev already started successfully.\n` +
        `- Do NOT call more tools.\n` +
        `- Return a final assistant response now.`
      : looksLikeSiteWorkflow && codeCliWriteDetected
        ? `\n\nCRITICAL NEXT ACTION:\n` +
          `- Code edits were already applied in the site workspace.\n` +
          `- Do NOT run verification loops.\n` +
          `- Do NOT call terminal_exec for ls/find/cat checks.\n` +
          `- Next step must be site_dev start (if preview not started) or final response.`
        : terminalLoopDetected
          ? `\n\nCRITICAL NEXT ACTION:\n` +
            `- You are looping with terminal_exec checks.\n` +
            `- Stop terminal verification loops now.\n` +
            `- Use code_cli_run for any remaining code work, then call site_dev.`
        : looksLikeSiteWorkflow && codeCliOnlyRound && safe.length >= 2
          ? `\n\nCRITICAL NEXT ACTION:\n` +
            `- You are repeating code_cli_run calls.\n` +
            `- Do one decisive scaffold/edit pass (no read-only loop), then proceed to site_dev/final.`
          : "";

  // Be explicit about what to do with the results to prevent re-calling tools unnecessarily
  return {
    role: "user",
    content:
      `[SYSTEM: Tool execution results from your previous request]\n\n${resultsText}\n\n` +
      `IMPORTANT: These are the results from the connector tools you requested. ` +
      `Do NOT call the same tool again unless the result indicates an error that can be retried. ` +
      `Process these results and either:\n` +
      `1. Provide the final answer to the user if you have enough information, OR\n` +
      `2. Call a DIFFERENT tool if you need additional information to complete the task.` +
      siteDirective,
  };
}

function parseJsonOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function extractSuccessfulSiteDevStart(toolResults?: ToolResultInput[]): {
  slug?: string;
  port: number;
} | null {
  if (!Array.isArray(toolResults) || toolResults.length === 0) return null;
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const tr = toolResults[i];
    if (!tr || tr.toolName !== "site_dev" || typeof tr.result !== "string") continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(tr.result);
    } catch {
      continue;
    }
    const candidates: Array<Record<string, unknown>> = [];
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      candidates.push(parsed as Record<string, unknown>);
      const inner = (parsed as Record<string, unknown>).result;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        candidates.push(inner as Record<string, unknown>);
      }
    }
    for (const c of candidates) {
      const ok = c.ok === true;
      const rawPort = c.port;
      const port =
        typeof rawPort === "number"
          ? rawPort
          : typeof rawPort === "string"
            ? Number(rawPort)
            : NaN;
      if (!ok || !Number.isFinite(port) || port <= 0) continue;
      const slug =
        typeof c.slug === "string" && c.slug.trim().length > 0
          ? c.slug.trim()
          : undefined;
      return { slug, port };
    }
  }
  return null;
}

function isInvalidApiKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  const status =
    typeof e.statusCode === "number"
      ? e.statusCode
      : typeof e.status === "number"
        ? e.status
        : null;
  if (status !== 401 && status !== 403) return false;

  const msg = typeof e.message === "string" ? e.message : "";
  const body = typeof e.responseBody === "string" ? e.responseBody : "";
  const combined = `${msg}\n${body}`.toLowerCase();

  if (combined.includes("invalid x-api-key")) return true;
  if (combined.includes("authentication_error") && combined.includes("api")) return true;
  if (combined.includes("incorrect api key")) return true;
  if (combined.includes("invalid api key")) return true;

  return false;
}

function isTransientApiError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  const status =
    typeof e.statusCode === "number"
      ? e.statusCode
      : typeof e.status === "number"
        ? e.status
        : null;
  if (status === 500 || status === 502 || status === 503 || status === 529) return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  const cause =
    "cause" in e
      ? e.cause instanceof Error
        ? e.cause.message.toLowerCase()
        : typeof e.cause === "string"
          ? e.cause.toLowerCase()
          : ""
      : "";
  const body = typeof e.responseBody === "string" ? e.responseBody.toLowerCase() : "";
  const combined = `${msg}\n${cause}\n${body}`;
  if (combined.includes("internal server error")) return true;
  if (combined.includes("api_error")) return true;
  if (combined.includes("overloaded")) return true;
  if (combined.includes("terminated")) return true;
  if (combined.includes("econnreset")) return true;
  if (combined.includes("socket hang up")) return true;
  if (combined.includes("connection reset")) return true;
  if (combined.includes("fetch failed")) return true;
  if (combined.includes("network")) return true;
  return false;
}

function hasServerProviderKey(provider: ProviderId): boolean {
  if (provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return !!process.env.OPENAI_API_KEY;
  return false;
}


export async function runOrchestratorRound(args: RunOrchestratorRoundArgs): Promise<OrchestratorRoundResult> {
  const {
    supabase,
    userId,
    userEmail,
    appBaseUrl,
    deviceId,
    obsidianVaultPath,
    history: historyRaw,
    message,
    memoryEnabled = true,
    toolResults,
    cookies,
    codeMode = false,
  } = args;

  const throwIfAborted = () => {
    if (args.abortController?.signal.aborted) {
      throw args.abortController.signal.reason instanceof Error
        ? args.abortController.signal.reason
        : new Error("orchestrator_run_aborted");
    }
  };
  throwIfAborted();

  if (
    await isChannelGuestUser({
      userId,
    }).catch(() => true)
  ) {
    return {
      kind: "final",
      traceId:
        typeof args.traceId === "string" && args.traceId
          ? args.traceId
          : `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text:
        "Channel guests can use Groovy only inside channels they were invited to.",
      toolCallsExecuted: [],
    };
  }

  const productAccess = await getProductAccessForUser({ userId }).catch(() => null);
  throwIfAborted();
  if (!productAccess?.hasAccess) {
    return {
      kind: "final",
      traceId:
        typeof args.traceId === "string" && args.traceId
          ? args.traceId
          : `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text:
        productAccess?.workspaceOwnerRequired
          ? "This workspace needs an active plan. Ask a workspace admin to activate Groovy."
          : productAccess?.accessStatus === "trial_available"
          ? "Start your free 5-day Groovy trial from the dashboard to continue. No credit card is required."
          : "Your Groovy trial has ended. Purchase a license from the dashboard to resume your orchestrator and agents.",
      toolCallsExecuted: [],
    };
  }

  let history = sanitizeMessages(historyRaw);
  const routingText = message.trim() ? message.trim() : lastUserText(history);
  const parsedRaw = parseInput(routingText);
  // Bypass directAgent detection for scheduled jobs (they need all tools despite schedule keywords in task)
  const parsed = codeMode
    ? { ...parsedRaw, directAgent: "code" as const, mentionedAgents: ["code" as const] }
    : args.bypassDirectAgent
      ? { ...parsedRaw, directAgent: null, mentionedAgents: [] }
      : parsedRaw;
  const safeToolResults = (toolResults || []).filter(
    (tr): tr is ToolResultInput =>
      typeof tr?.toolCallId === "string" &&
      typeof tr?.toolName === "string" &&
      typeof tr?.result === "string"
  );
  const scheduledBrowserPrerequisite =
    args.scheduledMode === true && explicitlyRequiresScheduledBrowser(routingText);
  const hasScheduledBrowserResult = safeToolResults.some(
    (result) => result.toolName === "browser_task"
  );
  const shouldDispatchScheduledBrowser =
    scheduledBrowserPrerequisite && !hasScheduledBrowserResult;
  const siteWorkflowMode = isLikelySiteWorkflow({
    routingText,
    history,
    toolResults: safeToolResults,
    directAgent: parsed.directAgent,
  });

  const traceId =
    typeof args.traceId === "string" && args.traceId
      ? args.traceId
      : `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Resolve the profile before any fast path, model selection, or tool
  // construction. A profile is a runtime security boundary, not merely a
  // system-prompt decoration.
  let harnessProfile: HarnessProfile | null = args.profile ?? null;
  if (args.profile === undefined) {
    let sessionProfileId: string | null = null;
    let threadProfileId: string | null = null;
    if (args.orchestratorSessionId) {
      const { data: sessionRow, error: sessionProfileError } = await supabase
        .from("orchestrator_sessions")
        .select("profile_id")
        .eq("id", args.orchestratorSessionId)
        .maybeSingle();
      if (sessionProfileError) throw new Error(sessionProfileError.message);
      sessionProfileId = (sessionRow?.profile_id as string | null) ?? null;
    }
    if (args.sourceProvider && args.sourceThreadKey) {
      const { data: threadRow, error: threadProfileError } = await supabase
        .from("orchestrator_external_threads")
        .select("profile_id")
        .eq("user_id", userId)
        .eq("provider", args.sourceProvider)
        .eq("thread_key", args.sourceThreadKey)
        .maybeSingle();
      if (threadProfileError) throw new Error(threadProfileError.message);
      threadProfileId = (threadRow?.profile_id as string | null) ?? null;
    }
    if (
      sessionProfileId &&
      threadProfileId &&
      sessionProfileId !== threadProfileId
    ) {
      throw new Error("The session and external thread have conflicting harness profiles.");
    }
    harnessProfile = await resolveHarnessProfile(supabase, {
      userId,
      sessionProfileId,
      provider: args.sourceProvider,
      threadKey: args.sourceThreadKey,
    });
    if ((sessionProfileId || threadProfileId) && !harnessProfile) {
      throw new Error("The harness profile bound to this session is unavailable.");
    }
    if (!sessionProfileId && harnessProfile && args.orchestratorSessionId) {
      const { error: bindProfileError } = await supabase
        .from("orchestrator_sessions")
        .update({ profile_id: harnessProfile.id })
        .eq("id", args.orchestratorSessionId)
        .is("profile_id", null);
      if (bindProfileError) throw new Error(bindProfileError.message);
    }
    if (
      !threadProfileId &&
      harnessProfile &&
      args.sourceProvider &&
      args.sourceThreadKey
    ) {
      const { error: bindThreadProfileError } = await supabase
        .from("orchestrator_external_threads")
        .update({ profile_id: harnessProfile.id })
        .eq("user_id", userId)
        .eq("provider", args.sourceProvider)
        .eq("thread_key", args.sourceThreadKey)
        .is("profile_id", null);
      if (bindThreadProfileError) throw new Error(bindThreadProfileError.message);
    }
  }
  const toolPolicy = buildToolPolicyExecutionContext({
    profile: harnessProfile,
    provider: args.sourceProvider || "orchestrator_round",
    memoryScopeId: args.memoryScopeId,
    allowedAgentIds: args.allowedAgentIds,
    agentRosterMode: args.agentRosterMode,
  });
  const memoryScopeId =
    toolPolicy.memoryScope === "profile"
      ? toolPolicy.memoryScopeId || undefined
      : undefined;

  // Loop-breaker: once local site preview has started successfully, finalize the round.
  // This prevents repetitive read/verify tool-call loops after site_dev start.
  if (!message.trim()) {
    const started = extractSuccessfulSiteDevStart(toolResults);
    if (started) {
      const scope = started.slug ? ` for "${started.slug}"` : "";
      return {
        kind: "final",
        traceId,
        text:
          `Local preview is running${scope} on port ${started.port}. ` +
          `I’m done with this step—tell me what to change next, or ask me to publish.`,
        toolCallsExecuted: [],
      };
    }
  }

  // Explicit remember commands bypass the main model but still use hybrid
  // Datagran + Wiki storage.
  if (
    parsed.isRememberCommand &&
    parsed.rememberContent &&
    isToolAllowed("remember", toolPolicy)
  ) {
    const connectionId = await getGroovyMemoryConnection(
      userId,
      userEmail || undefined,
      supabase,
      memoryScopeId,
    );
    const stored = await storeDurableLearning(
      connectionId || "",
      parsed.rememberContent,
      undefined,
      {
        wiki: {
          supabase,
          userId,
          source: "explicit remember command",
          profileId:
            memoryScopeId,
        },
      }
    );
    return {
      kind: "final",
      traceId,
      text: formatDurableLearningConfirmation(parsed.rememberContent, stored),
      toolCallsExecuted: [],
    };
  }

  // Resolve per-provider key modes and decrypt user keys
  const resolved = await resolveKeys(userId, supabase, cookies);
  const requestedModelOverride = harnessProfile?.model || args.modelOverride || null;
  // User-selected orchestrator "brain" model (stored on the orchestrator-runtime
  // agents row) overrides the env-resolved default when configured. A harness
  // profile's explicit brain remains authoritative over entry-point overrides.
  const orchestratorModelOverride = await resolveOrchestratorModelOverride({
    supabase,
    userId,
    agentId: args.orchestratorAgentId || null,
    resolved,
    selectionOverride: requestedModelOverride
      ? {
          provider: requestedModelOverride.provider,
          model: requestedModelOverride.model,
          reasoningEffort: requestedModelOverride.reasoningEffort,
        }
      : undefined,
  });
  if (requestedModelOverride && !orchestratorModelOverride) {
    return {
      kind: "final",
      traceId,
      text: `The configured model ${requestedModelOverride.model} cannot run because its ${requestedModelOverride.provider} API key is not configured for the current key mode. Update Settings or choose a different profile model.`,
      toolCallsExecuted: [],
    };
  }
  const mainProvider = orchestratorModelOverride?.provider ?? resolved.provider;
  const provider: ProviderId = mainProvider;
  const modelName = orchestratorModelOverride?.modelName ?? resolved.modelName;
  const apiKey = orchestratorModelOverride
    ? orchestratorModelOverride.apiKey
    : resolved.apiKey;
  const mainKeyMode = resolved.keyModes[mainProvider] || resolved.globalMode;

  if (!apiKey && mainKeyMode === "user") {
    return {
      kind: "final",
      traceId,
      text: "No API key configured. Add your model provider key in Settings.",
      toolCallsExecuted: [],
    };
  }
  if (
    mainKeyMode === "groovy" &&
    ((mainProvider === "anthropic" && !process.env.ANTHROPIC_API_KEY) ||
      (mainProvider === "openai" && !process.env.OPENAI_API_KEY))
  ) {
    return {
      kind: "final",
      traceId,
      text: "Server provider API keys are not configured.",
      toolCallsExecuted: [],
    };
  }

  const anthropicProviderOptions = getAnthropicContextProviderOptions(provider, modelName);
  const modelProviderOptions: SharedV3ProviderOptions | undefined =
    provider === "openai" && orchestratorModelOverride?.reasoningEffort
      ? {
          openai: {
            reasoningEffort: orchestratorModelOverride.reasoningEffort as
              | "none"
              | "low"
              | "medium"
              | "high"
              | "xhigh",
          },
        }
      : provider === "anthropic" && orchestratorModelOverride?.reasoningEffort
        ? {
            anthropic: {
              ...(anthropicProviderOptions?.anthropic || {}),
              effort: orchestratorModelOverride.reasoningEffort as
                | "low"
                | "medium"
                | "high"
                | "max",
            },
          }
        : anthropicProviderOptions;
  const contextBudget = getModelContextBudget(provider, modelName, anthropicProviderOptions);

  const effectiveTurnId = args.turnId || traceId;
  const roundSpanSeed = [
    effectiveTurnId,
    traceId,
    String(history.length),
    parsed.message || "",
    (toolResults || []).map((tr) => tr.toolCallId).sort().join(","),
  ].join("|");
  const roundSpanId = `round_${createHash("sha1").update(roundSpanSeed).digest("hex").slice(0, 16)}`;
  const billingWorkspaceId = await getOrCreateWorkspaceIdForUser({
    userId,
    email: userEmail || null,
    // In WhatsApp/scheduler flows this is typically an admin client already.
    supabaseAdmin: supabase,
  }).catch((e) => {
    console.warn(
      "[billing] getOrCreateWorkspaceIdForUser failed:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  });
  const integrationOwnerUserId = billingWorkspaceId
    ? await getWorkspaceCapabilityOwnerUserId({
        workspaceId: billingWorkspaceId,
        supabaseAdmin: supabase,
      }).catch(() => null)
    : null;

  let usageChargeType = usageChargeTypeForKeyMode(mainKeyMode);
  const connectorClaudeChargeType = resolved.claudeCliToken
    ? "external_key_fee"
    : usageChargeTypeForKeyMode(resolved.keyModes.anthropic || resolved.globalMode);
  const runGroovyPreflight = async () => {
    if (!billingWorkspaceId) return { allowed: true as const, message: "" };
    const preflight = await preflightGroovyUsage({
      workspaceId: billingWorkspaceId,
      userId,
      userEmail: userEmail || null,
      traceId,
      source: "run_orchestrator_round",
    });
    return preflight;
  };
  const preflight = await runGroovyPreflight();
  if (!preflight.allowed) {
    return {
      kind: "final",
      traceId,
      text: preflight.message,
      toolCallsExecuted: [],
    };
  }

  const billGroovyUsage = async (params: {
    source: string;
    spanId?: string;
    model?: string | null;
    usage?: unknown | null;
    modelCostUsdOverride?: number | null;
    meta?: Record<string, unknown>;
  }) => {
    if (!billingWorkspaceId) return;
    await settleGroovyUsageDebitBestEffort({
      workspaceId: billingWorkspaceId,
      userId,
      traceId,
      turnId: effectiveTurnId,
      source: params.source,
      spanId: params.spanId,
      model: params.model || modelName,
      usage: params.usage,
      modelCostUsdOverride: params.modelCostUsdOverride || null,
      chargeType: usageChargeType,
      meta: params.meta,
    }).catch(() => {});
  };

  // Billing: capture connector-side Claude CLI usage if present (tokens preferred, else estimate from cost).
  if (billingWorkspaceId && Array.isArray(toolResults) && toolResults.length > 0) {
    const asRecord = (v: unknown): Record<string, unknown> | null => {
      if (!v || typeof v !== "object") return null;
      if (Array.isArray(v)) return null;
      return v as Record<string, unknown>;
    };
    const pickNumber = (objs: Array<Record<string, unknown> | null>, key: string): number | null => {
      for (const o of objs) {
        if (!o) continue;
        const v = o[key];
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
        if (Number.isFinite(n)) return n;
      }
      return null;
    };
    const pickString = (objs: Array<Record<string, unknown> | null>, key: string): string | null => {
      for (const o of objs) {
        if (!o) continue;
        const v = o[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return null;
    };
    for (const tr of toolResults) {
      const toolName = tr.toolName;
      if (toolName !== "code_cli_run" && toolName !== "browser_task") continue;

      let parsedOuter: unknown = null;
      try {
        parsedOuter = JSON.parse(tr.result);
      } catch {
        parsedOuter = null;
      }

      const outer = asRecord(parsedOuter);
      const lvl1 = asRecord(outer?.result);
      const lvl2 = asRecord(lvl1?.result);
      const candidates = [outer, lvl1, lvl2];

      const usageCandidate =
        (outer && typeof outer.usage === "object" ? (outer.usage as unknown) : null) ||
        (lvl1 && typeof lvl1.usage === "object" ? (lvl1.usage as unknown) : null) ||
        (lvl2 && typeof lvl2.usage === "object" ? (lvl2.usage as unknown) : null) ||
        (outer ? outer : null) ||
        (lvl1 ? lvl1 : null) ||
        (lvl2 ? lvl2 : null);

      const normalizedUsage = normalizeTokenUsage(usageCandidate);
      const totalCostUsd =
        pickNumber(candidates, "total_cost_usd") ??
        pickNumber(candidates, "cost_usd") ??
        pickNumber(candidates, "totalCostUsd") ??
        pickNumber(candidates, "costUsd");
      const durationMs =
        pickNumber(candidates, "duration_ms") ??
        pickNumber(candidates, "durationMs");
      const modelFromPayload =
        pickString(candidates, "model") ??
        pickString(candidates, "model_name");
      const explicitChargeType = pickString(candidates, "billing_charge_type");
      const authOrigin = pickString(candidates, "billing_auth_origin");
      const authMethod = pickString(candidates, "billing_auth_method");
      const modelForEstimation =
        modelFromPayload || getOrchestratorAgentSdkFallbackModel();

      let inputTokens = normalizedUsage?.inputTokens ?? null;
      let outputTokens = normalizedUsage?.outputTokens ?? null;
      let totalTokens = normalizedUsage?.totalTokens ?? null;
      let estimated = false;
      let estimationReason: string | null = null;

      if (
        (typeof totalTokens !== "number" || totalTokens <= 0) &&
        typeof totalCostUsd === "number" &&
        totalCostUsd > 0
      ) {
        const est = estimateTokensFromCostUsd({
          totalCostUsd,
          model: modelForEstimation,
          outputRatio: 0.25,
        });
        if (est) {
          inputTokens = est.inputTokens;
          outputTokens = est.outputTokens;
          totalTokens = est.totalTokens;
          estimated = true;
          estimationReason = est.estimationReason;
        }
      }

      if (
        typeof inputTokens !== "number" &&
        typeof outputTokens !== "number" &&
        typeof totalTokens !== "number" &&
        typeof totalCostUsd !== "number"
      ) {
        continue;
      }

      const source = toolName === "code_cli_run" ? "connector_code_cli" : "connector_browser_task";
      const connectorChargeType = connectorClaudeChargeType;
      const connectorBillable = true;
      const usageForBilling = normalizedUsage ?? { inputTokens, outputTokens, totalTokens };
      const meta = {
        toolName,
        toolCallId: tr.toolCallId,
        totalCostUsd,
        durationMs,
        request_trace_id: traceId,
        authOrigin,
        authMethod,
        echoedChargeType: explicitChargeType,
        chargeType: connectorChargeType,
      };

      insertBillingUsageEventBestEffort({
        workspaceId: billingWorkspaceId,
        userId,
        turnId: effectiveTurnId,
        traceId: tr.toolCallId,
        source,
        spanId: "main",
        provider: "anthropic",
        model: modelFromPayload || null,
        inputTokens,
        outputTokens,
        totalTokens,
        estimated,
        estimationReason,
        modelCostUsd: typeof totalCostUsd === "number" ? totalCostUsd : null,
        billable: connectorBillable,
        chargeType: connectorChargeType,
        meta,
      });
      if (connectorBillable) {
        await settleGroovyUsageDebitBestEffort({
          workspaceId: billingWorkspaceId,
          userId,
          traceId: tr.toolCallId,
          turnId: effectiveTurnId,
          source,
          spanId: "main",
          model: modelFromPayload || null,
          usage: usageForBilling,
          modelCostUsdOverride: typeof totalCostUsd === "number" ? totalCostUsd : null,
          chargeType: connectorChargeType,
          meta,
        }).catch(() => {});
      }
    }
  }

  // Resolve memory connection for on-demand memory tools (recall/remember).
  // Do not preload memory context into the prompt; the model should decide when to call recall.
  const memoryContext = "";
  const preferenceContext = "";
  let memoryConnectionId: string | null = null;
  const ensureMemoryConnectionId = async (): Promise<string | null> => {
    if (!memoryEnabled) return null;
    if (memoryConnectionId) return memoryConnectionId;
    memoryConnectionId = await getGroovyMemoryConnection(
      userId,
      userEmail || undefined,
      supabase,
      memoryScopeId,
    );
    return memoryConnectionId;
  };

  if (memoryEnabled) {
    console.log("[runOrchestratorRound] Memory preload disabled (tool-invoked only)", {
      traceId,
      historyCount: history.length,
    });
  }

  const activeAgents = getToolsForRouting(parsed.directAgent);
  const branchControllerSettings =
    args.branchControllerSettings || (await loadBranchControllerSettings(supabase, userId));
  const runtimeScopeForBranchPolicy =
    args.runtimeScopeOverride ||
    (args.orchestratorAgentId
      ? await resolveRuntimeScope({
          supabase,
          userId,
          agentId: args.orchestratorAgentId,
          sessionId: args.orchestratorSessionId || null,
        })
      : null);
  const effectiveRuntimeAgentId =
    args.orchestratorAgentId || runtimeScopeForBranchPolicy?.agentId || null;
  const dynamicSkillTools = effectiveRuntimeAgentId
    ? await loadActiveSkillRuntimeTools({
        supabase,
        userId,
        agentId: effectiveRuntimeAgentId,
        epochId: runtimeScopeForBranchPolicy?.epochId || null,
        branchId: runtimeScopeForBranchPolicy?.branchId || null,
      })
    : [];
  const allDynamicExtensionTools = await loadInstalledExtensionRuntimeTools({
    supabase,
    userId,
  });
  const extensionCatalog = await listExtensionsForUser({
    supabase,
    userId,
  }).catch((error) => {
    console.warn(
      "[runOrchestratorRound] extension catalog unavailable:",
      error instanceof Error ? error.message : String(error)
    );
    return [] as Array<Record<string, unknown>>;
  });
  const dynamicExtensionTools = selectRelevantExtensionRuntimeTools({
    tools: allDynamicExtensionTools,
    queryText: routingText,
    recentTexts: buildExtensionSelectionRecentTexts(history),
  }).filter((tool) => isToolAllowed(tool.toolName, toolPolicy));
  const profileAiChatAgents = filterAgentRoster(
    args.aiChatAgents || [],
    toolPolicy.agentRoster,
  );

  const toolContext: ToolExecutionContext = {
    userId,
    integrationOwnerUserId: integrationOwnerUserId || userId,
    toolPolicy,
    harnessProfile,
    traceId,
    abortSignal: args.abortController?.signal,
    turnId: effectiveTurnId,
    billingWorkspaceId,
    appBaseUrl,
    deviceId,
    sourceConversationId: args.sourceConversationId || null,
    connectorPlatform: args.connectorPlatform || "unknown",
    obsidianVaultPath,
    directAgent: parsed.directAgent,
    orchestratorAgentId: effectiveRuntimeAgentId,
    orchestratorSessionId: args.orchestratorSessionId || null,
    taskNotifyTargets: args.taskNotifyTargets,
    taskRequestedChannel: args.taskRequestedChannel || null,
    branchControllerMode: branchControllerSettings.mode,
    branchControllerMaxBranches: branchControllerSettings.maxBranches,
    branchControllerMaxTurnsPerBranch: branchControllerSettings.maxTurnsPerBranch,
    branchCurrentTurnCount:
      runtimeScopeForBranchPolicy?.branchTurnCount ??
      (typeof args.branchCurrentTurnCount === "number" ? args.branchCurrentTurnCount : null),
    branchActiveCount:
      runtimeScopeForBranchPolicy?.activeBranchCount ??
      (typeof args.branchActiveCount === "number" ? args.branchActiveCount : null),
    runtimeEpochId: runtimeScopeForBranchPolicy?.epochId || null,
    runtimeBranchId: runtimeScopeForBranchPolicy?.branchId || null,
    branchRole: args.branchRole || "main",
    branchGoal: args.branchGoal || null,
    codeTerminalId: args.codeTerminalId || null,
    codeWorkspaceRootPath: args.codeWorkspaceRootPath || null,
    datagranConnectionId: memoryConnectionId,
    supabase,
    cookies,
    filesAgent: args.filesAgent || null,
    deviceToken: args.deviceToken,
    telegramBotToken: args.telegramBotToken,
    localTimezone: args.localTimezone,
    scheduledMode: args.scheduledMode === true,
    scheduledHardDeadlineAtMs:
      typeof args.scheduledHardDeadlineAtMs === "number"
        ? args.scheduledHardDeadlineAtMs
        : undefined,
    scheduledDataQueryTimeoutMs:
      typeof args.scheduledDataQueryTimeoutMs === "number"
        ? args.scheduledDataQueryTimeoutMs
        : undefined,
    // No UI-only code sessions in WhatsApp mode
    codeSessions: [],
    // User's AI chat agents for delegation
    aiChatAgents: profileAiChatAgents,
    webPixelNames: args.webPixelNames,
    onToolStream: args.onToolStream,
    onToolEvent: args.onToolEvent,
    // Browser tasks are supported in WhatsApp via connector-side runner (no dashboard loop required).
    disableBrowserTask: false,
    forceVisibleBrowserTask: shouldDispatchScheduledBrowser,
    // In site workflows, keep operations inside code_cli_run + site tools to avoid
    // terminal verification loops.
    disableTerminalExec: siteWorkflowMode,
    // Pass API keys + CLI token for code_cli_run using per-provider resolver
    ...buildToolApiKeys(resolved),
  };

  const executableTools = createExecutableTools(toolContext, dynamicSkillTools, dynamicExtensionTools);
  if (args.scheduledMode === true) {
    delete executableTools.assign_task;
    delete executableTools.consult_agent;
    delete executableTools.finalize_plan;
    delete executableTools.runtime_branch_parallel;
  }
  if (args.scheduledMode === true) {
    console.log(
      "[runOrchestratorRound] scheduled_browser_routing",
      JSON.stringify({
        traceId,
        prerequisiteRequired: scheduledBrowserPrerequisite,
        hasBrowserResult: hasScheduledBrowserResult,
        shouldDispatch: shouldDispatchScheduledBrowser,
        browserToolAvailable: typeof executableTools.browser_task !== "undefined",
        toolResultNames: safeToolResults.map((result) => result.toolName),
      })
    );
  }

  if (shouldDispatchScheduledBrowser) {
    const browserTool = executableTools.browser_task;
    if (!browserTool) {
      throw new Error("scheduled_browser_prerequisite_tool_unavailable");
    }

    const toolCallId = `scheduled_browser_${createHash("sha1")
      .update(`${traceId}|${routingText}`)
      .digest("hex")
      .slice(0, 20)}`;
    const rawDispatch = await browserTool.execute({
      task: buildScheduledBrowserPrerequisiteTask(routingText),
      startUrl: firstHttpUrl(routingText),
    });
    const parsedDispatch = parseJsonOutput(rawDispatch);
    const connectorDispatch = parsedDispatch as
      | {
          __connector_execute__?: unknown;
          type?: unknown;
          params?: unknown;
          toolName?: unknown;
          agent?: unknown;
          message?: unknown;
        }
      | null;
    if (
      !connectorDispatch ||
      connectorDispatch.__connector_execute__ !== true ||
      typeof connectorDispatch.type !== "string"
    ) {
      throw new Error("scheduled_browser_prerequisite_dispatch_invalid");
    }

    console.log(
      "[runOrchestratorRound] scheduled_browser_dispatched",
      JSON.stringify({
        traceId,
        toolCallId,
        connectorType: connectorDispatch.type,
        startUrl: firstHttpUrl(routingText) || null,
      })
    );
    return {
      kind: "needs_connector",
      traceId,
      partialText: "",
      toolCallsExecuted: ["browser_task"],
      connectorExecutes: [
        {
          toolCallId,
          toolName:
            typeof connectorDispatch.toolName === "string"
              ? connectorDispatch.toolName
              : "browser_task",
          agent:
            typeof connectorDispatch.agent === "string" ? connectorDispatch.agent : "browser",
          connectorType: connectorDispatch.type,
          connectorParams:
            connectorDispatch.params && typeof connectorDispatch.params === "object"
              ? (connectorDispatch.params as Record<string, unknown>)
              : {},
          message:
            typeof connectorDispatch.message === "string"
              ? connectorDispatch.message
              : undefined,
        },
      ],
    };
  }
  const nativeWebSearchEnabled =
    isAnthropicNativeWebSearchEnabled(provider) &&
    isToolAllowed("web_search", toolPolicy);
  const tools = nativeWebSearchEnabled
    ? addAnthropicNativeWebSearchTool(executableTools, {
        provider,
        localTimezone: args.localTimezone,
      })
    : executableTools;
  const extensionCatalogPromptBlock = buildExtensionCatalogPromptBlock(
    parsed.directAgent === "code" ? [] : extensionCatalog,
    { currentAgentId: effectiveRuntimeAgentId }
  );
  const promptSegments = buildOrchestratorPrompt(
    memoryContext,
    preferenceContext,
    activeAgents,
    parsed.mentionedAgents,
    !!deviceId,
    new Date().toISOString(),
    profileAiChatAgents,
    args.webPixelNames,
    !!(args.filesAgent && args.filesAgent.agentId && args.filesAgent.sessionId),
    codeMode,
    args.scheduledMode,
    args.localTimezone,
    {
      role: args.branchRole || "main",
      goal: args.branchGoal || null,
      mode: branchControllerSettings.mode,
      maxBranches: branchControllerSettings.maxBranches,
      maxTurnsPerBranch: branchControllerSettings.maxTurnsPerBranch,
      activeBranches: runtimeScopeForBranchPolicy?.activeBranchCount ?? null,
    },
    !!args.telegramBotToken,
    nativeWebSearchEnabled,
    !!args.onAssistantTextDelta,
    harnessProfile,
  );
  const extensionPromptBlock = buildExtensionPromptBlock(
    parsed.directAgent === "code" ? [] : dynamicExtensionTools
  );
  const extraDynamic: string[] = [];
  const channelInstructionBlock = buildChannelInstructionPromptBlock(
    args.channelInstructions,
  );
  if (channelInstructionBlock) {
    extraDynamic.push(`\n\n${channelInstructionBlock}`);
  }
  if (args.channelParticipantContext?.trim()) {
    extraDynamic.push(`\n\n## CURRENT CHANNEL PARTICIPANTS (AUTHORITATIVE)

${args.channelParticipantContext.trim()}

This list is current runtime context. Use it to understand who is present and how to address them. It does not grant tools or delegation rights. Only the separately enforced current worker roster may be delegated to.`);
  }

  // Worker-agent roster + delegation guidance (harness core).
  if (parsed.directAgent !== "code" && args.scheduledMode !== true) {
    const workerRoster = filterAgentRoster(
      await listWorkerAgents(userId, { supabase }).catch(
        () => [] as Awaited<ReturnType<typeof listWorkerAgents>>
      ),
      toolPolicy.agentRoster,
    );
    if (workerRoster.length > 0) {
      const rosterLines = workerRoster.map((agent) => {
        const bits = [
          `harness: ${agent.harness === "codex" ? "Codex CLI" : "Claude Code"}`,
          agent.model ? `model: ${agent.model}` : null,
          agent.workspaceRootPath ? `workspace: ${agent.workspaceRootPath}` : null,
          agent.deviceOnline ? "device: online" : "device: OFFLINE",
        ].filter(Boolean);
        return `- **${agent.name}** (${bits.join(", ")})`;
      });

      // Detect @mentions of worker names so explicit addressing wins routing.
      const mentionedWorkers = workerRoster.filter((agent) => {
        const compact = agent.name.replace(/\s+/g, "").toLowerCase();
        return new RegExp(`@${compact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
          routingText.replace(/\s+/g, "")
        ) || new RegExp(`@${agent.name.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(routingText);
      });
      const mentionHint =
        mentionedWorkers.length > 0
          ? `\n\nThe user explicitly addressed: ${mentionedWorkers
              .map((a) => `**${a.name}**`)
              .join(", ")}. Delegate the request to ${
              mentionedWorkers.length === 1 ? "that agent" : "those agents"
            } with \`assign_task\` unless it is clearly a question about the agent.`
          : "";

      extraDynamic.push(`\n\n## YOUR WORKER AGENTS

These are the user's worker agents — real coding harnesses (Claude Code / Codex CLI) running on their machines with full file, terminal, and repo access in their workspace:

${rosterLines.join("\n")}

Delegation rules:
- Use \`assign_task\` for any work that should happen in a workspace: coding, refactors, running commands, repo analysis, file generation.
- Tasks run in the background — tell the user the task is queued and on which agent; the completion result arrives as a follow-up event.
- Use \`list_agents\` / \`check_agent_status\` when unsure which agent fits or whether one is busy.
- Use \`transfer_context\` to hand one agent's findings to another before assigning follow-up work.
- Set \`require_approval: true\` for destructive or production-affecting work (deploys, deletions, force pushes, data migrations).
- When the user asks to plan a project or Plan mode is active, the orchestrator owns the final plan. Use \`consult_agent\` with the explicitly selected/mentioned worker so it explores its real workspace in enforced read-only mode and returns file/symbol/test evidence inline.
- After consultation, reason over the evidence yourself. You may call \`consult_agent\` again with the same planning_session_id for at most two targeted follow-ups when a material gap remains. Do not repeat broad exploration.
- The final plan must include: goal and non-goals, verified current architecture, evidence-backed files/symbols, ordered implementation steps, migrations/compatibility, tests, risks, and unresolved user decisions.
- Call \`finalize_plan\` with the synthesized plan before presenting it. The persisted plan then appears for review in the Tasks rail; approval saves it under .claude/plans/ and lets the user choose the execution agent.
- Use legacy \`assign_task(plan_mode: true)\` only when the user explicitly wants the worker—not the orchestrator—to author the plan.${mentionHint}`);
    } else {
      extraDynamic.push(`\n\n## YOUR WORKER AGENTS

${Array.isArray(args.allowedAgentIds)
  ? "No worker agents are selected for this conversation. Do not name, discover, inspect, or delegate to workers outside this conversation. If worker help is needed, ask a channel manager to add the agent in Channel settings."
  : "The user has no worker agents yet. When they ask for workspace/coding work, suggest creating one from the dashboard grid (pick a name, harness — Claude Code or Codex — and a workspace folder)."}`);
    }
  }
  if (deviceId) {
    await preflightAgentSkillsForUser({
      userId,
      deviceId,
      agentId: effectiveRuntimeAgentId,
      profileId: harnessProfile?.id || null,
      target: "flow",
    }).catch((error) => {
      console.warn(
        "[runOrchestratorRound] skills preflight failed:",
        error instanceof Error ? error.message : String(error)
      );
    });
  }
  const skillsPromptContext = await buildAssignedSkillsPromptContextForUser({
    userId,
    deviceId: deviceId || "",
    agentId: effectiveRuntimeAgentId,
    profileId: harnessProfile?.id || null,
    additionalArtifactIds: args.additionalSkillArtifactIds,
    target: "flow",
  }).catch((error) => {
    console.warn(
      "[runOrchestratorRound] skills context unavailable:",
      error instanceof Error ? error.message : String(error)
    );
    return { text: "", artifactCount: 0 };
  });
  if (skillsPromptContext.text) extraDynamic.push(`\n\n${skillsPromptContext.text}`);
  const fullDynamicContext =
    promptSegments.dynamicContext +
    extensionCatalogPromptBlock +
    extensionPromptBlock +
    extraDynamic.join("");
  // Flat string for logging / non-cache-aware consumers
  const systemPrompt =
    promptSegments.stableInstructions +
    "\n\n" +
    fullDynamicContext +
    "\n\n" +
    promptSegments.terminalInstructions;

  if (args.orchestratorSessionId && safeToolResults.length === 0) {
    const callerHistory = history;
    const durableContext = await buildDurableContextHistory({
      sessionId: args.orchestratorSessionId,
      authorizedUserId: userId,
      provider,
      apiKey: apiKey || undefined,
      filter: {
        epochId: runtimeScopeForBranchPolicy?.epochId || null,
        agentId: effectiveRuntimeAgentId,
        branchId: runtimeScopeForBranchPolicy?.branchId || null,
        useBranchScope: args.branchRole === "worker",
      },
      fallbackHistory: history,
      onSummaryUsage: async (summaryUsage) => {
        if (!summaryUsage.usage) return;
        const checkpointSpanId =
          `${roundSpanId}:checkpoint:v${summaryUsage.summaryVersion}`;
        if (billingWorkspaceId) {
          await insertBillingUsageEventBestEffort({
            workspaceId: billingWorkspaceId,
            userId,
            turnId: effectiveTurnId,
            traceId,
            source: "durable_context_checkpoint",
            spanId: checkpointSpanId,
            provider: summaryUsage.provider,
            model: summaryUsage.model,
            usage: summaryUsage.usage,
            billable: true,
            chargeType: usageChargeType,
            agentId: effectiveRuntimeAgentId,
            meta: {
              summarizedMessages: summaryUsage.summarizedMessages,
              summaryVersion: summaryUsage.summaryVersion,
              scopeKey: summaryUsage.scopeKey,
            },
          });
        }
        await billGroovyUsage({
          source: "durable_context_checkpoint",
          spanId: checkpointSpanId,
          model: summaryUsage.model,
          usage: summaryUsage.usage,
          meta: {
            summarizedMessages: summaryUsage.summarizedMessages,
            summaryVersion: summaryUsage.summaryVersion,
            scopeKey: summaryUsage.scopeKey,
          },
        });
      },
    });
    history = sanitizeMessages(durableContext.history);
    history = reconcileCurrentUserMessage({
      durableHistory: history,
      callerHistory,
      currentMessage: message,
    });
    if (durableContext.checkpointUpdated) {
      console.log("[runOrchestratorRound] durable context checkpoint updated", {
        traceId,
        sessionId: args.orchestratorSessionId,
        summarizedMessages: durableContext.summarizedMessages,
      });
    }
  }

  const trMsg = safeToolResults.length > 0 ? toolResultsToUserMessage(safeToolResults) : null;
  
  // Build messages, potentially adding files to the last user message
  const processedHistory = [...history];
  const inputFiles = args.files || [];
  
  // If we have files and a message, attach them to the user message
  if (inputFiles.length > 0 && message.trim()) {
    // Build multi-part content with text and files
    // AI SDK UserContent supports: TextPart | ImagePart | FilePart
    const parts: Array<
      | { type: "text"; text: string }
      | { type: "image"; image: string; mimeType?: string }
      | { type: "file"; data: string; mimeType: string }
    > = [];
    
    // Add file parts first (images and documents)
    for (const f of inputFiles) {
      const mime = f.mediaType || "";
      if (mime.startsWith("image/")) {
        // Image part - AI SDK expects base64 string for image
        parts.push({
          type: "image",
          image: f.base64,
          mimeType: mime,
        });
      } else {
        // Document/file part
        parts.push({
          type: "file",
          data: f.base64,
          mimeType: mime,
        });
      }
    }
    
    // Add text part
    parts.push({ type: "text", text: message.trim() });
    
    // Replace the last user message in history with multi-part version,
    // or append if the message isn't in history yet
    const lastUserIdx = processedHistory.findLastIndex((m) => m.role === "user");
    if (lastUserIdx >= 0) {
      // Replace with multi-part version (even if persisted history text differs;
      // e.g. WhatsApp may store a short user message but we augment the model input
      // with extracted document text).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (processedHistory as any)[lastUserIdx] = {
        role: "user" as const,
        content: parts,
      };
    }
  }
  
  const messages = sanitizeMessages([
    ...processedHistory,
    ...(trMsg ? [trMsg] : []),
  ]);

  let activeApiKey = apiKey;
  const toolCallsExecuted: string[] = [];
  const billingToolCalls: Array<{ toolCallId: string; toolName: string; agent: string }> = [];

  // Step budget:
  // - In WhatsApp "orch" mode, many useful tools (e.g. data_query/web_pixel) run server-side.
  //   If we stop at 1 step on the first round, the model often emits a preamble ("I'll query…"),
  //   calls the tool, and then gets cut off before it can return the actual report.
  // - In WhatsApp "code" mode, we still want tight step limits so the connector can execute the
  //   terminal step and round-trip results cleanly.
  const hasToolResults = Array.isArray(toolResults) && toolResults.length > 0;
  const allowSynthesisAfterTool = args.allowSynthesisAfterTool !== false;
  const maxSteps = args.maxSteps
    ? args.maxSteps
    : codeMode
      ? (hasToolResults ? 3 : 1)
      : 6;
  // Allow one extra synthesis step after tool execution in non-code mode.
  // Keep code mode unchanged so connector round-trips remain tight and predictable.
  const effectiveMaxSteps = Math.min(
    maxSteps + (codeMode || !allowSynthesisAfterTool ? 0 : 1),
    30
  );
  let loggedDataQueryReauthStop = false;
  let loggedScheduledDeadlineStop = false;
  const legacyStepBudgetStop = stepCountIs(effectiveMaxSteps) as (args: {
    steps: Array<{ toolCalls?: Array<{ toolName?: string }> }>;
  }) => boolean;
  const stopForLegacyRound = ({
    steps,
  }: {
    steps: Array<{ toolCalls?: Array<{ toolName?: string }> }>;
  }) => {
    if (toolContext.dataQueryReauthState?.blocked === true) {
      if (!loggedDataQueryReauthStop) {
        loggedDataQueryReauthStop = true;
        console.warn(
          "[runOrchestratorRound] stop_on_data_query_block",
          JSON.stringify({
            traceId,
            reason: toolContext.dataQueryReauthState.reason || "unknown",
            provider: toolContext.dataQueryReauthState.provider || null,
            agentId: toolContext.dataQueryReauthState.agentId || null,
          })
        );
      }
      return true;
    }
    const last = steps[steps.length - 1];
    const toolCalls = last?.toolCalls || [];
    if (toolCalls.some((tc) => String(tc?.toolName || "") === "runtime_branch_parallel")) {
      return true;
    }
    if (
      args.scheduledMode === true &&
      typeof args.scheduledHardDeadlineAtMs === "number" &&
      Number.isFinite(args.scheduledHardDeadlineAtMs)
    ) {
      const guardRaw = Number(process.env.SCHEDULED_ROUND_GUARD_MS);
      const guardMs = Number.isFinite(guardRaw)
        ? Math.max(5_000, Math.min(Math.trunc(guardRaw), 120_000))
        : 60_000;
      if (Date.now() >= args.scheduledHardDeadlineAtMs - guardMs) {
        if (!loggedScheduledDeadlineStop) {
          loggedScheduledDeadlineStop = true;
          console.warn(
            "[runOrchestratorRound] stop_on_scheduled_deadline",
            JSON.stringify({
              traceId,
              effectiveMaxSteps,
              remainingMs: Math.max(0, args.scheduledHardDeadlineAtMs - Date.now()),
              guardMs,
              steps: steps.length,
            })
          );
        }
        return true;
      }
    }
    return legacyStepBudgetStop({ steps });
  };

  // Compact messages if prompt is too large (> 150k tokens)
  let finalMessages = messages;
  try {
    const compactable = messages
      .map((m) => modelMessageToCompactable(m))
      .filter((m): m is NonNullable<typeof m> => m !== null);

    const compactionResult = await maybeCompactMessages(systemPrompt, compactable, {
      apiKey: activeApiKey || undefined,
      provider,
      triggerTokens: contextBudget.compactionTriggerTokens,
      keepTokens: contextBudget.keepRecentTokens,
      verbose: true,
      originalMessages: messages, // Pass original to preserve images/files
    });

    if (compactionResult.didCompact) {
      console.log("[runOrchestratorRound] Prompt compacted:", {
        traceId,
        scope: args.orchestratorAgentId ? `agent:${args.orchestratorAgentId}` : "agent:unknown",
        ...compactionResult.stats,
      });
      if (billingWorkspaceId && compactionResult.summaryUsage?.usage) {
        insertBillingUsageEventBestEffort({
          workspaceId: billingWorkspaceId,
          userId,
          turnId: effectiveTurnId,
          traceId,
          source: "compaction",
          spanId: `${roundSpanId}:summarize`,
          provider: compactionResult.summaryUsage.provider,
          model: compactionResult.summaryUsage.model,
          usage: compactionResult.summaryUsage.usage,
          billable: true,
          chargeType: usageChargeType,
          meta: {
            ...(compactionResult.stats ? { stats: compactionResult.stats } : {}),
          },
        });
        void billGroovyUsage({
          source: "compaction",
          spanId: `${roundSpanId}:summarize`,
          model: compactionResult.summaryUsage.model,
          usage: compactionResult.summaryUsage.usage,
          meta: {
            ...(compactionResult.stats ? { stats: compactionResult.stats } : {}),
          },
        });
      }
      
      // Use original messages for kept portion (preserves images/files)
      if (compactionResult.keptOriginalMessages && compactionResult.messages.length > 0) {
        const summaryMessage = compactableToModelMessage(compactionResult.messages[0]);
        finalMessages = [summaryMessage, ...(compactionResult.keptOriginalMessages as ModelMessage[])];
      } else {
        finalMessages = compactionResult.messages.map(compactableToModelMessage) as ModelMessage[];
      }
    }
  } catch (compactionError) {
    console.warn("[runOrchestratorRound] Compaction failed, using original messages:", compactionError);
  }

  // Anthropic rejects requests where the conversation ends with assistant prefill.
  // This can still happen in edge cases (history truncation/races), so force a
  // user tail before calling the model.
  if (finalMessages.length > 0 && finalMessages[finalMessages.length - 1]?.role !== "user") {
    const fallbackUserText =
      (parsed.message || message || lastUserText(history) || "").trim() ||
      "[follow-up]";
    finalMessages = [
      ...finalMessages,
      {
        role: "user",
        content: fallbackUserText,
      },
    ];
    console.warn("[runOrchestratorRound] appended_fallback_user_tail", {
      traceId,
      fallbackUserTextPreview: fallbackUserText.slice(0, 120),
      finalMessagesCount: finalMessages.length,
    });
  }

  let text = "";
  let finalFiles: Array<{ mediaType: string; base64: string; filename?: string | null }> | null = null;
  let finalGeneratedFiles: GeneratedFileRef[] | null = null;
  const connectorExecutes: ConnectorExecute[] = [];
  let uiOpenCode: UiOpenCode | null = null;
  let browserTask: BrowserTask | null = null;
  // If the model calls a server-side tool and we stop after 1 step, we can end up
  // with no assistant text at all. Keep the last tool output so we can surface it
  // (especially errors) rather than returning an empty WhatsApp reply.
  let lastToolOutputText: string | null = null;
  const capturedToolOutputLimit =
    args.allowSynthesisAfterTool === false ? 40_000 : 6_000;
  const generatedFileRefByKey = new Map<string, GeneratedFileRef>();

  const toNonEmptyString = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  const appendGeneratedFileRefs = (rawFiles: unknown) => {
    if (!Array.isArray(rawFiles)) return;
    for (const rawFile of rawFiles) {
      if (!rawFile || typeof rawFile !== "object") continue;
      const file = rawFile as Record<string, unknown>;
      const storagePath = toNonEmptyString(file.storage_path) || toNonEmptyString(file.storagePath);
      const fileId = toNonEmptyString(file.file_id) || toNonEmptyString(file.fileId);
      const url = toNonEmptyString(file.url);
      if (!storagePath && !fileId && !url) continue;
      const filename = toNonEmptyString(file.filename) || toNonEmptyString(file.name);
      const mimeType =
        toNonEmptyString(file.mime_type) || toNonEmptyString(file.mediaType) || "application/octet-stream";
      const normalized: GeneratedFileRef = {
        name: filename || "output",
        mediaType: mimeType,
      };
      if (url) normalized.url = url;
      if (storagePath) normalized.storage_path = storagePath;
      if (fileId) normalized.file_id = fileId;
      if (filename) normalized.filename = filename;
      if (mimeType) normalized.mime_type = mimeType;
      const dedupeKey = fileId || storagePath || url || `${normalized.name}:${normalized.mediaType}`;
      generatedFileRefByKey.set(dedupeKey, normalized);
    }
    finalGeneratedFiles = generatedFileRefByKey.size
      ? Array.from(generatedFileRefByKey.values())
      : null;
  };

  const maybeInjectScheduledWhatsAppMediaExecutes = () => {
    if (args.scheduledMode !== true) return;
    if (!Array.isArray(finalGeneratedFiles) || finalGeneratedFiles.length === 0) return;

    const alreadyHasMediaSend = connectorExecutes.some(
      (ex) =>
        ex.toolName === "whatsapp_send_media" ||
        ex.connectorType === "whatsapp_send_media"
    );
    if (alreadyHasMediaSend) return;

    const maxAutoMediaRaw = Number(process.env.SCHEDULED_WHATSAPP_AUTO_MEDIA_MAX_FILES);
    const maxAutoMedia = Number.isFinite(maxAutoMediaRaw)
      ? Math.max(1, Math.min(10, Math.trunc(maxAutoMediaRaw)))
      : 6;

    type WhatsAppAutoMediaCandidate = {
      dedupeKey: string;
      url?: string;
      storage_path?: string;
      file_id?: string;
      filename?: string;
    };
    const mediaCandidates: WhatsAppAutoMediaCandidate[] = [];
    for (const file of finalGeneratedFiles) {
      const url = toNonEmptyString(file.url);
      const storagePath = toNonEmptyString(file.storage_path);
      const fileId = toNonEmptyString(file.file_id);
      if (!url && !storagePath && !fileId) continue;
      const filename = toNonEmptyString(file.filename) || toNonEmptyString(file.name);
      const dedupeKey =
        storagePath || fileId || url || `${filename || "output"}:${file.mediaType}`;
      mediaCandidates.push({
        dedupeKey,
        url: url || undefined,
        storage_path: storagePath || undefined,
        file_id: fileId || undefined,
        filename: filename || undefined,
      });
    }

    if (mediaCandidates.length === 0) return;

    const uniqueMedia = Array.from(
      new Map(mediaCandidates.map((candidate) => [candidate.dedupeKey, candidate])).values()
    ).slice(0, maxAutoMedia);
    if (uniqueMedia.length === 0) return;

    const targetByChat = new Map<
      string,
      { chatId: string; recipientQuery?: string; insertAfterIndex: number }
    >();
    for (let i = 0; i < connectorExecutes.length; i++) {
      const ex = connectorExecutes[i];
      if (
        ex.toolName !== "whatsapp_send_text" &&
        ex.connectorType !== "whatsapp_send_text"
      ) {
        continue;
      }
      const chatId = toNonEmptyString(ex.connectorParams.chat_id);
      if (!chatId || targetByChat.has(chatId)) continue;
      const recipientQuery = toNonEmptyString(ex.connectorParams.recipient_query) || undefined;
      targetByChat.set(chatId, {
        chatId,
        recipientQuery,
        insertAfterIndex: i,
      });
    }

    if (targetByChat.size === 0) return;

    const targets = Array.from(targetByChat.values()).sort(
      (a, b) => a.insertAfterIndex - b.insertAfterIndex
    );

    let inserted = 0;
    const now = Date.now();
    for (const target of targets) {
      const mediaExecutes: ConnectorExecute[] = uniqueMedia.map((file, fileIndex) => ({
        toolCallId: `auto-wa-media-${now}-${inserted + fileIndex + 1}`,
        toolName: "whatsapp_send_media",
        agent: "files",
        connectorType: "whatsapp_send_media",
        connectorParams: {
          chat_id: target.chatId,
          ...(target.recipientQuery ? { recipient_query: target.recipientQuery } : {}),
          ...(file.url ? { url: file.url } : {}),
          ...(file.storage_path ? { storage_path: file.storage_path } : {}),
          ...(file.file_id ? { file_id: file.file_id } : {}),
          ...(file.filename ? { filename: file.filename } : {}),
        },
        message: file.filename
          ? `Sending WhatsApp attachment: ${file.filename}...`
          : "Sending WhatsApp attachment...",
      }));

      // Keep the primary text send first so attachment failures don't suppress
      // the main scheduled WhatsApp message for the chat.
      const insertAt = target.insertAfterIndex + inserted + 1;
      connectorExecutes.splice(insertAt, 0, ...mediaExecutes);
      inserted += mediaExecutes.length;
    }

    if (inserted > 0) {
      console.log(
        "[runOrchestratorRound] scheduled_whatsapp_auto_media_injected",
        JSON.stringify({
          traceId,
          recipients: targets.length,
          generatedFiles: finalGeneratedFiles.length,
          injectedMediaExecutes: inserted,
        })
      );
    }
  };

  const buildNeedsConnectorResult = (): OrchestratorRoundResult => {
    maybeInjectScheduledWhatsAppMediaExecutes();
    return {
      kind: "needs_connector",
      traceId,
      partialText: text,
      toolCallsExecuted,
      connectorExecutes,
    };
  };

  const toolNameToAgent = (toolName: string): string =>
    isWebSearchToolName(toolName)
      ? "browser"
      : toolName.startsWith("code_")
      ? "code"
      : toolName.startsWith("data_")
        ? "data"
        : toolName.startsWith("browser_")
          ? "browser"
          : toolName.startsWith("files_")
            ? "files"
            : toolName.startsWith("site_")
              ? "pages"
              : toolName.startsWith("obsidian_")
                ? "obsidian"
                : toolName.startsWith("schedule_")
                  ? "schedule"
                  : toolName === "terminal_exec"
                    ? "files"
                    : "chat";

  const processToolResult = (event: { toolCallId: string; toolName: string; output: string }) => {
    const parsedOutput = parseJsonOutput(event.output);
    try {
      if (typeof parsedOutput === "string") {
        const t = parsedOutput.trim();
        if (t) lastToolOutputText = t;
      } else if (parsedOutput != null) {
        const t = JSON.stringify(parsedOutput, null, 2);
        if (t && t.trim()) lastToolOutputText = t.slice(0, capturedToolOutputLimit);
      }
    } catch {
      // ignore
    }

    if (event.toolName === "ai_agent_delegate") {
      const out = parsedOutput as
        | { agentName?: unknown; response?: unknown; files?: unknown }
        | string
        | null;
      if (out && typeof out === "object") {
        const response = typeof out.response === "string" ? out.response : "";
        const filesRaw = out.files;
        const files = Array.isArray(filesRaw)
          ? filesRaw
              .map((f) => f as { mediaType?: unknown; base64?: unknown })
              .filter((f) => typeof f.mediaType === "string" && typeof f.base64 === "string")
              .map((f) => ({ mediaType: f.mediaType as string, base64: f.base64 as string }))
          : [];
        if (files.length > 0) finalFiles = files;
        if (!text.trim() && (response.trim() || files.length > 0)) {
          text = response.trim() || "[generated image]";
        }
      }
    }

    if (event.toolName === "files_agent_request") {
      const out = parsedOutput as
        | { response?: unknown; files?: unknown; generatedFiles?: unknown; generated_files?: unknown }
        | string
        | null;
      if (out && typeof out === "object") {
        const response = typeof out.response === "string" ? out.response : "";
        appendGeneratedFileRefs(
          (out as { generatedFiles?: unknown }).generatedFiles ??
            (out as { generated_files?: unknown }).generated_files ??
            (out as { files?: unknown }).files
        );
        const filesRaw =
          Array.isArray((out as { files_base64?: unknown }).files_base64)
            ? (out as { files_base64: unknown }).files_base64
            : (out as { files?: unknown }).files;
        const files = Array.isArray(filesRaw)
          ? filesRaw
              .map((f) => f as { mediaType?: unknown; base64?: unknown; filename?: unknown })
              .filter((f) => typeof f.mediaType === "string" && typeof f.base64 === "string")
              .map((f) => ({
                mediaType: f.mediaType as string,
                base64: f.base64 as string,
                filename: typeof f.filename === "string" ? (f.filename as string) : null,
              }))
          : [];
        if (files.length > 0) finalFiles = files;
        if (!text.trim() && (response.trim() || files.length > 0)) {
          text = response.trim() || "[generated file]";
        }
      }
    }

    if (event.toolName === "data_query") {
      const out = parsedOutput as
        | {
            agentResponse?: unknown;
            files?: unknown;
            files_base64?: unknown;
            generatedFiles?: unknown;
            generated_files?: unknown;
          }
        | string
        | null;
      if (out && typeof out === "object") {
        appendGeneratedFileRefs(
          (out as { generatedFiles?: unknown }).generatedFiles ??
            (out as { generated_files?: unknown }).generated_files ??
            (out as { files?: unknown }).files
        );
        const filesRaw =
          Array.isArray((out as { files_base64?: unknown }).files_base64)
            ? (out as { files_base64: unknown }).files_base64
            : (out as { files?: unknown }).files;
        const files = Array.isArray(filesRaw)
          ? filesRaw
              .map((f) => f as { mediaType?: unknown; base64?: unknown; filename?: unknown })
              .filter((f) => typeof f.mediaType === "string" && typeof f.base64 === "string")
              .map((f) => ({
                mediaType: f.mediaType as string,
                base64: f.base64 as string,
                filename: typeof f.filename === "string" ? (f.filename as string) : null,
              }))
          : [];
        if (files.length > 0) finalFiles = files;
      }
    }

    const isConnectorExecute =
      typeof parsedOutput === "object" &&
      parsedOutput !== null &&
      "__connector_execute__" in (parsedOutput as Record<string, unknown>);
    if (isConnectorExecute) {
      const v = parsedOutput as {
        __connector_execute__: true;
        type: string;
        params: Record<string, unknown>;
        toolName: string;
        agent: string;
        message?: string;
      };
      connectorExecutes.push({
        toolCallId: event.toolCallId,
        toolName: v.toolName || event.toolName,
        agent: v.agent || "data",
        connectorType: v.type,
        connectorParams: v.params || {},
        message: v.message,
      });
    }

    const isUiOpenCode =
      typeof parsedOutput === "object" &&
      parsedOutput !== null &&
      "__ui_open_code__" in (parsedOutput as Record<string, unknown>);
    if (isUiOpenCode) {
      const v = parsedOutput as {
        __ui_open_code__: true;
        agentId?: string;
        name?: string;
        requestedName?: string;
      };
      uiOpenCode = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        agentId: v.agentId,
        name: v.name,
        requestedName: v.requestedName,
      };
    }

    const isBrowserTask =
      typeof parsedOutput === "object" &&
      parsedOutput !== null &&
      "__browser_task__" in (parsedOutput as Record<string, unknown>);
    if (isBrowserTask) {
      const v = parsedOutput as {
        __browser_task__: true;
        task: string;
        startUrl?: string;
        message?: string;
      };
      browserTask = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        task: v.task,
        startUrl: v.startUrl,
        message: v.message,
      };
    }
  };

  const requiresConnectorRoundTrip = !!toolContext.deviceId;
  const orchUseAgentSdk = process.env.ORCH_USE_AGENT_SDK !== "0";
  const requiresStreamingProgress = !!args.onAssistantTextDelta;
  const agentSdkSupportsProvider = provider === "anthropic";
  const shouldUseAgentSdk =
    agentSdkSupportsProvider &&
    orchUseAgentSdk &&
    !requiresConnectorRoundTrip &&
    !requiresStreamingProgress;
  const preferredSdkApiKey = agentSdkSupportsProvider ? activeApiKey : null;
  const hasSdkApiKey = !!(preferredSdkApiKey || process.env.ANTHROPIC_API_KEY);
  const sdkPathReason = !agentSdkSupportsProvider
    ? "selected_provider_requires_ai_sdk"
    : !orchUseAgentSdk
      ? "disabled_by_env"
      : requiresConnectorRoundTrip
        ? "disabled_for_connector_round_trip"
        : requiresStreamingProgress
          ? "disabled_for_streaming_progress"
          : hasSdkApiKey
            ? "enabled"
            : "missing_anthropic_api_key";

  console.log(
    "[runOrchestratorRound] engine_selection",
    JSON.stringify({
      traceId,
      engine: shouldUseAgentSdk && hasSdkApiKey ? "agent_sdk" : "legacy",
      reason: sdkPathReason,
      provider,
      modelName,
      envOrchUseAgentSdk: process.env.ORCH_USE_AGENT_SDK ?? null,
      hasPreferredSdkApiKey: !!preferredSdkApiKey,
      hasServerAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    })
  );

  let agentSdkMetrics:
    | {
        durationMs?: number;
        durationApiMs?: number;
        numTurns?: number;
        toolExecutionMsTotal: number;
      }
    | null = null;

  const runWithAgentSdk = async (sdkApiKey: string | null) => {
    console.log(
      "[runOrchestratorRound] agent_sdk_start",
      JSON.stringify({
        traceId,
        provider,
        modelName,
        sdkApiKeySource: sdkApiKey ? "user_or_resolved" : "server_env",
        maxSteps,
        effectiveMaxSteps,
      })
    );
    const sdkModel =
      provider === "anthropic" && modelName.toLowerCase().includes("claude")
        ? modelName
        : getOrchestratorAgentSdkFallbackModel();
    const sdkSystemPrompt = `${systemPrompt}\n\n${buildOrchestratorRuntimeIdentityPrompt({
      provider: "anthropic",
      modelName: sdkModel,
      reasoningEffort: orchestratorModelOverride?.reasoningEffort,
      engine: "anthropic-agent-sdk",
      selectionSource: harnessProfile?.model
        ? "profile"
        : args.modelOverride
          ? "scheduled-override"
          : orchestratorModelOverride
            ? "user-selected"
            : "automatic-default",
    })}`;
    const sdkResult = await runAgentSdkOrchestrator({
      systemPrompt: sdkSystemPrompt,
      messages: finalMessages,
      tools: executableTools,
      builtinTools: isToolAllowed("WebSearch", toolPolicy)
        ? getAnthropicAgentSdkBuiltinTools(provider)
        : [],
      model: sdkModel,
      betas: anthropicProviderOptions?.anthropic?.betas,
      maxTurns: effectiveMaxSteps,
      apiKey: sdkApiKey,
      cwd: args.codeWorkspaceRootPath || process.cwd(),
      unrestricted: true,
      abortController: args.abortController,
    });
    agentSdkMetrics = sdkResult.metrics || null;

    for (const call of sdkResult.toolCalls) {
      const agent = toolNameToAgent(call.toolName);
      toolCallsExecuted.push(call.toolName);
      billingToolCalls.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        agent,
      });
      args.onToolEvent?.({ phase: "start", toolName: call.toolName, agent });
    }

    for (const tr of sdkResult.toolResults) {
      processToolResult({
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        output: tr.output,
      });
    }

    const measuredToolMsFromEvents = sdkResult.toolResults.reduce(
      (acc, tr) => acc + (typeof tr.elapsedMs === "number" ? tr.elapsedMs : 0),
      0
    );
    console.log(
      "[runOrchestratorRound] efficiency_summary",
      JSON.stringify({
        traceId,
        engine: "agent_sdk",
        numTurns: sdkResult.metrics?.numTurns ?? null,
        durationMs: sdkResult.metrics?.durationMs ?? null,
        durationApiMs: sdkResult.metrics?.durationApiMs ?? null,
        toolCalls: sdkResult.toolCalls.length,
        toolResults: sdkResult.toolResults.length,
        toolExecutionMsTotal:
          sdkResult.metrics?.toolExecutionMsTotal ?? measuredToolMsFromEvents,
      })
    );

    if (sdkResult.text && sdkResult.text.trim()) {
      text = sdkResult.text.trim();
    }

    if (billingWorkspaceId) {
      insertBillingUsageEventBestEffort({
        workspaceId: billingWorkspaceId,
        userId,
        turnId: effectiveTurnId,
        traceId,
        source: "orchestrator_round_agent_sdk",
        spanId: roundSpanId,
        provider: "anthropic",
        model: sdkModel,
        usage: sdkResult.usage,
        billable: true,
        chargeType: usageChargeType,
        meta: {
          directAgent: parsed.directAgent,
          maxSteps,
          historyCount: history.length,
          finalMessagesCount: finalMessages.length,
        },
      });
      await billGroovyUsage({
        source: "orchestrator_round_agent_sdk",
        spanId: roundSpanId,
        model: sdkModel,
        usage: sdkResult.usage,
        meta: {
          directAgent: parsed.directAgent,
          maxSteps,
          historyCount: history.length,
          finalMessagesCount: finalMessages.length,
        },
      });
    }

    if (text) {
      await scheduleAfterResponse(async () => {
        const resolvedMemoryConnectionId = await ensureMemoryConnectionId();
        if (!resolvedMemoryConnectionId) return;
        const result = await maybeStoreConversation(
          resolvedMemoryConnectionId,
          parsed.message || lastUserText(history),
          text,
          memoryContext,
          {
            llmApiKey: sdkApiKey || undefined,
            llmProvider: "anthropic",
            llmModel: sdkModel,
            wiki: {
              supabase,
              userId,
              source: "orchestrator conversation learning",
              profileId:
                memoryScopeId,
            },
          }
        );
        if (result.stored) {
          console.log("[runOrchestratorRound] Memory stored:", {
            label: result.label,
            datagranStored: result.datagranStored,
            wikiFiled: result.wikiFiled,
            wikiPath: result.wikiPath,
          });
        }
      }, "orchestrator round Agent SDK memory storage");
    }
  };

  if (shouldUseAgentSdk && hasSdkApiKey) {
    let usedAgentSdk = false;
    try {
      await runWithAgentSdk(preferredSdkApiKey || null);
      usedAgentSdk = true;
    } catch (err) {
      if (args.abortController?.signal.aborted) throw err;
      if (
        preferredSdkApiKey &&
        provider === "anthropic" &&
        isInvalidApiKeyError(err) &&
        hasServerProviderKey("anthropic")
      ) {
        console.warn("[runOrchestratorRound] Agent SDK user key invalid; retrying with Groovy key");
        if (usageChargeType !== "groovy_key") {
          const preflight = await runGroovyPreflight();
          if (!preflight.allowed) {
            return {
              kind: "final",
              traceId,
              text: preflight.message,
              toolCallsExecuted: [],
            };
          }
        }
        usageChargeType = "groovy_key";
        text = "";
        finalFiles = null;
        connectorExecutes.length = 0;
        uiOpenCode = null;
        browserTask = null;
        lastToolOutputText = null;
        toolCallsExecuted.length = 0;
        billingToolCalls.length = 0;
        await runWithAgentSdk(null);
        usedAgentSdk = true;
      } else {
        console.error("[runOrchestratorRound] Agent SDK failed; falling back to legacy engine", err);
        console.warn(
          "[runOrchestratorRound] fallback_to_legacy",
          JSON.stringify({
            traceId,
            reason: "agent_sdk_runtime_error",
            provider,
            modelName,
          })
        );
      }
    }

    if (usedAgentSdk) {
      const metrics = agentSdkMetrics as
        | {
            durationMs?: number;
            durationApiMs?: number;
            numTurns?: number;
            toolExecutionMsTotal: number;
          }
        | null;
      console.log(
        "[runOrchestratorRound] agent_sdk_complete",
        JSON.stringify({
          traceId,
          toolCallsExecuted: toolCallsExecuted.length,
          connectorExecutes: connectorExecutes.length,
          hasUiOpenCode: !!uiOpenCode,
          hasBrowserTask: !!browserTask,
          numTurns: metrics?.numTurns ?? null,
          durationMs: metrics?.durationMs ?? null,
          durationApiMs: metrics?.durationApiMs ?? null,
          toolExecutionMsTotal: metrics?.toolExecutionMsTotal ?? null,
        })
      );
      if (billingWorkspaceId && billingToolCalls.length > 0) {
        await insertBillingToolEventsBestEffort(
          billingToolCalls.map((c) => ({
            workspaceId: billingWorkspaceId,
            userId,
            turnId: effectiveTurnId,
            traceId,
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            agent: c.agent,
            meta: { request_trace_id: traceId },
          }))
        );
      }

      if (connectorExecutes.length > 0) {
        return buildNeedsConnectorResult();
      }

      if (browserTask) {
        return {
          kind: "browser_task",
          traceId,
          partialText: text,
          toolCallsExecuted,
          browserTask,
        };
      }

      if (uiOpenCode) {
        return {
          kind: "ui_open_code",
          traceId,
          partialText: text,
          toolCallsExecuted,
          uiOpenCode,
        };
      }

      const toolOutputText = (lastToolOutputText || "") as string;
      if (!text.trim() && toolOutputText) {
        try {
          const parsed = JSON.parse(toolOutputText);
          if (parsed && typeof parsed === "object") {
            const answer = parsed?.data?.answer || parsed?.answer;
            if (answer && typeof answer === "string" && answer.trim()) {
              text = answer.trim();
            } else if (
              parsed?.context &&
              typeof parsed.context === "string" &&
              parsed.context.trim()
            ) {
              text = parsed.context.slice(0, 2000);
            } else {
              text = toolOutputText.slice(0, 3000);
            }
          } else {
            text = toolOutputText.slice(0, 3000);
          }
        } catch {
          text = toolOutputText.slice(0, 3000);
        }
      }

      return {
        kind: "final",
        traceId,
        text,
        toolOutputText: toolOutputText || undefined,
        files: finalFiles || undefined,
        generatedFiles: finalGeneratedFiles || undefined,
        toolCallsExecuted,
      };
    }
  }

  if (!shouldUseAgentSdk || !hasSdkApiKey) {
    console.warn(
      "[runOrchestratorRound] using_legacy_engine",
      JSON.stringify({
        traceId,
        reason: !shouldUseAgentSdk ? "disabled_by_env" : "missing_anthropic_api_key",
        provider,
        modelName,
      })
    );
  }

  const runtimeIdentity = buildOrchestratorRuntimeIdentityPrompt({
    provider,
    modelName,
    reasoningEffort: orchestratorModelOverride?.reasoningEffort,
    engine: "ai-sdk",
    selectionSource: harnessProfile?.model
      ? "profile"
      : args.modelOverride
        ? "scheduled-override"
        : orchestratorModelOverride
          ? "user-selected"
          : "automatic-default",
  });
  const systemMessages =
    provider === "anthropic"
      ? [
          {
            role: "system" as const,
            content: promptSegments.stableInstructions,
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral" as const } },
            },
          },
          {
            role: "system" as const,
            content: `${fullDynamicContext}\n\n${promptSegments.terminalInstructions}\n\n${runtimeIdentity}`,
          },
        ]
      : [
          {
            role: "system" as const,
            content: `${systemPrompt}\n\n${runtimeIdentity}`,
          },
        ];

  const createResult = (currentApiKey: string | null) =>
    streamText({
      model: resolveChatModel(provider, modelName, currentApiKey ? { apiKey: currentApiKey } : undefined),
      system: systemMessages,
      providerOptions: modelProviderOptions,
      messages: finalMessages,
      tools,
      abortSignal: args.abortController?.signal,
      stopWhen: stopForLegacyRound,
      onFinish: async (event) => {
        const text = event.text;
        const usage = (event as unknown as { usage?: unknown }).usage;

        if (billingWorkspaceId) {
          insertBillingUsageEventBestEffort({
            workspaceId: billingWorkspaceId,
            userId,
            turnId: effectiveTurnId,
            traceId,
            source: "orchestrator_round",
            spanId: roundSpanId,
            provider,
            model: modelName,
            usage,
            billable: true,
            chargeType: usageChargeType,
            meta: {
              directAgent: parsed.directAgent,
              maxSteps,
              historyCount: history.length,
              finalMessagesCount: finalMessages.length,
            },
          });
          await billGroovyUsage({
            source: "orchestrator_round",
            spanId: roundSpanId,
            model: modelName,
            usage,
            meta: {
              directAgent: parsed.directAgent,
              maxSteps,
              historyCount: history.length,
              finalMessagesCount: finalMessages.length,
            },
          });
        }

        // AI-decided memory storage (async, don't block response)
        if (text && !args.abortController?.signal.aborted) {
          await scheduleAfterResponse(async () => {
            const resolvedMemoryConnectionId = await ensureMemoryConnectionId();
            if (!resolvedMemoryConnectionId) return;
            const result = await maybeStoreConversation(
              resolvedMemoryConnectionId,
              parsed.message || lastUserText(history),
              text,
              memoryContext,
              {
                llmApiKey: currentApiKey || undefined,
                llmProvider: provider,
                llmModel: modelName,
                wiki: {
                  supabase,
                  userId,
                  source: "orchestrator conversation learning",
                  profileId:
                    memoryScopeId,
                },
              }
            );
            if (result.stored) {
              console.log("[runOrchestratorRound] Memory stored:", {
                label: result.label,
                datagranStored: result.datagranStored,
                wikiFiled: result.wikiFiled,
                wikiPath: result.wikiPath,
              });
            }
          }, "orchestrator round memory storage");
        }
      },
    });

  const consumeStream = async (result: ReturnType<typeof createResult>) => {
    for await (const event of result.fullStream) {
    if (event.type === "text-delta") {
      text += event.text;
      args.onAssistantTextDelta?.({ text: event.text });
      continue;
    }

    if (event.type === "tool-call") {
      const toolName = event.toolName;
      toolCallsExecuted.push(toolName);
      const agent = toolNameToAgent(toolName);
      billingToolCalls.push({ toolCallId: event.toolCallId, toolName, agent });
      args.onToolEvent?.({ phase: "start", toolName, agent });
      continue;
    }

    if (event.type === "tool-result") {
      const parsedOutput = parseJsonOutput(event.output);
      try {
        if (typeof parsedOutput === "string") {
          const t = parsedOutput.trim();
          if (t) lastToolOutputText = t;
        } else if (parsedOutput != null) {
          // Keep it reasonably small for chat surfaces like WhatsApp.
          const t = JSON.stringify(parsedOutput, null, 2);
        if (t && t.trim()) lastToolOutputText = t.slice(0, capturedToolOutputLimit);
        }
      } catch {
        // ignore
      }

      // Special-case: ai_agent_delegate can return the final answer directly (and may include generated image files).
      if (event.toolName === "ai_agent_delegate") {
        const out = parsedOutput as
          | { agentName?: unknown; response?: unknown; files?: unknown }
          | string
          | null;
        if (out && typeof out === "object") {
          const response =
            typeof out.response === "string" ? out.response : "";
          const filesRaw = out.files;
          const files = Array.isArray(filesRaw)
            ? filesRaw
                .map((f) => f as { mediaType?: unknown; base64?: unknown })
                .filter((f) => typeof f.mediaType === "string" && typeof f.base64 === "string")
                .map((f) => ({ mediaType: f.mediaType as string, base64: f.base64 as string }))
            : [];
          if (files.length > 0) finalFiles = files;
          if (!text.trim() && (response.trim() || files.length > 0)) {
            text = response.trim() || "[generated image]";
          }
        }
      }

      // Special-case: files_agent_request can return generated files (xlsx/png/etc) as base64 for WhatsApp.
      if (event.toolName === "files_agent_request") {
        const out = parsedOutput as
          | { response?: unknown; files?: unknown; generatedFiles?: unknown; generated_files?: unknown }
          | string
          | null;
        if (out && typeof out === "object") {
          const response = typeof out.response === "string" ? out.response : "";
          appendGeneratedFileRefs(
            (out as { generatedFiles?: unknown }).generatedFiles ??
              (out as { generated_files?: unknown }).generated_files ??
              (out as { files?: unknown }).files
          );
          // Prefer base64 attachments for WhatsApp/connector surfaces when available.
          // Tool executors may also return URL-based `files` for dashboard downloads.
          const filesRaw =
            Array.isArray((out as { files_base64?: unknown }).files_base64)
              ? (out as { files_base64: unknown }).files_base64
              : (out as { files?: unknown }).files;
          const files = Array.isArray(filesRaw)
            ? filesRaw
                .map((f) => f as { mediaType?: unknown; base64?: unknown; filename?: unknown })
                .filter((f) => typeof f.mediaType === "string" && typeof f.base64 === "string")
                .map((f) => ({
                  mediaType: f.mediaType as string,
                  base64: f.base64 as string,
                  filename: typeof f.filename === "string" ? (f.filename as string) : null,
                }))
            : [];
          if (files.length > 0) finalFiles = files;
          if (!text.trim() && (response.trim() || files.length > 0)) {
            text = response.trim() || "[generated file]";
          }
        }
      }

      // Special-case: data_query can return generated files (charts, xlsx) as base64 for WhatsApp.
      if (event.toolName === "data_query") {
        const out = parsedOutput as
          | {
              agentResponse?: unknown;
              files?: unknown;
              files_base64?: unknown;
              generatedFiles?: unknown;
              generated_files?: unknown;
            }
          | string
          | null;
        if (out && typeof out === "object") {
          appendGeneratedFileRefs(
            (out as { generatedFiles?: unknown }).generatedFiles ??
              (out as { generated_files?: unknown }).generated_files ??
              (out as { files?: unknown }).files
          );
          const filesRaw =
            Array.isArray((out as { files_base64?: unknown }).files_base64)
              ? (out as { files_base64: unknown }).files_base64
              : (out as { files?: unknown }).files;
          const files = Array.isArray(filesRaw)
            ? filesRaw
                .map((f) => f as { mediaType?: unknown; base64?: unknown; filename?: unknown })
                .filter((f) => typeof f.mediaType === "string" && typeof f.base64 === "string")
                .map((f) => ({
                  mediaType: f.mediaType as string,
                  base64: f.base64 as string,
                  filename: typeof f.filename === "string" ? (f.filename as string) : null,
                }))
            : [];
          if (files.length > 0) finalFiles = files;
        }
      }

      const isConnectorExecute =
        typeof parsedOutput === "object" &&
        parsedOutput !== null &&
        "__connector_execute__" in (parsedOutput as Record<string, unknown>);
      if (isConnectorExecute) {
        const v = parsedOutput as {
          __connector_execute__: true;
          type: string;
          params: Record<string, unknown>;
          toolName: string;
          agent: string;
          message?: string;
        };
        connectorExecutes.push({
          toolCallId: event.toolCallId,
          toolName: v.toolName || event.toolName,
          agent: v.agent || "data",
          connectorType: v.type,
          connectorParams: v.params || {},
          message: v.message,
        });
      }

      const isUiOpenCode =
        typeof parsedOutput === "object" &&
        parsedOutput !== null &&
        "__ui_open_code__" in (parsedOutput as Record<string, unknown>);
      if (isUiOpenCode) {
        const v = parsedOutput as {
          __ui_open_code__: true;
          agentId?: string;
          name?: string;
          requestedName?: string;
        };
        uiOpenCode = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          agentId: v.agentId,
          name: v.name,
          requestedName: v.requestedName,
        };
      }

      const isBrowserTask =
        typeof parsedOutput === "object" &&
        parsedOutput !== null &&
        "__browser_task__" in (parsedOutput as Record<string, unknown>);
      if (isBrowserTask) {
        const v = parsedOutput as {
          __browser_task__: true;
          task: string;
          startUrl?: string;
          message?: string;
        };
        browserTask = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          task: v.task,
          startUrl: v.startUrl,
          message: v.message,
        };
      }
    }
  }
  };

  const TRANSIENT_MAX_RETRIES = 2;

  const resetStreamState = () => {
    text = "";
    finalFiles = null;
    finalGeneratedFiles = null;
    generatedFileRefByKey.clear();
    connectorExecutes.length = 0;
    uiOpenCode = null;
    browserTask = null;
    lastToolOutputText = null;
    toolCallsExecuted.length = 0;
    billingToolCalls.length = 0;
  };

  for (let transientAttempt = 0; ; transientAttempt++) {
    try {
      await consumeStream(createResult(activeApiKey));
      break;
    } catch (err) {
      if (args.abortController?.signal.aborted) throw err;
      if (args.scheduledMode === true && connectorExecutes.length > 0) {
        console.warn(
          "[runOrchestratorRound] scheduled_round_error_after_connector_execute",
          JSON.stringify({
            traceId,
            connectorExecutes: connectorExecutes.length,
            toolCallsExecuted: toolCallsExecuted.length,
            error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          })
        );
        return buildNeedsConnectorResult();
      }

      if (activeApiKey && isInvalidApiKeyError(err) && hasServerProviderKey(provider)) {
        console.warn("[runOrchestratorRound] user key invalid; retrying with Groovy key", {
          provider,
          modelName,
        });
        if (usageChargeType !== "groovy_key") {
          const preflight = await runGroovyPreflight();
          if (!preflight.allowed) {
            return {
              kind: "final",
              traceId,
              text: preflight.message,
              toolCallsExecuted: [],
            };
          }
        }
        usageChargeType = "groovy_key";
        activeApiKey = null;
        resetStreamState();
        transientAttempt = 0;
        continue;
      }

      if (isTransientApiError(err) && transientAttempt < TRANSIENT_MAX_RETRIES) {
        const backoffMs = Math.pow(2, transientAttempt + 1) * 1000;
        console.warn("[runOrchestratorRound] transient API error, retrying", {
          traceId,
          attempt: transientAttempt + 1,
          maxRetries: TRANSIENT_MAX_RETRIES,
          backoffMs,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        });
        resetStreamState();
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      throw err;
    }
  }

  if (billingWorkspaceId && billingToolCalls.length > 0) {
    await insertBillingToolEventsBestEffort(
      billingToolCalls.map((c) => ({
        workspaceId: billingWorkspaceId,
        userId,
        turnId: effectiveTurnId,
        traceId,
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        agent: c.agent,
        meta: { request_trace_id: traceId },
      }))
    );
  }

  if (connectorExecutes.length > 0) {
    return buildNeedsConnectorResult();
  }

  if (browserTask) {
    return {
      kind: "browser_task",
      traceId,
      partialText: text,
      toolCallsExecuted,
      browserTask,
    };
  }

  if (uiOpenCode) {
    return {
      kind: "ui_open_code",
      traceId,
      partialText: text,
      toolCallsExecuted,
      uiOpenCode,
    };
  }

  // Surface tool output if the model produced no assistant text this round.
  // This avoids "(no reply)" in WhatsApp when a tool errors (e.g. missing API key).
  const toolOutputText = (lastToolOutputText || "") as string;
  if (!text.trim() && toolOutputText) {
    // Try to extract a clean answer from recall/memory tool output instead of dumping raw JSON.
    try {
      const parsed = JSON.parse(toolOutputText);
      if (parsed && typeof parsed === "object") {
        // recall tool returns { context, data: { answer } }
        const answer = parsed?.data?.answer || parsed?.answer;
        if (answer && typeof answer === "string" && answer.trim()) {
          text = answer.trim();
        } else if (parsed?.context && typeof parsed.context === "string" && parsed.context.trim()) {
          // Use context but cap it — it can contain raw traces
          text = parsed.context.slice(0, 2000);
        } else {
          text = toolOutputText.slice(0, 3000);
        }
      } else {
        text = toolOutputText.slice(0, 3000);
      }
    } catch {
      // Not JSON — use as-is, just cap the size
      text = toolOutputText.slice(0, 3000);
    }
  }

  return {
    kind: "final",
    traceId,
    text,
    toolOutputText: toolOutputText || undefined,
    files: finalFiles || undefined,
    generatedFiles: finalGeneratedFiles || undefined,
    toolCallsExecuted,
  };
}
