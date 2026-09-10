import { isEmailFeedResponse } from "@/lib/email/feedCache";
import type { EmailFeedResponse } from "@/lib/email/types";

export const EMAIL_FOCUS_SNAPSHOT_CACHE = "groovy-email-focus-snapshot-v1";
export const EMAIL_FOCUS_SNAPSHOT_PATH = "/__groovy/email-focus-snapshot";
export const EMAIL_FOCUS_SNAPSHOT_AT_HEADER =
  "X-Groovy-Email-Snapshot-At";
export const EMAIL_FOCUS_SNAPSHOT_KIND_HEADER =
  "X-Groovy-Email-Snapshot-Kind";
export const EMAIL_FOCUS_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;
export type EmailFocusSnapshotKind = "full" | "notification";

export function emailFocusSnapshotUrl(
  scope: string,
  origin = typeof window === "undefined" ? "https://www.gogroovy.ai" : window.location.origin,
): string {
  const url = new URL(EMAIL_FOCUS_SNAPSHOT_PATH, origin);
  url.searchParams.set("scope", scope);
  return url.href;
}

export async function readEmailBackgroundFocusSnapshot(args: {
  scope: string;
  cacheStorage?: {
    open(name: string): Promise<Pick<Cache, "match">>;
  } | null;
  now?: number;
}): Promise<{
  feed: EmailFeedResponse;
  savedAt: number;
  kind: EmailFocusSnapshotKind;
} | null> {
  const cacheStorage =
    args.cacheStorage === undefined
      ? typeof caches === "undefined"
        ? null
        : caches
      : args.cacheStorage;
  if (!cacheStorage) return null;
  try {
    const cache = await cacheStorage.open(EMAIL_FOCUS_SNAPSHOT_CACHE);
    const response = await cache.match(emailFocusSnapshotUrl(args.scope));
    if (!response?.ok) return null;
    const savedAt = Number(response.headers.get(EMAIL_FOCUS_SNAPSHOT_AT_HEADER));
    const now = args.now ?? Date.now();
    if (
      !Number.isFinite(savedAt) ||
      savedAt > now + 60_000 ||
      Math.max(0, now - savedAt) > EMAIL_FOCUS_SNAPSHOT_MAX_AGE_MS
    ) {
      return null;
    }
    const payload: unknown = await response.json();
    return isEmailFeedResponse(payload, "focus")
      ? {
          feed: payload,
          savedAt,
          kind:
            response.headers.get(EMAIL_FOCUS_SNAPSHOT_KIND_HEADER) ===
            "notification"
              ? "notification"
              : "full",
        }
      : null;
  } catch {
    return null;
  }
}

export async function writeEmailBackgroundFocusSnapshot(args: {
  scope: string;
  feed: EmailFeedResponse;
  cacheStorage?: {
    open(name: string): Promise<Pick<Cache, "put">>;
  } | null;
  savedAt?: number;
  kind?: EmailFocusSnapshotKind;
}): Promise<boolean> {
  const cacheStorage =
    args.cacheStorage === undefined
      ? typeof caches === "undefined"
        ? null
        : caches
      : args.cacheStorage;
  if (!cacheStorage || !isEmailFeedResponse(args.feed, "focus")) return false;
  try {
    const savedAt = args.savedAt ?? Date.now();
    const cache = await cacheStorage.open(EMAIL_FOCUS_SNAPSHOT_CACHE);
    await cache.put(
      emailFocusSnapshotUrl(args.scope),
      new Response(JSON.stringify(args.feed), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          [EMAIL_FOCUS_SNAPSHOT_AT_HEADER]: String(savedAt),
          [EMAIL_FOCUS_SNAPSHOT_KIND_HEADER]: args.kind || "full",
        },
      }),
    );
    return true;
  } catch {
    return false;
  }
}
