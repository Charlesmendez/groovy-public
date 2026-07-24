import type { ModelMessage } from "ai";

function messageText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const candidate =
        part && typeof part === "object" && !Array.isArray(part)
          ? (part as Record<string, unknown>)
          : null;
      return candidate?.type === "text" && typeof candidate.text === "string"
        ? candidate.text.trim()
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Reconcile the current request with server-loaded durable history.
 *
 * Some callers persist the current user turn before invoking the orchestrator,
 * while others provide it only in memory. Only a caller entry that actually
 * matches the current request may replace the durable tail; otherwise an older
 * caller turn could overwrite the newly persisted message.
 */
export function reconcileCurrentUserMessage(args: {
  durableHistory: ModelMessage[];
  callerHistory: ModelMessage[];
  currentMessage: string;
  fallbackContent?: string;
}): ModelMessage[] {
  const currentMessage = args.currentMessage.trim();
  if (!currentMessage) return args.durableHistory;

  const callerCurrent = [...args.callerHistory]
    .reverse()
    .find(
      (entry) =>
        entry.role === "user" &&
        messageText(entry.content) === currentMessage,
    );
  const lastIndex = args.durableHistory.length - 1;
  const durableLast =
    lastIndex >= 0 ? args.durableHistory[lastIndex] : null;
  const durableAlreadyHasCurrent =
    durableLast?.role === "user" &&
    messageText(durableLast.content) === currentMessage;

  if (durableAlreadyHasCurrent) {
    if (!callerCurrent) return args.durableHistory;
    return args.durableHistory.map((entry, index) =>
      index === lastIndex ? callerCurrent : entry,
    );
  }

  return [
    ...args.durableHistory,
    callerCurrent || {
      role: "user",
      content: args.fallbackContent?.trim() || currentMessage,
    },
  ];
}
