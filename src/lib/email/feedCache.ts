import {
  EMAIL_FEED_SCHEMA_VERSION,
  type EmailFeedResponse,
  type EmailView,
} from "@/lib/email/types";

// Cached snapshots always repaint before a live refresh, so a generous age
// keeps cold launches (home-screen PWA, new tab) instant instead of blank.
export const EMAIL_FEED_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

const EMAIL_FEED_CACHE_VERSION = 6;
const EMAIL_FEED_CACHE_PREFIX = `groovy.email.feed.v${EMAIL_FEED_CACHE_VERSION}:`;
const EMAIL_VIEWS = new Set<EmailView>([
  "focus",
  "inbox",
  "sent",
  "noise",
  "handled",
  "all",
]);

export type EmailFeedCacheEntry = {
  feed: EmailFeedResponse;
  limit: number;
  savedAt: number;
  revision?: number;
};

export type EmailFeedCacheRecord = {
  view: EmailView;
  connectionId: string | null;
  entry: EmailFeedCacheEntry;
};

export type EmailFeedCacheStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

type StoredEmailFeedCache = EmailFeedCacheRecord & {
  version: number;
  scope: string;
};

const memoryCache = new Map<string, StoredEmailFeedCache>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEmailView(value: unknown): value is EmailView {
  return typeof value === "string" && EMAIL_VIEWS.has(value as EmailView);
}

function isMailbox(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.counts)) return false;
  return (
    typeof value.connectionId === "string" &&
    typeof value.address === "string" &&
    typeof value.displayName === "string" &&
    typeof value.status === "string" &&
    typeof value.counts.inbox === "number" &&
    typeof value.counts.focus === "number" &&
    typeof value.counts.drafts === "number" &&
    typeof value.counts.noise === "number"
  );
}

function isThread(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.mailbox)) return false;
  return (
    typeof value.key === "string" &&
    typeof value.connectionId === "string" &&
    typeof value.messageId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.senderName === "string" &&
    typeof value.senderEmail === "string" &&
    Array.isArray(value.recipients) &&
    typeof value.subject === "string" &&
    typeof value.snippet === "string" &&
    typeof value.receivedAt === "string" &&
    typeof value.unread === "boolean" &&
    typeof value.starred === "boolean" &&
    typeof value.hasAttachments === "boolean" &&
    (value.direction === "incoming" || value.direction === "outgoing") &&
    isMailbox(value.mailbox)
  );
}

export function isEmailFeedResponse(
  value: unknown,
  expectedView: EmailView,
): value is EmailFeedResponse {
  if (
    !isRecord(value) ||
    value.view !== expectedView ||
    !Array.isArray(value.mailboxes) ||
    !value.mailboxes.every(isMailbox) ||
    !Array.isArray(value.threads) ||
    !value.threads.every(isThread) ||
    !(value.nextCursor === null || typeof value.nextCursor === "string") ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === "string") ||
    !(
      value.authoritativeRemovedConversations === undefined ||
      (Array.isArray(value.authoritativeRemovedConversations) &&
        value.authoritativeRemovedConversations.every(
          (removal) =>
            isRecord(removal) &&
            typeof removal.id === "string" &&
            typeof removal.correctedAt === "string",
        ))
    ) ||
    !isRecord(value.stats)
  ) {
    return false;
  }
  return (
    value.schemaVersion === EMAIL_FEED_SCHEMA_VERSION &&
    typeof value.stats.focus === "number" &&
    typeof value.stats.processed === "number" &&
    typeof value.stats.draftsReady === "number" &&
    typeof value.stats.needsReview === "number" &&
    typeof value.stats.noiseCaught === "number"
  );
}

function cacheKey(
  scope: string,
  view: EmailView,
  connectionId: string | null,
): string {
  const mailbox = connectionId
    ? `mailbox:${encodeURIComponent(connectionId)}`
    : "all-mailboxes";
  return `${EMAIL_FEED_CACHE_PREFIX}${encodeURIComponent(scope)}:${view}:${mailbox}`;
}

