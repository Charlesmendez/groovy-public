import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import {
  calendarMessageMethod,
  calendarPartsContainInvitation,
  parseIcsCalendarInvitation,
  type ParsedCalendarInvitation,
} from "@/lib/email/calendarInvite";
import {
  ensureGroovyAiEmailDisclosure,
  GROOVY_AI_EMAIL_DISCLOSURE,
} from "@/lib/email/disclosure";
import {
  canRenderEmailAttachmentAsInlineImage,
  emailAttachmentUrl,
} from "@/lib/email/attachment";
import {
  normalizeEmailContentId,
  sanitizeEmailHtml,
} from "@/lib/email/html";
import type {
  EmailDraft,
  EmailDraftAttachment,
  EmailMailbox,
  EmailMessage,
} from "@/lib/email/types";

const DATAGRAN_ORIGIN = "https://www.datagran.io";
const REQUEST_TIMEOUT_MS = 45_000;
const GMAIL_PROFILE_CACHE_TTL_MS = 5 * 60_000;
const GMAIL_LABEL_CACHE_TTL_MS = 30 * 60_000;
// Gmail's documented per-user quota comfortably supports a small parallel
// read window. Two-at-a-time made a 30-result search wait through 15 serial
// network rounds, which was especially painful through the Datagran proxy.
// Mutations remain serialized per mailbox below.
const GMAIL_MAX_CONCURRENT_REQUESTS = 6;
const GMAIL_RETRY_DELAYS_MS = [1_000, 3_000, 7_000] as const;
const GMAIL_MAX_RATE_LIMIT_RETRIES = 1;
const GMAIL_MAX_RETRY_AFTER_MS = 20_000;
const GMAIL_LIST_CACHE_TTL_MS = 10_000;
const GMAIL_ITEM_CACHE_TTL_MS = 45_000;
// Vercel caps request bodies before a function can read them. Gmail's normal
// JSON draft API base64-encodes the complete MIME message a second time, so a
// few megabytes of attachments can cross that boundary. Media uploads keep the
// MIME message binary and resumable uploads split larger messages into chunks.
const GMAIL_MEDIA_UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;
const GMAIL_LIST_MESSAGE_FIELDS =
  "id,threadId,labelIds,snippet,internalDate," +
  "payload(filename,mimeType,headers,body/attachmentId," +
  "parts(filename,mimeType,headers,body/attachmentId," +
  "parts(filename,mimeType,headers,body/attachmentId)))";
const GMAIL_THREAD_MESSAGE_FIELDS =
  `messages(${GMAIL_LIST_MESSAGE_FIELDS})`;

const MAILBOX_COLORS = [
  "#22d3ee",
  "#a78bfa",
  "#34d399",
  "#f59e0b",
  "#fb7185",
  "#60a5fa",
  "#c084fc",
  "#2dd4bf",
  "#f97316",
  "#84cc16",
] as const;

export const GROOVY_EMAIL_LABELS = {
  processed: "Groovy/Processed",
  drafted: "Groovy/Drafted",
  spam: "Groovy/Spam",
  unsubscribed: "Groovy/Unsubscribed",
} as const;

export type GroovyEmailLabelName =
  (typeof GROOVY_EMAIL_LABELS)[keyof typeof GROOVY_EMAIL_LABELS];

type RecordLike = Record<string, unknown>;

export type GmailCallResult = {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
  needsReauth?: boolean;
  retryAfterMs?: number;
  responseHeaders?: Record<string, string>;
};

export class GmailApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number;
  readonly needsReauth: boolean;

  constructor(
    message: string,
    options: {
      status: number;
      retryable: boolean;
      retryAfterMs?: number;
      needsReauth?: boolean;
    },
  ) {
    super(message);
    this.name = "GmailApiError";
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs || 0;
    this.needsReauth = options.needsReauth === true;
  }
}

export type GmailCalendarInvitationPayloadErrorCode =
  | "missing_calendar_part"
  | "calendar_part_too_large"
  | "calendar_data_unavailable"
  | "non_actionable_calendar_method"
  | "invalid_calendar_data";

export class GmailCalendarInvitationPayloadError extends Error {
  readonly code: GmailCalendarInvitationPayloadErrorCode;

  constructor(
    code: GmailCalendarInvitationPayloadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GmailCalendarInvitationPayloadError";
    this.code = code;
  }
}

const gmailProfileCache = new Map<
  string,
  { expiresAt: number; result: GmailCallResult }
>();
const gmailProfileInflight = new Map<string, Promise<GmailCallResult>>();
const gmailGetCache = new Map<
  string,
  { expiresAt: number; result: GmailCallResult }
>();
const gmailLabelCache = new Map<
  string,
  { expiresAt: number; labels: Record<string, string> }
>();
const gmailLabelInflight = new Map<
  string,
  Promise<Record<string, string>>
>();
const gmailRequestQueue: Array<() => void> = [];
const gmailInteractiveRequestQueue: Array<() => void> = [];
const gmailMutationLocks = new Map<
  string,
  {
    active: boolean;
    interactiveWaiters: Array<() => void>;
    waiters: Array<() => void>;
  }
>();
let gmailActiveRequests = 0;
const gmailRateLimitedUntilByApiKey = new Map<string, number>();

export type EmailMailboxConnection = EmailMailbox & {
  datagranApiKey: string;
};

export type GmailThreadMessageItem = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  internalDate: string;
  messageIdHeader: string;
  references: string;
  listUnsubscribe?: string;
  authenticationResults?: string;
  autoSubmitted?: string;
  precedence?: string;
  listId?: string;
  snippet: string;
  labelIds: string[];
  hasAttachments: boolean;
  hasCalendarInvitation: boolean;
};

export type GmailThreadListItem = GmailThreadMessageItem & {
  matchedItem?: GmailThreadMessageItem;
  threadHasSentMessage?: boolean;
};

export type GmailThreadListResult = {
  items: GmailThreadListItem[];
  nextPageToken: string | null;
  resultSizeEstimate: number;
};

export type GmailMessageRef = {
  id: string;
  threadId: string;
};

export type GmailMessageRefListResult = {
  items: GmailMessageRef[];
  nextPageToken: string | null;
  resultSizeEstimate: number;
};

export type GmailHistoryMessageRefListResult = {
  added: GmailMessageRef[];
  changed: GmailMessageRef[];
  historyId: string;
  nextPageToken: string | null;
};

export function isGmailDraftMessage(labelIds: readonly string[]): boolean {
  return labelIds.some((labelId) => labelId.trim().toUpperCase() === "DRAFT");
}

export function isGmailTrashMessage(labelIds: readonly string[]): boolean {
  return labelIds.some((labelId) => labelId.trim().toUpperCase() === "TRASH");
}

export function gmailMessageIdKey(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .replace(/^</, "")
    .replace(/>$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Gmail can retain several mailbox records for one logical message. In
 * particular, recipient-specific SMTP delivery creates one private Sent copy
 * per envelope recipient before Groovy replaces them with a single canonical
 * copy. Those records intentionally share the same RFC Message-ID and must not
 * appear as separate messages in a conversation.
 */
export function collapseDuplicateGmailThreadItems<
  Item extends Pick<GmailThreadMessageItem, "messageIdHeader">,
>(items: readonly Item[]): Item[] {
  const seenMessageIds = new Set<string>();
  return items.filter((item) => {
    const key = gmailMessageIdKey(item.messageIdHeader);
    if (!key) return true;
    if (seenMessageIds.has(key)) return false;
    seenMessageIds.add(key);
    return true;
  });
}

function record(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value === null || value === undefined
      ? ""
      : String(value).trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean);
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function defaultMailboxColor(connectionId: string, index = 0): string {
  const start = hashString(connectionId) % MAILBOX_COLORS.length;
  return MAILBOX_COLORS[(start + index) % MAILBOX_COLORS.length];
}

function mailboxMonogram(name: string, address: string): string {
  const source = name.trim() || address.split("@")[0] || "M";
  const words = source.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function publicMailbox(
  mailbox: EmailMailboxConnection,
  counts?: Partial<EmailMailbox["counts"]>,
): EmailMailbox {
  return {
    connectionId: mailbox.connectionId,
    provider: "gmail",
    address: mailbox.address,
    displayName: mailbox.displayName,
    color: mailbox.color,
    monogram: mailbox.monogram,
    isDefaultSender: mailbox.isDefaultSender,
    includedInUnified: mailbox.includedInUnified,
    aiInstructions: mailbox.aiInstructions,
    status: mailbox.status,
    ...(mailbox.statusMessage
      ? { statusMessage: mailbox.statusMessage }
      : {}),
    counts: {
      inbox: counts?.inbox ?? mailbox.counts.inbox,
      focus: counts?.focus ?? mailbox.counts.focus,
      drafts: counts?.drafts ?? mailbox.counts.drafts,
      noise: counts?.noise ?? mailbox.counts.noise,
    },
  };
}

function parseDatagranError(data: unknown): string {
  if (typeof data === "string") return data.slice(0, 500);
  const root = record(data);
  if (!root) return "Datagran request failed";
  if (typeof root.message === "string") return root.message.slice(0, 500);
  if (typeof root.error === "string") return root.error.slice(0, 500);
  const nested = record(root.error);
  if (nested && typeof nested.message === "string") {
    return nested.message.slice(0, 500);
  }
  return JSON.stringify(data).slice(0, 500);
}

function needsReauthorization(status: number, message: string): boolean {
  if (status === 401) return true;
  if (/rate limit|quota|too many requests/i.test(message)) return false;
  return /authorization|required|reauth|expired|invalid.*token|insufficient.*scope/i.test(
    message,
  );
}

function gmailGetCacheTtl(url: URL): number {
  if (
    url.pathname.includes("/drafts/") ||
    url.pathname.includes("/attachments/")
  ) {
    return 0;
  }
  if (url.pathname.endsWith("/messages")) return GMAIL_LIST_CACHE_TTL_MS;
  if (
    /\/users\/me\/(?:messages|threads)\/[^/]+$/.test(url.pathname)
  ) {
    return GMAIL_ITEM_CACHE_TTL_MS;
  }
  return 0;
}

function pruneGmailGetCache(now: number): void {
  if (gmailGetCache.size <= 750) return;
  for (const [key, entry] of gmailGetCache) {
    if (entry.expiresAt <= now) gmailGetCache.delete(key);
  }
  while (gmailGetCache.size > 750) {
    const oldest = gmailGetCache.keys().next().value;
    if (typeof oldest !== "string") break;
    gmailGetCache.delete(oldest);
  }
}

function invalidateGmailGetCache(connectionId: string): void {
  const prefix = `${connectionId}:`;
  for (const key of gmailGetCache.keys()) {
    if (key.startsWith(prefix)) gmailGetCache.delete(key);
  }
}

async function acquireGmailRequestSlot(
  interactive = false,
): Promise<() => void> {
  if (gmailActiveRequests >= GMAIL_MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve) =>
      (interactive
        ? gmailInteractiveRequestQueue
        : gmailRequestQueue
      ).push(resolve),
    );
  } else {
    gmailActiveRequests += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next =
      gmailInteractiveRequestQueue.shift() || gmailRequestQueue.shift();
    if (next) {
      // Transfer this slot directly to the oldest waiter. Keeping the active
      // count unchanged avoids a newly arriving request racing ahead of it.
      next();
    } else {
      gmailActiveRequests = Math.max(0, gmailActiveRequests - 1);
    }
  };
}

async function acquireGmailMutationLock(
  connectionId: string,
  interactive = false,
): Promise<() => void> {
  let lock = gmailMutationLocks.get(connectionId);
  if (!lock) {
    lock = { active: false, interactiveWaiters: [], waiters: [] };
    gmailMutationLocks.set(connectionId, lock);
  }
  if (lock.active) {
    await new Promise<void>((resolve) =>
      (interactive
        ? lock?.interactiveWaiters
        : lock?.waiters
      )?.push(resolve),
    );
  } else {
    lock.active = true;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = gmailMutationLocks.get(connectionId);
    if (!current) return;
    const next =
      current.interactiveWaiters.shift() || current.waiters.shift();
    if (next) {
      // Transfer ownership without opening a window for a newer mutation to
      // overtake the oldest waiter.
      next();
      return;
    }
    current.active = false;
    gmailMutationLocks.delete(connectionId);
  };
}

function waitForGmailRetry(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function shouldRetryGmailCall(result: GmailCallResult): boolean {
  return (
    result.status === 0 ||
    result.status === 408 ||
    result.status === 425 ||
    result.status === 429 ||
    result.status >= 500 ||
    /rate limit|too many requests|temporar(?:y|ily)|try again/i.test(
      result.error || "",
    )
  );
}

function isGmailRateLimitResult(result: GmailCallResult): boolean {
  return (
    result.status === 429 ||
    /rate limit|quota|too many requests/i.test(result.error || "")
  );
}

function gmailApiError(
  result: GmailCallResult,
  fallback: string,
  prefix = "",
): GmailApiError {
  const detail = stringValue(result.error) || fallback;
  const retryable = shouldRetryGmailCall(result);
  return new GmailApiError(`${prefix}${detail}`, {
    status: result.status,
    retryable,
    retryAfterMs:
      result.retryAfterMs ||
      (isGmailRateLimitResult(result)
        ? GMAIL_RETRY_DELAYS_MS[GMAIL_RETRY_DELAYS_MS.length - 1]
        : 0),
    needsReauth: result.needsReauth,
  });
}

function retryAfterMs(headers: Headers): number {
  const raw = headers.get("retry-after")?.trim() || "";
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(GMAIL_MAX_RETRY_AFTER_MS, seconds * 1_000);
    }
    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt)) {
      return Math.min(
        GMAIL_MAX_RETRY_AFTER_MS,
        Math.max(0, retryAt - Date.now()),
      );
    }
  }
  const reset = Number(headers.get("x-ratelimit-reset") || "");
  if (Number.isFinite(reset) && reset > 0) {
    const resetAt = reset > 10_000_000_000 ? reset : reset * 1_000;
    return Math.min(
      GMAIL_MAX_RETRY_AFTER_MS,
      Math.max(0, resetAt - Date.now()),
    );
  }
  return 0;
}

