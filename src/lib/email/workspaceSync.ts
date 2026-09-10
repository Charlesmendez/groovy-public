import { applyOptimisticEmailOperation } from "@/lib/email/feedOptimistic";
import type {
  EmailFeedResponse,
  EmailThreadSummary,
  EmailView,
} from "@/lib/email/types";

export const EMAIL_WORKSPACE_CORRECTION_EVENT =
  "groovy:email-workspace-correction";

const RECENT_CORRECTION_LIMIT = 300;

export type EmailWorkspaceCorrection = {
  userId: string;
  connectionId: string;
  threadId: string;
  targetView?: "focus" | "inbox" | "noise" | "handled";
  targetViewChangedAt?: string;
  unread?: boolean;
  readChangedAt?: string;
  /** Most recent timestamp across the independent correction dimensions. */
  correctedAt: string;
};

const recentCorrections = new Map<string, EmailWorkspaceCorrection>();

function correctionIdentity(correction: EmailWorkspaceCorrection): string {
  return `${correction.userId}:${correction.connectionId}:${correction.threadId}`;
}

function validTimestamp(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : "";
}

function targetViewChangedAt(correction: EmailWorkspaceCorrection): string {
  if (!correction.targetView) return "";
  return (
    validTimestamp(correction.targetViewChangedAt) ||
    validTimestamp(correction.correctedAt)
  );
}

function readChangedAt(correction: EmailWorkspaceCorrection): string {
  if (correction.unread === undefined) return "";
  return (
    validTimestamp(correction.readChangedAt) ||
    validTimestamp(correction.correctedAt)
  );
}

function newestCorrectionTimestamp(...values: unknown[]): string {
  return values
    .map(validTimestamp)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || "";
}

/**
 * Persists a short in-memory replay window before dispatching. The global
 * notification bridge can reconcile while the lazily loaded Email workspace
 * is still mounting; without replay, that correction would be lost.
 */
export function publishEmailWorkspaceCorrection(
  correction: EmailWorkspaceCorrection,
): void {
  const identity = correctionIdentity(correction);
  const previous = recentCorrections.get(identity);
  const previousTargetAt = previous ? targetViewChangedAt(previous) : "";
  const incomingTargetAt = targetViewChangedAt(correction);
  const previousReadAt = previous ? readChangedAt(previous) : "";
  const incomingReadAt = readChangedAt(correction);
  const useIncomingTarget = Boolean(
    correction.targetView &&
      incomingTargetAt &&
      (!previousTargetAt ||
        Date.parse(incomingTargetAt) >= Date.parse(previousTargetAt)),
  );
  const useIncomingRead = Boolean(
    correction.unread !== undefined &&
      incomingReadAt &&
      (!previousReadAt ||
        Date.parse(incomingReadAt) >= Date.parse(previousReadAt)),
  );
  const effectiveTargetView = useIncomingTarget
    ? correction.targetView
    : previous?.targetView;
  const effectiveTargetAt = useIncomingTarget
    ? incomingTargetAt
    : previousTargetAt;
  const effectiveUnread = useIncomingRead
    ? correction.unread
    : previous?.unread;
  const effectiveReadAt = useIncomingRead ? incomingReadAt : previousReadAt;
  const effective: EmailWorkspaceCorrection = {
    userId: correction.userId,
    connectionId: correction.connectionId,
    threadId: correction.threadId,
    ...(effectiveTargetView
      ? {
          targetView: effectiveTargetView,
          targetViewChangedAt: effectiveTargetAt,
        }
      : {}),
    ...(effectiveUnread !== undefined
      ? { unread: effectiveUnread, readChangedAt: effectiveReadAt }
      : {}),
    correctedAt:
      newestCorrectionTimestamp(effectiveTargetAt, effectiveReadAt) ||
      validTimestamp(correction.correctedAt) ||
      previous?.correctedAt ||
      "",
  };
  if (
    previous &&
    effective.correctedAt === previous.correctedAt &&
    effective.targetView === previous.targetView &&
    effective.targetViewChangedAt === previous.targetViewChangedAt &&
    effective.unread === previous.unread &&
    effective.readChangedAt === previous.readChangedAt
  ) {
    return;
  }
  recentCorrections.delete(identity);
  recentCorrections.set(identity, effective);
  while (recentCorrections.size > RECENT_CORRECTION_LIMIT) {
    const oldest = recentCorrections.keys().next().value;
    if (typeof oldest !== "string") break;
    recentCorrections.delete(oldest);
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(EMAIL_WORKSPACE_CORRECTION_EVENT, {
        detail: effective,
      }),
    );
  }
}

