/**
 * Orchestrator API Route
 * Main endpoint for the command center - handles hybrid routing and tool calling.
 */

import { NextResponse } from "next/server";
import { getAppUrl } from "@/lib/config/appConfig";
import { streamText, stepCountIs, type ModelMessage, type UserContent } from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { embedText, embeddingToVectorLiteral } from "@/lib/ai/embeddings";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  resolveChatModel,
  type ProviderId,
  getAnthropicContextProviderOptions,
  getModelContextBudget,
  getOrchestratorAgentSdkFallbackModel,
} from "@/lib/ai/modelResolver";
import { resolveKeys, buildToolApiKeys } from "@/lib/keys/resolveKeyMode";
import { resolveOrchestratorModelOverride } from "@/lib/orchestrator/orchestratorModel";
import { resolveHarnessProfile, type HarnessProfile } from "@/lib/orchestrator/harnessProfiles";
import {
  buildOrchestratorPrompt as buildSharedOrchestratorPrompt,
} from "@/lib/orchestrator/promptKernel";
import {
  buildToolPolicyExecutionContext,
  isToolAllowed,
} from "@/lib/orchestrator/toolPolicy";
import { buildOrchestratorRuntimeIdentityPrompt } from "@/lib/orchestrator/runtimeIdentity";
import { scheduleAfterResponse } from "@/lib/runtime/afterResponse";
import {
  formatDurableLearningConfirmation,
  getGroovyMemoryConnection,
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
import {
  parseInput,
  getToolsForRouting,
  type AgentType,
} from "@/lib/orchestrator/router";
import { createExecutableTools } from "@/lib/orchestrator/executableTools";
import { getProductAccessForUser } from "@/lib/licensing/access";
import { runAgentSdkOrchestrator } from "@/lib/orchestrator/agentSdkRuntime";
import type { ToolExecutionContext, AgentActivity } from "@/lib/orchestrator/toolExecutor";
import { loadBranchControllerSettings } from "@/lib/orchestrator/branchController";
import {
  resolveRuntimeScope,
} from "@/lib/orchestrator/runtimeGraph";
import { ensureOrchestratorRuntimeAgentId } from "@/lib/orchestrator/runtimeAgents";
import { loadActiveSkillRuntimeTools } from "@/lib/orchestrator/skillsRuntime";
import {
  buildExtensionCatalogPromptBlock,
  buildExtensionPromptBlock,
  listExtensionsForUser,
  loadInstalledExtensionRuntimeTools,
  selectRelevantExtensionRuntimeTools,
} from "@/lib/extensions/registry";
import {
  detectConnectorPlatformFromUserAgent,
  normalizeConnectorPlatform,
  type ConnectorClientPlatform,
} from "@/lib/connector/platform";
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
import { getEnterpriseDemoConfig } from "@/lib/enterpriseDemo";
import {
  buildAssignedSkillsPromptContext,
  preflightAgentSkills,
} from "@/lib/skills-manager/service";
import { decryptTelegramBotToken } from "@/lib/telegram/botToken";
import {
  addAnthropicNativeWebSearchTool,
  getAnthropicAgentSdkBuiltinTools,
  isAnthropicNativeWebSearchEnabled,
  isWebSearchToolName,
} from "@/lib/orchestrator/anthropicWebSearch";

// Keep orchestrator rounds alive for long data/browser workflows on Vercel.
export const runtime = "nodejs";
// Vercel honors this for Route Handlers (plan-dependent). Safe no-op elsewhere.
export const maxDuration = 800;

type PostBody = {
  message?: string;
  history?: ModelMessage[];
  files?: Array<{
    mediaType?: string;
    base64?: string;
    filename?: string | null;
  }>;
  sessionId?: string; // Orchestrator session ID (for linked agent sessions)
  agentId?: string; // Agent runtime scope ID
  // Harness profile ("Mind") to power this turn; sticky on the session.
  profileId?: string;
  // Stable id for one user "turn" across multi-round connector loops
  turnId?: string;
  memoryEnabled?: boolean;
  // Keep memory retrieval, but skip auto-writing new notes.
  suppressMemoryStore?: boolean;
  // Skip loading global preference-memory context for this turn.
  suppressPreferenceMemory?: boolean;
  // Optional metadata for persistence (not injected into model history/prompt).
  messageMetadata?: Record<string, unknown>;
  deviceId?: string;
  connectorPlatform?: ConnectorClientPlatform;
  obsidianVaultPath?: string;
  // Tool results from client-side execution (for connector tools)
  toolResults?: Array<{
    toolCallId: string;
    toolName: string;
    result: string;
  }>;
  // Handshake context (agent-to-agent communication)
  handshakeId?: string;
  handshakePartnerSessionId?: string;
  handshakePartnerName?: string;
  handshakeSelfName?: string;
};

type ClientToolResultInput = {
  toolCallId: string;
  toolName: string;
  result: string;
};

type InlineFileInput = {
  mediaType: string;
  base64: string;
  filename?: string | null;
};

const SUPPORTED_INLINE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_INLINE_IMAGE_FILES = 3;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_TOTAL_BYTES = 2 * 1024 * 1024;

function normalizeBase64ImageData(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const commaIndex = trimmed.indexOf(",");
  return (commaIndex >= 0 ? trimmed.slice(commaIndex + 1) : trimmed).replace(/\s+/g, "");
}

function sanitizeInlineFiles(value: unknown): InlineFileInput[] {
  if (!Array.isArray(value)) return [];
  const out: InlineFileInput[] = [];
  let totalBytes = 0;
  for (const raw of value) {
    if (out.length >= MAX_INLINE_IMAGE_FILES) break;
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!item) continue;
    const mediaType = typeof item.mediaType === "string" ? item.mediaType.trim().toLowerCase() : "";
    if (!SUPPORTED_INLINE_IMAGE_TYPES.has(mediaType)) continue;
    const base64 = normalizeBase64ImageData(item.base64);
    if (!base64) continue;
    const approxBytes = Math.floor((base64.length * 3) / 4);
    if (approxBytes > MAX_INLINE_IMAGE_BYTES) continue;
    if (totalBytes + approxBytes > MAX_INLINE_IMAGE_TOTAL_BYTES) continue;
    const filename =
      typeof item.filename === "string" && item.filename.trim()
        ? item.filename.trim().slice(0, 200)
        : null;
    totalBytes += approxBytes;
    out.push({ mediaType, base64, filename });
  }
  return out;
}

function asTrimmedString(value: unknown, maxLen = 4000) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.slice(0, maxLen);
}

function shouldForceVisibleBrowserTask(value: string) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  return (
    /\bcomputer use\b/.test(text) ||
    /\bcomputer-use\b/.test(text) ||
    /\bcomputer browser\b/.test(text) ||
    /\buse (?:the )?computer(?:\s+use)?\b/.test(text) ||
    /\buse (?:the )?computer browser\b/.test(text) ||
    /\buse chrome\b/.test(text) ||
    /\bopen chrome\b/.test(text) ||
    /\bopen (?:the )?browser\b/.test(text) ||
    /\bvisible browser\b/.test(text) ||
    /\bbrowse visibly\b/.test(text) ||
    /\bshow (?:me )?(?:the )?(?:browser|chrome)\b/.test(text) ||
    /\bwatch (?:the )?(?:browser|chrome)\b/.test(text)
  );
}