async function waitForGmailRateLimitWindow(
  apiKey: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let rateLimitedUntil = gmailRateLimitedUntilByApiKey.get(apiKey) || 0;
  while (rateLimitedUntil > Date.now()) {
    const continued = await waitForGmailRetry(
      rateLimitedUntil - Date.now(),
      signal,
    );
    if (!continued) return false;
    rateLimitedUntil = gmailRateLimitedUntilByApiKey.get(apiKey) || 0;
  }
  if (rateLimitedUntil > 0) gmailRateLimitedUntilByApiKey.delete(apiKey);
  return signal?.aborted !== true;
}

export function isMissingGmailEntityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /requested entity (?:was )?not found|draft not found|\b404\b/i.test(
      error.message,
    )
  );
}

export async function gmailApiCall(args: {
  datagranApiKey: string;
  connectionId: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  endpoint: string;
  body?: unknown;
  rawBody?: string | ArrayBuffer;
  headers?: Record<string, string>;
  acceptedStatuses?: readonly number[];
  includeResponseHeaders?: boolean;
  signal?: AbortSignal;
  priority?: "interactive";
}): Promise<GmailCallResult> {
  if (!args.datagranApiKey || !args.connectionId) {
    return {
      ok: false,
      status: 0,
      error: "Datagran is not configured for this mailbox.",
    };
  }

  let url: URL;
  try {
    url = new URL(args.endpoint, DATAGRAN_ORIGIN);
  } catch {
    return { ok: false, status: 0, error: "Invalid Gmail endpoint." };
  }
  if (
    url.origin !== DATAGRAN_ORIGIN ||
    !url.pathname.startsWith("/api/proxy/gmail/")
  ) {
    return { ok: false, status: 0, error: "Blocked Gmail endpoint." };
  }
  if (!url.searchParams.has("connection_id")) {
    url.searchParams.set("connection_id", args.connectionId);
  }
  if (args.signal?.aborted) {
    return { ok: false, status: 0, error: "Gmail request cancelled." };
  }

  const cacheTtl = args.method === "GET" ? gmailGetCacheTtl(url) : 0;
  const cacheKey = `${args.connectionId}:${url.pathname}${url.search}`;
  if (cacheTtl > 0) {
    const cached = gmailGetCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    if (cached) gmailGetCache.delete(cacheKey);
  } else if (args.method !== "GET") {
    invalidateGmailGetCache(args.connectionId);
  }

  const releaseMutation =
    args.method === "GET"
      ? null
      : await acquireGmailMutationLock(
          args.connectionId,
          args.priority === "interactive",
        );
  try {
    let lastResult: GmailCallResult = {
      ok: false,
      status: 0,
      error: "Gmail request failed.",
    };
    for (
      let attempt = 0;
      attempt <= GMAIL_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      const sharedRateLimitedUntil =
        gmailRateLimitedUntilByApiKey.get(args.datagranApiKey) || 0;
      if (
        attempt === 0 &&
        sharedRateLimitedUntil > Date.now() &&
        args.priority !== "interactive"
      ) {
        return {
          ok: false,
          status: 429,
          error: "Gmail is temporarily rate limited.",
          retryAfterMs: sharedRateLimitedUntil - Date.now(),
        };
      }
      if (attempt > 0 && !isGmailRateLimitResult(lastResult)) {
        const continued = await waitForGmailRetry(
          GMAIL_RETRY_DELAYS_MS[attempt - 1],
          args.signal,
        );
        if (!continued) {
          return { ok: false, status: 0, error: "Gmail request cancelled." };
        }
      }
      if (
        !(await waitForGmailRateLimitWindow(
          args.datagranApiKey,
          args.signal,
        ))
      ) {
        return { ok: false, status: 0, error: "Gmail request cancelled." };
      }

      const release = await acquireGmailRequestSlot(
        args.priority === "interactive",
      );
      // Another request may have discovered a shared upstream throttle while
      // this first attempt was waiting in the concurrency queue. Do not let
      // every queued sibling spend another request into the same 429 window.
      const queuedRateLimitedUntil =
        gmailRateLimitedUntilByApiKey.get(args.datagranApiKey) || 0;
      if (attempt === 0 && queuedRateLimitedUntil > Date.now()) {
        release();
        if (args.priority === "interactive") {
          lastResult = {
            ok: false,
            status: 429,
            error: "Gmail is temporarily rate limited.",
            retryAfterMs: queuedRateLimitedUntil - Date.now(),
          };
          continue;
        }
        return {
          ok: false,
          status: 429,
          error: "Gmail is temporarily rate limited.",
          retryAfterMs: queuedRateLimitedUntil - Date.now(),
        };
      }
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort();
      if (args.signal?.aborted) controller.abort();
      else
        args.signal?.addEventListener("abort", abortFromCaller, { once: true });
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const requestHeaders = new Headers(args.headers);
        requestHeaders.set("x-api-key", args.datagranApiKey);
        if (!requestHeaders.has("Content-Type")) {
          requestHeaders.set(
            "Content-Type",
            args.rawBody === undefined
              ? "application/json"
              : "application/octet-stream",
          );
        }
        const requestBody =
          args.rawBody !== undefined
            ? args.rawBody
            : args.body !== undefined
              ? JSON.stringify(args.body)
              : undefined;
        const response = await fetch(url.toString(), {
          method: args.method,
          headers: requestHeaders,
          ...(requestBody !== undefined && args.method !== "GET"
            ? { body: requestBody }
            : {}),
          signal: controller.signal,
        });
        const responseText = await response.text();
        let data: unknown = responseText;
        try {
          data = responseText ? JSON.parse(responseText) : {};
        } catch {
          // Keep the text response for useful upstream errors.
        }
        const accepted =
          response.ok || args.acceptedStatuses?.includes(response.status);
        const responseHeaders = args.includeResponseHeaders
          ? Object.fromEntries(response.headers.entries())
          : undefined;
        if (!accepted) {
          const error = parseDatagranError(data);
          const retryDelay = retryAfterMs(response.headers);
          lastResult = {
            ok: false,
            status: response.status,
            error,
            needsReauth: needsReauthorization(response.status, error),
            ...(retryDelay > 0 ? { retryAfterMs: retryDelay } : {}),
            ...(responseHeaders ? { responseHeaders } : {}),
          };
        } else {
          lastResult = {
            ok: true,
            status: response.status,
            data,
            ...(responseHeaders ? { responseHeaders } : {}),
          };
        }
      } catch (error) {
        const externallyAborted = args.signal?.aborted === true;
        const message =
          error instanceof Error ? error.message : "Gmail request failed.";
        lastResult = {
          ok: false,
          status: 0,
          error:
            error instanceof Error && error.name === "AbortError"
              ? externallyAborted
                ? "Gmail request cancelled."
                : "Gmail request timed out."
              : message,
        };
      } finally {
        clearTimeout(timeout);
        args.signal?.removeEventListener("abort", abortFromCaller);
        release();
      }

      if (isGmailRateLimitResult(lastResult)) {
        const fallbackDelay =
          GMAIL_RETRY_DELAYS_MS[
            Math.min(attempt, GMAIL_RETRY_DELAYS_MS.length - 1)
          ];
        const appliedRetryDelay = Math.max(
          fallbackDelay,
          lastResult.retryAfterMs || 0,
        );
        lastResult = {
          ...lastResult,
          retryAfterMs: appliedRetryDelay,
        };
        gmailRateLimitedUntilByApiKey.set(
          args.datagranApiKey,
          Math.max(
            gmailRateLimitedUntilByApiKey.get(args.datagranApiKey) || 0,
            Date.now() + appliedRetryDelay,
          ),
        );
      }

      if (
        lastResult.ok ||
        args.signal?.aborted ||
        (args.method === "POST" &&
          url.pathname.endsWith("/drafts/send") &&
          !lastResult.ok) ||
        (isGmailRateLimitResult(lastResult) &&
          attempt >= GMAIL_MAX_RATE_LIMIT_RETRIES) ||
        !shouldRetryGmailCall(lastResult)
      ) {
        break;
      }
    }

    if (lastResult.ok && cacheTtl > 0) {
      const now = Date.now();
      gmailGetCache.set(cacheKey, {
        expiresAt: now + cacheTtl,
        result: lastResult,
      });
      pruneGmailGetCache(now);
    } else if (lastResult.ok && args.method !== "GET") {
      // A GET that began before the mutation may have repopulated the cache
      // after the eager invalidation above. Clear once more after success.
      invalidateGmailGetCache(args.connectionId);
    }
    return lastResult;
  } finally {
    releaseMutation?.();
  }
}

async function loadGmailProfile(args: {
  userId: string;
  mailbox: Pick<
    EmailMailboxConnection,
    "connectionId" | "datagranApiKey"
  >;
  priority?: "interactive";
  forceRefresh?: boolean;
}): Promise<GmailCallResult> {
  const cacheKey = `${args.userId}:${args.mailbox.connectionId}`;
  const now = Date.now();
  const cached = gmailProfileCache.get(cacheKey);
  if (!args.forceRefresh && cached && cached.expiresAt > now) {
    return cached.result;
  }
  if (cached) gmailProfileCache.delete(cacheKey);

  const existing = gmailProfileInflight.get(cacheKey);
  if (existing) return existing;
  const request = gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "GET",
    endpoint: "/api/proxy/gmail/gmail/v1/users/me/profile",
    priority: args.priority,
  });
  gmailProfileInflight.set(cacheKey, request);
  let result: GmailCallResult;
  try {
    result = await request;
  } finally {
    if (gmailProfileInflight.get(cacheKey) === request) {
      gmailProfileInflight.delete(cacheKey);
    }
  }
  // Only cache healthy connections. Reauthentication must become visible as
  // soon as the user reconnects, rather than waiting for a stale error cache.
  if (result.ok) {
    gmailProfileCache.set(cacheKey, {
      expiresAt: Date.now() + GMAIL_PROFILE_CACHE_TTL_MS,
      result,
    });
    if (gmailProfileCache.size > 500) {
      for (const [key, entry] of gmailProfileCache) {
        if (entry.expiresAt <= now) gmailProfileCache.delete(key);
      }
    }
  }
  return result;
}

export async function fetchVerifiedGmailMailboxAddress(args: {
  userId: string;
  connectionId: string;
  datagranApiKey: string;
}): Promise<string> {
  const profile = await loadGmailProfile({
    userId: args.userId,
    mailbox: {
      connectionId: args.connectionId,
      datagranApiKey: args.datagranApiKey,
    },
  });
  return profile.ok
    ? stringValue(record(profile.data)?.emailAddress).toLowerCase()
    : "";
}

