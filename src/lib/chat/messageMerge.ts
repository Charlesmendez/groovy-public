export type MergeableChatMessage = {
  id: string;
  created_at: string;
  content?: string;
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

export function chatMessageDeliveryConfirmed(
  messages: MergeableChatMessage[],
  attempt: {
    clientMessageId: string;
    resendMessageId?: string | null;
    content: string;
  },
): boolean {
  return messages.some((message) =>
    attempt.resendMessageId
      ? message.id === attempt.resendMessageId &&
        message.content === attempt.content
      : chatClientMessageId(message) === attempt.clientMessageId,
  );
}

function chatMessageVersion(message: MergeableChatMessage): number {
  const candidates = [
    message.metadata?.edited_at,
    message.metadata?.deleted_at,
  ];
  let version = 0;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const timestamp = Date.parse(candidate);
    if (Number.isFinite(timestamp)) version = Math.max(version, timestamp);
  }
  return version;
}

function prefersExistingMessage(
  existing: MergeableChatMessage,
  incoming: MergeableChatMessage,
): boolean {
  const existingVersion = chatMessageVersion(existing);
  const incomingVersion = chatMessageVersion(incoming);
  // An edit is applied optimistically to the existing server row. A refresh
  // that started before the PATCH can return that row without the edit marker.
  // Keep the newer local copy until the PATCH response or Realtime update
  // supplies an equal or newer version.
  return existingVersion > incomingVersion;
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
    const existing = byId.get(message.id);
    if (existing && prefersExistingMessage(existing, message)) {
      continue;
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
  const authoritativeById = new Map(
    authoritative.map((message) => [message.id, message]),
  );
  const authoritativeClientIds = new Set(
    authoritative
      .map(chatClientMessageId)
      .filter((value): value is string => Boolean(value)),
  );
  const locallyNewer = current.filter((message) => {
    const authoritativeMessage = authoritativeById.get(message.id);
    if (
      authoritativeMessage &&
      prefersExistingMessage(message, authoritativeMessage)
    ) {
      return true;
    }
    if (!isPendingChatMessage(message)) return false;
    const clientMessageId = chatClientMessageId(message);
    return !clientMessageId || !authoritativeClientIds.has(clientMessageId);
  });
  return mergeChatMessages(authoritative, locallyNewer);
}

export function reconcileChatMessagesAfterRequest<
  T extends MergeableChatMessage,
>(
  current: T[],
  authoritative: T[],
  requestSnapshotIds: ReadonlySet<string>,
): T[] {
  const arrivedDuringRequest = current.filter(
    (message) => !requestSnapshotIds.has(message.id),
  );
  return mergeChatMessages(
    reconcileChatMessages(current, authoritative),
    arrivedDuringRequest,
  );
}

export function reconcileLatestChatMessageWindow<
  T extends MergeableChatMessage & {
    thread_root_message_id?: string | null;
  },
>(
  current: T[],
  authoritative: T[],
  { hasOlder }: { hasOlder: boolean },
): T[] {
  const authoritativeIds = new Set(
    authoritative.map((message) => message.id),
  );
  const oldest = authoritative[0] || null;
  const oldestTimestamp = oldest ? Date.parse(oldest.created_at) : null;
  const preserved = current.filter((message) => {
    if (message.thread_root_message_id || isPendingChatMessage(message)) {
      return true;
    }
    if (authoritativeIds.has(message.id)) return true;
    if (
      !hasOlder ||
      !oldest ||
      oldestTimestamp === null ||
      !Number.isFinite(oldestTimestamp)
    ) {
      return false;
    }
    const timestamp = Date.parse(message.created_at);
    const beforeWindow =
      timestamp < oldestTimestamp ||
      (timestamp === oldestTimestamp && message.id < oldest.id);
    return beforeWindow;
  });
  return mergeChatMessages(preserved, authoritative);
}
