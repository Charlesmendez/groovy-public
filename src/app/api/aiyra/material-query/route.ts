import { createHash, createHmac } from "crypto";
import { after, NextResponse } from "next/server";
import { generateText, type ModelMessage } from "ai";
import { resolveAppBaseUrl } from "@/lib/appBaseUrl";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveChatModel } from "@/lib/ai/modelResolver";
import { runOrchestratorRound } from "@/lib/orchestrator/runOrchestratorRound";
import { callConnectorRpcViaRelay } from "@/lib/relay/connectorRpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

type MaterialQueryBody = {
  conversationId?: string;
  conversation_id?: string;
  prompt?: string;
  query?: string;
  question?: string;
  message?: string;
  text?: string;
  input?: string;
  materialQuery?: {
    prompt?: string;
    query?: string;
    question?: string;
    text?: string;
    message?: string;
  };
  material_query?: {
    prompt?: string;
    query?: string;
    question?: string;
    text?: string;
    message?: string;
  };
  accountId?: string;
  keyId?: string;
  channelMode?: "mic_main" | "twilio_main";
  lang?: string;
};

type ConversationBindingRow = {
  conversation_id: string;
  user_id: string;
  orchestrator_session_id: string;
  device_id: string | null;
  account_id: string | null;
  key_id: string | null;
  channel_mode: string | null;
};

type PersistedMessageRow = {
  role: "user" | "assistant";
  content: string;
  trace_id: string | null;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
};

type MaterialQueryClaimRow = {
  conversation_id: string;
  user_id: string;
  request_fingerprint: string;
  normalized_query: string;
  trace_id: string;
  status: "running" | "completed" | "failed";
  response_text: string | null;
  error_text: string | null;
  updated_at: string | null;
  expires_at: string | null;
};

type MaterialQueryToolTokenPayload = {
  conversationId: string;
  exp: number;
};

const MATERIAL_QUERY_TIMEOUT_MS = 120_000;
const MATERIAL_QUERY_CLAIM_TTL_MS = MATERIAL_QUERY_TIMEOUT_MS + 5_000;
const MATERIAL_QUERY_CLAIM_WAIT_MS = 2_000;
const MATERIAL_QUERY_POLL_AFTER_MS = 2_000;
const MATERIAL_QUERY_FAILED_TTL_MS = 30_000;
const MATERIAL_QUERY_PROGRESS_ANTHROPIC_MODEL = "claude-haiku-4.5";
const MATERIAL_QUERY_PROGRESS_HUMANIZE_TIMEOUT_MS = 2_500;
const MATERIAL_QUERY_SUMMARY_ANTHROPIC_MODEL = "claude-haiku-4.5";
const MATERIAL_QUERY_SUMMARY_OPENAI_MODEL = "gpt-4o-mini";
const MATERIAL_QUERY_TOOL_PROGRESS_ENABLED =
  process.env.AIYRA_MATERIAL_QUERY_TOOL_PROGRESS_ENABLED == null
    ? true
    : envBoolean(process.env.AIYRA_MATERIAL_QUERY_TOOL_PROGRESS_ENABLED);

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function getMaterialQueryPollSecret(): string {
  const secret =
    trimmed(process.env.AIYRA_MATERIAL_QUERY_POLL_SECRET) ||
    trimmed(process.env.RELAY_JWT_SECRET) ||
    trimmed(process.env.AIYRA_MATERIAL_QUERY_BEARER) ||
    trimmed(process.env.AIYRA_MATERIAL_QUERY_AUTH_BEARER);
  if (!secret) {
    throw new Error("Missing material-query poll secret");
  }
  return secret;
}

function verifyMaterialQueryToolToken(
  token: string
): MaterialQueryToolTokenPayload | null {
  const [encodedPayload, encodedSignature] = token.split(".");
  if (!encodedPayload || !encodedSignature) return null;
  const expectedSignature = createHmac("sha256", getMaterialQueryPollSecret())
    .update(encodedPayload)
    .digest("base64url");
  if (expectedSignature !== encodedSignature) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    const conversationId = trimmed(payload.conversationId);
    const exp = Number(payload.exp);
    if (!conversationId || !Number.isFinite(exp)) {
      return null;
    }
    if (Date.now() >= exp) {
      return null;
    }
    return {
      conversationId,
      exp: Math.trunc(exp),
    };
  } catch {
    return null;
  }
}