export async function fetchGmailMailboxHistoryId(args: {
  userId: string;
  mailbox: Pick<
    EmailMailboxConnection,
    "connectionId" | "datagranApiKey"
  >;
}): Promise<string> {
  // A durable full scan must start from a current cursor. Reusing the ordinary
  // five-minute identity cache after Gmail reports an expired cursor can make
  // every later history request fail and force repeated full reconciliations.
  const profile = await loadGmailProfile({ ...args, forceRefresh: true });
  if (!profile.ok) {
    throw gmailApiError(profile, "Could not load Gmail history state.");
  }
  const historyId = stringValue(record(profile.data)?.historyId);
  if (!/^\d+$/.test(historyId)) {
    throw new GmailApiError("Gmail did not return a valid history state.", {
      status: 502,
      retryable: true,
    });
  }
  return historyId;
}

type ConfigRow = {
  agent_id?: unknown;
  connection_id?: unknown;
  datagran_api_key_enc?: unknown;
  agents?: { name?: unknown } | Array<{ name?: unknown }> | null;
};

function configAgentName(row: ConfigRow): string {
  const joined = Array.isArray(row.agents) ? row.agents[0] : row.agents;
  return stringValue(joined?.name);
}

async function persistVerifiedGmailMailboxAddress(args: {
  supabase: SupabaseClient;
  userId: string;
  mailbox: EmailMailboxConnection;
}): Promise<void> {
  const updateAddressOnly = () =>
    args.supabase
      .from("email_mailbox_preferences")
      .update({
        email_address: args.mailbox.address,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", args.userId)
      .eq("provider", "gmail")
      .eq("connection_id", args.mailbox.connectionId)
      .select("connection_id")
      .maybeSingle();

  try {
    // Updating only the identity column preserves a Settings write that may
    // have landed while the comparatively slow Gmail profile request was in
    // flight. It also handles a preference row created by another request.
    const updated = await updateAddressOnly();
    if (updated.error) throw new Error(updated.error.message);
    if (updated.data) return;

    const preference = {
      user_id: args.userId,
      provider: "gmail",
      connection_id: args.mailbox.connectionId,
      email_address: args.mailbox.address,
      display_name: args.mailbox.displayName,
      color: args.mailbox.color,
      is_default_sender: args.mailbox.isDefaultSender,
      included_in_unified: args.mailbox.includedInUnified,
      ai_instructions: args.mailbox.aiInstructions,
      updated_at: new Date().toISOString(),
    };
    let inserted = await args.supabase
      .from("email_mailbox_preferences")
      .insert(preference);
    if (!inserted.error) return;

    // A concurrent request may have inserted this connection after the first
    // update observed no row. Never resolve that race with an upsert carrying
    // stale display/default/AI settings; update the address alone instead.
    const raced = await updateAddressOnly();
    if (raced.error) throw new Error(raced.error.message);
    if (raced.data) return;

    // A first-time mailbox can also race a default-sender change on another
    // connection. Preserve that newer default and create this preference as a
    // non-default row; the address remains the only provider-derived field.
    if (inserted.error.code === "23505" && preference.is_default_sender) {
      inserted = await args.supabase
        .from("email_mailbox_preferences")
        .insert({ ...preference, is_default_sender: false });
      if (!inserted.error) return;

      const secondRace = await updateAddressOnly();
      if (secondRace.error) throw new Error(secondRace.error.message);
      if (secondRace.data) return;
    }
    throw new Error(inserted.error.message);
  } catch (error) {
    console.warn(
      `[email] Could not persist verified Gmail mailbox address for ${args.mailbox.connectionId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function loadGmailMailboxes(args: {
  supabase: SupabaseClient;
  userId: string;
  verifyProfile?: boolean;
}): Promise<EmailMailboxConnection[]> {
  const { data: configs, error } = await args.supabase
    .from("datagran_agent_configs")
    .select(
      "agent_id,connection_id,datagran_api_key_enc,agents!datagran_agent_configs_agent_id_fkey(name)",
    )
    .eq("user_id", args.userId)
    .eq("provider", "gmail")
    .not("connection_id", "is", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const uniqueConfigs = Array.from(
    new Map(
      (configs || [])
        .map((row) => [
          stringValue((row as ConfigRow).connection_id),
          row as ConfigRow,
        ] as const)
        .filter(([connectionId]) => Boolean(connectionId)),
    ).values(),
  );
  const connectionIds = uniqueConfigs
    .map((row) => stringValue((row as ConfigRow).connection_id))
    .filter(Boolean);
  const { data: preferences } =
    connectionIds.length > 0
      ? await args.supabase
          .from("email_mailbox_preferences")
          .select(
            "connection_id,email_address,display_name,color,is_default_sender,included_in_unified,ai_instructions",
          )
          .eq("user_id", args.userId)
          .eq("provider", "gmail")
          .in("connection_id", connectionIds)
      : { data: [] };
  const preferenceByConnection = new Map(
    (preferences || []).map((row) => [
      stringValue(row.connection_id),
      row as RecordLike,
    ]),
  );

  const fallbackKey = process.env.DATAGRAN_API_KEY?.trim() || "";
  const provisional = uniqueConfigs
    .map((raw, index) => {
      const row = raw as ConfigRow;
      const connectionId = stringValue(row.connection_id);
      if (!connectionId) return null;
      let datagranApiKey = fallbackKey;
      const encrypted = stringValue(row.datagran_api_key_enc);
      if (encrypted) {
        try {
          datagranApiKey = decryptLlmApiKey(encrypted);
        } catch {
          // Use the deployment fallback when an old per-connection key is bad.
        }
      }
      const preference = preferenceByConnection.get(connectionId);
      const agentName = configAgentName(row);
      return {
        connectionId,
        provider: "gmail" as const,
        address: stringValue(preference?.email_address),
        displayName:
          stringValue(preference?.display_name) ||
          agentName ||
          `Mailbox ${index + 1}`,
        color:
          stringValue(preference?.color) ||
          defaultMailboxColor(connectionId, index),
        monogram: "",
        isDefaultSender: preference?.is_default_sender === true,
        includedInUnified: preference?.included_in_unified !== false,
        aiInstructions: stringValue(preference?.ai_instructions),
        status: "connected" as const,
        counts: { inbox: 0, focus: 0, drafts: 0, noise: 0 },
        datagranApiKey,
      } satisfies EmailMailboxConnection;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const mailboxes =
    args.verifyProfile === false
      ? provisional.map((mailbox) => ({
          ...mailbox,
          monogram: mailboxMonogram(mailbox.displayName, mailbox.address),
        }))
      : await Promise.all(
          provisional.map(async (mailbox) => {
            const profile = await loadGmailProfile({
              userId: args.userId,
              mailbox,
            });
            const profileData = record(profile.data);
            const address =
              stringValue(profileData?.emailAddress) || mailbox.address;
            const displayName =
              mailbox.displayName.startsWith("Mailbox ") && address
                ? address.split("@")[0]
                : mailbox.displayName;
            return {
              ...mailbox,
              address,
              displayName,
              monogram: mailboxMonogram(displayName, address),
              status: profile.ok
                ? ("connected" as const)
                : profile.needsReauth
                  ? ("reauth_required" as const)
                  : ("error" as const),
              ...(!profile.ok && profile.error
                ? { statusMessage: profile.error }
                : {}),
            };
          }),
        );

  if (mailboxes.length > 0 && !mailboxes.some((item) => item.isDefaultSender)) {
    mailboxes[0] = { ...mailboxes[0], isDefaultSender: true };
  }
  if (args.verifyProfile !== false) {
    const changedAddresses = mailboxes.filter(
      (mailbox) =>
        mailbox.status === "connected" &&
        Boolean(mailbox.address) &&
        stringValue(
          preferenceByConnection.get(mailbox.connectionId)?.email_address,
        ) !== mailbox.address,
    );
    if (changedAddresses.length > 0) {
      await Promise.all(
        changedAddresses.map((mailbox) =>
          persistVerifiedGmailMailboxAddress({
            supabase: args.supabase,
            userId: args.userId,
            mailbox,
          }),
        ),
      );
    }
  }
  return mailboxes;
}

export async function hydrateGmailMailboxProfile(args: {
  userId: string;
  mailbox: EmailMailboxConnection;
  priority?: "interactive";
}): Promise<EmailMailboxConnection> {
  const profile = await loadGmailProfile(args);
  const profileData = record(profile.data);
  const address =
    stringValue(profileData?.emailAddress) || args.mailbox.address;
  const displayName =
    args.mailbox.displayName.startsWith("Mailbox ") && address
      ? address.split("@")[0]
      : args.mailbox.displayName;
  return {
    ...args.mailbox,
    address,
    displayName,
    monogram: mailboxMonogram(displayName, address),
    status: profile.ok
      ? ("connected" as const)
      : profile.needsReauth
        ? ("reauth_required" as const)
        : ("error" as const),
    ...(!profile.ok && profile.error
      ? { statusMessage: profile.error }
      : {}),
  };
}

export async function findOwnedGmailMailbox(args: {
  supabase: SupabaseClient;
  userId: string;
  connectionId: string;
}): Promise<EmailMailboxConnection | null> {
  const mailboxes = await loadGmailMailboxes({
    supabase: args.supabase,
    userId: args.userId,
    verifyProfile: false,
  });
  return (
    mailboxes.find(
      (mailbox) => mailbox.connectionId === args.connectionId,
    ) || null
  );
}

function headerValue(payload: RecordLike | null, name: string): string {
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const match = headers.find((header) => {
    const item = record(header);
    return stringValue(item?.name).toLowerCase() === name.toLowerCase();
  });
  return stringValue(record(match)?.value);
}

export function parseEmailAddresses(value: unknown): string[] {
  const text = Array.isArray(value) ? value.join(",") : stringValue(value);
  const matches =
    text.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ||
    [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const email = raw.toLowerCase();
    if (!seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

export function parseSender(value: string): {
  name: string;
  email: string;
} {
  const email = parseEmailAddresses(value)[0] || "";
  const name = value
    .replace(email, "")
    .replace(/[<>"']/g, "")
    .trim();
  return { name: name || email.split("@")[0] || "Unknown", email };
}

function decodeBase64Url(input: string): string {
  return decodeBase64UrlBuffer(input).toString("utf8");
}

function decodeBase64UrlBuffer(input: string): Buffer {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  try {
    return Buffer.from(base64 + padding, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function encodeBase64Url(input: string): string {
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
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractPayloadContent(
  payload: RecordLike | null,
  messageContext?: {
    connectionId: string;
    messageId: string;
    threadId: string;
  },
): {
  body: string;
  htmlBody: string | null;
  attachments: EmailMessage["attachments"];
} {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: EmailMessage["attachments"] = [];

  const visit = (part: RecordLike | null) => {
    if (!part) return;
    const mimeType = stringValue(part.mimeType).toLowerCase();
    const filename = stringValue(part.filename);
    const body = record(part.body);
    const data = stringValue(body?.data);
    const attachmentId = stringValue(body?.attachmentId);
    const size = Number(body?.size || 0);
    const contentId = normalizeEmailContentId(
      headerValue(part, "Content-ID"),
    );

    if (data) {
      const decoded = decodeBase64Url(data);
      if (mimeType === "text/plain") plain.push(decoded);
      else if (mimeType === "text/html") html.push(decoded);
    }
    if (filename || attachmentId || contentId) {
      const partId = stringValue(part.partId);
      attachments.push({
        id: attachmentId || partId,
        partId: partId || undefined,
        filename: filename || "Attachment",
        mimeType: mimeType || "application/octet-stream",
        size: Number.isFinite(size) ? size : 0,
        contentId: contentId || undefined,
        inline: false,
      });
    }
    const children = Array.isArray(part.parts) ? part.parts : [];
    for (const child of children) visit(record(child));
  };
  visit(payload);

  const combinedHtml = html.join("\n\n").trim();
  const referencedContentIds = new Set<string>();
  for (const imageMatch of combinedHtml.matchAll(/<img\b[^>]*>/gi)) {
    const sourceMatch = imageMatch[0].match(
      /\bsrc\s*=\s*(?:"\s*cid:([^"]+)"|'\s*cid:([^']+)'|cid:([^\s>]+))/i,
    );
    const rawContentId = sourceMatch?.[1] || sourceMatch?.[2] || sourceMatch?.[3];
    if (!rawContentId) continue;
    const contentId = normalizeEmailContentId(
      rawContentId
        .replace(/^&lt;/i, "<")
        .replace(/&gt;$/i, ">"),
    );
    if (contentId) referencedContentIds.add(contentId);
  }
  const resolvedAttachments = attachments.map((attachment) => ({
    ...attachment,
    inline: Boolean(
      attachment.contentId &&
        canRenderEmailAttachmentAsInlineImage(attachment.mimeType) &&
        referencedContentIds.has(attachment.contentId),
    ),
  }));
  const cidImageSources = messageContext
    ? new Map(
        resolvedAttachments.flatMap((attachment) =>
          attachment.inline && attachment.contentId && attachment.id
            ? [
                [
                  attachment.contentId,
                  emailAttachmentUrl({
                    connectionId: messageContext.connectionId,
                    messageId: messageContext.messageId,
                    attachmentId:
                      attachment.id === attachment.partId
                        ? undefined
                        : attachment.id,
                    threadId: messageContext.threadId,
                    partId: attachment.partId,
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                  }),
                ] as const,
              ]
            : [],
        ),
      )
    : undefined;
  return {
    body: plain.join("\n\n").trim() || stripHtml(combinedHtml) || "",
    htmlBody: combinedHtml
      ? sanitizeEmailHtml(combinedHtml, {
          cidImageSources,
          preserveDocumentStyles: true,
        })
      : null,
    attachments: resolvedAttachments,
  };
}

function messageReceivedAt(data: RecordLike, dateHeader: string): string {
  const internalDate = Number(stringValue(data.internalDate));
  if (Number.isFinite(internalDate) && internalDate > 0) {
    return new Date(internalDate).toISOString();
  }
  const parsed = Date.parse(dateHeader);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function payloadHasCalendarInvitation(
  payload: RecordLike | null,
): boolean {
  const methods: string[] = [];
  const visit = (part: RecordLike | null) => {
    if (!part) return;
    const mimeType = stringValue(part.mimeType).toLowerCase();
    if (mimeType === "text/calendar" || mimeType === "application/ics") {
      const body = record(part.body);
      const encodedData = stringValue(body?.data);
      methods.push(
        calendarMessageMethod({
          contentType: headerValue(part, "Content-Type"),
          ics: encodedData ? decodeBase64Url(encodedData) : "",
        }),
      );
    }
    const children = Array.isArray(part.parts) ? part.parts : [];
    for (const child of children) visit(record(child));
  };
  visit(payload);
  return calendarPartsContainInvitation(methods);
}

function gmailThreadListItem(
  data: RecordLike,
  fallback?: { id?: string; threadId?: string },
): GmailThreadListItem {
  const payload = record(data.payload);
  const content = extractPayloadContent(payload);
  const date = headerValue(payload, "Date");
  return {
    id: stringValue(data.id) || fallback?.id || "",
    threadId: stringValue(data.threadId) || fallback?.threadId || "",
    from: headerValue(payload, "From"),
    to: headerValue(payload, "To"),
    cc: headerValue(payload, "Cc"),
    subject: headerValue(payload, "Subject") || "(no subject)",
    date,
    internalDate: messageReceivedAt(data, date),
    messageIdHeader: headerValue(payload, "Message-ID"),
    references: headerValue(payload, "References"),
    listUnsubscribe: headerValue(payload, "List-Unsubscribe"),
    authenticationResults: headerValue(payload, "Authentication-Results"),
    autoSubmitted: headerValue(payload, "Auto-Submitted"),
    precedence: headerValue(payload, "Precedence"),
    listId: headerValue(payload, "List-ID"),
    snippet: stringValue(data.snippet),
    labelIds: stringArray(data.labelIds),
    hasAttachments: content.attachments.length > 0,
    hasCalendarInvitation: payloadHasCalendarInvitation(payload),
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, limit)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        out[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export async function listGmailMessageRefs(args: {
  mailbox: EmailMailboxConnection;
  query?: string;
  maxResults?: number;
  pageToken?: string | null;
  signal?: AbortSignal;
  priority?: "interactive";
}): Promise<GmailMessageRefListResult> {
  const query = stringValue(args.query) || "in:inbox -from:me";
  const maxResults = Math.min(100, Math.max(1, args.maxResults || 24));
  const search = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
  });
  if (args.pageToken) search.set("pageToken", args.pageToken);
  if (/\bin:(spam|trash|anywhere)\b/i.test(query)) {
    search.set("includeSpamTrash", "true");
  }
  const list = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "GET",
    endpoint: `/api/proxy/gmail/gmail/v1/users/me/messages?${search.toString()}`,
    signal: args.signal,
    priority: args.priority,
  });
  if (!list.ok) {
    throw gmailApiError(list, "Could not load Gmail messages.");
  }
  const root = record(list.data);
  const items = (Array.isArray(root?.messages) ? root.messages : [])
    .map((item) => record(item))
    .filter((item): item is RecordLike => Boolean(item))
    .map((item) => ({
      id: stringValue(item.id),
      threadId: stringValue(item.threadId),
    }))
    .filter((item) => item.id);
  return {
    items,
    nextPageToken: stringValue(root?.nextPageToken) || null,
    resultSizeEstimate: Number(root?.resultSizeEstimate || items.length),
  };
}

function gmailHistoryMessageRef(value: unknown): GmailMessageRef | null {
  const wrapper = record(value);
  const message = record(wrapper?.message) || wrapper;
  const id = stringValue(message?.id);
  if (!id) return null;
  return { id, threadId: stringValue(message?.threadId) };
}

export async function listGmailHistoryMessageRefs(args: {
  mailbox: EmailMailboxConnection;
  startHistoryId: string;
  maxResults?: number;
  pageToken?: string | null;
  signal?: AbortSignal;
}): Promise<GmailHistoryMessageRefListResult> {
  const startHistoryId = stringValue(args.startHistoryId);
  if (!/^\d+$/.test(startHistoryId)) {
    throw new GmailApiError("A valid Gmail history ID is required.", {
      status: 400,
      retryable: false,
    });
  }
  const search = new URLSearchParams({
    startHistoryId,
    maxResults: String(Math.min(500, Math.max(1, args.maxResults || 100))),
  });
  if (args.pageToken) search.set("pageToken", args.pageToken);
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "GET",
    endpoint: `/api/proxy/gmail/gmail/v1/users/me/history?${search.toString()}`,
    signal: args.signal,
  });
  if (!response.ok) {
    throw gmailApiError(response, "Could not load Gmail history.");
  }
  const root = record(response.data);
  const histories = Array.isArray(root?.history) ? root.history : [];
  const added = new Map<string, GmailMessageRef>();
  const changed = new Map<string, GmailMessageRef>();
  for (const rawHistory of histories) {
    const history = record(rawHistory);
    const add = (target: Map<string, GmailMessageRef>, raw: unknown) => {
      const ref = gmailHistoryMessageRef(raw);
      if (ref) target.set(ref.id, ref);
    };
    for (const item of Array.isArray(history?.messagesAdded)
      ? history.messagesAdded
      : []) {
      add(added, item);
      add(changed, item);
    }
    for (const key of ["messagesDeleted", "labelsAdded", "labelsRemoved"] as const) {
      for (const item of Array.isArray(history?.[key]) ? history[key] : []) {
        add(changed, item);
      }
    }
    for (const item of Array.isArray(history?.messages)
      ? history.messages
      : []) {
      add(changed, item);
    }
  }
  return {
    added: Array.from(added.values()),
    changed: Array.from(changed.values()),
    historyId: stringValue(root?.historyId) || startHistoryId,
    nextPageToken: stringValue(root?.nextPageToken) || null,
  };
}

export async function fetchGmailMessageListItem(args: {
  mailbox: EmailMailboxConnection;
  messageId: string;
  threadId?: string;
  signal?: AbortSignal;
  throwOnTransientError?: boolean;
  priority?: "interactive";
}): Promise<GmailThreadListItem | null> {
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "GET",
    endpoint:
      `/api/proxy/gmail/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}` +
      `?format=full&fields=${encodeURIComponent(GMAIL_LIST_MESSAGE_FIELDS)}`,
    signal: args.signal,
    priority: args.priority,
  });
  if (!response.ok) {
    if (
      args.throwOnTransientError &&
      (response.status === 0 || response.status === 429 || response.status >= 500)
    ) {
      throw gmailApiError(response, "Could not load Gmail message.");
    }
    return null;
  }
  const data = record(response.data);
  return gmailThreadListItem(data || {}, {
    id: args.messageId,
    threadId: args.threadId,
  });
}

export async function listGmailThreads(args: {
  mailbox: EmailMailboxConnection;
  query?: string;
  maxResults?: number;
  pageToken?: string | null;
  signal?: AbortSignal;
  latestInThread?: boolean;
  detailConcurrency?: number;
  priority?: "interactive";
}): Promise<GmailThreadListResult> {
  const listed = await listGmailMessageRefs(args);
  const listedRefs = listed.items;
  const refs = args.latestInThread
    ? Array.from(
        listedRefs
          .reduce((byThread, ref) => {
            const identity = ref.threadId || ref.id;
            // Gmail returns newest matches first. Preserve the first matching
            // message so matchedItem points at the newest hit in a thread.
            if (!byThread.has(identity)) byThread.set(identity, ref);
            return byThread;
          }, new Map<string, (typeof listedRefs)[number]>())
          .values(),
      )
    : listedRefs;

  const details = await mapLimit(
    refs,
    Math.min(12, Math.max(1, args.detailConcurrency || 3)),
    async (ref) => {
      if (args.latestInThread && ref.threadId) {
        try {
          const threadItems = await fetchGmailThreadItems({
            mailbox: args.mailbox,
            threadId: ref.threadId,
            signal: args.signal,
            priority: args.priority,
          });
          const latest = latestGmailThreadItem(threadItems);
          if (latest) {
            return {
              ...latest,
              threadHasSentMessage: threadItems.some((item) =>
                item.labelIds.includes("SENT"),
              ),
              labelIds: threadItems.some((item) =>
                item.labelIds.includes("UNREAD"),
              )
                ? Array.from(new Set([...latest.labelIds, "UNREAD"]))
                : latest.labelIds.filter((labelId) => labelId !== "UNREAD"),
              hasAttachments: threadItems.some((item) => item.hasAttachments),
              matchedItem:
                threadItems.find((item) => item.id === ref.id) || undefined,
            };
          }
        } catch {
          // Fall back to the exact matching message so one unavailable
          // conversation does not make the entire mailbox page disappear.
        }
      }
      return fetchGmailMessageListItem({
        mailbox: args.mailbox,
        messageId: ref.id,
        threadId: ref.threadId,
        signal: args.signal,
        priority: args.priority,
      });
    },
  );

  return {
    items: details.filter(
      (item): item is GmailThreadListItem => item !== null,
    ),
    nextPageToken: listed.nextPageToken,
    resultSizeEstimate: listed.resultSizeEstimate,
  };
}

export async function fetchGmailThreadItems(args: {
  mailbox: EmailMailboxConnection;
  threadId: string;
  signal?: AbortSignal;
  priority?: "interactive";
}): Promise<GmailThreadListItem[]> {
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "GET",
    endpoint:
      `/api/proxy/gmail/gmail/v1/users/me/threads/${encodeURIComponent(args.threadId)}` +
      `?format=full&fields=${encodeURIComponent(GMAIL_THREAD_MESSAGE_FIELDS)}`,
    signal: args.signal,
    priority: args.priority,
  });
  if (!response.ok) {
    throw gmailApiError(response, "Could not load Gmail conversation.");
  }
  const root = record(response.data);
  return collapseDuplicateGmailThreadItems(
    (Array.isArray(root?.messages) ? root.messages : [])
      .map((raw) => record(raw))
      .filter((raw): raw is RecordLike => Boolean(raw))
      .map((raw) => gmailThreadListItem(raw, { threadId: args.threadId }))
      .filter(
        (item) =>
          item.id &&
          !isGmailDraftMessage(item.labelIds) &&
          !isGmailTrashMessage(item.labelIds),
      ),
  ).sort(
      (a, b) =>
        Date.parse(a.internalDate || a.date) -
        Date.parse(b.internalDate || b.date),
  );
}

export function latestGmailThreadItem(
  items: readonly GmailThreadListItem[],
): GmailThreadListItem | null {
  let latest: GmailThreadListItem | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (!item.id || isGmailDraftMessage(item.labelIds)) continue;
    const timestamp = Date.parse(item.internalDate || item.date);
    const comparable = Number.isFinite(timestamp) ? timestamp : 0;
    if (!latest || comparable >= latestAt) {
      latest = item;
      latestAt = comparable;
    }
  }
  return latest;
}

/**
 * Resolve the message used to summarize an opened conversation.
 *
 * All Mail is hydrated from Gmail message pages before the full conversation
 * is opened. Between those reads Gmail can remove that exact record, and
 * Groovy can also collapse a duplicate SMTP delivery with the same RFC
 * Message-ID. The conversation is still valid in both cases, so fall back to
 * its latest surviving message instead of rejecting the whole thread.
 */
export function resolveGmailThreadSummaryAnchor(args: {
  items: readonly GmailThreadListItem[];
  latest: GmailThreadListItem;
  requestedMessageId?: string | null;
}): GmailThreadListItem | null {
  const fallback =
    (args.latest.id ? args.latest : null) || args.items.at(-1) || null;
  const requestedMessageId = args.requestedMessageId?.trim() || "";
  if (!requestedMessageId) return fallback;
  return (
    args.items.find((item) => item.id === requestedMessageId) || fallback
  );
}

export function gmailItemDirection(
  item: GmailThreadListItem,
  ownedAddresses: readonly string[],
): "incoming" | "outgoing" {
  const owned = new Set(
    ownedAddresses.map((address) => address.trim().toLowerCase()).filter(Boolean),
  );
  const sender = parseSender(item.from).email.toLowerCase();
  return item.labelIds.includes("SENT") || (sender && owned.has(sender))
    ? "outgoing"
    : "incoming";
}

export function buildReplyRecipients(
  args: {
    from: string;
    to: string;
    cc: string;
    userAddress: string;
    ownedAddresses?: string[];
  },
  replyAll = false,
): { to: string[]; cc: string[] } {
  const sender = parseSender(args.from).email.toLowerCase();
  const owned = new Set(
    [args.userAddress, ...(args.ownedAddresses || [])]
      .map((address) => address.toLowerCase())
      .filter(Boolean),
  );
  const to: string[] = [];
  const cc: string[] = [];
  const seen = new Set<string>();
  const add = (target: string[], email: string) => {
    const normalized = email.toLowerCase();
    if (!normalized || owned.has(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    target.push(normalized);
  };
  const originalTo = parseEmailAddresses(args.to);
  const originalCc = parseEmailAddresses(args.cc);

  if (owned.has(sender)) {
    for (const email of originalTo) add(to, email);
    if (replyAll) {
      for (const email of originalCc) add(cc, email);
    }
  } else {
    if (sender) add(to, sender);
    if (replyAll) {
      for (const email of originalTo) add(cc, email);
      for (const email of originalCc) add(cc, email);
    }
  }
  return { to, cc };
}

export function buildReplyAllRecipients(args: {
  from: string;
  to: string;
  cc: string;
  userAddress: string;
  ownedAddresses?: string[];
}): { to: string[]; cc: string[] } {
  return buildReplyRecipients(args, true);
}

export async function fetchGmailThread(args: {
  mailbox: EmailMailboxConnection;
  threadId: string;
  ownedAddresses?: string[];
  priority?: "interactive";
}): Promise<{
  messages: EmailMessage[];
  items: GmailThreadListItem[];
  latest: GmailThreadListItem;
  replyAll: {
    to: string[];
    cc: string[];
    subject: string;
    inReplyTo: string | null;
    references: string | null;
  };
}> {
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "GET",
    priority: args.priority,
    endpoint: `/api/proxy/gmail/gmail/v1/users/me/threads/${encodeURIComponent(args.threadId)}?format=full`,
  });
  if (!response.ok) {
    throw new Error(response.error || "Could not load Gmail thread.");
  }
  const root = record(response.data);
  const rawMessages = Array.isArray(root?.messages) ? root.messages : [];
  const messages: EmailMessage[] = [];
  const listItems: GmailThreadListItem[] = [];
  const seenMessageIds = new Set<string>();
  const ownedAddresses = Array.from(
    new Set(
      [args.mailbox.address, ...(args.ownedAddresses || [])]
        .map((address) => address.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const ownedAddressSet = new Set(ownedAddresses);
  for (const raw of rawMessages) {
    const data = record(raw);
    if (!data) continue;
    const payload = record(data.payload);
    const messageId = stringValue(data.id);
    const threadId = stringValue(data.threadId) || args.threadId;
    const content = extractPayloadContent(payload, {
      connectionId: args.mailbox.connectionId,
      messageId,
      threadId,
    });
    const from = headerValue(payload, "From");
    const date = headerValue(payload, "Date");
    const item: GmailThreadListItem = {
      id: messageId,
      threadId,
      from,
      to: headerValue(payload, "To"),
      cc: headerValue(payload, "Cc"),
      subject: headerValue(payload, "Subject") || "(no subject)",
      date,
      internalDate: messageReceivedAt(data, date),
      messageIdHeader: headerValue(payload, "Message-ID"),
      references: headerValue(payload, "References"),
      snippet: stringValue(data.snippet),
      labelIds: stringArray(data.labelIds),
      hasAttachments: content.attachments.some(
        (attachment) => !attachment.inline,
      ),
      hasCalendarInvitation: payloadHasCalendarInvitation(payload),
    };
    // Gmail includes saved drafts in threads.get responses. Drafts belong in
    // the composer, not in conversation history where they look already sent.
    if (
      isGmailDraftMessage(item.labelIds) ||
      isGmailTrashMessage(item.labelIds)
    ) {
      continue;
    }
    const messageIdKey = gmailMessageIdKey(item.messageIdHeader);
    if (messageIdKey && seenMessageIds.has(messageIdKey)) continue;
    if (messageIdKey) seenMessageIds.add(messageIdKey);
    listItems.push(item);
    const isFromUser = ownedAddressSet.has(
      parseSender(from).email.toLowerCase(),
    );
    const reply = buildReplyRecipients(
      {
        from: item.from,
        to: item.to,
        cc: item.cc,
        userAddress: args.mailbox.address,
        ownedAddresses,
      },
      false,
    );
    const replyAll = buildReplyRecipients(
      {
        from: item.from,
        to: item.to,
        cc: item.cc,
        userAddress: args.mailbox.address,
        ownedAddresses,
      },
      true,
    );
    const replySubject = /^re:/i.test(item.subject)
      ? item.subject
      : `Re: ${item.subject}`;
    const references =
      [item.references, item.messageIdHeader]
        .filter(Boolean)
        .join(" ")
        .trim() || null;
    messages.push({
      id: item.id,
      threadId: item.threadId,
      from,
      to: parseEmailAddresses(item.to),
      cc: parseEmailAddresses(item.cc),
      bcc: parseEmailAddresses(headerValue(payload, "Bcc")),
      subject: item.subject,
      sentAt: item.internalDate,
      body: content.body || item.snippet,
      htmlBody: content.htmlBody,
      snippet: item.snippet,
      isFromUser,
      reply: {
        ...reply,
        subject: replySubject,
        inReplyTo: item.messageIdHeader || null,
        references,
      },
      replyAll: {
        ...replyAll,
        subject: replySubject,
        inReplyTo: item.messageIdHeader || null,
        references,
      },
      attachments: content.attachments,
    });
  }
  listItems.sort(
    (a, b) =>
      Date.parse(a.internalDate || a.date) -
      Date.parse(b.internalDate || b.date),
  );
  messages.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const latest =
    listItems[listItems.length - 1] ||
    ({
      id: "",
      threadId: args.threadId,
      from: "",
      to: "",
      cc: "",
      subject: "(no subject)",
      date: "",
      internalDate: "",
      messageIdHeader: "",
      references: "",
      snippet: "",
      labelIds: [],
      hasAttachments: false,
      hasCalendarInvitation: false,
    } satisfies GmailThreadListItem);
  const recipients = buildReplyAllRecipients({
    from: latest.from,
    to: latest.to,
    cc: latest.cc,
    userAddress: args.mailbox.address,
    ownedAddresses: args.ownedAddresses,
  });
  const subject = /^re:/i.test(latest.subject)
    ? latest.subject
    : `Re: ${latest.subject}`;
  return {
    messages,
    items: listItems,
    latest,
    replyAll: {
      ...recipients,
      subject,
      inReplyTo: latest.messageIdHeader || null,
      references:
        [latest.references, latest.messageIdHeader]
          .filter(Boolean)
          .join(" ")
          .trim() || null,
    },
  };
}

export async function fetchGmailAttachment(args: {
  mailbox: EmailMailboxConnection;
  messageId: string;
  attachmentId?: string;
  threadId?: string;
  partId?: string;
  filename?: string;
  mimeType?: string;
  priority?: "interactive";
}): Promise<{
  data: Buffer;
  filename: string;
  mimeType: string;
}> {
  if (args.attachmentId) {
    const directResponse = await gmailApiCall({
      datagranApiKey: args.mailbox.datagranApiKey,
      connectionId: args.mailbox.connectionId,
      method: "GET",
      priority: args.priority,
      endpoint:
        `/api/proxy/gmail/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}` +
        `/attachments/${encodeURIComponent(args.attachmentId)}`,
    });
    if (directResponse.ok) {
      const encodedData = stringValue(record(directResponse.data)?.data);
      const data = decodeBase64UrlBuffer(encodedData);
      if (data.length === 0) throw new Error("Gmail attachment is empty.");
      return {
        data,
        filename: args.filename || "attachment",
        mimeType: args.mimeType || "application/octet-stream",
      };
    }
    if (directResponse.status !== 404) {
      throw gmailApiError(
        directResponse,
        "Could not download Gmail attachment.",
      );
    }
  }

  const messageResponse = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "GET",
    priority: args.priority,
    endpoint: `/api/proxy/gmail/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}?format=full`,
  });
  if (
    !messageResponse.ok &&
    !(messageResponse.status === 404 && args.threadId)
  ) {
    throw gmailApiError(messageResponse, "Could not load Gmail message.");
  }
  const partsFor = (message: RecordLike | null) => {
    const parts: RecordLike[] = [];
    const visit = (part: RecordLike | null) => {
      if (!part) return;
      if (
        stringValue(part.filename) ||
        stringValue(record(part.body)?.attachmentId) ||
        headerValue(part, "Content-ID")
      ) {
        parts.push(part);
      }
      const children = Array.isArray(part.parts) ? part.parts : [];
      for (const child of children) visit(record(child));
    };
    visit(record(message?.payload));
    return parts;
  };

  const matchPart = (parts: readonly RecordLike[]) => {
    const byAttachmentId = args.attachmentId
      ? parts.find(
          (part) =>
            stringValue(record(part.body)?.attachmentId) === args.attachmentId,
        )
      : null;
    if (byAttachmentId) return byAttachmentId;
    const desiredPartId = args.partId || args.attachmentId;
    const byPartId = desiredPartId
      ? parts.find(
          (part) => stringValue(part.partId) === desiredPartId,
        )
      : null;
    if (byPartId) return byPartId;
    if (!args.filename) return null;
    const normalizedFilename = args.filename.trim().toLocaleLowerCase();
    const normalizedMimeType = args.mimeType?.trim().toLocaleLowerCase();
    const compatible = parts.filter(
      (part) =>
        stringValue(part.filename).trim().toLocaleLowerCase() ===
          normalizedFilename &&
        (!normalizedMimeType ||
          stringValue(part.mimeType).trim().toLocaleLowerCase() ===
            normalizedMimeType),
    );
    return compatible.length === 1 ? compatible[0] : null;
  };

  let resolvedMessageId = args.messageId;
  let matchedPart = matchPart(partsFor(record(messageResponse.data)));
  if (!matchedPart && args.threadId) {
    const threadResponse = await gmailApiCall({
      datagranApiKey: args.mailbox.datagranApiKey,
      connectionId: args.mailbox.connectionId,
      method: "GET",
      priority: args.priority,
      endpoint: `/api/proxy/gmail/gmail/v1/users/me/threads/${encodeURIComponent(args.threadId)}?format=full`,
    });
    if (!threadResponse.ok) {
      throw gmailApiError(
        threadResponse,
        "Could not resolve this Gmail attachment.",
      );
    }
    const candidates: Array<{
      messageId: string;
      part: RecordLike;
    }> = [];
    const messages = Array.isArray(record(threadResponse.data)?.messages)
      ? (record(threadResponse.data)?.messages as unknown[])
      : [];
    for (const item of messages) {
      const message = record(item);
      const part = matchPart(partsFor(message));
      if (part) {
        candidates.push({
          messageId: stringValue(message?.id),
          part,
        });
      }
    }
    if (candidates.length === 1 && candidates[0].messageId) {
      resolvedMessageId = candidates[0].messageId;
      matchedPart = candidates[0].part;
    }
  }
  if (!matchedPart) throw new Error("Gmail attachment not found.");

  const part = matchedPart as RecordLike;
  const partBody = record(part.body);
  const remoteAttachmentId = stringValue(partBody?.attachmentId);
  let encodedData = stringValue(partBody?.data);
  if (remoteAttachmentId) {
    const attachmentResponse = await gmailApiCall({
      datagranApiKey: args.mailbox.datagranApiKey,
      connectionId: args.mailbox.connectionId,
      method: "GET",
      priority: args.priority,
      endpoint:
        `/api/proxy/gmail/gmail/v1/users/me/messages/${encodeURIComponent(resolvedMessageId)}` +
        `/attachments/${encodeURIComponent(remoteAttachmentId)}`,
    });
    if (!attachmentResponse.ok) {
      throw gmailApiError(
        attachmentResponse,
        "Could not download Gmail attachment.",
      );
    }
    encodedData = stringValue(record(attachmentResponse.data)?.data);
  }
  if (!encodedData) throw new Error("Gmail attachment is empty.");
  const data = decodeBase64UrlBuffer(encodedData);
  if (data.length === 0) throw new Error("Gmail attachment is empty.");
  return {
    data,
    filename: stringValue(part.filename) || "attachment",
    mimeType: stringValue(part.mimeType) || "application/octet-stream",
  };
}

export async function fetchGmailCalendarInvitation(args: {
  mailbox: EmailMailboxConnection;
  messageId: string;
  threadId?: string | null;
}): Promise<ParsedCalendarInvitation> {
  const messageResponse = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "GET",
    endpoint: `/api/proxy/gmail/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}?format=full`,
  });
  if (!messageResponse.ok) {
    throw new Error(
      messageResponse.error || "Could not load the calendar invitation.",
    );
  }
  const findCalendarPart = (
    part: RecordLike | null,
  ): RecordLike | null => {
    if (!part) return null;
    const mimeType = stringValue(part.mimeType).toLowerCase();
    if (mimeType === "text/calendar" || mimeType === "application/ics") {
      return part;
    }
    const children = Array.isArray(part.parts) ? part.parts : [];
    for (const child of children) {
      const match = findCalendarPart(record(child));
      if (match) return match;
    }
    return null;
  };
  const calendarPart = findCalendarPart(
    record(record(messageResponse.data)?.payload),
  );
  if (!calendarPart) {
    throw new GmailCalendarInvitationPayloadError(
      "missing_calendar_part",
      "This email is a forwarded calendar update, not an invitation you can answer.",
    );
  }

  const declaredMethod = calendarMessageMethod({
    contentType: headerValue(calendarPart, "Content-Type"),
  });
  if (declaredMethod && declaredMethod !== "REQUEST") {
    throw new GmailCalendarInvitationPayloadError(
      "non_actionable_calendar_method",
      "This calendar message is an update, not an invitation you can answer.",
    );
  }

  const body = record(calendarPart.body);
  const size = Number(body?.size || 0);
  if (Number.isFinite(size) && size > 512_000) {
    throw new GmailCalendarInvitationPayloadError(
      "calendar_part_too_large",
      "This calendar invitation is too large to process safely.",
    );
  }
  let data = decodeBase64UrlBuffer(stringValue(body?.data));
  const attachmentId = stringValue(body?.attachmentId);
  if (data.length === 0 && attachmentId) {
    // We already resolved the exact MIME part from this message. Fetch the
    // attachment payload directly instead of loading the message a second
    // time through fetchGmailAttachment.
    const attachmentResponse = await gmailApiCall({
      datagranApiKey: args.mailbox.datagranApiKey,
      connectionId: args.mailbox.connectionId,
      method: "GET",
      endpoint:
        `/api/proxy/gmail/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}` +
        `/attachments/${encodeURIComponent(attachmentId)}`,
    });
    if (!attachmentResponse.ok) {
      throw new Error(
        attachmentResponse.error ||
          "Could not download the calendar invitation.",
      );
    }
    data = decodeBase64UrlBuffer(
      stringValue(record(attachmentResponse.data)?.data),
    );
  }
  if (data.length === 0 || data.length > 512_000) {
    throw new GmailCalendarInvitationPayloadError(
      "calendar_data_unavailable",
      "The calendar invitation data is unavailable.",
    );
  }
  const calendarData = data.toString("utf8");
  const messageMethod = calendarMessageMethod({ ics: calendarData });
  if (messageMethod && messageMethod !== "REQUEST") {
    throw new GmailCalendarInvitationPayloadError(
      "non_actionable_calendar_method",
      "This calendar message is an update, not an invitation you can answer.",
    );
  }
  const invitation = parseIcsCalendarInvitation(calendarData);
  if (!invitation) {
    throw new GmailCalendarInvitationPayloadError(
      "invalid_calendar_data",
      "The calendar invitation could not be understood.",
    );
  }
  return invitation;
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function encodeEmailSubjectHeader(value: string): string {
  const subject = safeHeader(value);
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;

  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of subject) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (chunk && chunkBytes + characterBytes > 45) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks
    .map(
      (part) =>
        `=?UTF-8?B?${Buffer.from(part, "utf8").toString("base64")}?=`,
    )
    .join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export type OutgoingEmailAttachment = EmailDraftAttachment & {
  data: Uint8Array;
};

function publicDraftAttachment(
  attachment: OutgoingEmailAttachment,
): EmailDraftAttachment {
  return {
    id: attachment.id,
    storagePath: attachment.storagePath,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    disposition: attachment.disposition,
    contentId: attachment.contentId,
  };
}

function mimeBoundary(kind: string): string {
  return `groovy-${kind}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function base64MimeLines(data: Uint8Array): string {
  return Buffer.from(data)
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n") || "";
}

