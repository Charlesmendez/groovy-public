type ChatRoundResult =
  | {
      kind: "final";
      text?: unknown;
      toolOutputText?: unknown;
    }
  | {
      kind: "needs_connector" | "ui_open_code" | "browser_task";
    };

const EMPTY_RESPONSE_MESSAGE =
  "Groovy could not produce a response for this turn. Please try again.";
const CONNECTOR_RESPONSE_MESSAGE =
  "This channel turn could not be completed without a local connector.";

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
  return toolText || EMPTY_RESPONSE_MESSAGE;
}
