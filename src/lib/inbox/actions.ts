import { generateText } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAnthropicReasoningProviderOptions,
  resolveChatModel,
  type ProviderId,
} from "@/lib/ai/modelResolver";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import { resolveKeys } from "@/lib/keys/resolveKeyMode";

const GROOVY_LABEL_PROCESSED = "Groovy/Processed";
const GROOVY_LABEL_DRAFTED = "Groovy/Drafted";
const GROOVY_LABEL_SPAM = "Groovy/Spam";
const GROOVY_LABEL_UNSUBSCRIBED = "Groovy/Unsubscribed";

const INBOX_ACTIONS_MAX_PER_RUN = 12;
const STAGE_B_MAX_BODY_CHARS = 14_000;
const HEARTBEAT_DRAFT_PREVIEW_CHARS = 260;
const COMMAND_LIST_MAX_ROWS = 12;
// Auto-canceling pending inbox actions proved too brittle in real chats (WhatsApp especially).
// Default is disabled; can be enabled via env for experimentation.
const INBOX_PENDING_AUTO_CANCEL_AFTER_MESSAGES = (() => {
  const raw = toTrimmed(process.env.INBOX_PENDING_AUTO_CANCEL_AFTER_MESSAGES);
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
})();
const DATAGRAN_API_TIMEOUT_MS = 60_000;
const SENDER_INTEL_TIMEOUT_MS = 8_000;
const GROOVY_EMAIL_SEND_NOTICE = "Sent with Groovy AI assistant. I apologize for any unintended messages.";
const GROOVY_EMAIL_SEND_NOTICE_LEGACY = "Email sent via my Groovy assistant. Please excuse any unintended requests.";

type DatagranResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
  needsReauth?: boolean;
};

type GmailLabelMutationResult = {
  ok: boolean;
  error?: string;
  needsReauth?: boolean;
};

export type HeartbeatPolicyModel = {
  provider: ProviderId;
  modelName: string;
  apiKey: string | null;
};

export type TriageMailbox = {
  connectionId: string;
  mailboxLabel: string;
  datagranApiKey?: string | null;
};

export type TriageEmailItem = {
  connectionId: string;
  mailboxLabel: string;
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
};

export type HeartbeatTriageResult = {
  runId: string;
  pendingActionIds: string[];
  pendingCount: number;
  autoExecutedCount: number;
  criticalCount: number;
  notes: string[];
};

export type BuildHeartbeatActionBlockResult = {
  block: string;
  pendingCount: number;
  aliases: Array<{ alias: number; actionId: string }>;
};

type ActionType = "draft_reply" | "mark_spam" | "unsubscribe" | "archive" | "label_only";
type ActionStatus = "pending" | "approved" | "executing" | "done" | "rejected" | "failed";

type ParsedInboxCommandSingle =
  | { kind: "show" }
  | { kind: "show_draft"; alias: number | null }
  | { kind: "why"; alias: number }
  | { kind: "approve" | "reject"; aliases: number[]; all: boolean }
  | { kind: "confirm_send"; aliases: number[] }
  | { kind: "edit"; alias: number; text: string }
  | { kind: "batch"; decisions: Array<{ kind: "approve" | "reject"; alias: number }> };

type ParsedInboxCommand =
  | ParsedInboxCommandSingle
  | { kind: "multi"; commands: ParsedInboxCommandSingle[] };

type ParsedInboxCommandIntent = {
  command: ParsedInboxCommand | null;
  followupText: string;
};

type SenderInfo = {
  name: string;
  email: string;
  domain: string;
};

type SenderIntel = {
  domain: string;
  reputation: "trusted" | "neutral" | "risky";
  confidence: number;
  summary: string;
  signals: Record<string, unknown>;
};

type SenderAffinity = {
  senderEmail: string;
  incomingCount: number;
  repliedCount: number;
  lastReceivedAt: string | null;
  lastRepliedAt: string | null;
};

type ThreadMessageCandidate = {
  gmailMessageId: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  snippet: string;
  messageIdHeader: string;
};

type PolicyDecision = {
  action: ActionType;
  confidence: number;
  pImportant: number;
  pSpam: number;
  pActionable: number;
  reason: string;
  critical: boolean;
  draftReply?: string;
  targetThreadId?: string;
  targetMessageIdHeader?: string;
  targetReason?: string;
  autoExecute: boolean;
};

type LabelsByName = Record<string, string>;

type InboxActionRow = {
  id: string;
  user_id: string;
  agent_id: string | null;
  session_id: string | null;
  source_job_id: string | null;
  run_id: string | null;
  provider: string;
  connection_id: string;
  mailbox_label: string | null;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  gmail_draft_id: string | null;
  sender_email: string | null;
  sender_name: string | null;
  sender_domain: string | null;
  subject: string | null;
  snippet: string | null;
  recommended_action: ActionType;
  status: ActionStatus;
  confidence: number | null;
  p_important: number | null;
  p_spam: number | null;
  p_actionable: number | null;
  reason: string | null;
  draft_to: unknown;
  draft_subject: string | null;
  draft_body: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type InsertInboxActionResult = {
  row: InboxActionRow;
  inserted: boolean;
};

type InboxCommandConfirmationPayload =
  | {
      kind: "approve" | "reject";
      parsed: { kind: "approve" | "reject"; aliases: number[]; all: false };
      confirm_cmd: string;
      summary_lines: string[];
    }
  | {
      kind: "batch";
      parsed: { kind: "batch"; decisions: Array<{ kind: "approve" | "reject"; alias: number }> };
      confirm_cmd: string;
      summary_lines: string[];
    };

type InboxCommandConfirmationIntent = { kind: "none" } | { kind: "confirm" } | { kind: "cancel" };

export type InboxCommandConnectorExecute = {
  toolCallId: string;
  toolName: string;
  agent: "files";
  connectorType: "email_unsubscribe_execute";
  connectorParams: Record<string, unknown>;
  message?: string;
};

type ExecuteActionResult = {
  ok: boolean;
  detail: string;
  connectorExecutes?: InboxCommandConnectorExecute[];
};

export type ExecuteInboxCommandResult = {
  handled: boolean;
  reply: string;
  connectorExecutes?: InboxCommandConnectorExecute[];
  statusMessage?: string;
  followupText?: string;
};

export type PendingInboxSilenceSweepResult = {
  touched: boolean;
  pendingBefore: number;
  pendingAfter: number;
  cancelledCount: number;
  messageMentionsActions: boolean;
  threshold: number;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function toTrimmed(v: unknown): string {
  return typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
}

function appendGroovyEmailSendNotice(body: string): string {
  const trimmed = toTrimmed(body);
  const noticeLower = normalizeKey(GROOVY_EMAIL_SEND_NOTICE);
  const legacyLower = normalizeKey(GROOVY_EMAIL_SEND_NOTICE_LEGACY);
  if (!trimmed) return GROOVY_EMAIL_SEND_NOTICE;
  const normalized = normalizeKey(trimmed);
  if (normalized.includes(noticeLower) || normalized.includes(legacyLower)) return trimmed;
  return `${trimmed}\n\n${GROOVY_EMAIL_SEND_NOTICE}`;
}

function parseDatagranErrorPayload(parsed: unknown): { message: string; reasons: string[] } {
  const rec = asRecord(parsed);
  if (!rec) return { message: toTrimmed(parsed), reasons: [] };
  const rootError = asRecord(rec.error);
  const reasons: string[] = [];
  const nestedErrors = Array.isArray(rootError?.errors) ? rootError.errors : [];
  for (const item of nestedErrors) {
    const reason = toTrimmed(asRecord(item)?.reason);
    if (reason) reasons.push(reason);
  }
  const details = Array.isArray(rootError?.details) ? rootError.details : [];
  for (const item of details) {
    const reason = toTrimmed(asRecord(item)?.reason);
    if (reason) reasons.push(reason);
  }
  const messageCandidates = [
    toTrimmed(rootError?.message),
    toTrimmed(rec.message),
    typeof rec.error === "string" ? toTrimmed(rec.error) : "",
  ].filter((v) => v && v !== "[object Object]");
  const message = messageCandidates[0] || (rootError ? JSON.stringify(rootError) : toTrimmed(parsed));
  return { message, reasons };
}

function isDatagranScopeInsufficient(status: number, message: string, reasons: string[]): boolean {
  if (status !== 403) return false;
  const hay = `${message} ${reasons.join(" ")}`.toLowerCase();
  return (
    hay.includes("insufficient authentication scopes") ||
    hay.includes("insufficient permission") ||
    reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
    reasons.includes("insufficientPermissions")
  );
}

function isDatagranAuthReauth(status: number, message: string, reasons: string[]): boolean {
  if (status === 401) return true;
  if (isDatagranScopeInsufficient(status, message, reasons)) return true;
  const hay = `${message} ${reasons.join(" ")}`.toLowerCase();
  return /token.*expired|authorization\.required|authorization_required|invalid.*token/.test(hay);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function normalizeKey(v: string): string {
  return String(v || "").trim().toLowerCase();
}

function normalizeMessageIdHeader(v: string): string {
  return toTrimmed(v)
    .replace(/^<+|>+$/g, "")
    .trim()
    .toLowerCase();
}

function truncateForPrompt(v: string, maxChars: number): string {
  const text = toTrimmed(v);
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function formatThreadCandidatesForPolicy(candidates: ThreadMessageCandidate[]): string {
  if (!Array.isArray(candidates) || candidates.length === 0) return "(none)";
  return candidates
    .map((c, idx) =>
      [
        `${idx + 1}.`,
        `thread_id=${c.threadId || "(missing)"}`,
        `message_id_header=${c.messageIdHeader || "(missing)"}`,
        `from=${truncateForPrompt(c.from, 140) || "(missing)"}`,
        `to=${truncateForPrompt(c.to, 160) || "(missing)"}`,
        `cc=${truncateForPrompt(c.cc, 160) || "(none)"}`,
        `subject=${truncateForPrompt(c.subject, 160) || "(none)"}`,
        `date=${truncateForPrompt(c.date, 120) || "(none)"}`,
      ].join(" | ")
    )
    .join("\n");
}

function parseSender(fromHeader: string): SenderInfo {
  const raw = String(fromHeader || "").trim();
  if (!raw) return { name: "", email: "", domain: "" };

  const angle = raw.match(/^(.*)<([^>]+)>$/);
  const emailRaw = angle ? angle[2] : raw;
  const nameRaw = angle ? angle[1] : "";
  const email = emailRaw.replace(/^"+|"+$/g, "").trim().toLowerCase();
  const name = nameRaw.replace(/^"+|"+$/g, "").trim();
  const at = email.lastIndexOf("@");
  const domain = at > 0 ? email.slice(at + 1) : "";
  return { name, email, domain };
}

function parseEmailAddresses(header: string): string[] {
  const raw = String(header || "");
  if (!raw) return [];
  const matches = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const email = normalizeKey(m);
    if (!email) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function buildReplyAllRecipients(args: {
  senderEmail: string;
  toHeader: string;
  ccHeader: string;
  userEmail?: string | null;
}): { to: string[]; cc: string[] } {
  const sender = normalizeKey(args.senderEmail);
  const user = normalizeKey(toTrimmed(args.userEmail));
  const toParsed = parseEmailAddresses(args.toHeader);
  const ccParsed = parseEmailAddresses(args.ccHeader);

  const to: string[] = [];
  const toSet = new Set<string>();
  const addTo = (email: string) => {
    const e = normalizeKey(email);
    if (!e) return;
    if (user && e === user) return;
    if (toSet.has(e)) return;
    toSet.add(e);
    to.push(e);
  };

  const cc: string[] = [];
  const ccSet = new Set<string>();
  const addCc = (email: string) => {
    const e = normalizeKey(email);
    if (!e) return;
    if (user && e === user) return;
    if (toSet.has(e)) return;
    if (ccSet.has(e)) return;
    ccSet.add(e);
    cc.push(e);
  };

  // Gmail-style reply-all:
  // - To: sender (or first visible recipient when sender missing)
  // - Cc: everyone else from original To/Cc (excluding user + sender)
  if (sender) addTo(sender);
  else if (toParsed.length > 0) addTo(toParsed[0]);
  for (const e of toParsed) addCc(e);
  for (const e of ccParsed) addCc(e);

  return { to, cc };
}

function listRecipientEmails(value: unknown): string[] {
  const values: unknown[] = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (email: string) => {
    const e = normalizeKey(email);
    if (!e || !e.includes("@")) return;
    if (seen.has(e)) return;
    seen.add(e);
    out.push(e);
  };
  for (const raw of values) {
    const text = toTrimmed(raw);
    if (!text) continue;
    const parsed = parseEmailAddresses(text);
    if (parsed.length > 0) {
      for (const email of parsed) add(email);
      continue;
    }
    add(text.replace(/^<|>$/g, ""));
  }
  return out;
}

function mergeRecipients(args: {
  to: string[];
  cc: string[];
  senderEmail?: string | null;
  userEmail?: string | null;
}): { to: string[]; cc: string[] } {
  const sender = normalizeKey(toTrimmed(args.senderEmail));
  const user = normalizeKey(toTrimmed(args.userEmail));
  const toOut: string[] = [];
  const toSet = new Set<string>();
  const ccOut: string[] = [];
  const ccSet = new Set<string>();

  const addTo = (email: string) => {
    const e = normalizeKey(email);
    if (!e || !e.includes("@")) return;
    if (user && e === user) return;
    if (toSet.has(e)) return;
    toSet.add(e);
    toOut.push(e);
  };
  const addCc = (email: string) => {
    const e = normalizeKey(email);
    if (!e || !e.includes("@")) return;
    if (user && e === user) return;
    if (sender && e === sender) return;
    if (toSet.has(e)) return;
    if (ccSet.has(e)) return;
    ccSet.add(e);
    ccOut.push(e);
  };

  for (const e of args.to || []) addTo(e);
  if (toOut.length === 0 && sender) addTo(sender);
  for (const e of args.cc || []) addCc(e);

  return { to: toOut, cc: ccOut };
}

function decodeBase64Url(input: string): string {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  try {
    return Buffer.from(b64 + pad, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last < first) return null;
  const slice = raw.slice(first, last + 1);
  try {
    const parsed = JSON.parse(slice);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function parseInboxCommandConfirmationPayload(v: unknown): InboxCommandConfirmationPayload | null {
  const rec = asRecord(v);
  if (!rec) return null;
  const kind = normalizeKey(toTrimmed(rec.kind));
  const parsed = asRecord(rec.parsed);
  const confirmCmd = toTrimmed(rec.confirm_cmd);
  const summaryLines = Array.isArray(rec.summary_lines)
    ? rec.summary_lines.map((s) => toTrimmed(s)).filter(Boolean).slice(0, 50)
    : [];
  if (!confirmCmd || !parsed) return null;

  if (kind === "approve" || kind === "reject") {
    const aliasesRaw = Array.isArray(parsed.aliases) ? parsed.aliases : [];
    const aliases = aliasesRaw
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (aliases.length === 0) return null;
    return {
      kind: kind as "approve" | "reject",
      parsed: { kind: kind as "approve" | "reject", aliases: Array.from(new Set(aliases)).sort((a, b) => a - b), all: false },
      confirm_cmd: confirmCmd,
      summary_lines: summaryLines,
    };
  }

  if (kind === "batch") {
    const decisionsRaw = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    const decisions = parseBatchDecisions(decisionsRaw, new Set(decisionsRaw.map((d) => Number(asRecord(d)?.alias)).filter((n) => Number.isFinite(n) && n > 0)));
    if (decisions.length === 0) return null;
    return {
      kind: "batch",
      parsed: { kind: "batch", decisions },
      confirm_cmd: confirmCmd,
      summary_lines: summaryLines,
    };
  }

  return null;
}

async function savePendingInboxCommandConfirmation(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  payload: InboxCommandConfirmationPayload;
}) {
  const nowIso = new Date().toISOString();
  await args.supabase.from("inbox_command_confirmations_agent").upsert(
    {
      user_id: args.userId,
      agent_id: args.agentId,
      status: "pending",
      payload: args.payload,
      created_at: nowIso,
      updated_at: nowIso,
      consumed_at: null,
    },
    { onConflict: "user_id,agent_id" }
  );
}

async function markInboxCommandConfirmationStatus(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  status: "consumed" | "cancelled";
}) {
  const nowIso = new Date().toISOString();
  await args.supabase
    .from("inbox_command_confirmations_agent")
    .update({
      status: args.status,
      updated_at: nowIso,
      consumed_at: args.status === "consumed" ? nowIso : null,
    })
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .eq("status", "pending");
}

async function loadPendingInboxCommandConfirmation(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
}): Promise<InboxCommandConfirmationPayload | null> {
  const res = await args.supabase
    .from("inbox_command_confirmations_agent")
    .select("status,payload")
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .maybeSingle();
  const status = normalizeKey(toTrimmed((res.data as { status?: unknown } | null)?.status));
  if (status !== "pending") return null;
  const payload = (res.data as { payload?: unknown } | null)?.payload;
  return parseInboxCommandConfirmationPayload(payload);
}

function parseAiInboxCommandConfirmationObject(args: {
  raw: Record<string, unknown>;
  userText: string;
}): InboxCommandConfirmationIntent {
  const kind = normalizeKey(toTrimmed(args.raw.kind));
  if (kind !== "confirm" && kind !== "cancel" && kind !== "none") return { kind: "none" };
  if (kind === "none") return { kind: "none" };
  const explicit = args.raw.explicit === true;
  const evidence = Array.isArray(args.raw.evidence)
    ? args.raw.evidence.map((v) => toTrimmed(v)).filter(Boolean)
    : [];
  if (!explicit || !hasIntentEvidenceMatch(args.userText, evidence)) return { kind: "none" };
  return kind === "confirm" ? { kind: "confirm" } : { kind: "cancel" };
}

async function parseInboxCommandConfirmationWithAi(args: {
  supabase: SupabaseClient;
  userId: string;
  text: string;
  pending: InboxCommandConfirmationPayload;
}): Promise<InboxCommandConfirmationIntent> {
  const userText = normalizeInboxCommandText(args.text, { stripLeadingAffirmation: false });
  if (!userText) return { kind: "none" };

  const modelConfig = await resolveInboxCommandIntentModel({
    supabase: args.supabase,
    userId: args.userId,
  });
  if (!modelConfig) return { kind: "none" };

  const model = resolveChatModel(
    modelConfig.provider,
    modelConfig.modelName,
    modelConfig.apiKey ? { apiKey: modelConfig.apiKey } : undefined
  );

  const prompt = `You are an inbox confirmation parser.
There is a pending inbox action proposal that requires confirmation before execution.

Proposal summary:
${args.pending.summary_lines.join("\n") || "(none)"}

If confirmed, the system will execute:
${args.pending.confirm_cmd}

User message:
${userText}

Return ONLY JSON:
{
  "kind": "none|confirm|cancel",
  "explicit": true|false,
  "evidence": ["exact short snippets copied from the user message proving intent"]
}

Rules:
- Fail closed.
- Only return confirm/cancel if the user is explicitly confirming or explicitly cancelling/declining.
- If the user asks a new question, requests edits, or gives a different command, return kind="none".
- Always set explicit=true only if evidence in the exact user message proves intent.
- If explicit=false then kind must be "none".`;

  try {
    const out = await generateText({ model, prompt });
    const parsed = extractJsonObject(out.text || "");
    if (!parsed) return { kind: "none" };
    return parseAiInboxCommandConfirmationObject({ raw: parsed, userText });
  } catch {
    return { kind: "none" };
  }
}

function splitListUnsubscribe(header: string): { url?: string; mailto?: string; oneClick: boolean } {
  const raw = String(header || "").trim();
  if (!raw) return { oneClick: false };
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^<|>$/g, ""));
  let url: string | undefined;
  let mailto: string | undefined;
  for (const part of parts) {
    if (!url && /^https?:\/\//i.test(part)) url = part;
    if (!mailto && /^mailto:/i.test(part)) mailto = part;
  }
  return { url, mailto, oneClick: Boolean(url) };
}

function shortMailboxLabel(v: string): string {
  const t = toTrimmed(v);
  return t || "Gmail";
}

function buildDraftRaw(args: {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
}): string {
  const headers: string[] = [];
  headers.push(`To: ${args.to}`);
  if (toTrimmed(args.cc)) headers.push(`Cc: ${toTrimmed(args.cc)}`);
  headers.push(`Subject: ${args.subject}`);
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references) headers.push(`References: ${args.references}`);
  headers.push("Content-Type: text/plain; charset=UTF-8");
  headers.push("MIME-Version: 1.0");
  headers.push("");
  headers.push(args.body);
  return headers.join("\r\n");
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const lim = Math.max(1, Math.floor(limit));
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(items.length, lim) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function datagranApiCall(
  datagranApiKey: string,
  connectionId: string,
  method: string,
  endpoint: string,
  body?: unknown
): Promise<DatagranResult> {
  if (!datagranApiKey || !connectionId) {
    return { ok: false, error: "missing_datagran_key_or_connection" };
  }
  try {
    const url = new URL(endpoint, "https://www.datagran.io");
    if (!url.searchParams.has("connection_id")) {
      url.searchParams.set("connection_id", connectionId);
    }

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), DATAGRAN_API_TIMEOUT_MS);
    const opts: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        "x-api-key": datagranApiKey,
        "Content-Type": "application/json",
      },
      signal: ac.signal,
    };
    if (body !== undefined && opts.method !== "GET") {
      opts.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), opts);
    } finally {
      clearTimeout(timeout);
    }

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const { message, reasons } = parseDatagranErrorPayload(parsed);
      const scopeInsufficient = isDatagranScopeInsufficient(res.status, message, reasons);
      const msg = scopeInsufficient
        ? `Request had insufficient authentication scopes. (${message || "missing gmail.modify"})`
        : message || `${res.status}`;
      return {
        ok: false,
        error: msg,
        needsReauth: isDatagranAuthReauth(res.status, message, reasons),
      };
    }

    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function resolveConnectionDatagranKey(args: {
  supabase: SupabaseClient;
  userId: string;
  connectionId: string;
}): Promise<string> {
  const fallback = process.env.DATAGRAN_API_KEY || "";
  const { supabase, userId, connectionId } = args;
  const { data: row } = await supabase
    .from("datagran_agent_configs")
    .select("datagran_api_key_enc")
    .eq("user_id", userId)
    .eq("connection_id", connectionId)
    .limit(1)
    .maybeSingle();
  const enc = toTrimmed((row as { datagran_api_key_enc?: unknown } | null)?.datagran_api_key_enc);
  if (!enc) return fallback;
  try {
    return decryptLlmApiKey(enc);
  } catch {
    return fallback;
  }
}