function browserFeedStorage(): EmailFeedCacheStorage | null {
  if (typeof window === "undefined") return null;
  // localStorage survives PWA cold launches (sessionStorage does not on iOS
  // home-screen apps), which is what makes reopen paints instant.
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isUsableStoredCache(
  value: unknown,
  expected: {
    scope: string;
    view?: EmailView;
    connectionId?: string | null;
    now: number;
    maxAgeMs?: number;
  },
): boolean {
  if (
    !isRecord(value) ||
    value.version !== EMAIL_FEED_CACHE_VERSION ||
    value.scope !== expected.scope ||
    !isEmailView(value.view) ||
    !(value.connectionId === null || typeof value.connectionId === "string") ||
    !isRecord(value.entry) ||
    !Number.isFinite(value.entry.limit) ||
    !Number.isFinite(value.entry.savedAt) ||
    !(
      value.entry.revision === undefined ||
      (Number.isSafeInteger(value.entry.revision) &&
        Number(value.entry.revision) >= 0)
    ) ||
    !isEmailFeedResponse(value.entry.feed, value.view)
  ) {
    return false;
  }
  if (
    expected.view !== undefined &&
    (value.view !== expected.view ||
      value.connectionId !== expected.connectionId)
  ) {
    return false;
  }
  const age = Math.max(0, expected.now - Number(value.entry.savedAt));
  return age <= (expected.maxAgeMs ?? EMAIL_FEED_CACHE_MAX_AGE_MS);
}

export function emailFeedCacheRevision(
  entry: Pick<EmailFeedCacheEntry, "revision"> | null | undefined,
): number {
  return Number.isFinite(entry?.revision) ? Number(entry?.revision) : 0;
}

export function nextEmailFeedCacheRevision(
  entry: Pick<EmailFeedCacheEntry, "revision"> | null | undefined,
): number {
  return emailFeedCacheRevision(entry) + 1;
}

export function isEmailFeedCacheRevisionCurrent(
  baseline: Pick<EmailFeedCacheEntry, "revision"> | null | undefined,
  current: Pick<EmailFeedCacheEntry, "revision"> | null | undefined,
): boolean {
  return emailFeedCacheRevision(baseline) === emailFeedCacheRevision(current);
}

function parseStoredCache(
  raw: string,
  expected: {
    scope: string;
    view?: EmailView;
    connectionId?: string | null;
    now: number;
    maxAgeMs?: number;
  },
): StoredEmailFeedCache | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isUsableStoredCache(parsed, expected)
      ? (parsed as StoredEmailFeedCache)
      : null;
  } catch {
    return null;
  }
}

function removeCacheKey(
  key: string,
  storage: EmailFeedCacheStorage | null,
): void {
  memoryCache.delete(key);
  try {
    storage?.removeItem(key);
  } catch {
    // The in-memory cache remains available when browser storage is restricted.
  }
}

export function readEmailFeedCache(
  scope: string,
  view: EmailView,
  connectionId: string | null,
  options: {
    now?: number;
    storage?: EmailFeedCacheStorage | null;
    maxAgeMs?: number;
  } = {},
): EmailFeedCacheEntry | null {
  const now = options.now ?? Date.now();
  const storage = options.storage ?? browserFeedStorage();
  const key = cacheKey(scope, view, connectionId);
  const inMemory = memoryCache.get(key);
  if (
    inMemory &&
    isUsableStoredCache(inMemory, {
      scope,
      view,
      connectionId,
      now,
      maxAgeMs: options.maxAgeMs,
    })
  ) {
    return inMemory.entry;
  }
  if (inMemory) memoryCache.delete(key);

  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  const stored = parseStoredCache(raw, {
    scope,
    view,
    connectionId,
    now,
    maxAgeMs: options.maxAgeMs,
  });
  if (!stored) {
    removeCacheKey(key, storage);
    return null;
  }
  memoryCache.set(key, stored);
  return stored.entry;
}