function mimeFilename(value: string): {
  fallback: string;
  encoded: string;
} {
  const fallback =
    value
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\\r\n]/g, "_")
      .slice(0, 180) || "attachment";
  return {
    fallback,
    encoded: encodeURIComponent(value).replace(
      /[!'()*]/g,
      (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    ),
  };
}

function appendAlternativeParts(args: {
  lines: string[];
  boundary: string;
  body: string;
  htmlBody: string;
}) {
  args.lines.push(`--${args.boundary}`);
  args.lines.push("Content-Type: text/plain; charset=UTF-8");
  args.lines.push("Content-Transfer-Encoding: 8bit");
  args.lines.push("");
  args.lines.push(args.body);
  args.lines.push(`--${args.boundary}`);
  args.lines.push("Content-Type: text/html; charset=UTF-8");
  args.lines.push("Content-Transfer-Encoding: 8bit");
  args.lines.push("");
  args.lines.push(args.htmlBody);
  args.lines.push(`--${args.boundary}--`);
}

function appendAttachmentPart(args: {
  lines: string[];
  boundary: string;
  attachment: OutgoingEmailAttachment;
}) {
  const filename = mimeFilename(args.attachment.filename);
  args.lines.push(`--${args.boundary}`);
  args.lines.push(
    `Content-Type: ${args.attachment.mimeType}; name="${filename.fallback}"; ` +
      `name*=UTF-8''${filename.encoded}`,
  );
  args.lines.push("Content-Transfer-Encoding: base64");
  args.lines.push(
    `Content-Disposition: ${args.attachment.disposition}; ` +
      `filename="${filename.fallback}"; filename*=UTF-8''${filename.encoded}`,
  );
  if (
    args.attachment.disposition === "inline" &&
    args.attachment.contentId
  ) {
    args.lines.push(
      `Content-ID: <${safeHeader(args.attachment.contentId)}>`,
    );
  }
  args.lines.push("");
  args.lines.push(base64MimeLines(args.attachment.data));
}

export function buildRawMessage(args: {
  from?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  includeBccHeader?: boolean;
  subject: string;
  body: string;
  bodyHtml?: string | null;
  attachments?: OutgoingEmailAttachment[];
  inReplyTo?: string | null;
  references?: string | null;
  trackingPixelUrl?: string | null;
  date?: string | null;
  messageId?: string | null;
}): string {
  const headers: string[] = [];
  if (args.from) {
    headers.push(`From: ${safeHeader(args.from)}`);
  }
  headers.push(`To: ${args.to.map(safeHeader).join(", ")}`);
  if (args.cc?.length) {
    headers.push(`Cc: ${args.cc.map(safeHeader).join(", ")}`);
  }
  if (args.bcc?.length && args.includeBccHeader !== false) {
    headers.push(`Bcc: ${args.bcc.map(safeHeader).join(", ")}`);
  }
  headers.push(`Subject: ${encodeEmailSubjectHeader(args.subject)}`);
  if (args.date) {
    headers.push(`Date: ${safeHeader(args.date)}`);
  }
  if (args.messageId) {
    headers.push(`Message-ID: ${safeHeader(args.messageId)}`);
  }
  if (args.inReplyTo) {
    headers.push(`In-Reply-To: ${safeHeader(args.inReplyTo)}`);
  }
  if (args.references) {
    headers.push(`References: ${safeHeader(args.references)}`);
  }
  headers.push("MIME-Version: 1.0");
  const attachments = args.attachments || [];
  const inlineAttachments = attachments.filter(
    (attachment) =>
      attachment.disposition === "inline" && attachment.contentId,
  );
  const regularAttachments = attachments.filter(
    (attachment) => attachment.disposition !== "inline",
  );
  let htmlBody = args.bodyHtml
    ? sanitizeEmailHtml(args.bodyHtml)
    : null;
  if (inlineAttachments.length > 0 && !htmlBody) {
    htmlBody = `<div style="white-space:pre-wrap">${escapeHtml(args.body)}</div>`;
  }
  if (htmlBody && !htmlBody.includes(GROOVY_AI_EMAIL_DISCLOSURE)) {
    htmlBody +=
      '<div style="margin-top:16px;color:#666666;font-size:12px">' +
      escapeHtml(GROOVY_AI_EMAIL_DISCLOSURE) +
      "</div>";
  }
  if (args.trackingPixelUrl) {
    htmlBody =
      (htmlBody ||
        `<div style="white-space:pre-wrap">${escapeHtml(args.body)}</div>`) +
      `<img src="${escapeHtml(args.trackingPixelUrl)}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0" />`;
  }

  const lines = headers;
  const appendBodyEntity = (parentBoundary: string | null) => {
    if (inlineAttachments.length > 0) {
      const relatedBoundary = mimeBoundary("related");
      if (parentBoundary) lines.push(`--${parentBoundary}`);
      lines.push(
        `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
      );
      lines.push("");
      const alternativeBoundary = mimeBoundary("alt");
      lines.push(`--${relatedBoundary}`);
      lines.push(
        `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      );
      lines.push("");
      appendAlternativeParts({
        lines,
        boundary: alternativeBoundary,
        body: args.body,
        htmlBody: htmlBody || "",
      });
      for (const attachment of inlineAttachments) {
        appendAttachmentPart({
          lines,
          boundary: relatedBoundary,
          attachment,
        });
      }
      lines.push(`--${relatedBoundary}--`);
      return;
    }
    if (htmlBody) {
      const alternativeBoundary = mimeBoundary("alt");
      if (parentBoundary) lines.push(`--${parentBoundary}`);
      lines.push(
        `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      );
      lines.push("");
      appendAlternativeParts({
        lines,
        boundary: alternativeBoundary,
        body: args.body,
        htmlBody,
      });
      return;
    }
    if (parentBoundary) lines.push(`--${parentBoundary}`);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 8bit");
    lines.push("");
    lines.push(args.body);
  };

  if (regularAttachments.length > 0) {
    const mixedBoundary = mimeBoundary("mixed");
    lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    lines.push("");
    appendBodyEntity(mixedBoundary);
    for (const attachment of regularAttachments) {
      appendAttachmentPart({
        lines,
        boundary: mixedBoundary,
        attachment,
      });
    }
    lines.push(`--${mixedBoundary}--`);
  } else if (inlineAttachments.length > 0) {
    const relatedBoundary = mimeBoundary("related");
    lines.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`);
    lines.push("");
    const alternativeBoundary = mimeBoundary("alt");
    lines.push(`--${relatedBoundary}`);
    lines.push(
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    );
    lines.push("");
    appendAlternativeParts({
      lines,
      boundary: alternativeBoundary,
      body: args.body,
      htmlBody: htmlBody || "",
    });
    for (const attachment of inlineAttachments) {
      appendAttachmentPart({
        lines,
        boundary: relatedBoundary,
        attachment,
      });
    }
    lines.push(`--${relatedBoundary}--`);
  } else if (htmlBody) {
    const alternativeBoundary = mimeBoundary("alt");
    lines.push(
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    );
    lines.push("");
    appendAlternativeParts({
      lines,
      boundary: alternativeBoundary,
      body: args.body,
      htmlBody,
    });
  } else {
    appendBodyEntity(null);
  }
  return lines.join("\r\n");
}

function validRecipients(values: unknown): string[] {
  return parseEmailAddresses(values);
}

function gmailDraftUploadMetadata(args: {
  draftId?: string;
  threadId?: string | null;
}): RecordLike {
  return {
    ...(args.draftId ? { id: args.draftId } : {}),
    message: args.threadId ? { threadId: args.threadId } : {},
  };
}

function gmailMultipartMediaBody(args: {
  metadata: RecordLike;
  rawMessage: Uint8Array;
}): { body: ArrayBuffer; contentType: string } {
  const boundary = mimeBoundary("upload");
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${JSON.stringify(args.metadata)}\r\n` +
      `--${boundary}\r\n` +
      "Content-Type: message/rfc822\r\n\r\n",
    "utf8",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([prefix, Buffer.from(args.rawMessage), suffix]);
  return {
    body: body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer,
    contentType: `multipart/related; boundary="${boundary}"`,
  };
}

function gmailProxyUploadSessionEndpoint(location: string): string | null {
  try {
    const url = new URL(location, "https://www.googleapis.com");
    if (
      !["www.googleapis.com", "gmail.googleapis.com"].includes(url.hostname) ||
      !url.pathname.startsWith("/upload/gmail/v1/users/")
    ) {
      return null;
    }
    return `/api/proxy/gmail${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

async function uploadGmailDraftMedia(args: {
  mailbox: EmailMailboxConnection;
  method: "POST" | "PUT";
  draftId?: string;
  threadId?: string | null;
  raw: string;
  priority?: "interactive";
}): Promise<GmailCallResult> {
  const draftPath = args.draftId
    ? `/drafts/${encodeURIComponent(args.draftId)}`
    : "/drafts";
  const uploadEndpoint =
    `/api/proxy/gmail/upload/gmail/v1/users/me${draftPath}`;
  const metadata = gmailDraftUploadMetadata(args);
  const rawMessage = Buffer.from(args.raw, "utf8");
  const multipart = gmailMultipartMediaBody({ metadata, rawMessage });

  if (multipart.body.byteLength <= GMAIL_MEDIA_UPLOAD_CHUNK_BYTES) {
    return gmailApiCall({
      datagranApiKey: args.mailbox.datagranApiKey,
      connectionId: args.mailbox.connectionId,
      method: args.method,
      endpoint: `${uploadEndpoint}?uploadType=multipart`,
      rawBody: multipart.body,
      headers: { "Content-Type": multipart.contentType },
      priority: args.priority,
    });
  }

  const initiation = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: args.method,
    endpoint: `${uploadEndpoint}?uploadType=resumable`,
    body: metadata,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "message/rfc822",
      "X-Upload-Content-Length": String(rawMessage.byteLength),
    },
    includeResponseHeaders: true,
    priority: args.priority,
  });
  if (!initiation.ok) return initiation;

  const sessionEndpoint = gmailProxyUploadSessionEndpoint(
    initiation.responseHeaders?.location || "",
  );
  if (!sessionEndpoint) {
    return {
      ok: false,
      status: initiation.status,
      error: "Gmail did not return a valid upload session.",
    };
  }

  let offset = 0;
  while (offset < rawMessage.byteLength) {
    const end = Math.min(
      rawMessage.byteLength,
      offset + GMAIL_MEDIA_UPLOAD_CHUNK_BYTES,
    );
    const chunk = rawMessage.buffer.slice(
      rawMessage.byteOffset + offset,
      rawMessage.byteOffset + end,
    ) as ArrayBuffer;
    const result = await gmailApiCall({
      datagranApiKey: args.mailbox.datagranApiKey,
      connectionId: args.mailbox.connectionId,
      method: "PUT",
      endpoint: sessionEndpoint,
      rawBody: chunk,
      headers: {
        "Content-Type": "message/rfc822",
        "Content-Range": `bytes ${offset}-${end - 1}/${rawMessage.byteLength}`,
      },
      acceptedStatuses: [308],
      includeResponseHeaders: true,
      priority: args.priority,
    });
    if (!result.ok) return result;
    if (result.status !== 308) return result;

    const acknowledged = result.responseHeaders?.range?.match(
      /^bytes=0-(\d+)$/i,
    );
    const nextOffset = acknowledged ? Number(acknowledged[1]) + 1 : end;
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) {
      return {
        ok: false,
        status: 502,
        error: "Gmail stopped before the draft upload completed.",
      };
    }
    offset = Math.min(nextOffset, rawMessage.byteLength);
  }

  return {
    ok: false,
    status: 502,
    error: "Gmail did not finish the draft upload.",
  };
}