async function ensureGroovyLabels(args: {
  datagranApiKey: string;
  connectionId: string;
}): Promise<LabelsByName> {
  const { datagranApiKey, connectionId } = args;
  const out: LabelsByName = {};
  const list = await datagranApiCall(
    datagranApiKey,
    connectionId,
    "GET",
    "/api/proxy/gmail/gmail/v1/users/me/labels"
  );
  const labelsRaw =
    list.ok && list.data && Array.isArray((list.data as { labels?: unknown }).labels)
      ? ((list.data as { labels: unknown[] }).labels as unknown[])
      : [];
  for (const raw of labelsRaw) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const id = toTrimmed(rec.id);
    const name = toTrimmed(rec.name);
    if (id && name) out[name] = id;
  }

  const needed = [
    GROOVY_LABEL_PROCESSED,
    GROOVY_LABEL_DRAFTED,
    GROOVY_LABEL_SPAM,
    GROOVY_LABEL_UNSUBSCRIBED,
  ];

  for (const name of needed) {
    if (out[name]) continue;
    const created = await datagranApiCall(
      datagranApiKey,
      connectionId,
      "POST",
      "/api/proxy/gmail/gmail/v1/users/me/labels",
      {
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      }
    );
    if (!created.ok || !created.data) continue;
    const rec = asRecord(created.data);
    const id = rec ? toTrimmed(rec.id) : "";
    if (id) out[name] = id;
  }
  return out;
}

async function modifyGmailMessageLabels(args: {
  datagranApiKey: string;
  connectionId: string;
  messageId?: string;
  threadId?: string | null;
  applyToThread?: boolean;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}): Promise<GmailLabelMutationResult> {
  const add = (args.addLabelIds || []).filter(Boolean);
  const remove = (args.removeLabelIds || []).filter(Boolean);
  const useThread = Boolean(args.applyToThread && toTrimmed(args.threadId));
  const targetId = useThread ? toTrimmed(args.threadId) : toTrimmed(args.messageId);
  if (!targetId) {
    return {
      ok: false,
      error: useThread ? "Missing Gmail thread id." : "Missing Gmail message id.",
    };
  }
  if (add.length === 0 && remove.length === 0) {
    return { ok: false, error: "No Gmail label mutations were requested." };
  }
  const endpoint = useThread
    ? `/api/proxy/gmail/gmail/v1/users/me/threads/${encodeURIComponent(targetId)}/modify`
    : `/api/proxy/gmail/gmail/v1/users/me/messages/${encodeURIComponent(targetId)}/modify`;
  const res = await datagranApiCall(
    args.datagranApiKey,
    args.connectionId,
    "POST",
    endpoint,
    {
      addLabelIds: add,
      removeLabelIds: remove,
    }
  );
  if (!res.ok) {
    return {
      ok: false,
      error: toTrimmed(res.error) || "Gmail modify failed.",
      needsReauth: res.needsReauth === true,
    };
  }
  return { ok: true };
}

async function createGmailDraft(args: {
  datagranApiKey: string;
  connectionId: string;
  threadId?: string | null;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
}): Promise<{ ok: boolean; draftId?: string; error?: string }> {
  const raw = buildDraftRaw({
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    body: args.body,
    inReplyTo: args.inReplyTo || undefined,
    references: args.references || undefined,
  });
  const payload: Record<string, unknown> = {
    message: {
      raw: toBase64Url(raw),
    },
  };
  if (args.threadId) {
    payload.message = { ...(payload.message as Record<string, unknown>), threadId: args.threadId };
  }
  const res = await datagranApiCall(
    args.datagranApiKey,
    args.connectionId,
    "POST",
    "/api/proxy/gmail/gmail/v1/users/me/drafts",
    payload
  );
  if (!res.ok) return { ok: false, error: res.error || "draft_create_failed" };
  const rec = asRecord(res.data);
  const id = rec ? toTrimmed(rec.id) : "";
  return id ? { ok: true, draftId: id } : { ok: false, error: "missing_draft_id" };
}

async function updateGmailDraft(args: {
  datagranApiKey: string;
  connectionId: string;
  draftId: string;
  threadId?: string | null;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
}): Promise<{ ok: boolean; draftId?: string; error?: string }> {
  const raw = buildDraftRaw({
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    body: args.body,
    inReplyTo: args.inReplyTo || undefined,
    references: args.references || undefined,
  });
  const payload: Record<string, unknown> = {
    id: args.draftId,
    message: {
      raw: toBase64Url(raw),
    },
  };
  if (args.threadId) {
    payload.message = { ...(payload.message as Record<string, unknown>), threadId: args.threadId };
  }
  const res = await datagranApiCall(
    args.datagranApiKey,
    args.connectionId,
    "PUT",
    `/api/proxy/gmail/gmail/v1/users/me/drafts/${encodeURIComponent(args.draftId)}`,
    payload
  );
  if (!res.ok) return { ok: false, error: res.error || "draft_update_failed" };
  const rec = asRecord(res.data);
  const id = rec ? toTrimmed(rec.id) : "";
  return id ? { ok: true, draftId: id } : { ok: false, error: "missing_draft_id" };
}

async function sendGmailDraft(args: {
  datagranApiKey: string;
  connectionId: string;
  draftId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await datagranApiCall(
    args.datagranApiKey,
    args.connectionId,
    "POST",
    "/api/proxy/gmail/gmail/v1/users/me/drafts/send",
    { id: args.draftId }
  );
  return res.ok ? { ok: true } : { ok: false, error: res.error || "draft_send_failed" };
}

function extractMessageBodyFromPayload(payload: Record<string, unknown> | null): string {
  const plainParts: string[] = [];
  const htmlParts: string[] = [];
  const walk = (part: Record<string, unknown> | null) => {
    if (!part) return;
    const mime = toTrimmed(part.mimeType).toLowerCase();
    const bodyRec = asRecord(part.body);
    const data = bodyRec ? toTrimmed(bodyRec.data) : "";
    if (data) {
      const decoded = decodeBase64Url(data);
      if (mime === "text/plain") plainParts.push(decoded);
      else if (mime === "text/html") htmlParts.push(decoded);
    }
    const parts = Array.isArray(part.parts) ? part.parts : [];
    for (const child of parts) walk(asRecord(child));
  };
  walk(payload);
  return plainParts.join("\n\n").trim() || stripHtml(htmlParts.join("\n\n")) || "";
}

async function fetchGmailMessageHeaders(args: {
  datagranApiKey: string;
  connectionId: string;
  messageId: string;
}): Promise<{ toHeader: string; ccHeader: string; fromHeader: string; messageIdHeader: string }> {
  const empty = { toHeader: "", ccHeader: "", fromHeader: "", messageIdHeader: "" };
  const messageId = toTrimmed(args.messageId);
  if (!messageId) return empty;
  const res = await datagranApiCall(
    args.datagranApiKey,
    args.connectionId,
    "GET",
    `/api/proxy/gmail/gmail/v1/users/me/messages/${encodeURIComponent(
      messageId
    )}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=From&metadataHeaders=Message-ID`
  );
  if (!res.ok || !res.data) return empty;
  const root = asRecord(res.data);
  const payload = root ? asRecord(root.payload) : null;
  const headers = Array.isArray(payload?.headers) ? payload?.headers : [];
  const byName = new Map<string, string>();
  for (const h of headers) {
    const rec = asRecord(h);
    if (!rec) continue;
    const name = normalizeKey(toTrimmed(rec.name));
    if (!name) continue;
    if (byName.has(name)) continue;
    byName.set(name, toTrimmed(rec.value));
  }
  return {
    toHeader: toTrimmed(byName.get("to") || ""),
    ccHeader: toTrimmed(byName.get("cc") || ""),
    fromHeader: toTrimmed(byName.get("from") || ""),
    messageIdHeader: toTrimmed(byName.get("message-id") || ""),
  };
}

async function fetchGmailDraftState(args: {
  datagranApiKey: string;
  connectionId: string;
  draftId: string;
}): Promise<{
  toHeader: string;
  ccHeader: string;
  subject: string;
  body: string;
  inReplyTo: string;
  references: string;
  threadId: string;
}> {
  const empty = {
    toHeader: "",
    ccHeader: "",
    subject: "",
    body: "",
    inReplyTo: "",
    references: "",
    threadId: "",
  };
  const draftId = toTrimmed(args.draftId);
  if (!draftId) return empty;
  const res = await datagranApiCall(
    args.datagranApiKey,
    args.connectionId,
    "GET",
    `/api/proxy/gmail/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=full`
  );
  if (!res.ok || !res.data) return empty;
  const root = asRecord(res.data);
  const message = root ? asRecord(root.message) : null;
  const payload = message ? asRecord(message.payload) : null;
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const byName = new Map<string, string>();
  for (const h of headers) {
    const rec = asRecord(h);
    if (!rec) continue;
    const name = normalizeKey(toTrimmed(rec.name));
    if (!name || byName.has(name)) continue;
    byName.set(name, toTrimmed(rec.value));
  }
  const bodyFromPayload = extractMessageBodyFromPayload(payload);
  const body = bodyFromPayload || toTrimmed(message?.snippet);
  return {
    toHeader: toTrimmed(byName.get("to") || ""),
    ccHeader: toTrimmed(byName.get("cc") || ""),
    subject: toTrimmed(byName.get("subject") || ""),
    body,
    inReplyTo: toTrimmed(byName.get("in-reply-to") || ""),
    references: toTrimmed(byName.get("references") || ""),
    threadId: toTrimmed(message?.threadId),
  };
}

async function fetchFullMessageAndThread(args: {
  datagranApiKey: string;
  connectionId: string;
  messageId: string;
  threadId?: string | null;
}): Promise<{ body: string; threadSummary: string; threadCandidates: ThreadMessageCandidate[] }> {
  const msgRes = await datagranApiCall(
    args.datagranApiKey,
    args.connectionId,
    "GET",
    `/api/proxy/gmail/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}?format=full`
  );
  let body = "";
  if (msgRes.ok && msgRes.data) {
    const root = asRecord(msgRes.data);
    const snippet = root ? toTrimmed(root.snippet) : "";
    const payload = root ? asRecord(root.payload) : null;
    const plainParts: string[] = [];
    const htmlParts: string[] = [];

    const walk = (part: Record<string, unknown> | null) => {
      if (!part) return;
      const mime = toTrimmed(part.mimeType).toLowerCase();
      const bodyRec = asRecord(part.body);
      const data = bodyRec ? toTrimmed(bodyRec.data) : "";
      if (data) {
        const decoded = decodeBase64Url(data);
        if (mime === "text/plain") plainParts.push(decoded);
        else if (mime === "text/html") htmlParts.push(decoded);
      }
      const parts = Array.isArray(part.parts) ? part.parts : [];
      for (const child of parts) walk(asRecord(child));
    };
    walk(payload);
    body =
      plainParts.join("\n\n").trim() ||
      stripHtml(htmlParts.join("\n\n")) ||
      snippet ||
      "";
  }

  let threadSummary = "";
  let threadCandidates: ThreadMessageCandidate[] = [];
  if (args.threadId) {
    const threadRes = await datagranApiCall(
      args.datagranApiKey,
      args.connectionId,
      "GET",
      `/api/proxy/gmail/gmail/v1/users/me/threads/${encodeURIComponent(args.threadId)}?format=full`
    );
    if (threadRes.ok && threadRes.data) {
      const thread = asRecord(threadRes.data);
      const messages = thread && Array.isArray(thread.messages) ? thread.messages : [];
      const parsedMessages: ThreadMessageCandidate[] = [];
      for (const m of messages) {
        const rec = asRecord(m);
        if (!rec) continue;
        const payload = asRecord(rec.payload);
        const headers = payload && Array.isArray(payload.headers) ? payload.headers : [];
        const byName = new Map<string, string>();
        for (const h of headers) {
          const hRec = asRecord(h);
          if (!hRec) continue;
          const name = normalizeKey(toTrimmed(hRec.name));
          if (!name || byName.has(name)) continue;
          byName.set(name, toTrimmed(hRec.value));
        }
        const candidate: ThreadMessageCandidate = {
          gmailMessageId: toTrimmed(rec.id),
          threadId: toTrimmed(rec.threadId) || toTrimmed(thread?.id) || toTrimmed(args.threadId),
          from: toTrimmed(byName.get("from") || ""),
          to: toTrimmed(byName.get("to") || ""),
          cc: toTrimmed(byName.get("cc") || ""),
          subject: toTrimmed(byName.get("subject") || ""),
          date: toTrimmed(byName.get("date") || ""),
          snippet: toTrimmed(rec.snippet),
          messageIdHeader: toTrimmed(byName.get("message-id") || ""),
        };
        if (!candidate.gmailMessageId && !candidate.messageIdHeader) continue;
        parsedMessages.push(candidate);
      }

      threadCandidates = parsedMessages.slice(-10);
      const snippets = parsedMessages.slice(-3).map((m) =>
        [m.from ? `From=${m.from}` : "", m.subject ? `Subject=${m.subject}` : "", m.snippet ? `Snippet=${m.snippet}` : ""]
          .filter(Boolean)
          .join(" | ")
      );
      threadSummary = snippets.join("\n");
    }
  }

  return {
    body: body.slice(0, STAGE_B_MAX_BODY_CHARS),
    threadSummary: threadSummary.slice(0, 3000),
    threadCandidates,
  };
}

async function fetchSenderIntel(args: {
  supabase: SupabaseClient;
  userId: string;
  sender: SenderInfo;
}): Promise<SenderIntel> {
  const domain = normalizeKey(args.sender.domain);
  if (!domain) {
    return {
      domain: "",
      reputation: "neutral",
      confidence: 0.3,
      summary: "No sender domain detected.",
      signals: {},
    };
  }

  const nowIso = new Date().toISOString();
  const { data: cached } = await args.supabase
    .from("email_sender_intel_cache")
    .select("reputation,confidence,summary,signals,expires_at")
    .eq("user_id", args.userId)
    .eq("sender_domain", domain)
    .maybeSingle();

  if (cached) {
    const expiresAt = toTrimmed((cached as { expires_at?: unknown }).expires_at);
    if (!expiresAt || Date.parse(expiresAt) > Date.now()) {
      const rec = asRecord(cached);
      return {
        domain,
        reputation:
          normalizeKey(toTrimmed(rec?.reputation)) === "trusted"
            ? "trusted"
            : normalizeKey(toTrimmed(rec?.reputation)) === "risky"
              ? "risky"
              : "neutral",
        confidence: clamp01(Number(rec?.confidence || 0.5)),
        summary: toTrimmed(rec?.summary) || "Cached sender intel.",
        signals: asRecord(rec?.signals) || {},
      };
    }
  }

  // Lightweight no-key web lookup (DuckDuckGo instant answer API).
  let summary = "";
  let reputation: SenderIntel["reputation"] = "neutral";
  let confidence = 0.45;
  const signals: Record<string, unknown> = {};
  let intelTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const query = encodeURIComponent(`${domain} company reputation email spam`);
    const ddgUrl = `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`;
    const ac = new AbortController();
    intelTimer = setTimeout(() => ac.abort(), SENDER_INTEL_TIMEOUT_MS);
    const res = await fetch(ddgUrl, { method: "GET", signal: ac.signal });
    if (!res.ok) throw new Error(`ddg_status_${res.status}`);
    const json = await res.json().catch(() => null);
    const rec = asRecord(json);
    const abstract = toTrimmed(rec?.AbstractText);
    const heading = toTrimmed(rec?.Heading);
    const related = Array.isArray(rec?.RelatedTopics) ? rec?.RelatedTopics : [];
    const relText = related
      .slice(0, 3)
      .map((r) => toTrimmed((asRecord(r) || {}).Text))
      .filter(Boolean)
      .join(" | ");
    summary = [heading, abstract, relText].filter(Boolean).join(" — ");
    if (!summary) {
      summary = `No strong public summary found for ${domain}.`;
    }
    const low = summary.toLowerCase();
    if (/\bscam|phishing|spam|fraud|lawsuit|blacklist\b/.test(low)) {
      reputation = "risky";
      confidence = 0.75;
      signals.risk_keywords = true;
    } else if (/\binc\.|official|wikipedia|linkedin|crunchbase|company\b/.test(low)) {
      reputation = "trusted";
      confidence = 0.65;
      signals.public_presence = true;
    }
  } catch {
    summary = `Unable to fetch live web intel for ${domain}.`;
    reputation = "neutral";
    confidence = 0.35;
  } finally {
    if (intelTimer) clearTimeout(intelTimer);
  }

  await args.supabase.from("email_sender_intel_cache").upsert(
    {
      user_id: args.userId,
      sender_domain: domain,
      sender_email: args.sender.email || null,
      reputation,
      confidence,
      summary,
      signals,
      source: "ddg_instant_answer",
      fetched_at: nowIso,
      expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      updated_at: nowIso,
    },
    { onConflict: "user_id,sender_domain" }
  );

  return { domain, reputation, confidence, summary, signals };
}

