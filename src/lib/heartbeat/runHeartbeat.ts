/**
 * Heartbeat Runner
 *
 * Runs on an hourly schedule (via scheduled_jobs). Gathers:
 *   1. User memory context (via Datagran brain)
 *   2. Gmail messages (if connected)
 *   3. Google Calendar events (if connected)
 * Then calls Haiku to generate a concise, friendly digest.
 */

import { generateText } from "ai";
import {
  getAnthropicReasoningProviderOptions,
  resolveChatModel,
  type ProviderId,
  getAnthropicContextProviderOptions,
} from "@/lib/ai/modelResolver";
import { insertBillingUsageEventBestEffort } from "@/lib/billing/events";
import { getOrCreateWorkspaceIdForUser } from "@/lib/billing/workspace";
import { preflightGroovyUsage, settleGroovyUsageDebitBestEffort } from "@/lib/billing/guard";
import { type UsageChargeType } from "@/lib/billing/pricing";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";
import {
  formatPreferenceForPrompt,
  getGroovyMemoryConnection,
  loadPreferenceMemoryContext,
  queryMemoryDirect,
  storeMemoryNote,
} from "@/lib/memory/groovyMemory";
import { getUpreadyReadinessForFlowUser, type UpreadyReadinessPoint } from "@/lib/upready/client";
import {
  buildHeartbeatActionBlock,
  runInboxTriageForHeartbeat,
  type TriageEmailItem,
  type TriageMailbox,
} from "@/lib/inbox/actions";
import { ensureHeartbeatSystemAgentId, resolveOwnedAgentId } from "@/lib/orchestrator/runtimeAgents";
import { resolveRuntimeScope } from "@/lib/orchestrator/runtimeGraph";
import type { SupabaseClient } from "@supabase/supabase-js";

const GMAIL_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.labels",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeartbeatTaskConfig = {
  type: "heartbeat_v1";
  ui_hidden?: boolean;
  orchestrator_agent_id?: string;
  orchestrator_session_id?: string;
  /** Last concrete web-pixel summary captured on a successful fetch. */
  last_web_pixel_summary?: string;
  delivery?: { dashboard?: boolean; whatsapp?: boolean; telegram?: boolean };
  /**
   * Fingerprint to avoid re-storing the same integration snapshot into memory
   * on every hourly heartbeat run.
   */
  last_integration_memory_label?: string;
  last_integration_memory_hash?: number;
  /**
   * Last heartbeat that was actually SENT (not __SKIP__). Used to suppress
   * repeated messages when calendar/email/pixel/readiness inputs haven't changed.
   */
  last_heartbeat_sent_at?: string;
  last_heartbeat_email_ids?: string[];
  last_heartbeat_calendar_keys?: string[];
  last_heartbeat_web_pixel_hash?: number;
  last_heartbeat_upready_latest_point_id?: string;
  /**
   * Fingerprint of "what happened today" memory retrieval used to avoid skipping
   * a heartbeat when only memory changed (no new emails/events/pixels).
   */
  last_heartbeat_memory_today_hash?: number;
  /** Last time we sent a wellbeing-oriented check-in question. */
  last_wellbeing_checkin_at?: string;
  /** Fingerprint of last wellbeing signal used in a sent check-in. */
  last_wellbeing_signal_hash?: number;
  /** Last time a Gmail/Calendar reconnect warning was surfaced in a heartbeat. */
  last_integration_reauth_warning_at?: string;
  /** Fingerprint of the providers included in the last reconnect warning. */
  last_integration_reauth_warning_hash?: number;
  /**
   * Legacy: ISO timestamp of last integrations fetch (applies to all providers).
   * New: per-provider ISO timestamps so one broken integration doesn't force refetching others hourly.
   */
  last_integrations_fetch?:
    | string
    | {
        gmail?: string;
        google_calendar?: string;
        web_pixel?: string;
      };
  options?: {
    lookback_minutes?: number;
    max_emails?: number;
    max_events?: number;
    max_chars?: number;
    /** Optional model override for heartbeat generation (e.g. "claude-sonnet-4-6"). */
    model_name?: string;
    /** Max web pixels to scan per run (default: all connected) */
    max_web_pixels?: number;
    /** Hours between integration fetches (legacy/global fallback). */
    integrations_interval_hours?: number;
    /** Hours between Gmail+Calendar fetches (overrides integrations_interval_hours; default 0 = every run). */
    calendar_email_interval_hours?: number;
    /** Hours between web pixel scans (overrides integrations_interval_hours; default 12). */
    web_pixel_interval_hours?: number;
    /** Disable/enable quiet-hours suppression (default true when timezone is provided) */
    quiet_hours_enabled?: boolean;
    /** Start of quiet hours in local time (0-23, default 23) */
    quiet_hours_start_hour?: number;
    /** End of quiet hours for weekdays in local time (0-23, default 7) */
    quiet_hours_end_hour_weekday?: number;
    /** End of quiet hours for weekends in local time (0-23, default 9) */
    quiet_hours_end_hour_weekend?: number;
    /** Enable an extra agentic research pass before drafting the heartbeat (default true). */
    agentic_research_enabled?: boolean;
    /** Max additional agentic memory follow-up questions (default 3, max 6). */
    agentic_memory_followups_max?: number;
    /** Max lightweight web search queries in agentic pass (default 2, max 4). */
    agentic_web_queries_max?: number;
    /** Max intentional inbox-cleanup heartbeats per local day (default 2). */
    inbox_cleanup_heartbeats_per_day_max?: number;
    /**
     * Optional override: allow critical inbox items to bypass cleanup daily cap/window.
     * Default false to keep cap behavior predictable.
     */
    inbox_cleanup_urgency_bypass_enabled?: boolean;
  };
};

export type HeartbeatResult = {
  ok: boolean;
  text: string;
  sessionId: string | null;
  agentId?: string | null;
  /** If true the caller should send to WhatsApp */
  sendWhatsApp: boolean;
  /** If true the caller should send to Telegram */
  sendTelegram: boolean;
  error?: string;
};

type IntegrationsFetchState = {
  gmail?: string;
  google_calendar?: string;
  web_pixel?: string;
};

type ScheduledJobPromptRow = {
  id?: string;
  name?: string | null;
  kind?: string | null;
  command?: string | null;
  task?: unknown;
  schedule?: unknown;
  last_run_at?: string | null;
  last_status?: string | null;
};

type LocalTimeContext = {
  timezone: string;
  weekdayName: string;
  weekdayIndex: number;
  hour24: number;
  minute: number;
  isWeekend: boolean;
  dayPart: "late_night" | "morning" | "afternoon" | "evening";
};

type WellbeingSignal = {
  triggered: boolean;
  source: "none" | "upready" | "memory";
  reason: string;
  signalHash: number | null;
  debug: string[];
};

type InboxActionPromptContext = {
  summary: string;
  pendingCount: number;
  approvedCount: number;
  executingCount: number;
  doneCount: number;
  rejectedCount: number;
  failedCount: number;
};

type EmailCleanupHeartbeatDecision = {
  shouldSend: boolean;
  reason: string;
  opener: string;
};

type EmailCleanupWindowDecision = {
  allowSendNow: boolean;
  reason: string;
};

type IntentionalEmailCleanupHeartbeatHistory = {
  lookupOk: boolean;
  sentTodayCount: number;
  todayLocalTimes: string[];
  recentLocalDateTimes: string[];
  lastSentAtIso: string | null;
};

type IntegrationReauthEntry = {
  provider: string;
  label: string;
  url: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATAGRAN_API_KEY = () => process.env.DATAGRAN_API_KEY || "";

function isoToMs(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const t = iso.trim();
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeIntegrationsFetchState(value: unknown): IntegrationsFetchState {
  // Legacy: a single ISO string applies to all providers.
  if (typeof value === "string" && value.trim()) {
    const iso = value.trim();
    return { gmail: iso, google_calendar: iso, web_pixel: iso };
  }

  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const out: IntegrationsFetchState = {};
  if (typeof v.gmail === "string" && v.gmail.trim()) out.gmail = v.gmail.trim();
  if (typeof v.google_calendar === "string" && v.google_calendar.trim()) out.google_calendar = v.google_calendar.trim();
  if (typeof v.web_pixel === "string" && v.web_pixel.trim()) out.web_pixel = v.web_pixel.trim();
  return out;
}

const INTEGRATION_REAUTH_WARNING_COOLDOWN_MS = 12 * 60 * 60_000;

function integrationReauthFingerprint(entries: IntegrationReauthEntry[]): number | null {
  const providers = Array.from(
    new Set(
      entries
        .map((entry) => String(entry.provider || "").trim().toLowerCase())
        .filter(Boolean)
    )
  ).sort();
  if (providers.length === 0) return null;
  return stableHash(providers.join("|"));
}

function shouldSurfaceIntegrationReauthWarning(args: {
  taskConfig: HeartbeatTaskConfig;
  entries: IntegrationReauthEntry[];
  nowMs: number;
}): { shouldSurface: boolean; reason: string; fingerprint: number | null } {
  const fingerprint = integrationReauthFingerprint(args.entries);
  if (fingerprint === null) {
    return { shouldSurface: false, reason: "empty", fingerprint: null };
  }

  const prevFingerprint =
    typeof args.taskConfig.last_integration_reauth_warning_hash === "number"
      ? args.taskConfig.last_integration_reauth_warning_hash
      : null;
  if (prevFingerprint !== fingerprint) {
    return {
      shouldSurface: true,
      reason: prevFingerprint === null ? "first_warning" : "providers_changed",
      fingerprint,
    };
  }

  const prevAtMs = isoToMs(args.taskConfig.last_integration_reauth_warning_at);
  if (prevAtMs === null) {
    return { shouldSurface: true, reason: "missing_last_warning_time", fingerprint };
  }

  const elapsedMs = Math.max(0, args.nowMs - prevAtMs);
  if (elapsedMs >= INTEGRATION_REAUTH_WARNING_COOLDOWN_MS) {
    return { shouldSurface: true, reason: "cooldown_elapsed", fingerprint };
  }

  return { shouldSurface: false, reason: "cooldown_active", fingerprint };
}

function buildIntegrationReauthWarningText(entries: IntegrationReauthEntry[]): string {
  const safeEntries = entries.filter((entry) => entry.label && entry.url);
  if (safeEntries.length === 0) return "";

  const labels = safeEntries.map((entry) => entry.label);
  const joinedLabels =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  const missingContext = safeEntries.some((entry) => entry.provider === "gmail") &&
    safeEntries.some((entry) => entry.provider === "google_calendar")
    ? "email and calendar context"
    : safeEntries.some((entry) => entry.provider === "gmail")
      ? "email context"
      : "calendar context";
  const links = safeEntries.map((entry) => `${entry.label}: ${entry.url}`).join(" | ");

  return `Tiny admin note, ${joinedLabels} ${
    safeEntries.length === 1 ? "needs" : "need"
  } reconnecting, so heartbeat is missing ${missingContext}. Reconnect here: ${links}`;
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

  // Anthropic
  if (combined.includes("invalid x-api-key")) return true;
  if (combined.includes("authentication_error") && combined.includes("api")) return true;

  // OpenAI (and generic)
  if (combined.includes("incorrect api key")) return true;
  if (combined.includes("invalid api key")) return true;

  return false;
}

function isClaudeCliToken(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v.startsWith("sk-ant-oat");
}

function hasServerProviderKey(provider: ProviderId): boolean {
  if (provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return !!process.env.OPENAI_API_KEY;
  return false;
}

function clampHour(input: unknown, fallback: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const rounded = Math.floor(input);
  if (rounded < 0 || rounded > 23) return fallback;
  return rounded;
}

function isHourInWindow(hour24: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  if (startHour < endHour) {
    return hour24 >= startHour && hour24 < endHour;
  }
  // Overnight window (e.g. 23 -> 7)
  return hour24 >= startHour || hour24 < endHour;
}

function getLocalTimeContext(now: Date, timezone: string): LocalTimeContext {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);

    const weekdayRaw = parts.find((p) => p.type === "weekday")?.value || "Mon";
    const weekdayShort = weekdayRaw.slice(0, 3);
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const weekdayIndex = weekdayMap[weekdayShort] ?? 1;
    const hour24 = Number(parts.find((p) => p.type === "hour")?.value || "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value || "0");
    const isWeekend = weekdayIndex === 0 || weekdayIndex === 6;
    const dayPart: LocalTimeContext["dayPart"] =
      hour24 < 5 ? "late_night" : hour24 < 12 ? "morning" : hour24 < 18 ? "afternoon" : "evening";

    return {
      timezone,
      weekdayName: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
        weekdayIndex
      ],
      weekdayIndex,
      hour24,
      minute,
      isWeekend,
      dayPart,
    };
  } catch {
    const utcDay = now.getUTCDay();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const isWeekend = utcDay === 0 || utcDay === 6;
    const dayPart: LocalTimeContext["dayPart"] =
      utcHour < 5 ? "late_night" : utcHour < 12 ? "morning" : utcHour < 18 ? "afternoon" : "evening";

    return {
      timezone: "UTC",
      weekdayName: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
        utcDay
      ],
      weekdayIndex: utcDay,
      hour24: utcHour,
      minute: utcMinute,
      isWeekend,
      dayPart,
    };
  }
}

function formatDateKeyInTimezone(value: Date | string, timezone: string): string | null {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const year = parts.find((p) => p.type === "year")?.value || "";
    const month = parts.find((p) => p.type === "month")?.value || "";
    const day = parts.find((p) => p.type === "day")?.value || "";
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickHeartbeatStyleVariant(seed: string): string {
  const variants = [
    `dry-comedian: You find the absurdity in everything. Deadpan observations. You'd describe a server fire as "so the database chose violence today." Your humor comes from understatement and timing, never from trying to be funny.`,
    `spicy-best-friend: You're the friend who texts "dude" before dropping real talk. Warm but zero filter. You celebrate wins hard and call out bad ideas harder. You gossip about their calendar like it's tea.`,
    `sharp-coach: Economy of words. You see the pattern they're missing and point at it. No motivational posters — just "you're overcomplicating this" or "that meeting is a trap, skip it." Direct and occasionally blunt to the point of being funny.`,
    `chaotic-genius: You connect dots nobody asked you to connect. You'll pivot from a calendar event to a tangential insight that somehow lands. Stream-of-consciousness energy but every sentence has a point. Think "your 11am is going to run long — bet you $5 Compensar brings up pricing again."`,
  ] as const;
  return variants[stableHash(seed) % variants.length];
}

function compressWhitespace(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

function normalizeQuestionKey(v: string): string {
  return compressWhitespace(String(v || "")).replace(/[?]+$/g, "").toLowerCase();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim()))
    .filter(Boolean);
}

function parseJsonObjectFromText(raw: string): Record<string, unknown> | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const candidates: string[] = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]?.trim()) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore parse errors; caller handles null
    }
  }
  return null;
}

