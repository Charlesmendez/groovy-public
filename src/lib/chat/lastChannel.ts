const LAST_CHAT_CHANNEL_PREFIX = "groovy-chat-last-channel";

export type ChatChannelStorage = Pick<Storage, "getItem" | "setItem">;

export function lastChatChannelStorageKey(
  workspaceId: string,
  userId: string,
): string {
  return `${LAST_CHAT_CHANNEL_PREFIX}:${workspaceId}:${userId}`;
}

export function readLastChatChannel(
  storage: ChatChannelStorage,
  workspaceId: string,
  userId: string,
): string | null {
  if (!workspaceId || !userId) return null;
  try {
    return storage.getItem(lastChatChannelStorageKey(workspaceId, userId));
  } catch {
    return null;
  }
}

export function rememberLastChatChannel(
  storage: ChatChannelStorage,
  workspaceId: string,
  userId: string,
  channelId: string,
): void {
  if (!workspaceId || !userId || !channelId) return;
  try {
    storage.setItem(
      lastChatChannelStorageKey(workspaceId, userId),
      channelId,
    );
  } catch {
    // Chat remains usable when browser storage is unavailable.
  }
}

export function resolveLastChatChannel(
  channelIds: string[],
  currentChannelId: string | null,
  rememberedChannelId: string | null,
): string | null {
  if (currentChannelId && channelIds.includes(currentChannelId)) {
    return currentChannelId;
  }
  if (rememberedChannelId && channelIds.includes(rememberedChannelId)) {
    return rememberedChannelId;
  }
  return channelIds[0] || null;
}
