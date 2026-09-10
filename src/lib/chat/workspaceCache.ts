// Chat previously kept nothing client-side, so every launch waited on
// /api/chat/channels (a deep server waterfall) before painting anything.
// These caches let the workspace and the last conversations paint instantly
// from localStorage while the live refresh runs in the background.

export const CHAT_WORKSPACE_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

const CHAT_WORKSPACE_CACHE_PREFIX = "groovy.chat.workspace.v1:";
const CHAT_MESSAGES_CACHE_PREFIX = "groovy.chat.messages.v1:";
const CHAT_COMPOSER_DRAFTS_PREFIX = "groovy.chat.composer-drafts.v1:";
const CHAT_CACHE_USER_KEY = "groovy.chat.cache-user.v1";
const MAX_CACHED_MESSAGE_CHANNELS = 6;
const MAX_CACHED_MESSAGES = 50;

export type ChatCacheStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

export type ChatWorkspaceCacheEntry = {
  channelsPayload: Record<string, unknown>;
  profilesPayload: Record<string, unknown>;
  savedAt: number;
};

type StoredWorkspaceCache = ChatWorkspaceCacheEntry & {
  userId: string;
};

type StoredMessagesCache = {
  userId: string;
  channelId: string;
  savedAt: number;
  messages: Array<Record<string, unknown>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function workspaceKey(userId: string): string {
  return `${CHAT_WORKSPACE_CACHE_PREFIX}${encodeURIComponent(userId)}`;
}

function messagesKey(userId: string, channelId: string): string {
  return `${CHAT_MESSAGES_CACHE_PREFIX}${encodeURIComponent(
    userId,
  )}:${encodeURIComponent(channelId)}`;
}

function composerDraftsKey(userId: string): string {
  return `${CHAT_COMPOSER_DRAFTS_PREFIX}${encodeURIComponent(userId)}`;
}

function browserLocalStorage(): ChatCacheStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function freshEnough(savedAt: unknown, now: number): boolean {
  return (
    typeof savedAt === "number" &&
    Number.isFinite(savedAt) &&
    Math.max(0, now - savedAt) <= CHAT_WORKSPACE_CACHE_MAX_AGE_MS
  );
}

/**
 * The account the caches belong to, recorded so a cold open can read them
 * synchronously. Resolving the id through Supabase first would be correct but
 * slow: getSession() refreshes tokens over the network, which is exactly the
 * wait the cache exists to avoid.
 */
export function readChatCacheUserId(
  storage: ChatCacheStorage | null = browserLocalStorage(),
): string {
  if (!storage) return "";
  try {
    return storage.getItem(CHAT_CACHE_USER_KEY) || "";
  } catch {
    return "";
  }
}

export function rememberChatCacheUserId(
  userId: string,
  storage: ChatCacheStorage | null = browserLocalStorage(),
): void {
  if (!storage || !userId) return;
  try {
    storage.setItem(CHAT_CACHE_USER_KEY, userId);
  } catch {
    // The network path still works without the hint.
  }
}

export function readChatWorkspaceCache(
  userId: string,
  options: { now?: number; storage?: ChatCacheStorage | null } = {},
): ChatWorkspaceCacheEntry | null {
  const storage = options.storage ?? browserLocalStorage();
  if (!storage || !userId) return null;
  const now = options.now ?? Date.now();
  let raw: string | null = null;
  try {
    raw = storage.getItem(workspaceKey(userId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredWorkspaceCache>;
    if (
      !isRecord(parsed) ||
      parsed.userId !== userId ||
      !freshEnough(parsed.savedAt, now) ||
      !isRecord(parsed.channelsPayload) ||
      !isRecord(parsed.profilesPayload)
    ) {
      return null;
    }
    return {
      channelsPayload: parsed.channelsPayload,
      profilesPayload: parsed.profilesPayload,
      savedAt: Number(parsed.savedAt),
    };
  } catch {
    return null;
  }
}

export function writeChatWorkspaceCache(
  userId: string,
  entry: Omit<ChatWorkspaceCacheEntry, "savedAt"> & { savedAt?: number },
  options: { storage?: ChatCacheStorage | null } = {},
): void {
  const storage = options.storage ?? browserLocalStorage();
  if (!storage || !userId) return;
  const stored: StoredWorkspaceCache = {
    userId,
    channelsPayload: entry.channelsPayload,
    profilesPayload: entry.profilesPayload,
    savedAt: entry.savedAt ?? Date.now(),
  };
  const serialized = JSON.stringify(stored);
  try {
    storage.setItem(workspaceKey(userId), serialized);
  } catch {
    // Make room by dropping message snapshots, which are recoverable.
    clearChatMessageCaches(storage);
    try {
      storage.setItem(workspaceKey(userId), serialized);
    } catch {
      // Chat still works from the network when storage is unavailable.
    }
  }
}

export function readChatChannelMessages(
  userId: string,
  channelId: string,
  options: { now?: number; storage?: ChatCacheStorage | null } = {},
): Array<Record<string, unknown>> | null {
  const storage = options.storage ?? browserLocalStorage();
  if (!storage || !userId || !channelId) return null;
  const now = options.now ?? Date.now();
  let raw: string | null = null;
  try {
    raw = storage.getItem(messagesKey(userId, channelId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredMessagesCache>;
    if (
      !isRecord(parsed) ||
      parsed.userId !== userId ||
      parsed.channelId !== channelId ||
      !freshEnough(parsed.savedAt, now) ||
      !Array.isArray(parsed.messages) ||
      !parsed.messages.every(
        (message) => isRecord(message) && typeof message.id === "string",
      )
    ) {
      return null;
    }
    return parsed.messages as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
}

export function writeChatChannelMessages(
  userId: string,
  channelId: string,
  messages: ReadonlyArray<unknown>,
  options: { now?: number; storage?: ChatCacheStorage | null } = {},
): void {
  const storage = options.storage ?? browserLocalStorage();
  if (!storage || !userId || !channelId) return;
  const now = options.now ?? Date.now();
  const stored: StoredMessagesCache = {
    userId,
    channelId,
    savedAt: now,
    messages: messages
      .filter(isRecord)
      .slice(-MAX_CACHED_MESSAGES) as Array<Record<string, unknown>>,
  };
  const serialized = JSON.stringify(stored);
  const write = () => storage.setItem(messagesKey(userId, channelId), serialized);
  try {
    write();
  } catch {
    clearChatMessageCaches(storage);
    try {
      write();
    } catch {
      return;
    }
  }
  pruneChatMessageCaches(userId, { now, storage });
}

/** Restores text-only composer drafts keyed by channel for one account. */
export function readChatComposerDrafts(
  userId: string,
  storage: ChatCacheStorage | null = browserLocalStorage(),
): Record<string, string> {
  if (!storage || !userId) return {};
  try {
    const parsed = JSON.parse(
      storage.getItem(composerDraftsKey(userId)) || "",
    ) as { userId?: unknown; drafts?: unknown };
    if (parsed.userId !== userId || !isRecord(parsed.drafts)) return {};
    return Object.fromEntries(
      Object.entries(parsed.drafts).filter(
        (entry): entry is [string, string] =>
          Boolean(entry[0]) && typeof entry[1] === "string" && entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

/** Persists or clears a text draft without exposing it to another account. */
export function writeChatComposerDraft(
  userId: string,
  channelId: string,
  draft: string,
  storage: ChatCacheStorage | null = browserLocalStorage(),
): void {
  if (!storage || !userId || !channelId) return;
  const drafts = readChatComposerDrafts(userId, storage);
  if (draft) drafts[channelId] = draft;
  else delete drafts[channelId];
  const key = composerDraftsKey(userId);
  try {
    if (Object.keys(drafts).length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ userId, drafts }));
  } catch {
    // The in-memory composer remains available when storage is unavailable.
  }
}

/** Removes every cached chat workspace/message snapshot for every user.
 * Called on sign-out so conversation content never outlives the session on
 * shared machines. */
export function clearChatWorkspaceCaches(
  storage: ChatCacheStorage | null = browserLocalStorage(),
): void {
  if (!storage) return;
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key?.startsWith(CHAT_WORKSPACE_CACHE_PREFIX) ||
        key?.startsWith(CHAT_MESSAGES_CACHE_PREFIX) ||
        key?.startsWith(CHAT_COMPOSER_DRAFTS_PREFIX)
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) storage.removeItem(key);
    storage.removeItem(CHAT_CACHE_USER_KEY);
  } catch {
    // Clearing a recoverable cache is best-effort.
  }
}

function listMessageCacheKeys(storage: ChatCacheStorage): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(CHAT_MESSAGES_CACHE_PREFIX)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

function clearChatMessageCaches(storage: ChatCacheStorage): void {
  for (const key of listMessageCacheKeys(storage)) {
    try {
      storage.removeItem(key);
    } catch {
      // Best effort; quota pressure only.
    }
  }
}

function pruneChatMessageCaches(
  userId: string,
  options: { now: number; storage: ChatCacheStorage },
): void {
  const { storage, now } = options;
  const prefix = `${CHAT_MESSAGES_CACHE_PREFIX}${encodeURIComponent(userId)}:`;
  const entries: Array<{ key: string; savedAt: number }> = [];
  for (const key of listMessageCacheKeys(storage)) {
    if (!key.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(storage.getItem(key) || "") as {
        savedAt?: unknown;
      };
      const savedAt =
        typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt)
          ? parsed.savedAt
          : 0;
      if (!freshEnough(savedAt, now)) {
        storage.removeItem(key);
        continue;
      }
      entries.push({ key, savedAt });
    } catch {
      try {
        storage.removeItem(key);
      } catch {
        // Ignore unreadable entries.
      }
    }
  }
  entries.sort((left, right) => right.savedAt - left.savedAt);
  for (const entry of entries.slice(MAX_CACHED_MESSAGE_CHANNELS)) {
    try {
      storage.removeItem(entry.key);
    } catch {
      // Best effort.
    }
  }
}