function toAgenticPlannerLines(value: unknown, maxItems: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const list = asStringArray(value).slice(0, Math.max(0, maxItems * 2));
  for (const item of list) {
    const normalized = compressWhitespace(item.replace(/^[-*#\d.)\s]+/, ""));
    if (!normalized || normalized.length < 8) continue;
    const clipped = normalized.length > 180 ? `${normalized.slice(0, 180).trimEnd()}…` : normalized;
    const dedupe = normalizeQuestionKey(clipped);
    if (!dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(clipped);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseAgenticResearchPlan(raw: string, args: {
  maxMemoryQuestions: number;
  maxWebQueries: number;
}): { memoryQuestions: string[]; webQueries: string[] } {
  const parsed = parseJsonObjectFromText(raw);
  if (!parsed) return { memoryQuestions: [], webQueries: [] };
  const memoryQuestions = toAgenticPlannerLines(
    parsed.memory_questions ?? parsed.memoryQuestions,
    args.maxMemoryQuestions
  ).map((q) => (q.endsWith("?") ? q : `${q}?`));
  const webQueries = toAgenticPlannerLines(
    parsed.web_search_queries ?? parsed.webSearchQueries,
    args.maxWebQueries
  );
  return { memoryQuestions, webQueries };
}

async function runDuckDuckGoInstantLookup(query: string): Promise<{ ok: boolean; summary: string; error?: string }> {
  const q = compressWhitespace(query);
  if (!q) return { ok: false, summary: "", error: "empty_query" };
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const ac = new AbortController();
    timeout = setTimeout(() => ac.abort(), 8_000);
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { method: "GET", signal: ac.signal });
    if (!res.ok) return { ok: false, summary: "", error: `ddg_status_${res.status}` };
    const json = await res.json().catch(() => null);
    const rec = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const heading = typeof rec.Heading === "string" ? compressWhitespace(rec.Heading) : "";
    const abstract = typeof rec.AbstractText === "string" ? compressWhitespace(rec.AbstractText) : "";
    const answer = typeof rec.Answer === "string" ? compressWhitespace(rec.Answer) : "";
    const relatedRaw = Array.isArray(rec.RelatedTopics) ? rec.RelatedTopics : [];
    const related: string[] = [];
    for (const item of relatedRaw.slice(0, 8)) {
      if (related.length >= 3) break;
      const obj = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      if (!obj) continue;
      const text = typeof obj.Text === "string" ? compressWhitespace(obj.Text) : "";
      if (text) related.push(text);
      if (related.length >= 3) break;
      const nested = Array.isArray(obj.Topics) ? obj.Topics : [];
      for (const sub of nested.slice(0, 4)) {
        if (related.length >= 3) break;
        const sobj = sub && typeof sub === "object" ? (sub as Record<string, unknown>) : null;
        const subText = typeof sobj?.Text === "string" ? compressWhitespace(sobj.Text) : "";
        if (subText) related.push(subText);
      }
    }
    const summary = [heading, abstract, answer, related.join(" | ")]
      .map((v) => compressWhitespace(v || ""))
      .filter(Boolean)
      .join(" — ");
    if (!summary) return { ok: false, summary: "", error: "no_result" };
    const clipped = summary.length > 420 ? `${summary.slice(0, 420).trimEnd()}…` : summary;
    return { ok: true, summary: clipped };
  } catch (e) {
    return { ok: false, summary: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeSignalTextForHash(text: string): string {
  const raw = String(text || "");
  if (!raw.trim()) return "";
  // Drop parenthetical "cached/age" lines so hashes reflect the underlying signal content.
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\(.*\)$/.test(l));
  return lines.join("\n").trim();
}

function signalHash(text: string): number | null {
  const normalized = normalizeSignalTextForHash(text);
  if (!normalized) return null;
  return stableHash(normalized.toLowerCase());
}

function normalizeHeartbeatTextForComparison(v: string): string {
  return String(v || "")
    .toLowerCase()
    .replace(/[`"'.,!?;:()[\]{}<>/\\|@#$%^&*_+=~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeHeartbeat(v: string): string[] {
  return normalizeHeartbeatTextForComparison(v)
    .split(" ")
    .map((w) => w.trim())
    .filter((w) => w.length > 2);
}

function tokenSet(v: string): Set<string> {
  return new Set(tokenizeHeartbeat(v));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function parseRecentHeartbeatExamples(snippets: string): string[] {
  const raw = String(snippets || "").trim();
  if (!raw || raw === "(none)") return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Example "))
    .map((line) => line.replace(/^Example\s+\d+:\s*/i, "").trim())
    .filter(Boolean);
}

function hasCurrentWebPixelSignals(webPixelSummary: string): boolean {
  const s = String(webPixelSummary || "").trim();
  if (!s) return false;
  if (
    /^\((nothing notable|not connected|could not fetch.*|scanned earlier today.*|last scanned .*check memory_context.*)\)$/i.test(
      s
    )
  ) {
    return false;
  }
  if (/check memory_context|scanned earlier today|last scanned .*check memory_context/i.test(s)) return false;
  if (/scanned:\s*0,\s*total:\s*\d+,\s*notable:\s*0,\s*ok:\s*0/i.test(s)) return false;
  return /\d/.test(s);
}

function buildInboxTriageLead(args: { pending: number; autoExecuted: number; critical: number }): string {
  const parts: string[] = [];
  if (args.pending > 0) parts.push(`${args.pending} email action${args.pending === 1 ? "" : "s"} waiting for approval`);
  if (args.autoExecuted > 0)
    parts.push(`${args.autoExecuted} low-risk email${args.autoExecuted === 1 ? "" : "s"} auto-processed`);
  if (args.critical > 0) parts.push(`${args.critical} critical email${args.critical === 1 ? "" : "s"} flagged`);
  if (parts.length === 0) return "Email triage update.";
  return `Email triage update: ${parts.join("; ")}.`;
}

function isHeartbeatPlaceholderSummary(value: string): boolean {
  const s = String(value || "").trim();
  if (!s) return true;
  if (/^\(.*\)$/.test(s)) return true;
  return /(see\s+memory_context|fetched earlier today|last fetched|scanned earlier today|could not fetch|nothing notable|not connected|no upcoming events|no recent emails|no new .* since last heartbeat)/i.test(
    s
  );
}

function firstHeartbeatSignalLine(value: string): string {
  const lines = String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/^\(.*\)$/.test(line)) continue;
    if (/^(gmail|calendar|web\s*pixel|upready)[^:]*:\s*$/i.test(line)) continue;
    if (/^(recent emails as of|calendar events for|web pixel signals as of)\b/i.test(line)) continue;
    return line;
  }
  return "";
}

function buildHeartbeatSkipFallbackText(args: {
  pending: number;
  autoExecuted: number;
  critical: number;
  calendarSummary: string;
  webPixelSummary: string;
  upreadySummary: string;
}): string {
  const lead = buildInboxTriageLead({
    pending: args.pending,
    autoExecuted: args.autoExecuted,
    critical: args.critical,
  });
  const signalParts: string[] = [];
  if (!isHeartbeatPlaceholderSummary(args.calendarSummary)) {
    const line = firstHeartbeatSignalLine(args.calendarSummary);
    if (line) signalParts.push(`Calendar: ${line}`);
  }
  if (hasCurrentWebPixelSignals(args.webPixelSummary)) {
    const line = firstHeartbeatSignalLine(args.webPixelSummary);
    if (line) signalParts.push(`Web: ${line}`);
  }
  if (!isHeartbeatPlaceholderSummary(args.upreadySummary)) {
    const line = firstHeartbeatSignalLine(args.upreadySummary);
    if (line) signalParts.push(`Readiness: ${line}`);
  }
  if (signalParts.length === 0) return lead;
  return `${signalParts.join(" ")} ${lead}`;
}

function normalizeEmailCleanupOpener(value: unknown): string {
  const raw = compressWhitespace(String(value || ""));
  if (!raw) return "Email cleanup time.";
  const cleaned = raw.replace(/^["'`\s]+|["'`\s]+$/g, "");
  if (!cleaned) return "Email cleanup time.";
  const withPeriod = /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
  return /email cleanup/i.test(withPeriod) ? withPeriod : "Email cleanup time.";
}

function parseEmailCleanupHeartbeatDecision(raw: string): EmailCleanupHeartbeatDecision {
  const parsed = parseJsonObjectFromText(raw);
  if (!parsed) {
    return {
      shouldSend: false,
      reason: "unparseable_decision",
      opener: "",
    };
  }
  const rawShouldSend =
    parsed.send_email_cleanup_heartbeat ??
    parsed.sendEmailCleanupHeartbeat ??
    parsed.send_cleanup ??
    parsed.sendCleanup ??
    parsed.send;
  const shouldSend =
    rawShouldSend === true ||
    (typeof rawShouldSend === "string" && /^(true|yes|1|send)$/i.test(rawShouldSend.trim()));
  const reason = clipHeartbeatText(String(parsed.reason || ""), 160);
  const opener = clipHeartbeatText(String(parsed.opener || parsed.intentional_opener || ""), 120);
  return {
    shouldSend,
    reason: reason || (shouldSend ? "model_selected_send" : "model_selected_skip"),
    opener,
  };
}

function parseEmailCleanupWindowDecision(raw: string): EmailCleanupWindowDecision {
  const parsed = parseJsonObjectFromText(raw);
  if (!parsed) {
    return {
      allowSendNow: false,
      reason: "unparseable_window_decision_default_deny",
    };
  }
  const rawAllow =
    parsed.allow_send_now ??
    parsed.allowSendNow ??
    parsed.send_now ??
    parsed.sendNow ??
    parsed.allow ??
    parsed.send;
  const allowSendNow =
    rawAllow === true ||
    (typeof rawAllow === "string" && /^(true|yes|1|allow|send)$/i.test(rawAllow.trim()));
  const reason = clipHeartbeatText(String(parsed.reason || ""), 160);
  return {
    allowSendNow,
    reason: reason || (allowSendNow ? "window_gate_allow" : "window_gate_skip"),
  };
}

function buildIntentionalEmailCleanupFallbackText(args: {
  opener: string;
  pending: number;
  autoExecuted: number;
  critical: number;
  calendarSummary: string;
  webPixelSummary: string;
  upreadySummary: string;
}): string {
  const opener = normalizeEmailCleanupOpener(args.opener);
  const body = buildHeartbeatSkipFallbackText({
    pending: args.pending,
    autoExecuted: args.autoExecuted,
    critical: args.critical,
    calendarSummary: args.calendarSummary,
    webPixelSummary: args.webPixelSummary,
    upreadySummary: args.upreadySummary,
  });
  return body ? `${opener} ${body}` : opener;
}

function clipHeartbeatText(v: string, maxChars: number): string {
  const s = compressWhitespace(String(v || ""));
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeInboxActionLabel(action: string): string {
  const a = String(action || "").trim().toLowerCase();
  if (a === "draft_reply") return "draft_reply";
  if (a === "mark_spam") return "mark_spam";
  if (a === "unsubscribe") return "unsubscribe";
  if (a === "archive") return "archive";
  return "label_only";
}

function normalizeInboxStatusLabel(status: string): "pending" | "approved" | "executing" | "done" | "rejected" | "failed" {
  const s = String(status || "").trim().toLowerCase();
  if (s === "approved") return "approved";
  if (s === "executing") return "executing";
  if (s === "done") return "done";
  if (s === "rejected") return "rejected";
  if (s === "failed") return "failed";
  return "pending";
}

async function buildInboxActionPromptContext(args: {
  supabase: SupabaseClient;
  userId: string;
  lookbackDays?: number;
  maxRows?: number;
}): Promise<InboxActionPromptContext> {
  const lookbackDays = Math.max(1, Math.min(14, Math.floor(args.lookbackDays ?? 7)));
  const maxRows = Math.max(20, Math.min(160, Math.floor(args.maxRows ?? 80)));
  const sinceIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60_000).toISOString();

  const { data, error } = await args.supabase
    .from("inbox_actions")
    .select(
      "mailbox_label,subject,recommended_action,status,confidence,p_important,p_spam,p_actionable,reason,created_at,updated_at,executed_at,run_id"
    )
    .eq("user_id", args.userId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(maxRows);

  if (error) {
    return {
      summary: "(inbox action status unavailable)",
      pendingCount: 0,
      approvedCount: 0,
      executingCount: 0,
      doneCount: 0,
      rejectedCount: 0,
      failedCount: 0,
    };
  }

  const rows = Array.isArray(data)
    ? data
        .map((raw) => (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null))
        .filter((r): r is Record<string, unknown> => !!r)
    : [];

  if (rows.length === 0) {
    return {
      summary: "(no recent inbox actions)",
      pendingCount: 0,
      approvedCount: 0,
      executingCount: 0,
      doneCount: 0,
      rejectedCount: 0,
      failedCount: 0,
    };
  }

  const statusCounts = {
    pending: 0,
    approved: 0,
    executing: 0,
    done: 0,
    rejected: 0,
    failed: 0,
  };
  const actionCounts: Record<string, number> = {
    draft_reply: 0,
    mark_spam: 0,
    unsubscribe: 0,
    archive: 0,
    label_only: 0,
  };

  for (const row of rows) {
    const status = normalizeInboxStatusLabel(typeof row.status === "string" ? row.status : "");
    const action = normalizeInboxActionLabel(
      typeof row.recommended_action === "string" ? row.recommended_action : ""
    );
    statusCounts[status] += 1;
    actionCounts[action] = (actionCounts[action] || 0) + 1;
  }

  const pendingRows = rows
    .filter((row) => normalizeInboxStatusLabel(typeof row.status === "string" ? row.status : "") === "pending")
    .slice(0, 4);
  const outcomeRows = rows
    .filter((row) => {
      const s = normalizeInboxStatusLabel(typeof row.status === "string" ? row.status : "");
      return s === "done" || s === "failed" || s === "rejected";
    })
    .slice(0, 4);

  const lines: string[] = [];
  lines.push(
    `Inbox actions (${lookbackDays}d): pending=${statusCounts.pending} | approved=${statusCounts.approved} | executing=${statusCounts.executing} | done=${statusCounts.done} | rejected=${statusCounts.rejected} | failed=${statusCounts.failed}`
  );
  lines.push(
    `Action mix: draft_reply=${actionCounts.draft_reply || 0} | mark_spam=${actionCounts.mark_spam || 0} | unsubscribe=${actionCounts.unsubscribe || 0} | archive=${actionCounts.archive || 0} | label_only=${actionCounts.label_only || 0}`
  );

  if (pendingRows.length > 0) {
    lines.push("Pending approvals:");
    lines.push(
      "Confidence semantics: conf is model confidence in the recommended action, not proof that the action is correct or incorrect."
    );
    for (const row of pendingRows) {
      const mailbox = clipHeartbeatText(
        typeof row.mailbox_label === "string" && row.mailbox_label.trim()
          ? row.mailbox_label
          : "Mailbox",
        22
      );
      const subject = clipHeartbeatText(
        typeof row.subject === "string" && row.subject.trim() ? row.subject : "(no subject)",
        90
      );
      const action = normalizeInboxActionLabel(
        typeof row.recommended_action === "string" ? row.recommended_action : ""
      );
      const confidence = Number(row.confidence);
      const conf =
        Number.isFinite(confidence) && confidence > 0
          ? ` conf=${Math.max(0, Math.min(1, confidence)).toFixed(2)}`
          : "";
      const toFiniteProb = (value: unknown): number | null => {
        if (typeof value === "number" && Number.isFinite(value)) {
          return Math.max(0, Math.min(1, value));
        }
        if (typeof value === "string" && value.trim()) {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
        }
        return null;
      };
      const pImportant = toFiniteProb((row as { p_important?: unknown }).p_important);
      const pSpam = toFiniteProb((row as { p_spam?: unknown }).p_spam);
      const pActionable = toFiniteProb((row as { p_actionable?: unknown }).p_actionable);
      const probs: string[] = [];
      if (pImportant !== null) probs.push(`important=${pImportant.toFixed(2)}`);
      if (pSpam !== null) probs.push(`spam=${pSpam.toFixed(2)}`);
      if (pActionable !== null) probs.push(`actionable=${pActionable.toFixed(2)}`);
      const probsText = probs.length > 0 ? ` probs={${probs.join(", ")}}` : "";
      const reason = clipHeartbeatText(
        typeof row.reason === "string" ? row.reason : "",
        120
      );
      lines.push(`- [${mailbox}] ${action}: ${subject}${conf}${probsText}${reason ? ` | reason=${reason}` : ""}`);
    }
  }

  if (outcomeRows.length > 0) {
    lines.push("Recent outcomes:");
    for (const row of outcomeRows) {
      const mailbox = clipHeartbeatText(
        typeof row.mailbox_label === "string" && row.mailbox_label.trim()
          ? row.mailbox_label
          : "Mailbox",
        22
      );
      const subject = clipHeartbeatText(
        typeof row.subject === "string" && row.subject.trim() ? row.subject : "(no subject)",
        90
      );
      const action = normalizeInboxActionLabel(
        typeof row.recommended_action === "string" ? row.recommended_action : ""
      );
      const status = normalizeInboxStatusLabel(typeof row.status === "string" ? row.status : "");
      const reason = clipHeartbeatText(
        typeof row.reason === "string" ? row.reason : "",
        100
      );
      lines.push(`- [${mailbox}] ${status}/${action}: ${subject}${reason ? ` | ${reason}` : ""}`);
    }
  }

  return {
    summary: lines.join("\n"),
    pendingCount: statusCounts.pending,
    approvedCount: statusCounts.approved,
    executingCount: statusCounts.executing,
    doneCount: statusCounts.done,
    rejectedCount: statusCounts.rejected,
    failedCount: statusCounts.failed,
  };
}

async function loadIntentionalEmailCleanupHeartbeatHistory(args: {
  supabase: SupabaseClient;
  userId: string;
  timezone: string;
  now: Date;
}): Promise<IntentionalEmailCleanupHeartbeatHistory> {
  const out: IntentionalEmailCleanupHeartbeatHistory = {
    lookupOk: false,
    sentTodayCount: 0,
    todayLocalTimes: [],
    recentLocalDateTimes: [],
    lastSentAtIso: null,
  };
  const todayKey = formatDateKeyInTimezone(args.now, args.timezone);
  if (!todayKey) return out;
  const sinceIso = new Date(args.now.getTime() - 14 * 24 * 60 * 60_000).toISOString();
  const { data, error } = await args.supabase
    .from("orchestrator_messages")
    .select("created_at, metadata")
    .eq("user_id", args.userId)
    .eq("role", "assistant")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(900);
  if (error || !Array.isArray(data)) return out;
  out.lookupOk = true;

  const seenRecentTimes = new Set<string>();
  const seenTodayTimes = new Set<string>();
  for (const row of data) {
    const createdAt = typeof row?.created_at === "string" ? row.created_at : "";
    if (!createdAt) continue;
    const metadata =
      row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null;
    if (!metadata) continue;
    const kind = typeof metadata.kind === "string" ? metadata.kind.trim().toLowerCase() : "";
    if (kind !== "heartbeat") continue;
    const isIntent = metadata.email_cleanup_intent === true;
    const focus = typeof metadata.heartbeat_focus === "string" ? metadata.heartbeat_focus.trim().toLowerCase() : "";
    if (!isIntent && focus !== "email_cleanup") continue;

    if (!out.lastSentAtIso) out.lastSentAtIso = createdAt;

    const localDateTime = formatLocalDateTimeForPrompt(createdAt, args.timezone);
    if (
      localDateTime &&
      localDateTime !== "unknown" &&
      !seenRecentTimes.has(localDateTime) &&
      out.recentLocalDateTimes.length < 12
    ) {
      out.recentLocalDateTimes.push(localDateTime);
      seenRecentTimes.add(localDateTime);
    }

    const createdDayKey = formatDateKeyInTimezone(createdAt, args.timezone);
    if (!createdDayKey || createdDayKey !== todayKey) continue;

    out.sentTodayCount += 1;
    const localTime = localDateTime.match(/\b\d{2}:\d{2}\b/)?.[0] || localDateTime;
    if (
      localTime &&
      localTime !== "unknown" &&
      !seenTodayTimes.has(localTime) &&
      out.todayLocalTimes.length < 8
    ) {
      out.todayLocalTimes.push(localTime);
      seenTodayTimes.add(localTime);
    }
  }
  return out;
}

function textMentionsWebPixelOrAnalytics(text: string): boolean {
  const t = String(text || "");
  return /web\s*pixel|pixel|visitors?|signups?|conversions?|page[_\s-]?views?|traffic|ctr|cpc|campaign|ads?/i.test(t);
}

function textMentionsReadiness(text: string): boolean {
  const t = String(text || "");
  return /upready|readiness|load/i.test(t);
}

function hasGenericWellbeingQuestion(text: string): boolean {
  const t = compressWhitespace(String(text || "").toLowerCase());
  return /\bhow are you feeling( today| right now)?\b/.test(t) || /\bhow do you feel( today| right now)?\b/.test(t);
}

function average(values: number[]): number | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildUpreadyWellbeingSignal(points: UpreadyReadinessPoint[]): WellbeingSignal {
  if (!Array.isArray(points) || points.length === 0) {
    return {
      triggered: false,
      source: "upready",
      reason: "",
      signalHash: null,
      debug: ["no_points"],
    };
  }

  const numericScores = points
    .map((p) => p.score)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (numericScores.length === 0) {
    return {
      triggered: false,
      source: "upready",
      reason: "",
      signalHash: null,
      debug: ["no_numeric_scores"],
    };
  }

  const latestScore = numericScores[0];
  const last7 = numericScores.slice(0, 7);
  const prev7 = numericScores.slice(7, 14);
  const avg7 = average(last7);
  const prevAvg7 = average(prev7);
  const delta7 = avg7 !== null && prevAvg7 !== null ? avg7 - prevAvg7 : null;
  const avgPrev3 = average(numericScores.slice(1, 4));
  const latestVsPrev3 = avgPrev3 !== null ? latestScore - avgPrev3 : null;

  let lowStreak = 0;
  for (const point of points) {
    const score = point?.score;
    if (typeof score !== "number" || !Number.isFinite(score)) break;
    if (score <= 60) {
      lowStreak += 1;
      continue;
    }
    break;
  }

  const reasons: string[] = [];
  if (latestScore <= 60 && lowStreak >= 2) {
    reasons.push(`readiness low streak (${lowStreak} days, latest ${Math.round(latestScore)})`);
  }
  if (delta7 !== null && delta7 <= -5) {
    reasons.push(`7-day readiness trend ${delta7 >= 0 ? "+" : ""}${delta7.toFixed(1)} vs prior week`);
  }
  if (latestVsPrev3 !== null && latestVsPrev3 <= -10) {
    reasons.push(`today dropped ${Math.abs(latestVsPrev3).toFixed(1)} points vs recent baseline`);
  }

  const reason = reasons.join("; ");
  return {
    triggered: reasons.length > 0,
    source: "upready",
    reason,
    signalHash: reasons.length > 0 ? stableHash(compressWhitespace(`upready ${reason}`).toLowerCase()) : null,
    debug: [
      `latest=${Math.round(latestScore)}`,
      `low_streak=${lowStreak}`,
      `avg7=${avg7 === null ? "n/a" : avg7.toFixed(1)}`,
      `prev_avg7=${prevAvg7 === null ? "n/a" : prevAvg7.toFixed(1)}`,
      `delta7=${delta7 === null ? "n/a" : delta7.toFixed(1)}`,
      `latest_vs_prev3=${latestVsPrev3 === null ? "n/a" : latestVsPrev3.toFixed(1)}`,
    ],
  };
}

function buildMemoryWellbeingSignal(memoryContext: string): WellbeingSignal {
  const text = String(memoryContext || "").toLowerCase();
  if (!text.trim()) {
    return {
      triggered: false,
      source: "memory",
      reason: "",
      signalHash: null,
      debug: ["empty_memory_context"],
    };
  }

  const cluePatterns = [
    {
      key: "sleep_strain",
      label: "sleep strain",
      regex:
        /\b(sleep(ing)? (has been )?(bad|rough|poor|worse)|slept badly|can'?t sleep|insomnia|sleep deprived|not sleeping well)\b/g,
    },
    {
      key: "stress_overload",
      label: "stress/overwhelm",
      regex: /\b(stressed|overwhelmed|anxious|burned out|burnt out|drained|exhausted)\b/g,
    },
    {
      key: "low_energy",
      label: "low energy",
      regex: /\b(low energy|no energy|fatigued|fatigue|wiped out|tired all day)\b/g,
    },
    {
      key: "mood_dip",
      label: "mood dip",
      regex: /\b(feeling down|felt down|sad lately|frustrated|irritable|emotionally drained)\b/g,
    },
  ] as const;

  const matched: string[] = [];
  let totalHits = 0;
  for (const pattern of cluePatterns) {
    const hits = text.match(pattern.regex) || [];
    if (hits.length > 0) {
      matched.push(pattern.label);
      totalHits += hits.length;
    }
  }

  const hasStrongClue = matched.length >= 2 || totalHits >= 3;
  const reason = hasStrongClue ? `memory clues suggest ${matched.join(", ")}` : "";
  return {
    triggered: hasStrongClue,
    source: "memory",
    reason,
    signalHash: hasStrongClue ? stableHash(compressWhitespace(`memory ${reason}`).toLowerCase()) : null,
    debug: [`matched=${matched.join(",") || "none"}`, `total_hits=${totalHits}`],
  };
}

function pickCalendarEventLinesStartingWithinMinutes(
  events: Array<{ start: string; line: string }>,
  nowMs: number,
  minutes: number,
  limit: number
): string[] {
  const maxDelta = Math.max(0, Math.floor(minutes)) * 60_000;
  const rows: Array<{ startMs: number; line: string }> = [];
  for (const event of events) {
    const start = typeof event.start === "string" ? event.start.trim() : "";
    const line = typeof event.line === "string" ? event.line.trim() : "";
    if (!start || !line) continue;
    if (!start.includes("T")) continue;
    const startMs = Date.parse(start);
    if (!Number.isFinite(startMs)) continue;
    const delta = startMs - nowMs;
    if (delta < 0 || delta > maxDelta) continue;
    rows.push({ startMs, line });
  }
  rows.sort((a, b) => a.startMs - b.startMs);
  return rows
    .slice(0, Math.max(0, Math.floor(limit)))
    .map((r) => r.line)
    .filter(Boolean);
}

function buildWellbeingContextForPrompt(args: {
  hasUpreadyReadiness: boolean;
  signal: WellbeingSignal;
  lastCheckinAtIso: string | null;
  hoursSinceLastCheckin: number | null;
  sameSignalAsLastCheckin: boolean;
}): string {
  const lines = [
    `upready_connected=${args.hasUpreadyReadiness}`,
    `wellbeing_signal_triggered=${args.signal.triggered}`,
    `wellbeing_signal_source=${args.signal.source}`,
    "wellbeing_decision_mode=model_led",
  ];
  if (args.signal.reason) {
    lines.push(`wellbeing_signal_reason=${args.signal.reason}`);
  }
  if (args.lastCheckinAtIso) {
    lines.push(`last_wellbeing_checkin_at=${args.lastCheckinAtIso}`);
  }
  lines.push(
    `hours_since_last_wellbeing_checkin=${
      args.hoursSinceLastCheckin === null ? "never" : args.hoursSinceLastCheckin.toFixed(1)
    }`
  );
  lines.push(`same_signal_as_last_wellbeing_checkin=${args.sameSignalAsLastCheckin}`);
  if (args.signal.debug.length > 0) {
    lines.push(`wellbeing_signal_debug=${args.signal.debug.join(" | ")}`);
  }
  if (!args.hasUpreadyReadiness) {
    lines.push("wellbeing_rule=upready_not_connected_use_memory_clues_only");
  }
  lines.push(
    "wellbeing_instruction=Use this as advisory context only. Decide from UPREADY_READINESS, MEMORY_CONTEXT, and recency whether a health mention is actually useful now."
  );
  return lines.join("\n");
}

function isWellbeingCheckInText(text: string): boolean {
  const t = compressWhitespace(String(text || ""));
  if (!t) return false;
  const hasReadinessAnchor = /\breadiness\b/i.test(t);
  const hasUpreadyAnchor = /\bupready\b/i.test(t);
  const hasReadinessDetail = /\b(latest readiness|latest score|7-day average|low streak|readiness trend|readiness load|latest load)\b/i.test(
    t
  );
  const hasWellbeingLanguage =
    /\b(sleep|low energy|energy levels?|stress|overwhelmed|burned out|burnt out|drained|fatigue|exhausted|recovery)\b/i.test(
      t
    );
  if (t.includes("?")) {
    return hasReadinessAnchor || (hasUpreadyAnchor && hasReadinessDetail) || hasWellbeingLanguage;
  }
  return hasWellbeingLanguage || hasReadinessAnchor || (hasUpreadyAnchor && hasReadinessDetail);
}

function startsWithSameLead(textA: string, textB: string, leadWords = 8): boolean {
  const a = tokenizeHeartbeat(textA).slice(0, leadWords).join(" ");
  const b = tokenizeHeartbeat(textB).slice(0, leadWords).join(" ");
  return Boolean(a && b && a === b);
}

function hasSharedWordNgram(textA: string, textB: string, n = 7): boolean {
  const a = tokenizeHeartbeat(textA);
  const b = tokenizeHeartbeat(textB);
  if (a.length < n || b.length < n) return false;

  const ngrams = new Set<string>();
  for (let i = 0; i <= a.length - n; i++) {
    ngrams.add(a.slice(i, i + n).join(" "));
  }
  for (let j = 0; j <= b.length - n; j++) {
    if (ngrams.has(b.slice(j, j + n).join(" "))) return true;
  }
  return false;
}

function shouldRegenerateHeartbeatForVariety(args: {
  text: string;
  recentHeartbeatSnippets: string;
  requirePixelMention?: boolean;
  requireReadinessMention?: boolean;
  forbidGenericWellbeingQuestion?: boolean;
}): { regenerate: boolean; reason: string } {
  const { text, recentHeartbeatSnippets } = args;
  const draft = String(text || "").trim();
  if (!draft || draft.startsWith("__SKIP__")) {
    return { regenerate: false, reason: "empty_or_skip" };
  }

  if (args.requirePixelMention && !textMentionsWebPixelOrAnalytics(draft)) {
    return { regenerate: true, reason: "missing_pixel_or_analytics_signal" };
  }

  if (args.requireReadinessMention && !textMentionsReadiness(draft)) {
    return { regenerate: true, reason: "missing_upready_readiness_signal" };
  }

  if (args.forbidGenericWellbeingQuestion && hasGenericWellbeingQuestion(draft)) {
    return { regenerate: true, reason: "generic_wellbeing_question" };
  }

  const examples = parseRecentHeartbeatExamples(recentHeartbeatSnippets);
  if (examples.length === 0) {
    return { regenerate: false, reason: "no_examples" };
  }

  const draftTokens = tokenSet(draft);
  let maxSimilarity = 0;
  let sameLead = false;
  let sharedLongPhrase = false;
  for (const ex of examples) {
    const sim = jaccardSimilarity(draftTokens, tokenSet(ex));
    if (sim > maxSimilarity) maxSimilarity = sim;
    if (!sameLead && startsWithSameLead(draft, ex, 8)) sameLead = true;
    if (!sharedLongPhrase && hasSharedWordNgram(draft, ex, 7)) sharedLongPhrase = true;
  }

  if (sharedLongPhrase) return { regenerate: true, reason: "shared_long_phrase_with_recent_example" };
  if (sameLead) return { regenerate: true, reason: "same_lead_as_recent_example" };
  if (maxSimilarity >= 0.62) return { regenerate: true, reason: `high_similarity_${maxSimilarity.toFixed(2)}` };

  return { regenerate: false, reason: "ok" };
}

function parsePreferenceComplianceResult(raw: string): {
  compliant: boolean;
  reason: string;
} {
  const text = String(raw || "").trim();
  if (!text) return { compliant: true, reason: "empty_checker_response" };
  if (/__COMPLIANT__/i.test(text)) return { compliant: true, reason: "compliant" };
  if (/__VIOLATION__/i.test(text)) {
    const explicitReason =
      text.replace(/^.*__VIOLATION__:\s*/i, "").trim() ||
      text.replace(/^.*__VIOLATION__/i, "").replace(/^[:\s-]+/, "").trim();
    return {
      compliant: false,
      reason: explicitReason || "preference_violation",
    };
  }
  // If checker output is malformed, do not silently block delivery.
  return { compliant: true, reason: `unparseable_checker_output:${text.slice(0, 160)}` };
}

function buildPreferenceComplianceCheckerPrompt(): string {
  return `You are a policy compliance checker for heartbeat drafts.
Your only job is to detect explicit conflicts with USER_PREFERENCES.

Output exactly one line:
- __COMPLIANT__
- __VIOLATION__: <very short reason>

Rules:
- Return __VIOLATION__ only when the draft clearly conflicts with an explicit suppression/exclusion in USER_PREFERENCES.
- Do NOT assume hidden preferences.
- Mentions of names, products, organizations, or vendors are allowed unless USER_PREFERENCES explicitly blocks them.
- If USER_PREFERENCES are ambiguous or silent on a topic, return __COMPLIANT__.
- Do not output anything else.`;
}

function isRetryableSupabaseErrorMessage(message: string): boolean {
  const text = String(message || "").trim().toLowerCase();
  if (!text) return false;
  return /(fetch failed|network|timeout|timed out|socket|econnreset|etimedout|enotfound|connection)/i.test(text);
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSupabaseQueryWithRetry<T>(
  query: () => PromiseLike<{ data: T | null; error: { message?: string } | null }>,
  args: { label: string; maxAttempts?: number; baseDelayMs?: number }
): Promise<{ data: T | null; errorMessage: string | null; attempts: number }> {
  const maxAttempts = Math.max(1, Math.min(4, Math.floor(args.maxAttempts ?? 3)));
  const baseDelayMs = Math.max(50, Math.min(2_000, Math.floor(args.baseDelayMs ?? 300)));
  let lastErrorMessage: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data, error } = await query();
      if (!error) {
        return { data, errorMessage: null, attempts: attempt };
      }
      lastErrorMessage = String(error.message || `${args.label}_query_failed`);
    } catch (e) {
      lastErrorMessage = e instanceof Error ? e.message : String(e);
    }

    const retryable = isRetryableSupabaseErrorMessage(lastErrorMessage || "");
    if (attempt < maxAttempts && retryable) {
      await waitMs(baseDelayMs * attempt);
      continue;
    }
    break;
  }

  return {
    data: null,
    errorMessage: lastErrorMessage || `${args.label}_query_failed`,
    attempts: maxAttempts,
  };
}

function isHiddenHeartbeatTask(task: unknown): boolean {
  if (!task || typeof task !== "object") return false;
  const t = task as Record<string, unknown>;
  return t.type === "heartbeat_v1" || t.ui_hidden === true;
}

function formatScheduleForPrompt(schedule: unknown): string {
  if (!schedule || typeof schedule !== "object") return "unknown";
  const s = schedule as Record<string, unknown>;
  const t = typeof s.type === "string" ? s.type : "";

  if (t === "once") {
    return typeof s.run_at === "string" && s.run_at.trim() ? `once @ ${s.run_at.trim()}` : "once";
  }

  if (t === "daily") {
    if (typeof s.hour === "number" && typeof s.minute === "number") {
      return `daily @ ${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")} (local)`;
    }
    return "daily";
  }

  if (t === "weekly") {
    const weekday =
      typeof s.weekday === "number"
        ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][s.weekday] || "?"
        : "?";
    if (typeof s.hour === "number" && typeof s.minute === "number") {
      return `weekly ${weekday} @ ${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(
        2,
        "0"
      )} (local)`;
    }
    return `weekly ${weekday}`;
  }

  if (t === "interval_minutes") {
    return typeof s.minutes === "number" ? `every ${s.minutes}m` : "interval";
  }

  return t || "unknown";
}

function formatLocalDateTimeForPrompt(value: Date | string, timezone: string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "unknown";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const weekday = parts.find((p) => p.type === "weekday")?.value || "???";
    const year = parts.find((p) => p.type === "year")?.value || "0000";
    const month = parts.find((p) => p.type === "month")?.value || "00";
    const day = parts.find((p) => p.type === "day")?.value || "00";
    const hour = parts.find((p) => p.type === "hour")?.value || "00";
    const minute = parts.find((p) => p.type === "minute")?.value || "00";
    return `${year}-${month}-${day} ${hour}:${minute} ${weekday} (${timezone})`;
  } catch {
    return d.toISOString();
  }
}

function formatScheduleTimingGuardForPrompt(schedule: unknown, localCtx: LocalTimeContext): string {
  if (!schedule || typeof schedule !== "object") return "n/a";
  const s = schedule as Record<string, unknown>;
  const t = typeof s.type === "string" ? s.type : "";
  const hour = typeof s.hour === "number" && Number.isFinite(s.hour) ? Math.floor(s.hour) : null;
  const minute = typeof s.minute === "number" && Number.isFinite(s.minute) ? Math.floor(s.minute) : null;
  const nowMinutes = localCtx.hour24 * 60 + localCtx.minute;
  const validHour = hour !== null && hour >= 0 && hour <= 23;
  const validMinute = minute !== null && minute >= 0 && minute <= 59;
  if ((t === "daily" || t === "weekly") && validHour && validMinute) {
    const hh = String(hour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");
    const slotMinutes = hour * 60 + minute;
    if (t === "daily") {
      return `today_slot_local=${hh}:${mm}; before_scheduled_time_today=${nowMinutes < slotMinutes}`;
    }
    const weekday = typeof s.weekday === "number" && Number.isFinite(s.weekday) ? Math.floor(s.weekday) : null;
    const weekdayLabel =
      weekday !== null && weekday >= 0 && weekday <= 6
        ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday]
        : "?";
    const todayMatch = weekday === localCtx.weekdayIndex;
    if (todayMatch) {
      return `today_is_scheduled_day=true; scheduled_weekday=${weekdayLabel}; today_slot_local=${hh}:${mm}; before_scheduled_time_today=${nowMinutes < slotMinutes}`;
    }
    return `today_is_scheduled_day=false; scheduled_weekday=${weekdayLabel}; slot_local=${hh}:${mm}`;
  }
  if (t === "interval_minutes" && typeof s.minutes === "number" && Number.isFinite(s.minutes)) {
    return `interval_minutes=${Math.max(1, Math.floor(s.minutes))}`;
  }
  return "n/a";
}

function summarizeJobPurposeForPrompt(job: ScheduledJobPromptRow): string {
  const kind = typeof job.kind === "string" ? job.kind : "shell";
  if (kind === "orchestrator") {
    const taskObj =
      job.task && typeof job.task === "object" ? (job.task as Record<string, unknown>) : null;
    const taskType = taskObj && typeof taskObj.type === "string" ? taskObj.type : "";
    if (taskType === "heartbeat_v1") return "heartbeat check-in";

    const message =
      taskObj && typeof taskObj.message === "string" ? compressWhitespace(taskObj.message) : "";
    if (message) return message.length > 180 ? `${message.slice(0, 180).trimEnd()}…` : message;
    return taskType ? `orchestrator task (${taskType})` : "orchestrator task";
  }

  const command = typeof job.command === "string" ? compressWhitespace(job.command) : "";
  if (command) return command.length > 140 ? `${command.slice(0, 140).trimEnd()}…` : command;
  return "shell task";
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const lim = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(lim, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Execute a single Datagran API call server-side. */
async function datagranApiCall(
  datagranApiKey: string,
  connectionId: string,
  method: string,
  endpoint: string,
  body?: unknown,
  provider?: string,
): Promise<{ ok: boolean; data?: unknown; error?: string; needsReauth?: boolean }> {
  try {
    const url = new URL(endpoint, "https://www.datagran.io");

    // For web_pixel provider, inject site_id instead of connection_id for pixel endpoints
    if (provider === "web_pixel" && endpoint.includes("/api/pixel/")) {
      if (!url.searchParams.has("site_id")) {
        url.searchParams.set("site_id", connectionId);
      }
    } else if (!url.searchParams.has("connection_id")) {
      url.searchParams.set("connection_id", connectionId);
    }

    const headers: Record<string, string> = {
      "x-api-key": datagranApiKey,
      "Content-Type": "application/json",
    };

    const DATAGRAN_API_TIMEOUT_MS = 60_000;
    const ac = new AbortController();
    const apiTimeout = setTimeout(() => ac.abort(), DATAGRAN_API_TIMEOUT_MS);

    const opts: RequestInit = { method: method.toUpperCase(), headers, signal: ac.signal };
    if (body && method.toUpperCase() !== "GET") {
      opts.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(url.toString(), opts);
    } finally {
      clearTimeout(apiTimeout);
    }
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      // Detect auth failures (expired/revoked OAuth token).
      // Datagran signals reauth via 401, or 409 with an error string like
      // "Connection requires reauthorization".
      const errMsg = data && typeof data === "object"
        ? String(
            (data as Record<string, unknown>).error
            || (data as Record<string, unknown>).message
            || (data as Record<string, unknown>).status
            || ""
          )
        : (typeof data === "string" ? data : "");
      const needsReauth = res.status === 401
        || /requires?\s+reauthor|reauthorization\s+required|authorization\s+required|token.*expired|invalid.*token/i.test(errMsg);
      return { ok: false, needsReauth: !!needsReauth, error: `${res.status}: ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}` };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type WebPixelConn = {
  siteId: string;
  name: string;
  apiKey: string;
};

type WebPixelStats = {
  visitors: number;
  sessions: number;
  uniquePeople: number;
  signUps: number;
  signIns: number;
  events: number;
  topPagePath?: string;
  topPageViews?: number;
  topEventName?: string;
  topEventCount?: number;
};

function parseWebPixelStats(data: unknown): WebPixelStats {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const stats =
    obj.stats && typeof obj.stats === "object" ? (obj.stats as Record<string, unknown>) : obj;
  const num = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };

  const topPagesRaw = Array.isArray(stats.top_pages) ? stats.top_pages : [];
  const topEventsRaw = Array.isArray(stats.top_events) ? stats.top_events : [];

  const topPage =
    topPagesRaw[0] && typeof topPagesRaw[0] === "object" ? (topPagesRaw[0] as Record<string, unknown>) : null;
  const topEvent =
    topEventsRaw[0] && typeof topEventsRaw[0] === "object" ? (topEventsRaw[0] as Record<string, unknown>) : null;

  return {
    visitors: num(stats.visitors),
    sessions: num(stats.sessions),
    uniquePeople: num(stats.unique_people),
    signUps: num(stats.sign_ups),
    signIns: num(stats.sign_ins),
    events: num(stats.events),
    topPagePath: typeof topPage?.path === "string" ? topPage.path : undefined,
    topPageViews: typeof topPage?.views === "number" && Number.isFinite(topPage.views) ? topPage.views : undefined,
    topEventName: typeof topEvent?.event_name === "string" ? topEvent.event_name : undefined,
    topEventCount: typeof topEvent?.count === "number" && Number.isFinite(topEvent.count) ? topEvent.count : undefined,
  };
}

function cleanPixelName(name: string): string {
  const n = name.trim();
  if (!n) return "Pixel";
  return n.replace(/^Pixel:\s*/i, "").trim() || n;
}

async function scanWebPixelsDaily(args: {
  conns: WebPixelConn[];
  maxPixels: number;
}): Promise<{
  summary: string;
  scanned: number;
  total: number;
  notable: number;
  okCount: number;
  errorCount: number;
}> {
  const { conns, maxPixels } = args;
  const total = conns.length;
  const list = conns
    .filter((c) => c && c.siteId && c.apiKey)
    .slice(0, Math.max(0, Math.min(maxPixels, conns.length)));
  if (list.length === 0) return { summary: "", scanned: 0, total, notable: 0, okCount: 0, errorCount: 0 };

  const nowMs = Date.now();
  const fromIso = new Date(nowMs - 24 * 60 * 60_000).toISOString();
  const toIso = new Date(nowMs).toISOString();
  const prevFromIso = new Date(nowMs - 48 * 60 * 60_000).toISOString();
  const prevToIso = fromIso;

  const nowStats = await mapLimit(list, 5, async (c) => {
    const r = await datagranApiCall(
      c.apiKey,
      c.siteId,
      "GET",
      `/api/pixel/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
      undefined,
      "web_pixel",
    );
    return { conn: c, ok: r.ok, stats: r.ok ? parseWebPixelStats(r.data) : null };
  });
  const okCount = nowStats.filter((r) => r.ok).length;
  const errorCount = list.length - okCount;

  // Baseline: only fetch previous-24h for pixels likely to matter.
  const withSignUps = nowStats
    .filter((r) => r.ok && r.stats && r.stats.signUps > 0)
    .sort((a, b) => (b.stats?.signUps || 0) - (a.stats?.signUps || 0))
    .slice(0, 12);

  const allTraffic = nowStats
    .filter((r) => r.ok && r.stats)
    .sort((a, b) => (b.stats?.visitors || 0) - (a.stats?.visitors || 0));

  const topTraffic = allTraffic.slice(0, 5);

  const baselineTargets = Array.from(
    new Map([...withSignUps, ...topTraffic].map((r) => [r.conn.siteId, r])).values()
  );

  const prevBySiteId = new Map<string, WebPixelStats>();
  await mapLimit(baselineTargets, 5, async (r) => {
    const c = r.conn;
    const res = await datagranApiCall(
      c.apiKey,
      c.siteId,
      "GET",
      `/api/pixel/stats?from=${encodeURIComponent(prevFromIso)}&to=${encodeURIComponent(prevToIso)}`,
      undefined,
      "web_pixel",
    );
    if (res.ok) prevBySiteId.set(c.siteId, parseWebPixelStats(res.data));
    return res.ok;
  });

  const signals: Array<{ score: number; line: string }> = [];

  for (const r of nowStats) {
    if (!r.ok || !r.stats) continue;

    const cur = r.stats;
    const prev = prevBySiteId.get(r.conn.siteId) || null;

    const vNow = cur.visitors;
    const vPrev = prev ? prev.visitors : null;
    const vDelta = vPrev === null ? null : vNow - vPrev;
    const vRatio = vPrev === null ? null : (vPrev > 0 ? vNow / vPrev : vNow > 0 ? Infinity : 1);

    const suNow = cur.signUps;
    const suPrev = prev ? prev.signUps : null;

    const spikeUp =
      vPrev !== null &&
      ((vPrev >= 40 && vDelta !== null && vDelta >= 60 && (vRatio || 0) >= 1.7) ||
        (vPrev < 40 && vNow >= 120));
    const spikeDown =
      vPrev !== null &&
      ((vPrev >= 80 && vDelta !== null && vDelta <= -60 && (vRatio || 1) <= 0.6) ||
        (vPrev >= 200 && vNow <= 100));

    const hasSignUps = suNow > 0 && (suPrev === null || suNow > suPrev);

    const notable = spikeUp || spikeDown || hasSignUps;
    if (!notable) continue;

    const name = cleanPixelName(r.conn.name);
    const bits: string[] = [];

    if (hasSignUps) {
      bits.push(suPrev === null ? `${suNow} signups` : `${suNow} signups (prev ${suPrev})`);
    }

    if (vPrev !== null && vDelta !== null && vRatio !== null && Number.isFinite(vRatio)) {
      const ratioTxt = vRatio === Infinity ? "∞x" : `${vRatio.toFixed(2)}x`;
      bits.push(`visitors ${vNow} vs ${vPrev} (${vDelta >= 0 ? "+" : ""}${vDelta}, ${ratioTxt})`);
    } else {
      bits.push(`visitors ${vNow}`);
    }

    if (cur.topEventName && typeof cur.topEventCount === "number") {
      bits.push(`top event ${cur.topEventName} (${cur.topEventCount})`);
    }
    if (cur.topPagePath && typeof cur.topPageViews === "number") {
      bits.push(`top page ${cur.topPagePath} (${cur.topPageViews} views)`);
    }

    const line = `${name}: ${bits.join("; ")}`.trim();
    const score = suNow * 1000 + (spikeUp ? 300 : 0) + (spikeDown ? 250 : 0) + Math.min(500, vNow);
    signals.push({ score, line });
  }

  signals.sort((a, b) => b.score - a.score);

  const notableLines = signals.slice(0, 8).map((s) => s.line);
  let summary = notableLines.join("\n").trim();

  // If nothing "notable" tripped (spikes/signups delta), still provide a small baseline
  // so the heartbeat has *some* pixel context to reference.
  if (!summary) {
    const baselineLines = topTraffic
      .filter((r) => r.ok && r.stats)
      .slice(0, 2)
      .map((r) => {
        const cur = r.stats!;
        const name = cleanPixelName(r.conn.name);
        const bits: string[] = [];
        if (cur.signUps > 0) bits.push(`${cur.signUps} signups`);
        bits.push(`visitors ${cur.visitors}`);
        if (cur.topPagePath && typeof cur.topPageViews === "number") {
          bits.push(`top page ${cur.topPagePath} (${cur.topPageViews} views)`);
        }
        return `${name}: ${bits.join("; ")}`.trim();
      })
      .filter(Boolean);
    if (baselineLines.length > 0) summary = baselineLines.join("\n").trim();
  }
  const coverageLines = allTraffic.map((r) => {
    const cur = r.stats!;
    const name = cleanPixelName(r.conn.name);
    const bits: string[] = [`visitors ${cur.visitors}`];
    if (cur.signUps > 0) bits.push(`signups ${cur.signUps}`);
    return `${name}: ${bits.join("; ")}`.trim();
  });
  const omittedByCap = Math.max(0, total - list.length);
  const coverageHeader =
    omittedByCap > 0
      ? `Pixel coverage (${list.length}/${total} connected scanned; ${omittedByCap} omitted by max_web_pixels cap):`
      : `Pixel coverage (${list.length}/${total} connected scanned):`;
  const coverageBlock =
    coverageLines.length > 0 ? `${coverageHeader}\n${coverageLines.join("\n")}` : `${coverageHeader}\n(no successful pixel stats fetched)`;
  const failedLines = nowStats
    .filter((r) => !r.ok)
    .map((r) => `${cleanPixelName(r.conn.name)}: fetch failed`)
    .slice(0, 12);
  const failedBlock = failedLines.length > 0 ? `Pixel fetch errors:\n${failedLines.join("\n")}` : "";
  summary = [summary, coverageBlock, failedBlock].filter(Boolean).join("\n\n").trim();

  return {
    summary,
    scanned: list.length,
    total,
    notable: notableLines.length,
    okCount,
    errorCount,
  };
}

/** Generate a Datagran reauth URL for a provider. */
async function generateReauthUrl(
  datagranApiKey: string,
  userId: string,
  email: string | undefined,
  provider: string,
): Promise<string | null> {
  try {
    const origin = process.env.NEXT_PUBLIC_APP_URL || "https://gogroovy.ai";
    const normalizedProvider = String(provider || "").trim().toLowerCase();
    const scopes = normalizedProvider === "gmail" ? GMAIL_REQUIRED_SCOPES : undefined;
    const res = await fetch("https://www.datagran.io/api/link/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": datagranApiKey },
      body: JSON.stringify({
        endUser: { externalId: `flow_${userId}`, email },
        origin,
        provider,
        ...(Array.isArray(scopes) && scopes.length > 0 ? { scopes } : {}),
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const linkToken = data.linkToken || data.link_token;
    if (!linkToken) return null;
    return `${origin}/dashboard?reauth=${provider}&linkToken=${linkToken}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchRecentEmails(
  datagranApiKey: string,
  connectionId: string,
  maxEmails: number,
  mailboxLabel?: string,
): Promise<{
  text: string;
  needsReauth?: boolean;
  ids: string[];
  items: Array<{
    id: string;
    threadId: string;
    from: string;
    to: string;
    cc: string;
    subject: string;
    date: string;
    snippet: string;
    listUnsubscribe?: string;
    messageIdHeader?: string;
    line: string;
  }>;
}> {
  const lookbackDays = 7;
  const inboxQuery = `in:inbox -from:me -label:"Groovy/Processed" -label:"Groovy/Unsubscribed" -label:"Groovy/Spam" newer_than:${lookbackDays}d`;
  // List inbox message IDs and activity counts from the last week.
  const listRes = await datagranApiCall(
    datagranApiKey,
    connectionId,
    "GET",
    `/api/proxy/gmail/gmail/v1/users/me/messages?q=${encodeURIComponent(inboxQuery)}&maxResults=${maxEmails}`,
  );
  if (!listRes.ok || !listRes.data) {
    console.warn("[heartbeat] Gmail fetch failed:", listRes.error || "no data", "needsReauth:", listRes.needsReauth);
    return { text: "(could not fetch emails)", needsReauth: listRes.needsReauth, ids: [], items: [] };
  }

  const inboxPayload = listRes.data as {
    messages?: Array<{ id: string; threadId?: string }>;
    resultSizeEstimate?: number;
  };
  const messages = inboxPayload?.messages;
  const inboxCount =
    typeof inboxPayload?.resultSizeEstimate === "number"
      ? inboxPayload.resultSizeEstimate
      : Array.isArray(messages)
        ? messages.length
        : 0;

  const [sentListRes, draftsListRes] = await Promise.all([
    datagranApiCall(
      datagranApiKey,
      connectionId,
      "GET",
      `/api/proxy/gmail/gmail/v1/users/me/messages?q=${encodeURIComponent(`in:sent newer_than:${lookbackDays}d`)}&maxResults=${Math.max(10, maxEmails)}`,
    ),
    datagranApiCall(
      datagranApiKey,
      connectionId,
      "GET",
      `/api/proxy/gmail/gmail/v1/users/me/drafts?maxResults=${Math.max(10, maxEmails)}`,
    ),
  ]);

  const sentPayload = sentListRes.ok
    ? (sentListRes.data as { messages?: Array<{ id: string }>; resultSizeEstimate?: number } | undefined)
    : undefined;
  const sentCount =
    typeof sentPayload?.resultSizeEstimate === "number"
      ? sentPayload.resultSizeEstimate
      : Array.isArray(sentPayload?.messages)
        ? sentPayload.messages.length
        : 0;
  const sentRefs = Array.isArray(sentPayload?.messages)
    ? sentPayload.messages
        .map((m) => (m && typeof m.id === "string" ? m.id.trim() : ""))
        .filter(Boolean)
        .slice(0, 3)
    : [];

  const draftsPayload = draftsListRes.ok
    ? (draftsListRes.data as { drafts?: Array<{ id: string }>; resultSizeEstimate?: number } | undefined)
    : undefined;
  const draftsCount =
    typeof draftsPayload?.resultSizeEstimate === "number"
      ? draftsPayload.resultSizeEstimate
      : Array.isArray(draftsPayload?.drafts)
        ? draftsPayload.drafts.length
        : 0;

  const prefix = mailboxLabel ? `[${mailboxLabel}] ` : "";
  const activityLine = `${prefix}Email activity (last ${lookbackDays}d): new_inbox=${inboxCount} | sent=${sentCount} | drafts=${draftsCount}`;
  let sentLines: string[] = [];
  if (sentRefs.length > 0) {
    const sentDetails = await mapLimit(sentRefs, 3, async (messageId, idx) => {
      const sentRes = await datagranApiCall(
        datagranApiKey,
        connectionId,
        "GET",
        `/api/proxy/gmail/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`
      );
      if (!sentRes.ok || !sentRes.data) return "";
      const payload = sentRes.data as { payload?: { headers?: Array<{ name: string; value: string }> } };
      const headers = payload?.payload?.headers || [];
      const get = (n: string) =>
        headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
      const to = clipHeartbeatText(get("To"), 70);
      const subject = clipHeartbeatText(get("Subject"), 70);
      const date = clipHeartbeatText(get("Date"), 60);
      return `${prefix}Sent ${idx + 1}: To=${to || "?"} | Subject=${subject || "(no subject)"} | Date=${date || "?"}`;
    });
    sentLines = sentDetails.filter(Boolean);
  }

  if (!messages || messages.length === 0) {
    const body = [activityLine, sentLines.length > 0 ? sentLines.join("\n") : "", "(no recent inbox emails)"]
      .filter(Boolean)
      .join("\n");
    return { text: body, ids: [], items: [] };
  }

  // Fetch metadata for each (parallel, capped)
  const refs = messages
    .slice(0, maxEmails)
    .map((m) => ({
      id: m && typeof m.id === "string" ? m.id.trim() : "",
      threadId: m && typeof m.threadId === "string" ? m.threadId.trim() : "",
    }))
    .filter((m) => Boolean(m.id));
  const ids = refs.map((m) => m.id);
  const EMAIL_DETAILS_CONCURRENCY = 6;
  const details = await mapLimit(refs, EMAIL_DETAILS_CONCURRENCY, async (ref, idx) => {
    const id = ref.id;
    const r = await datagranApiCall(
      datagranApiKey,
      connectionId,
      "GET",
      `/api/proxy/gmail/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=Message-ID`,
    );
    if (!r.ok || !r.data) return null;
    const payload = r.data as { payload?: { headers?: Array<{ name: string; value: string }> }; snippet?: string };
    const headers = payload?.payload?.headers || [];
    const get = (n: string) =>
      headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
    const from = get("From");
    const to = get("To");
    const cc = get("Cc");
    const subject = get("Subject");
    const date = get("Date");
    const listUnsubscribe = get("List-Unsubscribe");
    const messageIdHeader = get("Message-ID");
    const snippet = typeof payload?.snippet === "string" ? payload.snippet.trim() : "";
    const line = `${prefix}Email ${idx + 1}: From=${from} | Subject=${subject} | Date=${date}`;
    return {
      id,
      threadId: ref.threadId || "",
      from,
      to,
      cc,
      subject,
      date,
      snippet,
      listUnsubscribe,
      messageIdHeader,
      line,
    };
  });

  const items = details.filter(Boolean) as Array<{
    id: string;
    threadId: string;
    from: string;
    to: string;
    cc: string;
    subject: string;
    date: string;
    snippet: string;
    listUnsubscribe?: string;
    messageIdHeader?: string;
    line: string;
  }>;
  const lines = items.map((d) => d.line).filter(Boolean);
  const text =
    lines.length > 0
      ? [activityLine, sentLines.length > 0 ? sentLines.join("\n") : "", lines.join("\n")]
          .filter(Boolean)
          .join("\n")
      : [activityLine, sentLines.length > 0 ? sentLines.join("\n") : "", "(no inbox email details available)"]
          .filter(Boolean)
          .join("\n");
  return { text, ids, items };
}

async function fetchUpcomingEvents(
  datagranApiKey: string,
  connectionId: string,
  maxEvents: number,
): Promise<{
  text: string;
  needsReauth?: boolean;
  keys: string[];
  events: Array<{ id: string; summary: string; start: string; end: string; key: string; line: string }>;
}> {
  const now = new Date();
  // Weekly calendar context: start of local week (Mon) -> end of local week.
  const weekStart = new Date(now);
  const weekday = weekStart.getDay(); // 0=Sun, 1=Mon, ...
  const diffToMonday = (weekday + 6) % 7;
  weekStart.setDate(weekStart.getDate() - diffToMonday);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60_000);
  const timeMin = weekStart.toISOString();
  const timeMax = weekEnd.toISOString();

  const res = await datagranApiCall(
    datagranApiKey,
    connectionId,
    "GET",
    `/api/proxy/google-calendar/calendar/v3/calendars/primary/events?maxResults=${maxEvents}&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`,
  );
  if (!res.ok || !res.data) {
    console.warn("[heartbeat] Calendar fetch failed:", res.error || "no data", "needsReauth:", res.needsReauth);
    return { text: "(could not fetch calendar)", needsReauth: res.needsReauth, keys: [], events: [] };
  }

  const items = (
    res.data as {
      items?: Array<{
        id?: string;
        summary?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
      }>;
    }
  )?.items;
  if (!items || items.length === 0) return { text: "(no upcoming events)", keys: [], events: [] };

  const events = items.slice(0, maxEvents).map((ev, idx) => {
    const id = typeof ev.id === "string" ? ev.id.trim() : "";
    const summary = (ev.summary || "(no title)").trim();
    const start = ev.start?.dateTime || ev.start?.date || "?";
    const end = ev.end?.dateTime || ev.end?.date || "";
    const window = `${start}${end ? ` to ${end}` : ""}`;
    const line = `Week event ${idx + 1}: ${summary} @ ${window}`;
    const key = `${id || summary}|${start}|${end}`;
    return { id, summary, start, end, key, line };
  });
  const keys = events.map((e) => e.key);
  const lines = events.map((e) => e.line);
  return { text: lines.join("\n"), keys, events };
}

// ---------------------------------------------------------------------------
// Resolve LLM API key (same pattern as runOrchestratorRound)
// ---------------------------------------------------------------------------

const HEARTBEAT_OPENAI_MODEL = "gpt-5-mini-2025-08-07";
const HEARTBEAT_ANTHROPIC_MODEL =
  process.env.HEARTBEAT_ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-5-20250929";

async function resolveApiKey(supabase: SupabaseClient, userId: string): Promise<{
  provider: ProviderId;
  modelName: string;
  apiKey: string | null;
  billable: boolean;
  chargeType: UsageChargeType;
  error?: string;
}> {
  const resolved = await resolveKeys(userId, supabase, "");

  const anthropicMode = resolved.keyModes.anthropic || resolved.globalMode;
  const openaiMode = resolved.keyModes.openai || resolved.globalMode;
  const anthropicUserKey = resolved.userKeys.anthropic || null;
  const openaiUserKey = resolved.userKeys.openai || null;

  // Guardrail: if a Claude CLI headless token was accidentally saved under Anthropic,
  // never use it for chat models in heartbeat runs.
  if (
    anthropicMode === "user" &&
    anthropicUserKey &&
    isClaudeCliToken(anthropicUserKey) &&
    process.env.ANTHROPIC_API_KEY
  ) {
    console.warn("[heartbeat] Anthropic user key looks like Claude CLI token; falling back to Groovy Anthropic key.");
    return { provider: "anthropic", modelName: HEARTBEAT_ANTHROPIC_MODEL, apiKey: null, billable: true, chargeType: "groovy_key" };
  }

  // Heartbeat preference: Anthropic Sonnet for better personality/voice.
  if (anthropicMode === "user" && anthropicUserKey) {
    return { provider: "anthropic", modelName: HEARTBEAT_ANTHROPIC_MODEL, apiKey: anthropicUserKey, billable: true, chargeType: "external_key_fee" };
  }
  if (anthropicMode === "groovy" && process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", modelName: HEARTBEAT_ANTHROPIC_MODEL, apiKey: null, billable: true, chargeType: "groovy_key" };
  }

  // Fallback: OpenAI GPT-5 mini.
  if (openaiMode === "user" && openaiUserKey) {
    return { provider: "openai", modelName: HEARTBEAT_OPENAI_MODEL, apiKey: openaiUserKey, billable: true, chargeType: "external_key_fee" };
  }
  if (openaiMode === "groovy" && process.env.OPENAI_API_KEY) {
    return { provider: "openai", modelName: HEARTBEAT_OPENAI_MODEL, apiKey: null, billable: true, chargeType: "groovy_key" };
  }

  // If user explicitly selected user keys but none are present, call it out.
  if (anthropicMode === "user" || openaiMode === "user") {
    return {
      provider: "anthropic",
      modelName: HEARTBEAT_ANTHROPIC_MODEL,
      apiKey: null,
      billable: false,
      chargeType: "no_charge",
      error: "no_api_key",
    };
  }
  return {
    provider: "anthropic",
    modelName: HEARTBEAT_ANTHROPIC_MODEL,
    apiKey: null,
    billable: false,
    chargeType: "no_charge",
    error: "no_server_key",
  };
}

// ---------------------------------------------------------------------------
// Heartbeat system prompt
// ---------------------------------------------------------------------------

function buildHeartbeatPrompt(opts: {
  nowIso: string;
  localTime: string;
  timezone: string;
  localTimeContext: string;
  memoryContext: string;
  preferenceContext: string;
  wellbeingContext: string;
  scheduledTasksSummary: string;
  recentHeartbeatSnippets: string;
  styleVariant: string;
  emailSummary: string;
  inboxActionsSummary: string;
  calendarSummary: string;
  webPixelSummary: string;
  upreadySummary: string;
  hasGmail: boolean;
  hasCalendar: boolean;
  hasWebPixels: boolean;
  hasUpreadyReadiness: boolean;
  webResearchSummary?: string;
  forceSend?: boolean;
}): string {
  const parts: string[] = [];
  const preferenceBlock = formatPreferenceForPrompt(opts.preferenceContext, {
    channel: "heartbeat",
  }).trim();

  parts.push(`CRITICAL_EXECUTION_ORDER:
1) USER_PREFERENCES are the highest-priority constraints.
2) Follow USER_PREFERENCES before novelty, urgency, style, or any other rule.
3) If any drafted sentence conflicts with USER_PREFERENCES, regenerate or output __SKIP__.
4) Do not mention excluded items even if they appear in data sections.
5) USER_PREFERENCES are constraints only — they are NOT the only memory source.
6) You MUST also use MEMORY_CONTEXT for content selection (projects, personal details, recent actions, patterns, and surprises).

${
  preferenceBlock ||
  "## USER PREFERENCES (HIGHEST PRIORITY)\nNo explicit preference constraints were retrieved for this run."
}`);

  parts.push(`You are Groovy. You check in with the user periodically.

Current date/time: ${opts.localTime} (${opts.timezone})
Local time context: ${opts.localTimeContext}

VOICE:
You're texting a friend who happens to have their whole day in front of you. That's the energy. Not an assistant delivering a report — a person who noticed something and is telling them about it because they'd want to know.

You have opinions. Strong ones. Don't hedge with "it depends" — commit to a take.
If the answer fits in one sentence, one sentence is what they get.
Humor is your default mode — not forced jokes, just the natural wit of someone who's paying attention. A well-placed observation beats a bullet-point summary every time.
You can call things out. Charm over cruelty, but don't sugarcoat.
Light profanity is fine when it lands naturally. Don't force it. Don't overdo it.

Write like you'd text — start mid-thought sometimes. "That Supabase security email from 3am looks serious" not "I wanted to inform you that Supabase sent a security notification." Drop the preamble. Just say the thing.

Examples of good energy:
- "Sandra accepted the Compensar invite so that's locked in. Your 11:00 tomorrow is the one that actually matters — everything else is filler."
- "Supabase flagged security vulnerabilities at 3am. That's the kind of email you read before coffee, not after."
- "Someone connected you with Wendy, ex-Chief AI Officer at Tableau. Your week is packed but this one's worth a 15-minute slot."

Style variant for this message: ${opts.styleVariant}

FORMAT:
Plain text only. No markdown. No headings. No emojis.
Don't use bullet lists. No lines starting with '-' or '*'.
These messages are sent as WhatsApp updates. Keep them concise — but cover everything worth telling. Don't pad with filler, don't cut important context just to stay short.
At most ONE question mark total. Questions are optional.
NEVER ask generic wellbeing questions like "How are you feeling today?" or "How do you feel today?"
NEVER end with "want me to [do X]?" — just do it or skip it. If you're offering to help, state what you'll do and let them say no. Don't ask permission in every message.

ANTI-DRONE FILTER:
No corporate therapist tone. No HR-safe pep talk. No vague platitudes.
BANNED OPENERS: Never start a message with "New:", "Update:", "Heads up:", "Quick one:", "FYI:", or any single-word label followed by a colon. Never start with the same word twice in a row across heartbeats. Just start talking mid-thought, like a text from a friend.
BANNED CLOSERS: Never end with "want me to [verb]?", "shall I [verb]?", "should I [verb]?", or any permission-seeking question. If you have a suggestion, state it as a plan: "I'll [do X] unless you say otherwise" or just mention the info without offering to act.
Avoid these stale phrases: "solid foundation", "the real move", "either way", "all set up", "might want to", "have you thought about", "real talk", "real question is", "still in the", "ship it or kill it", "how's the", "five minutes max", "when daylight hits", "still the wall", "still the bottleneck", "still sitting there", "living that late-night grind", "that SMS", "pop into", "punch through that", "worth stopping the day for", "high-value contact", "tight one-page", "I'll draft".
Do not open with time references like "It's past X AM" or "It's nearly X AM" — the user can read a clock.
Do not repeatedly nag about the same unresolved task across multiple heartbeats — mention it once, then leave it alone until something changes.
Use concrete details and sharp language; sound like a real person with taste. Vary your sentence structure. Mix short declarative statements with longer ones. Sometimes lead with the action, sometimes with the context.

SLEEP/WAKE AWARENESS:
You do NOT know whether the user is awake or asleep. NEVER say things like "you're still up", "it's past midnight and you're awake", "you're still grinding", or anything that assumes you know the user's current state. You only know the local time — not whether they are at their computer, sleeping, or away. Do not comment on their sleep habits or imply they should go to bed. If it's late_night, just __SKIP__ silently.

FORCE_SEND:
${opts.forceSend ? "true" : "false"}
If FORCE_SEND=true, you MUST send a heartbeat. Do NOT output __SKIP__. If there is nothing noteworthy, send a short, human check-in anyway.

DECISION:
Before writing anything, decide if there is useful context worth surfacing now.
Good reasons to send: meaningful context from calendar/events this week, email activity trends (inbox/sent/drafts), web pixel traffic or signups, memory connections, readiness shifts, or a clear suggested next move.
Avoid low-value filler like "all quiet", but do NOT suppress useful context just because parts of it appeared before.
Treat CURRENT_SCHEDULED_TASKS as source-of-truth for what is already automated. Mention task status only when relevant (failure, timing, or impact).
SCHEDULE TIME GROUNDING (STRICT):
- CURRENT_SCHEDULED_TASKS includes schedule_guard and last_run_local fields. Use them literally.
- If schedule_guard contains before_scheduled_time_today=true, NEVER claim the task "ran today", "ran this morning", or "already ran".
- Only say a task ran "today" when last_run_local shows today's local date.
- If timing is uncertain, say "latest recorded run was ..." and cite last_run_local instead of inferring.
Respect local time and weekday context:
- late_night (midnight–5 AM): __SKIP__. Period. Unless a calendar event is starting in the next 60 minutes, output __SKIP__. Do not send motivational messages, do not recap the day, do not comment on the time.
- morning: prioritize what's coming soon today.
- afternoon: highlight blockers, follow-ups, and anything likely to slip.
- evening: focus on wrap-up + tomorrow prep.
- weekend: lower the intensity; only send when it is genuinely useful.

If there is NOTHING noteworthy, respond with exactly: __SKIP__
Do NOT pad it or explain — just the token alone.

CONTENT (only if you decide to send):
Lead with something the user has NOT heard in any recent heartbeat — a new event, a new email, a status change, a web pixel insight, or a personal detail you haven't referenced recently.
If there are upcoming meetings in the next 2 hours or urgent NEW emails, mention them.
Optionally suggest 1 action that would make their day easier — but only if it's a new suggestion, not one you've already made.
If Gmail/Calendar aren't connected and you have nothing else to say, one sentence suggesting they connect (but only if you haven't already suggested it in recent heartbeats).
If CURRENT_SCHEDULED_TASKS already includes an enabled automation, do NOT describe it, narrate it, or suggest scheduling it — the user already knows. Only mention it if something changed (new failure, imminent first run of the day, etc.).
Use INBOX_ACTION_STATUS to understand what already happened (pending approvals, done/failed/rejected outcomes) so you avoid repeating stale asks.
INBOX INTERPRETATION (STRICT):
- INBOX_ACTION_STATUS conf reflects triage-model confidence in its recommendation, not ground-truth correctness.
- Do not claim the autopilot is "wrong", "mistaken", or "the wrong call" unless INBOX_ACTION_STATUS reason/probabilities explicitly justify that conclusion.
- Do not use superlatives about confidence (for example "most certain ever") unless explicit historical comparison data is present in the provided context.

WELLBEING INTELLIGENCE:
WELLBEING_CONTEXT is advisory context, not a hard gate.
- Decide for yourself whether a wellbeing mention is worth sending now based on UPREADY_READINESS, MEMORY_CONTEXT, and the recency fields in WELLBEING_CONTEXT.
- If you mention wellbeing, ground it in concrete readiness numbers/trends or specific memory clues only. No invented biometrics.
- If the same wellbeing topic was raised very recently and nothing new happened, usually skip repeating it.
- Never ask generic "how are you feeling today?" style check-ins. Make it specific or skip it.

DIVERSITY — USE ALL DATA SOURCES:
You have access to emails, calendar, web pixel analytics, Upready readiness data, memory (projects, preferences, contacts, stored facts), and scheduled tasks. Do NOT default to just email + calendar every time. Actively look for interesting data from ALL sources:
- WEB_PIXEL_SIGNALS: If there's traffic data, visitor counts, signups, or notable changes — mention them. The user cares about their web analytics.
- UPREADY_READINESS: If readiness score or trend changed meaningfully, mention it with concrete numbers (score, trend, load).
- MEMORY_CONTEXT: This contains web pixel snapshots from previous fetches, stored projects, contacts, personal facts, and conversation history. If WEB_PIXEL_SIGNALS shows "(nothing notable)" but MEMORY_CONTEXT contains recent pixel data, USE the memory data.
- If recent heartbeats have been email-heavy, deliberately lead with something else — a pixel insight, a memory detail, a project status, a contact connection.
- The goal is that no two consecutive heartbeats feel like "email recap + calendar recap". Mix it up.

PERSONALITY:
You know this person. Act like it. Reference their projects by name, their contacts by name, their patterns. If they always have a packed Tuesday, acknowledge it. If they stored something personal recently, weave it in naturally — once, not every time.
The goal is for them to read this and think "this thing actually gets me" not "this thing read my calendar."

DIG INTO MEMORY — SURPRISE THEM:
MEMORY_CONTEXT is full of things the user may have forgotten or not connected. Look for:
- Funny coincidences or ironic patterns (e.g., they stored a note about wanting to sleep more but their calendar is stacked at 7am every day)
- Connections they haven't made (e.g., two contacts who work in the same space, a project goal that aligns with something they bookmarked weeks ago)
- Things that changed without them noticing (e.g., web pixel traffic doubled since last week, they haven't touched a project they said was urgent 2 weeks ago)
- Personal facts or milestones they stored and might enjoy being reminded of
- Stored preferences or goals they set for themselves that are relevant right now
Don't be a stalker about it — weave it in like a friend who has a good memory. "Didn't you say you wanted to [X]? Well, [Y] just happened" is gold. A heartbeat that surfaces something unexpected from memory is 10x more valuable than another email summary.

VARIETY (CRITICAL — follow this process BEFORE writing):
Step 1: Read RECENT_HEARTBEAT_EXAMPLES and avoid copying their exact opener or phrasing.
Step 2: Prefer a fresh angle (memory, calendar, pixels, readiness, email), but do NOT hide useful context just because it appeared before.
Step 3: If there is any actionable or meaningful context, send a concise heartbeat. Use __SKIP__ only when context is truly empty/irrelevant.

Additional variety rules:
- Do NOT reuse openings, rhythm, or phrasing from RECENT_HEARTBEAT_EXAMPLES.
- If your draft overlaps with any example by 5+ consecutive words, rewrite it completely.
- Each heartbeat should still feel useful and specific, not generic filler.`);

  if (opts.memoryContext) {
    parts.push(`\nMEMORY_CONTEXT:
MEMORY_CONTEXT may include relevance scores and citations from the memory system.
- "score" is the overall relevance (0-1). Higher = more relevant to the query.
- "freshness" indicates how recent the memory is (0-1). Higher = more recent.
- "semantic" is how closely the memory matches the query meaning (0-1).
Prioritize memories with high score AND high freshness — those are the most relevant and current. Low-freshness memories may be outdated. If all memories have low scores, there may be nothing worth mentioning.

${opts.memoryContext}`);
  }

  parts.push(`\nWELLBEING_CONTEXT:\n${opts.wellbeingContext && opts.wellbeingContext.trim() ? opts.wellbeingContext : "(none)"}`);

  parts.push(
    `\nCURRENT_SCHEDULED_TASKS:\n${
      opts.scheduledTasksSummary && opts.scheduledTasksSummary.trim()
        ? opts.scheduledTasksSummary
        : "(none)"
    }`
  );

  parts.push(
    `\nRECENT_HEARTBEAT_EXAMPLES:\n${
      opts.recentHeartbeatSnippets && opts.recentHeartbeatSnippets.trim()
        ? opts.recentHeartbeatSnippets
        : "(none)"
    }`
  );

  if (opts.hasCalendar) {
    parts.push(`\nUPCOMING_CALENDAR_EVENTS:\n${opts.calendarSummary}`);
  } else {
    parts.push(`\nUPCOMING_CALENDAR_EVENTS:\n(not connected)`);
  }

  if (opts.hasGmail) {
    parts.push(`\nRECENT_EMAILS:\n${opts.emailSummary}`);
  } else {
    parts.push(`\nRECENT_EMAILS:\n(not connected)`);
  }
  parts.push(
    `\nINBOX_ACTION_STATUS:\n${
      opts.inboxActionsSummary && opts.inboxActionsSummary.trim()
        ? opts.inboxActionsSummary
        : "(no inbox action status available)"
    }`
  );

  if (opts.hasWebPixels) {
    parts.push(
      `\nWEB_PIXEL_SIGNALS (last 24h):\n${opts.webPixelSummary.trim() ? opts.webPixelSummary : "(nothing notable)"}`
    );
  } else {
    parts.push(`\nWEB_PIXEL_SIGNALS (last 24h):\n(not connected)`);
  }

  if (opts.hasUpreadyReadiness) {
    parts.push(
      `\nUPREADY_READINESS:\n${opts.upreadySummary.trim() ? opts.upreadySummary : "(no recent readiness data)"}`
    );
  } else {
    parts.push(`\nUPREADY_READINESS:\n(not connected)`);
  }

  if (opts.webResearchSummary && opts.webResearchSummary.trim()) {
    parts.push(`\nWEB_RESEARCH_NOTES:\n${opts.webResearchSummary.trim()}`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runHeartbeat(args: {
  supabase: SupabaseClient;
  userId: string;
  userEmail: string | null;
  agentId?: string | null;
  taskConfig: HeartbeatTaskConfig;
  /** Job ID — needed to persist last_integrations_fetch timestamp */
  jobId?: string;
  /** IANA timezone from the connector (e.g., "America/New_York") */
  timezone?: string;
}): Promise<HeartbeatResult> {
  const { supabase, userId, userEmail, taskConfig, jobId, timezone } = args;
  const preferredHeartbeatAgentId = await resolveOwnedAgentId(supabase, userId, args.agentId);
  const taskHeartbeatAgentId = await resolveOwnedAgentId(
    supabase,
    userId,
    taskConfig.orchestrator_agent_id
  );
  let heartbeatAgentId = preferredHeartbeatAgentId || taskHeartbeatAgentId;
  if (!heartbeatAgentId) {
    heartbeatAgentId = await ensureHeartbeatSystemAgentId(supabase, userId);
  }
  if (!heartbeatAgentId) {
    return {
      ok: false,
      text: "",
      sessionId: null,
      agentId: null,
      sendWhatsApp: false,
      sendTelegram: false,
      error: "heartbeat_agent_init_failed",
    };
  }
  const opts = taskConfig.options || {};
  // We sometimes update scheduled_jobs.task inside this runner (best-effort). Keep a local
  // merged view so later updates don't clobber earlier ones.
  let dbTaskConfig: HeartbeatTaskConfig = {
    ...taskConfig,
    orchestrator_agent_id: heartbeatAgentId,
  };
  const forceSend =
    (opts as Record<string, unknown> | null)?.force_send === true ||
    (opts as Record<string, unknown> | null)?.debug_force_send === true;
  const agenticResearchEnabled = opts.agentic_research_enabled !== false;
  const agenticMemoryFollowupsMax = Math.max(
    0,
    Math.min(
      6,
      Number.isFinite(Number(opts.agentic_memory_followups_max))
        ? Math.floor(Number(opts.agentic_memory_followups_max))
        : 3
    )
  );
  const agenticWebQueriesMax = Math.max(
    0,
    Math.min(
      4,
      Number.isFinite(Number(opts.agentic_web_queries_max))
        ? Math.floor(Number(opts.agentic_web_queries_max))
        : 2
    )
  );
  const lookback = opts.lookback_minutes ?? 120;
  const maxEmails = opts.max_emails ?? 25;
  const maxEvents = opts.max_events ?? 80;
  const maxWebPixels =
    Number.isFinite(Number(opts.max_web_pixels)) && Number(opts.max_web_pixels) > 0
      ? Math.floor(Number(opts.max_web_pixels))
      : Number.MAX_SAFE_INTEGER;
  const inboxCleanupHeartbeatsPerDayMax = Math.max(
    0,
    Math.min(
      6,
      Number.isFinite(Number(opts.inbox_cleanup_heartbeats_per_day_max))
        ? Math.floor(Number(opts.inbox_cleanup_heartbeats_per_day_max))
        : 2
    )
  );
  const inboxCleanupUrgencyBypassEnabled =
    (opts as Record<string, unknown> | null)?.inbox_cleanup_urgency_bypass_enabled === true;
  const modelOverride = typeof opts.model_name === "string" && opts.model_name.trim()
    ? opts.model_name.trim()
    : "";
  const delivery = taskConfig.delivery || { dashboard: true, whatsapp: true };
  const now = new Date();
  const hasConnectorTimezone = typeof timezone === "string" && timezone.trim().length > 0;
  // Always resolve a real timezone — fall back to America/New_York (not UTC) so
  // quiet hours still work even when the connector hasn't reported a timezone.
  const tz = hasConnectorTimezone ? timezone!.trim() : "America/New_York";
  const localTime = now.toLocaleString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const localCtx = getLocalTimeContext(now, tz);
  // Quiet hours are ON by default — even without a connector timezone.
  // The only way to disable them is to explicitly set quiet_hours_enabled: false.
  const quietHoursEnabled =
    typeof opts.quiet_hours_enabled === "boolean" ? opts.quiet_hours_enabled : true;
  const quietStartHour = clampHour(opts.quiet_hours_start_hour, 23);
  const quietEndHourWeekday = clampHour(opts.quiet_hours_end_hour_weekday, 7);
  const quietEndHourWeekend = clampHour(opts.quiet_hours_end_hour_weekend, 9);
  const quietEndHour = localCtx.isWeekend ? quietEndHourWeekend : quietEndHourWeekday;
  const shouldSuppressForSleep =
    quietHoursEnabled && isHourInWindow(localCtx.hour24, quietStartHour, quietEndHour);
  const localTimeContext = `weekday=${localCtx.weekdayName}; hour=${String(localCtx.hour24).padStart(
    2,
    "0"
  )}:${String(localCtx.minute).padStart(2, "0")}; day_part=${localCtx.dayPart}; weekend=${
    localCtx.isWeekend
  }; quiet_window=${quietStartHour}-${quietEndHour}; sleep_window_active=${shouldSuppressForSleep}`;

  console.log("[heartbeat] starting", { userId, lookback, maxEmails, maxEvents, maxWebPixels });

  // 1. Resolve API key
  const keyInfo = await resolveApiKey(supabase, userId);
  const selectedModelName =
    modelOverride || (keyInfo.provider === "anthropic" ? "claude-sonnet-4-6" : keyInfo.modelName);
  console.log("[heartbeat] resolved API key:", {
    provider: keyInfo.provider,
    modelName: selectedModelName,
    modelOverride: modelOverride || null,
    hasUserKey: !!keyInfo.apiKey,
    error: keyInfo.error,
    envKeyExists: !!process.env.ANTHROPIC_API_KEY,
    envKeyPrefix: process.env.ANTHROPIC_API_KEY?.slice(0, 10),
  });
  if (keyInfo.error) {
    return { ok: false, text: "", sessionId: null, sendWhatsApp: false, sendTelegram: false, error: keyInfo.error };
  }

  // 1b. Respect local quiet hours so heartbeat does not ping while the user is likely asleep.
  if (shouldSuppressForSleep) {
    console.log("[heartbeat] skipped by quiet hours", {
      timezone: tz,
      weekday: localCtx.weekdayName,
      hour: localCtx.hour24,
      minute: localCtx.minute,
      quietStartHour,
      quietEndHour,
    });
    return { ok: true, text: "", sessionId: null, sendWhatsApp: false, sendTelegram: false };
  }

  // Billing usage events (best-effort): show heartbeat model usage in Usage dashboard.
  const billingTraceId = `heartbeat-${jobId || userId}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const billingTurnId = jobId || billingTraceId;
  let billingWorkspaceId: string | null | undefined = undefined;
  const getBillingWorkspaceId = async (): Promise<string | null> => {
    if (billingWorkspaceId !== undefined) return billingWorkspaceId;
    try {
      billingWorkspaceId = await getOrCreateWorkspaceIdForUser({
        userId,
        email: userEmail || null,
        supabaseAdmin: supabase,
      });
    } catch (e) {
      console.warn("[heartbeat] failed to resolve billing workspace:", e);
      billingWorkspaceId = null;
    }
    return billingWorkspaceId;
  };
  if (keyInfo.billable && keyInfo.chargeType !== "no_charge") {
    const workspaceId = await getBillingWorkspaceId();
    if (workspaceId) {
      const preflight = await preflightGroovyUsage({
        workspaceId,
        userId,
        userEmail: userEmail || null,
        traceId: billingTraceId,
        source: "heartbeat",
      });
      if (!preflight.allowed) {
        return {
          ok: false,
          text: "",
          sessionId: null,
          sendWhatsApp: false,
          sendTelegram: false,
          error: preflight.message,
        };
      }
    }
  }
  const recordHeartbeatUsage = async (args: {
    spanId: string;
    usage?: unknown;
    provider?: ProviderId;
    model?: string | null;
    billable?: boolean;
    chargeType?: UsageChargeType;
    meta?: Record<string, unknown>;
  }) => {
    if (!args.usage) return;
    const workspaceId = await getBillingWorkspaceId();
    if (!workspaceId) return;
    const eventBillable = args.billable ?? keyInfo.billable;
    const eventChargeType = args.chargeType || keyInfo.chargeType;
    insertBillingUsageEventBestEffort({
      workspaceId,
      userId,
      turnId: billingTurnId,
      traceId: billingTraceId,
      source: "heartbeat",
      spanId: args.spanId,
      provider: args.provider || keyInfo.provider,
      model: args.model || selectedModelName,
      usage: args.usage,
      billable: eventBillable,
      chargeType: eventChargeType,
      meta: args.meta || {},
    });
    if (eventBillable && eventChargeType !== "no_charge") {
      await settleGroovyUsageDebitBestEffort({
        workspaceId,
        userId,
        turnId: billingTurnId,
        traceId: billingTraceId,
        source: "heartbeat",
        spanId: args.spanId,
        model: args.model || selectedModelName,
        usage: args.usage,
        chargeType: eventChargeType,
        meta: args.meta || {},
      }).catch(() => {});
    }
  };

  // 2. Load memory context — two-pass: specific seed questions, then LLM-driven follow-ups.
  //    Hard cap: 2 rounds, max 2 follow-up questions.
  let memoryContext = "";
  let memoryConnectionId: string | null = null;
  const askedMemoryQuestionKeys = new Set<string>();
  let memoryTodayHash: number | null = null;
  let preferenceContext = "";
  try {
    const connectionId = await getGroovyMemoryConnection(
      userId,
      userEmail || undefined,
      supabase
    );
    if (connectionId) {
      memoryConnectionId = connectionId;
      const now = new Date();
      const todayStr = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

      // --- Pass 1: Fixed seed questions ---
      const seedQuestions = [
        `What information was stored or discussed today (${todayStr})? Include any personal facts, preferences, or things the user asked to remember.`,
        "What projects or tasks is the user currently working on? What did they work on most recently?",
        "What are the user's personal details, preferences, or fun facts that were recently stored?",
        `What integration snapshots or signals were stored today (${todayStr})? (emails, calendar, web pixels, ads, etc.) Summarize only the important bits.`,
        "What actions did the user already take recently (approved/rejected inbox actions, completed tasks, resolved follow-ups), and what outcomes are stored in memory?",
        "What concrete clues suggest stress, low energy, poor sleep, overload, or emotional strain recently?",
      ];
      for (const q of seedQuestions) askedMemoryQuestionKeys.add(normalizeQuestionKey(q));

      const seedResults = await Promise.all(
        seedQuestions.map((q) => queryMemoryDirect(connectionId, q).catch(() => ({ context: "", data: null }))),
      );

      // Track "today" memory deltas so we can send a heartbeat when only memory changed.
      // Use the *first* seed question (explicitly "today") to keep the fingerprint stable.
      const todayCtx = seedResults[0]?.context?.trim() || "";
      if (todayCtx) {
        memoryTodayHash = stableHash(compressWhitespace(todayCtx).toLowerCase());
      }

      // Collect pass-1 context
      const allParts: string[] = [];
      let totalChars = 0;
      const MAX_CHARS = 600_000;

      for (let i = 0; i < seedResults.length; i++) {
        const ctx = seedResults[i].context?.trim();
        if (!ctx) continue;
        const remaining = MAX_CHARS - totalChars;
        if (remaining <= 0) break;
        const safeCtx = ctx.length > remaining ? ctx.slice(0, remaining) : ctx;
        allParts.push(`[${seedQuestions[i].split("?")[0]}?]\n${safeCtx}`);
        totalChars += safeCtx.length;
        if (safeCtx.length < ctx.length) break;
      }

      const pass1Context = allParts.join("\n\n");

      console.log("[heartbeat] memory pass 1:", {
        questionsAsked: seedQuestions.length,
        resultsWithContent: seedResults.filter((r) => r.context?.trim()).length,
        totalChars,
      });

      // --- Pass 2: Generate follow-up questions based on pass-1 results ---
      if (pass1Context.trim() && totalChars < MAX_CHARS - 200) {
        try {
          const followUpModel = resolveChatModel(
            keyInfo.provider,
            selectedModelName,
            keyInfo.apiKey ? { apiKey: keyInfo.apiKey } : undefined
          );
          const followUpResult = await generateText({
            model: followUpModel,
            system: `You generate 1-2 SHORT follow-up questions to ask a memory database, based on what was already retrieved. The goal is to surface additional interesting or useful context for an hourly check-in message.

Rules:
- Output ONLY the questions, one per line. No numbering, no explanation.
- Questions must be specific and different from what was already asked.
- If the retrieved data mentions a person, project, date, or personal fact, ask something that digs deeper into it.
- Prioritize concrete wellbeing clues (stress, low energy, poor sleep, overload) when they appear in retrieved memory.
- If there is nothing interesting to follow up on, output exactly: __NONE__
- Maximum 2 questions.`,
            prompt: `Already retrieved:\n${pass1Context.slice(0, 2000)}\n\nAlready asked:\n${seedQuestions.join("\n")}\n\nWhat follow-up questions would retrieve additional useful context?`,
          });
          void recordHeartbeatUsage({
            spanId: "memory_followup_planner",
            usage: (followUpResult as unknown as { usage?: unknown }).usage,
            meta: { phase: "memory_pass2_followup_generation" },
          });

          const followUpText = (followUpResult.text || "").trim();
          if (followUpText && !followUpText.startsWith("__NONE__")) {
            const followUpQuestions = followUpText
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l && l.endsWith("?"))
              .slice(0, 2);
            for (const q of followUpQuestions) askedMemoryQuestionKeys.add(normalizeQuestionKey(q));

            if (followUpQuestions.length > 0) {
              console.log("[heartbeat] memory pass 2 questions:", followUpQuestions);

              const followUpResults = await Promise.all(
                followUpQuestions.map((q) => queryMemoryDirect(connectionId, q).catch(() => ({ context: "", data: null }))),
              );

              for (let i = 0; i < followUpResults.length; i++) {
                const ctx = followUpResults[i].context?.trim();
                if (!ctx) continue;
                const remaining = MAX_CHARS - totalChars;
                if (remaining <= 0) break;
                const safeCtx = ctx.length > remaining ? ctx.slice(0, remaining) : ctx;
                allParts.push(`[${followUpQuestions[i].split("?")[0]}?]\n${safeCtx}`);
                totalChars += safeCtx.length;
                if (safeCtx.length < ctx.length) break;
              }

              console.log("[heartbeat] memory pass 2:", {
                followUps: followUpQuestions.length,
                newContent: followUpResults.filter((r) => r.context?.trim()).length,
                totalChars,
              });
            }
          }
        } catch (e) {
          console.warn("[heartbeat] follow-up question generation failed:", e);
          // Non-fatal — we still have pass-1 context
        }
      }

      memoryContext = allParts.join("\n\n");

      const preferenceResult = await loadPreferenceMemoryContext(connectionId, {
        channel: "heartbeat",
        maxContextChars: 2000,
      });
      preferenceContext = preferenceResult.context;
      console.log("[heartbeat] preference memory loaded:", {
        question: preferenceResult.question,
        chars: preferenceResult.chars,
        hasContent: preferenceResult.context.length > 0,
      });
    }
  } catch (e) {
    console.warn("[heartbeat] memory load failed:", e);
  }

  // 2b. Load enabled scheduled jobs so heartbeat can reason about existing automation.
  let scheduledTasksSummary = "(none)";
  try {
    const { data: scheduledRows, errorMessage: scheduledErrMessage, attempts: scheduledAttempts } =
      await runSupabaseQueryWithRetry<ScheduledJobPromptRow[]>(
        () =>
          supabase
            .from("scheduled_jobs")
            .select("id,name,kind,command,task,schedule,last_run_at,last_status,enabled,updated_at")
            .eq("user_id", userId)
            .eq("enabled", true)
            .order("updated_at", { ascending: false })
            .limit(30),
        { label: "scheduled_jobs_context" }
      );

    if (scheduledErrMessage) {
      console.warn("[heartbeat] scheduled jobs load failed:", scheduledErrMessage);
    } else {
      if (scheduledAttempts > 1) {
        console.log("[heartbeat] scheduled jobs load recovered after retry", { attempts: scheduledAttempts });
      }
      const enabledJobs = ((scheduledRows || []) as ScheduledJobPromptRow[]).filter(
        (row) => row && typeof row === "object"
      );
      const visibleJobs = enabledJobs.filter((row) => !isHiddenHeartbeatTask(row.task));

      if (visibleJobs.length > 0) {
        const localNow = formatLocalDateTimeForPrompt(now, tz);
        const lines = visibleJobs.slice(0, 8).map((row, idx) => {
          const fallbackName =
            typeof row.id === "string" && row.id ? `Task ${row.id.slice(0, 8)}` : `Task ${idx + 1}`;
          const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : fallbackName;
          const schedule = formatScheduleForPrompt(row.schedule);
          const status =
            typeof row.last_status === "string" && row.last_status.trim()
              ? row.last_status.trim()
              : "unknown";
          const lastRunAt =
            typeof row.last_run_at === "string" && row.last_run_at.trim()
              ? row.last_run_at.trim()
              : "never";
          const lastRunLocal =
            lastRunAt === "never" ? "never" : formatLocalDateTimeForPrompt(lastRunAt, tz);
          const scheduleGuard = formatScheduleTimingGuardForPrompt(row.schedule, localCtx);
          const purpose = summarizeJobPurposeForPrompt(row);
          return `Task ${idx + 1}: ${name} | schedule=${schedule} | schedule_guard=${scheduleGuard} | last_status=${status} | last_run_utc=${lastRunAt} | last_run_local=${lastRunLocal} | purpose=${purpose}`;
        });

        if (visibleJobs.length > 8) {
          lines.push(`(+${visibleJobs.length - 8} more enabled scheduled tasks)`);
        }
        scheduledTasksSummary = [`Local now for schedule grounding: ${localNow}`, ...lines].join("\n");
      } else if (enabledJobs.length > 0) {
        scheduledTasksSummary = "(enabled schedules exist, but all are system-hidden)";
      }

      console.log("[heartbeat] scheduled tasks loaded", {
        enabledJobs: enabledJobs.length,
        visibleJobs: visibleJobs.length,
      });
    }
  } catch (e) {
    console.warn("[heartbeat] scheduled tasks context failed:", e);
  }

  // 2c. Load recent heartbeat examples so the model avoids repeating stale phrasing.
  let recentHeartbeatSnippets = "(none)";
  try {
    const sessionId =
      typeof taskConfig.orchestrator_session_id === "string" && taskConfig.orchestrator_session_id.trim()
        ? taskConfig.orchestrator_session_id.trim()
        : null;

    const { data: recentRows, errorMessage: recentErrMessage, attempts: recentAttempts } =
      await runSupabaseQueryWithRetry<Array<{ content?: unknown; metadata?: unknown; created_at?: unknown }>>(
        () => {
          let q = supabase
            .from("orchestrator_messages")
            .select("content,metadata,created_at")
            .eq("user_id", userId)
            .eq("role", "assistant")
            .order("created_at", { ascending: false })
            .limit(40);
          if (heartbeatAgentId) {
            q = q.eq("agent_id", heartbeatAgentId);
          } else if (sessionId) {
            q = q.eq("session_id", sessionId);
          }
          return q;
        },
        { label: "recent_heartbeat_samples" }
      );
    if (recentErrMessage) {
      console.warn("[heartbeat] recent heartbeat samples load failed:", recentErrMessage);
    } else {
      if (recentAttempts > 1) {
        console.log("[heartbeat] recent heartbeat samples load recovered after retry", { attempts: recentAttempts });
      }
      const lines = ((recentRows || []) as Array<{ content?: unknown; metadata?: unknown; created_at?: unknown }>)
        .filter((row) => row && typeof row.content === "string" && row.content.trim())
        .filter((row) => {
          // Avoid contaminating heartbeat examples with normal assistant chats.
          // Legacy fallback: if we are scoped to a heartbeat session, allow metadata-less rows from that session.
          if (!row.metadata || typeof row.metadata !== "object") {
            return Boolean(heartbeatAgentId || sessionId);
          }
          const m = row.metadata as Record<string, unknown>;
          const kind = typeof m.kind === "string" ? m.kind.trim() : "";
          return kind === "heartbeat";
        })
        .slice(0, 12)
        .map((row, idx) => {
          const content = compressWhitespace(String(row.content));
          return `Example ${idx + 1}: ${content}`;
        });

      if (lines.length > 0) {
        recentHeartbeatSnippets = lines.join("\n");
      }

      console.log("[heartbeat] recent heartbeat samples loaded", { count: lines.length });
    }
  } catch (e) {
    console.warn("[heartbeat] recent heartbeat samples context failed:", e);
  }

  // 3. Integrations — fetch fresh context every run and let the model decide
  // what is worth mentioning/actioning.
  const fetchState = normalizeIntegrationsFetchState(taskConfig.last_integrations_fetch);
  const cachedWebPixelSummary =
    typeof taskConfig.last_web_pixel_summary === "string" ? taskConfig.last_web_pixel_summary.trim() : "";

  let emailSummary = "";
  let calendarSummary = "";
  let webPixelSummary = "";
  let upreadySummary = "";
  let gmailMailboxContexts: TriageMailbox[] = [];
  const triageEmailItems: TriageEmailItem[] = [];
  let currentEmailIds: string[] = [];
  let currentEmailItems: Array<{
    id: string;
    prefixedId: string;
    connectionId: string;
    mailboxLabel: string;
    threadId: string;
    from: string;
    to: string;
    cc: string;
    subject: string;
    date: string;
    snippet: string;
    listUnsubscribe?: string;
    messageIdHeader?: string;
    line: string;
  }> = [];
  let currentCalendarKeys: string[] = [];
  let currentCalendarEvents: Array<{ id: string; summary: string; start: string; end: string; key: string; line: string }> = [];
  let upreadyLatestPointId: string | null = null;
  let hasGmail = false;
  let hasCalendar = false;
  let hasWebPixels = false;
  let hasUpreadyReadiness = false;
  let upreadyPoints: UpreadyReadinessPoint[] = [];
  const reauthNeeded: string[] = [];
  let integrationReauthEntries: IntegrationReauthEntry[] = [];
  let integrationReauthWarningText = "";
  let integrationReauthWarningHash: number | null = null;
  let integrationReauthWarningReason = "";
  let shouldAppendIntegrationReauthWarning = false;
  let appendedIntegrationReauthWarning = false;
  let inboxTriageResult: {
    runId: string;
    pendingActionIds: string[];
    pendingCount: number;
    autoExecutedCount: number;
    criticalCount: number;
    notes: string[];
  } | null = null;
  let inboxActionsPromptContext: InboxActionPromptContext = {
    summary: "(no recent inbox actions)",
    pendingCount: 0,
    approvedCount: 0,
    executingCount: 0,
    doneCount: 0,
    rejectedCount: 0,
    failedCount: 0,
  };

  // Always load connection status (cheap). We only load API keys if we actually fetch.
  type IntegrationProvider = "gmail" | "google_calendar" | "web_pixel";
  type IntegrationConn = {
    agentId: string | null;
    provider: IntegrationProvider;
    connectionId: string;
  };
  const integrationProviders: IntegrationProvider[] = ["gmail", "google_calendar", "web_pixel"];
  const toProvider = (v: unknown): IntegrationProvider | null =>
    v === "gmail" || v === "google_calendar" || v === "web_pixel" ? v : null;
  const toTrimmedString = (v: unknown): string =>
    typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
  const normalizeConns = (
    rows: Array<{ agent_id?: unknown; provider?: unknown; connection_id?: unknown }> | null | undefined
  ): IntegrationConn[] =>
    (rows || [])
      .map((row) => {
        const provider = toProvider(row?.provider);
        if (!provider) return null;
        return {
          agentId: toTrimmedString(row?.agent_id) || null,
          provider,
          connectionId: toTrimmedString(row?.connection_id),
        } satisfies IntegrationConn;
      })
      .filter((row): row is IntegrationConn => !!row);

  let connSource: "user_id" | "external_id" | "agent_owner" | "none" = "none";
  let allConns: IntegrationConn[] = [];

  const { data: byUserRows, error: byUserErr } = await supabase
    .from("datagran_agent_configs")
    .select("agent_id, provider, connection_id")
    .eq("user_id", userId)
    .in("provider", integrationProviders);
  if (byUserErr) {
    console.warn("[heartbeat] integrations lookup failed (user_id):", byUserErr.message);
  }
  allConns = normalizeConns(byUserRows as Array<{ agent_id?: unknown; provider?: unknown; connection_id?: unknown }>);
  if (allConns.length > 0) connSource = "user_id";

  // Legacy/migration fallback: some rows were written with mismatched user_id but correct external id.
  if (allConns.length === 0) {
    const { data: byExternalRows, error: byExternalErr } = await supabase
      .from("datagran_agent_configs")
      .select("agent_id, provider, connection_id")
      .eq("end_user_external_id", `flow_${userId}`)
      .in("provider", integrationProviders);
    if (byExternalErr) {
      console.warn("[heartbeat] integrations lookup failed (external_id):", byExternalErr.message);
    }
    allConns = normalizeConns(
      byExternalRows as Array<{ agent_id?: unknown; provider?: unknown; connection_id?: unknown }>
    );
    if (allConns.length > 0) connSource = "external_id";
  }

  // Last-resort fallback: find configs by this user's Datagran agents.
  if (allConns.length === 0) {
    const { data: ownedAgentRows, error: ownedAgentErr } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", userId)
      .eq("type", "datagran")
      .limit(500);
    if (ownedAgentErr) {
      console.warn("[heartbeat] integrations lookup failed (agent owner):", ownedAgentErr.message);
    }
    const ownedAgentIds = (ownedAgentRows || [])
      .map((r) => toTrimmedString((r as { id?: unknown }).id))
      .filter(Boolean);
    if (ownedAgentIds.length > 0) {
      const { data: byAgentRows, error: byAgentErr } = await supabase
        .from("datagran_agent_configs")
        .select("agent_id, provider, connection_id")
        .in("agent_id", ownedAgentIds)
        .in("provider", integrationProviders);
      if (byAgentErr) {
        console.warn("[heartbeat] integrations lookup failed (agent_id list):", byAgentErr.message);
      }
      allConns = normalizeConns(
        byAgentRows as Array<{ agent_id?: unknown; provider?: unknown; connection_id?: unknown }>
      );
      if (allConns.length > 0) connSource = "agent_owner";
    }
  }

  const connectedConns = allConns.filter((c) => c.connectionId.length > 0);
  const gmailConns = connectedConns.filter((c) => c.provider === "gmail");
  const calendarConns = connectedConns.filter((c) => c.provider === "google_calendar");
  const connectedWebPixelConns = connectedConns.filter((c) => c.provider === "web_pixel");

  const namedAgentIds = Array.from(
    new Set(
      [...connectedWebPixelConns, ...gmailConns]
        .map((c) => c.agentId)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    )
  );
  const agentNameById = new Map<string, string>();
  if (namedAgentIds.length > 0) {
    const { data: namedAgentRows, error: namedAgentErr } = await supabase
      .from("agents")
      .select("id,name")
      .in("id", namedAgentIds);
    if (namedAgentErr) {
      console.warn("[heartbeat] integration name lookup failed:", namedAgentErr.message);
    } else {
      for (const row of namedAgentRows || []) {
        const id = toTrimmedString((row as { id?: unknown }).id);
        const name = toTrimmedString((row as { name?: unknown }).name);
        if (id && name) agentNameById.set(id, name);
      }
    }
  }

  const seenWebPixelIds = new Set<string>();
  const webPixelSites = connectedWebPixelConns
    .map((c) => {
      const siteId = c.connectionId;
      const fallbackName = `Pixel ${siteId.slice(0, 6)}`;
      const name = c.agentId ? agentNameById.get(c.agentId) || fallbackName : fallbackName;
      return { siteId, name };
    })
    .filter((c) => {
      if (!c.siteId || seenWebPixelIds.has(c.siteId)) return false;
      seenWebPixelIds.add(c.siteId);
      return true;
    });

  const seenGmailConnIds = new Set<string>();
  const gmailMailboxes: Array<{ connectionId: string; mailboxLabel: string }> = gmailConns
    .map((c, idx) => {
      const connectionId = c.connectionId;
      const fallback = `Mailbox ${idx + 1}`;
      const mailboxLabel = c.agentId ? agentNameById.get(c.agentId) || fallback : fallback;
      return { connectionId, mailboxLabel };
    })
    .filter((m) => {
      if (!m.connectionId || seenGmailConnIds.has(m.connectionId)) return false;
      seenGmailConnIds.add(m.connectionId);
      return true;
    });
  const seenCalendarConnIds = new Set<string>();
  const calendarCalendars: Array<{ connectionId: string; calendarLabel: string }> = calendarConns
    .map((c, idx) => {
      const connectionId = c.connectionId;
      const fallback = `Calendar ${idx + 1}`;
      const calendarLabel = c.agentId ? agentNameById.get(c.agentId) || fallback : fallback;
      return { connectionId, calendarLabel };
    })
    .filter((c) => {
      if (!c.connectionId || seenCalendarConnIds.has(c.connectionId)) return false;
      seenCalendarConnIds.add(c.connectionId);
      return true;
    });

  console.log("[heartbeat] integrations connection lookup", {
    source: connSource,
    totalRows: allConns.length,
    connectedRows: connectedConns.length,
    gmailRows: connectedConns.filter((c) => c.provider === "gmail").length,
    gmailMailboxes: gmailMailboxes.length,
    calendarRows: connectedConns.filter((c) => c.provider === "google_calendar").length,
    calendarCalendars: calendarCalendars.length,
    webPixelRows: webPixelSites.length,
  });

  hasGmail = gmailMailboxes.length > 0;
  hasCalendar = calendarCalendars.length > 0;
  hasWebPixels = webPixelSites.length > 0;
  const hasAnyIntegration = hasGmail || hasCalendar || hasWebPixels;

  const shouldFetchGmail = hasGmail;
  const shouldFetchCalendar = hasCalendar;
  const shouldFetchWebPixels = hasWebPixels;
  const shouldFetchAny = hasAnyIntegration;

  if (!shouldFetchAny) {
    if (!hasAnyIntegration) {
      console.log("[heartbeat] integrations fetch skipped (no connected integrations)", {
        fetchState,
        hasGmail,
        hasCalendar,
        hasWebPixels,
      });
    }
    // For providers not fetched this run, indicate last-fetched time so the model knows data age.
    const fmtAge = (iso: string | undefined) => {
      if (!iso) return "never";
      const ms = Date.now() - Date.parse(iso);
      if (ms < 60_000) return "just now";
      if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
      return `${Math.round(ms / 3600_000)}h ago`;
    };
    if (hasCalendar && !shouldFetchCalendar)
      calendarSummary = `(last fetched ${fmtAge(fetchState.google_calendar)} — check MEMORY_CONTEXT for cached snapshot)`;
    if (hasGmail && !shouldFetchGmail)
      emailSummary = `(last fetched ${fmtAge(fetchState.gmail)} — check MEMORY_CONTEXT for cached snapshot)`;
    if (hasWebPixels && !shouldFetchWebPixels) {
      if (hasCurrentWebPixelSignals(cachedWebPixelSummary)) {
        webPixelSummary = `${cachedWebPixelSummary}\n(cached from previous scan; last scanned ${fmtAge(fetchState.web_pixel)})`;
      } else {
        webPixelSummary = `(last scanned ${fmtAge(fetchState.web_pixel)} — check MEMORY_CONTEXT for cached snapshot)`;
      }
    }
  } else {
    console.log("[heartbeat] fetching integrations", {
      gmail: shouldFetchGmail,
      google_calendar: shouldFetchCalendar,
      web_pixel: shouldFetchWebPixels,
      freshness: "fresh_every_run",
    });

    const providersToFetch = [
      ...(shouldFetchGmail ? ["gmail"] : []),
      ...(shouldFetchCalendar ? ["google_calendar"] : []),
      ...(shouldFetchWebPixels ? ["web_pixel"] : []),
    ];

    const webPixelSiteIdsToFetch = new Set(
      shouldFetchWebPixels ? webPixelSites.slice(0, maxWebPixels).map((c) => c.siteId) : []
    );
    const selectedFetchConns: IntegrationConn[] = [
      ...(shouldFetchGmail
        ? connectedConns.filter((c) => c.provider === "gmail")
        : []),
      ...(shouldFetchCalendar
        ? connectedConns.filter((c) => c.provider === "google_calendar")
        : []),
      ...(shouldFetchWebPixels
        ? connectedWebPixelConns.filter((c) => webPixelSiteIdsToFetch.has(c.connectionId))
        : []),
    ];
    const selectedAgentIds = Array.from(
      new Set(
        selectedFetchConns
          .map((c) => c.agentId)
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      )
    );
    const selectedConnIds = Array.from(
      new Set(selectedFetchConns.map((c) => c.connectionId).filter((v) => v.length > 0))
    );

    let keyRowsQuery = supabase
      .from("datagran_agent_configs")
      .select("agent_id, provider, connection_id, datagran_api_key_enc")
      .in("provider", providersToFetch);
    if (selectedAgentIds.length > 0) {
      keyRowsQuery = keyRowsQuery.in("agent_id", selectedAgentIds);
    } else if (selectedConnIds.length > 0) {
      keyRowsQuery = keyRowsQuery.in("connection_id", selectedConnIds);
    } else {
      keyRowsQuery = keyRowsQuery.eq("user_id", userId);
    }
    const { data: keyRows, error: keyRowsErr } = await keyRowsQuery;
    if (keyRowsErr) {
      console.warn("[heartbeat] integrations key lookup failed:", keyRowsErr.message);
    }

    const dgKey = DATAGRAN_API_KEY();
    const apiKeyByConnId = new Map<string, string>();
    for (const row of keyRows || []) {
      const connId = typeof row?.connection_id === "string" ? row.connection_id : "";
      if (!connId) continue;
      const enc = (row as unknown as { datagran_api_key_enc?: unknown }).datagran_api_key_enc;
      if (typeof enc !== "string" || !enc.trim()) continue;
      try {
        apiKeyByConnId.set(connId, decryptLlmApiKey(enc));
      } catch {
        // ignore
      }
    }

    const webPixelConns: WebPixelConn[] = shouldFetchWebPixels
      ? webPixelSites.slice(0, maxWebPixels).map((c) => ({
          siteId: c.siteId,
          name: c.name,
          apiKey: apiKeyByConnId.get(c.siteId) || dgKey,
        }))
      : [];

    const noEmailResult = {
      text: "",
      needsReauth: false,
      ids: [] as string[],
      items: [] as Array<{
        id: string;
        threadId: string;
        from: string;
        to: string;
        cc: string;
        subject: string;
        date: string;
        snippet: string;
        listUnsubscribe?: string;
        messageIdHeader?: string;
        line: string;
      }>,
    };
    const noCalendarResult = { text: "", needsReauth: false, keys: [] as string[], events: [] as Array<{ id: string; summary: string; start: string; end: string; key: string; line: string }> };
    const [emailResultsByMailbox, calendarResultsByConnection, webPixelScan] = await Promise.all([
      shouldFetchGmail
        ? mapLimit(gmailMailboxes, 3, async (mailbox) => {
            const key = apiKeyByConnId.get(mailbox.connectionId) || dgKey;
            const result = await fetchRecentEmails(
              key,
              mailbox.connectionId,
              maxEmails,
              mailbox.mailboxLabel
            );
            return {
              mailbox,
              datagranApiKey: key,
              result,
            };
          })
        : Promise.resolve(
            [] as Array<{
              mailbox: { connectionId: string; mailboxLabel: string };
              datagranApiKey: string;
              result: typeof noEmailResult;
            }>
          ),
      shouldFetchCalendar
        ? mapLimit(calendarCalendars, 3, async (calendar) => {
            const key = apiKeyByConnId.get(calendar.connectionId) || dgKey;
            const result = await fetchUpcomingEvents(key, calendar.connectionId, maxEvents);
            return {
              calendar,
              result,
            };
          })
        : Promise.resolve(
            [] as Array<{
              calendar: { connectionId: string; calendarLabel: string };
              result: typeof noCalendarResult;
            }>
          ),
      shouldFetchWebPixels
        ? scanWebPixelsDaily({ conns: webPixelConns, maxPixels: maxWebPixels })
        : Promise.resolve({ summary: "", scanned: 0, total: webPixelSites.length, notable: 0, okCount: 0, errorCount: 0 }),
    ]);

    if (shouldFetchGmail) {
      gmailMailboxContexts = emailResultsByMailbox.map((m) => ({
        connectionId: m.mailbox.connectionId,
        mailboxLabel: m.mailbox.mailboxLabel,
        datagranApiKey: m.datagranApiKey,
      }));

      const summaryBlocks: string[] = [];
      const mergedIds: string[] = [];
      const mergedItems: typeof currentEmailItems = [];
      let gmailNeedsReauth = false;
      for (const mailboxResult of emailResultsByMailbox) {
        const mailbox = mailboxResult.mailbox;
        const res = mailboxResult.result || noEmailResult;
        if (res.needsReauth) gmailNeedsReauth = true;
        const blockText = res.text && res.text.trim() ? res.text.trim() : "(no recent emails)";
        summaryBlocks.push(`${mailbox.mailboxLabel}:\n${blockText}`);
        for (const id of res.ids || []) {
          mergedIds.push(`${mailbox.connectionId}:${id}`);
        }
        for (const item of res.items || []) {
          const prefixedId = `${mailbox.connectionId}:${item.id}`;
          mergedItems.push({
            id: item.id,
            prefixedId,
            connectionId: mailbox.connectionId,
            mailboxLabel: mailbox.mailboxLabel,
            threadId: item.threadId || "",
            from: item.from,
            to: item.to,
            cc: item.cc,
            subject: item.subject,
            date: item.date,
            snippet: item.snippet,
            listUnsubscribe: item.listUnsubscribe,
            messageIdHeader: item.messageIdHeader,
            line: item.line,
          });
          triageEmailItems.push({
            connectionId: mailbox.connectionId,
            mailboxLabel: mailbox.mailboxLabel,
            id: item.id,
            threadId: item.threadId || "",
            from: item.from,
            to: item.to,
            cc: item.cc,
            subject: item.subject,
            date: item.date,
            snippet: item.snippet,
            listUnsubscribe: item.listUnsubscribe,
            messageIdHeader: item.messageIdHeader,
          });
        }
      }
      emailSummary = summaryBlocks.length > 0 ? summaryBlocks.join("\n\n") : "(no recent emails)";
      currentEmailIds = mergedIds;
      currentEmailItems = mergedItems;
      if (gmailNeedsReauth) reauthNeeded.push("gmail");
    } else if (hasGmail) {
      emailSummary = "(fetched earlier today — see MEMORY_CONTEXT)";
    }

    if (shouldFetchCalendar) {
      const summaryBlocks: string[] = [];
      const mergedKeys: string[] = [];
      const mergedEvents: typeof currentCalendarEvents = [];
      let calendarNeedsReauth = false;
      for (const calendarResult of calendarResultsByConnection) {
        const calendar = calendarResult.calendar;
        const res = calendarResult.result || noCalendarResult;
        if (res.needsReauth) calendarNeedsReauth = true;
        const blockText = res.text && res.text.trim() ? res.text.trim() : "(no upcoming events)";
        summaryBlocks.push(`${calendar.calendarLabel}:\n${blockText}`);
        for (const key of res.keys || []) {
          mergedKeys.push(`${calendar.connectionId}:${key}`);
        }
        for (const ev of res.events || []) {
          const window = `${ev.start}${ev.end ? ` to ${ev.end}` : ""}`;
          mergedEvents.push({
            ...ev,
            key: `${calendar.connectionId}:${ev.key}`,
            line: `${calendar.calendarLabel}: ${ev.summary} @ ${window}`,
          });
        }
      }
      calendarSummary = summaryBlocks.length > 0 ? summaryBlocks.join("\n\n") : "(no upcoming events)";
      currentCalendarKeys = mergedKeys;
      currentCalendarEvents = mergedEvents;
      if (calendarNeedsReauth) reauthNeeded.push("google_calendar");
    } else if (hasCalendar) {
      calendarSummary = "(fetched earlier today — see MEMORY_CONTEXT)";
    }

    if (shouldFetchWebPixels) {
      webPixelSummary = webPixelScan.summary;
    } else if (hasWebPixels) {
      if (hasCurrentWebPixelSignals(cachedWebPixelSummary)) {
        webPixelSummary = `${cachedWebPixelSummary}\n(cached from previous scan)`;
      } else {
        webPixelSummary = "(scanned earlier today — see MEMORY_CONTEXT)";
      }
    }

    console.log("[heartbeat] integrations fetched", {
      hasGmail,
      hasCalendar,
      hasWebPixels,
      emailLen: emailSummary.length,
      emailItems: currentEmailItems.length,
      calendarLen: calendarSummary.length,
      webPixels: {
        scanned: webPixelScan.scanned,
        total: webPixelScan.total,
        notable: webPixelScan.notable,
        ok: webPixelScan.okCount,
        errors: webPixelScan.errorCount,
        chars: webPixelSummary.length,
      },
      reauthNeeded,
    });

    let didUpdateIntegrationMemoryFingerprint = false;

    // Store integration data to memory so future heartbeats (within the day) can use it.
    // IMPORTANT: do this even if some providers need reauth so we don't waste scans (e.g. web pixels).
    const memConnId = await getGroovyMemoryConnection(
      userId,
      userEmail || undefined,
      supabase
    );
    if (memConnId) {
      const todayStr = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      const memParts: string[] = [];
      const isStalePlaceholder = (s: string) =>
        /(see\s+memory_context|fetched earlier today|last fetched|could not fetch)/i.test(s);
      if (
        calendarSummary &&
        !calendarSummary.includes("(no upcoming events)") &&
        !calendarSummary.includes("(could not fetch") &&
        !isStalePlaceholder(calendarSummary)
      ) {
        memParts.push(`Calendar events for ${todayStr}:\n${calendarSummary}`);
      }
      if (
        emailSummary &&
        !emailSummary.includes("(no recent emails)") &&
        !emailSummary.includes("(could not fetch") &&
        !isStalePlaceholder(emailSummary)
      ) {
        memParts.push(`Recent emails as of ${todayStr}:\n${emailSummary}`);
      }
      if (hasCurrentWebPixelSignals(webPixelSummary)) {
        memParts.push(`Web pixel signals as of ${todayStr} (last 24h):\n${webPixelSummary}`);
      }
      if (memParts.length > 0) {
        const memText = memParts.join("\n\n").trim();
        const memLabel = `Daily integrations snapshot (${todayStr})`;
        const memHash = stableHash(compressWhitespace(memText).toLowerCase());
        const prevHash =
          typeof dbTaskConfig.last_integration_memory_hash === "number"
            ? dbTaskConfig.last_integration_memory_hash
            : null;
        // Compare by content hash only — label changes daily but content may be identical
        // (e.g., same calendar events span midnight).
        const shouldStore = prevHash === null || prevHash !== memHash;

        if (shouldStore) {
          await storeMemoryNote(memConnId, memText, memLabel).catch(() => {});
          dbTaskConfig = { ...dbTaskConfig, last_integration_memory_label: memLabel, last_integration_memory_hash: memHash };
          didUpdateIntegrationMemoryFingerprint = true;
          console.log("[heartbeat] stored integration snapshot to memory");
        } else {
          console.log("[heartbeat] integration snapshot unchanged; skipping memory store");
        }
      }
    }

    // Persist per-provider timestamps so we don't refetch successful providers just because another needs reauth.
    const nowIso = new Date().toISOString();
    const nextFetchState: IntegrationsFetchState = { ...fetchState };
    let didUpdateFetchState = false;
    let nextCachedWebPixelSummary = cachedWebPixelSummary;
    let didUpdateCachedWebPixelSummary = false;
    const gmailHadReauth = emailResultsByMailbox.some((m) => m.result?.needsReauth);
    const calendarHadReauth = calendarResultsByConnection.some((c) => c.result?.needsReauth);

    if (shouldFetchGmail && !gmailHadReauth) {
      nextFetchState.gmail = nowIso;
      didUpdateFetchState = true;
    }
    if (shouldFetchCalendar && !calendarHadReauth) {
      nextFetchState.google_calendar = nowIso;
      didUpdateFetchState = true;
    }
    if (shouldFetchWebPixels && webPixelScan.okCount > 0) {
      nextFetchState.web_pixel = nowIso;
      didUpdateFetchState = true;
      if (hasCurrentWebPixelSignals(webPixelScan.summary)) {
        nextCachedWebPixelSummary = webPixelScan.summary.trim();
        didUpdateCachedWebPixelSummary = true;
      } else {
        // Important: clear stale cached summary when a fresh scan finds nothing notable,
        // otherwise we keep repeating old spikes forever.
        nextCachedWebPixelSummary = "";
        didUpdateCachedWebPixelSummary = true;
      }
    }

    if (jobId && (didUpdateFetchState || didUpdateCachedWebPixelSummary || didUpdateIntegrationMemoryFingerprint)) {
      try {
        const updatedTask: HeartbeatTaskConfig = {
          ...dbTaskConfig,
          ...(didUpdateFetchState ? { last_integrations_fetch: nextFetchState } : {}),
          ...(didUpdateCachedWebPixelSummary ? { last_web_pixel_summary: nextCachedWebPixelSummary } : {}),
        };
        dbTaskConfig = updatedTask;
        const { error } = await supabase
          .from("scheduled_jobs")
          .update({ task: updatedTask, updated_at: new Date().toISOString() })
          .eq("id", jobId);
        if (error) throw new Error(error.message);
      } catch {
        /* best-effort */
      }
    }

    // Generate reauth links if needed, but do not let this override the whole
    // heartbeat. Reconnect notices are appended on a cooldown below.
    if (reauthNeeded.length > 0) {
      const reauthEntries: Array<{ provider: string; label: string; url: string }> = [];
      for (const provider of reauthNeeded) {
        const url = await generateReauthUrl(dgKey, userId, userEmail || undefined, provider);
        if (url) {
          const label = provider === "gmail" ? "Gmail" : "Google Calendar";
          reauthEntries.push({ provider, label, url });
        }
      }
      if (reauthEntries.length > 0) {
        integrationReauthEntries = reauthEntries;
        const warningDecision = shouldSurfaceIntegrationReauthWarning({
          taskConfig: dbTaskConfig,
          entries: reauthEntries,
          nowMs: now.getTime(),
        });
        integrationReauthWarningHash = warningDecision.fingerprint;
        integrationReauthWarningReason = warningDecision.reason;
        shouldAppendIntegrationReauthWarning = warningDecision.shouldSurface;
        integrationReauthWarningText = warningDecision.shouldSurface
          ? buildIntegrationReauthWarningText(reauthEntries)
          : "";
        console.log("[heartbeat] integration reauth warning decision", {
          providers: reauthEntries.map((entry) => entry.provider),
          shouldSurface: warningDecision.shouldSurface,
          reason: warningDecision.reason,
        });
      }
    }
  }

  // 3b. Inbox triage + action queue (multi-mailbox).
  // This is the heartbeat's email decision engine:
  // - score each incoming email
  // - create drafts/actions
  // - auto-execute high-confidence low-risk actions
  if (shouldFetchGmail && triageEmailItems.length > 0 && gmailMailboxContexts.length > 0) {
    try {
      inboxTriageResult = await runInboxTriageForHeartbeat({
        supabase,
        userId,
        agentId: heartbeatAgentId,
        sessionId:
          typeof taskConfig.orchestrator_session_id === "string" && taskConfig.orchestrator_session_id.trim()
            ? taskConfig.orchestrator_session_id.trim()
            : null,
        sourceJobId: jobId || null,
        userEmail,
        policyModel: {
          provider: keyInfo.provider,
          modelName: selectedModelName,
          apiKey: keyInfo.apiKey,
        },
        memoryContext,
        preferenceContext,
        mailboxes: gmailMailboxContexts,
        emails: triageEmailItems,
      });
      console.log("[heartbeat] inbox triage", {
        pending: inboxTriageResult.pendingCount,
        autoExecuted: inboxTriageResult.autoExecutedCount,
        critical: inboxTriageResult.criticalCount,
      });
    } catch (e) {
      console.warn("[heartbeat] inbox triage failed:", e);
    }
  }
  try {
    inboxActionsPromptContext = await buildInboxActionPromptContext({
      supabase,
      userId,
      lookbackDays: 7,
      maxRows: 80,
    });
    if (inboxTriageResult?.notes?.length) {
      const noteLines = inboxTriageResult.notes
        .map((n) => clipHeartbeatText(n, 180))
        .filter(Boolean)
        .slice(0, 4)
        .map((n) => `- ${n}`);
      if (noteLines.length > 0) {
        inboxActionsPromptContext.summary = [
          inboxActionsPromptContext.summary,
          "This run outcomes:",
          ...noteLines,
        ]
          .filter(Boolean)
          .join("\n");
      }
    }
  } catch (e) {
    console.warn("[heartbeat] inbox action prompt context failed:", e);
  }

  // 4. Upready readiness (direct DB integration)
  try {
    const readiness = await getUpreadyReadinessForFlowUser({
      supabase,
      flowUserId: userId,
      days: 30,
      limit: 35,
    });
    hasUpreadyReadiness = readiness.connected;
    upreadyPoints = Array.isArray(readiness.points) ? readiness.points : [];
    upreadySummary = readiness.summary;
    upreadyLatestPointId =
      readiness.connected && Array.isArray(readiness.points) && readiness.points.length > 0
        ? readiness.points[0].id
        : null;
    if (readiness.connected) {
      const todayLocalDate = formatDateKeyInTimezone(now, tz);
      const latestLocalDate =
        Array.isArray(readiness.points) && readiness.points.length > 0
          ? formatDateKeyInTimezone(readiness.points[0].measuredAt, tz)
          : null;
      if (localCtx.hour24 < 9) {
        const availabilityNote =
          latestLocalDate && todayLocalDate && latestLocalDate === todayLocalDate
            ? "Today's Upready daily score is already available (publish window starts after 09:00 local time)."
            : `Today's Upready daily score is published after 09:00 local time (${tz}); before 09:00 it's expected that the latest available reading may still be from ${latestLocalDate || "the prior day"}.`;
        upreadySummary = `${upreadySummary}\n${availabilityNote}`.trim();
      } else if (todayLocalDate && latestLocalDate && latestLocalDate !== todayLocalDate) {
        upreadySummary = `${upreadySummary}\nNote: local time is after 09:00 (${tz}), but the latest Upready daily reading is still ${latestLocalDate}.`.trim();
      }
    }
    console.log("[heartbeat] upready readiness", {
      connected: readiness.connected,
      points: readiness.points.length,
      upreadyUserId: readiness.upreadyUserId,
    });
  } catch (e) {
    console.warn("[heartbeat] upready readiness fetch failed:", e);
  }

  // 4b. Suppress repeats: if calendar/mail/pixel/readiness inputs haven't changed since the last SENT
  // heartbeat, skip entirely. (The LLM is not reliable enough at self-skipping.)
  const prevSentAtIso =
    typeof dbTaskConfig.last_heartbeat_sent_at === "string" ? dbTaskConfig.last_heartbeat_sent_at.trim() : "";
  const hasPrevSent = Boolean(prevSentAtIso);
  const nowMs = now.getTime();
  const prevSentAtMs = hasPrevSent ? isoToMs(prevSentAtIso) : null;
  const prevEmailIds = asStringArray(dbTaskConfig.last_heartbeat_email_ids);
  const prevCalendarKeys = asStringArray(dbTaskConfig.last_heartbeat_calendar_keys);
  const prevWebPixelHash =
    typeof dbTaskConfig.last_heartbeat_web_pixel_hash === "number" ? dbTaskConfig.last_heartbeat_web_pixel_hash : null;
  const prevUpreadyLatestPointId =
    typeof dbTaskConfig.last_heartbeat_upready_latest_point_id === "string"
      ? dbTaskConfig.last_heartbeat_upready_latest_point_id.trim()
      : "";

  // If we didn't fetch this run, don't accidentally "change" to empty.
  if (hasGmail && currentEmailIds.length === 0 && /(fetched earlier today|last fetched|see memory_context)/i.test(emailSummary)) {
    currentEmailIds = prevEmailIds;
  }
  if (hasCalendar && currentCalendarKeys.length === 0 && /(fetched earlier today|last fetched|see memory_context)/i.test(calendarSummary)) {
    currentCalendarKeys = prevCalendarKeys;
  }

  const prevEmailSet = new Set(prevEmailIds);
  const prevCalSet = new Set(prevCalendarKeys);
  const curCalSet = new Set(currentCalendarKeys);

  const emailNewIds = hasPrevSent ? currentEmailIds.filter((id) => !prevEmailSet.has(id)) : currentEmailIds;
  const calAddedKeys = hasPrevSent ? currentCalendarKeys.filter((k) => !prevCalSet.has(k)) : currentCalendarKeys;
  const calRemovedKeys = hasPrevSent ? prevCalendarKeys.filter((k) => !curCalSet.has(k)) : [];
  const calendarChanged =
    !hasPrevSent ? currentCalendarKeys.length > 0 : calAddedKeys.length > 0 || calRemovedKeys.length > 0;

  const curWebPixelHash = signalHash(webPixelSummary);
  const webPixelChanged =
    !hasPrevSent ? curWebPixelHash !== null : curWebPixelHash !== null && curWebPixelHash !== prevWebPixelHash;

  const calendarImminentWindowMin = 120;
  const calendarImminentLines = pickCalendarEventLinesStartingWithinMinutes(
    currentCalendarEvents,
    nowMs,
    calendarImminentWindowMin,
    3
  );
  const calendarImminent = calendarImminentLines.length > 0;

  const webPixelNotable = hasWebPixels && hasCurrentWebPixelSignals(webPixelSummary);
  const WEB_PIXEL_REPEAT_COOLDOWN_MS = 12 * 60 * 60_000;
  const webPixelRepeatDue =
    webPixelNotable && !!prevSentAtMs && nowMs - (prevSentAtMs || 0) >= WEB_PIXEL_REPEAT_COOLDOWN_MS;
  const webPixelShouldMention = webPixelChanged || webPixelRepeatDue;

  const curUpreadyId = upreadyLatestPointId ? upreadyLatestPointId.trim() : "";
  const upreadyChanged =
    !hasPrevSent ? Boolean(curUpreadyId) : Boolean(curUpreadyId) && curUpreadyId !== prevUpreadyLatestPointId;
  const inboxChanged =
    !!inboxTriageResult &&
    (inboxTriageResult.pendingCount > 0 || inboxTriageResult.autoExecutedCount > 0);

  const prevMemoryTodayHash =
    typeof dbTaskConfig.last_heartbeat_memory_today_hash === "number"
      ? dbTaskConfig.last_heartbeat_memory_today_hash
      : null;
  const memoryTodayChanged =
    memoryTodayHash !== null && (prevMemoryTodayHash === null || prevMemoryTodayHash !== memoryTodayHash);

  const hasAnyChange =
    !hasPrevSent ||
    emailNewIds.length > 0 ||
    calendarChanged ||
    calendarImminent ||
    webPixelShouldMention ||
    upreadyChanged ||
    inboxChanged ||
    memoryTodayChanged;
  const wellbeingSignal = hasUpreadyReadiness
    ? buildUpreadyWellbeingSignal(upreadyPoints)
    : buildMemoryWellbeingSignal(memoryContext);

  const prevWellbeingCheckinAtIso =
    typeof dbTaskConfig.last_wellbeing_checkin_at === "string"
      ? dbTaskConfig.last_wellbeing_checkin_at.trim()
      : "";
  const prevWellbeingCheckinAtMs = prevWellbeingCheckinAtIso ? isoToMs(prevWellbeingCheckinAtIso) : null;
  const prevWellbeingSignalHash =
    typeof dbTaskConfig.last_wellbeing_signal_hash === "number" ? dbTaskConfig.last_wellbeing_signal_hash : null;
  const sameSignalAsLastCheckIn =
    wellbeingSignal.triggered &&
    wellbeingSignal.signalHash !== null &&
    prevWellbeingSignalHash !== null &&
    wellbeingSignal.signalHash === prevWellbeingSignalHash;
  const wellbeingHoursSinceLastCheckin =
    prevWellbeingCheckinAtMs !== null ? Math.max(0, (nowMs - prevWellbeingCheckinAtMs) / 3_600_000) : null;
  const wellbeingContextForPrompt = buildWellbeingContextForPrompt({
    hasUpreadyReadiness,
    signal: wellbeingSignal,
    lastCheckinAtIso: prevWellbeingCheckinAtIso || null,
    hoursSinceLastCheckin: wellbeingHoursSinceLastCheckin,
    sameSignalAsLastCheckin: sameSignalAsLastCheckIn,
  });
  let webResearchSummary = "";

  if (agenticResearchEnabled && (agenticMemoryFollowupsMax > 0 || agenticWebQueriesMax > 0)) {
    try {
      const planningModel = resolveChatModel(
        keyInfo.provider,
        selectedModelName,
        keyInfo.apiKey ? { apiKey: keyInfo.apiKey } : undefined
      );
      const planningProviderOptions = getAnthropicContextProviderOptions(
        keyInfo.provider,
        selectedModelName
      );
      const planningResult = await generateText({
        model: planningModel,
        providerOptions: planningProviderOptions,
        system: `You are a research planner for an hourly heartbeat.
Return ONLY valid JSON with this exact shape:
{
  "memory_questions": string[],
  "web_search_queries": string[]
}

Rules:
- Choose at most ${agenticMemoryFollowupsMax} memory_questions and ${agenticWebQueriesMax} web_search_queries.
- Use empty arrays when no extra research is needed.
- memory_questions must be specific, not generic, and must add new context.
- web_search_queries must be precise factual lookups that can improve the next heartbeat.
- Never ask for data already present in the provided sections.
- No explanations, no markdown, no extra keys.`,
        prompt: `Already asked memory questions:
${Array.from(askedMemoryQuestionKeys).slice(0, 20).join("\n") || "(none)"}

MEMORY_CONTEXT (truncated):
${memoryContext ? memoryContext.slice(0, 8_000) : "(none)"}

RECENT_EMAILS:
${emailSummary || "(none)"}

UPCOMING_CALENDAR_EVENTS:
${calendarSummary || "(none)"}

WEB_PIXEL_SIGNALS:
${webPixelSummary || "(none)"}

UPREADY_READINESS:
${upreadySummary || "(none)"}

WELLBEING_CONTEXT:
${wellbeingContextForPrompt || "(none)"}

CURRENT_SCHEDULED_TASKS:
${scheduledTasksSummary || "(none)"}

RECENT_HEARTBEAT_EXAMPLES:
${recentHeartbeatSnippets || "(none)"}`,
      });
      void recordHeartbeatUsage({
        spanId: "agentic_research_planner",
        usage: (planningResult as unknown as { usage?: unknown }).usage,
        meta: { phase: "agentic_research_planning" },
      });

      const plan = parseAgenticResearchPlan(planningResult.text || "", {
        maxMemoryQuestions: agenticMemoryFollowupsMax,
        maxWebQueries: agenticWebQueriesMax,
      });

      const memoryQuestions = plan.memoryQuestions.filter((q) => {
        const key = normalizeQuestionKey(q);
        return key && !askedMemoryQuestionKeys.has(key);
      });

      if (memoryQuestions.length > 0 && memoryConnectionId) {
        const extraMemoryResults = await Promise.all(
          memoryQuestions.map((q) => queryMemoryDirect(memoryConnectionId as string, q).catch(() => ({ context: "", data: null })))
        );
        const memoryExtraParts: string[] = [];
        let memoryExtraChars = 0;
        const MAX_AGENTIC_MEMORY_APPEND_CHARS = 120_000;
        for (let i = 0; i < extraMemoryResults.length; i++) {
          const q = memoryQuestions[i];
          const ctx = extraMemoryResults[i]?.context?.trim();
          if (!ctx) continue;
          const remaining = MAX_AGENTIC_MEMORY_APPEND_CHARS - memoryExtraChars;
          if (remaining <= 0) break;
          const safeCtx = ctx.length > remaining ? ctx.slice(0, remaining) : ctx;
          memoryExtraParts.push(`[Agentic follow-up: ${q.replace(/[?]+$/, "")}?]\n${safeCtx}`);
          memoryExtraChars += safeCtx.length;
          askedMemoryQuestionKeys.add(normalizeQuestionKey(q));
          if (safeCtx.length < ctx.length) break;
        }
        if (memoryExtraParts.length > 0) {
          memoryContext = [memoryContext, ...memoryExtraParts].filter(Boolean).join("\n\n");
          console.log("[heartbeat] agentic memory research appended", {
            questions: memoryQuestions.length,
            appendedBlocks: memoryExtraParts.length,
            appendedChars: memoryExtraChars,
          });
        }
      }

      if (plan.webQueries.length > 0) {
        const webResults = await mapLimit(plan.webQueries, 2, async (query) => {
          const lookup = await runDuckDuckGoInstantLookup(query);
          return { query, ...lookup };
        });
        const webLines = webResults
          .filter((r) => r.ok && r.summary)
          .map((r) => `- ${r.query}: ${r.summary}`);
        const failedWebResults = webResults.filter((r) => !r.ok || !r.summary);
        const failedWebLines = failedWebResults
          .slice(0, 4)
          .map((r) => `- ${r.query}: ${clipHeartbeatText(r.error || "lookup_failed", 140)}`);
        if (webLines.length > 0) {
          webResearchSummary = webLines.join("\n");
          if (failedWebLines.length > 0) {
            webResearchSummary = `${webResearchSummary}\nWeb lookups that failed:\n${failedWebLines.join("\n")}`;
          }
        } else if (failedWebLines.length > 0) {
          webResearchSummary = `Web lookups attempted but none succeeded:\n${failedWebLines.join("\n")}`;
        }
        console.log("[heartbeat] agentic web research", {
          plannedQueries: plan.webQueries.length,
          successfulQueries: webLines.length,
          failedQueries: failedWebResults.length,
          failedExamples: failedWebResults
            .slice(0, 3)
            .map((r) => `${r.query} -> ${clipHeartbeatText(r.error || "lookup_failed", 80)}`),
        });
      }
    } catch (e) {
      console.warn("[heartbeat] agentic research pass failed:", e);
    }
  }

  if (hasPrevSent && !hasAnyChange && !forceSend) {
    console.log("[heartbeat] no deterministic delta detected; model still decides send/skip", {
      gmailNew: emailNewIds.length,
      calendarChanged,
      calendarImminent,
      webPixelChanged,
      webPixelRepeatDue,
      memoryTodayChanged,
      upreadyChanged,
      wellbeingSignal: wellbeingSignal.triggered ? wellbeingSignal.reason : "none",
    });
  }

  // Pass full, fresh context to the model. We only append an explicit imminent-events
  // section so near-term meetings are easy to spot.
  const emailSummaryForPrompt = emailSummary || "(no recent emails)";
  let calendarSummaryForPrompt = calendarSummary || "(no calendar events this week)";
  const webPixelSummaryForPrompt = webPixelSummary || "(no web pixel activity available)";
  const upreadySummaryForPrompt = upreadySummary || "(not connected)";
  if (calendarImminent && calendarImminentLines.length > 0) {
    const imminentBlock = `Imminent events (next ${calendarImminentWindowMin}m):\n${calendarImminentLines.join("\n")}`.trim();
    calendarSummaryForPrompt = `${calendarSummaryForPrompt}\n\n${imminentBlock}`.trim();
  }

  const noveltyContext = `RUN_SIGNAL_HINTS:
gmail_new_emails=${emailNewIds.length}
calendar_changed=${calendarChanged}
calendar_imminent=${calendarImminent}
web_pixel_changed=${webPixelChanged}
web_pixel_repeat_due=${webPixelRepeatDue}
memory_today_changed=${memoryTodayChanged}
upready_changed=${upreadyChanged}
web_research_notes_present=${webResearchSummary ? "true" : "false"}
inbox_actions_pending=${inboxActionsPromptContext.pendingCount}
inbox_actions_done=${inboxActionsPromptContext.doneCount}
inbox_actions_failed=${inboxActionsPromptContext.failedCount}
wellbeing_signal_triggered=${wellbeingSignal.triggered}
wellbeing_signal_source=${wellbeingSignal.source}
wellbeing_last_checkin_hours_ago=${
  wellbeingHoursSinceLastCheckin === null ? "never" : wellbeingHoursSinceLastCheckin.toFixed(1)
}
wellbeing_same_signal_as_last_checkin=${sameSignalAsLastCheckIn}
${wellbeingSignal.triggered && wellbeingSignal.reason ? `wellbeing_signal_reason=${wellbeingSignal.reason}` : ""}
These are hints, not hard constraints. Use the full context above and decide what is worth sending.`;

  const preferenceConstraintsForHeartbeat = formatPreferenceForPrompt(preferenceContext, {
    channel: "heartbeat",
  }).trim();
  const preferenceGateBlock =
    preferenceConstraintsForHeartbeat ||
    "## USER PREFERENCES (HIGHEST PRIORITY)\nNo explicit preference constraints were retrieved for this run.";

  // 5. Generate digest with Haiku
  const styleVariant = pickHeartbeatStyleVariant(`${userId}|${now.toISOString()}`);

  const systemPrompt = buildHeartbeatPrompt({
    nowIso: now.toISOString(),
    localTime,
    timezone: tz,
    localTimeContext,
    memoryContext,
    preferenceContext,
    wellbeingContext: wellbeingContextForPrompt,
    scheduledTasksSummary,
    recentHeartbeatSnippets,
    styleVariant,
    emailSummary: emailSummaryForPrompt,
    inboxActionsSummary: inboxActionsPromptContext.summary,
    calendarSummary: calendarSummaryForPrompt,
    webPixelSummary: webPixelSummaryForPrompt,
    upreadySummary: upreadySummaryForPrompt,
    hasGmail,
    hasCalendar,
    hasWebPixels,
    hasUpreadyReadiness,
    webResearchSummary,
    forceSend,
  }) + `\n\n${noveltyContext}\n`;

  let activeModel = resolveChatModel(
    keyInfo.provider,
    selectedModelName,
    keyInfo.apiKey ? { apiKey: keyInfo.apiKey } : undefined
  );
  const heartbeatReasoningProviderOptions = getAnthropicReasoningProviderOptions(
    keyInfo.provider,
    selectedModelName,
    { enableThinking: true }
  );

  let text = "";
  try {
    const result = await generateText({
      model: activeModel,
      system: systemPrompt,
      prompt: "Generate the check-in now.",
      providerOptions: heartbeatReasoningProviderOptions,
    });
    void recordHeartbeatUsage({
      spanId: "main",
      usage: (result as unknown as { usage?: unknown }).usage,
      meta: { phase: "main_generation" },
    });
    text = (result.text || "").trim();
  } catch (e) {
    const usedUserKey = Boolean(keyInfo.apiKey);
    if (usedUserKey && isInvalidApiKeyError(e)) {
      if (hasServerProviderKey(keyInfo.provider)) {
        console.warn("[heartbeat] user's API key is invalid/expired; retrying heartbeat with Groovy server key", {
          provider: keyInfo.provider,
          modelName: selectedModelName,
        });
        try {
          activeModel = resolveChatModel(keyInfo.provider, selectedModelName);
          const fallbackResult = await generateText({
            model: activeModel,
            system: systemPrompt,
            prompt: "Generate the check-in now.",
            providerOptions: heartbeatReasoningProviderOptions,
          });
          void recordHeartbeatUsage({
            spanId: "main_fallback_server_key",
            usage: (fallbackResult as unknown as { usage?: unknown }).usage,
            billable: true,
            chargeType: "groovy_key",
            meta: { phase: "main_generation_fallback" },
          });
          text = (fallbackResult.text || "").trim();
        } catch (fallbackErr) {
          console.error("[heartbeat] Groovy key fallback failed:", fallbackErr);
          return {
            ok: false,
            text: "",
            sessionId: null,
            sendWhatsApp: false,
            sendTelegram: false,
            error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          };
        }
      } else {
        console.error("[heartbeat] LLM call failed — user's API key is invalid/expired", {
          provider: keyInfo.provider,
          modelName: selectedModelName,
        });
        return {
          ok: false,
          text: "",
          sessionId: null,
          sendWhatsApp: false,
          sendTelegram: false,
          error: "invalid_user_api_key",
        };
      }
    } else {
      console.error("[heartbeat] LLM call failed:", e);
      return { ok: false, text: "", sessionId: null, sendWhatsApp: false, sendTelegram: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (!text) {
    return { ok: false, text: "", sessionId: null, sendWhatsApp: false, sendTelegram: false, error: "empty_response" };
  }

  // Preference compliance pass (AI-driven): validate draft against constraints, then
  // regenerate once if needed.
  if (preferenceConstraintsForHeartbeat && !text.startsWith("__SKIP__")) {
    try {
      const complianceResult = await generateText({
        model: activeModel,
        system: buildPreferenceComplianceCheckerPrompt(),
        prompt: `USER_PREFERENCES:
${preferenceGateBlock}

DRAFT:
${text}`,
      });
      void recordHeartbeatUsage({
        spanId: "preference_compliance_check",
        usage: (complianceResult as unknown as { usage?: unknown }).usage,
        meta: { phase: "preference_compliance_check" },
      });

      const complianceCheck = parsePreferenceComplianceResult(complianceResult.text || "");
      if (!complianceCheck.compliant) {
        console.warn("[heartbeat] preference compliance violation detected; regenerating draft", {
          reason: complianceCheck.reason,
        });
        const regeneratedForCompliance = await generateText({
          model: activeModel,
          system: `${systemPrompt}

CRITICAL OVERRIDE: The previous draft violated USER_PREFERENCES.
- USER_PREFERENCES remain highest priority over all other instructions.
- Remove all conflicting mentions.
- If nothing compliant remains, output __SKIP__.`,
          prompt: `Previous non-compliant draft:
${text}

Regenerate a fully compliant check-in now.`,
        });
        void recordHeartbeatUsage({
          spanId: "preference_compliance_regen",
          usage: (regeneratedForCompliance as unknown as { usage?: unknown }).usage,
          meta: { phase: "preference_compliance_regeneration", reason: complianceCheck.reason },
        });

        const regeneratedText = (regeneratedForCompliance.text || "").trim();
        if (regeneratedText) {
          text = regeneratedText;
        }

        if (!text.startsWith("__SKIP__")) {
          const recheckResult = await generateText({
            model: activeModel,
            system: buildPreferenceComplianceCheckerPrompt(),
            prompt: `USER_PREFERENCES:
${preferenceGateBlock}

DRAFT:
${text}`,
          });
          void recordHeartbeatUsage({
            spanId: "preference_compliance_recheck",
            usage: (recheckResult as unknown as { usage?: unknown }).usage,
            meta: { phase: "preference_compliance_recheck" },
          });

          const recheck = parsePreferenceComplianceResult(recheckResult.text || "");
          if (!recheck.compliant) {
            console.warn("[heartbeat] preference compliance recheck failed; forcing __SKIP__", {
              reason: recheck.reason,
            });
            text = "__SKIP__";
          }
        }
      }
    } catch (e) {
      console.warn("[heartbeat] preference compliance pass failed:", e);
    }
  }

  // 5b. If the model decided there's nothing noteworthy, skip silently.
  //     During late_night (midnight–5 AM), respect the skip unconditionally — no gate override.
  const inboxPendingCount = inboxTriageResult?.pendingCount || 0;
  const inboxAutoExecutedCount = inboxTriageResult?.autoExecutedCount || 0;
  const inboxCriticalCount = inboxTriageResult?.criticalCount || 0;
  let inboxDisplayedPendingCount = inboxPendingCount;
  const inboxRequiresHeartbeat = inboxPendingCount > 0 || inboxAutoExecutedCount > 0;
  const emailCleanupUrgencyBypass = inboxCleanupUrgencyBypassEnabled && inboxCriticalCount > 0;
  let intentionalEmailCleanupHistory: IntentionalEmailCleanupHeartbeatHistory = {
    lookupOk: false,
    sentTodayCount: 0,
    todayLocalTimes: [],
    recentLocalDateTimes: [],
    lastSentAtIso: null,
  };
  if (inboxRequiresHeartbeat && inboxCleanupHeartbeatsPerDayMax > 0) {
    try {
      intentionalEmailCleanupHistory = await loadIntentionalEmailCleanupHeartbeatHistory({
        supabase,
        userId,
        timezone: tz,
        now,
      });
    } catch (e) {
      console.warn("[heartbeat] intentional email cleanup count failed:", e);
    }
  }
  const intentionalEmailCleanupHistoryLookupOk = intentionalEmailCleanupHistory.lookupOk;
  const intentionalEmailCleanupHeartbeatsSentToday = intentionalEmailCleanupHistory.sentTodayCount;
  const intentionalEmailCleanupSlotsRemaining = Math.max(
    0,
    (intentionalEmailCleanupHistoryLookupOk
      ? inboxCleanupHeartbeatsPerDayMax - intentionalEmailCleanupHeartbeatsSentToday
      : 0)
  );
  const emailCleanupCapAllows =
    intentionalEmailCleanupSlotsRemaining > 0 || emailCleanupUrgencyBypass;
  const todayCleanupHeartbeatTimes =
    intentionalEmailCleanupHistory.todayLocalTimes.length > 0
      ? intentionalEmailCleanupHistory.todayLocalTimes.join(", ")
      : "(none)";
  const recentCleanupHeartbeatLines =
    intentionalEmailCleanupHistory.recentLocalDateTimes.length > 0
      ? intentionalEmailCleanupHistory.recentLocalDateTimes.map((line) => `- ${line}`).join("\n")
      : "(none)";
  const lastCleanupHeartbeatLocal = intentionalEmailCleanupHistory.lastSentAtIso
    ? formatLocalDateTimeForPrompt(intentionalEmailCleanupHistory.lastSentAtIso, tz)
    : "(none)";
  let emailCleanupDecision: EmailCleanupHeartbeatDecision = {
    shouldSend: false,
    reason: "not_evaluated",
    opener: "",
  };
  if (inboxRequiresHeartbeat && emailCleanupCapAllows) {
    try {
      const decision = await generateText({
        model: activeModel,
        providerOptions: heartbeatReasoningProviderOptions,
        system: `You are a strict gate for heartbeat inbox-cleanup nudges.
Return ONLY valid JSON with this exact shape:
{
  "send_email_cleanup_heartbeat": boolean,
  "reason": string,
  "opener": string
}

Rules:
- USER_PREFERENCES are highest priority.
- send_email_cleanup_heartbeat=true only when this is a good moment for an intentional email cleanup nudge.
- Respect daily slot limit: if slots_remaining <= 0, return false unless urgency_bypass=true.
- Prefer false when this would feel repetitive or when non-email context is more important.
- If true, opener must be short plain text (4-12 words), no emojis, and explicitly indicate intentional email cleanup (e.g., "Email cleanup time.").`,
        prompt: `Current local time: ${localTime} (${tz})
LOCAL_TIME_CONTEXT:
${localTimeContext}

USER_PREFERENCES:
${preferenceGateBlock}

slots_remaining=${intentionalEmailCleanupSlotsRemaining}
history_lookup_ok=${intentionalEmailCleanupHistoryLookupOk}
urgency_bypass=${emailCleanupUrgencyBypass}
inbox_pending=${inboxPendingCount}
inbox_auto_executed=${inboxAutoExecutedCount}
inbox_critical=${inboxCriticalCount}

INBOX_ACTION_STATUS:
${inboxActionsPromptContext.summary || "(none)"}

RECENT_HEARTBEAT_EXAMPLES:
${recentHeartbeatSnippets || "(none)"}

OTHER_SIGNALS:
WEB_PIXEL_SIGNALS:
${webPixelSummaryForPrompt}

UPREADY_READINESS:
${upreadySummaryForPrompt}

WELLBEING_CONTEXT:
${wellbeingContextForPrompt || "(none)"}`,
      });
      void recordHeartbeatUsage({
        spanId: "email_cleanup_intent_gate",
        usage: (decision as unknown as { usage?: unknown }).usage,
        meta: { phase: "email_cleanup_intent_gate" },
      });
      emailCleanupDecision = parseEmailCleanupHeartbeatDecision(decision.text || "");
    } catch (e) {
      console.warn("[heartbeat] email cleanup intent gate failed:", e);
    }
  }
  const emailCleanupIntentApproved =
    inboxRequiresHeartbeat &&
    emailCleanupCapAllows &&
    emailCleanupDecision.shouldSend;
  let emailCleanupWindowDecision: EmailCleanupWindowDecision = {
    allowSendNow: false,
    reason: "not_evaluated",
  };
  if (emailCleanupIntentApproved) {
    try {
      const windowDecision = await generateText({
        model: activeModel,
        providerOptions: heartbeatReasoningProviderOptions,
        system: `You are a timing gate for intentional email-cleanup heartbeats.
Return ONLY valid JSON with this exact shape:
{
  "allow_send_now": boolean,
  "reason": string
}

Rules:
- USER_PREFERENCES are highest priority.
- Do not use fixed clock-hour rules or hardcoded time windows.
- Infer whether now is a good cleanup moment from user rhythm and recent cleanup heartbeat timing.
- Prefer spreading cleanup nudges across the day and avoid clustering them too closely.
- If inbox urgency is high (critical or heavy pending queue), you may still allow send_now.
- If uncertain, return allow_send_now=false.`,
        prompt: `Current local time: ${localTime} (${tz})
LOCAL_TIME_CONTEXT:
${localTimeContext}

USER_PREFERENCES:
${preferenceGateBlock}

INTENT_DECISION:
intent_should_send=${emailCleanupDecision.shouldSend}
intent_reason=${emailCleanupDecision.reason || "(none)"}
intent_opener=${emailCleanupDecision.opener || "(none)"}

DAILY_LIMIT:
daily_max=${inboxCleanupHeartbeatsPerDayMax}
sent_today=${intentionalEmailCleanupHeartbeatsSentToday}
slots_remaining=${intentionalEmailCleanupSlotsRemaining}
today_local_times=${todayCleanupHeartbeatTimes}

RECENT_INTENTIONAL_EMAIL_CLEANUP_HEARTBEATS:
${recentCleanupHeartbeatLines}

last_cleanup_heartbeat_local=${lastCleanupHeartbeatLocal}

INBOX_SIGNAL:
inbox_pending=${inboxPendingCount}
inbox_auto_executed=${inboxAutoExecutedCount}
inbox_critical=${inboxCriticalCount}

INBOX_ACTION_STATUS:
${inboxActionsPromptContext.summary || "(none)"}

RECENT_HEARTBEAT_EXAMPLES:
${recentHeartbeatSnippets || "(none)"}`,
      });
      void recordHeartbeatUsage({
        spanId: "email_cleanup_window_gate",
        usage: (windowDecision as unknown as { usage?: unknown }).usage,
        meta: { phase: "email_cleanup_window_gate" },
      });
      emailCleanupWindowDecision = parseEmailCleanupWindowDecision(windowDecision.text || "");
    } catch (e) {
      console.warn("[heartbeat] email cleanup window gate failed:", e);
    }
  }
  const emailCleanupUrgencyBypassApplied =
    emailCleanupIntentApproved &&
    !emailCleanupWindowDecision.allowSendNow &&
    emailCleanupUrgencyBypass;
  const shouldSendIntentionalEmailCleanupHeartbeat =
    emailCleanupIntentApproved &&
    (emailCleanupWindowDecision.allowSendNow || emailCleanupUrgencyBypassApplied);
  const intentionalEmailCleanupOpener = normalizeEmailCleanupOpener(emailCleanupDecision.opener);
  let usedIntentionalEmailCleanupFallback = false;
  const applyIntentionalEmailCleanupFallback = (pendingOverride?: number) => {
    const safePending = Number.isFinite(Number(pendingOverride))
      ? Math.max(0, Math.floor(Number(pendingOverride)))
      : inboxDisplayedPendingCount;
    inboxDisplayedPendingCount = safePending;
    text = buildIntentionalEmailCleanupFallbackText({
      opener: intentionalEmailCleanupOpener,
      pending: safePending,
      autoExecuted: inboxAutoExecutedCount,
      critical: inboxCriticalCount,
      calendarSummary: calendarSummaryForPrompt || calendarSummary,
      webPixelSummary: webPixelSummaryForPrompt || webPixelSummary,
      upreadySummary: upreadySummaryForPrompt || upreadySummary,
    });
    usedIntentionalEmailCleanupFallback = true;
  };
  if (text.startsWith("__SKIP__") && shouldSendIntentionalEmailCleanupHeartbeat) {
    applyIntentionalEmailCleanupFallback();
  }

  if (text.startsWith("__SKIP__")) {
    if (forceSend) {
      try {
        const forced = await generateText({
          model: activeModel,
          system: `${systemPrompt}\n\nOVERRIDE: FORCE_SEND=true. Do NOT output __SKIP__. Write 2–6 concise sentences with concrete details.`,
          prompt: "Generate the check-in now. Do not output __SKIP__.",
        });
        void recordHeartbeatUsage({
          spanId: "force_send_override",
          usage: (forced as unknown as { usage?: unknown }).usage,
          meta: { phase: "force_send_override" },
        });
        const forcedText = (forced.text || "").trim();
        if (forcedText && !forcedText.startsWith("__SKIP__")) {
          text = forcedText;
        }
      } catch (e) {
        console.warn("[heartbeat] force_send override failed:", e);
      }
    }
    if (forceSend && !text.startsWith("__SKIP__")) {
      // forced output achieved
    } else {
    if (localCtx.dayPart === "late_night") {
      console.log("[heartbeat] model decided __SKIP__ during late_night — respecting unconditionally");
      return { ok: true, text: "", sessionId: null, sendWhatsApp: false, sendTelegram: false };
    }

    try {
      const gateResult = await generateText({
        model: activeModel,
        system: `You are a strict heartbeat decision gate.
Your only job is to decide whether to send a check-in message now.

USER_PREFERENCES are highest priority. Enforce them before all other rules.

Return exactly one token:
- __SEND__  (if there is a genuinely NEW, concrete, time-sensitive detail worth sharing)
- __SKIP__  (if there is nothing new or noteworthy, or if the same topics have been covered in recent heartbeats)

Rules:
- If sending would violate USER_PREFERENCES, return __SKIP__.
- Only return __SEND__ if there is information the user has NOT already seen in recent heartbeats AND it is actionable or time-sensitive.
- Familiar project updates, ongoing tasks, or known blockers that have already been mentioned are NOT reasons to send.
- If calendar/email snippets contain concrete details about events in the NEXT 2 hours, return __SEND__.
- If WEB_PIXEL_SIGNALS contains concrete metrics/trends (visitors, signups, page views, etc.), return __SEND__.
- If UPREADY_READINESS contains a concrete score change/trend/load shift worth mentioning, return __SEND__.
- If MEMORY_CONTEXT contains a concrete or surprising detail that was not mentioned in RECENT_HEARTBEAT_EXAMPLES, return __SEND__.
- If UPREADY_READINESS or WELLBEING_CONTEXT contains a concrete health/readiness signal that feels worth surfacing now, return __SEND__.
- If context is only empty placeholders, stale boilerplate, or no concrete details at all, return __SKIP__.
- If LOCAL_TIME_CONTEXT says sleep_window_active=true, return __SKIP__. No exceptions.
- If LOCAL_TIME_CONTEXT says day_part=late_night, return __SKIP__. No exceptions.
- Do not explain. Output one token only.`,
        prompt: `USER_PREFERENCES (HIGHEST PRIORITY):
${preferenceGateBlock}

Current date/time: ${localTime} (${tz})
LOCAL_TIME_CONTEXT:
${localTimeContext}

MEMORY_CONTEXT:
${memoryContext || "(none)"}

UPCOMING_CALENDAR_EVENTS:
${calendarSummary || "(none)"}

RECENT_EMAILS:
${emailSummary || "(none)"}

WEB_PIXEL_SIGNALS:
${webPixelSummary || "(none)"}

UPREADY_READINESS:
${upreadySummary || "(none)"}

WELLBEING_CONTEXT:
${wellbeingContextForPrompt || "(none)"}

CURRENT_SCHEDULED_TASKS:
${scheduledTasksSummary || "(none)"}

RECENT_HEARTBEAT_EXAMPLES:
${recentHeartbeatSnippets || "(none)"}
`,
      });
      void recordHeartbeatUsage({
        spanId: "skip_gate",
        usage: (gateResult as unknown as { usage?: unknown }).usage,
        meta: { phase: "skip_gate_decision" },
      });

      const gateText = (gateResult.text || "").trim().toUpperCase();
      if (gateText.includes("__SEND__")) {
        console.warn("[heartbeat] model returned __SKIP__, gate decided __SEND__; regenerating check-in");
        const forced = await generateText({
          model: activeModel,
          system: `${systemPrompt}\n\nOVERRIDE: The decision gate determined there is noteworthy context. Do NOT output __SKIP__. Write 2-6 concise sentences with concrete details.`,
          prompt: "Generate the check-in now. Do not output __SKIP__.",
        });
        void recordHeartbeatUsage({
          spanId: "skip_regen",
          usage: (forced as unknown as { usage?: unknown }).usage,
          meta: { phase: "skip_override_regeneration" },
        });
        const forcedText = (forced.text || "").trim();
        if (forcedText && !forcedText.startsWith("__SKIP__")) {
          text = forcedText;
        }
      }
    } catch (e) {
      console.warn("[heartbeat] skip decision gate failed:", e);
    }

      if (text.startsWith("__SKIP__")) {
        console.log("[heartbeat] model decided nothing noteworthy — skipping");
        return { ok: true, text: "", sessionId: null, sendWhatsApp: false, sendTelegram: false };
      }
    }
  }

  // 5c. Quality/variety guardrail: if draft is too repetitive or ignores available
  // web analytics signals, regenerate once with stricter guidance.
  // Only require mention of pixel/readiness when the source actually CHANGED this run.
  const requirePixelMention = webPixelChanged && hasCurrentWebPixelSignals(webPixelSummaryForPrompt);
  const requireReadinessMention =
    upreadyChanged &&
    hasUpreadyReadiness &&
    Boolean(upreadySummaryForPrompt.trim()) &&
    !/^\(no new readiness point/i.test(upreadySummaryForPrompt.trim()) &&
    !/^\(not connected\)/i.test(upreadySummaryForPrompt.trim());
  const varietyCheck = shouldRegenerateHeartbeatForVariety({
    text,
    recentHeartbeatSnippets,
    requirePixelMention,
    requireReadinessMention,
    forbidGenericWellbeingQuestion: true,
  });
  if (varietyCheck.regenerate) {
    try {
      console.warn("[heartbeat] regenerating repetitive draft", {
        reason: varietyCheck.reason,
      });
      const regenerated = await generateText({
        model: activeModel,
        system: `${systemPrompt}

OVERRIDE: The previous draft was repetitive or ignored important signals.
Regenerate with a FRESH angle and stronger novelty.
- Do NOT repeat the same primary topics from RECENT_HEARTBEAT_EXAMPLES.
- Respect NOVELTY_SINCE_LAST_HEARTBEAT: do NOT restate unchanged sources.
- If web_pixel_changed=true, include one concrete analytics insight.
- If UPREADY_READINESS is connected and not placeholder, include the latest readiness number.
- If you include a wellbeing mention, anchor it to concrete signal details from WELLBEING_CONTEXT or UPREADY_READINESS.
- Never ask generic "How are you feeling today?" or "How do you feel today?".
- Include one unexpected-but-useful connection from MEMORY_CONTEXT when available.
- Keep 2-6 sentences, plain text, no markdown, no bullets.`,
        prompt: "Regenerate the check-in now. Do not output __SKIP__.",
      });
      void recordHeartbeatUsage({
        spanId: "variety_regen",
        usage: (regenerated as unknown as { usage?: unknown }).usage,
        meta: { phase: "variety_regeneration", reason: varietyCheck.reason },
      });
      const regeneratedText = (regenerated.text || "").trim();
      if (regeneratedText && !regeneratedText.startsWith("__SKIP__")) {
        text = regeneratedText;
      }
    } catch (e) {
      console.warn("[heartbeat] variety regeneration failed:", e);
    }
  }

  if (!text.startsWith("__SKIP__") && shouldSendIntentionalEmailCleanupHeartbeat) {
    if (!text.toLowerCase().startsWith(intentionalEmailCleanupOpener.toLowerCase())) {
      text = `${intentionalEmailCleanupOpener} ${text}`.trim();
    }
  }
  if (!text.startsWith("__SKIP__") && !shouldSendIntentionalEmailCleanupHeartbeat) {
    // Prevent accidental "Email cleanup time" copycat openers outside intentional cleanup heartbeats.
    text = text.replace(/^email cleanup time(?:\s*[—:-]\s*|\.\s*)/i, "").trim();
    if (!text) {
      text = "__SKIP__";
    }
  }

  // Final safety check: enforce preferences on the final draft after any regen paths.
  let finalComplianceForcedSkip = false;
  if (preferenceConstraintsForHeartbeat && !text.startsWith("__SKIP__")) {
    try {
      const finalComplianceResult = await generateText({
        model: activeModel,
        system: buildPreferenceComplianceCheckerPrompt(),
        prompt: `USER_PREFERENCES:
${preferenceGateBlock}

DRAFT:
${text}`,
      });
      void recordHeartbeatUsage({
        spanId: "preference_compliance_final",
        usage: (finalComplianceResult as unknown as { usage?: unknown }).usage,
        meta: { phase: "preference_compliance_final" },
      });
      const finalCompliance = parsePreferenceComplianceResult(finalComplianceResult.text || "");
      if (!finalCompliance.compliant) {
        console.warn("[heartbeat] final preference compliance failed; forcing __SKIP__", {
          reason: finalCompliance.reason,
        });
        text = "__SKIP__";
        finalComplianceForcedSkip = true;
      }
    } catch (e) {
      console.warn("[heartbeat] final preference compliance check failed:", e);
    }
  }

  if (text.startsWith("__SKIP__")) {
    if (shouldSendIntentionalEmailCleanupHeartbeat && !finalComplianceForcedSkip) {
      applyIntentionalEmailCleanupFallback();
    }
  }
  if (
    text.startsWith("__SKIP__") &&
    shouldAppendIntegrationReauthWarning &&
    integrationReauthWarningText &&
    !finalComplianceForcedSkip
  ) {
    text = integrationReauthWarningText;
    appendedIntegrationReauthWarning = true;
  }
  if (text.startsWith("__SKIP__")) {
    console.log("[heartbeat] final draft resolved to __SKIP__ after preference compliance");
    return { ok: true, text: "", sessionId: null, sendWhatsApp: false, sendTelegram: false };
  }

  const sentWellbeingCheckIn = isWellbeingCheckInText(text);

  let finalText = text;
  let hasProtectedActionBlock = false;

  // 6. Persist to dashboard session
  let sessionId = taskConfig.orchestrator_session_id || null;
  try {
    if (sessionId) {
      // Verify session exists
      const { data: existing } = await supabase
        .from("orchestrator_sessions")
        .select("id")
        .eq("id", sessionId)
        .maybeSingle();
      if (!existing) sessionId = null;
    }
    if (!sessionId) {
      const { data: newSession } = await supabase
        .from("orchestrator_sessions")
        .insert({ user_id: userId, title: "Heartbeat" })
        .select("id")
        .single();
      sessionId = newSession?.id || null;
    }

    // Bind pending inbox actions to this agent runtime. Append command block only for
    // intentional email-cleanup heartbeats.
    if (inboxTriageResult) {
      if (inboxTriageResult.pendingActionIds.length > 0) {
        try {
          await supabase
            .from("inbox_actions")
            .update({
              session_id: sessionId || null,
              agent_id: heartbeatAgentId,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId)
            .eq("run_id", inboxTriageResult.runId)
            .is("agent_id", null);
        } catch {
          // best effort
        }
      }
      if (shouldSendIntentionalEmailCleanupHeartbeat) {
        const actionBlock = await buildHeartbeatActionBlock({
          supabase,
          userId,
          agentId: heartbeatAgentId,
          runId: inboxTriageResult.runId,
          pendingActionIds: inboxTriageResult.pendingActionIds,
        });
        inboxDisplayedPendingCount = Math.max(inboxDisplayedPendingCount, actionBlock.pendingCount);
        if (usedIntentionalEmailCleanupFallback) {
          finalText = buildIntentionalEmailCleanupFallbackText({
            opener: intentionalEmailCleanupOpener,
            pending: inboxDisplayedPendingCount,
            autoExecuted: inboxAutoExecutedCount,
            critical: inboxCriticalCount,
            calendarSummary: calendarSummaryForPrompt || calendarSummary,
            webPixelSummary: webPixelSummaryForPrompt || webPixelSummary,
            upreadySummary: upreadySummaryForPrompt || upreadySummary,
          });
        }
        if (actionBlock.block.trim()) {
          hasProtectedActionBlock = true;
          finalText = `${finalText}${actionBlock.block}`;
        }
        if (inboxAutoExecutedCount > 0) {
          finalText = `${finalText}\n\nEmail autopilot processed ${inboxAutoExecutedCount} low-risk messages.`;
        }
      }
    }

    if (
      shouldAppendIntegrationReauthWarning &&
      integrationReauthWarningText &&
      !appendedIntegrationReauthWarning
    ) {
      finalText = `${finalText}\n\n${integrationReauthWarningText}`.trim();
      appendedIntegrationReauthWarning = true;
    }

    // Preference guard for the fully assembled message (including action block/fallback text).
    // This closes post-generation bypasses where appended sections can reintroduce excluded topics.
    if (preferenceConstraintsForHeartbeat && !finalText.startsWith("__SKIP__")) {
      try {
        const fullComplianceResult = await generateText({
          model: activeModel,
          system: buildPreferenceComplianceCheckerPrompt(),
          prompt: `USER_PREFERENCES:
${preferenceGateBlock}

DRAFT:
${finalText}`,
        });
        void recordHeartbeatUsage({
          spanId: "preference_compliance_full_message_check",
          usage: (fullComplianceResult as unknown as { usage?: unknown }).usage,
          meta: { phase: "preference_compliance_full_message_check" },
        });
        const fullCompliance = parsePreferenceComplianceResult(fullComplianceResult.text || "");
        const fullComplianceUnreliable = fullCompliance.reason.startsWith("unparseable_checker_output");

        if (!fullCompliance.compliant || fullComplianceUnreliable) {
          if (hasProtectedActionBlock) {
            console.warn("[heartbeat] command block present and full-message compliance failed; forcing __SKIP__", {
              reason: fullCompliance.reason,
              unreliableCheckerOutput: fullComplianceUnreliable,
            });
            finalText = "__SKIP__";
          } else {
            console.warn("[heartbeat] full message preference violation detected; attempting constrained rewrite", {
              reason: fullCompliance.reason,
            });
            const rewrittenResult = await generateText({
              model: activeModel,
              system: `You rewrite heartbeat messages to comply with USER_PREFERENCES.

Rules:
- USER_PREFERENCES are highest priority over all other goals.
- Keep the original text as intact as possible; make the smallest edits needed.
- You may delete conflicting lines/sections.
- Do not invent new action IDs, command aliases, subjects, or metrics.
- If the message includes command lines that remain valid, preserve them verbatim.
- If no compliant content remains, output exactly __SKIP__.
- Output plain text only.`,
              prompt: `USER_PREFERENCES:
${preferenceGateBlock}

NON_COMPLIANT_MESSAGE:
${finalText}

Rewrite a fully compliant final heartbeat message now.`,
            });
            void recordHeartbeatUsage({
              spanId: "preference_compliance_full_message_rewrite",
              usage: (rewrittenResult as unknown as { usage?: unknown }).usage,
              meta: {
                phase: "preference_compliance_full_message_rewrite",
                reason: fullCompliance.reason,
              },
            });
            const rewrittenText = (rewrittenResult.text || "").trim();
            finalText = rewrittenText || "__SKIP__";

            if (!finalText.startsWith("__SKIP__")) {
              const rewrittenRecheckResult = await generateText({
                model: activeModel,
                system: buildPreferenceComplianceCheckerPrompt(),
                prompt: `USER_PREFERENCES:
${preferenceGateBlock}

DRAFT:
${finalText}`,
              });
              void recordHeartbeatUsage({
                spanId: "preference_compliance_full_message_recheck",
                usage: (rewrittenRecheckResult as unknown as { usage?: unknown }).usage,
                meta: { phase: "preference_compliance_full_message_recheck" },
              });
              const rewrittenRecheck = parsePreferenceComplianceResult(
                rewrittenRecheckResult.text || ""
              );
              const rewrittenRecheckUnreliable =
                rewrittenRecheck.reason.startsWith("unparseable_checker_output");
              if (!rewrittenRecheck.compliant || rewrittenRecheckUnreliable) {
                console.warn("[heartbeat] rewritten full message still violates preferences; forcing __SKIP__", {
                  reason: rewrittenRecheck.reason,
                  unreliableCheckerOutput: rewrittenRecheckUnreliable,
                });
                finalText = "__SKIP__";
              }
            }
          }
        }
      } catch (e) {
        console.warn("[heartbeat] full message preference guard failed; forcing __SKIP__:", e);
        finalText = "__SKIP__";
      }
    }

    if (finalText.startsWith("__SKIP__")) {
      console.log("[heartbeat] assembled heartbeat resolved to __SKIP__ after full-message preference guard");
      return { ok: true, text: "", sessionId: null, agentId: heartbeatAgentId, sendWhatsApp: false, sendTelegram: false };
    }

    if (sessionId && delivery.dashboard !== false) {
      const runtimeScope = await resolveRuntimeScope({
        supabase,
        userId,
        sessionId,
        agentId: heartbeatAgentId,
      });
      const { error } = await supabase.from("orchestrator_messages").insert({
        user_id: userId,
        session_id: sessionId,
        agent_id: heartbeatAgentId,
        epoch_id: runtimeScope?.epochId || null,
        branch_id: runtimeScope?.branchId || null,
        role: "assistant",
        content: finalText,
        metadata: {
          kind: "heartbeat",
          generated_at: new Date().toISOString(),
          wellbeing_checkin: sentWellbeingCheckIn,
          wellbeing_signal_source: wellbeingSignal.source,
          heartbeat_focus: shouldSendIntentionalEmailCleanupHeartbeat ? "email_cleanup" : "general",
          email_cleanup_intent: shouldSendIntentionalEmailCleanupHeartbeat,
          email_cleanup_daily_max: inboxCleanupHeartbeatsPerDayMax,
          email_cleanup_heartbeats_sent_today:
            intentionalEmailCleanupHeartbeatsSentToday + (shouldSendIntentionalEmailCleanupHeartbeat ? 1 : 0),
          email_cleanup_slots_remaining: Math.max(
            0,
            intentionalEmailCleanupSlotsRemaining - (shouldSendIntentionalEmailCleanupHeartbeat ? 1 : 0)
          ),
          email_cleanup_history_lookup_ok: intentionalEmailCleanupHistoryLookupOk,
          email_cleanup_urgency_bypass: emailCleanupUrgencyBypass,
          email_cleanup_urgency_bypass_applied: emailCleanupUrgencyBypassApplied,
          inbox_pending_count: inboxDisplayedPendingCount,
          inbox_auto_executed_count: inboxAutoExecutedCount,
          inbox_critical_count: inboxCriticalCount,
          ...(inboxRequiresHeartbeat && emailCleanupDecision.reason
            ? { email_cleanup_intent_reason: emailCleanupDecision.reason }
            : {}),
          ...(inboxRequiresHeartbeat
            ? { email_cleanup_window_allowed: emailCleanupWindowDecision.allowSendNow }
            : {}),
          ...(inboxRequiresHeartbeat && emailCleanupWindowDecision.reason
            ? { email_cleanup_window_reason: emailCleanupWindowDecision.reason }
            : {}),
          ...(appendedIntegrationReauthWarning
            ? {
                integration_reauth_warning: true,
                integration_reauth_warning_reason: integrationReauthWarningReason || "unknown",
                reauth: integrationReauthEntries.map((entry) => ({
                  provider: entry.provider,
                  label: entry.label,
                  url: entry.url,
                })),
              }
            : {}),
          ...(wellbeingSignal.reason ? { wellbeing_signal_reason: wellbeingSignal.reason } : {}),
        },
      });
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    console.warn("[heartbeat] session persist error:", e);
  }

  // Persist "last sent" fingerprints so we can suppress repeats on the next hourly run.
  if (jobId) {
    try {
      const sentAtIso = new Date().toISOString();
      const nextWebPixelHash = signalHash(webPixelSummary);
      const nextUpreadyPointId = upreadyLatestPointId ? upreadyLatestPointId.trim() : "";
      const updatedTask: HeartbeatTaskConfig = {
        ...dbTaskConfig,
        last_heartbeat_sent_at: sentAtIso,
        last_heartbeat_email_ids: currentEmailIds,
        last_heartbeat_calendar_keys: currentCalendarKeys,
        ...(nextWebPixelHash !== null ? { last_heartbeat_web_pixel_hash: nextWebPixelHash } : {}),
        ...(nextUpreadyPointId ? { last_heartbeat_upready_latest_point_id: nextUpreadyPointId } : {}),
        ...(memoryTodayHash !== null ? { last_heartbeat_memory_today_hash: memoryTodayHash } : {}),
        ...(sentWellbeingCheckIn ? { last_wellbeing_checkin_at: sentAtIso } : {}),
        ...(sentWellbeingCheckIn && wellbeingSignal.signalHash !== null
          ? { last_wellbeing_signal_hash: wellbeingSignal.signalHash }
          : {}),
        ...(appendedIntegrationReauthWarning && integrationReauthWarningHash !== null
          ? {
              last_integration_reauth_warning_at: sentAtIso,
              last_integration_reauth_warning_hash: integrationReauthWarningHash,
            }
          : {}),
      };
      dbTaskConfig = updatedTask;
      const { error } = await supabase
        .from("scheduled_jobs")
        .update({ task: updatedTask, updated_at: sentAtIso })
        .eq("id", jobId);
      if (error) throw new Error(error.message);
    } catch {
      /* best-effort */
    }
  }

  console.log("[heartbeat] done", {
    textLen: finalText.length,
    agentId: heartbeatAgentId,
    sessionId,
    sendWhatsApp: delivery.whatsapp !== false,
    sendTelegram: delivery.telegram === true,
    inboxPending: inboxDisplayedPendingCount,
    inboxAutoExecuted: inboxAutoExecutedCount,
    emailCleanupIntent: shouldSendIntentionalEmailCleanupHeartbeat,
    emailCleanupSlotsRemaining: intentionalEmailCleanupSlotsRemaining,
    emailCleanupWindowAllowed: emailCleanupWindowDecision.allowSendNow,
    emailCleanupUrgencyBypassApplied,
    integrationReauthWarning: appendedIntegrationReauthWarning,
    integrationReauthWarningReason: integrationReauthWarningReason || null,
  });

  return {
    ok: true,
    text: finalText,
    sessionId,
    agentId: heartbeatAgentId,
    sendWhatsApp: delivery.whatsapp !== false,
    sendTelegram: delivery.telegram === true,
  };
}