export async function createGmailDraft(args: {
  mailbox: EmailMailboxConnection;
  threadId?: string | null;
  sourceMessageId?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string | null;
  attachments?: OutgoingEmailAttachment[];
  inReplyTo?: string | null;
  references?: string | null;
}): Promise<EmailDraft> {
  const to = validRecipients(args.to);
  const cc = validRecipients(args.cc || []);
  const bcc = validRecipients(args.bcc || []);
  const body = ensureGroovyAiEmailDisclosure(args.body);
  const raw = buildRawMessage({
    to,
    cc,
    bcc,
    subject: args.subject,
    body,
    bodyHtml: args.bodyHtml,
    attachments: args.attachments,
    inReplyTo: args.inReplyTo,
    references: args.references,
  });
  const response = args.attachments?.length
    ? await uploadGmailDraftMedia({
        mailbox: args.mailbox,
        method: "POST",
        threadId: args.threadId,
        raw,
      })
    : await gmailApiCall({
        datagranApiKey: args.mailbox.datagranApiKey,
        connectionId: args.mailbox.connectionId,
        method: "POST",
        endpoint: "/api/proxy/gmail/gmail/v1/users/me/drafts",
        body: {
          message: {
            raw: encodeBase64Url(raw),
            ...(args.threadId ? { threadId: args.threadId } : {}),
          },
        },
      });
  if (!response.ok) {
    throw gmailApiError(response, "Could not create Gmail draft.");
  }
  const data = record(response.data);
  const draftId = stringValue(data?.id);
  if (!draftId) throw new Error("Gmail did not return a draft ID.");
  return {
    actionId: null,
    draftId,
    connectionId: args.mailbox.connectionId,
    threadId: args.threadId || null,
    sourceMessageId: args.sourceMessageId || null,
    to,
    cc,
    bcc,
    subject: args.subject,
    body,
    bodyHtml: args.bodyHtml || null,
    attachments: (args.attachments || []).map(publicDraftAttachment),
    aiGenerated: false,
    untouched: false,
    updatedAt: new Date().toISOString(),
    inReplyTo: args.inReplyTo || null,
    references: args.references || null,
  };
}

