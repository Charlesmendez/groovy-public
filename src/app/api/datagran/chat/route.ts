import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyInternalRouteAuth } from "@/lib/internalRouteAuth";
import { verifyRelayDeviceToken } from "@/lib/relay/deviceToken";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";
import { getDatagranSystemPrompt, type DatagranProvider } from "@/lib/datagran/prompts";
import {
  completeAgentTrace,
  createAgentTrace,
  ingestAgentTraceToDatagranBestEffort,
} from "@/lib/traces/agentTraces";
import { randomUUID } from "crypto";
import { getOrCreateWorkspaceIdForUser } from "@/lib/billing/workspace";
import { insertBillingUsageEventBestEffort } from "@/lib/billing/events";
import { preflightGroovyUsage, settleGroovyUsageDebitBestEffort } from "@/lib/billing/guard";
import { usageChargeTypeForKeyMode } from "@/lib/billing/pricing";
import {
  ANTHROPIC_CONTEXT_1M_BETA,
  getDatagranChatModel,
} from "@/lib/ai/modelResolver";

// This route streams SSE and can run for several minutes (agentic + code execution).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel honors this for Route Handlers (plan-dependent). Safe no-op elsewhere.
export const maxDuration = 800;

type IncomingMessage = {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

type PostBody = {
  agentId?: unknown;
  sessionId?: unknown;
  messages?: unknown;
  containerId?: unknown;
  // Optional billing/trace context (passed by orchestrator)
  turnId?: unknown;
  orchestratorTraceId?: unknown;
};

const TOOL_RESULT_MAX_TOKENS = 100_000;
const APPROX_CHARS_PER_TOKEN = 4;
const TOOL_RESULT_MAX_CHARS = TOOL_RESULT_MAX_TOKENS * APPROX_CHARS_PER_TOKEN;
const MAX_MAX_TOKENS_CONTINUATIONS = 3;
const DATAGRAN_CHAT_BETAS = [
  ANTHROPIC_CONTEXT_1M_BETA,
  "code-execution-2025-08-25",
  "files-api-2025-04-14",
] as const;
const DATAGRAN_CHAT_MODEL = getDatagranChatModel();

const GMAIL_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.labels",
];

function isTransientAnthropicError(err: unknown): boolean {
  if (!err) return false;
  const record = err && typeof err === "object" ? (err as Record<string, unknown>) : null;
  const status =
    record && typeof record.status === "number"
      ? record.status
      : record && typeof record.statusCode === "number"
        ? record.statusCode
        : null;
  if (status === 500 || status === 502 || status === 503 || status === 529) return true;

  const errMsg = err instanceof Error ? err.message : String(err);
  const cause =
    record && "cause" in record
      ? record.cause instanceof Error
        ? record.cause.message
        : String(record.cause || "")
      : "";
  const combined = `${errMsg}\n${cause}`.toLowerCase();

  return (
    combined.includes("overloaded") ||
    combined.includes("internal server error") ||
    combined.includes("api_error") ||
    combined.includes("terminated") ||
    combined.includes("econnreset") ||
    combined.includes("socket hang up") ||
    combined.includes("connection reset") ||
    combined.includes("fetch failed") ||
    combined.includes("network") ||
    combined.includes("headers timeout") ||
    combined.includes("body timeout") ||
    combined.includes("und_err")
  );
}

function toStringOrEmpty(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function isHtmlErrorPage(responseText: string, contentType: string | null): boolean {
  const contentTypeNorm = String(contentType || "").toLowerCase();
  const sample = responseText.trim().slice(0, 800).toLowerCase();
  if (contentTypeNorm.includes("text/html")) return true;
  if (!sample.startsWith("<")) return false;
  return (
    sample.includes("<!doctype html") ||
    sample.includes("<html") ||
    sample.includes("<body") ||
    sample.includes("ngrok")
  );
}

function summarizeHtmlErrorPage(responseText: string): string {
  const sample = responseText.toLowerCase();
  if (sample.includes("ngrok")) {
    return "Upstream provider returned an HTML error page (tunnel/service unavailable).";
  }
  return "Upstream provider returned HTML instead of JSON. The service is likely temporarily unavailable.";
}

function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const role = v.role;
  const content = v.content;
  const okRole =
    role === "system" || role === "user" || role === "assistant" || role === "tool";
  return okRole && typeof content === "string";
}