export function readEmailFeedCaches(
  scope: string,
  options: {
    now?: number;
    storage?: EmailFeedCacheStorage | null;
  } = {},
): EmailFeedCacheRecord[] {
  const now = options.now ?? Date.now();
  const storage = options.storage ?? browserFeedStorage();
  const records = new Map<string, StoredEmailFeedCache>();

  for (const [key, stored] of memoryCache) {
    if (!key.startsWith(EMAIL_FEED_CACHE_PREFIX)) continue;
    if (isUsableStoredCache(stored, { scope, now })) {
      records.set(key, stored);
    } else if (stored.scope === scope) {
      memoryCache.delete(key);
    }
  }

  if (storage) {
    const keys: string[] = [];
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(EMAIL_FEED_CACHE_PREFIX)) keys.push(key);
      }
    } catch {
      return Array.from(records.values()).map(
        ({ view, connectionId, entry }) => ({ view, connectionId, entry }),
      );
    }
    for (const key of keys) {
      let raw: string | null = null;
      try {
        raw = storage.getItem(key);
      } catch {
        continue;
      }
      if (!raw) continue;
      const stored = parseStoredCache(raw, { scope, now });
      if (!stored) {
        // Only remove malformed or expired entries belonging to this user.
        try {
          const parsed = JSON.parse(raw) as { scope?: unknown };
          if (parsed?.scope === scope) removeCacheKey(key, storage);
        } catch {
          removeCacheKey(key, storage);
        }
        continue;
      }
      memoryCache.set(key, stored);
      records.set(key, stored);
    }
  }

  return Array.from(records.values())
    .sort((left, right) => right.entry.savedAt - left.entry.savedAt)
    .map(({ view, connectionId, entry }) => ({ view, connectionId, entry }));
}

export function writeEmailFeedCache(
  scope: string,
  view: EmailView,
  connectionId: string | null,
  entry: EmailFeedCacheEntry,
  options: {
    storage?: EmailFeedCacheStorage | null;
  } = {},
): void {
  const key = cacheKey(scope, view, connectionId);
  const stored: StoredEmailFeedCache = {
    version: EMAIL_FEED_CACHE_VERSION,
    scope,
    view,
    connectionId,
    entry: {
      feed: entry.feed,
      limit: Math.max(1, Math.floor(entry.limit)),
      savedAt: entry.savedAt,
      revision: emailFeedCacheRevision(entry),
    },
  };
  memoryCache.set(key, stored);

  const storage = options.storage ?? browserFeedStorage();
  if (!storage) return;
  const serialized = JSON.stringify(stored);
  try {
    storage.setItem(key, serialized);
    return;
  } catch {
    // Browser storage can be small on mobile. Keep the current view by
    // evicting older email snapshots only, then retry once.
  }

  const candidates: Array<{ key: string; savedAt: number }> = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const candidateKey = storage.key(index);
      if (
        !candidateKey ||
        candidateKey === key ||
        !candidateKey.startsWith(EMAIL_FEED_CACHE_PREFIX)
      ) {
        continue;
      }
      const raw = storage.getItem(candidateKey);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        entry?: { savedAt?: unknown };
      };
      candidates.push({
        key: candidateKey,
        savedAt:
          typeof parsed.entry?.savedAt === "number"
            ? parsed.entry.savedAt
            : 0,
      });
    }
    candidates.sort((left, right) => left.savedAt - right.savedAt);
    for (const candidate of candidates) storage.removeItem(candidate.key);
    storage.setItem(key, serialized);
  } catch {
    // The module cache still makes normal client-side navigation instant.
  }
}

export function clearEmailFeedCache(
  scope?: string,
  storage: EmailFeedCacheStorage | null = browserFeedStorage(),
): void {
  for (const [key, stored] of memoryCache) {
    if (scope === undefined || stored.scope === scope) memoryCache.delete(key);
  }
  if (!storage) return;
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(EMAIL_FEED_CACHE_PREFIX)) continue;
      if (scope === undefined) {
        keys.push(key);
        continue;
      }
      const raw = storage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { scope?: unknown };
      if (parsed.scope === scope) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Clearing a recoverable cache is best-effort.
  }
}