export async function updateGmailDraft(args: {
  mailbox: EmailMailboxConnection;
  draftId: string;
  threadId?: string | null;
  sourceMessageId?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string | null;
  attachments?: OutgoingEmailAttachment[];
  inReplyTo?: string | null;
  references?: string | null;
  trackingPixelUrl?: string | null;
  priority?: "interactive";
}): Promise<EmailDraft> {
  const to = validRecipients(args.to);
  const cc = validRecipients(args.cc || []);
  const bcc = validRecipients(args.bcc || []);
  const body = ensureGroovyAiEmailDisclosure(args.body);
  const raw = buildRawMessage({
    to,
    cc,
    bcc,
    subject: args.subject,
    body,
    bodyHtml: args.bodyHtml,
    attachments: args.attachments,
    inReplyTo: args.inReplyTo,
    references: args.references,
    trackingPixelUrl: args.trackingPixelUrl,
  });
  const response = args.attachments?.length
    ? await uploadGmailDraftMedia({
        mailbox: args.mailbox,
        method: "PUT",
        draftId: args.draftId,
        threadId: args.threadId,
        raw,
        priority: args.priority,
      })
    : await gmailApiCall({
        datagranApiKey: args.mailbox.datagranApiKey,
        connectionId: args.mailbox.connectionId,
        method: "PUT",
        endpoint: `/api/proxy/gmail/gmail/v1/users/me/drafts/${encodeURIComponent(args.draftId)}`,
        body: {
          id: args.draftId,
          message: {
            raw: encodeBase64Url(raw),
            ...(args.threadId ? { threadId: args.threadId } : {}),
          },
        },
        priority: args.priority,
      });
  if (!response.ok) {
    throw gmailApiError(response, "Could not update Gmail draft.");
  }
  return {
    actionId: null,
    draftId: args.draftId,
    connectionId: args.mailbox.connectionId,
    threadId: args.threadId || null,
    sourceMessageId: args.sourceMessageId || null,
    to,
    cc,
    bcc,
    subject: args.subject,
    body,
    bodyHtml: args.bodyHtml || null,
    attachments: (args.attachments || []).map(publicDraftAttachment),
    aiGenerated: false,
    untouched: false,
    updatedAt: new Date().toISOString(),
    inReplyTo: args.inReplyTo || null,
    references: args.references || null,
  };
}

