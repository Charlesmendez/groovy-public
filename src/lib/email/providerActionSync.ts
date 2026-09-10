import {
  ensureGroovyGmailLabels,
  fetchGmailThreadItems,
  GROOVY_EMAIL_LABELS,
  modifyGmailMessageLabels,
  modifyGmailMessagesLabels,
  modifyGmailThreadLabels,
  type EmailMailboxConnection,
  type GmailThreadListItem,
} from "@/lib/email/gmail";
import {
  emailWorkspaceActionAppliesToThread,
  emailWorkspaceActionUsesGroovyLabels,
  emailWorkspaceOverrideForOperation,
  parseEmailWorkspaceActionOperation,
  type EmailWorkspaceActionOperation,
} from "@/lib/email/actionState";

type RecordLike = Record<string, unknown>;

export const EMAIL_PROVIDER_SYNC_STATUS_KEY =
  "email_workspace_provider_sync_status";
export const EMAIL_PROVIDER_SYNC_OPERATION_KEY =
  "email_workspace_provider_sync_operation";
export const EMAIL_PROVIDER_SYNC_REQUEST_ID_KEY =
  "email_workspace_provider_sync_request_id";
export const EMAIL_PROVIDER_SYNC_REQUESTED_AT_KEY =
  "email_workspace_provider_sync_requested_at";

export type EmailProviderSyncStatus =
  | "pending"
  | "synced"
  | "superseded";