async function fetchSenderAffinity(args: {
  supabase: SupabaseClient;
  userId: string;
  connectionId: string;
  datagranApiKey: string;
  senderEmail: string;
}): Promise<SenderAffinity> {
  const senderEmail = normalizeKey(args.senderEmail);
  if (!senderEmail) {
    return {
      senderEmail: "",
      incomingCount: 0,
      repliedCount: 0,
      lastReceivedAt: null,
      lastRepliedAt: null,
    };
  }

  const nowIso = new Date().toISOString();
  const { data: cached } = await args.supabase
    .from("email_sender_affinity_cache")
    .select("incoming_count,replied_count,last_received_at,last_replied_at,expires_at")
    .eq("user_id", args.userId)
    .eq("connection_id", args.connectionId)
    .eq("sender_email", senderEmail)
    .maybeSingle();

  if (cached) {
    const expiresAt = toTrimmed((cached as { expires_at?: unknown }).expires_at);
    if (!expiresAt || Date.parse(expiresAt) > Date.now()) {
      const rec = asRecord(cached);
      return {
        senderEmail,
        incomingCount: Number(rec?.incoming_count || 0),
        repliedCount: Number(rec?.replied_count || 0),
        lastReceivedAt: toTrimmed(rec?.last_received_at) || null,
        lastRepliedAt: toTrimmed(rec?.last_replied_at) || null,
      };
    }
  }

  const incomingRes = await datagranApiCall(
    args.datagranApiKey,
    args.connectionId,
    "GET",
    `/api/proxy/gmail/gmail/v1/users/me/messages?q=${encodeURIComponent(
      `from:${senderEmail} newer_than:3y`
    )}&maxResults=25`
  );
  const repliedRes = await datagranApiCall(
    args.datagranApiKey,
    args.connectionId,
    "GET",
    `/api/proxy/gmail/gmail/v1/users/me/messages?q=${encodeURIComponent(
      `to:${senderEmail} newer_than:3y in:sent`
    )}&maxResults=25`
  );

  const incomingCount =
    incomingRes.ok &&
    incomingRes.data &&
    Array.isArray((incomingRes.data as { messages?: unknown }).messages)
      ? ((incomingRes.data as { messages: unknown[] }).messages || []).length
      : 0;
  const repliedCount =
    repliedRes.ok &&
    repliedRes.data &&
    Array.isArray((repliedRes.data as { messages?: unknown }).messages)
      ? ((repliedRes.data as { messages: unknown[] }).messages || []).length
      : 0;

  await args.supabase.from("email_sender_affinity_cache").upsert(
    {
      user_id: args.userId,
      connection_id: args.connectionId,
      sender_email: senderEmail,
      incoming_count: incomingCount,
      replied_count: repliedCount,
      fetched_at: nowIso,
      expires_at: new Date(Date.now() + 12 * 60 * 60_000).toISOString(),
      updated_at: nowIso,
    },
    { onConflict: "user_id,connection_id,sender_email" }
  );

  return {
    senderEmail,
    incomingCount,
    repliedCount,
    lastReceivedAt: null,
    lastRepliedAt: null,
  };
}

async function runStageBPolicy(args: {
  policyModel: HeartbeatPolicyModel;
  item: TriageEmailItem;
  sender: SenderInfo;
  intel: SenderIntel;
  affinity: SenderAffinity;
  fullBody: string;
  threadSummary: string;
  threadCandidates: ThreadMessageCandidate[];
  memoryContext?: string;
  preferenceContext?: string;
}): Promise<PolicyDecision | null> {
  const model = resolveChatModel(
    args.policyModel.provider,
    args.policyModel.modelName,
    args.policyModel.apiKey ? { apiKey: args.policyModel.apiKey } : undefined
  );
  const providerOptions = getAnthropicReasoningProviderOptions(
    args.policyModel.provider,
    args.policyModel.modelName,
    { enableThinking: true }
  );
  const memorySnippet = toTrimmed(args.memoryContext || "").slice(0, 1800);
  const prefSnippet = toTrimmed(args.preferenceContext || "").slice(0, 1200);
  const threadCandidatesText = formatThreadCandidatesForPolicy(args.threadCandidates);
  const prompt = `You are Groovy's email triage model.
${prefSnippet ? `\nUSER PREFERENCES (HIGHEST PRIORITY):\nThe user has standing exclusion rules. If this email matches an excluded category, sender, or topic below, set action to "archive" with auto_execute true and confidence 0.95.\n${prefSnippet}\n` : ""}
Return ONLY JSON with this shape:
{
  "action":"draft_reply|mark_spam|unsubscribe|archive|label_only",
  "auto_execute": true|false,
  "confidence":0..1,
  "p_important":0..1,
  "p_spam":0..1,
  "p_actionable":0..1,
  "critical":true|false,
  "reason":"short reason",
  "draft_reply":"reply draft when action is draft_reply, else empty",
  "target_thread_id":"thread id from candidates when action is draft_reply, else empty",
  "target_message_id_header":"Message-ID header from candidates when action is draft_reply, else empty",
  "target_reason":"short reason for target selection when action is draft_reply"
}

Sender:
- from: ${args.item.from}
- sender_email: ${args.sender.email}
- sender_domain: ${args.sender.domain}
- sender_intel: ${args.intel.summary}
- sender_reputation: ${args.intel.reputation}
- prior_incoming_count: ${args.affinity.incomingCount}
- prior_replied_count: ${args.affinity.repliedCount}

Email metadata:
- subject: ${args.item.subject}
- to: ${args.item.to}
- cc: ${args.item.cc}
- date: ${args.item.date}
- list_unsubscribe: ${args.item.listUnsubscribe || "(none)"}
- snippet: ${args.item.snippet}

Thread context:
${args.threadSummary || "(none)"}

Reply target candidates (current thread only):
${threadCandidatesText}

Full email body:
${args.fullBody || "(empty)"}

Relevant memory context:
${memorySnippet || "(none)"}

Constraints:
- auto_execute MUST be false when action is draft_reply or unsubscribe.
- action="archive" means low-priority but legitimate email that should stay visible in the inbox while being marked as processed.
- Only use mark_spam or unsubscribe for junk, spam, or mailing-list style email that should leave the inbox.
- If action is draft_reply, draft_reply must be non-empty plain text (no HTML).
- If action is draft_reply, choose exactly one candidate and copy its thread_id + message_id_header exactly.
- Never invent thread ids or Message-ID headers.
- If candidates are missing or ambiguous for draft_reply, use action="label_only".
- Keep reason short and concrete.`;

  try {
    const out = await generateText({
      model,
      prompt,
      providerOptions,
    });
    const parsed = extractJsonObject(out.text || "");
    if (!parsed) return null;
    const actionRaw = normalizeKey(toTrimmed(parsed.action));
    const action: ActionType =
      actionRaw === "draft_reply" ||
      actionRaw === "mark_spam" ||
      actionRaw === "unsubscribe" ||
      actionRaw === "archive" ||
      actionRaw === "label_only"
        ? actionRaw
        : "label_only";
    const autoExecuteRaw = parsed.auto_execute === true;
    const autoExecute = autoExecuteRaw && action !== "draft_reply" && action !== "unsubscribe";
    return {
      action,
      confidence: clamp01(Number(parsed.confidence ?? 0.5)),
      pImportant: clamp01(Number(parsed.p_important ?? 0.5)),
      pSpam: clamp01(Number(parsed.p_spam ?? 0.5)),
      pActionable: clamp01(Number(parsed.p_actionable ?? 0.5)),
      reason: toTrimmed(parsed.reason) || "Policy model decision.",
      critical: Boolean(parsed.critical),
      draftReply: toTrimmed(parsed.draft_reply || ""),
      targetThreadId: toTrimmed(parsed.target_thread_id || "") || undefined,
      targetMessageIdHeader: toTrimmed(parsed.target_message_id_header || "") || undefined,
      targetReason: toTrimmed(parsed.target_reason || "") || undefined,
      autoExecute,
    };
  } catch {
    return null;
  }
}

function resolveDraftTarget(args: {
  decision: PolicyDecision;
  item: TriageEmailItem;
  threadCandidates: ThreadMessageCandidate[];
}): { ok: true; candidate: ThreadMessageCandidate; reason: string } | { ok: false; reason: string } {
  const currentThreadId = toTrimmed(args.item.threadId);
  const candidates = (args.threadCandidates || []).filter(
    (c) => toTrimmed(c.messageIdHeader) && toTrimmed(c.threadId || currentThreadId)
  );
  if (candidates.length === 0) {
    return { ok: false, reason: "No thread candidates with Message-ID were available." };
  }

  const selectedMessageId = normalizeMessageIdHeader(toTrimmed(args.decision.targetMessageIdHeader || ""));
  if (!selectedMessageId) {
    return { ok: false, reason: "Model did not provide target_message_id_header." };
  }

  const matches = candidates.filter((c) => normalizeMessageIdHeader(c.messageIdHeader) === selectedMessageId);
  if (matches.length !== 1) {
    return { ok: false, reason: "Model selected an unknown or non-unique target message." };
  }

  const candidate = matches[0];
  const selectedThreadId = toTrimmed(args.decision.targetThreadId || "");
  const candidateThreadId = toTrimmed(candidate.threadId || currentThreadId);
  if (selectedThreadId && candidateThreadId && selectedThreadId !== candidateThreadId) {
    return { ok: false, reason: "Model target thread did not match the selected message." };
  }
  if (currentThreadId && candidateThreadId && candidateThreadId !== currentThreadId) {
    return { ok: false, reason: "Model selected a message outside the current thread." };
  }

  return {
    ok: true,
    candidate: {
      ...candidate,
      threadId: candidateThreadId,
    },
    reason: toTrimmed(args.decision.targetReason || "") || "Model selected a thread reply anchor.",
  };
}

async function insertInboxAction(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId?: string | null;
  sessionId?: string | null;
  sourceJobId?: string | null;
  runId: string;
  item: TriageEmailItem;
  sender: SenderInfo;
  decision: PolicyDecision;
  draft?: { to: string[]; cc?: string[]; subject: string; body: string; gmailDraftId?: string | null } | null;
  metadata?: Record<string, unknown>;
  status?: ActionStatus;
}): Promise<InsertInboxActionResult | null> {
  const existing = await args.supabase
    .from("inbox_actions")
    .select("*")
    .eq("user_id", args.userId)
    .eq("provider", "gmail")
    .eq("connection_id", args.item.connectionId)
    .eq("gmail_message_id", args.item.id)
    .eq("recommended_action", args.decision.action)
    .maybeSingle();

  if (existing.data) {
    const row = rowToInboxAction(existing.data);
    return row ? { row, inserted: false } : null;
  }

  const payload: Record<string, unknown> = {
    user_id: args.userId,
    agent_id: args.agentId || null,
    session_id: args.sessionId || null,
    source_job_id: args.sourceJobId || null,
    run_id: args.runId,
    provider: "gmail",
    connection_id: args.item.connectionId,
    mailbox_label: args.item.mailboxLabel,
    gmail_message_id: args.item.id,
    gmail_thread_id: args.item.threadId || null,
    gmail_draft_id: args.draft?.gmailDraftId || null,
    sender_email: args.sender.email || null,
    sender_name: args.sender.name || null,
    sender_domain: args.sender.domain || null,
    subject: args.item.subject || null,
    snippet: args.item.snippet || null,
    received_at: args.item.date ? new Date(args.item.date).toISOString() : null,
    recommended_action: args.decision.action,
    status: args.status || "pending",
    confidence: args.decision.confidence,
    p_important: args.decision.pImportant,
    p_spam: args.decision.pSpam,
    p_actionable: args.decision.pActionable,
    reason: args.decision.reason,
    draft_to: args.draft ? args.draft.to : null,
    draft_subject: args.draft?.subject || null,
    draft_body: args.draft?.body || null,
    metadata: args.metadata || {},
  };

  const inserted = await args.supabase.from("inbox_actions").insert(payload).select("*").maybeSingle();
  if (inserted.data) {
    const row = rowToInboxAction(inserted.data);
    return row ? { row, inserted: true } : null;
  }

  if (inserted.error && /duplicate key|unique/i.test(inserted.error.message || "")) {
    const reRead = await args.supabase
      .from("inbox_actions")
      .select("*")
      .eq("user_id", args.userId)
      .eq("provider", "gmail")
      .eq("connection_id", args.item.connectionId)
      .eq("gmail_message_id", args.item.id)
      .eq("recommended_action", args.decision.action)
      .maybeSingle();
    const row = rowToInboxAction(reRead.data);
    if (row) return { row, inserted: false };

    if (args.decision.action === "draft_reply" && args.item.threadId) {
      const reReadThread = await args.supabase
        .from("inbox_actions")
        .select("*")
        .eq("user_id", args.userId)
        .eq("provider", "gmail")
        .eq("connection_id", args.item.connectionId)
        .eq("gmail_thread_id", args.item.threadId)
        .eq("recommended_action", "draft_reply")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const threadRow = rowToInboxAction(reReadThread.data);
      if (threadRow) return { row: threadRow, inserted: false };
    }
  }
  return null;
}

async function findExistingDraftReplyAction(args: {
  supabase: SupabaseClient;
  userId: string;
  connectionId: string;
  messageId: string;
  threadId?: string | null;
}): Promise<InboxActionRow | null> {
  const messageId = toTrimmed(args.messageId);
  if (messageId) {
    const byMessage = await args.supabase
      .from("inbox_actions")
      .select("*")
      .eq("user_id", args.userId)
      .eq("provider", "gmail")
      .eq("connection_id", args.connectionId)
      .eq("gmail_message_id", messageId)
      .eq("recommended_action", "draft_reply")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = rowToInboxAction(byMessage.data);
    if (row) return row;
  }

  const threadId = toTrimmed(args.threadId);
  if (!threadId) return null;
  const byThread = await args.supabase
    .from("inbox_actions")
    .select("*")
    .eq("user_id", args.userId)
    .eq("provider", "gmail")
    .eq("connection_id", args.connectionId)
    .eq("gmail_thread_id", threadId)
    .eq("recommended_action", "draft_reply")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return rowToInboxAction(byThread.data);
}

function rowToInboxAction(v: unknown): InboxActionRow | null {
  const r = asRecord(v);
  if (!r) return null;
  const id = toTrimmed(r.id);
  const userId = toTrimmed(r.user_id);
  const connectionId = toTrimmed(r.connection_id);
  const messageId = toTrimmed(r.gmail_message_id);
  const action = normalizeKey(toTrimmed(r.recommended_action)) as ActionType;
  const status = normalizeKey(toTrimmed(r.status)) as ActionStatus;
  if (!id || !userId || !connectionId || !messageId) return null;
  if (!["draft_reply", "mark_spam", "unsubscribe", "archive", "label_only"].includes(action)) return null;
  if (!["pending", "approved", "executing", "done", "rejected", "failed"].includes(status)) return null;
  return {
    id,
    user_id: userId,
    agent_id: toTrimmed(r.agent_id) || null,
    session_id: toTrimmed(r.session_id) || null,
    source_job_id: toTrimmed(r.source_job_id) || null,
    run_id: toTrimmed(r.run_id) || null,
    provider: toTrimmed(r.provider) || "gmail",
    connection_id: connectionId,
    mailbox_label: toTrimmed(r.mailbox_label) || null,
    gmail_message_id: messageId,
    gmail_thread_id: toTrimmed(r.gmail_thread_id) || null,
    gmail_draft_id: toTrimmed(r.gmail_draft_id) || null,
    sender_email: toTrimmed(r.sender_email) || null,
    sender_name: toTrimmed(r.sender_name) || null,
    sender_domain: toTrimmed(r.sender_domain) || null,
    subject: toTrimmed(r.subject) || null,
    snippet: toTrimmed(r.snippet) || null,
    recommended_action: action,
    status,
    confidence: Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null,
    p_important: Number.isFinite(Number(r.p_important)) ? Number(r.p_important) : null,
    p_spam: Number.isFinite(Number(r.p_spam)) ? Number(r.p_spam) : null,
    p_actionable: Number.isFinite(Number(r.p_actionable)) ? Number(r.p_actionable) : null,
    reason: toTrimmed(r.reason) || null,
    draft_to: r.draft_to,
    draft_subject: toTrimmed(r.draft_subject) || null,
    draft_body: toTrimmed(r.draft_body) || null,
    metadata: r.metadata,
    created_at: toTrimmed(r.created_at),
    updated_at: toTrimmed(r.updated_at),
  };
}

async function tryAcquireActionExecutionLock(args: {
  supabase: SupabaseClient;
  actionId: string;
  userId: string;
}): Promise<InboxActionRow | null> {
  const nowIso = new Date().toISOString();
  const res = await args.supabase
    .from("inbox_actions")
    .update({ status: "executing", updated_at: nowIso })
    .eq("id", args.actionId)
    .eq("user_id", args.userId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  return rowToInboxAction(res.data);
}

function describeGmailMutationFailure(base: string, mutation: GmailLabelMutationResult): string {
  const err = toTrimmed(mutation.error);
  const low = err.toLowerCase();
  if (!err) return base;
  if (low.includes("no gmail label mutations were requested")) {
    return `${base} Groovy labels are unavailable for this mailbox. Reconnect Gmail with write scopes and retry.`;
  }
  if (
    mutation.needsReauth ||
    low.includes("insufficient authentication scopes") ||
    low.includes("insufficient permission") ||
    low.includes("gmail.modify")
  ) {
    return `${base} Gmail connection is missing write permission (gmail.modify). Reconnect Gmail in Integrations, then retry.`;
  }
  return `${base} ${err}`;
}

async function completeAction(args: {
  supabase: SupabaseClient;
  actionId: string;
  userId: string;
  status: "done" | "failed" | "rejected";
  extra?: Record<string, unknown>;
}) {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: args.status,
    updated_at: nowIso,
  };
  if (args.status === "done") patch.executed_at = nowIso;
  if (args.extra) {
    patch.metadata = args.extra;
  }
  await args.supabase
    .from("inbox_actions")
    .update(patch)
    .eq("id", args.actionId)
    .eq("user_id", args.userId);
}