export async function fetchGmailDraft(args: {
  mailbox: EmailMailboxConnection;
  draftId: string;
  actionId?: string | null;
  aiGenerated?: boolean;
  untouched?: boolean;
  priority?: "interactive";
}): Promise<EmailDraft | null> {
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "GET",
    endpoint: `/api/proxy/gmail/gmail/v1/users/me/drafts/${encodeURIComponent(args.draftId)}?format=full`,
    priority: args.priority,
  });
  if (!response.ok) {
    if (
      response.status === 404 ||
      isMissingGmailEntityError(new Error(response.error || ""))
    ) {
      return null;
    }
    throw gmailApiError(response, "Could not load Gmail draft.");
  }
  const data = record(response.data);
  const message = record(data?.message);
  const payload = record(message?.payload);
  const content = extractPayloadContent(payload);
  return {
    actionId: args.actionId || null,
    draftId: stringValue(data?.id) || args.draftId,
    connectionId: args.mailbox.connectionId,
    threadId: stringValue(message?.threadId) || null,
    sourceMessageId: null,
    to: parseEmailAddresses(headerValue(payload, "To")),
    cc: parseEmailAddresses(headerValue(payload, "Cc")),
    bcc: parseEmailAddresses(headerValue(payload, "Bcc")),
    subject: headerValue(payload, "Subject"),
    body: content.body,
    bodyHtml: content.htmlBody,
    attachments: [],
    aiGenerated: args.aiGenerated === true,
    untouched: args.untouched === true,
    updatedAt: null,
    inReplyTo: headerValue(payload, "In-Reply-To") || null,
    references: headerValue(payload, "References") || null,
  };
}

export async function sendGmailDraft(args: {
  mailbox: EmailMailboxConnection;
  draftId: string;
  priority?: "interactive";
}): Promise<{ messageId: string | null; threadId: string | null }> {
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "POST",
    endpoint: "/api/proxy/gmail/gmail/v1/users/me/drafts/send",
    body: { id: args.draftId },
    priority: args.priority,
  });
  if (!response.ok) {
    throw gmailApiError(response, "Could not send Gmail draft.");
  }
  const data = record(response.data);
  return {
    messageId: stringValue(data?.id) || null,
    threadId: stringValue(data?.threadId) || null,
  };
}

async function gmailMessageIdsForQuery(args: {
  mailbox: EmailMailboxConnection;
  query: string;
  priority?: "interactive";
}): Promise<string[]> {
  invalidateGmailGetCache(args.mailbox.connectionId);
  const query = new URLSearchParams({
    q: args.query,
    maxResults: "500",
  });
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "GET",
    endpoint:
      `/api/proxy/gmail/gmail/v1/users/me/messages?${query.toString()}`,
    priority: args.priority,
  });
  if (!response.ok) {
    throw gmailApiError(
      response,
      "Could not verify Gmail's automatic sent copies.",
    );
  }
  const root = record(response.data);
  const messages = Array.isArray(root?.messages) ? root.messages : [];
  return Array.from(
    new Set(
      messages
        .map((item) => stringValue(record(item)?.id))
        .filter(Boolean),
    ),
  );
}