function buildMaterialQueryPollUrl(args: {
  req: Request;
  conversationId: string;
  requestFingerprint: string;
}): string {
  const origin = resolveAppBaseUrl(args.req);
  if (!origin) {
    throw new Error("Missing public app origin for material-query polling");
  }
  const payload = {
    conversationId: args.conversationId,
    requestFingerprint: args.requestFingerprint,
    exp: Date.now() + MATERIAL_QUERY_CLAIM_TTL_MS,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", getMaterialQueryPollSecret())
    .update(encodedPayload)
    .digest("base64url");
  const token = `${encodedPayload}.${signature}`;
  return `${origin}/api/aiyra/material-query-progress?token=${encodeURIComponent(token)}`;
}

function summarizePollUrlForLog(value: string): string | null {
  const raw = trimmed(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split("?")[0] || null;
  }
}

function envBoolean(value: unknown): boolean {
  const normalized = trimmed(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeBearer(value: string): string {
  let token = trimmed(value);
  if (!token) return "";
  // Be permissive: collapse accidental repeated "Bearer " prefixes.
  while (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }
  return token;
}

function getQueryText(body: MaterialQueryBody): string {
  const nested = body.materialQuery || body.material_query || {};
  return (
    trimmed(body.text) ||
    trimmed(body.message) ||
    trimmed(body.input) ||
    trimmed(body.question) ||
    trimmed(body.query) ||
    trimmed(body.prompt) ||
    trimmed(nested.text)
    || trimmed(nested.message)
    || trimmed(nested.question)
    || trimmed(nested.query)
    || trimmed(nested.prompt) ||
    ""
  );
}

function getConversationId(body: MaterialQueryBody): string {
  return (
    trimmed(body.conversationId) ||
    trimmed(body.conversation_id)
  );
}

function logAiyraMaterialEvent(event: string, fields: Record<string, unknown>) {
  try {
    console.info(
      JSON.stringify({
        event,
        ts: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {
    // ignore logging failures
  }
}

function previewText(value: string, max = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max
    ? `${normalized.slice(0, Math.max(0, max - 3))}...`
    : normalized;
}

function previewMessageContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") return previewText(content);
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
    return previewText(joined);
  }
  return previewText(String(content ?? ""));
}

function summarizeHistoryTail(messages: ModelMessage[], limit = 3) {
  return messages.slice(-limit).map((message, index, arr) => ({
    offset_from_tail: arr.length - index,
    role: message.role,
    content_preview: previewMessageContent(message.content),
  }));
}

function normalizeTurnText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function fingerprintTurnText(value: string): string {
  return createHash("sha256").update(normalizeTurnText(value)).digest("hex");
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isUniqueViolation(error: unknown): boolean {
  const obj = toRecord(error);
  return trimmed(obj?.code) === "23505";
}

function isAiyraMaterialMetadata(value: unknown): boolean {
  return toRecord(value)?.source === "aiyra_material_query";
}

function toMs(value: string | null | undefined): number {
  if (!value) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeProgressKey(value: unknown): string {
  return trimmed(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sanitizeSpokenProgressText(value: string, max = 96): string {
  let text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text
    .replace(/^\[+\s*/, "")
    .replace(/\s*\]+$/, "")
    .replace(/[*_`>#]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!text) return "";
  if (text.length > max) {
    text = `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
  }
  if (!/[.!?]$/.test(text)) {
    text += ".";
  }
  return text;
}

type MaterialQueryTopic =
  | "calendar"
  | "schedule"
  | "email"
  | "site"
  | "files"
  | "browser"
  | "code"
  | "data"
  | "generic";

function detectMaterialQueryTopic(queryText: string): MaterialQueryTopic {
  const q = normalizeProgressKey(queryText);
  if (
    q.includes("calendar") ||
    q.includes("meeting") ||
    q.includes("event") ||
    q.includes("appointment")
  ) {
    return "calendar";
  }
  if (
    q.includes("schedule") ||
    q.includes("scheduled") ||
    q.includes("job") ||
    q.includes("task")
  ) {
    return "schedule";
  }
  if (q.includes("email") || q.includes("inbox") || q.includes("gmail")) {
    return "email";
  }
  if (
    q.includes("site") ||
    q.includes("domain") ||
    q.includes("deploy") ||
    q.includes("website") ||
    q.includes("page")
  ) {
    return "site";
  }
  if (q.includes("file") || q.includes("folder") || q.includes("document")) {
    return "files";
  }
  if (q.includes("browser") || q.includes("click") || q.includes("open")) {
    return "browser";
  }
  if (q.includes("code") || q.includes("repo") || q.includes("function")) {
    return "code";
  }
  if (q.includes("data") || q.includes("database") || q.includes("table")) {
    return "data";
  }
  return "generic";
}

function buildInitialMaterialQueryProgressText(queryText: string): string {
  switch (detectMaterialQueryTopic(queryText)) {
    case "calendar":
      return "I'm checking your calendar.";
    case "schedule":
      return "I'm checking your scheduled tasks.";
    case "email":
      return "I'm checking your email.";
    case "site":
      return "I'm checking the site details.";
    case "files":
      return "I'm looking through the files.";
    case "browser":
      return "I'm checking that in the browser.";
    case "code":
      return "I'm checking that in code.";
    case "data":
      return "I'm checking your connected data.";
    default:
      return "I'm checking that now.";
  }
}

function buildOrchestratorWorkingProgressText(queryText: string): string {
  switch (detectMaterialQueryTopic(queryText)) {
    case "calendar":
      return "I'm pulling together your calendar details.";
    case "schedule":
      return "I'm pulling together your scheduled tasks.";
    case "email":
      return "I'm pulling together your email details.";
    case "site":
      return "I'm pulling together the site details.";
    case "files":
      return "I'm pulling together the relevant file details.";
    case "browser":
      return "I'm working through that browser task now.";
    case "code":
      return "I'm working through the code details now.";
    case "data":
      return "I'm pulling together the relevant data.";
    default:
      return "I'm pulling together the relevant details.";
  }
}

function buildPendingMaterialQueryProgressText(args: {
  queryText: string;
  sameRequest: boolean;
  activeProgressText?: string;
}): string {
  const activeProgressText = sanitizeSpokenProgressText(trimmed(args.activeProgressText || ""));
  if (activeProgressText) return activeProgressText;
  if (!args.sameRequest) return "I'm still finishing the previous request.";
  return buildInitialMaterialQueryProgressText(args.queryText);
}

async function humanizeMaterialProgressText(args: {
  queryText: string;
  source: string;
  progressText: string;
  previousProgressText?: string;
  cache: Map<string, string>;
}): Promise<string> {
  const fallback = sanitizeSpokenProgressText(args.progressText);
  if (!fallback) return "";

  const cacheKey = `${normalizeProgressKey(args.source)}::${fallback}`;
  const cached = args.cache.get(cacheKey);
  if (cached) return cached;

  if (!trimmed(process.env.ANTHROPIC_API_KEY)) {
    args.cache.set(cacheKey, fallback);
    logAiyraMaterialEvent("aiyra.material_query.progress_humanized", {
      mode: "no_key",
      progress_source: args.source,
      query_preview: previewText(args.queryText),
      fallback_text: fallback,
      final_text: fallback,
      changed: false,
    });
    return fallback;
  }

  const startedAtMs = Date.now();
  try {
    const result = await Promise.race([
      generateText({
        model: resolveChatModel("anthropic", MATERIAL_QUERY_PROGRESS_ANTHROPIC_MODEL),
        system: `You rewrite a voice assistant's in-progress status updates so they sound natural and human.

Rules:
- Preserve the exact stage and certainty of the original update.
- Keep it to one short spoken sentence.
- Sound warm, casual, and natural, not robotic.
- Write in first person.
- Do not invent new facts, results, or steps.
- Do not mention tools, APIs, databases, models, or internal processing.
- No markdown, bullets, quotes, or emojis.
- Keep it under 12 words when possible.

Return only the rewritten sentence.`,
        prompt: `User request:
${previewText(args.queryText, 240)}

Progress event source:
${normalizeProgressKey(args.source) || "unknown"}

Current status text:
${fallback}

Previous spoken update:
${trimmed(args.previousProgressText) || "(none)"}`,
      }),
      new Promise<{ __timeout: true }>((resolve) => {
        setTimeout(() => resolve({ __timeout: true }), MATERIAL_QUERY_PROGRESS_HUMANIZE_TIMEOUT_MS);
      }),
    ]);

    if (
      result &&
      typeof result === "object" &&
      "__timeout" in result &&
      (result as { __timeout?: boolean }).__timeout === true
    ) {
      args.cache.set(cacheKey, fallback);
      logAiyraMaterialEvent("aiyra.material_query.progress_humanized", {
        mode: "timeout",
        progress_source: args.source,
        query_preview: previewText(args.queryText),
        fallback_text: fallback,
        final_text: fallback,
        changed: false,
        latency_ms: Math.max(0, Date.now() - startedAtMs),
        timeout_ms: MATERIAL_QUERY_PROGRESS_HUMANIZE_TIMEOUT_MS,
      });
      return fallback;
    }

    const rewritten =
      result && typeof result === "object" && "text" in result
        ? sanitizeSpokenProgressText(
            trimmed((result as { text?: string }).text || "")
          )
        : "";
    const finalText = rewritten || fallback;
    args.cache.set(cacheKey, finalText);
    logAiyraMaterialEvent("aiyra.material_query.progress_humanized", {
      mode: "rewritten",
      progress_source: args.source,
      query_preview: previewText(args.queryText),
      fallback_text: fallback,
      final_text: finalText,
      changed: finalText !== fallback,
      latency_ms: Math.max(0, Date.now() - startedAtMs),
      timeout_ms: MATERIAL_QUERY_PROGRESS_HUMANIZE_TIMEOUT_MS,
    });
    return finalText;
  } catch (error) {
    args.cache.set(cacheKey, fallback);
    logAiyraMaterialEvent("aiyra.material_query.progress_humanized", {
      mode: "error",
      progress_source: args.source,
      query_preview: previewText(args.queryText),
      fallback_text: fallback,
      final_text: fallback,
      changed: false,
      latency_ms: Math.max(0, Date.now() - startedAtMs),
      timeout_ms: MATERIAL_QUERY_PROGRESS_HUMANIZE_TIMEOUT_MS,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

function buildMaterialQueryPendingResponse(args: {
  progressText: string;
  pollUrl: string;
  traceId: string;
  latencyMs: number;
  deduped?: boolean;
}) {
  return {
    ok: true,
    pending: true,
    progressText: sanitizeSpokenProgressText(args.progressText),
    pollUrl: args.pollUrl,
    pollAfterMs: MATERIAL_QUERY_POLL_AFTER_MS,
    traceId: args.traceId,
    kind: "pending" as const,
    deduped: args.deduped === true,
    latencyMs: args.latencyMs,
  };
}

function buildMaterialQueryFinalResponse(args: {
  answerText: string;
  traceId: string;
  latencyMs: number;
  kind?: string;
  deduped?: boolean;
  orchestratorRoundLatencyMs?: number;
}) {
  return {
    ok: true,
    answerText: args.answerText,
    answer: args.answerText,
    text: args.answerText,
    response: args.answerText,
    traceId: args.traceId,
    kind: args.kind || "final",
    deduped: args.deduped === true,
    ...(Number.isFinite(args.orchestratorRoundLatencyMs)
      ? { orchestratorRoundLatencyMs: args.orchestratorRoundLatencyMs }
      : {}),
    latencyMs: args.latencyMs,
  };
}

function parseJsonLoose(value: string): unknown {
  const raw = trimmed(value);
  if (!raw) return null;

  let current: unknown = raw;
  for (let i = 0; i < 3; i += 1) {
    if (typeof current !== "string") return current;
    const currentText = current;
    try {
      current = JSON.parse(currentText);
      continue;
    } catch {
      const start = currentText.indexOf("{");
      const end = currentText.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          current = JSON.parse(currentText.slice(start, end + 1));
          continue;
        } catch {
          return null;
        }
      }
      return null;
    }
  }
  return current;
}

function extractJobsArray(value: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(value)) {
    const jobs = value.filter(
      (job): job is Record<string, unknown> =>
        !!job && typeof job === "object" && !Array.isArray(job)
    );
    return jobs.length > 0 ? jobs : null;
  }
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.jobs)) {
    return extractJobsArray(obj.jobs);
  }
  if (obj.result) {
    const nested = extractJobsArray(obj.result);
    if (nested) return nested;
  }
  if (obj.data) {
    const nested = extractJobsArray(obj.data);
    if (nested) return nested;
  }
  return null;
}

function formatScheduleSpec(value: unknown): string {
  const schedule =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (!schedule) return "custom schedule";
  const type = trimmed(schedule.type).toLowerCase();
  const hour = Number(schedule.hour);
  const minute = Number(schedule.minute);
  const time =
    Number.isFinite(hour) && Number.isFinite(minute)
      ? `${String(Math.max(0, hour)).padStart(2, "0")}:${String(Math.max(0, minute)).padStart(2, "0")}`
      : "";
  if (type === "once") {
    const runAt = trimmed(schedule.run_at);
    return runAt ? `runs once at ${runAt}` : "runs once";
  }
  if (type === "daily") {
    return time ? `runs daily at ${time}` : "runs daily";
  }
  if (type === "weekly") {
    const weekdayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const weekday = Number(schedule.weekday);
    const day =
      Number.isInteger(weekday) && weekday >= 0 && weekday < weekdayNames.length
        ? weekdayNames[weekday]
        : "weekly";
    return time ? `runs every ${day} at ${time}` : `runs every ${day}`;
  }
  if (type === "interval_minutes") {
    const minutes = Number(schedule.minutes);
    if (Number.isFinite(minutes) && minutes > 0) {
      return `runs every ${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
  }
  return type ? `schedule type ${type}` : "custom schedule";
}

function buildScheduleListAnswerFromToolOutput(toolOutputText: string): string | null {
  const parsed = parseJsonLoose(toolOutputText);
  const jobs = extractJobsArray(parsed);
  if (!jobs) return null;
  if (jobs.length === 0) {
    return "You don't have any scheduled jobs.";
  }
  const lead = `You have ${jobs.length} scheduled job${jobs.length === 1 ? "" : "s"}.`;
  const summaries = jobs.slice(0, 8).map((job) => {
    const name = trimmed(job.name) || "Unnamed job";
    const state = job.enabled === false ? "paused" : "active";
    const lastStatus = trimmed(job.last_status) || "not run yet";
    const scheduleText = formatScheduleSpec(job.schedule);
    return `${name}: ${scheduleText}, ${state}, last status ${lastStatus}`;
  });
  const moreCount = jobs.length - summaries.length;
  const tail =
    moreCount > 0
      ? ` There ${moreCount === 1 ? "is" : "are"} also ${moreCount} more job${moreCount === 1 ? "" : "s"}.`
      : "";
  return `${lead} ${summaries.join(". ")}.${tail}`.replace(/\s+/g, " ").trim();
}

async function summarizeMaterialToolOutput(args: {
  queryText: string;
  toolOutputText: string;
  toolCallsExecuted: string[];
}): Promise<string | null> {
  const { queryText, toolOutputText, toolCallsExecuted } = args;
  if (!trimmed(toolOutputText)) return null;

  if (toolCallsExecuted.includes("schedule_list")) {
    const deterministic = buildScheduleListAnswerFromToolOutput(toolOutputText);
    if (deterministic) return deterministic;
  }

  let provider: "anthropic" | "openai" | null = null;
  let modelName = "";
  if (process.env.ANTHROPIC_API_KEY) {
    provider = "anthropic";
    modelName = MATERIAL_QUERY_SUMMARY_ANTHROPIC_MODEL;
  } else if (process.env.OPENAI_API_KEY) {
    provider = "openai";
    modelName = MATERIAL_QUERY_SUMMARY_OPENAI_MODEL;
  } else {
    return null;
  }

  try {
    const result = await generateText({
      model: resolveChatModel(provider, modelName),
      system: `You convert raw tool output into a concise voice-assistant answer.

Rules:
- Answer the user's request directly.
- Be human, fun. You have a personality. Do not sound like an AI agent.
- Do not mention tools, JSON, payloads, tables, or internal processing.
- Use plain English with no markdown tables.
- If the result is a list, say the important items compactly.
- Keep it under 140 words.`,
      prompt: `User request:
${queryText}

Tools used:
${toolCallsExecuted.join(", ") || "(unknown)"}

Raw tool output:
${toolOutputText.slice(0, 12_000)}`,
    });
    const answer = result.text.replace(/\s+/g, " ").trim();
    return answer || null;
  } catch {
    return null;
  }
}

function buildMaterialQueryRoundFallbackAnswer(round: Awaited<ReturnType<typeof runOrchestratorRound>>): string {
  if (round.kind === "final") {
    return trimmed(round.text);
  }
  if (round.kind === "needs_connector") {
    return trimmed(round.partialText)
      ? `${trimmed(round.partialText)}\n\n(I still need local connector tool execution to finish this task.)`
      : "I need local connector tool execution to complete this request.";
  }
  if (round.kind === "ui_open_code") {
    return trimmed(round.partialText)
      ? `${trimmed(round.partialText)}\n\n(This requires opening code mode in the Flow UI.)`
      : "This request needs code mode in the Flow UI.";
  }
  return trimmed(round.partialText)
    ? `${trimmed(round.partialText)}\n\n(This request needs browser task execution in the Flow UI.)`
    : "This request needs browser task execution in the Flow UI.";
}

function buildMaterialQueryConnectorStatusMessage(
  round: Extract<Awaited<ReturnType<typeof runOrchestratorRound>>, { kind: "needs_connector" }>
): string {
  const preferred = round.connectorExecutes.find(
    (ex) => typeof ex.message === "string" && ex.message.trim()
  );
  if (preferred?.message?.trim()) return preferred.message.trim();
  const first = round.connectorExecutes[0];
  if (!first) return "Running local connector tools...";
  if (first.connectorType === "terminal_step") return "Working in Claude Code...";
  if (first.connectorType.startsWith("whatsapp_")) return "Checking WhatsApp on your Mac...";
  if (first.connectorType.startsWith("browser_")) return "Working in the browser...";
  if (first.connectorType.startsWith("file_")) return "Accessing local files...";
  if (first.connectorType.startsWith("obsidian_")) return "Checking Obsidian...";
  return `Running ${first.connectorType}...`;
}

function resolveMaterialQueryConnectorTimeoutMs(connectorType: string): number {
  const normalized = trimmed(connectorType).toLowerCase();
  if (!normalized) return 60_000;
  if (normalized === "terminal_step") return 5 * 60 * 1000;
  if (normalized.startsWith("browser_")) return 3 * 60 * 1000;
  if (normalized.startsWith("file_")) return 2 * 60 * 1000;
  if (normalized.startsWith("obsidian_")) return 2 * 60 * 1000;
  return 60_000;
}

function buildToolEventProgressText(args: {
  phase: "start" | "end";
  toolName: string;
  agent?: string;
  success?: boolean;
  queryText?: string;
}): string {
  const toolName = normalizeProgressKey(args.toolName);
  const agent = normalizeProgressKey(args.agent);
  const topic = detectMaterialQueryTopic(trimmed(args.queryText || ""));
  if (args.phase === "end") {
    if (args.success === false) {
      return "That step hit an issue. I'm trying another way.";
    }
    if (toolName === "data_query" || agent === "data") {
      if (topic === "calendar") {
        return "I found your calendar details. I'm putting the answer together.";
      }
      if (topic === "email") {
        return "I found your email details. I'm putting the answer together.";
      }
      return "I found the data I need. I'm putting the answer together.";
    }
    if (
      toolName === "schedule_list" ||
      agent === "schedule" ||
      toolName === "data_query" ||
      agent === "data" ||
      agent === "files" ||
      toolName === "browser_task"
    ) {
      return "I have what I need. I'm putting the answer together.";
    }
    return "";
  }

  switch (toolName) {
    case "schedule_list":
      return "I'm checking your scheduled tasks.";
    case "schedule_create":
      return "I'm creating that schedule.";
    case "schedule_update":
      return "I'm updating that schedule.";
    case "schedule_delete":
      return "I'm removing that schedule.";
    case "data_query":
      if (topic === "calendar") return "I'm checking your calendar.";
      if (topic === "email") return "I'm checking your email.";
      return "I'm checking your connected data.";
    case "files_agent_request":
      return "I'm looking through the files.";
    case "browser_task":
      return "I'm checking that in the browser.";
    case "code_cli_run":
      return "I'm checking that in code.";
  }

  switch (agent) {
    case "schedule":
      return "I'm checking your schedules.";
    case "data":
      if (topic === "calendar") return "I'm checking your calendar.";
      if (topic === "email") return "I'm checking your email.";
      return "I'm checking your connected data.";
    case "files":
      return "I'm looking through the files.";
    case "browser":
      return "I'm checking that in the browser.";
    case "memory":
      return "I'm checking what I already know.";
    case "pages":
      return "I'm checking the site details.";
    default:
      return "I'm working on that now.";
  }
}

function buildToolStreamProgressText(args: { toolName: string; text: string }): string {
  const toolName = normalizeProgressKey(args.toolName);
  if (!toolName || toolName === "__clear_text__") return "";
  const raw = trimmed(args.text);
  if (!raw) return "";
  const bracketMatch = raw.match(/^\[(.+)\]$/);
  if (!bracketMatch) return "";
  const rawStatusText = trimmed(bracketMatch[1]);
  if (!rawStatusText) return "";
  const normalizedStatusKey = normalizeProgressKey(rawStatusText);
  let rewrittenStatusText = rawStatusText;
  if (
    normalizedStatusKey.startsWith("calling_datagran_api") ||
    normalizedStatusKey.startsWith("api_response_received")
  ) {
    if (toolName === "data_query") {
      if (/google-calendar|calendar/i.test(rawStatusText)) {
        rewrittenStatusText = normalizedStatusKey.startsWith("api_response_received")
          ? "I found your calendar details. I'm putting the answer together."
          : "I'm checking your calendar.";
      } else if (/gmail|email|inbox/i.test(rawStatusText)) {
        rewrittenStatusText = normalizedStatusKey.startsWith("api_response_received")
          ? "I found your email details. I'm putting the answer together."
          : "I'm checking your email.";
      } else {
        rewrittenStatusText = normalizedStatusKey.startsWith("api_response_received")
          ? "I found the data. I'm putting the answer together."
          : "I'm checking your connected data.";
      }
    } else {
      rewrittenStatusText = normalizedStatusKey.startsWith("api_response_received")
        ? "I found what I need. I'm putting the answer together."
        : "I'm checking that now.";
    }
  }
  const statusText = sanitizeSpokenProgressText(rewrittenStatusText);
  if (!statusText) return "";
  if (/^error:/i.test(statusText)) {
    return "That step hit an issue. I'm trying another way.";
  }
  return statusText;
}

async function updateMaterialQueryClaimProgress(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  conversationId: string;
  requestFingerprint: string;
  traceId: string;
  progressText: string;
  ttlMs?: number;
}): Promise<void> {
  const {
    supabase,
    conversationId,
    requestFingerprint,
    traceId,
    progressText,
    ttlMs = MATERIAL_QUERY_CLAIM_TTL_MS,
  } = args;
  const sanitized = sanitizeSpokenProgressText(progressText);
  if (!sanitized) return;
  const nowMs = Date.now();
  const { error } = await supabase
    .from("aiyra_material_query_claims")
    .update({
      status: "running",
      response_text: sanitized,
      error_text: null,
      updated_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + ttlMs).toISOString(),
    })
    .eq("conversation_id", conversationId)
    .eq("request_fingerprint", requestFingerprint)
    .eq("trace_id", traceId)
    .eq("status", "running");
  if (error) throw new Error(error.message);
}

async function loadMaterialQueryClaim(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  conversationId: string;
}): Promise<MaterialQueryClaimRow | null> {
  const { supabase, conversationId } = args;
  const { data, error } = await supabase
    .from("aiyra_material_query_claims")
    .select(
      "conversation_id, user_id, request_fingerprint, normalized_query, trace_id, status, response_text, error_text, updated_at, expires_at"
    )
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data || null) as MaterialQueryClaimRow | null;
}

async function waitForMaterialQueryClaimResult(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  conversationId: string;
  requestFingerprint: string;
  timeoutMs?: number;
  pollEveryMs?: number;
}): Promise<{ traceId: string; answer: string } | null> {
  const {
    supabase,
    conversationId,
    requestFingerprint,
    timeoutMs = 1500,
    pollEveryMs = 250,
  } = args;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const claim = await loadMaterialQueryClaim({ supabase, conversationId });
    if (!claim) return null;
    if (trimmed(claim.request_fingerprint) !== requestFingerprint) return null;
    const expiredAtMs = toMs(claim.expires_at);
    const expired = Number.isFinite(expiredAtMs) && expiredAtMs <= Date.now();
    const answer = trimmed(claim.response_text);
    if (!expired && claim.status === "completed" && answer) {
      return {
        traceId: trimmed(claim.trace_id),
        answer,
      };
    }
    if (claim.status === "failed" || expired) return null;
    await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
  }
  return null;
}

async function completeMaterialQueryClaim(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  conversationId: string;
  requestFingerprint: string;
  traceId: string;
  answer: string;
  ttlMs?: number;
}): Promise<void> {
  const {
    supabase,
    conversationId,
    requestFingerprint,
    traceId,
    answer,
    ttlMs = MATERIAL_QUERY_CLAIM_TTL_MS,
  } = args;
  const nowMs = Date.now();
  const { error } = await supabase
    .from("aiyra_material_query_claims")
    .update({
      trace_id: traceId,
      status: "completed",
      response_text: answer,
      error_text: null,
      updated_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + ttlMs).toISOString(),
    })
    .eq("conversation_id", conversationId)
    .eq("request_fingerprint", requestFingerprint);
  if (error) throw new Error(error.message);
}

async function failMaterialQueryClaim(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  conversationId: string;
  requestFingerprint: string;
  traceId: string;
  errorText: string;
}): Promise<void> {
  const { supabase, conversationId, requestFingerprint, traceId, errorText } = args;
  const nowMs = Date.now();
  const { error } = await supabase
    .from("aiyra_material_query_claims")
    .update({
      status: "failed",
      response_text: null,
      error_text: errorText,
      updated_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + MATERIAL_QUERY_FAILED_TTL_MS).toISOString(),
    })
    .eq("conversation_id", conversationId)
    .eq("request_fingerprint", requestFingerprint)
    .eq("trace_id", traceId);
  if (error) throw new Error(error.message);
}

async function claimMaterialQueryTurn(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  conversationId: string;
  queryText: string;
  traceId: string;
  ttlMs?: number;
  waitTimeoutMs?: number;
}):
  Promise<
    | { kind: "claimed"; traceId: string; requestFingerprint: string }
    | { kind: "completed"; traceId: string; answer: string; requestFingerprint: string }
    | {
        kind: "pending";
        traceId: string;
        requestFingerprint: string;
        activeRequestFingerprint: string;
        sameRequest: boolean;
      }
  > {
  const {
    supabase,
    userId,
    conversationId,
    queryText,
    traceId,
    ttlMs = MATERIAL_QUERY_CLAIM_TTL_MS,
    waitTimeoutMs = MATERIAL_QUERY_CLAIM_WAIT_MS,
  } = args;
  const requestFingerprint = fingerprintTurnText(queryText);
  const normalizedQuery = normalizeTurnText(queryText);
  const waitDeadlineMs = Date.now() + waitTimeoutMs;

  while (true) {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAtIso = new Date(nowMs + ttlMs).toISOString();
    const existing = await loadMaterialQueryClaim({ supabase, conversationId });

    if (!existing) {
      const { error } = await supabase.from("aiyra_material_query_claims").insert({
        conversation_id: conversationId,
        user_id: userId,
        request_fingerprint: requestFingerprint,
        normalized_query: normalizedQuery,
        trace_id: traceId,
        status: "running",
        response_text: null,
        error_text: null,
        updated_at: nowIso,
        expires_at: expiresAtIso,
      });
      if (!error) {
        return { kind: "claimed", traceId, requestFingerprint };
      }
      if (isUniqueViolation(error)) continue;
      throw new Error(error.message);
    }

    const existingFingerprint = trimmed(existing.request_fingerprint);
    const sameRequest = existingFingerprint === requestFingerprint;
    const existingTraceId = trimmed(existing.trace_id) || traceId;
    const existingAnswer = trimmed(existing.response_text);
    const expiresAtMs = toMs(existing.expires_at);
    const expired = Number.isFinite(expiresAtMs) ? expiresAtMs <= nowMs : true;

    if (!expired && sameRequest && existing.status === "completed" && existingAnswer) {
      return {
        kind: "completed",
        traceId: existingTraceId,
        answer: existingAnswer,
        requestFingerprint,
      };
    }

    if (!expired && existing.status === "running") {
      const remainingWaitMs = Math.max(0, waitDeadlineMs - nowMs);
      const waited = await waitForMaterialQueryClaimResult({
        supabase,
        conversationId,
        requestFingerprint: existingFingerprint,
        timeoutMs: Math.min(remainingWaitMs, 1500),
      });
      if (waited && sameRequest) {
        return {
          kind: "completed",
          traceId: waited.traceId,
          answer: waited.answer,
          requestFingerprint,
        };
      }
      if (Date.now() >= waitDeadlineMs) {
        return {
          kind: "pending",
          traceId: existingTraceId,
          requestFingerprint,
          activeRequestFingerprint: existingFingerprint,
          sameRequest,
        };
      }
      continue;
    }

    const { data: claimed, error: claimError } = await supabase
      .from("aiyra_material_query_claims")
      .update({
        user_id: userId,
        request_fingerprint: requestFingerprint,
        normalized_query: normalizedQuery,
        trace_id: traceId,
        status: "running",
        response_text: null,
        error_text: null,
        updated_at: nowIso,
        expires_at: expiresAtIso,
      })
      .eq("conversation_id", conversationId)
      .eq("updated_at", existing.updated_at || "")
      .select("conversation_id")
      .maybeSingle();
    if (claimError) throw new Error(claimError.message);
    if (claimed) {
      return { kind: "claimed", traceId, requestFingerprint };
    }
  }
}

async function loadRecentPersistedMessages(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
  limit?: number;
}): Promise<PersistedMessageRow[]> {
  const { supabase, userId, sessionId, limit = 10 } = args;
  const { data, error } = await supabase
    .from("orchestrator_messages")
    .select("role, content, trace_id, created_at, metadata")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const out: PersistedMessageRow[] = [];
  for (const row of data || []) {
    const obj = toRecord(row);
    const role = obj?.role === "user" || obj?.role === "assistant" ? obj.role : null;
    const content = typeof obj?.content === "string" ? obj.content.trim() : "";
    if (!role || !content) continue;
    out.push({
      role,
      content,
      trace_id: typeof obj?.trace_id === "string" ? obj.trace_id : null,
      created_at: typeof obj?.created_at === "string" ? obj.created_at : null,
      metadata: toRecord(obj?.metadata),
    });
  }
  return out;
}

function findRecentDuplicateTurn(args: {
  messages: PersistedMessageRow[];
  queryText: string;
  nowMs?: number;
  maxAgeMs?: number;
}):
  | { status: "completed"; traceId: string; assistantContent: string }
  | { status: "pending"; traceId: string }
  | null {
  const { messages, queryText, nowMs = Date.now(), maxAgeMs = 12_000 } = args;
  const normalizedQuery = normalizeTurnText(queryText);
  const recentUser = messages.find((message) => {
    if (message.role !== "user") return false;
    if (!message.trace_id) return false;
    if (!isAiyraMaterialMetadata(message.metadata)) return false;
    if (normalizeTurnText(message.content) !== normalizedQuery) return false;
    const createdAtMs = toMs(message.created_at);
    return Number.isFinite(createdAtMs) && nowMs - createdAtMs <= maxAgeMs;
  });
  if (!recentUser?.trace_id) return null;

  const matchingAssistant = messages.find(
    (message) =>
      message.role === "assistant" &&
      message.trace_id === recentUser.trace_id &&
      isAiyraMaterialMetadata(message.metadata)
  );
  if (matchingAssistant?.content) {
    return {
      status: "completed",
      traceId: recentUser.trace_id,
      assistantContent: matchingAssistant.content,
    };
  }
  return {
    status: "pending",
    traceId: recentUser.trace_id,
  };
}

async function waitForAssistantByTraceId(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
  traceId: string;
  timeoutMs?: number;
  pollEveryMs?: number;
}): Promise<string | null> {
  const {
    supabase,
    userId,
    sessionId,
    traceId,
    timeoutMs = 2500,
    pollEveryMs = 250,
  } = args;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from("orchestrator_messages")
      .select("content")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .eq("role", "assistant")
      .eq("trace_id", traceId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const first = Array.isArray(data) ? data[0] : null;
    const content = first && typeof first === "object" && typeof (first as { content?: unknown }).content === "string"
      ? (first as { content: string }).content.trim()
      : "";
    if (content) return content;
    await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
  }
  return null;
}

async function loadHistory(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
}): Promise<ModelMessage[]> {
  const { supabase, userId, sessionId } = args;
  const { data, error } = await supabase
    .from("orchestrator_messages")
    .select("role, content")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(80);
  if (error) throw new Error(error.message);

  const out: ModelMessage[] = [];
  for (const row of data || []) {
    const roleRaw =
      row && typeof row === "object" ? (row as { role?: unknown }).role : null;
    const contentRaw =
      row && typeof row === "object"
        ? (row as { content?: unknown }).content
        : null;
    const role = typeof roleRaw === "string" ? roleRaw : "";
    const content = typeof contentRaw === "string" ? contentRaw.trim() : "";
    if (!content) continue;
    // Persisted system rows are prompt/config artifacts, not conversational turns.
    // Including them here can make questions like "what was my first question?"
    // answer from the system prompt instead of the user's first utterance.
    if (role !== "user" && role !== "assistant") continue;
    out.push({ role, content });
  }
  return out;
}

async function persistMessage(args: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const { supabase, userId, sessionId, role, content, traceId, metadata } = args;
  if (traceId) {
    const { data: existing, error: existingError } = await supabase
      .from("orchestrator_messages")
      .select("id")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .eq("role", role)
      .eq("trace_id", traceId)
      .limit(1);
    if (existingError) throw new Error(existingError.message);
    if (Array.isArray(existing) && existing.length > 0) {
      return false;
    }
  }
  const { error } = await supabase.from("orchestrator_messages").insert({
    user_id: userId,
    session_id: sessionId,
    role,
    content,
    ...(traceId ? { trace_id: traceId } : {}),
    ...(metadata ? { metadata } : {}),
  });
  if (error) throw new Error(error.message);
  return true;
}

async function processClaimedMaterialQuery(args: {
  req: Request;
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  bindingRow: ConversationBindingRow;
  conversationId: string;
  queryText: string;
  requestFingerprint: string;
  traceId: string;
  userEmail: string | null;
  startedAtMs: number;
}): Promise<{
  answer: string;
  traceId: string;
  kind: string;
  deduped: boolean;
  orchestratorRoundLatencyMs?: number;
  latencyMs: number;
}> {
  const {
    req,
    supabase,
    bindingRow,
    conversationId,
    queryText,
    requestFingerprint,
    traceId,
    userEmail,
    startedAtMs,
  } = args;
  let lastProgressText = "";
  const progressHumanizationCache = new Map<string, string>();
  const pushProgressUpdate = async (rawText: string, source: string) => {
    const deterministicProgressText = sanitizeSpokenProgressText(rawText);
    if (!deterministicProgressText) return;
    const progressText = await humanizeMaterialProgressText({
      queryText,
      source,
      progressText: deterministicProgressText,
      previousProgressText: lastProgressText,
      cache: progressHumanizationCache,
    });
    if (!progressText || progressText === lastProgressText) return;
    lastProgressText = progressText;
    try {
      await updateMaterialQueryClaimProgress({
        supabase,
        conversationId,
        requestFingerprint,
        traceId,
        progressText,
      });
      logAiyraMaterialEvent("aiyra.material_query.progress", {
        conversation_id: conversationId,
        trace_id: traceId,
        progress_text: progressText,
        progress_source: source,
      });
    } catch (error) {
      logAiyraMaterialEvent("aiyra.material_query.progress_update_failed", {
        conversation_id: conversationId,
        trace_id: traceId,
        progress_text: progressText,
        progress_source: source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await pushProgressUpdate(
    buildInitialMaterialQueryProgressText(queryText),
    "request_started"
  );

  const recentMessages = await loadRecentPersistedMessages({
    supabase,
    userId: bindingRow.user_id,
    sessionId: bindingRow.orchestrator_session_id,
  });
  const duplicateTurn = findRecentDuplicateTurn({
    messages: recentMessages,
    queryText,
  });
  if (duplicateTurn?.status === "completed") {
    await completeMaterialQueryClaim({
      supabase,
      conversationId,
      requestFingerprint,
      traceId: duplicateTurn.traceId,
      answer: duplicateTurn.assistantContent,
    });
    logAiyraMaterialEvent("aiyra.material_query.deduped_recent_turn", {
      conversation_id: conversationId,
      orchestrator_session_id: bindingRow.orchestrator_session_id,
      trace_id: duplicateTurn.traceId,
      dedupe_status: "completed",
      query_preview: previewText(queryText),
    });
    return {
      answer: duplicateTurn.assistantContent,
      traceId: duplicateTurn.traceId,
      kind: "final",
      deduped: true,
      latencyMs: Math.max(0, Date.now() - startedAtMs),
    };
  }
  if (duplicateTurn?.status === "pending") {
    const waitedAssistant = await waitForAssistantByTraceId({
      supabase,
      userId: bindingRow.user_id,
      sessionId: bindingRow.orchestrator_session_id,
      traceId: duplicateTurn.traceId,
    });
    if (waitedAssistant) {
      await completeMaterialQueryClaim({
        supabase,
        conversationId,
        requestFingerprint,
        traceId: duplicateTurn.traceId,
        answer: waitedAssistant,
      });
      logAiyraMaterialEvent("aiyra.material_query.deduped_recent_turn", {
        conversation_id: conversationId,
        orchestrator_session_id: bindingRow.orchestrator_session_id,
        trace_id: duplicateTurn.traceId,
        dedupe_status: "waited_for_assistant",
        query_preview: previewText(queryText),
      });
      return {
        answer: waitedAssistant,
        traceId: duplicateTurn.traceId,
        kind: "final",
        deduped: true,
        latencyMs: Math.max(0, Date.now() - startedAtMs),
      };
    }
  }

  const userInserted =
    duplicateTurn?.status === "pending"
      ? false
      : await persistMessage({
          supabase,
          userId: bindingRow.user_id,
          sessionId: bindingRow.orchestrator_session_id,
          role: "user",
          content: queryText,
          traceId,
          metadata: {
            source: "aiyra_material_query",
            conversation_id: conversationId,
          },
        });
  logAiyraMaterialEvent("aiyra.material_query.user_persisted", {
    conversation_id: conversationId,
    orchestrator_session_id: bindingRow.orchestrator_session_id,
    trace_id: traceId,
    persisted_role: "user",
    inserted: userInserted,
    deduped_pending_turn: duplicateTurn?.status === "pending",
    query_preview: previewText(queryText),
  });

  const history = await loadHistory({
    supabase,
    userId: bindingRow.user_id,
    sessionId: bindingRow.orchestrator_session_id,
  });
  logAiyraMaterialEvent("aiyra.material_query.history_loaded", {
    conversation_id: conversationId,
    orchestrator_session_id: bindingRow.orchestrator_session_id,
    trace_id: traceId,
    loaded_message_count: history.length,
    history_tail: summarizeHistoryTail(history),
    query_preview: previewText(queryText),
  });
  logAiyraMaterialEvent("aiyra.material_query.round_context", {
    conversation_id: conversationId,
    orchestrator_session_id: bindingRow.orchestrator_session_id,
    trace_id: traceId,
    context_message_count: history.length,
    context_tail: summarizeHistoryTail(history),
  });
  await pushProgressUpdate(
    buildOrchestratorWorkingProgressText(queryText),
    "orchestrator_started"
  );

  const roundStartedAtMs = Date.now();
  // Orchestrator self-calls should use the live request origin for this server instance.
  const appBaseUrl = new URL(req.url).origin;
  const runRound = (
    toolResults?:
      | Array<{
          toolCallId: string;
          toolName: string;
          result: string;
        }>
      | undefined,
    traceIdOverride?: string
  ) =>
    runOrchestratorRound({
      supabase,
      userId: bindingRow.user_id,
      userEmail,
      appBaseUrl,
      deviceId: bindingRow.device_id || undefined,
      sourceConversationId: conversationId,
      history,
      message: queryText,
      orchestratorSessionId: bindingRow.orchestrator_session_id,
      turnId: traceId,
      traceId: traceIdOverride || traceId,
      maxSteps: 1,
      allowSynthesisAfterTool: false,
      toolResults: toolResults?.length ? toolResults : undefined,
      onToolEvent: (event) => {
        if (!MATERIAL_QUERY_TOOL_PROGRESS_ENABLED) return;
        const progressText = buildToolEventProgressText({
          ...event,
          queryText,
        });
        if (progressText) {
          void pushProgressUpdate(
            progressText,
            `tool_${event.phase}:${normalizeProgressKey(event.toolName)}`
          );
        }
      },
      onToolStream: (data) => {
        if (!MATERIAL_QUERY_TOOL_PROGRESS_ENABLED) return;
        const progressText = buildToolStreamProgressText(data);
        if (progressText) {
          void pushProgressUpdate(
            progressText,
            `tool_stream:${normalizeProgressKey(data.toolName)}`
          );
        }
      },
    });

  let round = await runRound();
  const MAX_CONNECTOR_ROUNDS = 12;
  let connectorRoundsCompleted = 0;

  while (round.kind === "needs_connector" && connectorRoundsCompleted < MAX_CONNECTOR_ROUNDS) {
    if (!bindingRow.device_id) {
      break;
    }
    connectorRoundsCompleted += 1;
    await pushProgressUpdate(
      buildMaterialQueryConnectorStatusMessage(round),
      `connector_round_${connectorRoundsCompleted}_start`
    );

    const toolResults: Array<{
      toolCallId: string;
      toolName: string;
      result: string;
    }> = [];
    for (const execute of round.connectorExecutes) {
      let rpcResult: Record<string, unknown>;
      try {
        rpcResult = await callConnectorRpcViaRelay({
          userId: bindingRow.user_id,
          deviceId: bindingRow.device_id,
          rpcType: execute.connectorType,
          payload: execute.connectorParams,
          timeoutMs: resolveMaterialQueryConnectorTimeoutMs(execute.connectorType),
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

    await pushProgressUpdate(
      "I got the local result. Continuing the request.",
      `connector_round_${connectorRoundsCompleted}_result`
    );
    round = await runRound(toolResults, round.traceId || traceId);
  }

  const roundLatencyMs = Math.max(0, Date.now() - roundStartedAtMs);
  await pushProgressUpdate(
    round.kind === "final"
      ? "I have what I need. I'm putting the answer together."
      : "I'm wrapping up what I found.",
    "answer_synthesis"
  );

  let answer =
    round.kind === "final" && round.toolOutputText
      ? await summarizeMaterialToolOutput({
          queryText,
          toolOutputText: round.toolOutputText,
          toolCallsExecuted: round.toolCallsExecuted,
        })
      : null;
  if (!answer) {
    answer = buildMaterialQueryRoundFallbackAnswer(round);
  }
  if (!answer) {
    answer = "I couldn't generate a response for that request.";
  }
  const usedToolOutputSummary =
    round.kind === "final" && !!trimmed(round.toolOutputText || "");

  await persistMessage({
    supabase,
    userId: bindingRow.user_id,
    sessionId: bindingRow.orchestrator_session_id,
    role: "assistant",
    content: answer,
    traceId: round.traceId || traceId,
    metadata: {
      source: "aiyra_material_query",
      conversation_id: conversationId,
      round_kind: round.kind,
      summary_from_tool_output: usedToolOutputSummary,
      orchestrator_round_latency_ms: roundLatencyMs,
      total_latency_ms: Math.max(0, Date.now() - startedAtMs),
    },
  });
  await completeMaterialQueryClaim({
    supabase,
    conversationId,
    requestFingerprint,
    traceId: round.traceId || traceId,
    answer,
  });
  logAiyraMaterialEvent("aiyra.material_query.assistant_persisted", {
    conversation_id: conversationId,
    orchestrator_session_id: bindingRow.orchestrator_session_id,
    trace_id: round.traceId || traceId,
    persisted_role: "assistant",
    answer_preview: previewText(answer),
    round_kind: round.kind,
    used_tool_output_summary: usedToolOutputSummary,
  });

  await supabase
    .from("aiyra_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("conversation_id", conversationId);

  logAiyraMaterialEvent("aiyra.material_query.ok", {
    conversation_id: conversationId,
    kind: round.kind,
    trace_id: round.traceId || traceId,
    round_latency_ms: roundLatencyMs,
    total_latency_ms: Math.max(0, Date.now() - startedAtMs),
  });

  return {
    answer,
    traceId: round.traceId || traceId,
    kind: round.kind,
    deduped: false,
    orchestratorRoundLatencyMs: roundLatencyMs,
    latencyMs: Math.max(0, Date.now() - startedAtMs),
  };
}

export async function POST(req: Request) {
  const startedAtMs = Date.now();
  const responseProgressHumanizationCache = new Map<string, string>();
  let claimContext:
    | { conversationId: string; requestFingerprint: string; traceId: string }
    | null = null;
  try {
    const allowUnauthenticatedDev =
      process.env.NODE_ENV !== "production" &&
      envBoolean(process.env.AIYRA_MATERIAL_QUERY_ALLOW_UNAUTH_DEV);
    const url = new URL(req.url);
    const signedToolToken = trimmed(url.searchParams.get("token"));
    const toolTokenPayload = signedToolToken
      ? verifyMaterialQueryToolToken(signedToolToken)
      : null;
    const expectedBearer = normalizeBearer(
      process.env.AIYRA_MATERIAL_QUERY_BEARER ||
        process.env.AIYRA_MATERIAL_QUERY_AUTH_BEARER ||
        ""
    );
    if (!expectedBearer && !toolTokenPayload && !allowUnauthenticatedDev) {
      return NextResponse.json(
        { error: "Missing AIYRA_MATERIAL_QUERY_BEARER" },
        { status: 500 }
      );
    }

    const providedBearer = normalizeBearer(req.headers.get("authorization") || "");
    const bearerAuthorized = !!expectedBearer && providedBearer === expectedBearer;
    const toolTokenAuthorized = !!toolTokenPayload;
    const authorized = bearerAuthorized || toolTokenAuthorized;
    if (!authorized && !allowUnauthenticatedDev) {
      logAiyraMaterialEvent("aiyra.material_query.unauthorized", {
        has_authorization: !!providedBearer,
        has_signed_tool_token: !!signedToolToken,
        signed_tool_token_valid: !!toolTokenPayload,
      });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!authorized && allowUnauthenticatedDev) {
      logAiyraMaterialEvent("aiyra.material_query.auth_bypassed_dev", {
        has_authorization: !!providedBearer,
        has_signed_tool_token: !!signedToolToken,
        signed_tool_token_valid: !!toolTokenPayload,
      });
    }

    const body = (await req.json().catch(() => null)) as MaterialQueryBody | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const signedConversationId = toolTokenPayload?.conversationId || "";
    const conversationId = getConversationId(body) || signedConversationId;
    const queryText = getQueryText(body);
    if (!conversationId) {
      return NextResponse.json({ error: "Missing conversationId" }, { status: 400 });
    }
    if (!queryText) {
      return NextResponse.json({ error: "Missing prompt/query/question" }, { status: 400 });
    }
    if (signedConversationId && conversationId !== signedConversationId) {
      logAiyraMaterialEvent("aiyra.material_query.token_conversation_mismatch", {
        signed_conversation_id: signedConversationId,
        body_conversation_id: getConversationId(body) || null,
        query_preview: previewText(queryText),
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    logAiyraMaterialEvent("aiyra.material_query.request", {
      conversation_id: conversationId,
      auth_mode: toolTokenAuthorized
        ? "signed_tool_url"
        : bearerAuthorized
          ? "bearer"
          : "dev_bypass",
      query_preview: previewText(queryText),
    });

    const supabase = createSupabaseAdminClient();
    const { data: binding, error: bindingErr } = await supabase
      .from("aiyra_conversations")
      .select(
        "conversation_id, user_id, orchestrator_session_id, device_id, account_id, key_id, channel_mode"
      )
      .eq("conversation_id", conversationId)
      .maybeSingle();
    if (bindingErr) {
      return NextResponse.json({ error: bindingErr.message }, { status: 500 });
    }
    const bindingRow = (binding || null) as ConversationBindingRow | null;
    if (!bindingRow?.user_id || !bindingRow?.orchestrator_session_id) {
      logAiyraMaterialEvent("aiyra.material_query.unknown_conversation", {
        conversation_id: conversationId,
      });
      return NextResponse.json({ error: "Unknown conversationId" }, { status: 404 });
    }

    const accountId = trimmed(body.accountId);
    const keyId = trimmed(body.keyId);
    const persistedAccountId = trimmed(bindingRow.account_id);
    const persistedKeyId = trimmed(bindingRow.key_id);
    if (
      (persistedAccountId && accountId && persistedAccountId !== accountId) ||
      (persistedKeyId && keyId && persistedKeyId !== keyId)
    ) {
      logAiyraMaterialEvent("aiyra.material_query.binding_mismatch", {
        conversation_id: conversationId,
      });
      return NextResponse.json(
        { error: "Conversation binding mismatch" },
        { status: 403 }
      );
    }

    const persistedChannelMode = trimmed(bindingRow.channel_mode);
    const requestedChannelMode = trimmed(body.channelMode);
    const shouldUpdateChannelMode =
      !!requestedChannelMode &&
      requestedChannelMode !== "twilio_parent" &&
      persistedChannelMode !== requestedChannelMode &&
      persistedChannelMode !== "twilio_parent";

    if (
      (!persistedAccountId && accountId) ||
      (!persistedKeyId && keyId) ||
      shouldUpdateChannelMode
    ) {
      await supabase
        .from("aiyra_conversations")
        .update({
          ...(accountId && !persistedAccountId ? { account_id: accountId } : {}),
          ...(keyId && !persistedKeyId ? { key_id: keyId } : {}),
          ...(shouldUpdateChannelMode ? { channel_mode: requestedChannelMode } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("conversation_id", conversationId);
    }

    let userEmail: string | null = null;
    try {
      const userResult = await supabase.auth.admin.getUserById(bindingRow.user_id);
      userEmail = userResult?.data?.user?.email || null;
    } catch {
      userEmail = null;
    }

    const claimedTurn = await claimMaterialQueryTurn({
      supabase,
      userId: bindingRow.user_id,
      conversationId,
      queryText,
      traceId: `aiyra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    if (claimedTurn.kind === "completed") {
      logAiyraMaterialEvent("aiyra.material_query.deduped_claim", {
        conversation_id: conversationId,
        orchestrator_session_id: bindingRow.orchestrator_session_id,
        trace_id: claimedTurn.traceId,
        dedupe_status: "claim_completed",
        query_preview: previewText(queryText),
      });
      return NextResponse.json(
        buildMaterialQueryFinalResponse({
          answerText: claimedTurn.answer,
          traceId: claimedTurn.traceId,
          kind: "final",
          deduped: true,
          latencyMs: Math.max(0, Date.now() - startedAtMs),
        })
      );
    }
    if (claimedTurn.kind === "pending") {
      const activeClaim = await loadMaterialQueryClaim({ supabase, conversationId }).catch(
        () => null
      );
      if (!claimedTurn.sameRequest) {
        const busyReply =
          "I'm still finishing the previous request. Please ask again in a moment.";
        logAiyraMaterialEvent("aiyra.material_query.busy_previous_request", {
          conversation_id: conversationId,
          orchestrator_session_id: bindingRow.orchestrator_session_id,
          active_trace_id: claimedTurn.traceId,
          active_request_fingerprint: claimedTurn.activeRequestFingerprint,
          query_preview: previewText(queryText),
        });
        return NextResponse.json(
          buildMaterialQueryFinalResponse({
            answerText: busyReply,
            traceId: claimedTurn.traceId,
            kind: "busy_previous_request",
            latencyMs: Math.max(0, Date.now() - startedAtMs),
          })
        );
      }
      const activeProgressText = sanitizeSpokenProgressText(
        trimmed(activeClaim?.response_text || "")
      );
      const progressReply =
        activeProgressText ||
        (await humanizeMaterialProgressText({
          queryText,
          source: "pending_existing_claim",
          progressText: buildPendingMaterialQueryProgressText({
            queryText,
            sameRequest: true,
            activeProgressText: "",
          }),
          previousProgressText: "",
          cache: responseProgressHumanizationCache,
        }));
      const pollUrl = buildMaterialQueryPollUrl({
        req,
        conversationId,
        requestFingerprint: claimedTurn.activeRequestFingerprint,
      });
      logAiyraMaterialEvent("aiyra.material_query.claim_still_running", {
        conversation_id: conversationId,
        orchestrator_session_id: bindingRow.orchestrator_session_id,
        trace_id: claimedTurn.traceId,
        same_request: claimedTurn.sameRequest,
        progress_reply: progressReply,
        poll_url: summarizePollUrlForLog(pollUrl),
        poll_url_signed: trimmed(pollUrl).includes("token=") || undefined,
        query_preview: previewText(queryText),
      });
      return NextResponse.json(
        buildMaterialQueryPendingResponse({
          progressText: progressReply,
          pollUrl,
          traceId: claimedTurn.traceId,
          deduped: claimedTurn.sameRequest,
          latencyMs: Math.max(0, Date.now() - startedAtMs),
        })
      );
    }

    claimContext = {
      conversationId,
      requestFingerprint: claimedTurn.requestFingerprint,
      traceId: claimedTurn.traceId,
    };
    const pollUrl = buildMaterialQueryPollUrl({
      req,
      conversationId,
      requestFingerprint: claimedTurn.requestFingerprint,
    });
    after(async () => {
      try {
        await processClaimedMaterialQuery({
          req,
          supabase,
          bindingRow,
          conversationId,
          queryText,
          requestFingerprint: claimedTurn.requestFingerprint,
          traceId: claimedTurn.traceId,
          userEmail,
          startedAtMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Internal error";
        try {
          await failMaterialQueryClaim({
            supabase,
            conversationId,
            requestFingerprint: claimedTurn.requestFingerprint,
            traceId: claimedTurn.traceId,
            errorText: message,
          });
        } catch {
          // ignore background claim cleanup failures
        }
        logAiyraMaterialEvent("aiyra.material_query.background_error", {
          error: message,
          conversation_id: conversationId,
          trace_id: claimedTurn.traceId,
          total_latency_ms: Math.max(0, Date.now() - startedAtMs),
        });
      }
    });
    logAiyraMaterialEvent("aiyra.material_query.after_scheduled", {
      conversation_id: conversationId,
      orchestrator_session_id: bindingRow.orchestrator_session_id,
      trace_id: claimedTurn.traceId,
      poll_url: summarizePollUrlForLog(pollUrl),
      poll_url_signed: trimmed(pollUrl).includes("token=") || undefined,
      query_preview: previewText(queryText),
    });

    const latestClaim = await loadMaterialQueryClaim({ supabase, conversationId }).catch(
      () => null
    );
    const initialProgressText = buildInitialMaterialQueryProgressText(queryText);
    const latestProgressText = sanitizeSpokenProgressText(
      trimmed(latestClaim?.response_text || "")
    );
    const pendingProgressText =
      latestProgressText ||
      (await humanizeMaterialProgressText({
        queryText,
        source: "pending_response",
        progressText: initialProgressText,
        previousProgressText: "",
        cache: responseProgressHumanizationCache,
      }));
    logAiyraMaterialEvent("aiyra.material_query.pending_response", {
      conversation_id: conversationId,
      orchestrator_session_id: bindingRow.orchestrator_session_id,
      trace_id: claimedTurn.traceId,
      progress_text: pendingProgressText,
      poll_url: summarizePollUrlForLog(pollUrl),
      poll_url_signed: trimmed(pollUrl).includes("token=") || undefined,
      query_preview: previewText(queryText),
    });
    claimContext = null;
    return NextResponse.json(
      buildMaterialQueryPendingResponse({
        progressText: pendingProgressText,
        pollUrl,
        traceId: claimedTurn.traceId,
        latencyMs: Math.max(0, Date.now() - startedAtMs),
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    if (claimContext) {
      try {
        const supabase = createSupabaseAdminClient();
        await failMaterialQueryClaim({
          supabase,
          conversationId: claimContext.conversationId,
          requestFingerprint: claimContext.requestFingerprint,
          traceId: claimContext.traceId,
          errorText: message,
        });
      } catch {
        // ignore claim cleanup failures
      }
    }
    logAiyraMaterialEvent("aiyra.material_query.error", {
      error: message,
      conversation_id: claimContext?.conversationId || null,
      trace_id: claimContext?.traceId || null,
      total_latency_ms: Math.max(0, Date.now() - startedAtMs),
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
