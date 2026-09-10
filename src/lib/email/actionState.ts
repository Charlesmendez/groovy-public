export type EmailWorkspaceActionOperation =
  | "archive"
  | "spam"
  | "restore"
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "move_focus"
  | "move_inbox"
  | "move_noise"
  | "move_handled";

function normalized(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseEmailWorkspaceActionOperation(
  value: unknown,
): EmailWorkspaceActionOperation | null {
  return value === "archive" ||
    value === "spam" ||
    value === "restore" ||
    value === "read" ||
    value === "unread" ||
    value === "star" ||
    value === "unstar" ||
    value === "move_focus" ||
    value === "move_inbox" ||
    value === "move_noise" ||
    value === "move_handled"
    ? value
    : null;
}

export function createsEmailWorkspaceAction(
  operation: EmailWorkspaceActionOperation,
): boolean {
  return (
    operation === "archive" ||
    operation === "spam" ||
    operation === "move_focus" ||
    operation === "move_noise" ||
    operation === "move_handled"
  );
}

export function emailWorkspaceActionUsesGroovyLabels(
  operation: EmailWorkspaceActionOperation,
): boolean {
  return (
    createsEmailWorkspaceAction(operation) ||
    operation === "restore" ||
    operation === "move_inbox"
  );
}

/**
 * Feed cards represent whole Gmail conversations. Placement and unread
 * operations therefore apply to the thread; only Gmail's message-specific
 * star state remains scoped to the displayed message.
 */
export function emailWorkspaceActionAppliesToThread(
  operation: EmailWorkspaceActionOperation,
): boolean {
  return operation !== "star" && operation !== "unstar";
}

export function completedEmailWorkspaceAction(
  operation: EmailWorkspaceActionOperation,
): boolean {
  return (
    operation === "archive" ||
    operation === "spam" ||
    operation === "move_noise" ||
    operation === "move_handled"
  );
}

export function emailWorkspaceOverrideForOperation(
  operation: EmailWorkspaceActionOperation,
): "focus" | "inbox" | "noise" | "handled" | null {
  if (operation === "archive" || operation === "move_handled") {
    return "handled";
  }
  if (operation === "spam" || operation === "move_noise") return "noise";
  if (operation === "restore" || operation === "move_inbox") return "inbox";
  if (operation === "move_focus") return "focus";
  return null;
}

export function emailActionBelongsToConversation(args: {
  storedThreadId?: string | null;
  storedMessageId?: string | null;
  requestedThreadId?: string | null;
  requestedMessageId?: string | null;
}): boolean {
  const storedThreadId = normalized(args.storedThreadId);
  const storedMessageId = normalized(args.storedMessageId);
  const requestedThreadId = normalized(args.requestedThreadId);
  const requestedMessageId = normalized(args.requestedMessageId);

  if (storedThreadId) {
    return Boolean(requestedThreadId) && storedThreadId === requestedThreadId;
  }
  return (
    !storedMessageId ||
    !requestedMessageId ||
    storedMessageId === requestedMessageId
  );
}
