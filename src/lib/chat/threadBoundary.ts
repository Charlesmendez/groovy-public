export type ThreadBoundaryMessage = {
  id: string;
  thread_root_message_id?: string | null;
};

export function threadRootId(
  message: ThreadBoundaryMessage,
): string {
  return message.thread_root_message_id || message.id;
}

export function messageBelongsToThread(
  message: ThreadBoundaryMessage,
  rootId: string,
): boolean {
  return message.id === rootId || message.thread_root_message_id === rootId;
}

export function threadReplyCounts(
  messages: ThreadBoundaryMessage[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (!message.thread_root_message_id) continue;
    counts.set(
      message.thread_root_message_id,
      (counts.get(message.thread_root_message_id) || 0) + 1,
    );
  }
  return counts;
}