// Execute Datagran API call server-side
async function executeDatagranApiCall(
  apiKey: string,
  connectionId: string,
  method: string,
  endpoint: string,
  body?: unknown,
  headers?: Record<string, string>,
  provider?: string
): Promise<{ success: boolean; data?: unknown; error?: string; status?: number; needsReauth?: boolean }> {
  try {
    const url = new URL(endpoint, "https://www.datagran.io");
    
    // For web_pixel provider, inject site_id instead of connection_id for pixel endpoints
    if (provider === "web_pixel" && endpoint.includes("/api/pixel/")) {
      if (!url.searchParams.has("site_id")) {
        url.searchParams.set("site_id", connectionId);
      }
    } else if (!url.searchParams.has("connection_id")) {
      // Add connection_id to URL if not already present (for other providers)
      url.searchParams.set("connection_id", connectionId);
    }

    const fetchHeaders: Record<string, string> = {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      ...headers,
    };

    // Timeout individual Datagran/Firecrawl API calls so a stalled upstream doesn't hang
    // the entire agentic loop (and by extension the orchestrator/scheduler).
    const DATAGRAN_API_TIMEOUT_MS = 60_000; // 60 seconds per API call
    const ac = new AbortController();
    const apiTimeout = setTimeout(() => ac.abort(), DATAGRAN_API_TIMEOUT_MS);

    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: fetchHeaders,
      signal: ac.signal,
    };

    if (body && method.toUpperCase() !== "GET") {
      fetchOptions.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), fetchOptions);
    } finally {
      clearTimeout(apiTimeout);
    }
    const responseText = await response.text();
    const contentType = response.headers.get("content-type");
    
    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }

    const htmlErrorPage = isHtmlErrorPage(responseText, contentType);
    if (htmlErrorPage) {
      console.warn(
        "[datagran-chat-html-response]",
        JSON.stringify({
          provider,
          method: method.toUpperCase(),
          endpoint,
          status: response.status,
          contentType,
          preview: responseText.trim().slice(0, 300),
        })
      );
    }

    if (!response.ok) {
      if (htmlErrorPage) {
        return {
          success: false,
          error: summarizeHtmlErrorPage(responseText),
          status: response.status || 503,
          needsReauth: false,
        };
      }
      // Check if the error indicates authorization is required (token expired/revoked)
      const needsReauth = isAuthorizationRequiredError(response.status, data, provider);
      console.warn(
        "[datagran-chat-api-error]",
        JSON.stringify({
          provider,
          method: method.toUpperCase(),
          endpoint,
          status: response.status,
          needsReauth,
          htmlErrorPage,
          errorPreview:
            typeof data === "string"
              ? data.slice(0, 300)
              : JSON.stringify(data).slice(0, 300),
        })
      );
      return {
        success: false,
        error: `API returned ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
        status: response.status,
        needsReauth,
      };
    }

    if (htmlErrorPage) {
      return {
        success: false,
        error: summarizeHtmlErrorPage(responseText),
        status: 503,
        needsReauth: false,
      };
    }

    return { success: true, data };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

function isLikelyRetryableStatus(status: number | undefined): boolean {
  if (!Number.isFinite(status)) return true;
  const s = Number(status);
  if (s >= 500) return true;
  if (s === 408 || s === 409 || s === 425 || s === 429) return true;
  return false;
}

function enforcePaginationGuard(
  provider: string | undefined,
  input: {
    method?: string;
    endpoint?: string;
    body?: unknown;
  }
): string | null {
  const providerNorm = (provider || "").trim().toLowerCase();
  const method = (input.method || "").toString().trim().toUpperCase();
  const endpoint = (input.endpoint || "").toString().trim().toLowerCase();

  // Enforce server-side pagination for large SQL fetches (current hotspot).
  if (
    providerNorm === "postgres" &&
    method === "POST" &&
    endpoint.includes("/api/proxy/postgres/query")
  ) {
    const body =
      input.body && typeof input.body === "object" && !Array.isArray(input.body)
        ? (input.body as Record<string, unknown>)
        : null;
    const sql = body && typeof body.sql === "string" ? body.sql : "";
    const normalizedSql = sql.replace(/\s+/g, " ").trim();
    const isSelect = /^select\b/i.test(normalizedSql);
    const hasLimit = /\blimit\s+\d+\b/i.test(normalizedSql);

    if (isSelect && !hasLimit) {
      return [
        "pagination_required: SELECT queries must include LIMIT pagination.",
        "Use LIMIT <= 500 and paginate with OFFSET (or keyset).",
        "Example: SELECT ... ORDER BY id LIMIT 500 OFFSET 0; then OFFSET 500, 1000, ...",
      ].join(" ");
    }
  }

  return null;
}

const DATAGRAN_PROVIDER_REAUTH_CAPABLE = new Set([
  "facebook_ads",
  "facebook_leads",
  "instagram",
  "google_ads",
  "google_calendar",
  "gmail",
  "linkedin_ads",
  "google_drive",
  "tiktok",
  "salesforce",
]);

function supportsDatagranProviderReauth(provider: unknown): boolean {
  const normalized =
    typeof provider === "string" ? provider.trim().toLowerCase() : "";
  return DATAGRAN_PROVIDER_REAUTH_CAPABLE.has(normalized);
}

// Check if an API error indicates re-authorization is needed
function isAuthorizationRequiredError(
  status: number,
  data: unknown,
  provider?: string
): boolean {
  // For non-OAuth providers (postgres, firecrawl, web_pixel), never emit reauth.
  if (!supportsDatagranProviderReauth(provider)) return false;

  // 401 Unauthorized typically means auth is needed
  if (status === 401) return true;

  // 403 insufficient scope should trigger a reauth with write scopes
  if (status === 403 && data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const rootError = d.error && typeof d.error === "object" ? (d.error as Record<string, unknown>) : null;
    const msg = `${typeof d.message === "string" ? d.message : ""} ${typeof rootError?.message === "string" ? rootError.message : ""}`.toLowerCase();
    const nested = Array.isArray(rootError?.errors) ? rootError.errors : [];
    const details = Array.isArray(rootError?.details) ? rootError.details : [];
    const reasons = [
      ...nested.map((x) =>
        x && typeof x === "object" && typeof (x as Record<string, unknown>).reason === "string"
          ? (x as Record<string, unknown>).reason as string
          : ""
      ),
      ...details.map((x) =>
        x && typeof x === "object" && typeof (x as Record<string, unknown>).reason === "string"
          ? (x as Record<string, unknown>).reason as string
          : ""
      ),
    ].filter(Boolean);
    if (
      msg.includes("insufficient authentication scopes") ||
      msg.includes("insufficient permission") ||
      reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
      reasons.includes("insufficientPermissions")
    ) {
      return true;
    }
  }
  
  // Check for specific error codes/messages in the response body
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    // Datagran-specific: status field indicates authorization_required
    if (d.status === "authorization_required") return true;
    if (d.error === "authorization_required") return true;
    // OAuth token expired
    if (typeof d.error === "string" && /token.*expired|invalid.*token|authorization.*required/i.test(d.error)) return true;
    if (typeof d.message === "string" && /token.*expired|invalid.*token|authorization.*required/i.test(d.message)) return true;
  }
  
  return false;
}

// Extract file info from code execution results
interface FileInfo {
  file_id: string;
  filename: string;
  mime_type?: string;
}

// Stored file info with Supabase storage details
interface StoredFileInfo extends FileInfo {
  storage_path?: string;
  url?: string;
}

// MIME type mapping for common file extensions
const MIME_TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain",
  html: "text/html",
};

function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return MIME_TYPES[ext] || "application/octet-stream";
}

function extractFilesFromResponse(response: Anthropic.Beta.Messages.BetaMessage): FileInfo[] {
  const files: FileInfo[] = [];
  
  for (const block of response.content) {
    // Handle bash_code_execution_tool_result
    // Structure: { type: "bash_code_execution_tool_result", content: { type: "bash_code_execution_result", content: [{ type: "bash_code_execution_output", file_id: "..." }] } }
    if (block.type === "bash_code_execution_tool_result") {
      const result = block as { content?: { type?: string; content?: unknown[]; stdout?: string } };
      if (result.content?.type === "bash_code_execution_result" && Array.isArray(result.content.content)) {
        for (const item of result.content.content) {
          if (item && typeof item === "object" && "file_id" in item) {
            const fileItem = item as { file_id: string; filename?: string; mime_type?: string };
            // Try to extract filename from stdout if available
            let filename = fileItem.filename || "output.png";
            if (result.content.stdout) {
              const match = result.content.stdout.match(/([^\s/]+\.(png|jpg|jpeg|gif|svg|pdf|csv|json|txt))[\s\n]/i);
              if (match) filename = match[1];
            }
            files.push({
              file_id: fileItem.file_id,
              filename,
              mime_type: fileItem.mime_type,
            });
          }
        }
      }
    }
    
    // Handle text_editor_code_execution_tool_result
    if (block.type === "text_editor_code_execution_tool_result") {
      const result = block as { content?: { type?: string; content?: unknown[] } };
      if (result.content && Array.isArray(result.content.content)) {
        for (const item of result.content.content) {
          if (item && typeof item === "object" && "file_id" in item) {
            const fileItem = item as { file_id: string; filename?: string; mime_type?: string };
            files.push({
              file_id: fileItem.file_id,
              filename: fileItem.filename || "output",
              mime_type: fileItem.mime_type,
            });
          }
        }
      }
    }
  }
  
  return files;
}

// Define the datagran_api tool for Claude
const DATAGRAN_API_TOOL: Anthropic.Tool = {
  name: "datagran_api",
  description: `Call the Datagran API to fetch data from the connected service. Use this tool to make any API requests to Datagran endpoints.

IMPORTANT: The connection_id and x-api-key headers are automatically added. Do NOT include them in your request.

Examples:
- GET /api/facebook-ads/accounts
- GET /api/google-ads/accounts  
- POST /api/proxy/google-ads/v21/customers/123/googleAds:searchStream with body {"query": "SELECT campaign.id FROM campaign"}
- POST /api/proxy/firecrawl/v1/scrape with body {"url": "https://example.com", "formats": ["markdown"]}`,
  input_schema: {
    type: "object" as const,
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "DELETE"],
        description: "HTTP method",
      },
      endpoint: {
        type: "string",
        description: "API endpoint path starting with /api/ (e.g., /api/facebook-ads/accounts)",
      },
      body: {
        type: "object",
        description: "Request body for POST/PUT requests (optional)",
      },
      headers: {
        type: "object",
        description: "Additional headers (optional). Do NOT include x-api-key or connection_id.",
      },
    },
    required: ["method", "endpoint"],
  },
};

export async function POST(req: Request) {
  // Support cookie auth (dashboard) OR device-token auth (WhatsApp/connector).
  const deviceToken = req.headers.get("x-device-token") || "";
  const relaySecret = process.env.RELAY_JWT_SECRET || "";
  const verified = deviceToken ? verifyRelayDeviceToken(deviceToken, relaySecret) : null;
  const verifiedInternal = verified ? null : verifyInternalRouteAuth(req, "datagran-chat");

  const supabase =
    verified || verifiedInternal
      ? createSupabaseAdminClient()
      : await createSupabaseServerClient();

  let user: { id: string; email?: string } | null = null;
  if (verified) {
    user = { id: verified.userId };
  } else if (verifiedInternal) {
    user = { id: verifiedInternal.userId };
  } else {
    const {
      data: { user: cookieUser },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !cookieUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    user = { id: cookieUser.id, email: cookieUser.email ?? undefined };
  }

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

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const agentId = toStringOrEmpty(body.agentId);
  const sessionId = toStringOrEmpty(body.sessionId);
  const localTimezoneRaw = toStringOrEmpty(req.headers.get("x-local-timezone")).trim();
  const localTimezone = localTimezoneRaw || undefined;
  const containerId = toStringOrEmpty(body.containerId) || undefined;
  const turnIdRaw = toStringOrEmpty(body.turnId);
  const orchestratorTraceIdRaw = toStringOrEmpty(body.orchestratorTraceId);
  const effectiveTurnId = turnIdRaw || orchestratorTraceIdRaw || "";
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

  let traceId: string | null = null;
  let traceCreatedAtIso = new Date().toISOString();

  // Load agent and its Datagran config
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, name, type, flag_key")
    .eq("id", agentId)
    .single();

  if (agentError || !agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (agent.type !== "datagran") {
    return NextResponse.json(
      { error: "Agent type is not datagran" },
      { status: 400 }
    );
  }

  const cookie = req.headers.get("cookie") || "";
  const resolved = await resolveKeys(user.id, supabase, cookie);
  const keyMode = resolved.keyModes.anthropic || resolved.globalMode;

  // Load Datagran config
  const { data: config, error: cfgError } = await supabase
    .from("datagran_agent_configs")
    .select("provider, connection_id, datagran_api_key_enc")
    .eq("agent_id", agentId)
    .single();

  if (cfgError || !config) {
    return NextResponse.json(
      { error: "Datagran config not found" },
      { status: 404 }
    );
  }

  if (!config.connection_id) {
    return NextResponse.json(
      { error: "Datagran connection not authenticated. Please authenticate first." },
      { status: 400 }
    );
  }

  // Decrypt API keys
  const anthropicApiKey: string | null =
    keyMode === "user" ? (resolved.userKeys.anthropic || null) : null;
  let datagranApiKey: string;

  try {
    datagranApiKey = decryptLlmApiKey(config.datagran_api_key_enc);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to decrypt API keys" },
      { status: 500 }
    );
  }

  if (keyMode === "user" && !anthropicApiKey) {
    return NextResponse.json(
      {
        error: "Missing Anthropic API key. Add it in Settings, or switch Anthropic to Groovy.",
      },
      { status: 400 }
    );
  }

  if (keyMode === "groovy" && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      {
        error:
          "No Anthropic API key available for Datagran agent. Add one in Settings → API Keys, or set ANTHROPIC_API_KEY on the server.",
      },
      { status: 500 }
    );
  }

  const usageChargeType = usageChargeTypeForKeyMode(keyMode);
  if (billingWorkspaceId) {
    const preflight = await preflightGroovyUsage({
      workspaceId: billingWorkspaceId,
      userId: user.id,
      userEmail: user.email || null,
      traceId: orchestratorTraceIdRaw || randomUUID(),
      source: "datagran_chat",
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

  // Persist latest user message
  if (userText.trim()) {
    const { count } = await supabase
      .from("chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId);

    await supabase.from("chat_messages").insert({
      user_id: user.id,
      session_id: sessionId,
      role: "user",
      content: userText,
      metadata: {
        agent_id: agentId,
      },
    });

    const trace = await createAgentTrace(supabase, {
      userId: user.id,
      agentId,
      sessionId,
      agentName: agent.name,
      agentType: agent.type,
      flagKey: (agent as unknown as { flag_key?: string | null }).flag_key || null,
      provider: "anthropic",
      model: DATAGRAN_CHAT_MODEL,
      prompt: userText,
      metadata: {
        datagran_provider: config.provider,
      },
    });
    traceId = trace.traceId;
    traceCreatedAtIso = trace.createdAtIso;

    // If first message, update session title
    const updateData: { updated_at: string; title?: string } = {
      updated_at: new Date().toISOString(),
    };
    if (count === 0) {
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

  // Create Anthropic client
  const anthropic = new Anthropic(
    anthropicApiKey ? { apiKey: anthropicApiKey } : {}
  );

  // Build system prompt with Datagran API info (but NOT the credentials in the prompt)
  const systemPrompt = getDatagranSystemPrompt(
    config.provider as DatagranProvider,
    config.connection_id,
    datagranApiKey,
    localTimezone
  );

  // Convert messages to Anthropic format
  const anthropicMessages: Anthropic.Beta.Messages.BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      anthropicMessages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      anthropicMessages.push({ role: "assistant", content: m.content });
    }
  }

  let streamClosed = false;

  // Helper to send SSE event
  const sendSSE = (controller: ReadableStreamDefaultController, encoder: TextEncoder, data: unknown) => {
    if (streamClosed) return;
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {
      streamClosed = true;
    }
  };

  // Create streaming response with agentic loop (SSE format)
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      streamClosed = false;
      try {
        const currentMessages = [...anthropicMessages];
        let fullText = "";
        const storedFiles: StoredFileInfo[] = [];
        let currentContainerId = containerId;
        const maxIterations = 10; // Prevent infinite loops
        const MAX_RETRIES = 3;
        let continueAfterMaxTokens = false;
        let maxTokensContinuationCount = 0;
        
        // --- Error circuit breaker ---
        // Track consecutive API call failures. When we see repeated errors,
        // inject a message telling the model to stop retrying and work with
        // whatever data it already has.
        let consecutiveApiErrors = 0;
        let maxConsecutiveApiErrors = 0;
        let totalApiErrors = 0;
        let circuitBreakerTriggered = false;
        let sawNonRetryableApiError = false;
        let lastApiErrorStatus: number | null = null;
        let lastApiErrorText: string | null = null;
        const CIRCUIT_BREAKER_THRESHOLD = 3; // After 3 consecutive errors, tell model to stop
        
        // Helper to create API stream with retry for overloaded errors
        const createStreamWithRetry = async (msgs: typeof currentMessages, cId?: string) => {
          for (let retry = 0; retry < MAX_RETRIES; retry++) {
            try {
              const stream = anthropic.beta.messages.stream({
                model: DATAGRAN_CHAT_MODEL,
                max_tokens: 16384,
                betas: [...DATAGRAN_CHAT_BETAS],
                system: [{ type: "text" as const, text: systemPrompt, cache_control: { type: "ephemeral" as const } }],
                messages: msgs,
                container: cId,
                tools: [
                  DATAGRAN_API_TOOL,
                  {
                    type: "code_execution_20250825" as const,
                    name: "code_execution",
                  },
                ],
              });
              return stream;
            } catch (err) {
              if (isTransientAnthropicError(err)) {
                console.log(`[datagran-chat] Anthropic transient error, retrying (${retry + 1}/${MAX_RETRIES})...`);
                sendSSE(controller, encoder, { type: "status", text: "Server busy, retrying..." });
                await new Promise(r => setTimeout(r, Math.pow(2, retry + 1) * 1000));
                continue;
              }
              throw err;
            }
          }
          throw new Error("Anthropic API unavailable after retries");
        };
        
        for (let i = 0; i < maxIterations; i++) {
          const appendIterationText = continueAfterMaxTokens;
          continueAfterMaxTokens = false;
          // On non-first iterations, tell the client to discard the previous
          // iteration's streaming text so intermediate "I'll gather..." scaffolding
          // doesn't get concatenated with the final comprehensive response.
          if (i > 0 && !appendIterationText) {
            sendSSE(controller, encoder, { type: "clear_text" });
          }

          // Wrap in retry loop for overloaded errors during streaming
          let response: Anthropic.Beta.Messages.BetaMessage | null = null;
          let iterationText = "";
          
          for (let streamRetry = 0; streamRetry < MAX_RETRIES; streamRetry++) {
            try {
              // Use streaming API for real-time output with retry
              const apiStream = await createStreamWithRetry(currentMessages, currentContainerId);
              iterationText = "";

              // Stream text in real-time via SSE
              let streamEventCount = 0;
              let textDeltaCount = 0;
              for await (const event of apiStream) {
                streamEventCount++;
                if (event.type === "message_start") {
                  if (event.message.container?.id) {
                    currentContainerId = event.message.container.id;
                  }
                  console.log("[datagran-chat] Stream: message_start, container:", event.message.container?.id);
                } else if (event.type === "content_block_start") {
                  const block = event.content_block;
                  console.log("[datagran-chat] Stream: content_block_start, type:", block.type);
                  if (block.type === "server_tool_use") {
                    const toolName = (block as { name?: string }).name || "code_execution";
                    sendSSE(controller, encoder, { type: "status", text: `Running ${toolName}...` });
                  } else if (block.type === "thinking") {
                    console.log("[datagran-chat] Stream: thinking block started");
                    sendSSE(controller, encoder, { type: "status", text: "Thinking..." });
                  }
                } else if (event.type === "content_block_delta") {
                  const delta = event.delta;
                  if (delta.type === "text_delta") {
                    textDeltaCount++;
                    iterationText += delta.text;
                    sendSSE(controller, encoder, { type: "text", text: delta.text });
                    // Log every 50th delta for progress tracking
                    if (textDeltaCount % 50 === 1) {
                      console.log(`[datagran-chat] Stream: text_delta #${textDeltaCount}, total text: ${iterationText.length} chars`);
                    }
                  } else if (delta.type === "thinking_delta") {
                    // Stream thinking content too
                    const thinkingDelta = delta as { thinking?: string };
                    if (thinkingDelta.thinking) {
                      sendSSE(controller, encoder, { type: "text", text: thinkingDelta.thinking });
                      iterationText += thinkingDelta.thinking;
                    }
                  }
                } else if (event.type === "content_block_stop") {
                  console.log("[datagran-chat] Stream: content_block_stop");
                }
              }
              console.log(`[datagran-chat] Stream complete: ${streamEventCount} events, ${textDeltaCount} text deltas, ${iterationText.length} chars`);

              // Get final response
              response = await apiStream.finalMessage();
              if (billingWorkspaceId) {
                const usage = (response as unknown as { usage?: unknown }).usage;
                const billingTraceId = traceId || randomUUID();
                const billingTurnId = effectiveTurnId || traceId || billingTraceId;
                insertBillingUsageEventBestEffort({
                  workspaceId: billingWorkspaceId,
                  userId: user.id,
                  turnId: billingTurnId,
                  traceId: billingTraceId,
                  source: "datagran_agent",
                  spanId: `iter-${i}`,
                  provider: "anthropic",
                  model: DATAGRAN_CHAT_MODEL,
                  usage,
                  billable: true,
                  chargeType: usageChargeType,
                  meta: {
                    agentId,
                    datagran_provider: config.provider,
                    container_id: currentContainerId,
                    orchestratorTraceId: orchestratorTraceIdRaw || null,
                  },
                });
                await settleGroovyUsageDebitBestEffort({
                  workspaceId: billingWorkspaceId,
                  userId: user.id,
                  traceId: billingTraceId,
                  turnId: billingTurnId,
                  source: "datagran_agent",
                  spanId: `iter-${i}`,
                  model: DATAGRAN_CHAT_MODEL,
                  usage,
                  chargeType: usageChargeType,
                  meta: {
                    agentId,
                    datagran_provider: config.provider,
                    container_id: currentContainerId,
                    orchestratorTraceId: orchestratorTraceIdRaw || null,
                  },
                }).catch(() => {});
              }
              break; // Success, exit retry loop
            } catch (streamErr) {
              if (isTransientAnthropicError(streamErr) && streamRetry < MAX_RETRIES - 1) {
                console.log(`[datagran-chat] Stream transient error, retrying (${streamRetry + 1}/${MAX_RETRIES})...`);
                sendSSE(controller, encoder, { type: "status", text: "Server busy, retrying request..." });
                await new Promise(r => setTimeout(r, Math.pow(2, streamRetry + 1) * 1000));
                continue;
              }
              throw streamErr;
            }
          }
          
          if (!response) {
            throw new Error("Failed to get response after retries");
          }
          
          // Usually we keep only the latest iteration's text (we clear older scaffolding).
          // When continuing after stop_reason=max_tokens, append instead.
          fullText = appendIterationText ? `${fullText}${iterationText}` : iterationText;
          
          // Debug: Log content block types and detailed structure
          console.log("[datagran-chat] Response content blocks:", response.content.map(b => b.type));
          console.log("[datagran-chat] Iteration text length:", iterationText.length);
          console.log("[datagran-chat] Full text length so far:", fullText.length);
          console.log("[datagran-chat] Stop reason:", response.stop_reason);
          
          // Log content of each block for debugging
          for (let blockIdx = 0; blockIdx < response.content.length; blockIdx++) {
            const block = response.content[blockIdx];
            if (block.type === "text") {
              const textBlock = block as { type: "text"; text: string };
              console.log(`[datagran-chat] Block ${blockIdx} (text): ${textBlock.text.length} chars, preview: ${textBlock.text.slice(0, 200)}...`);
            } else if (block.type === "tool_use") {
              const toolBlock = block as { type: "tool_use"; name: string; id: string };
              console.log(`[datagran-chat] Block ${blockIdx} (tool_use): ${toolBlock.name}, id: ${toolBlock.id}`);
            } else if (block.type === "server_tool_use") {
              const serverToolBlock = block as { type: "server_tool_use"; name?: string };
              console.log(`[datagran-chat] Block ${blockIdx} (server_tool_use): ${serverToolBlock.name || "code_execution"}`);
            } else if (block.type === "bash_code_execution_tool_result") {
              const resultBlock = block as { content?: { stdout?: string; stderr?: string } };
              console.log(`[datagran-chat] Block ${blockIdx} (bash_code_execution_tool_result): stdout=${resultBlock.content?.stdout?.length || 0} chars, stderr=${resultBlock.content?.stderr?.length || 0} chars`);
              if (resultBlock.content?.stdout) {
                console.log(`[datagran-chat] stdout preview: ${resultBlock.content.stdout.slice(0, 500)}...`);
              }
            } else {
              console.log(`[datagran-chat] Block ${blockIdx} (${block.type})`);
            }
          }
          
          // Extract files from code execution results
          const newFiles = extractFilesFromResponse(response);
          console.log("[datagran-chat] Extracted files:", newFiles);

          // Download and persist each file to Supabase
          for (const file of newFiles) {
            try {
              sendSSE(controller, encoder, { type: "status", text: `Saving ${file.filename}...` });

              // Get file metadata from Anthropic
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const fileMeta = await (anthropic.beta.files as any).retrieveMetadata(
                file.file_id,
                { betas: ["files-api-2025-04-14"] }
              );
              console.log("[datagran-chat] File metadata:", JSON.stringify(fileMeta, null, 2));

              const fileName = fileMeta?.filename || file.filename || `file_${storedFiles.length + 1}`;

              // Download the file content
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const fileResponse = await (anthropic.beta.files as any).download(
                file.file_id,
                { betas: ["files-api-2025-04-14"] }
              );

              // Convert to buffer
              let fileBuffer: Buffer;
              if (fileResponse instanceof Response) {
                const arrayBuffer = await fileResponse.arrayBuffer();
                fileBuffer = Buffer.from(arrayBuffer);
              } else if (fileResponse?.body?.getReader) {
                const chunks: Uint8Array[] = [];
                const reader = fileResponse.body.getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  chunks.push(value);
                }
                fileBuffer = Buffer.concat(chunks);
              } else if (Buffer.isBuffer(fileResponse)) {
                fileBuffer = fileResponse;
              } else {
                fileBuffer = Buffer.from(fileResponse);
              }

              console.log("[datagran-chat] Downloaded file, size:", fileBuffer.length);

              // Determine MIME type
              const mimeType = getMimeType(fileName);

              // Store in Supabase
              const storagePath = `${user.id}/${sessionId}/${randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

              const { error: uploadError } = await supabase.storage
                .from("chat_uploads")
                .upload(storagePath, fileBuffer, {
                  contentType: mimeType,
                  upsert: false,
                });

              if (!uploadError) {
                // Generate signed URL for download
                const { data: signedData } = await supabase.storage
                  .from("chat_uploads")
                  .createSignedUrl(storagePath, 3600); // 1 hour expiry

                const storedFile: StoredFileInfo = {
                  file_id: file.file_id,
                  filename: fileName,
                  mime_type: mimeType,
                  storage_path: storagePath,
                  url: signedData?.signedUrl,
                };
                storedFiles.push(storedFile);

                // Send file event to client
                console.log("[datagran-chat] Sending file SSE event:", storedFile.filename, "url:", !!storedFile.url);
                sendSSE(controller, encoder, { type: "file", file: storedFile });

                // Record in chat_attachments table
                await supabase.from("chat_attachments").insert({
                  user_id: user.id,
                  session_id: sessionId,
                  storage_path: storagePath,
                  file_name: fileName,
                  mime_type: mimeType,
                  size_bytes: fileBuffer.length,
                });

                console.log("[datagran-chat] File stored successfully:", fileName);
              } else {
                console.error("[datagran-chat] Supabase upload error:", uploadError);
                // Still track the file with just Anthropic file_id for fallback
                storedFiles.push({
                  file_id: file.file_id,
                  filename: fileName,
                  mime_type: mimeType,
                });
              }
            } catch (downloadErr) {
              console.error("[datagran-chat] Failed to download file:", downloadErr);
              // Track file with just the file_id for on-demand download fallback
              const fallbackFile: StoredFileInfo = {
                file_id: file.file_id,
                filename: file.filename,
                mime_type: file.mime_type,
              };
              storedFiles.push(fallbackFile);
              // Still send file event so client can try to load via fallback API
              sendSSE(controller, encoder, { type: "file", file: fallbackFile });
            }
          }

          // Check if Claude called our custom datagran_api tool
          const datagranToolUses = response.content.filter(
            (block): block is Anthropic.Beta.Messages.BetaToolUseBlock =>
              block.type === "tool_use" && block.name === "datagran_api"
          );

          // If no datagran_api calls:
          // - end_turn => done
          // - max_tokens => continue from partial response (don't finalize truncated turn)
          // - anything else => done
          if (datagranToolUses.length === 0) {
            if (response.stop_reason === "end_turn") {
              break;
            }

            if (response.stop_reason === "max_tokens") {
              maxTokensContinuationCount++;
              if (maxTokensContinuationCount > MAX_MAX_TOKENS_CONTINUATIONS) {
                console.warn(
                  `[datagran-chat] max_tokens continuation limit reached (${MAX_MAX_TOKENS_CONTINUATIONS}); returning best-effort response`
                );
                sendSSE(controller, encoder, {
                  type: "status",
                  text: "Response reached token limit repeatedly; returning best-effort output.",
                });
                break;
              }

              sendSSE(controller, encoder, {
                type: "status",
                text: "Token limit reached; continuing response...",
              });

              // IMPORTANT:
              // Do NOT replay raw assistant content blocks here. If the last streamed message
              // ended with an unfinished server_tool_use block (e.g. text_editor_code_execution),
              // Anthropic will reject the next request with a 400 because that tool use has no
              // corresponding *_tool_result block in history.
              //
              // For continuation, only carry forward assistant text context.
              const continuationAssistantText =
                (iterationText || fullText || "")
                  .trim()
                  .slice(-20_000) || "[continuing previous response]";

              currentMessages.push({
                role: "assistant",
                content: continuationAssistantText,
              });
              currentMessages.push({
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "[SYSTEM] Continue exactly where you left off. Do not repeat prior explanation. Do not re-run API calls unless absolutely required to complete a missing final artifact or value.",
                  },
                ],
              });
              continueAfterMaxTokens = true;
              continue;
            }

            break;
          }
          maxTokensContinuationCount = 0;

          // Execute our datagran_api tool calls
          // First, add the assistant message (with full content including tool_use)
          currentMessages.push({
            role: "assistant",
            content: response.content as Anthropic.Beta.Messages.BetaContentBlockParam[],
          });

          // Execute tool calls and build tool results
          const toolResults: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
          
          for (const toolUse of datagranToolUses) {
            const input = toolUse.input as {
              method?: string;
              endpoint?: string;
              body?: unknown;
              headers?: Record<string, string>;
            };

            sendSSE(controller, encoder, { type: "status", text: `Calling Datagran API: ${input.method} ${input.endpoint}...` });

            const paginationGuardError = enforcePaginationGuard(
              config.provider as string | undefined,
              input
            );
            if (paginationGuardError) {
              consecutiveApiErrors++;
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: `Error: ${paginationGuardError}`,
              });
              sendSSE(controller, encoder, {
                type: "status",
                text: "Pagination required; returned guidance to model.",
              });
              continue;
            }

            const result = await executeDatagranApiCall(
              datagranApiKey,
              config.connection_id,
              input.method || "GET",
              input.endpoint || "",
              input.body,
              input.headers,
              config.provider
            );
            
            // Track consecutive errors for circuit breaker
            if (!result.success) {
              consecutiveApiErrors++;
              totalApiErrors++;
              maxConsecutiveApiErrors = Math.max(maxConsecutiveApiErrors, consecutiveApiErrors);
              if (typeof result.status === "number") {
                lastApiErrorStatus = result.status;
                if (!isLikelyRetryableStatus(result.status)) {
                  sawNonRetryableApiError = true;
                }
              }
              if (typeof result.error === "string" && result.error.trim()) {
                lastApiErrorText = result.error.slice(0, 500);
              }
              console.log(`[datagran-chat] API error #${consecutiveApiErrors}: ${result.error?.slice(0, 200)}`);
            } else {
              consecutiveApiErrors = 0; // Reset on success
            }

            // Check if re-authorization is needed
            if (result.needsReauth) {
              console.log("[datagran-chat] Authorization required, generating link token...");
              // Generate a fresh link token for re-auth
              try {
                const origin = req.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
                const providerNorm = String(config.provider || "").trim().toLowerCase();
                const scopes = providerNorm === "gmail" ? GMAIL_REQUIRED_SCOPES : undefined;
                const linkTokenRes = await fetch("https://www.datagran.io/api/link/token", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-api-key": datagranApiKey,
                  },
                  body: JSON.stringify({
                    endUser: {
                      externalId: `flow_${user.id}`,
                      email: user.email || undefined,
                    },
                    origin,
                    provider: config.provider,
                    ...(Array.isArray(scopes) && scopes.length > 0 ? { scopes } : {}),
                  }),
                });

                if (linkTokenRes.ok) {
                  const linkTokenData = await linkTokenRes.json();
                  const linkToken = linkTokenData.linkToken || linkTokenData.link_token;
                  sendSSE(controller, encoder, {
                    type: "needs_reauth",
                    provider: config.provider,
                    agentId,
                    linkToken,
                    error: result.error,
                  });
                } else {
                  // Couldn't get link token, just send error
                  sendSSE(controller, encoder, {
                    type: "needs_reauth",
                    provider: config.provider,
                    agentId,
                    error: result.error,
                  });
                }
              } catch (linkErr) {
                console.error("[datagran-chat] Failed to get link token:", linkErr);
                sendSSE(controller, encoder, {
                  type: "needs_reauth",
                  provider: config.provider,
                  agentId,
                  error: result.error,
                });
              }
              if (!streamClosed) {
                controller.close();
                streamClosed = true;
              }
              return;
            }

            const resultContent = result.success
              ? JSON.stringify(result.data, null, 2)
              : `Error: ${result.error}`;

            // Truncate very long responses (~100k token budget)
            const maxLen = TOOL_RESULT_MAX_CHARS;
            const truncatedContent = resultContent.length > maxLen
              ? resultContent.slice(0, maxLen) +
                `\n... (truncated at ~${TOOL_RESULT_MAX_TOKENS} tokens; fetch remaining rows with pagination)`
              : resultContent;

            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: truncatedContent,
            });

            sendSSE(controller, encoder, { type: "status", text: `API response received (${truncatedContent.length} chars)` });
          }

          // Add tool results to messages
          currentMessages.push({
            role: "user",
            content: toolResults,
          });
          
          // Circuit breaker: if we've seen too many consecutive API errors,
          // inject a message telling the model to stop retrying and wrap up.
          if (consecutiveApiErrors >= CIRCUIT_BREAKER_THRESHOLD) {
            if (!circuitBreakerTriggered) {
              circuitBreakerTriggered = true;
              console.warn(
                "[datagran-chat-circuit-breaker]",
                JSON.stringify({
                  provider: config.provider,
                  agentId,
                  totalApiErrors,
                  maxConsecutiveApiErrors,
                  consecutiveAtEnd: consecutiveApiErrors,
                  lastStatus: lastApiErrorStatus,
                  sawNonRetryableApiError,
                  lastError: lastApiErrorText,
                })
              );
              sendSSE(controller, encoder, {
                type: "run_policy",
                dataQueryRetryable: sawNonRetryableApiError ? false : true,
                reason: sawNonRetryableApiError
                  ? "upstream_non_retryable_errors"
                  : "upstream_retryable_or_mixed_errors",
                apiErrors: {
                  total: totalApiErrors,
                  maxConsecutive: maxConsecutiveApiErrors,
                  consecutiveAtEnd: consecutiveApiErrors,
                  lastStatus: lastApiErrorStatus,
                  sawNonRetryableApiError,
                  lastError: lastApiErrorText,
                },
              });
            }
            console.log(`[datagran-chat] Circuit breaker triggered after ${consecutiveApiErrors} consecutive API errors. Telling model to stop retrying.`);
            sendSSE(controller, encoder, { type: "status", text: "Multiple API errors detected — wrapping up with available data..." });
            currentMessages.push({
              role: "user",
              content: [{
                type: "text",
                text:
                  `[SYSTEM] Multiple consecutive API calls have failed (${consecutiveApiErrors} in a row). ` +
                  `Do NOT make any more API calls. Summarize whatever valid data you already collected. ` +
                  `If you have no usable data at all, reply with a short user-facing explanation that the provider is temporarily unavailable right now and they should retry later. ` +
                  `Do NOT mention internal HTML pages, ngrok, tunnels, raw upstream payloads, or process narration like "I'll fetch..." or "I queried...".`,
              }],
            });
          }
        }

        // Save assistant message with metadata (including stored files with URLs)
        const responseText = fullText.trim() || (storedFiles.length > 0 ? "[File operation completed]" : "");
        
        if (responseText) {
          const messageMetadata: Record<string, unknown> = {
            agent_id: agentId,
            provider: "anthropic",
            model: DATAGRAN_CHAT_MODEL,
            datagran_provider: config.provider,
          };
          
          if (currentContainerId) {
            messageMetadata.container_id = currentContainerId;
          }
          
          if (storedFiles.length > 0) {
            messageMetadata.generated_files = storedFiles;
          }

          await supabase.from("chat_messages").insert({
            user_id: user.id,
            session_id: sessionId,
            role: "assistant",
            content: responseText,
            metadata: messageMetadata,
          });

          if (traceId) {
            await completeAgentTrace(supabase, { traceId, response: responseText });
            // Fire-and-forget: don't block response waiting for Datagran
            ingestAgentTraceToDatagranBestEffort(supabase, {
              userId: user.id,
              traceId,
              createdAtIso: traceCreatedAtIso,
              agentName: agent.name,
              agentType: agent.type,
              flagKey: (agent as unknown as { flag_key?: string | null }).flag_key || null,
              provider: "anthropic",
              model: DATAGRAN_CHAT_MODEL,
              sessionId,
              prompt: userText,
              response: responseText,
              metadata: {
                datagran_provider: config.provider,
                container_id: currentContainerId,
                generated_files: storedFiles.length > 0 ? storedFiles : undefined,
              },
            });
          }
          
          await supabase
            .from("chat_sessions")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", sessionId);
        }

        // Log final response before sending done
        console.log("[datagran-chat] Final response:", {
          fullTextLength: fullText.length,
          storedFilesCount: storedFiles.length,
          containerId: currentContainerId,
          textPreview: fullText.slice(0, 500),
          textEnd: fullText.slice(-200),
        });

        // Send done event with all files and container ID
        console.log("[datagran-chat] Sending done SSE event with files:", storedFiles.map(f => ({ filename: f.filename, hasUrl: !!f.url })));
        const diagnostics = {
          apiErrors: {
            total: totalApiErrors,
            maxConsecutive: maxConsecutiveApiErrors,
            consecutiveAtEnd: consecutiveApiErrors,
            circuitBreakerTriggered,
            lastStatus: lastApiErrorStatus,
            sawNonRetryableApiError,
            lastError: lastApiErrorText,
          },
          runPolicy: {
            dataQueryRetryable:
              circuitBreakerTriggered && sawNonRetryableApiError ? false : true,
            reason:
              circuitBreakerTriggered && sawNonRetryableApiError
                ? "upstream_non_retryable_errors"
                : circuitBreakerTriggered
                  ? "upstream_retryable_or_mixed_errors"
                  : "no_circuit_breaker",
          },
        };
        sendSSE(controller, encoder, {
          type: "done",
          files: storedFiles,
          containerId: currentContainerId,
          diagnostics,
        });
        if (!streamClosed) {
          controller.close();
          streamClosed = true;
        }
      } catch (error) {
        console.error("[datagran-chat] Anthropic API error:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        sendSSE(controller, encoder, { type: "error", error: errorMessage });
        if (!streamClosed) {
          controller.close();
          streamClosed = true;
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