async function buildEnterpriseDemoPromptBlock(args: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  filesSessionId: string | null;
  queryText: string;
  targetUrl: string;
}) {
  const { supabase, filesSessionId, queryText, targetUrl } = args;

  let docExcerptBlock = "";

  if (filesSessionId) {
    try {
      let excerpts: string[] = [];

      if (queryText) {
        const embedding = await embedText(queryText).catch(() => []);
        if (Array.isArray(embedding) && embedding.length > 0) {
          const vector = embeddingToVectorLiteral(embedding);
          const { data: matches } = await supabase.rpc("match_chat_doc_chunks", {
            p_session_id: filesSessionId,
            p_embedding: vector,
            p_match_count: 6,
          });

          excerpts = Array.isArray(matches)
            ? matches
                .map((match) =>
                  match && typeof match === "object" && typeof match.content === "string"
                    ? match.content.trim()
                    : ""
                )
                .filter(Boolean)
                .slice(0, 6)
            : [];
        }
      }

      if (excerpts.length === 0) {
        const { data: latestAttachment } = await supabase
          .from("chat_attachments")
          .select("id, file_name")
          .eq("session_id", filesSessionId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const attachmentId =
          latestAttachment && typeof latestAttachment.id === "string" ? latestAttachment.id : "";
        const attachmentName =
          latestAttachment && typeof latestAttachment.file_name === "string"
            ? latestAttachment.file_name
            : "latest upload";

        if (attachmentId) {
          const { data: fallbackChunks } = await supabase
            .from("chat_doc_chunks")
            .select("content, chunk_index")
            .eq("session_id", filesSessionId)
            .eq("attachment_id", attachmentId)
            .order("chunk_index", { ascending: true })
            .limit(6);

          const fallbackExcerpts = Array.isArray(fallbackChunks)
            ? fallbackChunks
                .map((chunk) =>
                  chunk && typeof chunk === "object" && typeof chunk.content === "string"
                    ? chunk.content.trim()
                    : ""
                )
                .filter(Boolean)
                .slice(0, 6)
            : [];

          if (fallbackExcerpts.length > 0) {
            excerpts = fallbackExcerpts;
            docExcerptBlock = `Latest uploaded document (${attachmentName}) excerpts:\n${fallbackExcerpts
              .map((excerpt, idx) => `(${idx + 1}) ${excerpt}`)
              .join("\n\n")}`;
          }
        }
      }

      if (!docExcerptBlock && excerpts.length > 0) {
        docExcerptBlock = `Relevant uploaded document excerpts:\n${excerpts
          .map((excerpt, idx) => `(${idx + 1}) ${excerpt}`)
          .join("\n\n")}`;
      }
    } catch (error) {
      console.warn("[orchestrator] Failed to build enterprise demo doc context:", error);
    }
  }

  const lines = [
    "## ENTERPRISE REVIEW CONTEXT",
    "This is supplemental context for the current review only. Keep the normal orchestrator behavior, tool access, and tool-selection logic unchanged.",
    targetUrl
      ? `Company URL / reference site: ${targetUrl}`
      : "No company URL has been set for this review session.",
    docExcerptBlock || "No uploaded document excerpts were found for this review session yet.",
    "Use this company context alongside the user's request when assessing fit, comparing requirements, or evaluating external pages.",
    "Do not mention internal flags or implementation details.",
  ].filter(Boolean);

  return `\n\n${lines.join("\n\n")}`;
}

function sanitizeMessages(input: ModelMessage[]): ModelMessage[] {
  return input
    .map((m) => {
      if (typeof m.content === "string") {
        const trimmed = m.content.trim();
        return trimmed ? { ...m, content: trimmed } : null;
      }

      // Content-part format (defensive; current UI sends strings)
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

function parseStepBudget(
  raw: string | undefined,
  fallback: number,
  opts?: { min?: number; max?: number }
): number {
  const min = typeof opts?.min === "number" ? opts.min : 1;
  const max = typeof opts?.max === "number" ? opts.max : 50;
  const normalizedFallback = Math.min(max, Math.max(min, Math.floor(fallback)));
  const rawTrimmed = typeof raw === "string" ? raw.trim() : "";
  if (!rawTrimmed) return normalizedFallback;
  const parsed = Number(rawTrimmed);
  if (!Number.isFinite(parsed)) return normalizedFallback;
  const rounded = Math.floor(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function formatOrchestratorError(err: unknown): string {
  if (err instanceof Error) {
    const name = typeof err.name === "string" ? err.name.trim() : "";
    const message = typeof err.message === "string" ? err.message.trim() : "";
    if (name && message) return `${name}: ${message}`;
    if (message) return message;
    if (name) return name;
  }

  if (typeof err === "string" && err.trim()) return err.trim();

  if (err && typeof err === "object" && !Array.isArray(err)) {
    const record = err as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const message = typeof record.message === "string" ? record.message.trim() : "";
    if (name && message) return `${name}: ${message}`;
    if (message) return message;
    if (name) return name;
    try {
      const json = JSON.stringify(record);
      if (json && json !== "{}") return json;
    } catch {
      // fall through
    }
  }

  return String(err);
}

function isSensitiveSignedUrl(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  try {
    const url = new URL(text);
    const path = url.pathname.toLowerCase();
    if (path.includes("/storage/v1/object/sign/")) return true;
    const sensitiveKeys = [
      "token",
      "sig",
      "signature",
      "expires",
      "expiry",
      "x-amz-signature",
      "x-amz-credential",
      "x-amz-security-token",
      "x-goog-signature",
      "x-goog-credential",
      "x-goog-expires",
    ];
    for (const key of url.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (sensitiveKeys.some((s) => lower.includes(s))) return true;
    }
  } catch {
    // Non-URL strings are handled as non-sensitive here.
  }
  return false;
}

function summarizeFilesForLog(files: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(files)) return [];
  return files.slice(0, 5).map((raw) => {
    const f = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const fileName =
      (typeof f.filename === "string" && f.filename) ||
      (typeof f.name === "string" && f.name) ||
      "output";
    const mediaType =
      (typeof f.mime_type === "string" && f.mime_type) ||
      (typeof f.mediaType === "string" && f.mediaType) ||
      "application/octet-stream";
    const url = typeof f.url === "string" ? f.url : "";
    const redactedUrl = url
      ? isSensitiveSignedUrl(url)
        ? "[redacted_signed_url]"
        : url.slice(0, 200)
      : undefined;
    return {
      name: fileName,
      mediaType,
      hasUrl: !!url,
      urlPreview: redactedUrl,
      hasStoragePath:
        typeof f.storage_path === "string" && f.storage_path.trim().length > 0,
      hasFileId: typeof f.file_id === "string" && f.file_id.trim().length > 0,
    };
  });
}

function isRetryableAgentSdkError(err: unknown): boolean {
  const message = formatOrchestratorError(err).toLowerCase();

  // Deterministic/configuration failures should fail fast with exact error.
  const nonRetryableSignals = [
    "pathtoclaudecodeexecutable",
    "executable not found",
    "missing_api_key",
    "invalid api key",
    "authentication",
    "unauthorized",
    "forbidden",
    "permission denied",
    "no api key configured",
  ];
  if (nonRetryableSignals.some((signal) => message.includes(signal))) {
    return false;
  }

  // Transient transport/provider failures should use exponential backoff.
  const retryableSignals = [
    "rate limit",
    "429",
    "500",
    "502",
    "503",
    "504",
    "timeout",
    "timed out",
    "temporarily unavailable",
    "overloaded",
    "network",
    "socket hang up",
    "econnreset",
    "eai_again",
    "enotfound",
    "etimedout",
    "ehostunreach",
    // Agent SDK may intermittently end without a usable result payload.
    "did not emit a result event",
    "received an empty result event",
    "no assistant text or tool events",
  ];
  return retryableSignals.some((signal) => message.includes(signal));
}

function computeExponentialBackoffMs(attempt: number): number {
  const baseMs = 500;
  const maxMs = 4000;
  const power = Math.max(0, attempt - 1);
  return Math.min(maxMs, baseMs * 2 ** power);
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isLikelySiteWorkflow(args: {
  routingText: string;
  history: ModelMessage[];
  toolResults: ClientToolResultInput[];
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

export async function POST(req: Request) {
  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch (err) {
    console.error("[orchestrator] Failed to create Supabase client:", err);
    return NextResponse.json(
      { error: "Service temporarily unavailable. Please try again." },
      { status: 503 }
    );
  }

  let user;
  try {
    const { data, error: userError } = await supabase.auth.getUser();
    if (userError) {
      console.error("[orchestrator] Auth error:", userError);
      return NextResponse.json({ error: "Please sign in again" }, { status: 401 });
    }
    user = data.user;
  } catch (err) {
    console.error("[orchestrator] Auth check failed:", err);
    return NextResponse.json(
      { error: "Authentication service unavailable. Please try again." },
      { status: 503 }
    );
  }

  if (!user) {
    return NextResponse.json({ error: "Please sign in" }, { status: 401 });
  }
  try {
    if (await isChannelGuestUser({ userId: user.id })) {
      return NextResponse.json(
        {
          error:
            "Channel guests can use Groovy only inside channels they were invited to.",
        },
        { status: 403 },
      );
    }
  } catch (error) {
    console.error("[orchestrator] Guest access check failed:", error);
    return NextResponse.json(
      { error: "Could not verify workspace access. Please try again." },
      { status: 503 },
    );
  }

  try {
    const access = await getProductAccessForUser({ userId: user.id });
    if (!access.hasAccess) {
      return NextResponse.json(
        {
          error:
            access.workspaceOwnerRequired
              ? "This workspace needs an active plan. Ask a workspace admin to activate Groovy."
              : access.accessStatus === "trial_available"
              ? "Start your free 5-day trial to use the orchestrator."
              : "Your free trial has ended. Purchase a Groovy license to continue.",
          code: access.accessStatus === "trial_available" ? "trial_not_started" : "license_required",
          accessStatus: access.accessStatus,
          trial: access.trial,
        },
        { status: 402 }
      );
    }
  } catch (error) {
    console.error("[orchestrator] License access check failed:", error);
    return NextResponse.json(
      { error: "Could not verify Groovy access. Please refresh and try again." },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const rawMessage = typeof body.message === "string" ? body.message : "";
  const historyRaw = Array.isArray(body.history) ? body.history : [];
  const history = sanitizeMessages(historyRaw);
  const inlineFiles = sanitizeInlineFiles(body.files);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const requestedAgentId =
    typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : null;
  const turnId =
    typeof body.turnId === "string" && body.turnId.trim() ? body.turnId.trim() : null;
  const memoryEnabled = body.memoryEnabled !== false;
  const memoryStoreEnabled = body.suppressMemoryStore !== true;
  const requestMessageMetadata =
    body.messageMetadata && typeof body.messageMetadata === "object"
      ? (body.messageMetadata as Record<string, unknown>)
      : null;
  const enterpriseDemoConfig = getEnterpriseDemoConfig();
  const isEnterpriseDemoRequest =
    requestMessageMetadata?.enterprise_demo === true &&
    enterpriseDemoConfig.enabled &&
    enterpriseDemoConfig.userId === user.id;
  const enterpriseDemoTargetUrl = isEnterpriseDemoRequest
    ? asTrimmedString(requestMessageMetadata?.enterprise_target_url, 2048)
    : "";
  const isAutoHandshakeTurn = requestMessageMetadata?.handshake_auto_trigger === true;
  const requestedDeviceId =
    typeof body.deviceId === "string" && body.deviceId.trim() ? body.deviceId.trim() : null;
  const connectorPlatform =
    typeof body.connectorPlatform === "string" && body.connectorPlatform.trim()
      ? normalizeConnectorPlatform(body.connectorPlatform)
      : detectConnectorPlatformFromUserAgent(req.headers.get("user-agent") || "");
  const obsidianVaultPath =
    typeof body.obsidianVaultPath === "string" ? body.obsidianVaultPath : null;

  const resolveOwnedDeviceId = async (candidateId: string | null): Promise<string | null> => {
    if (!candidateId) return null;
    try {
      const { data: owned } = await supabase
        .from("devices")
        .select("id")
        .eq("user_id", user.id)
        .eq("id", candidateId)
        .limit(1)
        .maybeSingle();
      return owned?.id ? String(owned.id) : null;
    } catch {
      return null;
    }
  };

  let deviceId = await resolveOwnedDeviceId(requestedDeviceId);
  if (!deviceId) {
    // Fallback 1: user's preferred connector device from onboarding preferences.
    try {
      const { data: prefs } = await supabase
        .from("user_preferences")
        .select("onboarding_data")
        .eq("user_id", user.id)
        .maybeSingle();
      const onboardingData =
        prefs?.onboarding_data && typeof prefs.onboarding_data === "object"
          ? (prefs.onboarding_data as Record<string, unknown>)
          : null;
      const preferredRaw =
        onboardingData && typeof onboardingData.connectorDeviceId === "string"
          ? onboardingData.connectorDeviceId.trim()
          : "";
      deviceId = await resolveOwnedDeviceId(preferredRaw || null);
    } catch {
      // ignore preference fallback failures
    }
  }
  if (!deviceId) {
    // Fallback 2: latest owned connector device.
    try {
      const { data: latest } = await supabase
        .from("devices")
        .select("id")
        .eq("user_id", user.id)
        .order("last_seen", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      deviceId = latest?.id ? String(latest.id) : null;
    } catch {
      deviceId = null;
    }
  }

  const hasAnyHistory = history.length > 0;
  const hasToolResults = Array.isArray(body.toolResults) && body.toolResults.length > 0;
  if (!rawMessage.trim() && !hasToolResults && !hasAnyHistory) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  const isSyntheticToolResultsUserMessage = (content: string) => {
    const t = content.trim();
    if (!t) return false;
    if (t.startsWith("[SYSTEM: Tool execution results")) return true;
    if (t.includes("<tool_result")) return true;
    return false;
  };

  const historyWithoutSyntheticToolResults = history.filter((m) => {
    if (m.role !== "user") return true;
    if (typeof m.content !== "string") return true;
    return !isSyntheticToolResultsUserMessage(m.content);
  });

  // For continuation requests (toolResults with empty message), route using the last user message.
  const lastUserMessage = (() => {
    for (let i = historyWithoutSyntheticToolResults.length - 1; i >= 0; i--) {
      const m = historyWithoutSyntheticToolResults[i];
      if (m.role !== "user") continue;
      if (typeof m.content !== "string") continue;
      const t = m.content.trim();
      if (t) return t;
    }
    return "";
  })();

  const routingText = rawMessage.trim() ? rawMessage : lastUserMessage;
  const parsed = parseInput(routingText);
  const forceVisibleBrowserTask =
    shouldForceVisibleBrowserTask(routingText) || parsed.mentionedAgents.includes("browser");
  const clientToolResults: ClientToolResultInput[] = (body.toolResults || []).filter(
    (tr): tr is ClientToolResultInput =>
      typeof tr?.toolCallId === "string" &&
      typeof tr?.toolName === "string" &&
      typeof tr?.result === "string"
  );
  const siteWorkflowMode = isLikelySiteWorkflow({
    routingText,
    history: historyWithoutSyntheticToolResults,
    toolResults: clientToolResults,
    directAgent: parsed.directAgent,
  });

  // Resolve the profile before fast paths or tool construction.
  const requestedProfileSelection =
    typeof body.profileId === "string" && body.profileId.trim()
      ? body.profileId.trim()
      : null;
  const explicitlyBuiltIn = requestedProfileSelection === "__default__";
  const requestedProfileId = explicitlyBuiltIn ? null : requestedProfileSelection;
  let sessionProfileId: string | null = null;
  if (sessionId) {
    const { data: sessionRow, error: sessionProfileError } = await supabase
      .from("orchestrator_sessions")
      .select("profile_id")
      .eq("id", sessionId)
      .maybeSingle();
    if (sessionProfileError) {
      return NextResponse.json(
        { error: "Could not resolve the profile bound to this session." },
        { status: 500 },
      );
    }
    sessionProfileId = (sessionRow?.profile_id as string | null) ?? null;
  }
  const harnessProfile = explicitlyBuiltIn
    ? null
    : await resolveHarnessProfile(supabase, {
        userId: user.id,
        explicitProfileId: requestedProfileId,
        sessionProfileId,
      });
  if (requestedProfileId && harnessProfile?.id !== requestedProfileId) {
    return NextResponse.json(
      { error: "The selected profile does not exist or is not available to this user." },
      { status: 404 },
    );
  }
  if (sessionProfileId && !requestedProfileId && !explicitlyBuiltIn && !harnessProfile) {
    return NextResponse.json(
      { error: "The profile bound to this session is no longer available." },
      { status: 409 },
    );
  }
  // Persist an explicit selection before any fast path (including `remember`)
  // can return. The built-in sentinel intentionally clears a prior sticky
  // profile; omitting profileId continues to mean "use this session's binding
  // or the configured workspace/personal default".
  if (
    sessionId &&
    requestedProfileSelection &&
    (
      (explicitlyBuiltIn && sessionProfileId !== null) ||
      (
        requestedProfileId &&
        harnessProfile?.id === requestedProfileId &&
        sessionProfileId !== requestedProfileId
      )
    )
  ) {
    const { error: stickyProfileError } = await supabase
      .from("orchestrator_sessions")
      .update({ profile_id: explicitlyBuiltIn ? null : requestedProfileId })
      .eq("id", sessionId);
    if (stickyProfileError) {
      return NextResponse.json(
        { error: "Could not update the profile bound to this session." },
        { status: 500 },
      );
    }
    sessionProfileId = explicitlyBuiltIn ? null : requestedProfileId;
  }
  if (
    sessionId &&
    !requestedProfileSelection &&
    !sessionProfileId &&
    harnessProfile
  ) {
    const { error: defaultProfileBindError } = await supabase
      .from("orchestrator_sessions")
      .update({ profile_id: harnessProfile.id })
      .eq("id", sessionId)
      .is("profile_id", null);
    if (defaultProfileBindError) {
      return NextResponse.json(
        { error: "Could not bind the default profile to this session." },
        { status: 500 },
      );
    }
    sessionProfileId = harnessProfile.id;
  }
  const toolPolicy = buildToolPolicyExecutionContext({
    profile: harnessProfile,
    provider: "dashboard",
  });

  // Explicit remember commands bypass the main model but still use hybrid
  // Datagran + Wiki storage.
  if (
    parsed.isRememberCommand &&
    parsed.rememberContent &&
    isToolAllowed("remember", toolPolicy)
  ) {
    const connectionId = await getGroovyMemoryConnection(
      user.id,
      user.email || undefined,
      supabase,
      harnessProfile?.memoryScope === "profile" ? harnessProfile.id : undefined,
    );
    const stored = await storeDurableLearning(
      connectionId || "",
      parsed.rememberContent,
      undefined,
      {
        wiki: {
          supabase,
          userId: user.id,
          source: "explicit remember command",
          profileId:
            harnessProfile?.memoryScope === "profile" ? harnessProfile.id : undefined,
        },
      }
    );
    return NextResponse.json({
      message: formatDurableLearningConfirmation(parsed.rememberContent, stored),
      remembered: stored.stored,
      datagranStored: stored.datagranStored,
      wikiFiled: stored.wikiFiled,
      wikiPath: stored.wikiPath,
    });
  }

  // Resolve per-provider key modes and decrypt user keys
  const cookie = req.headers.get("cookie") || "";
  const resolved = await resolveKeys(user.id, supabase, cookie);

  // User-selected orchestrator "brain" model (stored on the orchestrator-runtime
  // agents row) overrides the env-resolved default when configured.
  const orchestratorModelOverride = await resolveOrchestratorModelOverride({
    supabase,
    userId: user.id,
    agentId:
      typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : null,
    resolved,
    selectionOverride: harnessProfile?.model
      ? {
          provider: harnessProfile.model.provider,
          model: harnessProfile.model.model,
          reasoningEffort: harnessProfile.model.reasoningEffort,
        }
      : undefined,
  });
  if (harnessProfile?.model && !orchestratorModelOverride) {
    return NextResponse.json(
      {
        error: `The profile model ${harnessProfile.model.model} cannot run because its ${harnessProfile.model.provider} API key is not configured.`,
      },
      { status: 400 },
    );
  }
  const mainProvider = orchestratorModelOverride?.provider ?? resolved.provider;
  const provider: ProviderId = mainProvider;
  const modelName = orchestratorModelOverride?.modelName ?? resolved.modelName;
  const apiKey = orchestratorModelOverride
    ? orchestratorModelOverride.apiKey
    : resolved.apiKey;
  const mainKeyMode = resolved.keyModes[mainProvider] || resolved.globalMode;

  // Validate we have a usable key for the main LLM call
  if (mainKeyMode === "user" && !apiKey) {
    return NextResponse.json(
      { error: "No API key configured. Add your model provider key in Settings." },
      { status: 400 }
    );
  }
  if (
    mainKeyMode === "groovy" &&
    ((mainProvider === "anthropic" && !process.env.ANTHROPIC_API_KEY) ||
      (mainProvider === "openai" && !process.env.OPENAI_API_KEY))
  ) {
    return NextResponse.json(
      { error: "Server provider API keys are not configured. Add provider keys or configure customer-owned keys." },
      { status: 500 }
    );
  }

  const anthropicProviderOptions = getAnthropicContextProviderOptions(provider, modelName);
  const contextBudget = getModelContextBudget(provider, modelName, anthropicProviderOptions);

  // Create trace ID for logging correlation (also used for billing event idempotency within this request)
  const traceId = `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const effectiveTurnId = turnId || traceId;
  const usageChargeType = usageChargeTypeForKeyMode(mainKeyMode);
  const connectorClaudeChargeType = resolved.claudeCliToken
    ? "external_key_fee"
    : usageChargeTypeForKeyMode(resolved.keyModes.anthropic || resolved.globalMode);
  const billingWorkspaceId = await getOrCreateWorkspaceIdForUser({
    userId: user.id,
    email: user.email || null,
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
      }).catch(() => null)
    : null;

  if (billingWorkspaceId) {
    const preflight = await preflightGroovyUsage({
      workspaceId: billingWorkspaceId,
      userId: user.id,
      userEmail: user.email || null,
      traceId,
      source: "orchestrator_api",
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

  const billGroovyUsage = async (args: {
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
      userId: user.id,
      traceId,
      turnId: effectiveTurnId,
      source: args.source,
      spanId: args.spanId,
      model: args.model || modelName,
      usage: args.usage,
      modelCostUsdOverride: args.modelCostUsdOverride || null,
      chargeType: usageChargeType,
      meta: args.meta,
    }).catch(() => {});
  };

  // Resolve memory connection for on-demand memory tools (recall/remember).
  // Do not preload memory context into the prompt; the model should decide when to call recall.
  const memoryContext = "";
  const preferenceContext = "";
  let memoryConnectionId: string | null = null;
  const ensureMemoryConnectionId = async (): Promise<string | null> => {
    if (!memoryEnabled) return null;
    if (memoryConnectionId) return memoryConnectionId;
    memoryConnectionId = await getGroovyMemoryConnection(
      user.id,
      user.email || undefined,
      supabase,
      harnessProfile?.memoryScope === "profile" ? harnessProfile.id : undefined,
    );
    return memoryConnectionId;
  };

  if (memoryEnabled) {
    console.log("[orchestrator] Memory preload disabled (tool-invoked only)", {
      traceId,
      historyCount: historyWithoutSyntheticToolResults.length,
    });
  }

  // Determine which agents to enable
  const activeAgents = getToolsForRouting(parsed.directAgent);

  // Gather web pixel names (as shown in dashboard) so the model can choose correctly
  let webPixelNames: string[] = [];
  try {
    const { data: pxRows } = await supabase
      .from("datagran_agent_configs")
      .select("provider, connection_id, agents!datagran_agent_configs_agent_id_fkey(name)")
      .eq("user_id", user.id)
      .eq("provider", "web_pixel")
      .not("connection_id", "is", null)
      .limit(50);
    webPixelNames =
      (pxRows || [])
        .map((r) => {
          const row = r as unknown as { agents?: { name?: unknown } | null };
          const name = row.agents?.name;
          return typeof name === "string" ? name : null;
        })
        .filter((n): n is string => typeof n === "string" && n.trim().length > 0);
  } catch (e) {
    console.warn("[orchestrator] Failed to load web pixel names:", e);
  }

  // Gather Claude Code sessions (named terminal sessions) so the model can open one in the UI.
  // Only include sessions that have a valid device+workspace config.
  let codeSessions: Array<{ id: string; name: string }> = [];
  try {
    const { data: ccRows } = await supabase
      .from("claude_code_agent_configs")
      .select("agent_id, agents!inner(id,name)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    codeSessions =
      (ccRows || [])
        .map((r) => {
          const agent = r.agents as unknown as { id?: string; name?: string } | null;
          if (!agent) return null;
          return {
            id: typeof agent.id === "string" ? agent.id : "",
            name: typeof agent.name === "string" ? agent.name : "",
          };
        })
        .filter((r): r is { id: string; name: string } => !!r && !!r.id && !!r.name);
  } catch (e) {
    console.warn("[orchestrator] Failed to load code sessions:", e);
  }

  // Look up linked Files agent session (if orchestrator session provided)
  let filesAgent: { agentId: string; sessionId: string } | null = null;
  if (sessionId) {
    try {
      const { data: link } = await supabase
        .from("orchestrator_agent_sessions")
        .select("agent_session_id, chat_sessions!inner(agent_id)")
        .eq("orchestrator_session_id", sessionId)
        .eq("agent_type", "files")
        .single();
      if (link) {
        const cs = link.chat_sessions as unknown as { agent_id?: string } | null;
        const agentId = cs?.agent_id;
        if (typeof agentId === "string" && typeof link.agent_session_id === "string") {
          filesAgent = { agentId, sessionId: link.agent_session_id };
        }
      }
    } catch {
      // No linked Files agent session - that's OK
    }
  }

  const enterpriseDemoPromptBlock = isEnterpriseDemoRequest
    ? await buildEnterpriseDemoPromptBlock({
        supabase,
        filesSessionId: filesAgent?.sessionId || null,
        queryText: routingText.trim(),
        targetUrl: enterpriseDemoTargetUrl,
      })
    : "";

  // Track agent activities for the response
  const agentActivities: AgentActivity[] = [];
  // Tool stream emitter (wired after SSE stream starts)
  let toolStreamEmitter: ((data: { toolName: string; text: string }) => void) | null = null;

  // Build apiKeys + claudeCliToken for tool context using per-provider resolver
  const { apiKeys: toolApiKeys, claudeCliToken } = buildToolApiKeys(resolved);
  const runtimeScope = await resolveRuntimeScope({
    supabase,
    userId: user.id,
    sessionId,
    agentId: requestedAgentId,
  });
  const branchControllerSettings = await loadBranchControllerSettings(supabase, user.id);
  const effectiveRuntimeScope = runtimeScope;
  const effectiveAgentId =
    effectiveRuntimeScope?.agentId ||
    requestedAgentId ||
    (await ensureOrchestratorRuntimeAgentId(supabase, user.id));
  const dynamicSkillTools = effectiveAgentId
    ? await loadActiveSkillRuntimeTools({
        supabase,
        userId: user.id,
        agentId: effectiveAgentId,
        epochId: effectiveRuntimeScope?.epochId || null,
        branchId: effectiveRuntimeScope?.branchId || null,
      })
    : [];
  const allDynamicExtensionTools = await loadInstalledExtensionRuntimeTools({
    supabase,
    userId: user.id,
  });
  const extensionCatalog = await listExtensionsForUser({
    supabase,
    userId: user.id,
  }).catch((error) => {
    console.warn(
      "[orchestrator] extension catalog unavailable:",
      error instanceof Error ? error.message : String(error)
    );
    return [] as Array<Record<string, unknown>>;
  });
  const dynamicExtensionTools = selectRelevantExtensionRuntimeTools({
    tools: allDynamicExtensionTools,
    queryText: routingText,
    recentTexts: buildExtensionSelectionRecentTexts(history),
  }).filter((tool) => isToolAllowed(tool.toolName, toolPolicy));

  let telegramBotToken: string | undefined;
  try {
    const { data: tgConfig } = await supabase
      .from("telegram_bot_configs")
      .select("bot_token_encrypted")
      .eq("user_id", user.id)
      .maybeSingle();
    if (tgConfig?.bot_token_encrypted) {
      telegramBotToken = decryptTelegramBotToken(tgConfig.bot_token_encrypted);
    }
  } catch {
    // ignore - telegram not configured
  }

  // Create tool execution context
  const toolContext: ToolExecutionContext = {
    userId: user.id,
    integrationOwnerUserId: integrationOwnerUserId || user.id,
    toolPolicy,
    harnessProfile,
    traceId,
    turnId: effectiveTurnId,
    billingWorkspaceId,
    appBaseUrl: getAppUrl(),
    deviceId,
    connectorPlatform,
    obsidianVaultPath,
    directAgent: parsed.directAgent,
    orchestratorAgentId: effectiveAgentId,
    branchControllerMode: branchControllerSettings.mode,
    branchControllerMaxBranches: branchControllerSettings.maxBranches,
    branchControllerMaxTurnsPerBranch: branchControllerSettings.maxTurnsPerBranch,
    branchCurrentTurnCount: effectiveRuntimeScope?.branchTurnCount ?? null,
    branchActiveCount: effectiveRuntimeScope?.activeBranchCount ?? null,
    runtimeEpochId: effectiveRuntimeScope?.epochId || null,
    runtimeBranchId: effectiveRuntimeScope?.branchId || null,
    branchRole: "main",
    branchGoal: null,
    orchestratorSessionId: sessionId,
    datagranConnectionId: memoryConnectionId,
    supabase,
    // Forward cookies for auth when calling sub-agents
    cookies: req.headers.get("cookie") || undefined,
    // Files agent session info (for document creation requests)
    filesAgent,
    // API keys for connector tools (claude_run, etc.)
    apiKeys: toolApiKeys,
    // Claude headless CLI OAuth token (from `claude setup-token`)
    claudeCliToken,
    // Force visible computer-use when the user explicitly asks for it.
    forceVisibleBrowserTask,
    // Stream tool output (for long-running tools like files_agent_request)
    onToolStream: (data) => {
      if (toolStreamEmitter) toolStreamEmitter(data);
    },
    // Callback to track agent activity
    onAgentActivity: (activity) => {
      agentActivities.push(activity);
      console.log(
        "[orchestrator-activity]",
        JSON.stringify({
          traceId,
          agentId: activity.agentId,
          agentName: activity.agentName,
          status: activity.status,
          message: activity.message?.slice(0, 200),
        })
      );
    },
    // Note: relaySend is not available server-side
    // Connector tools will return instructions for client-side execution
    codeSessions,
    webPixelNames,
    // In site workflows, keep operations inside code_cli_run + site tools to prevent
    // terminal ls/find/cat loops.
    disableTerminalExec: siteWorkflowMode,
    // Handshake context (agent-to-agent communication)
    // Auto-handshake turns must not call handshake_send again, otherwise we can
    // bounce between panes and create duplicate/mixed messages.
    activeHandshakeId:
      !isAutoHandshakeTurn && typeof body.handshakeId === "string"
        ? body.handshakeId
        : null,
    handshakePartnerSessionId:
      !isAutoHandshakeTurn && typeof body.handshakePartnerSessionId === "string"
        ? body.handshakePartnerSessionId
        : null,
    handshakePartnerName:
      !isAutoHandshakeTurn && typeof body.handshakePartnerName === "string"
        ? body.handshakePartnerName
        : null,
    telegramBotToken,
  };

  // Get executable tools. Native Anthropic web search is provider-executed and
  // only added to the AI SDK streamText path; the Agent SDK path gets WebSearch
  // as an explicit built-in instead.
  const executableTools = createExecutableTools(toolContext, dynamicSkillTools, dynamicExtensionTools);
  const nativeWebSearchEnabled =
    isAnthropicNativeWebSearchEnabled(provider) &&
    isToolAllowed("web_search", toolPolicy);
  const tools = nativeWebSearchEnabled
    ? addAnthropicNativeWebSearchTool(executableTools, {
        provider,
      })
    : executableTools;

  // Build system prompt with agent capabilities
  const promptSegments = buildOrchestratorPrompt(
    memoryContext,
    preferenceContext,
    activeAgents,
    parsed.mentionedAgents,
    !!deviceId,
    new Date().toISOString(),
    webPixelNames,
    !!filesAgent,
    {
      role: "main",
      mode: branchControllerSettings.mode,
      maxBranches: branchControllerSettings.maxBranches,
      maxTurnsPerBranch: branchControllerSettings.maxTurnsPerBranch,
      activeBranches: effectiveRuntimeScope?.activeBranchCount ?? null,
    },
    !!telegramBotToken,
    nativeWebSearchEnabled,
    harnessProfile,
  );

  // Append per-turn dynamic sections to dynamicContext
  const extraDynamic: string[] = [];

  if (deviceId) {
    await preflightAgentSkills({
      deviceId,
      agentId: effectiveAgentId,
      profileId: harnessProfile?.id || null,
      target: "flow",
    }).catch((error) => {
      console.warn(
        "[orchestrator] skills preflight failed:",
        error instanceof Error ? error.message : String(error)
      );
    });
  }
  const skillsPromptContext = await buildAssignedSkillsPromptContext({
    deviceId: deviceId || "",
    agentId: effectiveAgentId,
    profileId: harnessProfile?.id || null,
    target: "flow",
  }).catch((error) => {
    console.warn(
      "[orchestrator] skills context unavailable:",
      error instanceof Error ? error.message : String(error)
    );
    return { text: "", artifactCount: 0 };
  });
  if (skillsPromptContext.text) {
    extraDynamic.push(`\n\n${skillsPromptContext.text}`);
  }

  if (codeSessions.length > 0) {
    extraDynamic.push(`\n\n## CODE (Claude Code CLI)\nThe user has ${codeSessions.length} Code session(s) configured in the dashboard:\n${codeSessions
      .map((s) => `- ${s.name}`)
      .join("\n")}\n\nWhen the user asks to open/switch to a coding session (including messages like "@code <session name>"), call the tool code_open_session with the exact session name.`);
  }

  const extensionCatalogPromptBlock = buildExtensionCatalogPromptBlock(
    parsed.directAgent === "code" ? [] : extensionCatalog,
    { currentAgentId: effectiveAgentId }
  );
  if (extensionCatalogPromptBlock) {
    extraDynamic.push(extensionCatalogPromptBlock);
  }

  const extensionPromptBlock = buildExtensionPromptBlock(
    parsed.directAgent === "code" ? [] : dynamicExtensionTools
  );
  if (extensionPromptBlock) {
    extraDynamic.push(extensionPromptBlock);
  }

  // Handshake: inject collaboration context into the system prompt
  if (!isAutoHandshakeTurn && body.handshakeId && body.handshakePartnerName) {
    const selfName =
      typeof body.handshakeSelfName === "string" && body.handshakeSelfName.trim()
        ? body.handshakeSelfName.trim()
        : "this agent";
    const partnerName = body.handshakePartnerName.trim();
    extraDynamic.push(`\n\n## Active Handshake

You are currently acting as: "${selfName}".
You are connected to another agent session: "${partnerName}".
You have a \`handshake_send\` tool available. Use it when you need to:
- Send results, data, or findings to "${partnerName}"
- Ask "${partnerName}" for information or help
- Collaborate on the user's request by exchanging information

Identity rules (critical):
- "${partnerName}" is your partner, NOT your identity.
- Never claim to be "${partnerName}".
- If asked your name/origin/persona, answer as "${selfName}".

The partner agent may also send you messages. Always acknowledge received handshake messages and act on them as instructed by the user.`);
  }
  if (isAutoHandshakeTurn) {
    const partnerName =
      typeof body.handshakePartnerName === "string" && body.handshakePartnerName.trim()
        ? body.handshakePartnerName.trim()
        : "the partner agent";
    extraDynamic.push(`\n\n## Handshake Auto-Reply

You are handling a background handshake message from "${partnerName}".
Reply directly with the requested info based on your own session knowledge.
Do not ask "${partnerName}" to repeat the request, and do not attempt another handshake handoff in this turn.`);
  }

  if (filesAgent) {
    extraDynamic.push(`\n\n## FILES AGENT (Capability Context)
A Files agent session is active.

Use files_agent_request when the next deliverable requires:
- binary/document extraction or transformation (xlsx/csv/pdf/docx/pptx), or
- generating downloadable file artifacts (xlsx/csv/png/pdf/pptx/docx).

Do not default to files_agent_request when another tool is a better capability fit for the next deliverable.
After file extraction, re-evaluate tool choice for execution/verification steps.`);
  }
  if (enterpriseDemoPromptBlock) {
    extraDynamic.push(enterpriseDemoPromptBlock);
  }
  if (forceVisibleBrowserTask) {
    extraDynamic.push(`\n\n## BROWSER MODE FOR THIS TURN
The user explicitly asked for visible computer-use browsing.
For browser work in this turn, use browser_task instead of the low-level browser DOM tools.`);
  }

  // Merge extra dynamic sections into the dynamic context
  const fullDynamicContext = promptSegments.dynamicContext + extraDynamic.join("");
  // Flat string for logging / non-cache-aware consumers
  const systemPrompt =
    promptSegments.stableInstructions +
    "\n\n" +
    fullDynamicContext +
    "\n\n" +
    promptSegments.terminalInstructions;

  // Build messages (never send empty text blocks to Anthropic)
  // For connector tool results from client, inject them as a user message with structured data.
  // We include a marker so the model knows these are results from tools it previously requested.
  if (clientToolResults.length > 0) {
    const summarizeOne = (tr: { toolCallId: string; toolName: string; result: string }) => {
      try {
        const parsedUnknown: unknown = JSON.parse(tr.result);
        const parsed =
          parsedUnknown && typeof parsedUnknown === "object"
            ? (parsedUnknown as Record<string, unknown>)
            : {};
        const inner =
          parsed.result && typeof parsed.result === "object"
            ? (parsed.result as Record<string, unknown>)
            : null;
        // Connector tool results are typically { ok, ... }.
        // Some tools wrap inside { ok, result, error }.
        const ok =
          typeof parsed.ok === "boolean"
            ? parsed.ok
            : typeof inner?.ok === "boolean"
              ? inner.ok
              : undefined;

        if (tr.toolName === "whatsapp_resolve_recipient") {
          const candidates = Array.isArray(parsed.candidates)
            ? parsed.candidates
            : Array.isArray(inner?.candidates)
              ? inner.candidates
              : [];
          const exact = parsed.exact || inner?.exact || null;
          const exactObj =
            exact && typeof exact === "object" ? (exact as Record<string, unknown>) : null;
          return {
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            ok,
            candidatesLen: candidates.length,
            exactChatId: typeof exactObj?.chatId === "string" ? exactObj.chatId : undefined,
            exactName: typeof exactObj?.name === "string" ? exactObj.name : undefined,
            error:
              typeof parsed.error === "string"
                ? parsed.error
                : typeof inner?.error === "string"
                  ? inner.error
                  : undefined,
          };
        }

        if (tr.toolName === "schedule_create") {
          const jobId =
            parsed.job && typeof parsed.job === "object" && typeof (parsed.job as Record<string, unknown>).id === "string"
              ? ((parsed.job as Record<string, unknown>).id as string)
              : inner?.job && typeof inner.job === "object" && typeof (inner.job as Record<string, unknown>).id === "string"
                ? ((inner.job as Record<string, unknown>).id as string)
                : undefined;
          return { toolCallId: tr.toolCallId, toolName: tr.toolName, ok, jobId };
        }

        if (tr.toolName === "data_query") {
          const agent =
            typeof parsed.fromAgent === "string"
              ? parsed.fromAgent
              : typeof inner?.fromAgent === "string"
                ? inner.fromAgent
                : undefined;
          const agentResponseLen =
            typeof parsed.agentResponse === "string"
              ? parsed.agentResponse.length
              : typeof inner?.agentResponse === "string"
                ? inner.agentResponse.length
                : undefined;
          const filesLen = Array.isArray(parsed.files)
            ? parsed.files.length
            : Array.isArray(inner?.files)
              ? inner.files.length
              : 0;
          return { toolCallId: tr.toolCallId, toolName: tr.toolName, ok, agent, agentResponseLen, filesLen };
        }

        return { toolCallId: tr.toolCallId, toolName: tr.toolName, ok };
      } catch {
        return { toolCallId: tr.toolCallId, toolName: tr.toolName, ok: undefined };
      }
    };
    console.log("[orchestrator-tool-results-received]", JSON.stringify({
      count: clientToolResults.length,
      tools: clientToolResults.map((tr) => ({
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        resultLen: tr.result?.length,
        summary: summarizeOne(tr),
      })),
    }));
  }

  // Billing: capture connector-side Claude CLI usage if present (tokens preferred, else estimate from cost).
  if (billingWorkspaceId && clientToolResults.length > 0) {
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
    for (const tr of clientToolResults) {
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

      // Prefer explicit tokens if present.
      const usageCandidate =
        (outer && typeof outer.usage === "object" ? (outer.usage as unknown) : null) ||
        (lvl1 && typeof lvl1.usage === "object" ? (lvl1.usage as unknown) : null) ||
        (lvl2 && typeof lvl2.usage === "object" ? (lvl2.usage as unknown) : null) ||
        // Some payloads flatten token fields at top-level
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

      // If we have neither tokens nor cost, skip.
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
        userId: user.id,
        turnId: effectiveTurnId,
        // Stable idempotency per tool call
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
          userId: user.id,
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

  const toolResultMessages: ModelMessage[] = [];
  // Hard cap for individual tool results to prevent prompt explosion (target ~2k tokens per result)
  const TOOL_RESULT_MAX_CHARS = 8000;
  const lastHistoryMessageForToolResults =
    history.length > 0 ? history[history.length - 1] : null;
  const lastHistoryMessageForToolResultsContent =
    lastHistoryMessageForToolResults && typeof lastHistoryMessageForToolResults === "object"
      ? (lastHistoryMessageForToolResults as { content?: unknown }).content
      : null;
  const historyAlreadyHasSyntheticToolResultsAtEnd =
    !!lastHistoryMessageForToolResults &&
    lastHistoryMessageForToolResults.role === "user" &&
    typeof lastHistoryMessageForToolResultsContent === "string" &&
    isSyntheticToolResultsUserMessage(lastHistoryMessageForToolResultsContent);

  // If the client already appended the tool results into `history` (stateful llmHistory),
  // don't inject them again (would duplicate + bloat prompts).
  if (clientToolResults.length > 0 && !historyAlreadyHasSyntheticToolResultsAtEnd) {
    type ParsedEntry = {
      toolName: string;
      parsed: Record<string, unknown> | null;
    };
    const parsedEntries: ParsedEntry[] = clientToolResults.map((tr) => {
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
      siteWorkflowMode ||
      clientToolResults.some((tr) => tr.toolName === "site_dev") ||
      clientToolResults.some((tr) => tr.toolName === "code_cli_run" && tr.result.includes(".groovy/sites/"));

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
      clientToolResults.length > 0 &&
      clientToolResults.every((tr) => tr.toolName === "code_cli_run");
    const terminalExecCount = clientToolResults.filter((tr) => tr.toolName === "terminal_exec").length;
    const terminalLoopDetected = looksLikeSiteWorkflow && terminalExecCount >= 2;

    // Format results in a way the model understands - as a user message containing tool output
    const resultsText = clientToolResults
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
          : looksLikeSiteWorkflow && codeCliOnlyRound && clientToolResults.length >= 2
            ? `\n\nCRITICAL NEXT ACTION:\n` +
              `- You are repeating code_cli_run calls.\n` +
              `- Do one decisive scaffold/edit pass (no read-only loop), then proceed to site_dev/final.`
            : "";

    toolResultMessages.push({
      role: "user" as const,
      content:
        `[SYSTEM: Tool execution results from your previous request]\n\n${resultsText}\n\n` +
        `IMPORTANT: These are the results from the tools you requested. ` +
        `Do NOT call the same tool again unless the result indicates an error that can be retried. ` +
        `Process these results and either:\n` +
        `1. Provide the final answer to the user if you have enough information, OR\n` +
        `2. Call a DIFFERENT tool if you need additional information to complete the task.` +
        siteDirective,
    });
  }

  let effectiveHistory = history;
  if (sessionId && clientToolResults.length === 0) {
    const callerHistory = history;
    const durableContext = await buildDurableContextHistory({
      sessionId,
      authorizedUserId: user.id,
      provider,
      apiKey: apiKey || undefined,
      filter: {
        epochId: effectiveRuntimeScope?.epochId || null,
        agentId: effectiveAgentId,
        branchId: effectiveRuntimeScope?.branchId || null,
        useBranchScope: false,
      },
      fallbackHistory: history,
      onSummaryUsage: async (summaryUsage) => {
        if (!summaryUsage.usage) return;
        const checkpointSpanId = `checkpoint:v${summaryUsage.summaryVersion}`;
        if (billingWorkspaceId) {
          await insertBillingUsageEventBestEffort({
            workspaceId: billingWorkspaceId,
            userId: user.id,
            turnId: effectiveTurnId,
            traceId,
            source: "durable_context_checkpoint",
            spanId: checkpointSpanId,
            provider: summaryUsage.provider,
            model: summaryUsage.model,
            usage: summaryUsage.usage,
            billable: true,
            chargeType: usageChargeType,
            agentId: effectiveAgentId,
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
    effectiveHistory = sanitizeMessages(durableContext.history);
    effectiveHistory = reconcileCurrentUserMessage({
      durableHistory: effectiveHistory,
      callerHistory,
      currentMessage: rawMessage,
      fallbackContent: parsed.message,
    });
    if (durableContext.checkpointUpdated) {
      console.log("[orchestrator] durable context checkpoint updated", {
        traceId,
        sessionId,
        summarizedMessages: durableContext.summarizedMessages,
      });
    }
  }

  const rawMessageTrimmed = rawMessage.trim();
  const parsedMessageTrimmed = parsed.message.trim();
  const lastHistoryMessage =
    effectiveHistory.length > 0
      ? effectiveHistory[effectiveHistory.length - 1]
      : null;
  const lastHistoryMessageContent =
    lastHistoryMessage && typeof lastHistoryMessage === "object"
      ? (lastHistoryMessage as { content?: unknown }).content
      : null;
  const historyAlreadyIncludesCurrentUserMessage =
    !!rawMessageTrimmed &&
    !!lastHistoryMessage &&
    lastHistoryMessage.role === "user" &&
    typeof lastHistoryMessageContent === "string" &&
    (
      lastHistoryMessageContent.trim() === rawMessageTrimmed ||
      lastHistoryMessageContent.trim() === parsedMessageTrimmed
    );

  let messages: ModelMessage[] = sanitizeMessages([
    ...effectiveHistory,
    ...(rawMessageTrimmed && !historyAlreadyIncludesCurrentUserMessage
      ? [{ role: "user" as const, content: parsed.message }]
      : []),
    ...toolResultMessages,
  ]);

  if (inlineFiles.length > 0) {
    const targetUserIdx = messages.findLastIndex((m) => {
      if (m.role !== "user") return false;
      const content = modelMessageTextForExtensionSelection(m.content);
      return !content.startsWith("[SYSTEM: Tool execution results");
    });
    const targetText =
      rawMessageTrimmed ||
      (targetUserIdx >= 0 ? modelMessageTextForExtensionSelection(messages[targetUserIdx].content) : "") ||
      "Please analyze the attached image(s).";
    const parts: Exclude<UserContent, string> = [
      ...inlineFiles.map((file) => ({
        type: "image" as const,
        image: file.base64,
        mediaType: file.mediaType,
      })),
      { type: "text" as const, text: parsed.message || targetText },
    ];
    const buildUserMessageWithImages = (existing?: ModelMessage): ModelMessage => {
      if (existing?.role === "user" && existing.providerOptions) {
        return { role: "user", content: parts, providerOptions: existing.providerOptions };
      }
      return { role: "user", content: parts };
    };
    if (targetUserIdx >= 0) {
      messages = messages.map((m, idx) =>
        idx === targetUserIdx ? buildUserMessageWithImages(m) : m
      );
    } else {
      messages.push(buildUserMessageWithImages());
    }
  }

  if (messages.length === 0) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  // Resolve models lazily per-attempt so retries can switch model names.
  const resolveModelForName = (candidateModelName: string) =>
    resolveChatModel(
      provider,
      candidateModelName,
      apiKey ? { apiKey } : undefined
    );
  const getProviderOptionsForModel = (
    candidateModelName: string
  ): SharedV3ProviderOptions | undefined => {
    const effort = orchestratorModelOverride?.reasoningEffort;
    if (provider === "openai" && effort) {
      return {
        openai: {
          reasoningEffort: effort as "none" | "low" | "medium" | "high" | "xhigh",
        },
      };
    }
    const base = getAnthropicContextProviderOptions(provider, candidateModelName);
    if (provider === "anthropic" && effort) {
      return {
        anthropic: {
          ...(base?.anthropic || {}),
          effort: effort as "low" | "medium" | "high" | "max",
        },
      };
    }
    return base;
  };

  // Track tool calls for activity reporting
  const toolCallsExecuted: string[] = [];
  const billingToolCalls: Array<{ toolCallId: string; toolName: string; agent: string }> = [];

  console.log(
    "[orchestrator]",
    JSON.stringify({
      traceId,
      userId: user.id,
      directAgent: parsed.directAgent,
      activeAgents,
      tools: Object.keys(tools),
      messageLen: parsed.message?.length || 0,
      historyCount: history.length,
      inlineFiles: inlineFiles.map((file) => ({ mediaType: file.mediaType, filename: file.filename || null })),
    })
  );

  // Stream response with tool calling using fullStream for activity events.
  // Connector-backed tools must round-trip through the local connector before
  // the model can continue safely.
  const usesExternalConnector =
    !!deviceId &&
    (activeAgents.includes("browser") ||
      activeAgents.includes("files") ||
      activeAgents.includes("pages") ||
      activeAgents.includes("obsidian") ||
      activeAgents.includes("code"));
  const connectorStepBudget = parseStepBudget(
    process.env.ORCH_MAX_STEPS_CONNECTOR,
    6,
    { min: 2, max: 30 }
  );
  const serverStepBudget = parseStepBudget(
    process.env.ORCH_MAX_STEPS_SERVER,
    10,
    { min: 4, max: 30 }
  );
  // IMPORTANT:
  // Connector presence should NOT reduce the model's overall step budget for server-side work
  // (e.g. data_query). We enforce connector round-trips via a stop condition instead.
  const stepBudget = serverStepBudget;
  // Give the model one extra step to synthesize after the final tool result.
  // Without this, we can stop immediately after a tool call (e.g. data_query),
  // cutting off the final user-facing summary.
  const effectiveStepBudget = Math.min(stepBudget + 1, 30);

  console.log(
    "[orchestrator-step-budget]",
    JSON.stringify({
      traceId,
      usesExternalConnector,
      connectorStepBudget,
      serverStepBudget,
      stepBudget,
      effectiveStepBudget,
      rawConnectorEnv: process.env.ORCH_MAX_STEPS_CONNECTOR || null,
      rawServerEnv: process.env.ORCH_MAX_STEPS_SERVER || null,
    })
  );

  // Compact messages if prompt is too large (> 150k tokens)
  let finalMessages = messages;
  let compactionStats: { originalTokens: number; compactedTokens: number; messagesSummarized: number; messagesKept: number } | null = null;
  try {
    const compactable = messages
      .map((m) => modelMessageToCompactable(m))
      .filter((m): m is NonNullable<typeof m> => m !== null);

    const compactionResult = await maybeCompactMessages(systemPrompt, compactable, {
      apiKey: apiKey || undefined,
      provider,
      triggerTokens: contextBudget.compactionTriggerTokens,
      keepTokens: contextBudget.keepRecentTokens,
      verbose: true,
      originalMessages: messages, // Pass original to preserve images/files
    });

    if (compactionResult.didCompact && compactionResult.stats) {
      console.log("[orchestrator] Prompt compacted:", {
        traceId,
        scope: effectiveAgentId ? `agent:${effectiveAgentId}` : "agent:unknown",
        ...compactionResult.stats,
      });
      compactionStats = compactionResult.stats;
      if (billingWorkspaceId && compactionResult.summaryUsage?.usage) {
        insertBillingUsageEventBestEffort({
          workspaceId: billingWorkspaceId,
          userId: user.id,
          turnId: effectiveTurnId,
          traceId,
          source: "compaction",
          spanId: "summarize",
          provider: compactionResult.summaryUsage.provider,
          model: compactionResult.summaryUsage.model,
          usage: compactionResult.summaryUsage.usage,
          billable: true,
          chargeType: usageChargeType,
          meta: {
            messagesSummarized: compactionResult.stats.messagesSummarized,
            messagesKept: compactionResult.stats.messagesKept,
            originalTokens: compactionResult.stats.originalTokens,
            compactedTokens: compactionResult.stats.compactedTokens,
          },
        });
        void billGroovyUsage({
          source: "compaction",
          spanId: "summarize",
          model: compactionResult.summaryUsage.model || null,
          usage: compactionResult.summaryUsage.usage,
          meta: {
            messagesSummarized: compactionResult.stats.messagesSummarized,
            messagesKept: compactionResult.stats.messagesKept,
            originalTokens: compactionResult.stats.originalTokens,
            compactedTokens: compactionResult.stats.compactedTokens,
          },
        });
      }
      
      // Use original messages for kept portion (preserves images/files)
      // Only the summary message needs to be converted from CompactableMessage
      if (compactionResult.keptOriginalMessages && compactionResult.messages.length > 0) {
        const summaryMessage = compactableToModelMessage(compactionResult.messages[0]);
        finalMessages = [summaryMessage, ...(compactionResult.keptOriginalMessages as ModelMessage[])];
      } else {
        finalMessages = compactionResult.messages.map(compactableToModelMessage) as ModelMessage[];
      }
    }
  } catch (compactionError) {
    console.warn("[orchestrator] Compaction failed, using original messages:", compactionError);
  }

  // Agent SDK doesn't support our "stop immediately after requesting a connector tool"
  // round-trip semantics. Force legacy engine when connector tools are enabled.
  const requiresConnectorRoundTrip = usesExternalConnector;
  const orchUseAgentSdk = process.env.ORCH_USE_AGENT_SDK !== "0";
  const agentSdkSupportsProvider = provider === "anthropic";
  const shouldUseAgentSdk =
    agentSdkSupportsProvider && orchUseAgentSdk && !requiresConnectorRoundTrip;
  const preferredSdkApiKey = agentSdkSupportsProvider ? apiKey : null;
  const hasSdkApiKey = !!(preferredSdkApiKey || process.env.ANTHROPIC_API_KEY);
  const sdkPathReason = !agentSdkSupportsProvider
    ? "selected_provider_requires_ai_sdk"
    : !orchUseAgentSdk
      ? "disabled_by_env"
      : requiresConnectorRoundTrip
        ? "disabled_for_connector_round_trip"
        : hasSdkApiKey
          ? "enabled"
          : "missing_anthropic_api_key";

  console.log(
    "[orchestrator] engine_selection",
    JSON.stringify({
      traceId,
      engine: shouldUseAgentSdk && hasSdkApiKey ? "agent_sdk" : "legacy",
      reason: sdkPathReason,
      requiresConnectorRoundTrip,
      provider,
      modelName,
      envOrchUseAgentSdk: process.env.ORCH_USE_AGENT_SDK ?? null,
      hasPreferredSdkApiKey: !!preferredSdkApiKey,
      hasServerAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    })
  );

  if (shouldUseAgentSdk && hasSdkApiKey) {
    console.log(
      "[orchestrator] agent_sdk_stream_start",
      JSON.stringify({
        traceId,
        provider,
        modelName,
        stepBudget,
      })
    );
    const encoder = new TextEncoder();

    const customStream = new ReadableStream({
      async start(controller) {
        let streamClosed = false;
        let streamedText = "";
        let needsClientContinuation = false;

        const safeEnqueue = (data: Uint8Array) => {
          if (streamClosed) return;
          try {
            controller.enqueue(data);
          } catch {
            streamClosed = true;
          }
        };

        let toolStreamCharsSent = 0;
        toolStreamEmitter = (data) => {
          if (data.toolName === "__clear_text__") {
            toolStreamCharsSent = 0;
            safeEnqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "clear_tool_stream" })}\n\n`)
            );
            return;
          }

          toolStreamCharsSent += data.text?.length || 0;
          if (toolStreamCharsSent % 1000 < (data.text?.length || 0)) {
            console.log(
              "[orchestrator-tool-stream]",
              JSON.stringify({
                traceId,
                toolName: data.toolName,
                totalCharsSent: toolStreamCharsSent,
              })
            );
          }
          safeEnqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "tool-stream",
                toolName: data.toolName,
                text: data.text,
              })}\n\n`
            )
          );
        };

        const emitActivity = (
          agent: string,
          action: string,
          detail?: string,
          status: string = "complete"
        ) => {
          safeEnqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "activity",
                agent,
                action,
                detail: detail?.slice(0, 100),
                status,
              })}\n\n`
            )
          );
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
                      : toolName.startsWith("skill_")
                        ? "code"
                        : toolName === "terminal_exec"
                          ? "files"
                          : "chat";

        const emitToolCall = (event: {
          toolCallId: string;
          toolName: string;
          input: unknown;
        }) => {
          const toolName = event.toolName;
          const input = event.input as Record<string, unknown>;
          const agent = toolNameToAgent(toolName);

          toolCallsExecuted.push(toolName);
          billingToolCalls.push({
            toolCallId: event.toolCallId,
            toolName,
            agent,
          });

          const metadata = buildToolCallMetadata(toolName, input);

          console.log(
            "[orchestrator-tool-call]",
            JSON.stringify({
              traceId,
              toolName,
              agent,
              input,
            })
          );

          safeEnqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "tool-call",
                toolCallId: event.toolCallId,
                toolName,
                agent,
                args: input,
                status: "running",
                metadata,
              })}\n\n`
            )
          );
        };

        const emitToolResult = (event: {
          toolCallId: string;
          toolName: string;
          output: string;
          elapsedMs?: number;
        }) => {
          const toolName = event.toolName;
          const agent = toolNameToAgent(toolName);
          const output = event.output;

          let parsedOutput: unknown = output;
          if (typeof output === "string") {
            try {
              parsedOutput = JSON.parse(output);
            } catch {
              parsedOutput = output;
            }
          }

          const isBrowserTask =
            typeof parsedOutput === "object" &&
            parsedOutput !== null &&
            "__browser_task__" in (parsedOutput as Record<string, unknown>);

          if (isBrowserTask) {
            needsClientContinuation = true;
            const browserTaskResult = parsedOutput as {
              __browser_task__: true;
              task: string;
              startUrl?: string;
              message: string;
            };

            console.log(
              "[orchestrator-browser-task]",
              JSON.stringify({
                traceId,
                task: browserTaskResult.task?.slice(0, 100),
                startUrl: browserTaskResult.startUrl,
              })
            );

            safeEnqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "browser-task",
                  toolCallId: event.toolCallId,
                  toolName,
                  agent: "browser",
                  task: browserTaskResult.task,
                  startUrl: browserTaskResult.startUrl,
                  message: browserTaskResult.message,
                })}\n\n`
              )
            );
            return;
          }

          const isUiOpenCode =
            typeof parsedOutput === "object" &&
            parsedOutput !== null &&
            "__ui_open_code__" in (parsedOutput as Record<string, unknown>);

          if (isUiOpenCode) {
            needsClientContinuation = true;
            const uiResult = parsedOutput as {
              __ui_open_code__: true;
              agentId?: string;
              name?: string;
              requestedName?: string;
            };

            console.log(
              "[orchestrator-ui-open-code]",
              JSON.stringify({
                traceId,
                requestedName: uiResult.requestedName,
                agentId: uiResult.agentId,
                name: uiResult.name,
              })
            );

            safeEnqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "ui-open-code",
                  toolCallId: event.toolCallId,
                  toolName,
                  agentId: uiResult.agentId,
                  name: uiResult.name,
                  requestedName: uiResult.requestedName,
                })}\n\n`
              )
            );
            return;
          }

          const isConnectorExecute =
            typeof parsedOutput === "object" &&
            parsedOutput !== null &&
            "__connector_execute__" in (parsedOutput as Record<string, unknown>);

          if (isConnectorExecute) {
            needsClientContinuation = true;
            const connectorResult = parsedOutput as {
              __connector_execute__: true;
              type: string;
              params: Record<string, unknown>;
              message: string;
            };

            console.log(
              "[orchestrator-connector-execute]",
              JSON.stringify({
                traceId,
                toolName,
                agent,
                connectorType: connectorResult.type,
              })
            );

            safeEnqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "connector-execute",
                  toolCallId: event.toolCallId,
                  toolName,
                  agent,
                  connectorType: connectorResult.type,
                  connectorParams: connectorResult.params,
                  message: connectorResult.message,
                })}\n\n`
              )
            );
            return;
          }

          const outputStr = typeof output === "string" ? output : JSON.stringify(output);
          const summary = parseToolResultSummary(toolName, outputStr);

          let generatedFiles:
            | Array<{
                name: string;
                mediaType: string;
                url?: string;
                storage_path?: string;
                file_id?: string;
              }>
            | undefined;
          let filesAgentResponse: string | undefined;
          let dataQueryResponse: string | undefined;

          if (
            toolName === "files_agent_request" &&
            typeof parsedOutput === "object" &&
            parsedOutput !== null
          ) {
            const filesResult = parsedOutput as {
              response?: string;
              generatedFiles?: Array<{
                name: string;
                mediaType: string;
                url?: string;
                storage_path?: string;
                file_id?: string;
              }>;
            };
            filesAgentResponse =
              typeof filesResult.response === "string"
                ? filesResult.response
                : undefined;
            generatedFiles = Array.isArray(filesResult.generatedFiles)
              ? filesResult.generatedFiles
              : undefined;
          }

          if (
            toolName === "data_query" &&
            typeof parsedOutput === "object" &&
            parsedOutput !== null
          ) {
            const dataResult = parsedOutput as {
              agentResponse?: unknown;
              files?: unknown;
              needsReauth?: boolean;
              provider?: string;
              agentId?: string;
              linkToken?: string;
            };

            console.log(
              "[orchestrator-data_query-files]",
              JSON.stringify({
                traceId,
                hasFiles: !!dataResult.files,
                filesIsArray: Array.isArray(dataResult.files),
                filesLength: Array.isArray(dataResult.files)
                  ? dataResult.files.length
                  : 0,
                filesPreview: summarizeFilesForLog(dataResult.files),
                filesPreviewTruncated:
                  Array.isArray(dataResult.files) && dataResult.files.length > 5,
              })
            );

            if (dataResult.needsReauth) {
              needsClientContinuation = true;
              console.log(
                "[orchestrator-needs-reauth]",
                JSON.stringify({
                  traceId,
                  provider: dataResult.provider,
                  agentId: dataResult.agentId,
                  hasLinkToken: !!dataResult.linkToken,
                })
              );

              safeEnqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "needs-reauth",
                    toolCallId: event.toolCallId,
                    toolName,
                    provider: dataResult.provider,
                    agentId: dataResult.agentId,
                    linkToken: dataResult.linkToken,
                  })}\n\n`
                )
              );
              return;
            }

            dataQueryResponse =
              typeof dataResult.agentResponse === "string"
                ? (dataResult.agentResponse as string)
                : undefined;
            console.log(
              "[orchestrator-data_query-response]",
              JSON.stringify({
                traceId,
                provider: dataResult.provider,
                agentId: dataResult.agentId,
                needsReauth: !!dataResult.needsReauth,
                hasAgentResponse: typeof dataResult.agentResponse === "string",
                agentResponsePreview:
                  typeof dataResult.agentResponse === "string"
                    ? dataResult.agentResponse.slice(0, 300)
                    : null,
              })
            );

            const rawFiles = Array.isArray(dataResult.files)
              ? (dataResult.files as Array<Record<string, unknown>>)
              : [];
            const normalized = rawFiles
              .map((f) => {
                const name =
                  (typeof f.filename === "string" && f.filename) ||
                  (typeof f.name === "string" && f.name) ||
                  "output";
                const mediaType =
                  (typeof f.mime_type === "string" && f.mime_type) ||
                  (typeof f.mediaType === "string" && f.mediaType) ||
                  "application/octet-stream";
                const url =
                  typeof f.url === "string" && f.url ? f.url : undefined;
                const storage_path =
                  typeof f.storage_path === "string" && f.storage_path
                    ? f.storage_path
                    : undefined;
                const file_id =
                  typeof f.file_id === "string" && f.file_id
                    ? f.file_id
                    : undefined;
                return { name, mediaType, url, storage_path, file_id };
              })
              .filter(
                (f) => typeof f.name === "string" && typeof f.mediaType === "string"
              );

            if (normalized.length > 0) {
              generatedFiles = normalized;
            }
          }

          console.log(
            "[orchestrator-tool-result]",
            JSON.stringify({
              traceId,
              toolName,
              agent,
              outputLength: outputStr.length,
              summary,
              hasGeneratedFiles: !!generatedFiles?.length,
              elapsedMs: event.elapsedMs ?? null,
            })
          );

          safeEnqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "tool-result",
                toolCallId: event.toolCallId,
                toolName,
                agent,
                result: filesAgentResponse || dataQueryResponse || outputStr,
                status: "complete",
                summary,
                generatedFiles,
              })}\n\n`
            )
          );
        };

        try {
          if (memoryEnabled) {
            emitActivity(
              "memory",
              "Memory: on-demand",
              "Use recall when current thread context is insufficient"
            );
          }

          if (compactionStats) {
            const saved =
              compactionStats.originalTokens - compactionStats.compactedTokens;
            const savedText =
              saved > 0
                ? `saved ${saved >= 1000 ? Math.round(saved / 1000) + "k" : saved} tokens`
                : `${compactionStats.compactedTokens} tokens after summary`;
            emitActivity(
              "system",
              "Context compacted",
              `${compactionStats.messagesSummarized} messages summarized, ${savedText}`
            );
          }

          emitActivity(
            "data",
            "Processing request",
            (parsed.message || lastUserMessage).slice(0, 50) + "..."
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
              : orchestratorModelOverride
                ? "user-selected"
                : "automatic-default",
          })}`;

          const maxAgentSdkAttempts = 3;
          let sdkResult: Awaited<ReturnType<typeof runAgentSdkOrchestrator>> | null = null;
          let finalSdkError: string | null = null;
          for (let attempt = 1; attempt <= maxAgentSdkAttempts; attempt++) {
            try {
              sdkResult = await runAgentSdkOrchestrator({
                systemPrompt: sdkSystemPrompt,
                messages: finalMessages,
                tools: executableTools,
                builtinTools: isToolAllowed("WebSearch", toolPolicy)
                  ? getAnthropicAgentSdkBuiltinTools(provider)
                  : [],
                model: sdkModel,
                betas: anthropicProviderOptions?.anthropic?.betas,
                maxTurns: effectiveStepBudget,
                apiKey: preferredSdkApiKey || null,
                cwd: process.cwd(),
                unrestricted: true,
                callbacks: {
                  onTextDelta: (delta) => {
                    if (!delta) return;
                    streamedText += delta;
                    safeEnqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ type: "text", text: delta })}\n\n`
                      )
                    );
                  },
                  onToolCall: (ev) => {
                    emitToolCall({
                      toolCallId: ev.toolCallId,
                      toolName: ev.toolName,
                      input: ev.input,
                    });
                  },
                  onToolResult: (ev) => {
                    emitToolResult({
                      toolCallId: ev.toolCallId,
                      toolName: ev.toolName,
                      output: ev.output,
                      elapsedMs: ev.elapsedMs,
                    });
                  },
                },
              });
              if (attempt > 1) {
                console.log(
                  "[orchestrator] agent_sdk_retry_succeeded",
                  JSON.stringify({
                    traceId,
                    attempt,
                    maxAgentSdkAttempts,
                  })
                );
              }
              break;
            } catch (sdkErr) {
              const errorMessage = formatOrchestratorError(sdkErr);
              finalSdkError = errorMessage;
              const retryable = isRetryableAgentSdkError(sdkErr);
              const canRetry = retryable && attempt < maxAgentSdkAttempts;
              console.error(
                "[orchestrator-agent-sdk-attempt-error]",
                JSON.stringify({
                  traceId,
                  attempt,
                  maxAgentSdkAttempts,
                  retryable,
                  error: errorMessage,
                })
              );

              if (!canRetry) {
                throw new Error(errorMessage);
              }

              const backoffMs = computeExponentialBackoffMs(attempt);
              emitActivity(
                "system",
                "Anthropic request failed",
                `Attempt ${attempt}/${maxAgentSdkAttempts} failed. Retrying in ${backoffMs}ms...`,
                "running"
              );
              await sleepMs(backoffMs);
            }
          }

          if (!sdkResult) {
            throw new Error(finalSdkError || "Anthropic request failed with no response.");
          }

          const measuredToolMsFromEvents = sdkResult.toolResults.reduce(
            (acc, tr) => acc + (typeof tr.elapsedMs === "number" ? tr.elapsedMs : 0),
            0
          );
          console.log(
            "[orchestrator] efficiency_summary",
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
          const hitAgentSdkStepBudget =
            typeof sdkResult.metrics?.numTurns === "number" &&
            sdkResult.metrics.numTurns >= effectiveStepBudget;
          if (
            typeof sdkResult.metrics?.numTurns === "number" &&
            sdkResult.metrics.numTurns >= effectiveStepBudget
          ) {
            console.warn(
              "[orchestrator-step-budget-hit]",
              JSON.stringify({
                traceId,
                engine: "agent_sdk",
                stepBudget: effectiveStepBudget,
                configuredStepBudget: stepBudget,
                observedSteps: sdkResult.metrics.numTurns,
                usesExternalConnector,
                toolCalls: sdkResult.toolCalls.length,
                toolResults: sdkResult.toolResults.length,
              })
            );
          }

          if (sdkResult.text && sdkResult.text.trim()) {
            const finalText = sdkResult.text.trim();
            const delta = finalText.startsWith(streamedText)
              ? finalText.slice(streamedText.length)
              : streamedText.endsWith(finalText)
                ? ""
                : (streamedText ? "\n" : "") + finalText;
            if (delta) {
              safeEnqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "text", text: delta })}\n\n`
                )
              );
            }
          }

          if (billingWorkspaceId) {
            insertBillingUsageEventBestEffort({
              workspaceId: billingWorkspaceId,
              userId: user.id,
              turnId: effectiveTurnId,
              traceId,
              source: "orchestrator_agent_sdk",
              provider: "anthropic",
              model: sdkModel,
              usage: sdkResult.usage,
              billable: true,
              chargeType: usageChargeType,
              meta: {
                directAgent: parsed.directAgent,
                usesExternalConnector,
                stepBudget,
                historyCount: history.length,
                finalMessagesCount: finalMessages.length,
                ...(compactionStats ? { compactionStats } : {}),
              },
            });
            await billGroovyUsage({
              source: "orchestrator_agent_sdk",
              model: sdkModel,
              usage: sdkResult.usage,
              meta: {
                directAgent: parsed.directAgent,
                usesExternalConnector,
                stepBudget,
                historyCount: history.length,
                finalMessagesCount: finalMessages.length,
                ...(compactionStats ? { compactionStats } : {}),
              },
            });
          }

          if (memoryStoreEnabled && sdkResult.text) {
            await scheduleAfterResponse(async () => {
              const resolvedMemoryConnectionId = await ensureMemoryConnectionId();
              if (!resolvedMemoryConnectionId) return;
              const result = await maybeStoreConversation(
                resolvedMemoryConnectionId,
                parsed.message || lastUserMessage,
                sdkResult.text,
                memoryContext,
                {
                  llmApiKey: preferredSdkApiKey || undefined,
                  llmProvider: "anthropic",
                  llmModel: sdkModel,
                  wiki: {
                    supabase,
                    userId: user.id,
                    source: "orchestrator conversation learning",
                    profileId:
                      harnessProfile?.memoryScope === "profile"
                        ? harnessProfile.id
                        : undefined,
                  },
                }
              );
              if (result.stored) {
                console.log("[orchestrator] Memory stored:", {
                  traceId,
                  label: result.label,
                  datagranStored: result.datagranStored,
                  wikiFiled: result.wikiFiled,
                  wikiPath: result.wikiPath,
                });
              } else {
                console.log("[orchestrator] Memory not stored:", result.reason);
              }
            }, "orchestrator Agent SDK memory storage");
          }

          if (memoryEnabled) {
            emitActivity(
              "memory",
              "Memory: evaluating",
              "AI deciding if worth storing..."
            );
          }

          if (billingWorkspaceId && billingToolCalls.length > 0) {
            await insertBillingToolEventsBestEffort(
              billingToolCalls.map((c) => ({
                workspaceId: billingWorkspaceId,
                userId: user.id,
                turnId: effectiveTurnId,
                traceId,
                toolCallId: c.toolCallId,
                toolName: c.toolName,
                agent: c.agent,
                meta: { request_trace_id: traceId },
              }))
            );
          }

          // Server-side persist: save the assistant message so it survives client
          // disconnects (e.g. mobile sleep). Best-effort, never blocks the stream.
          // Uses trace_id to avoid duplicates with the client-side persist.
          if (
            sdkResult?.text?.trim() &&
            sessionId &&
            traceId &&
            !needsClientContinuation &&
            !hitAgentSdkStepBudget
          ) {
            const assistantContent = sdkResult.text.trim();
            (async () => {
              try {
                // Check if the client already persisted this message
                const { data: existing } = await supabase
                  .from("orchestrator_messages")
                  .select("id")
                  .eq("session_id", sessionId)
                  .eq("trace_id", traceId)
                  .eq("role", "assistant")
                  .limit(1);
                if (existing && existing.length > 0) return; // client beat us
                await supabase.from("orchestrator_messages").insert({
                  user_id: user.id,
                  session_id: sessionId,
                  agent_id: effectiveAgentId || null,
                  epoch_id: effectiveRuntimeScope?.epochId || null,
                  branch_id: effectiveRuntimeScope?.branchId || null,
                  role: "assistant",
                  content: assistantContent,
                  trace_id: traceId,
                  metadata: requestMessageMetadata
                    ? { ...requestMessageMetadata, server_persisted: true }
                    : { server_persisted: true },
                });
              } catch { /* best-effort */ }
            })();
          }

          safeEnqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "done",
                traceId,
                hitStepBudget: hitAgentSdkStepBudget,
                needsClientContinuation,
                runtime: {
                  provider: "anthropic",
                  model: sdkModel,
                  reasoningEffort:
                    orchestratorModelOverride?.reasoningEffort || null,
                  engine: "anthropic-agent-sdk",
                },
              })}\n\n`
            )
          );
        } catch (err) {
          const errorMessage = formatOrchestratorError(err);
          console.error("[orchestrator-agent-sdk-stream-error]", err);
          console.warn(
            "[orchestrator] agent_sdk_stream_failed_no_legacy_retry",
            JSON.stringify({
              traceId,
              reason: "agent_sdk_stream_error",
              error: errorMessage,
            })
          );
          safeEnqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", error: errorMessage })}\n\n`
            )
          );
        } finally {
          streamClosed = true;
          toolStreamEmitter = null;
          controller.close();
        }
      },
    });

    return new Response(customStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Orchestrator-Trace-Id": traceId,
        "X-Orchestrator-Direct-Agent": parsed.directAgent || "",
        "X-Orchestrator-Active-Agents": activeAgents.join(","),
      },
    });
  }

  if (!shouldUseAgentSdk || !hasSdkApiKey) {
    console.warn(
      "[orchestrator] using_legacy_engine",
      JSON.stringify({
        traceId,
        reason: sdkPathReason,
        provider,
        modelName,
      })
    );
  }

  let loggedStepBudgetHit = false;
  let loggedDataQueryReauthStop = false;
  const stepBudgetStop = stepCountIs(effectiveStepBudget) as (args: {
    steps: Array<{ toolCalls?: Array<{ toolName?: string }> }>;
  }) => boolean;
  const stopForStepBudget = ({
    steps,
  }: {
    steps: Array<{ toolCalls?: Array<{ toolName?: string }> }>;
  }) => {
    const reached = stepBudgetStop({ steps });
    if (reached && !loggedStepBudgetHit) {
      loggedStepBudgetHit = true;
      const lastToolCalls = (steps[steps.length - 1]?.toolCalls || [])
        .map((tc) => String(tc?.toolName || "").trim())
        .filter(Boolean);
      console.warn(
        "[orchestrator-step-budget-hit]",
        JSON.stringify({
          traceId,
          engine: "legacy_stream_text",
          stepBudget: effectiveStepBudget,
          configuredStepBudget: stepBudget,
          observedSteps: steps.length,
          usesExternalConnector,
          lastToolCalls,
        })
      );
    }
    return reached;
  };

  const buildLegacySystemMessages = (candidateModelName: string) => {
    const runtimeIdentity = buildOrchestratorRuntimeIdentityPrompt({
      provider,
      modelName: candidateModelName,
      reasoningEffort: orchestratorModelOverride?.reasoningEffort,
      engine: "ai-sdk",
      selectionSource: harnessProfile?.model
        ? "profile"
        : orchestratorModelOverride
          ? "user-selected"
          : "automatic-default",
    });
    return provider === "anthropic"
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
  };

  const createLegacyResult = (candidateModelName: string) => streamText({
    model: resolveModelForName(candidateModelName),
    system: buildLegacySystemMessages(candidateModelName),
    providerOptions: getProviderOptionsForModel(candidateModelName),
    messages: finalMessages,
    tools,
    // Strict connector round-trip mode:
    // connector-backed tool calls must complete client-side before the model can continue.
    // Stop immediately after *requesting* any connector-backed tool so the client can execute it,
    // then resume the model with real toolResults in the next round.
    stopWhen: [
      stopForStepBudget,
      () => {
        const blocked = toolContext.dataQueryReauthState?.blocked === true;
        if (blocked && !loggedDataQueryReauthStop) {
          loggedDataQueryReauthStop = true;
          console.warn(
            "[orchestrator-stop-on-data-query-auth-block]",
            JSON.stringify({
              traceId,
              reason: toolContext.dataQueryReauthState?.reason || "unknown",
              provider: toolContext.dataQueryReauthState?.provider || null,
              agentId: toolContext.dataQueryReauthState?.agentId || null,
            })
          );
        }
        return blocked;
      },
      ({ steps }: { steps: Array<{ toolCalls?: Array<{ toolName?: string }> }> }) => {
        if (!usesExternalConnector) return false;
        const last = steps[steps.length - 1];
        const toolCalls = last?.toolCalls || [];
        return toolCalls.some((tc) => {
          const name = String(tc?.toolName || "");
          if (!name) return false;
          // Connector-backed tools require a client round-trip.
          if (name === "terminal_exec") return true;
          if (name === "code_cli_run") return true;
          if (name === "code_terminal_step") return true;
          if (name === "runtime_branch_parallel") return true;
          if (name === "browser_task") return true;
          if (name.startsWith("browser_")) return true;
          // files_agent_request runs fully server-side and should not force early stop.
          if (name.startsWith("files_") && name !== "files_agent_request") return true;
          if (name.startsWith("obsidian_")) return true;
          if (name.startsWith("site_")) return true;
          if (name.startsWith("whatsapp_")) return true;
          if (name.startsWith("linkdb_")) return true;
          if (name.startsWith("sqlite_")) return true;
          return false;
        });
      },
    ],
    onFinish: async (event) => {
      const text = event.text;
      const usage = (event as unknown as { usage?: unknown }).usage;

      if (billingWorkspaceId) {
        insertBillingUsageEventBestEffort({
          workspaceId: billingWorkspaceId,
          userId: user.id,
          turnId: effectiveTurnId,
          traceId,
          source: "orchestrator",
          provider,
          model: candidateModelName,
            usage,
            billable: true,
            chargeType: usageChargeType,
          meta: {
            directAgent: parsed.directAgent,
            usesExternalConnector,
            stepBudget,
            historyCount: history.length,
            finalMessagesCount: finalMessages.length,
            ...(compactionStats ? { compactionStats } : {}),
          },
        });
        await billGroovyUsage({
          source: "orchestrator",
          model: candidateModelName,
          usage,
          meta: {
            directAgent: parsed.directAgent,
            usesExternalConnector,
            stepBudget,
            historyCount: history.length,
            finalMessagesCount: finalMessages.length,
            ...(compactionStats ? { compactionStats } : {}),
          },
        });
      }

      // AI-decided memory storage (async, don't block response)
      // Only store if AI decides this conversation has durable value
      if (memoryStoreEnabled && text) {
        await scheduleAfterResponse(async () => {
          const resolvedMemoryConnectionId = await ensureMemoryConnectionId();
          if (!resolvedMemoryConnectionId) return;
          const result = await maybeStoreConversation(
            resolvedMemoryConnectionId,
            parsed.message || lastUserMessage,
            text,
            memoryContext, // Existing context helps AI avoid storing duplicates
            {
              llmApiKey: apiKey || undefined,
              llmProvider: provider,
              llmModel: candidateModelName,
              wiki: {
                supabase,
                userId: user.id,
                source: "orchestrator conversation learning",
                profileId:
                  harnessProfile?.memoryScope === "profile"
                    ? harnessProfile.id
                    : undefined,
              },
            }
          );
          if (result.stored) {
            console.log("[orchestrator] Memory stored:", {
              traceId,
              label: result.label,
              datagranStored: result.datagranStored,
              wikiFiled: result.wikiFiled,
              wikiPath: result.wikiPath,
            });
          } else {
            console.log("[orchestrator] Memory not stored:", result.reason);
          }
        }, "orchestrator memory storage");
      }
    },
  });

  // Create a custom stream that includes both text and activity events
  // Format: SSE with event types: "text", "tool-call", "tool-result", "activity", "done"
  const encoder = new TextEncoder();
  
  const customStream = new ReadableStream({
    async start(controller) {
      let streamClosed = false;
      let needsClientContinuation = false;
      
      // Safe enqueue that won't throw if controller is closed
      const safeEnqueue = (data: Uint8Array) => {
        if (streamClosed) return;
        try {
          controller.enqueue(data);
        } catch {
          streamClosed = true;
        }
      };

      // Wire tool stream emitter (used by long-running tools)
      let toolStreamCharsSent = 0;
      toolStreamEmitter = (data) => {
        // Handle clear_text signal from data agent — emit as a dedicated SSE event
        // type so the client can reset its accumulated text.
        if (data.toolName === "__clear_text__") {
          toolStreamCharsSent = 0;
          safeEnqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "clear_tool_stream" })}\n\n`)
          );
          return;
        }

        toolStreamCharsSent += data.text?.length || 0;
        // Log every 1000 chars to track streaming progress
        if (toolStreamCharsSent % 1000 < (data.text?.length || 0)) {
          console.log("[orchestrator-tool-stream]", JSON.stringify({
            traceId,
            toolName: data.toolName,
            totalCharsSent: toolStreamCharsSent,
          }));
        }
        safeEnqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "tool-stream",
              toolName: data.toolName,
              text: data.text,
            })}\n\n`
          )
        );
      };
      
      // Helper to emit activity events
      const emitActivity = (agent: string, action: string, detail?: string, status: string = "complete") => {
        safeEnqueue(
          encoder.encode(`data: ${JSON.stringify({ 
            type: "activity", 
            agent, 
            action, 
            detail: detail?.slice(0, 100),
            status 
          })}\n\n`)
        );
      };
      try {
        // Emit memory loading activities
        if (memoryEnabled) {
          emitActivity(
            "memory",
            "Memory: on-demand",
            "Use recall when current thread context is insufficient"
          );
        }
        
        // Emit compaction activity if prompt was compacted
        if (compactionStats) {
          const saved = compactionStats.originalTokens - compactionStats.compactedTokens;
          const savedText = saved > 0 
            ? `saved ${saved >= 1000 ? Math.round(saved / 1000) + "k" : saved} tokens`
            : `${compactionStats.compactedTokens} tokens after summary`;
          emitActivity(
            "system",
            "Context compacted",
            `${compactionStats.messagesSummarized} messages summarized, ${savedText}`
          );
        }
        
        // Emit processing activity as complete (informational only)
        emitActivity(
          "data",
          "Processing request",
          (parsed.message || lastUserMessage).slice(0, 50) + "..."
        );
        
        const legacyModelCandidates = (() => {
          if (provider !== "anthropic") return [modelName];
          const candidates = [modelName];
          const normalizedModel = modelName.toLowerCase();
          // Opus overloads are common under high traffic; retry once on Sonnet.
          if (normalizedModel.includes("opus")) {
            candidates.push("claude-sonnet-4.6");
          } else if (normalizedModel.includes("sonnet-4.6")) {
            candidates.push("claude-sonnet-4.5");
          }
          return candidates.filter(
            (candidate, idx, arr) => arr.indexOf(candidate) === idx
          );
        })();

        const legacyToolNameToAgent = (toolName: string): string =>
          isWebSearchToolName(toolName) ? "browser"
            : toolName.startsWith("code_") ? "code"
            : toolName.startsWith("data_") ? "data"
            : toolName.startsWith("browser_") ? "browser"
            : toolName.startsWith("files_") ? "files"
            : toolName.startsWith("site_") ? "pages"
            : toolName.startsWith("obsidian_") ? "obsidian"
            : toolName.startsWith("schedule_") ? "schedule"
            : toolName.startsWith("skill_") ? "code"
            : toolName === "terminal_exec" ? "files"
            : "chat";

        let legacyStreamSucceeded = false;
        let lastLegacyStreamError: unknown = null;
        let legacyAccumulatedText = "";
        let legacySuccessfulModelName = modelName;
        for (let attempt = 1; attempt <= legacyModelCandidates.length; attempt++) {
          const attemptModelName = legacyModelCandidates[attempt - 1] || modelName;
          const toolCallsBeforeAttempt = toolCallsExecuted.length;
          let emittedMeaningfulSseThisAttempt = false;
          let sawToolCallThisAttempt = false;
          let loggedPreToolTextThisAttempt = false;

          try {
            if (attempt > 1) {
              emitActivity(
                "system",
                "Retrying model call",
                `Attempt ${attempt}/${legacyModelCandidates.length} with ${attemptModelName}...`,
                "running"
              );
            }

            const result = createLegacyResult(attemptModelName);
            for await (const event of result.fullStream) {
              if (event.type === "text-delta") {
                legacyAccumulatedText += event.text;
                emittedMeaningfulSseThisAttempt = true;
                if (!sawToolCallThisAttempt && !loggedPreToolTextThisAttempt && event.text.trim()) {
                  loggedPreToolTextThisAttempt = true;
                  console.log(
                    "[orchestrator-pre-tool-text]",
                    JSON.stringify({
                      traceId,
                      attempt,
                      model: attemptModelName,
                      preview: event.text.trim().slice(0, 300),
                    })
                  );
                }
                // Text chunk
                safeEnqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: "text", text: event.text })}\n\n`)
                );
              } else if (event.type === "tool-call") {
                emittedMeaningfulSseThisAttempt = true;
                sawToolCallThisAttempt = true;
                // Tool is being called - this is when activity starts
                const toolName = event.toolName;
                const input = event.input as Record<string, unknown>;
                const agent = legacyToolNameToAgent(toolName);

                toolCallsExecuted.push(toolName);
                billingToolCalls.push({
                  toolCallId: event.toolCallId,
                  toolName,
                  agent,
                });

                // Build rich metadata for the activity
                const metadata = buildToolCallMetadata(toolName, input);

                console.log("[orchestrator-tool-call]", JSON.stringify({
                  traceId,
                  toolName,
                  agent,
                  input,
                }));

                safeEnqueue(
                  encoder.encode(`data: ${JSON.stringify({
                    type: "tool-call",
                    toolCallId: event.toolCallId,
                    toolName,
                    agent,
                    args: input,
                    status: "running",
                    // Rich metadata for activity display
                    metadata,
                  })}\n\n`)
                );
              } else if (event.type === "tool-result") {
                emittedMeaningfulSseThisAttempt = true;
                // Tool completed
                const toolName = event.toolName;
                const agent = legacyToolNameToAgent(toolName);
            
            const output = event.output;
            
            // Parse output if it's a JSON string (tool execute handlers return strings)
            let parsedOutput: unknown = output;
            if (typeof output === "string") {
              try {
                parsedOutput = JSON.parse(output);
              } catch {
                // Not JSON, keep as string
                parsedOutput = output;
              }
            }
            
            // Check if this is a browser-task marker (uses Claude Computer Use)
            const isBrowserTask = typeof parsedOutput === "object"
              && parsedOutput !== null
              && "__browser_task__" in (parsedOutput as Record<string, unknown>);
            
            if (isBrowserTask) {
              needsClientContinuation = true;
              const browserTaskResult = parsedOutput as {
                __browser_task__: true;
                task: string;
                startUrl?: string;
                agent: string;
                message: string;
              };
              
              console.log("[orchestrator-browser-task]", JSON.stringify({
                traceId,
                task: browserTaskResult.task?.slice(0, 100),
                startUrl: browserTaskResult.startUrl,
              }));
              
              // Emit browser-task event for client to handle Computer Use loop
              safeEnqueue(
                encoder.encode(`data: ${JSON.stringify({
                  type: "browser-task",
                  toolCallId: event.toolCallId,
                  toolName,
                  agent: "browser",
                  task: browserTaskResult.task,
                  startUrl: browserTaskResult.startUrl,
                  message: browserTaskResult.message,
                })}\n\n`)
              );
              continue;
            }

            // Check if this is a UI open-code marker (opens a named Claude Code session in the dashboard)
            const isUiOpenCode =
              typeof parsedOutput === "object" &&
              parsedOutput !== null &&
              "__ui_open_code__" in (parsedOutput as Record<string, unknown>);

            if (isUiOpenCode) {
              needsClientContinuation = true;
              const uiResult = parsedOutput as {
                __ui_open_code__: true;
                agentId?: string;
                name?: string;
                requestedName?: string;
              };

              console.log("[orchestrator-ui-open-code]", JSON.stringify({
                traceId,
                requestedName: uiResult.requestedName,
                agentId: uiResult.agentId,
                name: uiResult.name,
              }));

              safeEnqueue(
                encoder.encode(`data: ${JSON.stringify({
                  type: "ui-open-code",
                  toolCallId: event.toolCallId,
                  toolName,
                  agentId: uiResult.agentId,
                  name: uiResult.name,
                  requestedName: uiResult.requestedName,
                })}\n\n`)
              );
              continue;
            }

            // Check if this is a connector-execute marker (browser/files/obsidian tools)
            const isConnectorExecute = typeof parsedOutput === "object" 
              && parsedOutput !== null 
              && "__connector_execute__" in (parsedOutput as Record<string, unknown>);
            
            if (isConnectorExecute) {
              needsClientContinuation = true;
              const connectorResult = parsedOutput as {
                __connector_execute__: true;
                type: string;
                params: Record<string, unknown>;
                toolName: string;
                agent: string;
                message: string;
              };
              
              console.log("[orchestrator-connector-execute]", JSON.stringify({
                traceId,
                toolName,
                agent,
                connectorType: connectorResult.type,
              }));
              
              // Emit connector-execute event for client to handle
              safeEnqueue(
                encoder.encode(`data: ${JSON.stringify({
                  type: "connector-execute",
                  toolCallId: event.toolCallId,
                  toolName,
                  agent,
                  connectorType: connectorResult.type,
                  connectorParams: connectorResult.params,
                  message: connectorResult.message,
                })}\n\n`)
              );
            } else {
              const outputStr = typeof output === "string" 
                ? output 
                : JSON.stringify(output);
              
              // Parse the result to extract meaningful summary
              const summary = parseToolResultSummary(toolName, outputStr);
              
              // Extract generated files from files_agent_request result
              let generatedFiles: Array<{ name: string; mediaType: string; url?: string; storage_path?: string; file_id?: string }> | undefined;
              let filesAgentResponse: string | undefined;
              // For data_query (Datagran/web_pixel/etc), agents may generate files (charts, spreadsheets).
              // Normalize and forward them so the dashboard can render previews/downloads.
              let dataQueryResponse: string | undefined;
              
              if (toolName === "files_agent_request" && typeof parsedOutput === "object" && parsedOutput !== null) {
                const filesResult = parsedOutput as {
                  response?: string;
                  generatedFiles?: Array<{ name: string; mediaType: string; url?: string; storage_path?: string; file_id?: string }>;
                };
                filesAgentResponse = typeof filesResult.response === "string" ? filesResult.response : undefined;
                generatedFiles = Array.isArray(filesResult.generatedFiles) ? filesResult.generatedFiles : undefined;
              }

              if (toolName === "data_query" && typeof parsedOutput === "object" && parsedOutput !== null) {
                const dataResult = parsedOutput as {
                  agentResponse?: unknown;
                  files?: unknown;
                  // Check for re-auth needed
                  needsReauth?: boolean;
                  provider?: string;
                  agentId?: string;
                  linkToken?: string;
                };

                // Debug: log incoming files from data_query
                console.log("[orchestrator-data_query-files]", JSON.stringify({
                  traceId,
                  hasFiles: !!dataResult.files,
                  filesIsArray: Array.isArray(dataResult.files),
                  filesLength: Array.isArray(dataResult.files) ? dataResult.files.length : 0,
                  filesPreview: summarizeFilesForLog(dataResult.files),
                  filesPreviewTruncated:
                    Array.isArray(dataResult.files) && dataResult.files.length > 5,
                }));

                // Check if data agent requires re-authorization
                if (dataResult.needsReauth) {
                  needsClientContinuation = true;
                  console.log("[orchestrator-needs-reauth]", JSON.stringify({
                    traceId,
                    provider: dataResult.provider,
                    agentId: dataResult.agentId,
                    hasLinkToken: !!dataResult.linkToken,
                  }));
                  
                  safeEnqueue(
                    encoder.encode(`data: ${JSON.stringify({
                      type: "needs-reauth",
                      toolCallId: event.toolCallId,
                      toolName,
                      provider: dataResult.provider,
                      agentId: dataResult.agentId,
                      linkToken: dataResult.linkToken,
                    })}\n\n`)
                  );
                  continue;
                }

                dataQueryResponse =
                  typeof dataResult.agentResponse === "string" ? (dataResult.agentResponse as string) : undefined;
                console.log(
                  "[orchestrator-data_query-response]",
                  JSON.stringify({
                    traceId,
                    provider: dataResult.provider,
                    agentId: dataResult.agentId,
                    needsReauth: !!dataResult.needsReauth,
                    hasAgentResponse: typeof dataResult.agentResponse === "string",
                    agentResponsePreview:
                      typeof dataResult.agentResponse === "string"
                        ? dataResult.agentResponse.slice(0, 300)
                        : null,
                  })
                );

                const rawFiles = Array.isArray(dataResult.files) ? (dataResult.files as Array<Record<string, unknown>>) : [];
                const normalized = rawFiles
                  .map((f) => {
                    const name =
                      (typeof f.filename === "string" && f.filename) ||
                      (typeof f.name === "string" && f.name) ||
                      "output";
                    const mediaType =
                      (typeof f.mime_type === "string" && f.mime_type) ||
                      (typeof f.mediaType === "string" && f.mediaType) ||
                      "application/octet-stream";
                    const url = typeof f.url === "string" && f.url ? f.url : undefined;
                    // Include storage_path and file_id for proxy URL generation
                    const storage_path = typeof f.storage_path === "string" && f.storage_path ? f.storage_path : undefined;
                    const file_id = typeof f.file_id === "string" && f.file_id ? f.file_id : undefined;
                    return { name, mediaType, url, storage_path, file_id };
                  })
                  .filter((f) => typeof f.name === "string" && typeof f.mediaType === "string");

                if (normalized.length > 0) {
                  generatedFiles = normalized;
                }
              }
              
              console.log("[orchestrator-tool-result]", JSON.stringify({
                traceId,
                toolName,
                agent,
                outputLength: outputStr.length,
                summary,
                hasGeneratedFiles: !!generatedFiles?.length,
              }));
              
              safeEnqueue(
                encoder.encode(`data: ${JSON.stringify({
                  type: "tool-result",
                  toolCallId: event.toolCallId,
                  toolName,
                  agent,
                  result:
                    filesAgentResponse ||
                    dataQueryResponse ||
                    // Do NOT truncate here - the client needs the full result for context in the next round.
                    // Truncation happens in the UI layer if needed, but the data must remain intact.
                    outputStr,
                  status: "complete",
                  // Rich summary for activity display
                  summary,
                  // Include generated files from Files agent
                  generatedFiles,
                })}\n\n`)
              );
            }
          }
            }
            legacyStreamSucceeded = true;
            legacySuccessfulModelName = attemptModelName;
            break;
          } catch (streamErr) {
            lastLegacyStreamError = streamErr;
            const retryable = isRetryableAgentSdkError(streamErr);
            const hadToolCallsThisAttempt =
              toolCallsExecuted.length > toolCallsBeforeAttempt;
            const canRetry =
              retryable &&
              !hadToolCallsThisAttempt &&
              !emittedMeaningfulSseThisAttempt &&
              attempt < legacyModelCandidates.length;

            console.error(
              "[orchestrator-legacy-attempt-error]",
              JSON.stringify({
                traceId,
                attempt,
                maxAttempts: legacyModelCandidates.length,
                modelName: attemptModelName,
                retryable,
                hadToolCallsThisAttempt,
                emittedMeaningfulSseThisAttempt,
                error: formatOrchestratorError(streamErr),
              })
            );

            if (!canRetry) {
              break;
            }

            const backoffMs = computeExponentialBackoffMs(attempt);
            emitActivity(
              "system",
              "Model overloaded",
              `Attempt ${attempt}/${legacyModelCandidates.length} failed. Retrying in ${backoffMs}ms...`,
              "running"
            );
            await sleepMs(backoffMs);
          }
        }

        if (!legacyStreamSucceeded) {
          throw (
            lastLegacyStreamError ||
            new Error("Orchestrator stream failed before completion.")
          );
        }
        
        // Memory storage note - AI will decide if this conversation should be stored
        if (memoryEnabled) {
          emitActivity("memory", "Memory: evaluating", "AI deciding if worth storing...");
        }

        if (billingWorkspaceId && billingToolCalls.length > 0) {
          await insertBillingToolEventsBestEffort(
            billingToolCalls.map((c) => ({
              workspaceId: billingWorkspaceId,
              userId: user.id,
              turnId: effectiveTurnId,
              traceId,
              toolCallId: c.toolCallId,
              toolName: c.toolName,
              agent: c.agent,
              meta: { request_trace_id: traceId },
            }))
          );
        }
        
        // Server-side persist (legacy path): save assistant message so it survives
        // client disconnects (e.g. mobile sleep). Best-effort.
        // Uses trace_id to avoid duplicates with the client-side persist.
        if (
          legacyAccumulatedText.trim() &&
          sessionId &&
          traceId &&
          !needsClientContinuation &&
          !loggedStepBudgetHit
        ) {
          (async () => {
            try {
              const { data: existing } = await supabase
                .from("orchestrator_messages")
                .select("id")
                .eq("session_id", sessionId)
                .eq("trace_id", traceId)
                .eq("role", "assistant")
                .limit(1);
              if (existing && existing.length > 0) return;
              await supabase.from("orchestrator_messages").insert({
                user_id: user.id,
                session_id: sessionId,
                agent_id: effectiveAgentId || null,
                epoch_id: effectiveRuntimeScope?.epochId || null,
                branch_id: effectiveRuntimeScope?.branchId || null,
                role: "assistant",
                content: legacyAccumulatedText.trim(),
                trace_id: traceId,
                metadata: requestMessageMetadata
                  ? { ...requestMessageMetadata, server_persisted: true }
                  : { server_persisted: true },
              });
            } catch { /* best-effort */ }
          })();
        }

        // Stream completed - send done event
        safeEnqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "done",
              traceId,
              hitStepBudget: loggedStepBudgetHit,
              needsClientContinuation,
              runtime: {
                provider,
                model: legacySuccessfulModelName,
                reasoningEffort:
                  orchestratorModelOverride?.reasoningEffort || null,
                engine: "ai-sdk",
              },
            })}\n\n`
          )
        );
      } catch (err) {
        const errorMessage = formatOrchestratorError(err);
        console.error("[orchestrator-stream-error]", err);
        safeEnqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", error: errorMessage })}\n\n`)
        );
      } finally {
        streamClosed = true;
        toolStreamEmitter = null;
        controller.close();
      }
    },
  });

  // Return SSE response with activity events
  return new Response(customStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Orchestrator-Trace-Id": traceId,
      "X-Orchestrator-Direct-Agent": parsed.directAgent || "",
      "X-Orchestrator-Active-Agents": activeAgents.join(","),
    },
  });
}

