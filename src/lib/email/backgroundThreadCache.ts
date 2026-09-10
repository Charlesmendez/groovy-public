import type { EmailThreadDetail } from "@/lib/email/types";

/**
 * Conversation bodies the service worker fetched while handling a push, so a
 * notification tap renders the message immediately instead of waiting on
 * Gmail. Keyed by account + conversation, independent of the request query
 * string, so the worker and the app agree on the entry.
 */
export const EMAIL_THREAD_SNAPSHOT_CACHE = "groovy-email-thread-v1";
export const EMAIL_THREAD_SNAPSHOT_PATH = "/__groovy/email-thread";
export const EMAIL_THREAD_SNAPSHOT_AT_HEADER = "X-Groovy-Email-Thread-At";
export const EMAIL_THREAD_SNAPSHOT_MAX_AGE_MS = 60 * 60_000;

/**
 * A cached conversation is only safe to reuse when it contains the message
 * represented by the current list row or notification. Gmail threads grow as
 * replies arrive, while the cache key intentionally stays stable; checking
 * coverage prevents an older snapshot from hiding a newer reply.
 */
export function emailThreadDetailContainsMessage(
  detail: { messages: readonly { id: string }[] },
  messageId: string | null | undefined,
): boolean {
  const expected = messageId?.trim();
  return !expected || detail.messages.some((message) => message.id === expected);
}

export function emailThreadSnapshotUrl(
  args: {
    scope: string;
    connectionId: string;
    threadId: string;
  },
  origin = typeof window === "undefined"
    ? "https://www.gogroovy.ai"
    : window.location.origin,
): string {
  const url = new URL(EMAIL_THREAD_SNAPSHOT_PATH, origin);
  url.searchParams.set("scope", args.scope);
  url.searchParams.set("connectionId", args.connectionId);
  url.searchParams.set("threadId", args.threadId);
  return url.href;
}

function isThreadDetail(value: unknown): value is EmailThreadDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  const summary = detail.summary as Record<string, unknown> | undefined;
  return (
    Boolean(summary) &&
    typeof summary?.key === "string" &&
    typeof summary?.threadId === "string" &&
    typeof summary?.connectionId === "string" &&
    Array.isArray(detail.messages)
  );
}

export async function readEmailBackgroundThreadSnapshot(args: {
  scope: string;
  connectionId: string;
  threadId: string;
  cacheStorage?: {
    open(name: string): Promise<Pick<Cache, "match">>;
  } | null;
  now?: number;
}): Promise<{ detail: EmailThreadDetail; savedAt: number } | null> {
  const cacheStorage =
    args.cacheStorage === undefined
      ? typeof caches === "undefined"
        ? null
        : caches
      : args.cacheStorage;
  if (!cacheStorage || !args.scope || !args.connectionId || !args.threadId) {
    return null;
  }
  try {
    const cache = await cacheStorage.open(EMAIL_THREAD_SNAPSHOT_CACHE);
    const response = await cache.match(
      emailThreadSnapshotUrl({
        scope: args.scope,
        connectionId: args.connectionId,
        threadId: args.threadId,
      }),
    );
    if (!response?.ok) return null;
    const savedAt = Number(
      response.headers.get(EMAIL_THREAD_SNAPSHOT_AT_HEADER),
    );
    const now = args.now ?? Date.now();
    if (
      !Number.isFinite(savedAt) ||
      savedAt > now + 60_000 ||
      Math.max(0, now - savedAt) > EMAIL_THREAD_SNAPSHOT_MAX_AGE_MS
    ) {
      return null;
    }
    const payload: unknown = await response.json();
    const detail =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).thread
        : null;
    return isThreadDetail(detail) ? { detail, savedAt } : null;
  } catch {
    return null;
  }
}
