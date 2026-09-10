import {
  readEmailFeedCache,
  writeEmailFeedCache,
  type EmailFeedCacheEntry,
  type EmailFeedCacheStorage,
} from "@/lib/email/feedCache";
import type { EmailView } from "@/lib/email/types";

// A standalone iOS app can lose its WebKit process and session storage while
// suspended. Keep one recoverable screen long enough for a normal next-day
// return, then revalidate it quietly as soon as the app becomes active.
export const EMAIL_NAVIGATION_FEED_MAX_AGE_MS = 24 * 60 * 60_000;

type NavigationFeedSnapshot = EmailFeedCacheEntry & {
  capturedAt: number;
};

const navigationFeeds = new Map<string, NavigationFeedSnapshot>();
const navigationLocations = new Map<
  string,
  { view: EmailView; connectionId: string | null; capturedAt: number }
>();
const EMAIL_NAVIGATION_LOCATION_VERSION = 1;
const EMAIL_NAVIGATION_LOCATION_PREFIX =
  `groovy.email.navigation.v${EMAIL_NAVIGATION_LOCATION_VERSION}:`;
const EMAIL_VIEWS = new Set<EmailView>([
  "focus",
  "inbox",
  "sent",
  "noise",
  "handled",
  "all",
]);

type StoredNavigationLocation = {
  version: number;
  scope: string;
  view: EmailView;
  connectionId: string | null;
  capturedAt: number;
};

export function shouldPersistEmailNavigationAcrossLaunches(args: {
  standaloneDisplayMode: boolean;
  navigatorStandalone: boolean;
}): boolean {
  return args.standaloneDisplayMode || args.navigatorStandalone;
}

export function shouldRefreshRestoredEmailNavigation(args: {
  cachedSavedAt: number | null;
  attentionCount: number;
  now: number;
  refreshCooldownMs: number;
}): boolean {
  // This snapshot is local to one browser or installed app. Its age cannot
  // prove that another device did not move a conversation in the meantime.
  // Paint it immediately for a fast launch, but always revalidate it quietly.
  void args;
  return true;
}