/**
 * Build the orchestrator system prompt
 */
function buildOrchestratorPrompt(
  memoryContext: string,
  preferenceContext: string,
  activeAgents: AgentType[],
  mentionedAgents: AgentType[],
  hasConnector: boolean,
  nowIso: string,
  webPixelNames: string[],
  hasFilesAgent: boolean,
  branchRuntime?: {
    role: "main" | "worker";
    goal?: string | null;
    mode: "read_only" | "read_write";
    maxBranches: number;
    maxTurnsPerBranch: number;
    activeBranches?: number | null;
  },
  hasTelegram?: boolean,
  hasNativeWebSearch?: boolean,
  profile?: HarnessProfile | null,
): ReturnType<typeof buildSharedOrchestratorPrompt> {
  return buildSharedOrchestratorPrompt(
    memoryContext,
    preferenceContext,
    activeAgents,
    mentionedAgents,
    hasConnector,
    nowIso,
    undefined,
    webPixelNames,
    hasFilesAgent,
    false,
    false,
    undefined,
    branchRuntime,
    hasTelegram,
    hasNativeWebSearch,
    false,
    profile,
  );
}

/**
 * Build rich metadata for tool call activity
 */
function buildToolCallMetadata(
  toolName: string,
  input: Record<string, unknown>
): {
  title: string;
  subtitle?: string;
  provider?: string;
  target?: string;
  query?: string;
  tags?: string[];
} {
  if (toolName === "data_query") {
    const provider = input.provider as string;
    const pixelName = input.pixelName as string | undefined;
    const query = input.query as string | undefined;
    
    const providerLabels: Record<string, string> = {
      web_pixel: "Web Pixel Analytics",
      firecrawl: "Firecrawl Web Scraper",
      google_ads: "Google Ads",
      facebook_ads: "Facebook Ads",
      facebook_leads: "Facebook Leads",
      instagram: "Instagram",
      linkedin_ads: "LinkedIn Ads",
      tiktok: "TikTok Ads",
      postgres: "PostgreSQL",
      salesforce: "Salesforce",
      google_drive: "Google Drive",
    };
    
    const title = pixelName 
      ? `Querying ${pixelName}` 
      : `Querying ${providerLabels[provider] || provider}`;
    
    return {
      title,
      subtitle: query ? (query.length > 80 ? query.slice(0, 80) + "..." : query) : undefined,
      provider,
      target: pixelName || provider,
      query,
      tags: [provider, pixelName].filter(Boolean) as string[],
    };
  }

  if (isWebSearchToolName(toolName)) {
    const query = typeof input.query === "string" ? input.query : undefined;
    return {
      title: "Searching the web",
      subtitle: query ? (query.length > 80 ? query.slice(0, 80) + "..." : query) : undefined,
      provider: "anthropic",
      query,
      tags: ["web-search", "anthropic"],
    };
  }
  
  if (toolName === "data_check_connection") {
    const provider = input.provider as string;
    return {
      title: `Checking ${provider.replace(/_/g, " ")} connection`,
      provider,
      tags: [provider],
    };
  }
  
  if (toolName === "remember") {
    const content = input.content as string;
    return {
      title: "Saving to memory",
      subtitle: content ? (content.length > 60 ? content.slice(0, 60) + "..." : content) : undefined,
      tags: ["memory"],
    };
  }
  
  if (toolName === "recall") {
    const query = input.query as string;
    return {
      title: "Searching memory",
      subtitle: query,
      query,
      tags: ["memory"],
    };
  }

  if (toolName === "runtime_branch_parallel") {
    const tasks = Array.isArray(input.tasks)
      ? input.tasks
          .map((task) => {
            if (!task || typeof task !== "object") return "";
            const row = task as Record<string, unknown>;
            const title = typeof row.title === "string" ? row.title.trim() : "";
            const goal = typeof row.goal === "string" ? row.goal.trim() : "";
            return title || goal;
          })
          .filter(Boolean)
      : [];
    const count = tasks.length;
    const preview = tasks.slice(0, 3).join(", ");
    const extra = count > 3 ? ` (+${count - 3} more)` : "";
    return {
      title: count > 0 ? `Forking ${count} worker branches` : "Forking worker branches",
      subtitle: preview ? `${preview}${extra}` : undefined,
      target: count > 0 ? `${count} branches` : "branches",
      tags: ["branch", "parallel"],
    };
  }

  if (toolName.startsWith("skill_registry_")) {
    const action = toolName.slice("skill_registry_".length).replace(/_/g, " ").trim() || "registry";
    const skillRef =
      (typeof input.skill_ref === "string" && input.skill_ref.trim()) ||
      (typeof input.slug === "string" && input.slug.trim()) ||
      (typeof input.name === "string" && input.name.trim()) ||
      "";
    const validationTask =
      typeof input.validation_task === "string" && input.validation_task.trim()
        ? input.validation_task.trim()
        : "";
    const subtitle = validationTask || skillRef || undefined;
    return {
      title: `Skill ${action}`,
      subtitle: subtitle
        ? subtitle.length > 90
          ? `${subtitle.slice(0, 90)}...`
          : subtitle
        : undefined,
      target: skillRef || undefined,
      query: validationTask || undefined,
      tags: ["skill-registry", action.replace(/\s+/g, "-"), ...(skillRef ? [skillRef] : [])],
    };
  }

  if (toolName.startsWith("skill_")) {
    const skillSlug = toolName.slice("skill_".length) || "custom";
    const skillLabel = skillSlug.replace(/_/g, " ");
    const task = typeof input.task === "string" ? input.task.trim() : "";
    return {
      title: `Using skill ${skillLabel}`,
      subtitle: task ? (task.length > 80 ? `${task.slice(0, 80)}...` : task) : undefined,
      target: skillSlug,
      query: task || undefined,
      tags: ["skill", skillSlug],
    };
  }
  
  return { title: toolName.replace(/_/g, " ") };
}

