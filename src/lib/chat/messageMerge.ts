export type MergeableChatMessage = {
  id: string;
  created_at: string;
  metadata?: Record<string, unknown> | null;
};

export function chatClientMessageId(
  message: MergeableChatMessage,
): string | null {
  const value = message.metadata?.client_message_id;
  return typeof value === "string" && value ? value : null;
}

export function isPendingChatMessage(
  message: MergeableChatMessage,
): boolean {
  return message.metadata?.client_pending === true;
}

export function mergeChatMessages<T extends MergeableChatMessage>(
  current: T[],
  incoming: T[],
): T[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const clientMessageId = chatClientMessageId(message);
    if (clientMessageId) {
      for (const [existingId, existing] of byId) {
        if (
          existingId !== message.id &&
          isPendingChatMessage(existing) &&
          chatClientMessageId(existing) === clientMessageId
        ) {
          byId.delete(existingId);
        }
      }
    }
    byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

export function reconcileChatMessages<T extends MergeableChatMessage>(
  current: T[],
  authoritative: T[],
): T[] {
  const authoritativeClientIds = new Set(
    authoritative
      .map(chatClientMessageId)
      .filter((value): value is string => Boolean(value)),
  );
  const unconfirmed = current.filter((message) => {
    if (!isPendingChatMessage(message)) return false;
    const clientMessageId = chatClientMessageId(message);
    return !clientMessageId || !authoritativeClientIds.has(clientMessageId);
  });
  return mergeChatMessages(authoritative, unconfirmed);
}