export async function findGmailSentMessageIds(args: {
  mailbox: EmailMailboxConnection;
  messageIdHeader: string;
  priority?: "interactive";
}): Promise<string[]> {
  const messageId = safeHeader(args.messageIdHeader)
    .replace(/^</, "")
    .replace(/>$/, "");
  if (!messageId || !messageId.includes("@")) return [];
  return gmailMessageIdsForQuery({
    mailbox: args.mailbox,
    query: `in:sent rfc822msgid:${messageId}`,
    priority: args.priority,
  });
}

export async function trashGmailSmtpSentCopies(args: {
  mailbox: EmailMailboxConnection;
  messageIdHeader: string;
  expectedCopyCount?: number;
  pollDelaysMs?: readonly number[];
  excludeMessageIds?: readonly string[];
  priority?: "interactive";
}): Promise<{ messageIds: string[]; alreadyTrashed: boolean }> {
  const messageId = safeHeader(args.messageIdHeader)
    .replace(/^</, "")
    .replace(/>$/, "");
  if (!messageId || !messageId.includes("@")) {
    throw new Error("A valid sent Message-ID is required.");
  }
  const search = `rfc822msgid:${messageId}`;
  const excludedMessageIds = new Set(
    (args.excludeMessageIds || []).map((value) => value.trim()).filter(Boolean),
  );
  const withoutExcluded = (messageIds: string[]) =>
    messageIds.filter((id) => !excludedMessageIds.has(id));
  const expectedCopyCount = Math.max(
    1,
    Math.min(500, Math.floor(args.expectedCopyCount || 1)),
  );
  const pollDelaysMs =
    args.pollDelaysMs &&
    args.pollDelaysMs.length > 0
      ? args.pollDelaysMs
      : [
          0,
          250,
          500,
          750,
          1_000,
          1_500,
          2_000,
          2_500,
          3_000,
          4_000,
          5_000,
        ];
  let sentMessageIds: string[] = [];
  let trashedMessageIds: string[] = [];
  let allMessageIds: string[] = [];
  for (const delayMs of pollDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, delayMs)),
      );
    }
    sentMessageIds = await gmailMessageIdsForQuery({
      mailbox: args.mailbox,
      query: `in:sent ${search}`,
      priority: args.priority,
    }).then(withoutExcluded);
    if (sentMessageIds.length >= expectedCopyCount) {
      allMessageIds = sentMessageIds;
      break;
    }
    // A prior request may have moved some SMTP variants to Trash before its
    // response was interrupted. Count both locations so a retry can finish
    // cleanup without resending recipients or waiting for an impossible
    // number of copies to remain in Sent.
    trashedMessageIds = await gmailMessageIdsForQuery({
      mailbox: args.mailbox,
      query: `in:trash ${search}`,
      priority: args.priority,
    }).then(withoutExcluded);
    allMessageIds = Array.from(
      new Set([...sentMessageIds, ...trashedMessageIds]),
    );
    if (allMessageIds.length >= expectedCopyCount) break;
  }
  if (allMessageIds.length < expectedCopyCount) {
    throw new GmailApiError(
      "Gmail delivered the recipients, but every private sent copy is not indexed yet. Groovy will retry cleanup without resending anyone.",
      {
        status: 503,
        retryable: true,
        retryAfterMs: 1_500,
      },
    );
  }
  for (const messageId of sentMessageIds) {
    const response = await gmailApiCall({
      datagranApiKey: args.mailbox.datagranApiKey,
      connectionId: args.mailbox.connectionId,
      method: "POST",
      endpoint:
        `/api/proxy/gmail/gmail/v1/users/me/messages/` +
        `${encodeURIComponent(messageId)}/trash`,
      body: {},
      priority: args.priority,
    });
    if (!response.ok && response.status !== 404) {
      throw gmailApiError(
        response,
        "Could not replace Gmail's private sent copies.",
      );
    }
  }
  return {
    messageIds: allMessageIds,
    alreadyTrashed: sentMessageIds.length === 0,
  };
}

export async function insertGmailSentMessage(args: {
  mailbox: EmailMailboxConnection;
  raw: string;
  threadId?: string | null;
  priority?: "interactive";
}): Promise<{ messageId: string | null; threadId: string | null }> {
  const message: RecordLike = {
    raw: encodeBase64Url(args.raw),
    labelIds: ["SENT"],
  };
  if (args.threadId) message.threadId = args.threadId;
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "POST",
    endpoint:
      "/api/proxy/gmail/gmail/v1/users/me/messages" +
      "?internalDateSource=dateHeader",
    body: message,
    priority: args.priority,
  });
  if (!response.ok) {
    throw gmailApiError(response, "Could not save the sent Gmail copy.");
  }
  const data = record(response.data);
  return {
    messageId: stringValue(data?.id) || null,
    threadId: stringValue(data?.threadId) || null,
  };
}

export async function deleteGmailDraft(args: {
  mailbox: EmailMailboxConnection;
  draftId: string;
  priority?: "interactive";
}): Promise<void> {
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "DELETE",
    endpoint: `/api/proxy/gmail/gmail/v1/users/me/drafts/${encodeURIComponent(args.draftId)}`,
    priority: args.priority,
  });
  if (!response.ok && response.status !== 404) {
    throw gmailApiError(response, "Could not discard Gmail draft.");
  }
}

function gmailLabelsFromResponse(data: unknown): Record<string, string> {
  const root = record(data);
  const labels = Array.isArray(root?.labels) ? root.labels : [];
  const byName: Record<string, string> = {};
  for (const raw of labels) {
    const item = record(raw);
    const name = stringValue(item?.name);
    const id = stringValue(item?.id);
    if (name && id) byName[name] = id;
  }
  return byName;
}

function gmailLabelPreparationError(result: GmailCallResult): Error {
  if (result.needsReauth) {
    return new GmailApiError(
      "Gmail authorization no longer permits label updates. Reconnect this mailbox and try again.",
      {
        status: result.status,
        retryable: false,
        needsReauth: true,
      },
    );
  }
  return gmailApiError(
    result,
    "Could not prepare Gmail labels. Try again.",
    stringValue(result.error) ? "Could not prepare Gmail labels: " : "",
  );
}

function cacheGroovyGmailLabels(
  cacheKey: string,
  labels: Record<string, string>,
): Record<string, string> {
  const now = Date.now();
  gmailLabelCache.set(cacheKey, {
    expiresAt: now + GMAIL_LABEL_CACHE_TTL_MS,
    labels,
  });
  if (gmailLabelCache.size > 500) {
    for (const [key, entry] of gmailLabelCache) {
      if (entry.expiresAt <= now) gmailLabelCache.delete(key);
    }
    while (gmailLabelCache.size > 500) {
      const oldest = gmailLabelCache.keys().next().value;
      if (typeof oldest !== "string") break;
      gmailLabelCache.delete(oldest);
    }
  }
  return labels;
}

async function prepareGroovyGmailLabels(
  mailbox: EmailMailboxConnection,
  requiredLabels: readonly GroovyEmailLabelName[],
  cacheKey: string,
  priority?: "interactive",
): Promise<Record<string, string>> {
  const listLabels = () =>
    gmailApiCall({
      datagranApiKey: mailbox.datagranApiKey,
      connectionId: mailbox.connectionId,
      method: "GET",
      endpoint: "/api/proxy/gmail/gmail/v1/users/me/labels",
      priority,
    });
  const listed = await listLabels();
  if (!listed.ok) throw gmailLabelPreparationError(listed);

  let byName = gmailLabelsFromResponse(listed.data);
  let createFailure: GmailCallResult | null = null;
  for (const name of requiredLabels) {
    if (byName[name]) continue;
    const created = await gmailApiCall({
      datagranApiKey: mailbox.datagranApiKey,
      connectionId: mailbox.connectionId,
      method: "POST",
      endpoint: "/api/proxy/gmail/gmail/v1/users/me/labels",
      body: {
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
      priority,
    });
    const item = record(created.data);
    const id = stringValue(item?.id);
    if (created.ok && id) {
      byName[name] = id;
    } else {
      createFailure = created;
    }
  }

  const missing = requiredLabels.filter((name) => !byName[name]);
  if (missing.length > 0) {
    // Another server instance may have created the same label between our
    // list and create calls. Re-list once so Gmail's durable state wins over
    // a harmless duplicate-name response.
    const refreshed = await listLabels();
    if (refreshed.ok) {
      byName = {
        ...byName,
        ...gmailLabelsFromResponse(refreshed.data),
      };
    } else if (refreshed.needsReauth || !createFailure) {
      createFailure = refreshed;
    }
  }

  if (requiredLabels.some((name) => !byName[name])) {
    throw gmailLabelPreparationError(
      createFailure || {
        ok: false,
        status: 0,
        error: "Gmail did not return the requested label.",
      },
    );
  }
  return cacheGroovyGmailLabels(cacheKey, byName);
}

export async function ensureGroovyGmailLabels(args: {
  mailbox: EmailMailboxConnection;
  requiredLabels?: readonly GroovyEmailLabelName[];
  priority?: "interactive";
}): Promise<Record<string, string>> {
  const requiredLabels = Array.from(
    new Set(
      args.requiredLabels?.length
        ? args.requiredLabels
        : Object.values(GROOVY_EMAIL_LABELS),
    ),
  );
  const connectionId = args.mailbox.connectionId;
  const cacheKey = `${connectionId}:${hashString(
    args.mailbox.datagranApiKey,
  )}`;
  // An interactive mutation must not wait behind a background label lookup.
  // The resolved label cache remains shared, while in-flight work is split by
  // priority so the request scheduler can put the user action first.
  const inflightKey = `${cacheKey}:${args.priority || "background"}`;

  while (true) {
    const now = Date.now();
    const cached = gmailLabelCache.get(cacheKey);
    if (cached && cached.expiresAt <= now) {
      gmailLabelCache.delete(cacheKey);
    } else if (
      cached &&
      requiredLabels.every((name) => Boolean(cached.labels[name]))
    ) {
      return cached.labels;
    }

    const active = gmailLabelInflight.get(inflightKey);
    if (active) {
      await active;
      continue;
    }

    const task = prepareGroovyGmailLabels(
      args.mailbox,
      requiredLabels,
      cacheKey,
      args.priority,
    ).finally(() => {
      if (gmailLabelInflight.get(inflightKey) === task) {
        gmailLabelInflight.delete(inflightKey);
      }
    });
    gmailLabelInflight.set(inflightKey, task);
    return task;
  }
}

export async function modifyGmailThreadLabels(args: {
  mailbox: EmailMailboxConnection;
  threadId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  priority?: "interactive";
}): Promise<void> {
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "POST",
    endpoint: `/api/proxy/gmail/gmail/v1/users/me/threads/${encodeURIComponent(args.threadId)}/modify`,
    body: {
      addLabelIds: (args.addLabelIds || []).filter(Boolean),
      removeLabelIds: (args.removeLabelIds || []).filter(Boolean),
    },
    priority: args.priority,
  });
  if (!response.ok) {
    throw gmailApiError(response, "Could not update Gmail labels.");
  }
}

export async function modifyGmailMessageLabels(args: {
  mailbox: EmailMailboxConnection;
  messageId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  priority?: "interactive";
}): Promise<void> {
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "POST",
    endpoint: `/api/proxy/gmail/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}/modify`,
    body: {
      addLabelIds: (args.addLabelIds || []).filter(Boolean),
      removeLabelIds: (args.removeLabelIds || []).filter(Boolean),
    },
    priority: args.priority,
  });
  if (!response.ok) {
    throw gmailApiError(response, "Could not update Gmail labels.");
  }
}

export async function modifyGmailMessagesLabels(args: {
  mailbox: EmailMailboxConnection;
  messageIds: readonly string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
  priority?: "interactive";
}): Promise<void> {
  const ids = Array.from(
    new Set(args.messageIds.map((value) => value.trim()).filter(Boolean)),
  );
  if (ids.length === 0) return;
  const response = await gmailApiCall({
    datagranApiKey: args.mailbox.datagranApiKey,
    connectionId: args.mailbox.connectionId,
    method: "POST",
    endpoint: "/api/proxy/gmail/gmail/v1/users/me/messages/batchModify",
    body: {
      ids,
      addLabelIds: (args.addLabelIds || []).filter(Boolean),
      removeLabelIds: (args.removeLabelIds || []).filter(Boolean),
    },
    priority: args.priority,
  });
  if (!response.ok) {
    throw gmailApiError(response, "Could not update Gmail labels.");
  }
}