/**
 * Parse tool result to extract meaningful summary
 */
function parseToolResultSummary(
  toolName: string,
  resultStr: string
): {
  headline?: string;
  stats?: Record<string, string | number>;
  items?: string[];
  error?: string;
} {
  try {
    // Check if it's an error
    if (resultStr.startsWith("Error:")) {
      return { error: resultStr.slice(7).trim() };
    }
    
    // Try to parse as JSON for structured data
    if (resultStr.startsWith("{") || resultStr.startsWith("[")) {
      const data = JSON.parse(resultStr);

      if (toolName === "runtime_branch_parallel" && data && typeof data === "object" && !Array.isArray(data)) {
        const record = data as Record<string, unknown>;
        const launched =
          typeof record.launchedTasks === "number"
            ? record.launchedTasks
            : typeof record.launched_tasks === "number"
              ? record.launched_tasks
              : Array.isArray(record.results)
                ? record.results.length
                : 0;
        const requested =
          typeof record.requestedTasks === "number"
            ? record.requestedTasks
            : typeof record.requested_tasks === "number"
              ? record.requested_tasks
              : launched;
        const skipped =
          typeof record.skippedTasks === "number"
            ? record.skippedTasks
            : typeof record.skipped_tasks === "number"
              ? record.skipped_tasks
              : Math.max(0, requested - launched);
        const results = Array.isArray(record.results) ? record.results : [];
        const completed = results.filter((row) => {
          if (!row || typeof row !== "object") return false;
          return (row as Record<string, unknown>).status === "completed";
        }).length;
        const failed = results.length - completed;
        return {
          headline:
            launched > 0
              ? `${launched} worker branch${launched === 1 ? "" : "es"} launched`
              : "No worker branches launched",
          stats: {
            launchedBranches: launched,
            requestedBranches: requested,
            skippedBranches: skipped,
            completedBranches: completed,
            failedBranches: failed,
          },
        };
      }

      if (isWebSearchToolName(toolName) && Array.isArray(data)) {
        const items = data
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const row = item as Record<string, unknown>;
            const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : "";
            const url = typeof row.url === "string" && row.url.trim() ? row.url.trim() : "";
            return title || url;
          })
          .filter(Boolean)
          .slice(0, 5);
        return {
          headline: `Found ${data.length} web result${data.length === 1 ? "" : "s"}`,
          items,
        };
      }

      if (
        toolName.startsWith("skill_registry_") &&
        data &&
        typeof data === "object" &&
        !Array.isArray(data)
      ) {
        const record = data as Record<string, unknown>;
        const status = typeof record.status === "string" ? record.status : "";
        const skill =
          record.skill && typeof record.skill === "object" && !Array.isArray(record.skill)
            ? (record.skill as Record<string, unknown>)
            : null;
        const skillLabel =
          (typeof skill?.slug === "string" && skill.slug) ||
          (typeof skill?.name === "string" && skill.name) ||
          (typeof record.liveToolName === "string" && record.liveToolName) ||
          "";
        const normalizedLabel = skillLabel.replace(/^skill_/, "").replace(/_/g, " ").trim();
        if (status === "draft_created") {
          return {
            headline: normalizedLabel ? `Draft created: ${normalizedLabel}` : "Skill draft created",
          };
        }
        if (status === "validation_finished") {
          return {
            headline: normalizedLabel
              ? `Validation finished: ${normalizedLabel}`
              : "Skill validation finished",
          };
        }
        if (status === "activated") {
          return {
            headline: normalizedLabel ? `Activated: ${normalizedLabel}` : "Skill activated",
          };
        }
      }
      
      // Web Pixel stats
      if (data.stats) {
        const stats: Record<string, string | number> = {};
        if (data.stats.visitors !== undefined) stats.visitors = data.stats.visitors;
        if (data.stats.sessions !== undefined) stats.sessions = data.stats.sessions;
        if (data.stats.sign_ups !== undefined) stats.signUps = data.stats.sign_ups;
        if (data.stats.sign_ins !== undefined) stats.signIns = data.stats.sign_ins;
        if (data.stats.unique_people !== undefined) stats.uniquePeople = data.stats.unique_people;
        if (data.stats.events !== undefined) stats.events = data.stats.events;
        
        if (Object.keys(stats).length > 0) {
          const headline = `${stats.visitors || 0} visitors, ${stats.sessions || 0} sessions`;
          return { headline, stats };
        }
      }
      
      // Users list
      if (data.users && Array.isArray(data.users)) {
        const userCount = data.users.length;
        const emails = data.users.slice(0, 3).map((u: { email?: string }) => u.email).filter(Boolean);
        return {
          headline: `${userCount} users found`,
          items: emails,
          stats: { totalUsers: userCount },
        };
      }
      
      // Firecrawl/scraping results
      if (data.data?.markdown || data.markdown) {
        const markdown = data.data?.markdown || data.markdown;
        const wordCount = markdown.split(/\s+/).length;
        return {
          headline: `Scraped ${wordCount} words`,
          stats: { words: wordCount },
        };
      }
      
      // Connection check
      if (typeof data.connected === "boolean") {
        return {
          headline: data.connected ? "Connected" : "Not connected",
          stats: { connected: data.connected },
        };
      }
    }
    
    // Agent response (from delegated agent)
    if (resultStr.includes("agentResponse")) {
      try {
        const parsed = JSON.parse(resultStr);
        if (parsed.agentResponse) {
          const preview = parsed.agentResponse.slice(0, 100);
          return { headline: preview + (parsed.agentResponse.length > 100 ? "..." : "") };
        }
      } catch {
        // Not JSON
      }
    }
    
    // Plain text response - just get first line as headline
    const firstLine = resultStr.split("\n")[0];
    if (firstLine.length > 100) {
      return { headline: firstLine.slice(0, 100) + "..." };
    }
    return { headline: firstLine };
    
  } catch {
    // If parsing fails, just return first 100 chars
    return { headline: resultStr.slice(0, 100) + (resultStr.length > 100 ? "..." : "") };
  }
}

/**
 * GET handler - returns orchestrator status
 */
export async function GET() {
  const hasDatagranKey = !!process.env.DATAGRAN_API_KEY;
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

  return NextResponse.json({
    status: "ok",
    features: {
      memory: hasDatagranKey,
      voiceTranscription: hasOpenAIKey,
    },
  });
}