export type EmailProviderActionIntent = {
  actionId: string;
  connectionId: string;
  threadId: string;
  messageId: string;
  operation: EmailWorkspaceActionOperation;
  requestId: string;
  requestedAt: string;
  requestedTimestamp: number;
  status: EmailProviderSyncStatus;
};

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timestamp(value: unknown): number {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function emailWorkspaceActionNeedsDurableProviderSync(
  operation: EmailWorkspaceActionOperation,
): boolean {
  return emailWorkspaceOverrideForOperation(operation) !== null;
}

export function emailProviderSyncMetadata(args: {
  operation: EmailWorkspaceActionOperation;
  requestId: string;
  requestedAt: string;
  status: EmailProviderSyncStatus;
  attemptedAt?: string | null;
  syncedAt?: string | null;
  lastError?: string | null;
  retryAfterMs?: number | null;
}): Record<string, unknown> {
  return {
    [EMAIL_PROVIDER_SYNC_STATUS_KEY]: args.status,
    [EMAIL_PROVIDER_SYNC_OPERATION_KEY]: args.operation,
    [EMAIL_PROVIDER_SYNC_REQUEST_ID_KEY]: args.requestId,
    [EMAIL_PROVIDER_SYNC_REQUESTED_AT_KEY]: args.requestedAt,
    email_workspace_provider_sync_last_attempt_at:
      args.attemptedAt || null,
    email_workspace_provider_synced_at: args.syncedAt || null,
    email_workspace_provider_sync_last_error: args.lastError || null,
    email_workspace_provider_sync_retry_after_ms:
      typeof args.retryAfterMs === "number" &&
      Number.isFinite(args.retryAfterMs)
        ? Math.max(0, Math.floor(args.retryAfterMs))
        : null,
  };
}

export function emailProviderActionIntentFromRow(
  value: unknown,
): EmailProviderActionIntent | null {
  const row = record(value);
  const metadata = record(row.metadata);
  const operation = parseEmailWorkspaceActionOperation(
    metadata[EMAIL_PROVIDER_SYNC_OPERATION_KEY],
  );
  const status = text(metadata[EMAIL_PROVIDER_SYNC_STATUS_KEY]);
  const actionId = text(row.id);
  const connectionId = text(row.connection_id);
  const threadId = text(row.gmail_thread_id);
  const messageId = text(row.gmail_message_id);
  const requestId = text(metadata[EMAIL_PROVIDER_SYNC_REQUEST_ID_KEY]);
  const requestedAt =
    text(metadata[EMAIL_PROVIDER_SYNC_REQUESTED_AT_KEY]) ||
    text(metadata.email_workspace_corrected_at) ||
    text(row.updated_at);
  if (
    !operation ||
    !emailWorkspaceActionNeedsDurableProviderSync(operation) ||
    (status !== "pending" &&
      status !== "synced" &&
      status !== "superseded") ||
    !actionId ||
    !connectionId ||
    !threadId ||
    !requestedAt
  ) {
    return null;
  }
  return {
    actionId,
    connectionId,
    threadId,
    messageId,
    operation,
    requestId,
    requestedAt,
    requestedTimestamp: timestamp(requestedAt),
    status,
  };
}

export function latestEmailProviderActionIntent(
  rows: readonly unknown[],
): EmailProviderActionIntent | null {
  return rows
    .map(emailProviderActionIntentFromRow)
    .filter((value): value is EmailProviderActionIntent => value !== null)
    .sort(
      (left, right) =>
        right.requestedTimestamp - left.requestedTimestamp ||
        right.actionId.localeCompare(left.actionId),
    )[0] || null;
}

export function gmailLabelChangeForEmailWorkspaceOperation(args: {
  operation: EmailWorkspaceActionOperation;
  labels?: Record<string, string>;
}): { addLabelIds: string[]; removeLabelIds: string[] } {
  const labels = args.labels || {};
  const processed = labels[GROOVY_EMAIL_LABELS.processed] || "";
  const spam = labels[GROOVY_EMAIL_LABELS.spam] || "";
  const add: string[] = [];
  const remove: string[] = [];
  if (args.operation === "archive" || args.operation === "move_handled") {
    remove.push("INBOX", "SPAM", "TRASH", spam);
    add.push(processed);
  } else if (
    args.operation === "spam" ||
    args.operation === "move_noise"
  ) {
    remove.push("INBOX", processed);
    add.push("SPAM", spam);
  } else if (
    args.operation === "restore" ||
    args.operation === "move_inbox" ||
    args.operation === "move_focus"
  ) {
    add.push("INBOX");
    remove.push("SPAM", "TRASH", spam, processed);
  } else if (args.operation === "read") {
    remove.push("UNREAD");
  } else if (args.operation === "unread") {
    add.push("UNREAD");
  } else if (args.operation === "star") {
    add.push("STARRED");
  } else if (args.operation === "unstar") {
    remove.push("STARRED");
  }
  return {
    addLabelIds: add.filter(Boolean),
    removeLabelIds: remove.filter(Boolean),
  };
}

export function gmailMessageIdsAtOrBefore(args: {
  items: readonly GmailThreadListItem[];
  cutoff: string;
  fallbackMessageId?: string | null;
}): string[] {
  const cutoff = Date.parse(args.cutoff);
  const ids = Number.isFinite(cutoff)
    ? args.items
        .filter((item) => {
          const receivedAt = Date.parse(item.internalDate || item.date);
          return Number.isFinite(receivedAt) && receivedAt <= cutoff;
        })
        .map((item) => item.id.trim())
        .filter(Boolean)
    : [];
  const fallback = text(args.fallbackMessageId);
  return Array.from(new Set(ids.length > 0 ? ids : fallback ? [fallback] : []));
}

export async function syncEmailWorkspaceProviderAction(args: {
  mailbox: EmailMailboxConnection;
  operation: EmailWorkspaceActionOperation;
  threadId: string;
  messageId?: string | null;
  requestedAt?: string | null;
  priority?: "interactive";
}): Promise<void> {
  const labels = emailWorkspaceActionUsesGroovyLabels(args.operation)
    ? await ensureGroovyGmailLabels({
        mailbox: args.mailbox,
        requiredLabels: [
          GROOVY_EMAIL_LABELS.processed,
          GROOVY_EMAIL_LABELS.spam,
        ],
        priority: args.priority,
      })
    : {};
  if (
    (args.operation === "archive" || args.operation === "move_handled") &&
    !labels[GROOVY_EMAIL_LABELS.processed]
  ) {
    throw new Error(
      "Could not prepare the Groovy/Processed Gmail label. Reconnect this mailbox and try again.",
    );
  }
  if (
    (args.operation === "spam" || args.operation === "move_noise") &&
    !labels[GROOVY_EMAIL_LABELS.spam]
  ) {
    throw new Error(
      "Could not prepare the Groovy/Spam Gmail label. Reconnect this mailbox and try again.",
    );
  }
  const labelChange = gmailLabelChangeForEmailWorkspaceOperation({
    operation: args.operation,
    labels,
  });
  if (args.requestedAt) {
    // A deferred thread mutation must not archive a reply that arrived after
    // the user acted. Apply the same labels in one batch only to messages that
    // already existed at the durable intent cutoff.
    const items = await fetchGmailThreadItems({
      mailbox: args.mailbox,
      threadId: args.threadId,
      priority: args.priority,
    });
    const messageIds = gmailMessageIdsAtOrBefore({
      items,
      cutoff: args.requestedAt,
      fallbackMessageId: args.messageId,
    });
    if (messageIds.length === 0) {
      throw new Error("The Gmail conversation has no message to update.");
    }
    await modifyGmailMessagesLabels({
      mailbox: args.mailbox,
      messageIds,
      ...labelChange,
      priority: args.priority,
    });
    return;
  }
  if (emailWorkspaceActionAppliesToThread(args.operation)) {
    await modifyGmailThreadLabels({
      mailbox: args.mailbox,
      threadId: args.threadId,
      ...labelChange,
      priority: args.priority,
    });
    return;
  }
  const messageId = text(args.messageId);
  if (!messageId) {
    throw new Error("A Gmail message is required for this operation.");
  }
  await modifyGmailMessageLabels({
    mailbox: args.mailbox,
    messageId,
    ...labelChange,
    priority: args.priority,
  });
}