async function executeInboxAction(args: {
  supabase: SupabaseClient;
  row: InboxActionRow;
  datagranApiKey: string;
  labels: LabelsByName;
}): Promise<ExecuteActionResult> {
  const { row, datagranApiKey, labels } = args;
  const processed = labels[GROOVY_LABEL_PROCESSED];
  const spamLabel = labels[GROOVY_LABEL_SPAM];
  const unsubLabel = labels[GROOVY_LABEL_UNSUBSCRIBED];
  const connectionId = row.connection_id;
  const messageId = row.gmail_message_id;

  if (row.recommended_action === "draft_reply") {
    let draftId = row.gmail_draft_id;
    const meta = asRecord(row.metadata) || {};
    const liveHeaders = await fetchGmailMessageHeaders({
      datagranApiKey,
      connectionId,
      messageId,
    });
    const liveDraft = draftId
      ? await fetchGmailDraftState({
          datagranApiKey,
          connectionId,
          draftId,
        })
      : null;
    const targetFromHeader = toTrimmed(meta.target_from_header) || "";
    const targetToHeader = toTrimmed(meta.target_to_header) || "";
    const targetCcHeader = toTrimmed(meta.target_cc_header) || "";
    const senderFromLive = parseSender(targetFromHeader || liveHeaders.fromHeader).email;
    const senderEmail = senderFromLive || row.sender_email || "";
    const userEmail = toTrimmed(meta.user_email) || null;
    const originalToHeader = targetToHeader || toTrimmed(meta.original_to_header) || liveHeaders.toHeader;
    const originalCcHeader = targetCcHeader || toTrimmed(meta.original_cc_header) || liveHeaders.ccHeader;
    const replyAll = buildReplyAllRecipients({
      senderEmail,
      toHeader: originalToHeader,
      ccHeader: originalCcHeader,
      userEmail,
    });
    const mergedRecipients = mergeRecipients({
      to: [...listRecipientEmails(liveDraft?.toHeader), ...listRecipientEmails(row.draft_to), ...replyAll.to],
      cc: [...listRecipientEmails(liveDraft?.ccHeader), ...listRecipientEmails(meta.draft_cc), ...replyAll.cc],
      senderEmail,
      userEmail,
    });
    const toList = mergedRecipients.to.length > 0 ? mergedRecipients.to : senderEmail ? [senderEmail] : [];
    const ccList = mergedRecipients.cc;
    const to = toList.join(", ");
    const cc = ccList.join(", ");
    const subject = toTrimmed(liveDraft?.subject) || row.draft_subject || `Re: ${row.subject || ""}`;
    const bodyText = toTrimmed(liveDraft?.body) || toTrimmed(row.draft_body);
    if (!bodyText) return { ok: false, detail: "Draft body is empty. Edit the draft text first." };
    const body = appendGroovyEmailSendNotice(bodyText);
    const targetMessageIdHeader = toTrimmed(meta.target_message_id_header) || null;
    const targetThreadId = toTrimmed(meta.target_thread_id) || null;
    const messageIdHeader =
      targetMessageIdHeader ||
      toTrimmed(meta.message_id_header) ||
      toTrimmed(liveDraft?.inReplyTo) ||
      toTrimmed(liveDraft?.references) ||
      liveHeaders.messageIdHeader ||
      null;
    const referencesHeader = toTrimmed(liveDraft?.references) || messageIdHeader || null;
    const threadIdForDraft = toTrimmed(liveDraft?.threadId) || targetThreadId || row.gmail_thread_id;
    if (!to) return { ok: false, detail: "Draft action has no recipient." };
    if (!draftId && !threadIdForDraft) {
      return {
        ok: false,
        detail: "Draft target thread is missing. Re-run triage so Groovy can pick a valid reply thread.",
      };
    }

    if (!draftId) {
      const created = await createGmailDraft({
        datagranApiKey,
        connectionId,
        threadId: threadIdForDraft,
        to,
        cc,
        subject,
        body,
        inReplyTo: messageIdHeader,
        references: referencesHeader,
      });
      if (!created.ok || !created.draftId) {
        return { ok: false, detail: created.error || "Failed to create missing draft before send." };
      }
      draftId = created.draftId;
    } else {
      const updated = await updateGmailDraft({
        datagranApiKey,
        connectionId,
        draftId,
        threadId: threadIdForDraft,
        to,
        cc,
        subject,
        body,
        inReplyTo: messageIdHeader,
        references: referencesHeader,
      });
      if (!updated.ok) {
        return { ok: false, detail: updated.error || "Failed to update draft before send." };
      }
      draftId = updated.draftId || draftId;
    }
    if (!draftId) {
      return { ok: false, detail: "Draft action has no Gmail draft id." };
    }
    const persistedTargetThreadId = threadIdForDraft || targetThreadId || null;
    const nextMeta: Record<string, unknown> = {
      ...meta,
      user_email: userEmail || null,
      original_to_header: originalToHeader || null,
      original_cc_header: originalCcHeader || null,
      draft_cc: ccList,
      ...(targetFromHeader ? { target_from_header: targetFromHeader } : {}),
      ...(targetToHeader ? { target_to_header: targetToHeader } : {}),
      ...(targetCcHeader ? { target_cc_header: targetCcHeader } : {}),
      ...(persistedTargetThreadId ? { target_thread_id: persistedTargetThreadId } : {}),
      ...(targetMessageIdHeader ? { target_message_id_header: targetMessageIdHeader } : {}),
      ...(messageIdHeader ? { message_id_header: messageIdHeader } : {}),
    };
    await args.supabase
      .from("inbox_actions")
      .update({
        gmail_draft_id: draftId,
        draft_to: toList,
        draft_subject: subject,
        draft_body: body,
        metadata: nextMeta,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("user_id", row.user_id);
    const sent = await sendGmailDraft({
      datagranApiKey,
      connectionId,
      draftId,
    });
    if (!sent.ok) return { ok: false, detail: sent.error || "Failed to send draft." };
    await modifyGmailMessageLabels({
      datagranApiKey,
      connectionId,
      messageId,
      addLabelIds: [processed].filter(Boolean),
      removeLabelIds: [],
    });
    return { ok: true, detail: "Draft approved and sent." };
  }

  if (row.recommended_action === "mark_spam") {
    const mutation = await modifyGmailMessageLabels({
      datagranApiKey,
      connectionId,
      messageId,
      threadId: row.gmail_thread_id,
      applyToThread: true,
      addLabelIds: ["SPAM", spamLabel, processed].filter(Boolean),
      removeLabelIds: ["INBOX"],
    });
    return mutation.ok
      ? { ok: true, detail: "Marked as spam." }
      : { ok: false, detail: describeGmailMutationFailure("Failed to mark as spam.", mutation) };
  }

  if (row.recommended_action === "unsubscribe") {
    const meta = asRecord(row.metadata) || {};
    const unsub = asRecord(meta.list_unsubscribe || {});
    const unsubUrl = unsub ? toTrimmed(unsub.url) : "";
    const unsubMailto = unsub ? toTrimmed(unsub.mailto) : "";
    const mutation = await modifyGmailMessageLabels({
      datagranApiKey,
      connectionId,
      messageId,
      threadId: row.gmail_thread_id,
      applyToThread: true,
      addLabelIds: [unsubLabel, processed].filter(Boolean),
      removeLabelIds: ["INBOX"],
    });
    if (!mutation.ok) {
      return {
        ok: false,
        detail: describeGmailMutationFailure("Failed to archive/unsubscribe label.", mutation),
      };
    }
    const connectorExecutes = buildUnsubscribeConnectorExec({
      row,
      unsubscribeUrl: unsubUrl,
      unsubscribeMailto: unsubMailto,
    });
    return {
      ok: true,
      detail:
        connectorExecutes.length > 0
          ? "Archived and labeled unsubscribed. Local unsubscribe execution queued."
          : "Archived and labeled unsubscribed.",
      connectorExecutes: connectorExecutes.length > 0 ? connectorExecutes : undefined,
    };
  }

  if (row.recommended_action === "archive") {
    const mutation = await modifyGmailMessageLabels({
      datagranApiKey,
      connectionId,
      messageId,
      threadId: row.gmail_thread_id,
      applyToThread: true,
      addLabelIds: [processed].filter(Boolean),
      removeLabelIds: [],
    });
    return mutation.ok
      ? { ok: true, detail: "Kept in inbox and labeled as processed." }
      : { ok: false, detail: describeGmailMutationFailure("Failed to keep in inbox.", mutation) };
  }

  const mutation = await modifyGmailMessageLabels({
    datagranApiKey,
    connectionId,
    messageId,
    addLabelIds: [processed].filter(Boolean),
    removeLabelIds: [],
  });
  return mutation.ok
    ? { ok: true, detail: "Labeled as processed." }
    : { ok: false, detail: describeGmailMutationFailure("Failed to apply labels.", mutation) };
}

function buildUnsubscribeConnectorExec(args: {
  row: InboxActionRow;
  unsubscribeUrl?: string;
  unsubscribeMailto?: string;
}): InboxCommandConnectorExecute[] {
  const unsubscribeUrl = toTrimmed(args.unsubscribeUrl);
  const unsubscribeMailto = toTrimmed(args.unsubscribeMailto);
  if (!unsubscribeUrl && !unsubscribeMailto) return [];
  const subject = toTrimmed(args.row.subject) || "(no subject)";
  return [
    {
      toolCallId: `inbox-unsub-${args.row.id}`,
      toolName: "inbox_unsubscribe_execute",
      agent: "files",
      connectorType: "email_unsubscribe_execute",
      connectorParams: {
        action_id: args.row.id,
        sender_email: args.row.sender_email || "",
        subject,
        mailbox_label: args.row.mailbox_label || "",
        gmail_message_id: args.row.gmail_message_id,
        unsubscribe_url: unsubscribeUrl || null,
        unsubscribe_mailto: unsubscribeMailto || null,
      },
      message: `Completing unsubscribe locally for "${subject}"...`,
    },
  ];
}

async function syncSessionAliases(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  actionIds: string[];
}): Promise<Array<{ alias: number; actionId: string }>> {
  const dedup = Array.from(new Set(args.actionIds.filter(Boolean)));
  const existingAliasByAction = new Map<string, number>();
  const aliasOwners = new Map<number, Set<string>>();
  let maxAlias = 0;
  if (dedup.length > 0) {
    const actionAliasRes = await args.supabase
      .from("inbox_action_aliases_agent")
      .select("alias,action_id")
      .eq("user_id", args.userId)
      .in("action_id", dedup);
    const actionAliasRows = (actionAliasRes.data || [])
      .map((row) => ({
        alias: Number((row as { alias?: unknown }).alias),
        actionId: toTrimmed((row as { action_id?: unknown }).action_id),
      }))
      .filter((row) => Number.isFinite(row.alias) && row.alias > 0 && row.actionId);
    for (const row of actionAliasRows) {
      if (!existingAliasByAction.has(row.actionId)) {
        existingAliasByAction.set(row.actionId, row.alias);
      }
    }

    const candidateAliases = Array.from(new Set(actionAliasRows.map((row) => row.alias)));
    if (candidateAliases.length > 0) {
      const aliasOwnerRes = await args.supabase
        .from("inbox_action_aliases_agent")
        .select("alias,action_id")
        .eq("user_id", args.userId)
        .in("alias", candidateAliases)
        .limit(COMMAND_LIST_MAX_ROWS * 500);
      const ownerRows = (aliasOwnerRes.data || [])
        .map((row) => ({
          alias: Number((row as { alias?: unknown }).alias),
          actionId: toTrimmed((row as { action_id?: unknown }).action_id),
        }))
        .filter((row) => Number.isFinite(row.alias) && row.alias > 0 && row.actionId);
      for (const row of ownerRows) {
        const owners = aliasOwners.get(row.alias) || new Set<string>();
        owners.add(row.actionId);
        aliasOwners.set(row.alias, owners);
      }
    }
  }

  const maxAliasRes = await args.supabase
    .from("inbox_action_aliases_agent")
    .select("alias")
    .eq("user_id", args.userId)
    .order("alias", { ascending: false })
    .limit(1);
  const maxAliasRaw = Number((maxAliasRes.data?.[0] as { alias?: unknown } | undefined)?.alias);
  if (Number.isFinite(maxAliasRaw) && maxAliasRaw > 0) {
    maxAlias = Math.floor(maxAliasRaw);
  }

  const usedAliases = new Set<number>();
  const mappings: Array<{ alias: number; actionId: string }> = [];
  for (const actionId of dedup) {
    const keptAlias = existingAliasByAction.get(actionId);
    const keptAliasOwners = keptAlias ? aliasOwners.get(keptAlias) : null;
    const canKeepAlias =
      Boolean(keptAlias) &&
      !usedAliases.has(keptAlias as number) &&
      Boolean(
        keptAliasOwners &&
          keptAliasOwners.size === 1 &&
          keptAliasOwners.has(actionId)
      );
    if (canKeepAlias && keptAlias) {
      mappings.push({ alias: keptAlias, actionId });
      usedAliases.add(keptAlias);
      continue;
    }
    maxAlias += 1;
    while (usedAliases.has(maxAlias)) {
      maxAlias += 1;
    }
    mappings.push({ alias: maxAlias, actionId });
    usedAliases.add(maxAlias);
  }

  // Replace all mappings for this agent scope and move action-owned aliases from
  // any other agent scope into the target scope.
  await args.supabase
    .from("inbox_action_aliases_agent")
    .delete()
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId);
  if (dedup.length > 0) {
    await args.supabase
      .from("inbox_action_aliases_agent")
      .delete()
      .eq("user_id", args.userId)
      .in("action_id", dedup);
  }

  for (const m of mappings.sort((a, b) => a.alias - b.alias)) {
    await args.supabase.from("inbox_action_aliases_agent").insert({
      user_id: args.userId,
      agent_id: args.agentId,
      alias: m.alias,
      action_id: m.actionId,
      updated_at: new Date().toISOString(),
    });
  }

  return mappings;
}

async function markDraftSendConfirmationPending(args: {
  supabase: SupabaseClient;
  row: InboxActionRow;
  userId: string;
  alias: number;
}) {
  const nowIso = new Date().toISOString();
  const meta = asRecord(args.row.metadata) || {};
  await args.supabase
    .from("inbox_actions")
    .update({
      metadata: {
        ...meta,
        approved_via: "command",
        send_confirmation_required: true,
        send_confirmation_pending: true,
        send_confirmation_requested_at: nowIso,
        send_confirmation_alias: args.alias,
      },
      updated_at: nowIso,
    })
    .eq("id", args.row.id)
    .eq("user_id", args.userId)
    .eq("status", "pending");
}

function formatActionForHeartbeat(alias: number, row: InboxActionRow): string {
  const mailbox = shortMailboxLabel(row.mailbox_label || "");
  const subject = row.subject || "(no subject)";
  const action = row.recommended_action;
  if (action === "draft_reply") {
    const meta = asRecord(row.metadata) || {};
    const sendPending = meta.send_confirmation_pending === true;
    const preview = (row.draft_body || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, HEARTBEAT_DRAFT_PREVIEW_CHARS);
    const commandLine = sendPending
      ? `Commands: draft ${alias} | send ${alias} | edit ${alias}: <new text> | reject ${alias}`
      : `Commands: draft ${alias} | approve ${alias} | send ${alias} | edit ${alias}: <new text> | reject ${alias}`;
    const sendLine = sendPending
      ? `Send confirmation pending: send ${alias}`
      : `Send requires double-confirmation: approve ${alias}, then send ${alias}`;
    return [
      `#${alias} [${mailbox}] Draft reply: ${subject}`,
      `Draft preview: ${preview || "(empty draft)"}`,
      commandLine,
      sendLine,
    ].join("\n");
  }
  const label =
    action === "mark_spam"
      ? "Mark as spam"
      : action === "unsubscribe"
        ? "Unsubscribe"
        : action === "archive"
          ? "Keep in inbox"
          : "Label as processed";
  return [
    `#${alias} [${mailbox}] ${label}: ${subject}`,
    `Commands: approve ${alias} | reject ${alias}`,
  ].join("\n");
}

function formatOutcomePrefix(alias: number, row: InboxActionRow): string {
  const mailbox = shortMailboxLabel(row.mailbox_label || "");
  const subject = row.subject || "(no subject)";
  return `#${alias} [${mailbox}] ${subject}`;
}

type InboxAliasIntentContext = {
  alias: number;
  actionId: string;
  action: string;
  status: string;
  subject: string;
};

