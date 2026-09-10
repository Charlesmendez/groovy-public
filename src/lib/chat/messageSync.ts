export type ChatMessageSyncCursor = {
  id: string;
  createdAt: string;
};

type SyncableChatMessage = {
  id: string;
  created_at: string;
  thread_root_message_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function parseChatMessageSyncCursor(
  id: unknown,
  createdAt: unknown,
): ChatMessageSyncCursor | null {
  if (
    !isUuid(id) ||
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    return null;
  }
  return { id, createdAt };
}

export function latestPersistedChatMessageCursor(
  messages: readonly SyncableChatMessage[],
  threadRootId: string | null = null,
): ChatMessageSyncCursor | null {
  let latest: ChatMessageSyncCursor | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    if ((message.thread_root_message_id || null) !== threadRootId) continue;
    if (message.metadata?.client_pending === true) continue;
    const candidate = parseChatMessageSyncCursor(message.id, message.created_at);
    if (!candidate) continue;
    const candidateTimestamp = Date.parse(candidate.createdAt);
    if (
      !latest ||
      candidateTimestamp > latestTimestamp ||
      (candidateTimestamp === latestTimestamp && candidate.id > latest.id)
    ) {
      latest = candidate;
      latestTimestamp = candidateTimestamp;
    }
  }
  return latest;
}

export function chatMessageSyncCursorMatches(
  left: ChatMessageSyncCursor | null,
  right: ChatMessageSyncCursor | null,
): boolean {
  return Boolean(
    left &&
      right &&
      left.id === right.id &&
      left.createdAt === right.createdAt,
  );
}
