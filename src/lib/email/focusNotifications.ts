import { routeEmailClassification } from "./routing";

export type EmailFocusArrival = {
  actionId: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  mailboxLabel: string;
  connectionId?: string;
  threadId?: string;
  messageId?: string;
};

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function focusArrivalFromAction(
  value: unknown,
): EmailFocusArrival | null {
  const row = record(value);
  const metadata = record(row.metadata);
  const actionId = text(row.id);
  const action = text(row.recommended_action);
  const status = text(row.status);
  const override = text(metadata.email_workspace_override_view);
  const route = routeEmailClassification({
    action,
    status,
    confidence: numberOrNull(row.confidence),
    override,
    critical: metadata.critical === true,
  });
  if (
    !actionId ||
    status !== "pending" ||
    route !== "focus" ||
    metadata.email_tracking_record === true ||
    metadata.auto_execute_planned === true ||
    metadata.email_workspace_unread === false ||
    text(metadata.email_workspace_user_action) ||
    override === "sent"
  ) {
    return null;
  }
  return {
    actionId,
    senderName: text(row.sender_name),
    senderEmail: text(row.sender_email),
    subject: text(row.subject) || "(no subject)",
    mailboxLabel: text(row.mailbox_label),
    connectionId: text(row.connection_id) || undefined,
    threadId: text(row.gmail_thread_id) || undefined,
    messageId: text(row.gmail_message_id) || undefined,
  };
}

export type EmailFocusPrefetchTarget = {
  connectionId: string;
  threadId: string;
  messageId?: string;
};

const EMAIL_FOCUS_PREFETCH_LIMIT = 3;

/** Conversations worth warming in the service worker before the user taps. */
export function emailFocusPrefetchTargets(
  arrivals: EmailFocusArrival[],
): EmailFocusPrefetchTarget[] {
  const targets: EmailFocusPrefetchTarget[] = [];
  const seen = new Set<string>();
  for (const arrival of arrivals) {
    if (!arrival.connectionId || !arrival.threadId) continue;
    const key = `${arrival.connectionId}:${arrival.threadId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      connectionId: arrival.connectionId,
      threadId: arrival.threadId,
      ...(arrival.messageId ? { messageId: arrival.messageId } : {}),
    });
    if (targets.length >= EMAIL_FOCUS_PREFETCH_LIMIT) break;
  }
  return targets;
}

export function emailFocusNotificationUrl(
  arrivals: EmailFocusArrival[],
): string {
  const first = arrivals[0];
  // A single arrival deep-links straight to the conversation so a
  // notification tap paints the message instead of the list.
  if (arrivals.length === 1 && first?.connectionId && first.threadId) {
    const params = new URLSearchParams({
      openConnectionId: first.connectionId,
      openThreadId: first.threadId,
    });
    if (first.messageId) params.set("openMessageId", first.messageId);
    return `/email?${params.toString()}`;
  }
  return "/email";
}

export function emailFocusNotificationCopy(arrivals: EmailFocusArrival[]): {
  title: string;
  body: string;
} {
  const first = arrivals[0];
  if (!first) return { title: "Focus is up to date", body: "" };
  const sender =
    first.senderName ||
    first.senderEmail ||
    first.mailboxLabel ||
    "New email";
  return {
    title:
      arrivals.length === 1
        ? `Focus · ${sender}`
        : `${arrivals.length} emails entered Focus`,
    body:
      arrivals.length === 1
        ? first.subject
        : arrivals
            .slice(0, 3)
            .map((arrival) => arrival.subject)
            .join(" · "),
  };
}