export function recentEmailWorkspaceCorrections(
  userId: string,
): EmailWorkspaceCorrection[] {
  return Array.from(recentCorrections.values()).filter(
    (correction) => correction.userId === userId,
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Returns a stable identity only for the database write that confirms a send.
 *
 * Realtime UPDATE payloads do not include the previous metadata unless the
 * table uses REPLICA IDENTITY FULL. Comparing the row's update timestamp with
 * the immutable completion timestamp distinguishes the completion write from
 * later open-pixel and cleanup updates, while the previous row remains a useful
 * extra guard when it is available.
 */
export function emailTrackingCompletedSendIdentity(
  value: unknown,
  previousValue?: unknown,
): string {
  const row = record(value);
  const metadata = record(row.metadata);
  const previousMetadata = record(record(previousValue).metadata);
  const rowId = text(row.id);
  const completedAt =
    validTimestamp(metadata.email_send_completed_at) ||
    validTimestamp(metadata.email_send_recovered_at);
  const updatedAt = validTimestamp(row.updated_at);
  if (
    !rowId ||
    metadata.email_tracking_record !== true ||
    text(metadata.email_send_state) !== "sent" ||
    text(previousMetadata.email_send_state) === "sent" ||
    !completedAt ||
    !updatedAt ||
    Date.parse(completedAt) !== Date.parse(updatedAt)
  ) {
    return "";
  }
  return `${rowId}:${completedAt}`;
}

export function emailWorkspaceCorrectionFromRow(
  value: unknown,
): EmailWorkspaceCorrection | null {
  const row = record(value);
  const metadata = record(row.metadata);
  const userId = text(row.user_id);
  const connectionId = text(row.connection_id);
  const threadId = text(row.gmail_thread_id) || text(row.gmail_message_id);
  const rawTargetView = text(metadata.email_workspace_override_view);
  const rawCorrectedAt = text(metadata.email_workspace_corrected_at);
  const rawReadChangedAt = text(metadata.email_workspace_read_changed_at);
  const targetView = ["focus", "inbox", "noise", "handled"].includes(
    rawTargetView,
  )
    ? (rawTargetView as EmailWorkspaceCorrection["targetView"])
    : undefined;
  const unread =
    typeof metadata.email_workspace_unread === "boolean"
      ? metadata.email_workspace_unread
      : undefined;
  const correctedAt =
    targetView && Number.isFinite(Date.parse(rawCorrectedAt))
      ? rawCorrectedAt
      : "";
  const readChangedAt =
    unread !== undefined && Number.isFinite(Date.parse(rawReadChangedAt))
      ? rawReadChangedAt
      : "";
  if (
    !userId ||
    !connectionId ||
    !threadId ||
    (!correctedAt && !readChangedAt)
  ) {
    return null;
  }
  const changedAt =
    correctedAt && readChangedAt
      ? Date.parse(readChangedAt) >= Date.parse(correctedAt)
        ? readChangedAt
        : correctedAt
      : correctedAt || readChangedAt;
  return {
    userId,
    connectionId,
    threadId,
    ...(targetView && correctedAt
      ? { targetView, targetViewChangedAt: correctedAt }
      : {}),
    ...(unread !== undefined && readChangedAt
      ? { unread, readChangedAt }
      : {}),
    correctedAt: changedAt,
  };
}

export function emailWorkspaceOperationForTargetView(
  view: NonNullable<EmailWorkspaceCorrection["targetView"]>,
): "move_focus" | "move_inbox" | "move_noise" | "move_handled" {
  if (view === "focus") return "move_focus";
  if (view === "inbox") return "move_inbox";
  if (view === "noise") return "move_noise";
  return "move_handled";
}

export function emailWorkspaceCorrectionRemovesFromView(
  correction: EmailWorkspaceCorrection,
  view: EmailView,
): boolean {
  return Boolean(
    correction.targetView &&
      view !== "all" &&
      view !== "sent" &&
      correction.targetView !== view,
  );
}

export function emailWorkspacePlacementAppliesToThread(
  correction: EmailWorkspaceCorrection,
  thread: Pick<EmailThreadSummary, "receivedAt">,
): boolean {
  if (!correction.targetView) return false;
  const queueChangedAt = targetViewChangedAt(correction);
  if (!queueChangedAt) return true;
  const receivedAt = Date.parse(thread.receivedAt);
  return (
    !Number.isFinite(receivedAt) ||
    receivedAt <= Date.parse(queueChangedAt)
  );
}

export function emailWorkspaceReadStateAppliesToThread(
  correction: EmailWorkspaceCorrection,
  thread: Pick<EmailThreadSummary, "receivedAt">,
): boolean {
  if (correction.unread === undefined) return false;
  const changedAt = readChangedAt(correction);
  if (!changedAt) return true;
  const receivedAt = Date.parse(thread.receivedAt);
  return !Number.isFinite(receivedAt) || receivedAt <= Date.parse(changedAt);
}

function reconcileEmailWorkspaceRemoval(
  feed: EmailFeedResponse,
  correction: EmailWorkspaceCorrection,
): EmailFeedResponse {
  const correctedAt = targetViewChangedAt(correction);
  if (!correctedAt) return feed;
  const id = `${correction.connectionId}:${correction.threadId}`;
  const existing = (feed.authoritativeRemovedConversations || []).find(
    (removal) => removal.id === id,
  );
  const existingAt = existing ? Date.parse(existing.correctedAt) : NaN;
  const correctionAt = Date.parse(correctedAt);
  if (!emailWorkspaceCorrectionRemovesFromView(correction, feed.view)) {
    if (
      correction.targetView !== feed.view ||
      !existing ||
      (Number.isFinite(existingAt) && existingAt > correctionAt)
    ) {
      return feed;
    }
    return {
      ...feed,
      authoritativeRemovedConversations: (
        feed.authoritativeRemovedConversations || []
      ).filter((removal) => removal.id !== id),
    };
  }
  if (
    existing &&
    existingAt >= correctionAt
  ) {
    return feed;
  }
  return {
    ...feed,
    authoritativeRemovedConversations: [
      ...(feed.authoritativeRemovedConversations || []).filter(
        (removal) => removal.id !== id,
      ),
      { id, correctedAt },
    ],
  };
}

export function applyEmailWorkspaceCorrectionToFeed(
  feed: EmailFeedResponse,
  correction: EmailWorkspaceCorrection,
): EmailFeedResponse {
  let nextFeed = feed;
  let thread = nextFeed.threads.find(
    (item) =>
      item.connectionId === correction.connectionId &&
      item.threadId === correction.threadId,
  );
  if (
    thread &&
    emailWorkspaceReadStateAppliesToThread(correction, thread)
  ) {
    nextFeed = applyOptimisticEmailOperation(
      nextFeed,
      thread,
      correction.unread ? "unread" : "read",
      nextFeed.view,
    );
  }
  if (!correction.targetView) return nextFeed;
  thread = nextFeed.threads.find(
    (item) =>
      item.connectionId === correction.connectionId &&
      item.threadId === correction.threadId,
  );
  if (!thread) return reconcileEmailWorkspaceRemoval(nextFeed, correction);
  if (!emailWorkspacePlacementAppliesToThread(correction, thread)) {
    // A queue correction only applies to messages that existed when the user
    // made it. A later reply reopens the conversation; a subsequent read-state
    // change must not silently promote the older Done timestamp.
    return reconcileEmailWorkspaceRemoval(nextFeed, correction);
  }
  return reconcileEmailWorkspaceRemoval(
    applyOptimisticEmailOperation(
      nextFeed,
      thread,
      emailWorkspaceOperationForTargetView(correction.targetView),
      nextFeed.view,
    ),
    correction,
  );
}

/**
 * Replays accepted workspace decisions over a newly loaded feed snapshot.
 * Gmail and cached feed reads can briefly trail the durable action write, so
 * the client keeps the accepted placement without hiding a genuinely newer
 * reply that arrived after the correction timestamp.
 */
export function applyEmailWorkspaceCorrectionsToFeed(
  feed: EmailFeedResponse,
  corrections: readonly EmailWorkspaceCorrection[],
): EmailFeedResponse {
  return corrections.reduce(
    (current, correction) =>
      applyEmailWorkspaceCorrectionToFeed(current, correction),
    feed,
  );
}