function browserNavigationStorage(): EmailFeedCacheStorage | null {
  if (typeof window === "undefined") return null;
  try {
    const persistent = shouldPersistEmailNavigationAcrossLaunches({
      standaloneDisplayMode: window.matchMedia(
        "(display-mode: standalone)",
      ).matches,
      navigatorStandalone: Boolean(
        (window.navigator as Navigator & { standalone?: boolean })
          .standalone,
      ),
    });
    return persistent ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function navigationLocationKey(scope: string): string {
  return `${EMAIL_NAVIGATION_LOCATION_PREFIX}${encodeURIComponent(scope)}`;
}

function selectedStorage(
  storage: EmailFeedCacheStorage | null | undefined,
): EmailFeedCacheStorage | null {
  return storage === undefined ? browserNavigationStorage() : storage;
}

function removeStoredNavigationLocation(
  scope: string,
  storage: EmailFeedCacheStorage | null,
): void {
  try {
    storage?.removeItem(navigationLocationKey(scope));
  } catch {
    // This is a short-lived performance snapshot, never authoritative state.
  }
}

function readStoredNavigationLocation(args: {
  scope: string;
  now: number;
  storage: EmailFeedCacheStorage | null;
}): StoredNavigationLocation | null {
  let raw: string | null = null;
  try {
    raw = args.storage?.getItem(navigationLocationKey(args.scope)) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredNavigationLocation>;
    const usable =
      value.version === EMAIL_NAVIGATION_LOCATION_VERSION &&
      value.scope === args.scope &&
      typeof value.view === "string" &&
      EMAIL_VIEWS.has(value.view as EmailView) &&
      (value.connectionId === null ||
        typeof value.connectionId === "string") &&
      typeof value.capturedAt === "number" &&
      Number.isFinite(value.capturedAt) &&
      Math.max(0, args.now - value.capturedAt) <=
        EMAIL_NAVIGATION_FEED_MAX_AGE_MS;
    if (!usable) {
      removeStoredNavigationLocation(args.scope, args.storage);
      return null;
    }
    return value as StoredNavigationLocation;
  } catch {
    removeStoredNavigationLocation(args.scope, args.storage);
    return null;
  }
}

function navigationFeedKey(
  scope: string,
  view: EmailView,
  connectionId: string | null,
): string {
  return `${scope}:${view}:${connectionId || "all"}`;
}

export function rememberEmailNavigationFeed(args: {
  scope: string;
  view: EmailView;
  connectionId: string | null;
  entry: EmailFeedCacheEntry;
  capturedAt?: number;
  storage?: EmailFeedCacheStorage | null;
}): void {
  const capturedAt = args.capturedAt ?? Date.now();
  navigationFeeds.set(
    navigationFeedKey(args.scope, args.view, args.connectionId),
    {
      ...args.entry,
      capturedAt,
    },
  );
  navigationLocations.set(args.scope, {
    view: args.view,
    connectionId: args.connectionId,
    capturedAt,
  });
  const storage = selectedStorage(args.storage);
  try {
    storage?.setItem(
      navigationLocationKey(args.scope),
      JSON.stringify({
        version: EMAIL_NAVIGATION_LOCATION_VERSION,
        scope: args.scope,
        view: args.view,
        connectionId: args.connectionId,
        capturedAt,
      } satisfies StoredNavigationLocation),
    );
  } catch {
    // In-memory navigation remains available when storage is restricted.
  }
  writeEmailFeedCache(
    args.scope,
    args.view,
    args.connectionId,
    args.entry,
    { storage },
  );
}

export function readEmailNavigationLocation(args: {
  scope: string;
  now?: number;
  storage?: EmailFeedCacheStorage | null;
}): { view: EmailView; connectionId: string | null } | null {
  const now = args.now ?? Date.now();
  const storage = selectedStorage(args.storage);
  const location = navigationLocations.get(args.scope);
  if (location) {
    const age = Math.max(0, now - location.capturedAt);
    if (age <= EMAIL_NAVIGATION_FEED_MAX_AGE_MS) {
      return { view: location.view, connectionId: location.connectionId };
    }
    navigationLocations.delete(args.scope);
  }
  const stored = readStoredNavigationLocation({
    scope: args.scope,
    now,
    storage,
  });
  if (!stored) return null;
  navigationLocations.set(args.scope, {
    view: stored.view,
    connectionId: stored.connectionId,
    capturedAt: stored.capturedAt,
  });
  return { view: stored.view, connectionId: stored.connectionId };
}

export function readEmailNavigationFeed(args: {
  scope: string;
  view: EmailView;
  connectionId: string | null;
  now?: number;
  storage?: EmailFeedCacheStorage | null;
}): EmailFeedCacheEntry | null {
  const now = args.now ?? Date.now();
  const storage = selectedStorage(args.storage);
  const key = navigationFeedKey(
    args.scope,
    args.view,
    args.connectionId,
  );
  const snapshot = navigationFeeds.get(key);
  if (snapshot) {
    const age = Math.max(0, now - snapshot.capturedAt);
    if (age <= EMAIL_NAVIGATION_FEED_MAX_AGE_MS) {
      return {
        feed: snapshot.feed,
        limit: snapshot.limit,
        savedAt: snapshot.savedAt,
        ...(snapshot.revision !== undefined
          ? { revision: snapshot.revision }
          : {}),
      };
    }
    navigationFeeds.delete(key);
  }
  const location = readEmailNavigationLocation({
    scope: args.scope,
    now,
    storage,
  });
  if (
    !location ||
    location.view !== args.view ||
    location.connectionId !== args.connectionId
  ) {
    return null;
  }
  return readEmailFeedCache(args.scope, args.view, args.connectionId, {
    now,
    storage,
    maxAgeMs: EMAIL_NAVIGATION_FEED_MAX_AGE_MS,
  });
}

export function clearEmailNavigationFeedsForTest(): void {
  navigationFeeds.clear();
  navigationLocations.clear();
}
