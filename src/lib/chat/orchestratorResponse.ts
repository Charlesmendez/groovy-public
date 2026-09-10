type ChatRoundResult =
  | {
      kind: "final";
      text?: unknown;
      toolOutputText?: unknown;
      toolCallsExecuted?: unknown;
    }
  | {
      kind: "needs_connector" | "ui_open_code" | "browser_task";
    };

const CONNECTOR_RESPONSE_MESSAGE =
  "This channel turn could not be completed without a local connector.";

const SCHEDULE_MUTATION_TOOLS = new Set([
  "schedule_create",
  "schedule_update",
  "schedule_pause",
  "schedule_resume",
  "schedule_cancel_next",
  "schedule_delete",
]);

/**
 * Tell Team Chat clients when a completed Mind turn changed the channel's
 * schedule list. The flag is persisted on the assistant message so every
 * open client can invalidate its sidebar, not only the sender's device.
 */
export function chatRoundChangesScheduledTasks(
  result: ChatRoundResult,
): boolean {
  return (
    result.kind === "final" &&
    Array.isArray(result.toolCallsExecuted) &&
    result.toolCallsExecuted.some(
      (toolName) =>
        typeof toolName === "string" &&
        SCHEDULE_MUTATION_TOOLS.has(toolName),
    )
  );
}

function meaningfulText(value: unknown, depth = 0): string {
  if (depth > 5 || value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return meaningfulText(JSON.parse(trimmed), depth + 1) || trimmed;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => meaningfulText(entry, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  for (const key of [
    "response",
    "message",
    "answer",
    "text",
    "result",
    "error",
    "context",
    "data",
  ]) {
    const candidate = meaningfulText(record[key], depth + 1);
    if (candidate) return candidate;
  }
  return "";
}

/**
 * Resolve a human-readable channel response without converting an empty model
 * turn into a false success receipt such as "Done."
 */
export function resolveChatRoundText(result: ChatRoundResult): string {
  if (result.kind !== "final") return CONNECTOR_RESPONSE_MESSAGE;

  const assistantText = meaningfulText(result.text);
  if (assistantText) return assistantText;

  const toolText = meaningfulText(result.toolOutputText);
  if (toolText) return toolText;

  // An empty provider turn is an error, not a successful assistant message.
  // The route keeps the user's message, marks the run failed, and exposes the
  // Edit & resend recovery path instead of persisting a misleading reply.
  throw new Error("The orchestrator returned an empty final response.");
}
