export const CHAT_MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1_000;

type GroupableChatMessage = {
  channel_id: string;
  author_type: "user" | "orchestrator" | "agent" | "system";
  author_user_id: string | null;
  author_agent_id: string | null;
  profile_id: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
};

function authorKey(message: GroupableChatMessage): string | null {
  if (message.author_type === "user") {
    return message.author_user_id ? `user:${message.author_user_id}` : null;
  }
  if (message.author_type === "agent") {
    const metadataAgentId =
      typeof message.metadata?.agent_id === "string"
        ? message.metadata.agent_id
        : "";
    const metadataAgentName =
      typeof message.metadata?.agent_name === "string"
        ? message.metadata.agent_name
        : "";
    const identity =
      message.author_agent_id || metadataAgentId || metadataAgentName;
    return identity ? `agent:${identity}` : null;
  }
  if (message.author_type === "orchestrator") {
    return `orchestrator:${message.profile_id || "default"}`;
  }
  return null;
}

function isScheduledTaskResult(message: GroupableChatMessage): boolean {
  return message.metadata?.kind === "scheduled_task_result";
}

export function shouldGroupChatMessage(
  previous: GroupableChatMessage | null | undefined,
  current: GroupableChatMessage,
  windowMs = CHAT_MESSAGE_GROUP_WINDOW_MS,
): boolean {
  if (!previous || previous.channel_id !== current.channel_id) return false;
  // Scheduled results are separate channel events, even when the same Mind
  // also answered a human message within the normal grouping window.
  if (
    isScheduledTaskResult(previous) ||
    isScheduledTaskResult(current)
  ) {
    return false;
  }
  const previousAuthor = authorKey(previous);
  if (!previousAuthor || previousAuthor !== authorKey(current)) return false;

  const previousTime = Date.parse(previous.created_at);
  const currentTime = Date.parse(current.created_at);
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) {
    return false;
  }
  const elapsed = currentTime - previousTime;
  if (elapsed < 0 || elapsed > windowMs) return false;

  return (
    new Date(previousTime).toDateString() ===
    new Date(currentTime).toDateString()
  );
}