function normalizeIntentEvidenceText(text: string): string {
  return toTrimmed(text)
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, " ")
    .replace(/[^a-z0-9#\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hasIntentEvidenceMatch(userText: string, evidence: string[]): boolean {
  const normalizedUserText = normalizeIntentEvidenceText(userText);
  if (!normalizedUserText) return false;
  for (const item of evidence) {
    const normalized = normalizeIntentEvidenceText(item);
    if (!normalized || normalized.length < 2) continue;
    if (normalizedUserText.includes(normalized)) return true;
  }
  return false;
}

function parseAliasNumbers(value: unknown, allowedAliases: Set<number>): number[] {
  const rawItems: unknown[] = Array.isArray(value)
    ? value
    : value === null || value === undefined
      ? []
      : [value];
  const out: number[] = [];
  for (const item of rawItems) {
    const text = toTrimmed(item);
    if (!text) continue;
    const nums = text.match(/\d+/g) || [];
    for (const n of nums) {
      const alias = Number(n);
      if (!Number.isFinite(alias) || alias <= 0) continue;
      if (!allowedAliases.has(alias)) continue;
      out.push(alias);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function extractMentionedAliases(userText: string, allowedAliases: Set<number>): Set<number> {
  const out = new Set<number>();
  const nums = extractPositiveNumbers(userText);
  for (const alias of nums) {
    if (!allowedAliases.has(alias)) continue;
    out.add(alias);
  }
  return out;
}

function extractPositiveNumbers(value: unknown): number[] {
  const nums = toTrimmed(value).match(/\d+/g) || [];
  const out: number[] = [];
  for (const n of nums) {
    const alias = Number(n);
    if (!Number.isFinite(alias) || alias <= 0) continue;
    out.push(alias);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function extractStrictInboxCommandAliases(userText: string): number[] {
  const text = normalizeInboxCommandText(userText);
  if (!text) return [];

  const editMatch = text.match(/^\s*edit\s+#?(\d+)\s*:/i);
  if (editMatch) return extractPositiveNumbers(editMatch[1]);

  const singleAliasMatch = text.match(
    /^\s*(?:why|draft|show\s+draft(?:\s+of)?)\s+#?(\d+)\s*(?:please|pls)?[.!]?\s*$/i
  );
  if (singleAliasMatch) return extractPositiveNumbers(singleAliasMatch[1]);

  if (/\b(approve|reject|send)\b/i.test(text) && /#\d+/.test(text)) {
    return Array.from(new Set(Array.from(text.matchAll(/#(\d+)/g)).map((m) => Number(m[1]))))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
  }

  const actionMatch = text.match(/^\s*(?:approve|reject|send)\s+(.+?)\s*(?:please|pls)?[.!]?\s*$/i);
  if (!actionMatch) return [];

  const body = toTrimmed(actionMatch[1]);
  if (!/^(?:\d+|\s|,|;|&|\band\b)+$/i.test(body)) return [];
  return extractPositiveNumbers(body);
}

function parseBatchDecisions(
  value: unknown,
  allowedAliases: Set<number>
): Array<{ kind: "approve" | "reject"; alias: number }> {
  if (!Array.isArray(value)) return [];
  const finalByAlias = new Map<number, "approve" | "reject">();
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const kind = normalizeKey(toTrimmed(rec.kind));
    const alias = Number(toTrimmed(rec.alias));
    if (kind !== "approve" && kind !== "reject") continue;
    if (!Number.isFinite(alias) || alias <= 0) continue;
    if (!allowedAliases.has(alias)) continue;
    finalByAlias.set(alias, kind);
  }
  return Array.from(finalByAlias.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([alias, kind]) => ({ alias, kind }));
}

async function loadInboxAliasIntentContext(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
}): Promise<InboxAliasIntentContext[]> {
  const aliasRows = await args.supabase
    .from("inbox_action_aliases_agent")
    .select("alias,action_id")
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .order("alias", { ascending: true })
    .limit(COMMAND_LIST_MAX_ROWS);
  const aliasList = (aliasRows.data || [])
    .map((row) => ({
      alias: Number((row as { alias?: unknown }).alias),
      actionId: toTrimmed((row as { action_id?: unknown }).action_id),
    }))
    .filter((row) => Number.isFinite(row.alias) && row.alias > 0 && row.actionId);
  if (aliasList.length === 0) return [];

  const actionIds = aliasList.map((row) => row.actionId);
  const actionRows = await args.supabase
    .from("inbox_actions")
    .select("id,recommended_action,status,subject")
    .eq("user_id", args.userId)
    .in("id", actionIds);
  const byId = new Map<
    string,
    { action: string; status: string; subject: string }
  >();
  for (const row of actionRows.data || []) {
    const rec = asRecord(row) || {};
    const actionId = toTrimmed(rec.id);
    if (!actionId) continue;
    byId.set(actionId, {
      action: toTrimmed(rec.recommended_action) || "unknown",
      status: toTrimmed(rec.status) || "unknown",
      subject: toTrimmed(rec.subject) || "(no subject)",
    });
  }

  return aliasList
    .map((row) => {
      const details = byId.get(row.actionId);
      return {
        alias: row.alias,
        actionId: row.actionId,
        action: details?.action || "unknown",
        status: details?.status || "unknown",
        subject: details?.subject || "(no subject)",
      };
    })
    .sort((a, b) => a.alias - b.alias);
}

async function recoverExplicitAliasesForAgent(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  userText: string;
  targetAliases?: number[];
  aliasContext: InboxAliasIntentContext[];
}): Promise<InboxAliasIntentContext[]> {
  const numbers = Array.isArray(args.targetAliases) ? args.targetAliases : extractStrictInboxCommandAliases(args.userText);
  if (numbers.length === 0) return args.aliasContext;

  const currentAliases = new Set(args.aliasContext.map((item) => item.alias));
  const missingAliases = numbers.filter((alias) => !currentAliases.has(alias));
  if (missingAliases.length === 0) return args.aliasContext;

  const aliasRows = await args.supabase
    .from("inbox_action_aliases_agent")
    .select("alias,action_id,updated_at,created_at")
    .eq("user_id", args.userId)
    .in("alias", missingAliases)
    .order("updated_at", { ascending: false })
    .limit(COMMAND_LIST_MAX_ROWS * 10);

  const candidates = (aliasRows.data || [])
    .map((row) => ({
      alias: Number((row as { alias?: unknown }).alias),
      actionId: toTrimmed((row as { action_id?: unknown }).action_id),
      updatedAt: toTrimmed((row as { updated_at?: unknown }).updated_at),
      createdAt: toTrimmed((row as { created_at?: unknown }).created_at),
    }))
    .filter((row) => Number.isFinite(row.alias) && row.alias > 0 && row.actionId);
  if (candidates.length === 0) return args.aliasContext;

  const actionIds = Array.from(new Set(candidates.map((row) => row.actionId)));
  const actionRows = await args.supabase
    .from("inbox_actions")
    .select("id,recommended_action,status,subject")
    .eq("user_id", args.userId)
    .in("id", actionIds);

  const actionById = new Map<string, { action: string; status: string; subject: string }>();
  for (const row of actionRows.data || []) {
    const rec = asRecord(row) || {};
    const id = toTrimmed(rec.id);
    if (!id) continue;
    actionById.set(id, {
      action: toTrimmed(rec.recommended_action) || "unknown",
      status: toTrimmed(rec.status) || "unknown",
      subject: toTrimmed(rec.subject) || "(no subject)",
    });
  }

  const adoptedActionIds: string[] = [];
  for (const alias of missingAliases) {
    const aliasCandidates = candidates
      .filter((row) => row.alias === alias && actionById.has(row.actionId))
      .sort((a, b) => {
        const aTime = Date.parse(a.updatedAt || a.createdAt || "");
        const bTime = Date.parse(b.updatedAt || b.createdAt || "");
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
      });
    if (aliasCandidates.length === 0) continue;
    const pending = aliasCandidates.filter((row) => actionById.get(row.actionId)?.status === "pending");
    const eligible = pending.length > 0 ? pending : aliasCandidates;
    const uniqueActionIds = Array.from(new Set(eligible.map((row) => row.actionId)));
    if (uniqueActionIds.length === 1) {
      adoptedActionIds.push(uniqueActionIds[0]);
      continue;
    }

    console.warn("[inbox-actions] ambiguous alias recovery skipped", {
      userId: args.userId,
      agentId: args.agentId,
      alias,
      candidateCount: uniqueActionIds.length,
    });
  }

  const existingActionIds = args.aliasContext.map((item) => item.actionId).filter(Boolean);
  const syncActionIds = Array.from(new Set([...existingActionIds, ...adoptedActionIds]));
  if (adoptedActionIds.length === 0 || syncActionIds.length === existingActionIds.length) {
    return args.aliasContext;
  }

  await syncSessionAliases({
    supabase: args.supabase,
    userId: args.userId,
    agentId: args.agentId,
    actionIds: syncActionIds,
  });

  const recovered = await loadInboxAliasIntentContext({
    supabase: args.supabase,
    userId: args.userId,
    agentId: args.agentId,
  });
  if (recovered.length > args.aliasContext.length) {
    console.log("[inbox-actions] recovered explicit aliases from another agent scope", {
      userId: args.userId,
      agentId: args.agentId,
      aliases: missingAliases,
      recoveredAliases: recovered.length,
    });
  }
  return recovered.length > 0 ? recovered : args.aliasContext;
}

async function resolveInboxCommandIntentModel(args: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<HeartbeatPolicyModel | null> {
  try {
    const resolved = await resolveKeys(args.userId, args.supabase);
    return {
      provider: resolved.provider,
      modelName: resolved.provider === "anthropic" ? "claude-haiku-4.5" : "gpt-4o-mini",
      apiKey: resolved.apiKey,
    };
  } catch (err) {
    console.warn("[inbox-actions] command intent model resolve failed:", err);
    return null;
  }
}

function parseDeterministicInboxCommand(args: {
  userText: string;
  allowedAliases: Set<number>;
}): ParsedInboxCommandSingle | null {
  const text = toTrimmed(args.userText);
  if (!text) return null;

  if (/\b(show|list|pending)\s+actions?\b/i.test(text)) {
    return { kind: "show" };
  }

  const editMatch = text.match(/\bedit\s+#?(\d+)\s*:\s*([\s\S]+)$/i);
  if (editMatch) {
    const alias = Number(editMatch[1]);
    const body = toTrimmed(editMatch[2]);
    if (Number.isFinite(alias) && alias > 0 && body && args.allowedAliases.has(alias)) {
      return { kind: "edit", alias, text: body };
    }
    return null;
  }

  const whyMatch = text.match(/\bwhy\s+#?(\d+)\b/i);
  if (whyMatch) {
    const alias = Number(whyMatch[1]);
    if (Number.isFinite(alias) && alias > 0 && args.allowedAliases.has(alias)) {
      return { kind: "why", alias };
    }
    return null;
  }

  const showDraftMatch = text.match(/\b(?:show\s+)?draft(?:\s+of)?\s+#?(\d+)\b/i);
  if (showDraftMatch) {
    const alias = Number(showDraftMatch[1]);
    if (Number.isFinite(alias) && alias > 0 && args.allowedAliases.has(alias)) {
      return { kind: "show_draft", alias };
    }
    return null;
  }

  const actionVerbMatches = Array.from(text.matchAll(/\b(approve|reject|send)\b/gi));
  if (actionVerbMatches.length === 1) {
    const verb = normalizeKey(actionVerbMatches[0]?.[1] || "");
    const aliases = extractStrictInboxCommandAliases(text).filter((alias) => args.allowedAliases.has(alias));
    if (aliases.length > 0) {
      if (verb === "approve" || verb === "reject") {
        return { kind: verb, aliases, all: false };
      }
      if (verb === "send") {
        return { kind: "confirm_send", aliases };
      }
    }
  }

  return null;
}

function parseAiInboxCommandObject(args: {
  raw: Record<string, unknown>;
  userText: string;
  allowedAliases: Set<number>;
}): ParsedInboxCommandIntent {
  const normalizeKind = (rawKind: string): string => {
    const k = normalizeKey(rawKind);
    if (k === "send") return "confirm_send";
    if (k === "draft") return "show_draft";
    if (k === "showdraft") return "show_draft";
    return k;
  };

  const parseSingle = (raw: Record<string, unknown>): ParsedInboxCommandSingle | null => {
    const kind = normalizeKind(toTrimmed(raw.kind));
    if (!kind || kind === "none" || kind === "multi") return null;

    const mentionedAliases = extractMentionedAliases(args.userText, args.allowedAliases);
    const strictMentionedAliases = new Set(
      extractStrictInboxCommandAliases(args.userText).filter((alias) => args.allowedAliases.has(alias))
    );
    const hasAllowedNumberMention = mentionedAliases.size > 0;
    const mentionsAll = /\ball\b/i.test(args.userText);

    if (kind === "show") return { kind: "show" };
    if (kind === "show_draft") {
      const aliases = parseAliasNumbers(raw.alias, args.allowedAliases);
      const alias = aliases.length === 1 ? aliases[0] : null;
      return { kind: "show_draft", alias };
    }
    if (kind === "why") {
      const aliases = parseAliasNumbers(raw.alias, args.allowedAliases);
      if (aliases.length !== 1) return null;
      if (!mentionedAliases.has(aliases[0])) return null;
      return { kind: "why", alias: aliases[0] };
    }
    if (kind === "edit") {
      const aliases = parseAliasNumbers(raw.alias, args.allowedAliases);
      const text = toTrimmed(raw.text);
      if (aliases.length !== 1 || !text) return null;
      if (!mentionedAliases.has(aliases[0])) return null;
      return { kind: "edit", alias: aliases[0], text };
    }
    if (kind === "approve" || kind === "reject") {
      const aliases = parseAliasNumbers(raw.aliases ?? raw.alias, args.allowedAliases);
      if (aliases.length === 0) return null;
      if (hasAllowedNumberMention && strictMentionedAliases.size === 0 && !mentionsAll) return null;
      if (strictMentionedAliases.size > 0 && !mentionsAll && aliases.some((alias) => !strictMentionedAliases.has(alias)))
        return null;
      if (mentionedAliases.size > 0 && !mentionsAll && aliases.some((alias) => !mentionedAliases.has(alias))) return null;
      return { kind, aliases, all: false };
    }
    if (kind === "confirm_send") {
      const aliases = parseAliasNumbers(raw.aliases ?? raw.alias, args.allowedAliases);
      if (aliases.length === 0) return null;
      if (hasAllowedNumberMention && strictMentionedAliases.size === 0 && !mentionsAll) return null;
      if (strictMentionedAliases.size > 0 && !mentionsAll && aliases.some((alias) => !strictMentionedAliases.has(alias)))
        return null;
      if (!mentionsAll && aliases.some((alias) => !mentionedAliases.has(alias))) return null;
      return { kind: "confirm_send", aliases };
    }
    if (kind === "batch") {
      const decisions = parseBatchDecisions(raw.decisions, args.allowedAliases);
      if (decisions.length === 0) return null;
      if (hasAllowedNumberMention && strictMentionedAliases.size === 0 && !mentionsAll) return null;
      if (
        strictMentionedAliases.size > 0 &&
        !mentionsAll &&
        decisions.some((decision) => !strictMentionedAliases.has(decision.alias))
      )
        return null;
      if (mentionedAliases.size > 0 && !mentionsAll && decisions.some((decision) => !mentionedAliases.has(decision.alias)))
        return null;
      return { kind: "batch", decisions };
    }
    return null;
  };

  const followupTextRaw = toTrimmed(args.raw.followup_text ?? args.raw.followupText);
  const followupText = normalizeInboxCommandText(followupTextRaw, {
    stripLeadingAffirmation: false,
  });
  const kind = normalizeKind(toTrimmed(args.raw.kind));
  if (!kind || kind === "none") {
    return {
      command: null,
      followupText: "",
    };
  }

  const isReadOnly = kind === "show" || kind === "why" || kind === "show_draft";
  const explicit = args.raw.explicit === true;
  const evidence = Array.isArray(args.raw.evidence)
    ? args.raw.evidence.map((v) => toTrimmed(v)).filter(Boolean)
    : [];
  if (!isReadOnly && (!explicit || !hasIntentEvidenceMatch(args.userText, evidence))) {
    return {
      command: null,
      followupText: "",
    };
  }

  if (kind === "multi") {
    if (!explicit || !hasIntentEvidenceMatch(args.userText, evidence)) {
      return {
        command: null,
        followupText: "",
      };
    }
    const rawCommands = Array.isArray(args.raw.commands) ? args.raw.commands : [];
    const commands: ParsedInboxCommandSingle[] = [];
    for (const item of rawCommands) {
      const rec = asRecord(item);
      if (!rec) continue;
      const cmd = parseSingle(rec);
      if (cmd) commands.push(cmd);
    }
    if (commands.length === 0) {
      return {
        command: null,
        followupText: "",
      };
    }
    return {
      command: { kind: "multi", commands },
      followupText,
    };
  }

  const command = parseSingle(args.raw);
  if (!command) {
    return {
      command: null,
      followupText: "",
    };
  }
  return {
    command,
    followupText,
  };
}

async function parseInboxCommandWithAi(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  text: string;
}): Promise<ParsedInboxCommandIntent> {
  const userText = normalizeInboxCommandText(args.text);
  if (!userText) {
    return {
      command: null,
      followupText: "",
    };
  }

  let aliasContext = await loadInboxAliasIntentContext({
    supabase: args.supabase,
    userId: args.userId,
    agentId: args.agentId,
  });
  const hasShowRequest = /\b(show|list|pending)\s+actions?\b/i.test(userText);
  const looksLikeScopedBulkCommand = messageLooksLikeScopedBulkInboxCommand(userText);
  const explicitAliasTargets = extractStrictInboxCommandAliases(userText);
  const looksLikeNumberedCommand = explicitAliasTargets.length > 0;
  if (looksLikeNumberedCommand) {
    aliasContext = await recoverExplicitAliasesForAgent({
      supabase: args.supabase,
      userId: args.userId,
      agentId: args.agentId,
      userText,
      targetAliases: explicitAliasTargets,
      aliasContext,
    });
  }
  if (aliasContext.length === 0) {
    // Best-effort: aliases can be missing/stale if a user issues commands before the action block was rendered.
    const pendingRes = await args.supabase
      .from("inbox_actions")
      .select("id")
      .eq("user_id", args.userId)
      .eq("agent_id", args.agentId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(COMMAND_LIST_MAX_ROWS);
    const pendingIds = (pendingRes.data || [])
      .map((r) => toTrimmed((r as { id?: unknown }).id))
      .filter(Boolean);
    if (pendingIds.length > 0) {
      await syncSessionAliases({
        supabase: args.supabase,
        userId: args.userId,
        agentId: args.agentId,
        actionIds: pendingIds,
      });
      aliasContext = await loadInboxAliasIntentContext({
        supabase: args.supabase,
        userId: args.userId,
        agentId: args.agentId,
      });
    }
  }
  if (aliasContext.length === 0 && (hasShowRequest || looksLikeNumberedCommand || looksLikeScopedBulkCommand)) {
    // Cross-agent recovery: if alias state is stale, recover from current pending actions.
    const crossPendingRes = await args.supabase
      .from("inbox_actions")
      .select("id,agent_id,created_at")
      .eq("user_id", args.userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(COMMAND_LIST_MAX_ROWS * 3);

    const rows = Array.isArray(crossPendingRes.data) ? crossPendingRes.data : [];
    const pendingByAgent = new Map<string, string[]>();
    const allPendingIds: string[] = [];
    for (const raw of rows) {
      const rec = asRecord(raw);
      if (!rec) continue;
      const id = toTrimmed(rec.id);
      const aid = toTrimmed(rec.agent_id);
      if (!id || !aid) continue;
      allPendingIds.push(id);
      const existing = pendingByAgent.get(aid) || [];
      if (!existing.includes(id)) existing.push(id);
      pendingByAgent.set(aid, existing);
    }

    let adoptedActionIds: string[] = [];
    let adoptedFromAgentId = "";
    const uniquePendingIds = Array.from(new Set(allPendingIds));
    const allowMultiAdopt = hasShowRequest || looksLikeScopedBulkCommand;
    if (uniquePendingIds.length === 1) {
      adoptedActionIds = uniquePendingIds;
      const oneAgent = Array.from(pendingByAgent.keys())[0];
      adoptedFromAgentId = oneAgent || "";
    } else if (allowMultiAdopt && pendingByAgent.size === 1) {
      const onlyEntry = Array.from(pendingByAgent.entries())[0];
      adoptedFromAgentId = onlyEntry?.[0] || "";
      adoptedActionIds = Array.isArray(onlyEntry?.[1]) ? onlyEntry[1] : [];
    }

    if (adoptedActionIds.length > 0) {
      const adoptedSet = new Set(adoptedActionIds);
      // Preserve alias order from source session when available so displayed numbers
      // continue to match what the user saw in WhatsApp.
      if (adoptedFromAgentId && adoptedFromAgentId !== args.agentId) {
        const sourceAliasRes = await args.supabase
          .from("inbox_action_aliases_agent")
          .select("alias,action_id")
          .eq("user_id", args.userId)
          .eq("agent_id", adoptedFromAgentId)
          .order("alias", { ascending: true })
          .limit(COMMAND_LIST_MAX_ROWS * 3);
        const sourceAliasRows = Array.isArray(sourceAliasRes.data) ? sourceAliasRes.data : [];
        const orderedFromSource = sourceAliasRows
          .map((r) => ({
            alias: Number((r as { alias?: unknown }).alias),
            actionId: toTrimmed((r as { action_id?: unknown }).action_id),
          }))
          .filter((r) => Number.isFinite(r.alias) && r.alias > 0 && r.actionId && adoptedSet.has(r.actionId))
          .sort((a, b) => a.alias - b.alias)
          .map((r) => r.actionId);
        if (orderedFromSource.length > 0) {
          const orderedSet = new Set(orderedFromSource);
          const remaining = adoptedActionIds.filter((id) => !orderedSet.has(id));
          adoptedActionIds = [...orderedFromSource, ...remaining];
        }
      }

      await syncSessionAliases({
        supabase: args.supabase,
        userId: args.userId,
        agentId: args.agentId,
        actionIds: adoptedActionIds.slice(0, COMMAND_LIST_MAX_ROWS),
      });
      aliasContext = await loadInboxAliasIntentContext({
        supabase: args.supabase,
        userId: args.userId,
        agentId: args.agentId,
      });
      if (aliasContext.length > 0) {
        console.log("[inbox-actions] recovered aliases from pending cross-agent actions", {
          userId: args.userId,
          agentId: args.agentId,
          adoptedFromAgentId: adoptedFromAgentId || null,
          recoveredAliases: aliasContext.length,
        });
      }
    }
  }
  if (looksLikeNumberedCommand) {
    aliasContext = await recoverExplicitAliasesForAgent({
      supabase: args.supabase,
      userId: args.userId,
      agentId: args.agentId,
      userText,
      targetAliases: explicitAliasTargets,
      aliasContext,
    });
  }
  if (aliasContext.length === 0) {
    return {
      command: hasShowRequest ? { kind: "show" } : null,
      followupText: "",
    };
  }

  const allowedAliases = new Set(aliasContext.map((item) => item.alias));
  const modelConfig = await resolveInboxCommandIntentModel({
    supabase: args.supabase,
    userId: args.userId,
  });
  if (modelConfig) {
    const model = resolveChatModel(
      modelConfig.provider,
      modelConfig.modelName,
      modelConfig.apiKey ? { apiKey: modelConfig.apiKey } : undefined
    );
    const aliasSummary = aliasContext
      .map(
        (item) =>
          `#${item.alias} | action=${item.action} | status=${item.status} | subject=${item.subject}`
      )
      .join("\n");
    const prompt = `You are a strict inbox command parser.
Return ONLY JSON with this shape:
{
  "mode": "none|commands_only|commands_plus_followup",
  "kind": "none|show|show_draft|why|edit|approve|reject|confirm_send|batch|multi",
  "alias": <number for why/edit/show_draft, otherwise 0>,
  "aliases": [<numbers for approve/reject/confirm_send>],
  "text": "<new draft text for edit, otherwise empty>",
  "decisions": [{"kind":"approve|reject","alias":<number>}],
  "commands": [{"kind":"show|show_draft|why|edit|approve|reject|confirm_send|batch","alias":0,"aliases":[],"text":"","decisions":[]}],
  "followup_text": "<non-inbox follow-up question from user, otherwise empty string>",
  "explicit": true|false,
  "evidence": ["exact short snippets copied from user message that prove intent"]
}

Allowed aliases:
${Array.from(allowedAliases).sort((a, b) => a - b).join(", ")}

Alias context:
${aliasSummary}

User message:
${userText}

Rules:
- Fail closed. If intent is missing, ambiguous, conversational, or not explicit, return kind="none".
- Never infer approvals/rejections/sends from context or sentiment.
- Only use aliases from the allowed aliases list.
- For send, use kind="confirm_send" and ONLY when user explicitly asks to send.
- For approve/reject: when the user is explicit but does not name action numbers, select matching aliases from the alias context.
- Map natural action words to Alias context action values: "drafts" / "draft replies" => action=draft_reply; "unsubscribe", "unsubscribes", "unsubs", and misspellings like "unsubcribes" => action=unsubscribe; "spam" / "junk" => action=mark_spam; "archive" / "keep in inbox" => action=archive; "label" / "label only" => action=label_only; "everything" / "all" => every allowed pending alias.
- Example: if the user says "reject all drafts and approve all unsubcribes", return kind="batch" with reject decisions for all action=draft_reply aliases and approve decisions for all action=unsubscribe aliases.
- confirm_send still requires explicit action numbers.
- For mixed approve/reject in one message, use kind="batch" with explicit decisions.
- For "show actions", use kind="show".
- For "show draft <alias>" or "what's the draft of <alias>", use kind="show_draft".
- For "why <alias>", use kind="why".
- For "edit <alias>: ...", use kind="edit" with alias and text.
- If the user includes multiple operations in one message (e.g., approve/reject AND edit), use kind="multi" and put each operation in "commands".
- Always set explicit=true only if evidence in the exact user message proves intent.
- If explicit=false then kind must be "none".
- mode=none => kind must be "none" and followup_text must be empty.
- mode=commands_only => kind must be a command kind and followup_text must be empty.
- mode=commands_plus_followup => kind must be a command kind and followup_text must contain ONLY the non-inbox ask.
- Never copy command phrases into followup_text.
- Keep followup_text exactly as the user asked (do not paraphrase).`;

    try {
      const out = await generateText({
        model,
        prompt,
      });
      const parsed = extractJsonObject(out.text || "");
      if (parsed) {
        const intent = parseAiInboxCommandObject({
          raw: parsed,
          userText,
          allowedAliases,
        });
        if (intent.command) {
          return intent;
        }
      }
    } catch (err) {
      console.warn("[inbox-actions] command intent parse failed:", err);
    }
  }

  const deterministic = parseDeterministicInboxCommand({
    userText,
    allowedAliases,
  });
  if (deterministic) {
    return {
      command: deterministic,
      followupText: "",
    };
  }

  // Fast-path: "show me the draft" is read-only and should never depend on model luck.
  const mentionsDraft = /\bdraft\b/i.test(userText);
  const mentionsMutating = /\b(approve|reject|send|edit)\b/i.test(userText);
  const whyWithAlias = /\bwhy\b/i.test(userText) && /#?\d+/.test(userText);
  if (mentionsDraft && !mentionsMutating && !whyWithAlias) {
    const mentioned = extractMentionedAliases(userText, allowedAliases);
    const one = Array.from(mentioned)[0];
    return {
      command: { kind: "show_draft", alias: mentioned.size === 1 ? one : null },
      followupText: "",
    };
  }

  return {
    command: null,
    followupText: "",
  };
}

function normalizeInboxCommandText(
  text: string,
  opts?: { stripLeadingAffirmation?: boolean }
): string {
  const raw = toTrimmed(text);
  if (!raw) return "";
  // WhatsApp often injects zero-width separators in copied numbered lists.
  const cleaned = raw
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Strip common WhatsApp bot prefixes.
  const withoutBotPrefix = cleaned.replace(/^@(?:groovy|code)\b[\s,.:;-]*/i, "").trim();
  const stripLeadingAffirmation = opts?.stripLeadingAffirmation !== false;
  if (!stripLeadingAffirmation) return withoutBotPrefix;
  // Allow natural command prefixes like "yes approve 1" in WhatsApp.
  return withoutBotPrefix.replace(/^(?:yes|ok|okay|sure|yep|yeah)\b[\s,.:;-]*/i, "").trim();
}

function messageMentionsInboxActions(text: string): boolean {
  const raw = toTrimmed(text);
  if (!raw) return false;
  if (/\b(show|list|pending)\s+actions?\b/i.test(raw)) return true;
  if (/\bemail\s+actions?\b/i.test(raw)) return true;
  if (/\b(inbox|gmail)\s+actions?\b/i.test(raw)) return true;
  if (/\b(inbox|gmail|email)\b[\s\S]{0,60}\b(action|actions|draft|drafts|approve|reject|unsubscribe|archive|cancel)\b/i.test(raw))
    return true;
  if (/\b(action|actions|draft|drafts)\b/i.test(raw)) return true;
  if (/\b(actions?|drafts?|approve|reje(?:ct|ction)|unsubscribe|archive)\b/i.test(raw) && /#?\d+/.test(raw))
    return true;
  return false;
}

function messageLooksLikeScopedBulkInboxCommand(text: string): boolean {
  const raw = normalizeInboxCommandText(text);
  if (!raw) return false;
  if (!/\b(?:approve|reject)\b/i.test(raw)) return false;
  if (!/\ball\b/i.test(raw)) return false;
  return /\b(?:drafts?|unsub(?:s|scribes?|scribe|scribed|criptions?|cribes?|cribe)?|spam|junk|archive|archives|labels?|rest|others?|everything)\b/i.test(raw);
}

export async function applyPendingInboxActionSilencePolicy(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  messageText: string;
  thresholdMessages?: number;
}): Promise<PendingInboxSilenceSweepResult> {
  const thresholdRaw =
    typeof args.thresholdMessages === "number" ? args.thresholdMessages : INBOX_PENDING_AUTO_CANCEL_AFTER_MESSAGES;
  const threshold = Number.isFinite(thresholdRaw) ? Math.max(0, Math.floor(thresholdRaw)) : 0;
  const messageText = toTrimmed(args.messageText);
  if (!args.agentId || !messageText) {
    return {
      touched: false,
      pendingBefore: 0,
      pendingAfter: 0,
      cancelledCount: 0,
      messageMentionsActions: false,
      threshold,
    };
  }

  // When disabled, do nothing (no metadata writes, no alias churn).
  if (threshold <= 0) {
    return {
      touched: false,
      pendingBefore: 0,
      pendingAfter: 0,
      cancelledCount: 0,
      messageMentionsActions: messageMentionsInboxActions(messageText),
      threshold,
    };
  }

  const pendingRes = await args.supabase
    .from("inbox_actions")
    .select("*")
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(COMMAND_LIST_MAX_ROWS);
  const pendingRows = (pendingRes.data || [])
    .map((row) => rowToInboxAction(row))
    .filter((row): row is InboxActionRow => !!row);

  if (pendingRows.length === 0) {
    return {
      touched: false,
      pendingBefore: 0,
      pendingAfter: 0,
      cancelledCount: 0,
      messageMentionsActions: messageMentionsInboxActions(messageText),
      threshold,
    };
  }

  const mentionsActions = messageMentionsInboxActions(messageText);
  const nowIso = new Date().toISOString();
  let cancelledCount = 0;
  const remainingIds: string[] = [];

  await mapLimit(pendingRows, 4, async (row) => {
    const existingMeta = asRecord(row.metadata) || {};
    const previousTurnsRaw = Number(existingMeta.auto_cancel_silence_turns);
    const previousTurns = Number.isFinite(previousTurnsRaw) ? Math.max(0, Math.floor(previousTurnsRaw)) : 0;
    const nextTurns = mentionsActions ? 0 : previousTurns + 1;

    const nextMeta: Record<string, unknown> = {
      ...existingMeta,
      auto_cancel_silence_turns: nextTurns,
      auto_cancel_threshold_messages: threshold,
      auto_cancel_last_user_message_at: nowIso,
    };

    if (!mentionsActions && nextTurns >= threshold) {
      cancelledCount += 1;
      await completeAction({
        supabase: args.supabase,
        actionId: row.id,
        userId: args.userId,
        status: "rejected",
        extra: {
          ...nextMeta,
          auto_cancelled: true,
          auto_cancelled_at: nowIso,
          auto_cancel_reason: `No inbox action follow-up after ${threshold} user messages.`,
        },
      });
      return;
    }

    remainingIds.push(row.id);

    // If user referenced actions and the counter was already zero, avoid a no-op write.
    if (mentionsActions && previousTurns === 0) return;

    await args.supabase
      .from("inbox_actions")
      .update({
        metadata: nextMeta,
        updated_at: nowIso,
      })
      .eq("id", row.id)
      .eq("user_id", args.userId)
      .eq("status", "pending");
  });

  await syncSessionAliases({
    supabase: args.supabase,
    userId: args.userId,
    agentId: args.agentId,
    actionIds: remainingIds,
  });

  return {
    touched: true,
    pendingBefore: pendingRows.length,
    pendingAfter: remainingIds.length,
    cancelledCount,
    messageMentionsActions: mentionsActions,
    threshold,
  };
}

async function listPendingAliases(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
}): Promise<string> {
  const aliasRows = await args.supabase
    .from("inbox_action_aliases_agent")
    .select("alias,action_id")
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .order("alias", { ascending: true })
    .limit(COMMAND_LIST_MAX_ROWS);

  const aliases = (aliasRows.data || [])
    .map((r) => ({ alias: Number((r as { alias?: unknown }).alias), actionId: toTrimmed((r as { action_id?: unknown }).action_id) }))
    .filter((r) => Number.isFinite(r.alias) && r.alias > 0 && r.actionId);
  if (aliases.length === 0) {
    return "No pending inbox actions right now.";
  }
  const actionIds = aliases.map((a) => a.actionId);
  const rows = await args.supabase
    .from("inbox_actions")
    .select("*")
    .eq("user_id", args.userId)
    .in("id", actionIds);
  const byId = new Map<string, InboxActionRow>();
  for (const r of rows.data || []) {
    const parsed = rowToInboxAction(r);
    if (parsed) byId.set(parsed.id, parsed);
  }
  const lines = aliases.map((a) => {
    const row = byId.get(a.actionId);
    if (!row) return `#${a.alias} (missing action)`;
    return `#${a.alias} ${shortMailboxLabel(row.mailbox_label || "")}: ${row.recommended_action} — ${row.subject || "(no subject)"}`;
  });
  return `Pending inbox actions:\n${lines.join("\n")}`;
}

async function resequencePendingAliases(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
}) {
  const pending = await args.supabase
    .from("inbox_actions")
    .select("id")
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(COMMAND_LIST_MAX_ROWS);
  const ids = (pending.data || [])
    .map((r) => toTrimmed((r as { id?: unknown }).id))
    .filter(Boolean);
  await syncSessionAliases({
    supabase: args.supabase,
    userId: args.userId,
    agentId: args.agentId,
    actionIds: ids,
  });
}

export async function executeInboxCommand(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  text: string;
}): Promise<ExecuteInboxCommandResult> {
  // If we previously returned an "implicit selection" preview, allow the user to confirm/cancel
  // with natural language (parsed by the model).
  try {
    const pending = await loadPendingInboxCommandConfirmation({
      supabase: args.supabase,
      userId: args.userId,
      agentId: args.agentId,
    });
    if (pending) {
      const confirmText = normalizeInboxCommandText(args.text, { stripLeadingAffirmation: false });
      const hasDigits = /#?\d+/.test(confirmText);
      // Any explicit numbered command supersedes the pending proposal.
      if (hasDigits) {
        await markInboxCommandConfirmationStatus({
          supabase: args.supabase,
          userId: args.userId,
          agentId: args.agentId,
          status: "cancelled",
        });
      } else {
        const intent = await parseInboxCommandConfirmationWithAi({
          supabase: args.supabase,
          userId: args.userId,
          text: args.text,
          pending,
        });
        if (intent.kind === "cancel") {
          await markInboxCommandConfirmationStatus({
            supabase: args.supabase,
            userId: args.userId,
            agentId: args.agentId,
            status: "cancelled",
          });
          return { handled: true, reply: "Cancelled." };
        }
        if (intent.kind === "confirm") {
          await markInboxCommandConfirmationStatus({
            supabase: args.supabase,
            userId: args.userId,
            agentId: args.agentId,
            status: "consumed",
          });
          // Re-enter with the explicit confirmation command (contains aliases),
          // which will execute deterministically.
          return await executeInboxCommand({
            ...args,
            text: pending.confirm_cmd,
          });
        }
        // If the user issues a different inbox command while a proposal is pending,
        // clear the proposal to avoid accidental later confirmation.
        if (messageMentionsInboxActions(confirmText)) {
          await markInboxCommandConfirmationStatus({
            supabase: args.supabase,
            userId: args.userId,
            agentId: args.agentId,
            status: "cancelled",
          });
        }
      }
    }
  } catch {
    // ignore confirmation parsing failures
  }

  const explicitEdits: Array<{ alias: number; text: string }> = [];
  try {
    const normalized = normalizeInboxCommandText(args.text);
    const re = /\bedit\s+#?(\d+)\s*:\s*/gi;
    while (true) {
      const m = re.exec(normalized);
      if (!m) break;
      const alias = Number(m[1]);
      if (!Number.isFinite(alias) || alias <= 0) continue;
      const bodyStart = re.lastIndex;
      const rest = normalized.slice(bodyStart);
      const nextIdx = rest.search(/(?:,|;|\n)\s*(?:#?\d+\s+)?(?:approve|reject|send|edit)\b/i);
      const end = nextIdx >= 0 ? bodyStart + nextIdx : normalized.length;
      const text = normalized.slice(bodyStart, end).trim();
      if (text) explicitEdits.push({ alias, text });
      re.lastIndex = end;
    }
  } catch {
    // ignore
  }

  const parsedIntent = await parseInboxCommandWithAi({
    supabase: args.supabase,
    userId: args.userId,
    agentId: args.agentId,
    text: args.text,
  });
  let parsed = parsedIntent.command;
  const followupText = toTrimmed(parsedIntent.followupText);
  const withFollowupText = (result: ExecuteInboxCommandResult): ExecuteInboxCommandResult => {
    if (!result.handled || !followupText) return result;
    return {
      ...result,
      followupText,
    };
  };

  if (explicitEdits.length > 0 && !followupText) {
    const editByAlias = new Map<number, string>();
    for (const e of explicitEdits) {
      if (!Number.isFinite(e.alias) || e.alias <= 0) continue;
      const text = toTrimmed(e.text);
      if (!text) continue;
      editByAlias.set(e.alias, text);
    }
    const editCommands: ParsedInboxCommandSingle[] = Array.from(editByAlias.entries()).map(([alias, text]) => ({
      kind: "edit",
      alias,
      text,
    }));
    if (editCommands.length === 0) {
      // fall through
    } else if (!parsed) {
      parsed = editCommands.length === 1 ? editCommands[0] : { kind: "multi", commands: editCommands };
    } else if (parsed.kind === "multi") {
      const withoutOverridden = parsed.commands.filter(
        (c) => !(c.kind === "edit" && editByAlias.has((c as { kind: "edit"; alias: number }).alias))
      );
      parsed = { kind: "multi", commands: [...editCommands, ...withoutOverridden] };
    } else if (parsed.kind === "edit") {
      const override = editByAlias.get(parsed.alias);
      if (override) {
        parsed = { kind: "edit", alias: parsed.alias, text: override };
      }
      if (editCommands.length > 1) {
        parsed = { kind: "multi", commands: editCommands };
      }
    } else {
      parsed = { kind: "multi", commands: [...editCommands, parsed] };
    }
  }
  if (!parsed && !followupText) {
    const normalized = normalizeInboxCommandText(args.text);
    const explicitNumbers = extractStrictInboxCommandAliases(normalized);
    if (explicitNumbers.length > 0) {
      const explicitNumberSet = new Set(explicitNumbers);
      const unscopedDeterministic = parseDeterministicInboxCommand({
        userText: normalized,
        allowedAliases: explicitNumberSet,
      });
      if (unscopedDeterministic) {
        parsed = unscopedDeterministic;
      }
    }
  }
  if (!parsed) {
    const raw = toTrimmed(args.text);
    const looksLikeScopedBulkCommand = messageLooksLikeScopedBulkInboxCommand(raw);
    const looksLikeInboxCommand =
      looksLikeScopedBulkCommand ||
      (/#?\d+/.test(raw) &&
        /\b(approve|reject|edit|send|draft|why|show|list|pending)\b/i.test(raw) &&
        messageMentionsInboxActions(raw));
    if (!looksLikeInboxCommand) return { handled: false, reply: "" };
    return {
      handled: true,
      reply: `I couldn't interpret that as inbox actions. Try: "show actions", "approve 2", "reject 5", "draft 9", "edit 9: <new text>", or "send 9".`,
    };
  }

  const runSingle = async (parsed: ParsedInboxCommandSingle): Promise<ExecuteInboxCommandResult> => {
    if (parsed.kind === "batch") {
      const finalByAlias = new Map<number, "approve" | "reject">();
      for (const decision of parsed.decisions) {
        if (!Number.isFinite(decision.alias) || decision.alias <= 0) continue;
        finalByAlias.set(decision.alias, decision.kind);
      }
      const targetAliases = Array.from(finalByAlias.keys()).sort((a, b) => a - b);
      if (targetAliases.length === 0) {
        return {
          handled: true,
          reply: `I couldn't parse action numbers. Use "approve 1 2" or "reject 3".`,
        };
      }

      const aliasRows = await args.supabase
        .from("inbox_action_aliases_agent")
        .select("alias,action_id")
        .eq("user_id", args.userId)
        .eq("agent_id", args.agentId)
        .order("alias", { ascending: true });
      const aliasList = (aliasRows.data || [])
        .map((r) => ({
          alias: Number((r as { alias?: unknown }).alias),
          actionId: toTrimmed((r as { action_id?: unknown }).action_id),
        }))
        .filter((r) => Number.isFinite(r.alias) && r.alias > 0 && r.actionId);
      const actionByAlias = new Map(aliasList.map((a) => [a.alias, a.actionId]));
      const resolved = targetAliases
        .map((alias) => ({
          alias,
          kind: finalByAlias.get(alias) as "approve" | "reject",
          actionId: actionByAlias.get(alias) || "",
        }))
        .filter((item) => item.kind === "approve" || item.kind === "reject");
      const missing = resolved.filter((item) => !item.actionId).map((item) => item.alias);
      const wanted = resolved.filter((item) => item.actionId);
      if (wanted.length === 0) {
        return {
          handled: true,
          reply: `I couldn't find those action numbers${missing.length ? `: ${missing.join(", ")}` : ""}.`,
        };
      }

      const rows = await args.supabase
        .from("inbox_actions")
        .select("*")
        .eq("user_id", args.userId)
        .in("id", wanted.map((w) => w.actionId));
      const byId = new Map<string, InboxActionRow>();
      for (const r of rows.data || []) {
        const parsedRow = rowToInboxAction(r);
        if (parsedRow) byId.set(parsedRow.id, parsedRow);
      }

      const normalizedUserText = normalizeInboxCommandText(args.text);
      const mentioned = extractMentionedAliases(
        normalizedUserText,
        new Set(aliasList.map((a) => a.alias))
      );
      const isImplicit = wanted.some((w) => mentioned.size === 0 || !mentioned.has(w.alias));
      if (isImplicit) {
        const approveAliases = wanted
          .filter((w) => w.kind === "approve")
          .map((w) => w.alias)
          .sort((a, b) => a - b);
        const rejectAliases = wanted
          .filter((w) => w.kind === "reject")
          .map((w) => w.alias)
          .sort((a, b) => a - b);
        const lines = wanted
          .sort((a, b) => a.alias - b.alias)
          .map((w) => {
            const row = byId.get(w.actionId);
            if (!row) return `- ${w.kind.toUpperCase()} #${w.alias}: missing action`;
            return `- ${w.kind.toUpperCase()} #${w.alias} ${shortMailboxLabel(row.mailbox_label || "")}: ${row.recommended_action} — ${row.subject || "(no subject)"}`;
          });
        const confirmParts: string[] = [];
        if (rejectAliases.length > 0) confirmParts.push(`reject ${rejectAliases.join(" ")}`);
        if (approveAliases.length > 0) confirmParts.push(`approve ${approveAliases.join(" ")}`);
        const confirmCmd = confirmParts.join(", ");
        await savePendingInboxCommandConfirmation({
          supabase: args.supabase,
          userId: args.userId,
          agentId: args.agentId,
          payload: {
            kind: "batch",
            parsed: {
              kind: "batch",
              decisions: wanted.map((w) => ({ kind: w.kind, alias: w.alias })),
            },
            confirm_cmd: confirmCmd,
            summary_lines: lines,
          },
        });
        return {
          handled: true,
          reply:
            `I can do that, but please confirm first.\n\n` +
            `Proposed:\n${lines.join("\n")}\n\n` +
            `To confirm, reply with a confirmation (any phrasing) or paste: ${confirmCmd}`,
        };
      }

      const outcomes: string[] = [];
      const pendingConnectorExecutes: InboxCommandConnectorExecute[] = [];
      for (const target of wanted) {
        const row = byId.get(target.actionId);
        if (!row) {
          outcomes.push(`#${target.alias}: missing action`);
          continue;
        }
        const prefix = formatOutcomePrefix(target.alias, row);
        if (row.status !== "pending") {
          outcomes.push(`${prefix}: already handled`);
          continue;
        }
        if (target.kind === "reject") {
          await completeAction({
            supabase: args.supabase,
            actionId: row.id,
            userId: args.userId,
            status: "rejected",
            extra: {
              ...(asRecord(row.metadata) || {}),
              rejected_via: "command",
              rejected_at: new Date().toISOString(),
            },
          });
          outcomes.push(`${prefix}: rejected`);
          continue;
        }

        if (row.recommended_action === "draft_reply") {
          await markDraftSendConfirmationPending({
            supabase: args.supabase,
            row,
            userId: args.userId,
            alias: target.alias,
          });
          outcomes.push(`${prefix}: draft approved. Send is not executed yet. Confirm with "send ${target.alias}".`);
          continue;
        }

        const lock = await tryAcquireActionExecutionLock({
          supabase: args.supabase,
          actionId: row.id,
          userId: args.userId,
        });
        if (!lock) {
          outcomes.push(`${prefix}: already handled`);
          continue;
        }

        const datagranApiKey = await resolveConnectionDatagranKey({
          supabase: args.supabase,
          userId: args.userId,
          connectionId: lock.connection_id,
        });
        const labels = await ensureGroovyLabels({
          datagranApiKey,
          connectionId: lock.connection_id,
        });
        const exec = await executeInboxAction({
          supabase: args.supabase,
          row: lock,
          datagranApiKey,
          labels,
        });
        if (exec.ok) {
          await completeAction({
            supabase: args.supabase,
            actionId: lock.id,
            userId: args.userId,
            status: "done",
            extra: {
              ...(asRecord(lock.metadata) || {}),
              approved_via: "command",
              execution_detail: exec.detail,
              ...(Array.isArray(exec.connectorExecutes) && exec.connectorExecutes.length > 0
                ? {
                    local_unsubscribe_queued: true,
                    local_unsubscribe_executes: exec.connectorExecutes.map((e) => ({
                      connectorType: e.connectorType,
                      toolCallId: e.toolCallId,
                      subject: toTrimmed(e.connectorParams?.subject),
                    })),
                  }
                : {}),
            },
          });
          outcomes.push(`${prefix}: ${exec.detail}`);
          if (Array.isArray(exec.connectorExecutes) && exec.connectorExecutes.length > 0) {
            pendingConnectorExecutes.push(...exec.connectorExecutes);
          }
        } else {
          await completeAction({
            supabase: args.supabase,
            actionId: lock.id,
            userId: args.userId,
            status: "failed",
            extra: {
              ...(asRecord(lock.metadata) || {}),
              execution_error: exec.detail,
            },
          });
          outcomes.push(`${prefix}: failed (${exec.detail})`);
        }
      }

      await resequencePendingAliases({
        supabase: args.supabase,
        userId: args.userId,
        agentId: args.agentId,
      });

      const hasApprove = wanted.some((w) => w.kind === "approve");
      const hasReject = wanted.some((w) => w.kind === "reject");
      const prefix = hasApprove && hasReject ? "Approval/Rejection results" : hasApprove ? "Approval results" : "Rejection results";
      const missingLine = missing.length > 0 ? `\nMissing aliases: ${missing.join(", ")}` : "";
      const connectorExecutes =
        pendingConnectorExecutes.length > 0
          ? Array.from(
              new Map(pendingConnectorExecutes.map((e) => [`${e.toolCallId}:${e.connectorType}`, e])).values()
            )
          : [];
      const connectorLine =
        connectorExecutes.length > 0
          ? `\nLocal unsubscribe execution queued: ${connectorExecutes.length}.`
          : "";
      return {
        handled: true,
        reply: `${prefix}:\n${outcomes.join("\n")}${missingLine}${connectorLine}`,
        connectorExecutes: connectorExecutes.length > 0 ? connectorExecutes : undefined,
        statusMessage: connectorExecutes.length > 0 ? "Completing unsubscribe locally..." : undefined,
      };
    }

    if (parsed.kind === "confirm_send") {
      const aliasRows = await args.supabase
        .from("inbox_action_aliases_agent")
        .select("alias,action_id")
        .eq("user_id", args.userId)
        .eq("agent_id", args.agentId)
        .order("alias", { ascending: true });
      const aliasList = (aliasRows.data || [])
        .map((row) => ({
          alias: Number((row as { alias?: unknown }).alias),
          actionId: toTrimmed((row as { action_id?: unknown }).action_id),
        }))
        .filter((row) => Number.isFinite(row.alias) && row.alias > 0 && row.actionId);

      const targetAliases = parsed.aliases.filter((n) => Number.isFinite(n) && n > 0);
      if (targetAliases.length === 0) {
        return {
          handled: true,
          reply: `Specify draft action numbers, e.g. "send 5".`,
        };
      }

      const wanted = aliasList.filter((row) => targetAliases.includes(row.alias));
      const missing = targetAliases.filter((n) => !wanted.some((w) => w.alias === n));
      if (wanted.length === 0) {
        return {
          handled: true,
          reply: `I couldn't find those action numbers${missing.length ? `: ${missing.join(", ")}` : ""}.`,
        };
      }

      const rows = await args.supabase
        .from("inbox_actions")
        .select("*")
        .eq("user_id", args.userId)
        .in("id", wanted.map((w) => w.actionId));
      const byId = new Map<string, InboxActionRow>();
      for (const row of rows.data || []) {
        const parsedRow = rowToInboxAction(row);
        if (parsedRow) byId.set(parsedRow.id, parsedRow);
      }

      const outcomes: string[] = [];
      for (const alias of wanted) {
        const row = byId.get(alias.actionId);
        if (!row) {
          outcomes.push(`#${alias.alias}: missing action`);
          continue;
        }
        const prefix = formatOutcomePrefix(alias.alias, row);
        if (row.status !== "pending") {
          outcomes.push(`${prefix}: already handled`);
          continue;
        }
        if (row.recommended_action !== "draft_reply") {
          outcomes.push(`${prefix}: not a draft action.`);
          continue;
        }

        const rowMeta = asRecord(row.metadata) || {};
        if (rowMeta.send_confirmation_pending !== true) {
          outcomes.push(`${prefix}: send confirmation is not pending. Use "approve ${alias.alias}" first.`);
          continue;
        }

        const lock = await tryAcquireActionExecutionLock({
          supabase: args.supabase,
          actionId: row.id,
          userId: args.userId,
        });
        if (!lock) {
          outcomes.push(`${prefix}: already handled`);
          continue;
        }

        const datagranApiKey = await resolveConnectionDatagranKey({
          supabase: args.supabase,
          userId: args.userId,
          connectionId: lock.connection_id,
        });
        const labels = await ensureGroovyLabels({
          datagranApiKey,
          connectionId: lock.connection_id,
        });
        const exec = await executeInboxAction({
          supabase: args.supabase,
          row: lock,
          datagranApiKey,
          labels,
        });
        if (exec.ok) {
          await completeAction({
            supabase: args.supabase,
            actionId: lock.id,
            userId: args.userId,
            status: "done",
            extra: {
              ...(asRecord(lock.metadata) || {}),
              approved_via: "command",
              send_confirmed_via: "command",
              send_confirmation_pending: false,
              send_confirmed_at: new Date().toISOString(),
              execution_detail: exec.detail,
            },
          });
          outcomes.push(`${prefix}: ${exec.detail}`);
        } else {
          await completeAction({
            supabase: args.supabase,
            actionId: lock.id,
            userId: args.userId,
            status: "failed",
            extra: {
              ...(asRecord(lock.metadata) || {}),
              send_confirmation_pending: false,
              execution_error: exec.detail,
            },
          });
          outcomes.push(`${prefix}: failed (${exec.detail})`);
        }
      }

      await resequencePendingAliases({
        supabase: args.supabase,
        userId: args.userId,
        agentId: args.agentId,
      });

      const missingLine = missing.length > 0 ? `\nMissing aliases: ${missing.join(", ")}` : "";
      return {
        handled: true,
        reply: `Send confirmation results:\n${outcomes.join("\n")}${missingLine}`,
      };
    }

    if (parsed.kind === "show") {
      return {
        handled: true,
        reply: await listPendingAliases({
          supabase: args.supabase,
          userId: args.userId,
          agentId: args.agentId,
        }),
      };
    }

    if (parsed.kind === "show_draft") {
      let alias = parsed.alias;
      if (!alias) {
        const aliasRows = await args.supabase
          .from("inbox_action_aliases_agent")
          .select("alias,action_id")
          .eq("user_id", args.userId)
          .eq("agent_id", args.agentId)
          .order("alias", { ascending: true })
          .limit(COMMAND_LIST_MAX_ROWS);
        const aliasList = (aliasRows.data || [])
          .map((r) => ({
            alias: Number((r as { alias?: unknown }).alias),
            actionId: toTrimmed((r as { action_id?: unknown }).action_id),
          }))
          .filter((r) => Number.isFinite(r.alias) && r.alias > 0 && r.actionId);
        if (aliasList.length === 0) {
          return { handled: true, reply: "No pending inbox actions right now." };
        }
        const actionRows = await args.supabase
          .from("inbox_actions")
          .select("id,recommended_action,status")
          .eq("user_id", args.userId)
          .in("id", aliasList.map((a) => a.actionId));
        const byId = new Map<string, { action: string; status: string }>();
        for (const row of actionRows.data || []) {
          const rec = asRecord(row) || {};
          const id = toTrimmed(rec.id);
          if (!id) continue;
          byId.set(id, {
            action: normalizeKey(toTrimmed(rec.recommended_action)),
            status: normalizeKey(toTrimmed(rec.status)),
          });
        }
        const draftAliases = aliasList.filter((a) => {
          const v = byId.get(a.actionId);
          return v?.action === "draft_reply" && v?.status === "pending";
        });
        if (draftAliases.length === 1) {
          alias = draftAliases[0].alias;
        } else if (draftAliases.length > 1) {
          return {
            handled: true,
            reply: `Which draft? Specify a number, e.g. "draft ${draftAliases[0].alias}".`,
          };
        } else {
          return { handled: true, reply: "No pending draft actions right now." };
        }
      }
      if (!alias) return { handled: true, reply: `Specify a draft number, e.g. "draft 9".` };

      const aliasRow = await args.supabase
        .from("inbox_action_aliases_agent")
        .select("action_id")
        .eq("user_id", args.userId)
        .eq("agent_id", args.agentId)
        .eq("alias", alias)
        .maybeSingle();
      const actionId = toTrimmed((aliasRow.data as { action_id?: unknown } | null)?.action_id);
      if (!actionId) return { handled: true, reply: `I can't find action #${alias}.` };

      const actionRow = await args.supabase
        .from("inbox_actions")
        .select("*")
        .eq("id", actionId)
        .eq("user_id", args.userId)
        .maybeSingle();
      const row = rowToInboxAction(actionRow.data);
      if (!row) return { handled: true, reply: `Action #${alias} not found.` };
      if (row.recommended_action !== "draft_reply") {
        return { handled: true, reply: `Action #${alias} is not a draft action.` };
      }

      const mailbox = shortMailboxLabel(row.mailbox_label || "");
      const toList = Array.isArray(row.draft_to) ? row.draft_to.map((v) => toTrimmed(v)).filter(Boolean) : [];
      const to = toList.join(", ") || row.sender_email || "(missing to)";
      const meta = asRecord(row.metadata) || {};
      const ccList = Array.isArray(meta.draft_cc) ? meta.draft_cc.map((v) => toTrimmed(v)).filter(Boolean) : [];
      const cc = ccList.join(", ");
      const subject = row.draft_subject || `Re: ${row.subject || ""}`;
      const draftIdLine = row.gmail_draft_id ? `Gmail draft id: ${row.gmail_draft_id}` : `Gmail draft id: (not created yet)`;
      const body = toTrimmed(row.draft_body) || "(empty draft)";
      const shown = body.length > 1800 ? `${body.slice(0, 1800)}\n\n(truncated)` : body;
      return {
        handled: true,
        reply: `#${alias} [${mailbox}] Draft reply\nTo: ${to}${cc ? `\nCc: ${cc}` : ""}\nSubject: ${subject}\n${draftIdLine}\n\n${shown}`,
      };
    }

    if (parsed.kind === "why") {
      const aliasRow = await args.supabase
        .from("inbox_action_aliases_agent")
        .select("action_id")
        .eq("user_id", args.userId)
        .eq("agent_id", args.agentId)
        .eq("alias", parsed.alias)
        .maybeSingle();
      const actionId = toTrimmed((aliasRow.data as { action_id?: unknown } | null)?.action_id);
      if (!actionId) {
        return { handled: true, reply: `I can't find action #${parsed.alias}.` };
      }
      const actionRow = await args.supabase
        .from("inbox_actions")
        .select("*")
        .eq("id", actionId)
        .eq("user_id", args.userId)
        .maybeSingle();
      const row = rowToInboxAction(actionRow.data);
      if (!row) return { handled: true, reply: `Action #${parsed.alias} is no longer available.` };
      const reason = row.reason || "(no reason)";
      const probs = `important=${(row.p_important ?? 0).toFixed(2)}, spam=${(row.p_spam ?? 0).toFixed(2)}, actionable=${(row.p_actionable ?? 0).toFixed(2)}`;
      return {
        handled: true,
        reply: `#${parsed.alias} ${row.recommended_action} — ${row.subject || "(no subject)"}\nReason: ${reason}\nScores: ${probs}`,
      };
    }

    if (parsed.kind === "edit") {
      if (!parsed.text) {
        return { handled: true, reply: `Use: edit ${parsed.alias}: <new draft text>` };
      }
      const aliasRow = await args.supabase
        .from("inbox_action_aliases_agent")
        .select("action_id")
        .eq("user_id", args.userId)
        .eq("agent_id", args.agentId)
        .eq("alias", parsed.alias)
        .maybeSingle();
      const actionId = toTrimmed((aliasRow.data as { action_id?: unknown } | null)?.action_id);
      if (!actionId) return { handled: true, reply: `I can't find action #${parsed.alias}.` };

      const actionRow = await args.supabase
        .from("inbox_actions")
        .select("*")
        .eq("id", actionId)
        .eq("user_id", args.userId)
        .maybeSingle();
      const row = rowToInboxAction(actionRow.data);
      if (!row) return { handled: true, reply: `Action #${parsed.alias} not found.` };
      if (row.recommended_action !== "draft_reply") {
        return { handled: true, reply: `Action #${parsed.alias} is not a draft action.` };
      }

      const datagranApiKey = await resolveConnectionDatagranKey({
        supabase: args.supabase,
        userId: args.userId,
        connectionId: row.connection_id,
      });
      const toList = Array.isArray(row.draft_to) ? row.draft_to.map((v) => toTrimmed(v)).filter(Boolean) : [];
      const to = toList.join(", ") || row.sender_email || "";
      const meta = asRecord(row.metadata) || {};
      const ccList = Array.isArray(meta.draft_cc) ? meta.draft_cc.map((v) => toTrimmed(v)).filter(Boolean) : [];
      const cc = ccList.join(", ");
      const subj = row.draft_subject || `Re: ${row.subject || ""}`;
      const targetThreadId = toTrimmed(meta.target_thread_id) || row.gmail_thread_id;
      const targetMessageIdHeader =
        toTrimmed(meta.target_message_id_header) || toTrimmed(meta.message_id_header) || null;
      if (!to) return { handled: true, reply: `Draft #${parsed.alias} has no recipient.` };

      let finalDraftId = row.gmail_draft_id;
      let draftWriteError = "";
      if (row.gmail_draft_id) {
        const updated = await updateGmailDraft({
          datagranApiKey,
          connectionId: row.connection_id,
          draftId: row.gmail_draft_id,
          threadId: targetThreadId,
          to,
          cc,
          subject: subj,
          body: parsed.text,
          inReplyTo: targetMessageIdHeader,
          references: targetMessageIdHeader,
        });
        if (updated.ok) {
          finalDraftId = updated.draftId || finalDraftId;
        } else {
          draftWriteError = updated.error || "Failed to update Gmail draft.";
        }
      } else {
        if (!targetThreadId) {
          return {
            handled: true,
            reply: `Draft #${parsed.alias} has no target thread id. Re-run triage for this message first.`,
          };
        }
        const created = await createGmailDraft({
          datagranApiKey,
          connectionId: row.connection_id,
          threadId: targetThreadId,
          to,
          cc,
          subject: subj,
          body: parsed.text,
          inReplyTo: targetMessageIdHeader,
          references: targetMessageIdHeader,
        });
        if (created.ok && created.draftId) {
          finalDraftId = created.draftId;
        } else {
          draftWriteError = created.error || "Failed to create Gmail draft id.";
        }
      }

      if (draftWriteError) {
        return {
          handled: true,
          reply: `Failed to update draft #${parsed.alias}: ${draftWriteError}`,
        };
      }

      await args.supabase
        .from("inbox_actions")
        .update({
          draft_body: parsed.text,
          gmail_draft_id: finalDraftId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("user_id", args.userId);

      const mailbox = shortMailboxLabel(row.mailbox_label || "");
      const draftIdLine = finalDraftId ? ` (draft id: ${finalDraftId})` : "";
      return {
        handled: true,
        reply: `Updated draft #${parsed.alias} in ${mailbox}${draftIdLine}. Use "approve ${parsed.alias}" and then "send ${parsed.alias}" when ready.`,
      };
    }

    // approve/reject
    const aliasRows = await args.supabase
      .from("inbox_action_aliases_agent")
      .select("alias,action_id")
      .eq("user_id", args.userId)
      .eq("agent_id", args.agentId)
      .order("alias", { ascending: true });
    const aliasList = (aliasRows.data || [])
      .map((r) => ({
        alias: Number((r as { alias?: unknown }).alias),
        actionId: toTrimmed((r as { action_id?: unknown }).action_id),
      }))
      .filter((r) => Number.isFinite(r.alias) && r.alias > 0 && r.actionId);

    const targetAliases = parsed.all
      ? aliasList.map((a) => a.alias)
      : parsed.aliases.filter((n) => Number.isFinite(n) && n > 0);

    if (targetAliases.length === 0) {
      return {
        handled: true,
        reply: `Specify action numbers, e.g. "${parsed.kind} 1" or "${parsed.kind} 1 2".`,
      };
    }

    const wanted = aliasList.filter((a) => targetAliases.includes(a.alias));
    const missing = targetAliases.filter((n) => !wanted.some((w) => w.alias === n));
    if (wanted.length === 0) {
      return {
        handled: true,
        reply: `I couldn't find those action numbers${missing.length ? `: ${missing.join(", ")}` : ""}.`,
      };
    }

    const rows = await args.supabase
      .from("inbox_actions")
      .select("*")
      .eq("user_id", args.userId)
      .in("id", wanted.map((w) => w.actionId));
    const byId = new Map<string, InboxActionRow>();
    for (const r of rows.data || []) {
      const parsedRow = rowToInboxAction(r);
      if (parsedRow) byId.set(parsedRow.id, parsedRow);
    }

    const normalizedUserText = normalizeInboxCommandText(args.text);
    const mentioned = extractMentionedAliases(
      normalizedUserText,
      new Set(aliasList.map((a) => a.alias))
    );
    const isImplicit = wanted.some((w) => mentioned.size === 0 || !mentioned.has(w.alias));
    if (isImplicit) {
      const lines = wanted
        .slice()
        .sort((a, b) => a.alias - b.alias)
        .map((w) => {
          const row = byId.get(w.actionId);
          if (!row) return `- #${w.alias}: missing action`;
          return `- #${w.alias} ${shortMailboxLabel(row.mailbox_label || "")}: ${row.recommended_action} (${row.status}) — ${row.subject || "(no subject)"}`;
        });
      const confirmAliases = wanted
        .map((w) => w.alias)
        .sort((a, b) => a - b);
      const confirmCmd = `${parsed.kind} ${confirmAliases.join(" ")}`;
      const missingLine = missing.length > 0 ? `\nMissing aliases: ${missing.join(", ")}` : "";
      await savePendingInboxCommandConfirmation({
        supabase: args.supabase,
        userId: args.userId,
        agentId: args.agentId,
        payload: {
          kind: parsed.kind,
          parsed: { kind: parsed.kind, aliases: confirmAliases, all: false },
          confirm_cmd: confirmCmd,
          summary_lines: lines,
        },
      });
      return {
        handled: true,
        reply:
          `I can do that, but please confirm first.\n\n` +
          `Proposed ${parsed.kind}:\n${lines.join("\n")}${missingLine}\n\n` +
          `To confirm, reply with a confirmation (any phrasing) or paste: ${confirmCmd}`,
      };
    }

    const outcomes: string[] = [];
    const pendingConnectorExecutes: InboxCommandConnectorExecute[] = [];
    for (const alias of wanted) {
      const row = byId.get(alias.actionId);
      if (!row) {
        outcomes.push(`#${alias.alias}: missing action`);
        continue;
      }
      const prefix = formatOutcomePrefix(alias.alias, row);
      if (row.status !== "pending") {
        outcomes.push(`${prefix}: already handled`);
        continue;
      }
      if (parsed.kind === "reject") {
        await completeAction({
          supabase: args.supabase,
          actionId: row.id,
          userId: args.userId,
          status: "rejected",
          extra: {
            ...(asRecord(row.metadata) || {}),
            rejected_via: "command",
            rejected_at: new Date().toISOString(),
          },
        });
        outcomes.push(`${prefix}: rejected`);
        continue;
      }

      if (row.recommended_action === "draft_reply") {
        await markDraftSendConfirmationPending({
          supabase: args.supabase,
          row,
          userId: args.userId,
          alias: alias.alias,
        });
        outcomes.push(`${prefix}: draft approved. Send is not executed yet. Confirm with "send ${alias.alias}".`);
        continue;
      }

      const lock = await tryAcquireActionExecutionLock({
        supabase: args.supabase,
        actionId: row.id,
        userId: args.userId,
      });
      if (!lock) {
        outcomes.push(`${prefix}: already handled`);
        continue;
      }

      const datagranApiKey = await resolveConnectionDatagranKey({
        supabase: args.supabase,
        userId: args.userId,
        connectionId: lock.connection_id,
      });
      const labels = await ensureGroovyLabels({
        datagranApiKey,
        connectionId: lock.connection_id,
      });
      const exec = await executeInboxAction({
        supabase: args.supabase,
        row: lock,
        datagranApiKey,
        labels,
      });
      if (exec.ok) {
        await completeAction({
          supabase: args.supabase,
          actionId: lock.id,
          userId: args.userId,
          status: "done",
          extra: {
            ...(asRecord(lock.metadata) || {}),
            approved_via: "command",
            execution_detail: exec.detail,
            ...(Array.isArray(exec.connectorExecutes) && exec.connectorExecutes.length > 0
              ? {
                  local_unsubscribe_queued: true,
                  local_unsubscribe_executes: exec.connectorExecutes.map((e) => ({
                    connectorType: e.connectorType,
                    toolCallId: e.toolCallId,
                    subject: toTrimmed(e.connectorParams?.subject),
                  })),
                }
              : {}),
          },
        });
        outcomes.push(`${prefix}: ${exec.detail}`);
        if (Array.isArray(exec.connectorExecutes) && exec.connectorExecutes.length > 0) {
          pendingConnectorExecutes.push(...exec.connectorExecutes);
        }
      } else {
        await completeAction({
          supabase: args.supabase,
          actionId: lock.id,
          userId: args.userId,
          status: "failed",
          extra: {
            ...(asRecord(lock.metadata) || {}),
            execution_error: exec.detail,
          },
        });
        outcomes.push(`${prefix}: failed (${exec.detail})`);
      }
    }

    await resequencePendingAliases({
      supabase: args.supabase,
      userId: args.userId,
      agentId: args.agentId,
    });

    const prefix = parsed.kind === "approve" ? "Approval results" : "Rejection results";
    const missingLine = missing.length > 0 ? `\nMissing aliases: ${missing.join(", ")}` : "";
    const connectorExecutes =
      pendingConnectorExecutes.length > 0
        ? Array.from(
            new Map(pendingConnectorExecutes.map((e) => [`${e.toolCallId}:${e.connectorType}`, e])).values()
          )
        : [];
    const connectorLine =
      connectorExecutes.length > 0
        ? `\nLocal unsubscribe execution queued: ${connectorExecutes.length}.`
        : "";
    return {
      handled: true,
      reply: `${prefix}:\n${outcomes.join("\n")}${missingLine}${connectorLine}`,
      connectorExecutes: connectorExecutes.length > 0 ? connectorExecutes : undefined,
      statusMessage: connectorExecutes.length > 0 ? "Completing unsubscribe locally..." : undefined,
    };
  };

  if (parsed.kind === "multi") {
    const priority = (k: ParsedInboxCommandSingle["kind"]): number => {
      if (k === "edit") return 1;
      if (k === "batch" || k === "approve" || k === "reject") return 2;
      if (k === "confirm_send") return 3;
      return 4;
    };
    const commands = Array.isArray(parsed.commands) ? parsed.commands.slice() : [];
    commands.sort((a, b) => priority(a.kind) - priority(b.kind));
    const replies: string[] = [];
    const pendingConnectorExecutes: InboxCommandConnectorExecute[] = [];
    let statusMessage: string | undefined = undefined;
    for (const cmd of commands) {
      const res = await runSingle(cmd);
      if (toTrimmed(res.reply)) replies.push(res.reply);
      if (Array.isArray(res.connectorExecutes) && res.connectorExecutes.length > 0) {
        pendingConnectorExecutes.push(...res.connectorExecutes);
        statusMessage = res.statusMessage || statusMessage;
      }
    }
    const connectorExecutes =
      pendingConnectorExecutes.length > 0
        ? Array.from(
            new Map(pendingConnectorExecutes.map((e) => [`${e.toolCallId}:${e.connectorType}`, e])).values()
          )
        : [];
    return withFollowupText({
      handled: true,
      reply: replies.join("\n\n") || "Done.",
      connectorExecutes: connectorExecutes.length > 0 ? connectorExecutes : undefined,
      statusMessage: connectorExecutes.length > 0 ? statusMessage || "Completing unsubscribe locally..." : undefined,
    });
  }

  return withFollowupText(await runSingle(parsed));
}

export async function runInboxTriageForHeartbeat(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId?: string | null;
  sessionId?: string | null;
  sourceJobId?: string | null;
  userEmail?: string | null;
  policyModel: HeartbeatPolicyModel;
  memoryContext?: string;
  preferenceContext?: string;
  mailboxes: TriageMailbox[];
  emails: TriageEmailItem[];
}): Promise<HeartbeatTriageResult> {
  const runId = `hb-email-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const notes: string[] = [];
  if (!Array.isArray(args.emails) || args.emails.length === 0) {
    return {
      runId,
      pendingActionIds: [],
      pendingCount: 0,
      autoExecutedCount: 0,
      criticalCount: 0,
      notes,
    };
  }

  const byConnection = new Map<string, TriageMailbox>();
  for (const m of args.mailboxes || []) byConnection.set(m.connectionId, m);
  const labelCache = new Map<string, LabelsByName>();
  const keyCache = new Map<string, string>();
  const affinityCache = new Map<string, SenderAffinity>();
  const intelCache = new Map<string, SenderIntel>();
  const draftReplyScopeClaims = new Set<string>();

  const pendingActionIds: string[] = [];
  let autoExecutedCount = 0;
  let criticalCount = 0;

  const items = args.emails
    .slice(0, INBOX_ACTIONS_MAX_PER_RUN)
    .map((item) => ({
      ...item,
      connectionId: toTrimmed(item.connectionId),
      mailboxLabel: shortMailboxLabel(item.mailboxLabel),
      id: toTrimmed(item.id),
      threadId: toTrimmed(item.threadId),
      from: toTrimmed(item.from),
      to: toTrimmed(item.to),
      cc: toTrimmed(item.cc),
      subject: toTrimmed(item.subject),
      date: toTrimmed(item.date),
      snippet: toTrimmed(item.snippet),
      listUnsubscribe: toTrimmed(item.listUnsubscribe || ""),
      messageIdHeader: toTrimmed(item.messageIdHeader || ""),
    }))
    .filter((i) => i.connectionId && i.id);

  await mapLimit(items, 3, async (item) => {
    const sender = parseSender(item.from);
    if (!sender.email && !sender.domain) return;

    let dgKey = keyCache.get(item.connectionId) || "";
    if (!dgKey) {
      const mailbox = byConnection.get(item.connectionId);
      dgKey = toTrimmed(mailbox?.datagranApiKey || "");
      if (!dgKey) {
        dgKey = await resolveConnectionDatagranKey({
          supabase: args.supabase,
          userId: args.userId,
          connectionId: item.connectionId,
        });
      }
      keyCache.set(item.connectionId, dgKey);
    }
    if (!dgKey) return;

    const affinityKey = `${item.connectionId}:${normalizeKey(sender.email)}`;
    let affinity = affinityCache.get(affinityKey);
    if (!affinity) {
      affinity = await fetchSenderAffinity({
        supabase: args.supabase,
        userId: args.userId,
        connectionId: item.connectionId,
        datagranApiKey: dgKey,
        senderEmail: sender.email,
      });
      affinityCache.set(affinityKey, affinity);
    }

    const intelKey = normalizeKey(sender.domain);
    let intel = intelCache.get(intelKey);
    if (!intel) {
      intel = await fetchSenderIntel({
        supabase: args.supabase,
        userId: args.userId,
        sender,
      });
      intelCache.set(intelKey, intel);
    }

    const full = await fetchFullMessageAndThread({
      datagranApiKey: dgKey,
      connectionId: item.connectionId,
      messageId: item.id,
      threadId: item.threadId || null,
    });
    let decision =
      (await runStageBPolicy({
        policyModel: args.policyModel,
        item,
        sender,
        intel,
        affinity,
        fullBody: full.body,
        threadSummary: full.threadSummary,
        threadCandidates: full.threadCandidates,
        memoryContext: args.memoryContext,
        preferenceContext: args.preferenceContext,
      })) || null;
    if (!decision) {
      notes.push(`${item.mailboxLabel}: triage model failed for "${item.subject}"`);
      decision = {
        action: "label_only",
        autoExecute: false,
        confidence: 0.2,
        pImportant: 0.5,
        pSpam: 0.5,
        pActionable: 0.5,
        reason: "Triage model failed; manual review recommended.",
        critical: false,
        draftReply: "",
      };
    }

    if (decision.critical) criticalCount += 1;

    let targetThreadIdForDraft: string | null = null;
    let targetMessageIdHeaderForDraft: string | null = null;
    let targetResolutionForDraft: string | null = null;
    let targetFromHeaderForDraft: string | null = null;
    let targetToHeaderForDraft: string | null = null;
    let targetCcHeaderForDraft: string | null = null;
    let draftInfo:
      | { to: string[]; cc?: string[]; subject: string; body: string; gmailDraftId?: string | null }
      | null = null;

    if (decision.action === "draft_reply") {
      const targetResolution = resolveDraftTarget({
        decision,
        item,
        threadCandidates: full.threadCandidates,
      });
      targetResolutionForDraft = targetResolution.reason;
      if (!targetResolution.ok) {
        notes.push(
          `${item.mailboxLabel}: draft_reply skipped for "${item.subject}" (${targetResolution.reason})`
        );
        decision = {
          ...decision,
          action: "label_only",
          autoExecute: false,
          reason: `Model selected draft_reply but target was ambiguous: ${targetResolution.reason}`,
          draftReply: "",
          targetThreadId: undefined,
          targetMessageIdHeader: undefined,
          targetReason: undefined,
        };
      } else {
        const anchor = targetResolution.candidate;
        const anchorSender = parseSender(anchor.from).email || sender.email;
        targetThreadIdForDraft = toTrimmed(anchor.threadId || item.threadId) || null;
        targetMessageIdHeaderForDraft = toTrimmed(anchor.messageIdHeader || item.messageIdHeader) || null;
        targetFromHeaderForDraft = toTrimmed(anchor.from) || null;
        targetToHeaderForDraft = toTrimmed(anchor.to) || null;
        targetCcHeaderForDraft = toTrimmed(anchor.cc) || null;

        const draftSubjectSource = toTrimmed(anchor.subject || item.subject);
        const draftSubject = draftSubjectSource ? `Re: ${draftSubjectSource}` : "Re:";
        const replyAll = buildReplyAllRecipients({
          senderEmail: anchorSender,
          toHeader: anchor.to || item.to,
          ccHeader: anchor.cc || item.cc,
          userEmail: args.userEmail || null,
        });
        const draftTo = replyAll.to.length > 0 ? replyAll.to : anchorSender ? [anchorSender] : [];
        const draftCc = replyAll.cc;
        if (!targetThreadIdForDraft) {
          notes.push(
            `${item.mailboxLabel}: draft_reply skipped for "${item.subject}" (target thread id missing)`
          );
          decision = {
            ...decision,
            action: "label_only",
            autoExecute: false,
            reason: "Model selected draft_reply but target thread id was missing; manual review recommended.",
            draftReply: "",
            targetThreadId: undefined,
            targetMessageIdHeader: undefined,
            targetReason: undefined,
          };
          targetMessageIdHeaderForDraft = null;
          targetFromHeaderForDraft = null;
          targetToHeaderForDraft = null;
          targetCcHeaderForDraft = null;
        }
        if (decision.action === "draft_reply" && draftTo.length === 0) {
          notes.push(
            `${item.mailboxLabel}: triage returned draft_reply but no recipients were found for "${item.subject}"`
          );
          decision = {
            ...decision,
            action: "label_only",
            autoExecute: false,
            reason: "Model selected draft_reply but no recipients were available; manual review recommended.",
            draftReply: "",
            targetThreadId: undefined,
            targetMessageIdHeader: undefined,
            targetReason: undefined,
          };
          targetThreadIdForDraft = null;
          targetMessageIdHeaderForDraft = null;
          targetFromHeaderForDraft = null;
          targetToHeaderForDraft = null;
          targetCcHeaderForDraft = null;
        }
        const rawDraft = toTrimmed(decision.draftReply || "");
        if (decision.action === "draft_reply" && !rawDraft) {
          notes.push(`${item.mailboxLabel}: triage returned draft_reply but draft text was empty for "${item.subject}"`);
          decision = {
            ...decision,
            action: "label_only",
            autoExecute: false,
            reason: "Model selected draft_reply but provided no draft text; manual review recommended.",
            draftReply: "",
            targetThreadId: undefined,
            targetMessageIdHeader: undefined,
            targetReason: undefined,
          };
          targetThreadIdForDraft = null;
          targetMessageIdHeaderForDraft = null;
          targetFromHeaderForDraft = null;
          targetToHeaderForDraft = null;
          targetCcHeaderForDraft = null;
        }
        const replyBody = rawDraft ? appendGroovyEmailSendNotice(rawDraft) : "";
        if (decision.action === "draft_reply" && replyBody && draftTo.length > 0) {
          const draftScopeThreadId = targetThreadIdForDraft || item.threadId || "";
          const draftScopeKey = `${item.connectionId}:${draftScopeThreadId || `message:${item.id}`}`;
          if (draftReplyScopeClaims.has(draftScopeKey)) {
            notes.push(
              `${item.mailboxLabel}: draft_reply skipped for "${item.subject}" (draft already queued for this thread in this heartbeat)`
            );
            return;
          }
          draftReplyScopeClaims.add(draftScopeKey);

          const existingDraftAction = await findExistingDraftReplyAction({
            supabase: args.supabase,
            userId: args.userId,
            connectionId: item.connectionId,
            messageId: item.id,
            threadId: draftScopeThreadId,
          });
          if (existingDraftAction) {
            if (existingDraftAction.status === "pending" && !pendingActionIds.includes(existingDraftAction.id)) {
              pendingActionIds.push(existingDraftAction.id);
            }
            notes.push(
              `${item.mailboxLabel}: draft_reply skipped for "${item.subject}" (draft action already exists for this thread)`
            );
            return;
          }

          draftInfo = {
            to: draftTo,
            cc: draftCc,
            subject: draftSubject,
            body: replyBody,
            gmailDraftId: null,
          };
        }
      }
    }

    const actionWrite = await insertInboxAction({
      supabase: args.supabase,
      userId: args.userId,
      agentId: args.agentId || null,
      sessionId: args.sessionId || null,
      sourceJobId: args.sourceJobId || null,
      runId,
      item,
      sender,
      decision,
      draft: draftInfo,
      metadata: {
        sender_intel: intel,
        sender_affinity: affinity,
        list_unsubscribe: splitListUnsubscribe(item.listUnsubscribe || ""),
        message_id_header: item.messageIdHeader || null,
        original_to_header: item.to || null,
        original_cc_header: item.cc || null,
        user_email: args.userEmail || null,
        ...(targetThreadIdForDraft ? { target_thread_id: targetThreadIdForDraft } : {}),
        ...(targetMessageIdHeaderForDraft ? { target_message_id_header: targetMessageIdHeaderForDraft } : {}),
        ...(targetResolutionForDraft ? { target_resolution: targetResolutionForDraft } : {}),
        ...(targetFromHeaderForDraft ? { target_from_header: targetFromHeaderForDraft } : {}),
        ...(targetToHeaderForDraft ? { target_to_header: targetToHeaderForDraft } : {}),
        ...(targetCcHeaderForDraft ? { target_cc_header: targetCcHeaderForDraft } : {}),
        ...(draftInfo?.cc && draftInfo.cc.length > 0 ? { draft_cc: draftInfo.cc } : {}),
      },
      status: "pending",
    });

    if (!actionWrite) return;
    let actionRow = actionWrite.row;
    if (decision.action === "draft_reply" && draftInfo && actionWrite.inserted) {
      const created = await createGmailDraft({
        datagranApiKey: dgKey,
        connectionId: item.connectionId,
        threadId: targetThreadIdForDraft,
        to: draftInfo.to.join(", "),
        cc: (draftInfo.cc || []).join(", "),
        subject: draftInfo.subject,
        body: draftInfo.body,
        inReplyTo: targetMessageIdHeaderForDraft,
        references: targetMessageIdHeaderForDraft,
      });
      const createdDraftId = created.ok ? created.draftId || null : null;
      if (createdDraftId) {
        await args.supabase
          .from("inbox_actions")
          .update({
            gmail_draft_id: createdDraftId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", actionRow.id)
          .eq("user_id", args.userId);
        actionRow = {
          ...actionRow,
          gmail_draft_id: createdDraftId,
        };
        let labels = labelCache.get(item.connectionId);
        if (!labels) {
          labels = await ensureGroovyLabels({
            datagranApiKey: dgKey,
            connectionId: item.connectionId,
          });
          labelCache.set(item.connectionId, labels);
        }
        await modifyGmailMessageLabels({
          datagranApiKey: dgKey,
          connectionId: item.connectionId,
          messageId: item.id,
          addLabelIds: [labels[GROOVY_LABEL_DRAFTED]].filter(Boolean),
        });
      } else if (!created.ok) {
        notes.push(
          `${item.mailboxLabel}: draft pre-create failed for "${item.subject}" (${created.error || "unknown error"})`
        );
      }
    }

    const auto = decision.autoExecute === true;
    if (!auto) {
      if (actionRow.status === "pending" && actionRow.run_id === runId) {
        pendingActionIds.push(actionRow.id);
      }
      return;
    }

    if (actionRow.status !== "pending") return;

    const lock = await tryAcquireActionExecutionLock({
      supabase: args.supabase,
      actionId: actionRow.id,
      userId: args.userId,
    });
    if (!lock) return;
    let labels = labelCache.get(item.connectionId);
    if (!labels) {
      labels = await ensureGroovyLabels({
        datagranApiKey: dgKey,
        connectionId: item.connectionId,
      });
      labelCache.set(item.connectionId, labels);
    }
    const exec = await executeInboxAction({
      supabase: args.supabase,
      row: lock,
      datagranApiKey: dgKey,
      labels,
    });
    if (exec.ok) {
      autoExecutedCount += 1;
      await completeAction({
        supabase: args.supabase,
        actionId: lock.id,
        userId: args.userId,
        status: "done",
        extra: {
          ...(asRecord(lock.metadata) || {}),
          auto_executed: true,
          execution_detail: exec.detail,
        },
      });
      notes.push(`${item.mailboxLabel}: ${decision.action} auto-executed for "${item.subject}"`);
    } else {
      await completeAction({
        supabase: args.supabase,
        actionId: lock.id,
        userId: args.userId,
        status: "failed",
        extra: {
          ...(asRecord(lock.metadata) || {}),
          auto_executed: true,
          execution_error: exec.detail,
        },
      });
      notes.push(`${item.mailboxLabel}: auto action failed for "${item.subject}" (${exec.detail})`);
    }
  });

  return {
    runId,
    pendingActionIds,
    pendingCount: pendingActionIds.length,
    autoExecutedCount,
    criticalCount,
    notes,
  };
}

export async function buildHeartbeatActionBlock(args: {
  supabase: SupabaseClient;
  userId: string;
  agentId: string;
  runId: string;
  pendingActionIds: string[];
}): Promise<BuildHeartbeatActionBlockResult> {
  const requestedIds = Array.from(new Set(args.pendingActionIds.filter(Boolean)));
  const sessionPendingRes = await args.supabase
    .from("inbox_actions")
    .select("id")
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .eq("status", "pending")
    .order("confidence", { ascending: false })
    .limit(COMMAND_LIST_MAX_ROWS);
  const sessionPendingIds = (sessionPendingRes.data || [])
    .map((row) => toTrimmed((row as { id?: unknown }).id))
    .filter(Boolean);
  const ids = Array.from(new Set([...requestedIds, ...sessionPendingIds]));
  if (ids.length === 0) {
    // Clear stale aliases for this agent if nothing is pending.
    await syncSessionAliases({
      supabase: args.supabase,
      userId: args.userId,
      agentId: args.agentId,
      actionIds: [],
    });
    return { block: "", pendingCount: 0, aliases: [] };
  }

  const rowsRes = await args.supabase
    .from("inbox_actions")
    .select("*")
    .eq("user_id", args.userId)
    .eq("agent_id", args.agentId)
    .eq("status", "pending")
    .in("id", ids)
    .order("confidence", { ascending: false })
    .limit(COMMAND_LIST_MAX_ROWS);

  const rows: InboxActionRow[] = [];
  for (const raw of rowsRes.data || []) {
    const parsed = rowToInboxAction(raw);
    if (parsed) rows.push(parsed);
  }
  if (rows.length === 0) {
    await syncSessionAliases({
      supabase: args.supabase,
      userId: args.userId,
      agentId: args.agentId,
      actionIds: [],
    });
    return { block: "", pendingCount: 0, aliases: [] };
  }

  const mappings = await syncSessionAliases({
    supabase: args.supabase,
    userId: args.userId,
    agentId: args.agentId,
    actionIds: rows.map((r) => r.id),
  });
  const byAlias = new Map<number, InboxActionRow>();
  for (const m of mappings) {
    const row = rows.find((r) => r.id === m.actionId);
    if (row) byAlias.set(m.alias, row);
  }

  const sections = mappings
    .sort((a, b) => a.alias - b.alias)
    .map((m) => {
      const row = byAlias.get(m.alias);
      if (!row) return "";
      return formatActionForHeartbeat(m.alias, row);
    })
    .filter(Boolean);

  if (sections.length === 0) return { block: "", pendingCount: 0, aliases: mappings };

  const block =
    `\n\nEmail actions pending (${sections.length}):\n` +
    `${sections.join("\n\n")}\n\n` +
    `Actions execute only after explicit confirmation.\n` +
    `You can also say: show actions | draft 9 | approve all unsubscribes`;
  return {
    block,
    pendingCount: sections.length,
    aliases: mappings,
  };
}
