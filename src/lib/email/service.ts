import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchGmailDraft,
  fetchGmailThreadItems,
  GmailApiError,
  gmailItemDirection,
  gmailMessageIdKey,
  GROOVY_EMAIL_LABELS,
  latestGmailThreadItem,
  listGmailThreads,
  parseEmailAddresses,
  parseSender,
  publicMailbox,
  type EmailMailboxConnection,
  type GmailThreadListItem,
} from "@/lib/email/gmail";
import {
  emailOpenStatusFromTrackingRow,
  emailOpenStatusFromTrackingRows,
  EMAIL_TRACKING_RECIPIENT_RECORD_KEY,
  isEmailTrackingRecord,
} from "@/lib/email/openTracking";
import { emailCalendarInviteSummary } from "@/lib/email/calendarInvite";
import { normalizeEmailDraftAttachments } from "@/lib/email/draftAttachments";
import { sanitizeAutomaticRecipientFields } from "@/lib/email/recipients";
import { routeEmailClassification } from "@/lib/email/routing";
import { emailActionIsRetryableModelFailure } from "@/lib/email/triageFreshness";
import {
  EMAIL_FEED_SCHEMA_VERSION,
  type EmailActionState,
  type EmailActionStatus,
  type EmailActionType,
  type EmailDraft,
  type EmailFeedResponse,
  type EmailFocusLane,
  type EmailMailbox,
  type EmailOpenStatus,
  type EmailThreadSummary,
  type EmailView,
} from "@/lib/email/types";

type RecordLike = Record<string, unknown>;
type EmailFeedCursor = {
  v: 1;
  view: EmailView;
  connectionId: string | null;
  offset?: number;
  gmail?: Record<string, string | null>;
};

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function decodeFeedCursor(
  value: string | null | undefined,
  view: EmailView,
  connectionId: string | null | undefined,
): EmailFeedCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as EmailFeedCursor;
    if (
      parsed.v !== 1 ||
      parsed.view !== view ||
      (parsed.connectionId || null) !== (connectionId || null)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function encodeFeedCursor(cursor: EmailFeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return parseEmailAddresses(value);
  return parseEmailAddresses(value);
}

function isActionType(value: unknown): value is EmailActionType {
  return (
    value === "draft_reply" ||
    value === "mark_spam" ||
    value === "unsubscribe" ||
    value === "archive" ||
    value === "label_only"
  );
}

function isActionStatus(value: unknown): value is EmailActionStatus {
  return (
    value === "pending" ||
    value === "approved" ||
    value === "executing" ||
    value === "done" ||
    value === "rejected" ||
    value === "failed"
  );
}

function inferredLane(row: RecordLike): EmailFocusLane {
  const metadata = record(row.metadata);
  const calendarInvite = emailCalendarInviteSummary({
    subject: row.subject,
    metadata,
  });
  if (
    calendarInvite &&
    !text(metadata.email_workspace_override_view)
  ) {
    return calendarInvite.responseStatus === "needsAction"
      ? "read"
      : "handled";
  }
  const action = text(row.recommended_action);
  const route = routeEmailClassification({
    action,
    status: text(row.status),
    confidence: numberOrNull(row.confidence),
    override: text(metadata.email_workspace_override_view),
    critical: metadata.critical === true,
  });
  if (route === "needs_review") return "decide";
  if (route === "noise") return "noise";
  if (route === "handled") return "handled";
  if (action === "draft_reply" && text(row.draft_body)) return "ready";
  return "read";
}

function timestamp(value: unknown): number {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * A user moves a conversation, not one historical triage row. Propagate the
 * newest explicit correction to every action that represents a message which
 * already existed at correction time. A genuinely new reply remains eligible
 * for triage and can bring the conversation back.
 */
export function applyConversationWorkspaceOverrides(
  input: readonly RecordLike[],
): RecordLike[] {
  const latestByConversation = new Map<
    string,
    { view: string; correctedAt: string; timestamp: number }
  >();
  for (const row of input) {
    const metadata = record(row.metadata);
    const view = text(metadata.email_workspace_override_view);
    if (!["focus", "inbox", "noise", "handled"].includes(view)) continue;
    const connectionId = text(row.connection_id);
    const identity =
      text(row.gmail_thread_id) || text(row.gmail_message_id);
    if (!connectionId || !identity) continue;
    const correctedAt =
      text(metadata.email_workspace_corrected_at) ||
      text(row.updated_at) ||
      text(row.created_at);
    const correctedTimestamp = timestamp(correctedAt);
    const key = `${connectionId}:${identity}`;
    const current = latestByConversation.get(key);
    if (!current || correctedTimestamp > current.timestamp) {
      latestByConversation.set(key, {
        view,
        correctedAt,
        timestamp: correctedTimestamp,
      });
    }
  }

  return input.map((row) => {
    const connectionId = text(row.connection_id);
    const identity =
      text(row.gmail_thread_id) || text(row.gmail_message_id);
    const correction = latestByConversation.get(
      `${connectionId}:${identity}`,
    );
    if (!correction) return row;
    const receivedTimestamp = timestamp(
      row.received_at || row.created_at,
    );
    if (
      Number.isFinite(receivedTimestamp) &&
      Number.isFinite(correction.timestamp) &&
      receivedTimestamp > correction.timestamp
    ) {
      return row;
    }
    return {
      ...row,
      metadata: {
        ...record(row.metadata),
        email_workspace_override_view: correction.view,
        email_workspace_corrected_at: correction.correctedAt,
      },
    };
  });
}

function confirmedCalendarStartTimestamp(subject: unknown): number {
  const match = text(subject).match(/^confirmed:\s*(.+)$/i);
  if (!match) return Number.NaN;
  const dateText = match[1]
    .replace(/\s+with\s+.+$/i, "")
    .replace(/\s*[·•]\s*/g, ", ")
    .trim();
  return Date.parse(dateText);
}

/**
 * Scheduling services commonly deliver a human-readable confirmation beside
 * the actionable iTIP invitation. Once the user responds to the invitation,
 * keep an exact same-sender/same-start confirmation out of Needs Review too.
 * Explicit user corrections always win, and unrelated replies remain active.
 */
export function applyRelatedCalendarWorkspaceOverrides(
  input: readonly RecordLike[],
): RecordLike[] {
  const responsesBySender = new Map<
    string,
    Array<{
      messageId: string;
      threadId: string;
      respondedAt: string;
      respondedTimestamp: number;
      startTimestamp: number;
    }>
  >();
  for (const row of input) {
    const metadata = record(row.metadata);
    const responseStatus = text(metadata.calendar_rsvp_status);
    if (
      responseStatus !== "accepted" &&
      responseStatus !== "tentative" &&
      responseStatus !== "declined"
    ) {
      continue;
    }
    const connectionId = text(row.connection_id);
    const senderEmail = text(row.sender_email).toLowerCase();
    const invite = record(metadata.calendar_invite);
    const startTimestamp = timestamp(invite.start);
    const respondedAt =
      text(metadata.calendar_rsvp_responded_at) ||
      text(metadata.email_workspace_corrected_at);
    const respondedTimestamp = timestamp(respondedAt);
    if (
      !connectionId ||
      !senderEmail ||
      !Number.isFinite(startTimestamp) ||
      !respondedAt ||
      !Number.isFinite(respondedTimestamp)
    ) {
      continue;
    }
    const key = `${connectionId}:${senderEmail}`;
    const responses = responsesBySender.get(key) || [];
    responses.push({
      messageId: text(row.gmail_message_id),
      threadId: text(row.gmail_thread_id),
      respondedAt,
      respondedTimestamp,
      startTimestamp,
    });
    responsesBySender.set(key, responses);
  }
  if (responsesBySender.size === 0) return [...input];

  return input.map((row) => {
    const metadata = record(row.metadata);
    if (
      text(metadata.email_workspace_override_view) ||
      text(metadata.message_kind) !== "calendar"
    ) {
      return row;
    }
    const confirmationStart = confirmedCalendarStartTimestamp(row.subject);
    if (!Number.isFinite(confirmationStart)) return row;
    const connectionId = text(row.connection_id);
    const senderEmail = text(row.sender_email).toLowerCase();
    const receivedTimestamp = timestamp(row.received_at || row.created_at);
    if (!connectionId || !senderEmail || !Number.isFinite(receivedTimestamp)) {
      return row;
    }
    const messageId = text(row.gmail_message_id);
    const threadId = text(row.gmail_thread_id);
    const response = (
      responsesBySender.get(`${connectionId}:${senderEmail}`) || []
    )
      .filter(
        (candidate) =>
          candidate.messageId !== messageId &&
          candidate.threadId !== threadId &&
          receivedTimestamp <= candidate.respondedTimestamp &&
          Math.abs(candidate.startTimestamp - confirmationStart) <=
            5 * 60_000,
      )
      .sort(
        (left, right) =>
          left.respondedTimestamp - right.respondedTimestamp,
      )[0];
    if (!response) return row;
    return {
      ...row,
      metadata: {
        ...metadata,
        email_workspace_override_view: "handled",
        email_workspace_corrected_at: response.respondedAt,
        email_workspace_user_action: "calendar_rsvp_related_confirmation",
      },
    };
  });
}

type ReferencedWorkspaceCorrection = {
  view: "focus" | "inbox" | "noise" | "handled";
  correctedAt: string;
  correctedTimestamp: number;
  senderEmail: string;
  subject: string;
};

type ReferencedWorkspaceCorrectionIndex = Map<
  string,
  ReferencedWorkspaceCorrection[]
>;

function normalizedEmailConversationSubject(value: unknown): string {
  let subject = text(value).toLowerCase();
  let previous = "";
  while (subject !== previous) {
    previous = subject;
    subject = subject
      .replace(/^\s*\[(?:external|ext)\]\s*/i, "")
      .replace(/^\s*(?:re|fw|fwd)\s*:\s*/i, "");
  }
  return subject.replace(/\s+/g, " ").trim();
}

function referencedMessageIdKeys(value: unknown): string[] {
  const source = text(value);
  if (!source) return [];
  const tokens = source.match(/<[^<>]+>/g) || source.split(/\s+/);
  return Array.from(
    new Set(tokens.map(gmailMessageIdKey).filter(Boolean)),
  );
}

export function referencedWorkspaceCorrectionIndex(
  input: readonly RecordLike[],
): ReferencedWorkspaceCorrectionIndex {
  const index: ReferencedWorkspaceCorrectionIndex = new Map();
  for (const row of input) {
    const metadata = record(row.metadata);
    const view = text(metadata.email_workspace_override_view);
    if (
      view !== "focus" &&
      view !== "inbox" &&
      view !== "noise" &&
      view !== "handled"
    ) {
      continue;
    }
    if (!text(metadata.email_workspace_user_action)) continue;
    const messageId = gmailMessageIdKey(text(metadata.message_id_header));
    const senderEmail = text(row.sender_email).toLowerCase();
    const subject = normalizedEmailConversationSubject(row.subject);
    const correctedAt = text(metadata.email_workspace_corrected_at);
    const correctedTimestamp = timestamp(correctedAt);
    if (
      !messageId ||
      !senderEmail ||
      !subject ||
      !correctedAt ||
      !Number.isFinite(correctedTimestamp)
    ) {
      continue;
    }
    const corrections = index.get(messageId) || [];
    corrections.push({
      view,
      correctedAt,
      correctedTimestamp,
      senderEmail,
      subject,
    });
    index.set(messageId, corrections);
  }
  return index;
}

/**
 * Gmail thread ids are mailbox-local. A reply chain delivered across two
 * connected aliases can therefore split into separate Gmail conversations.
 * RFC References is the portable identity: inherit an earlier explicit user
 * correction only when the sender and normalized subject also match, and only
 * for mail that already existed when the correction was made.
 */
export function applyReferencedWorkspaceCorrection(args: {
  item: GmailThreadListItem;
  actionRow?: RecordLike;
  corrections: ReferencedWorkspaceCorrectionIndex;
}): RecordLike | undefined {
  const currentMetadata = record(args.actionRow?.metadata);
  if (text(currentMetadata.email_workspace_override_view)) {
    return args.actionRow;
  }
  const senderEmail = parseSender(args.item.from).email.toLowerCase();
  const subject = normalizedEmailConversationSubject(args.item.subject);
  const receivedTimestamp = timestamp(
    args.item.internalDate || args.item.date,
  );
  if (!senderEmail || !subject || !Number.isFinite(receivedTimestamp)) {
    return args.actionRow;
  }
  const referencedIds = Array.from(
    new Set([
      ...referencedMessageIdKeys(args.item.references),
      ...referencedMessageIdKeys(args.item.messageIdHeader),
    ]),
  );
  const correction = referencedIds
    .flatMap((messageId) => args.corrections.get(messageId) || [])
    .filter(
      (candidate) =>
        candidate.senderEmail === senderEmail &&
        candidate.subject === subject &&
        receivedTimestamp <= candidate.correctedTimestamp,
    )
    .sort(
      (left, right) =>
        right.correctedTimestamp - left.correctedTimestamp,
    )[0];
  if (!correction) return args.actionRow;
  return {
    ...(args.actionRow || {}),
    recommended_action:
      text(args.actionRow?.recommended_action) || "label_only",
    status: text(args.actionRow?.status) || "done",
    confidence: numberOrNull(args.actionRow?.confidence) ?? 1,
    metadata: {
      ...currentMetadata,
      email_workspace_override_view: correction.view,
      email_workspace_corrected_at: correction.correctedAt,
      email_workspace_user_action: "referenced_conversation_correction",
    },
  };
}

function emailActionActivityTimestamp(row: RecordLike): number {
  const metadata = record(row.metadata);
  return Math.max(
    timestamp(row.received_at || row.created_at),
    timestamp(metadata.email_workspace_corrected_at),
  );
}

/**
 * Keeps the effective newest action for each Gmail conversation. Explicit
 * workspace corrections participate in the ordering, and rows without
 * received_at fall back to created_at. This prevents an older Calendar action
 * with a null received_at from hiding a genuinely newer reply.
 */
export function latestEmailActionRowsByConversation(
  input: readonly RecordLike[],
): RecordLike[] {
  const ordered = input
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const difference =
        emailActionActivityTimestamp(right.row) -
        emailActionActivityTimestamp(left.row);
      return difference || left.index - right.index;
    })
    .map(({ row }) => row);
  const seen = new Set<string>();
  return ordered.filter((row) => {
    const connectionId = text(row.connection_id);
    const identity =
      text(row.gmail_thread_id) || text(row.gmail_message_id);
    if (!connectionId || !identity) return true;
    const key = `${connectionId}:${identity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function emailActionIsUnread(row: RecordLike): boolean {
  const unread = record(row.metadata).email_workspace_unread;
  return typeof unread === "boolean" ? unread : text(row.status) === "pending";
}

export function emailFocusUnreadCount(
  input: readonly RecordLike[],
): number {
  return latestEmailActionRowsByConversation(
    applyConversationWorkspaceOverrides(input),
  ).filter(
    (row) =>
      actionMatchesWorkspaceView(row, "focus") &&
      emailActionIsUnread(row),
  ).length;
}

export function emailActionStats(input: readonly RecordLike[]): {
  focus: number;
  processed: number;
  draftsReady: number;
  needsReview: number;
  noiseCaught: number;
} {
  const rows = latestEmailActionRowsByConversation(input);
  return {
    focus: rows.filter((row) => actionMatchesWorkspaceView(row, "focus"))
      .length,
    processed: rows.filter((row) => inferredLane(row) === "handled").length,
    draftsReady: rows.filter((row) => inferredLane(row) === "ready").length,
    needsReview: rows.filter((row) => inferredLane(row) === "decide").length,
    noiseCaught: rows.filter((row) => inferredLane(row) === "noise").length,
  };
}

/**
 * Navigation totals normally use the complete action history, but Focus is a
 * live work queue backed by the bounded rich-action snapshot used to build its
 * cards. Counting older actions that cannot be materialized into that queue
 * makes the badge advertise conversations the user cannot open.
 */
export function emailFeedStats(args: {
  materializedRows: readonly RecordLike[];
  allRows: readonly RecordLike[];
  liveNeedsReviewCount?: number;
}): ReturnType<typeof emailActionStats> {
  const historical = emailActionStats(args.allRows);
  const materialized = emailActionStats(args.materializedRows);
  return {
    ...historical,
    focus: materialized.focus,
    draftsReady: materialized.draftsReady,
    needsReview:
      args.liveNeedsReviewCount === undefined
        ? historical.needsReview
        : Math.max(0, Math.floor(args.liveNeedsReviewCount)),
  };
}

export function authoritativeEmailConversationRemovals(
  rows: readonly RecordLike[],
  view: EmailView,
): Array<{ id: string; correctedAt: string }> {
  if (view === "all" || view === "sent") return [];
  const latestByConversation = new Map<
    string,
    { targetView: string; correctedAt: string; timestamp: number }
  >();
  for (const row of rows) {
    const metadata = record(row.metadata);
    const userAction = text(metadata.email_workspace_user_action);
    const targetView = text(metadata.email_workspace_override_view);
    const connectionId = text(row.connection_id);
    const threadId =
      text(row.gmail_thread_id) || text(row.gmail_message_id);
    const correctedAt = text(
      metadata.email_workspace_corrected_at,
    );
    if (
      !userAction ||
      !targetView ||
      !connectionId ||
      !threadId ||
      !correctedAt
    ) {
      continue;
    }
    const id = `${connectionId}:${threadId}`;
    const correctedTimestamp = timestamp(correctedAt);
    const current = latestByConversation.get(id);
    if (!current || correctedTimestamp > current.timestamp) {
      latestByConversation.set(id, {
        targetView,
        correctedAt,
        timestamp: correctedTimestamp,
      });
    }
  }
  return Array.from(latestByConversation.entries()).flatMap(
    ([id, correction]) =>
      correction.targetView === view
        ? []
        : [{ id, correctedAt: correction.correctedAt }],
  );
}

/**
 * A small action-state delta is allowed to invalidate cached queue membership
 * without waiting for Gmail. Unlike the explicit-correction markers above,
 * this is only used by the bounded delta endpoint: the latest persisted action
 * itself proves that a cached card has completed or moved to another queue.
 */
export function emailActionStateConversationRemovals(
  rows: readonly RecordLike[],
  view: EmailView,
): Array<{ id: string; correctedAt: string }> {
  if (view === "all" || view === "sent") return [];
  return latestEmailActionRowsByConversation(
    applyConversationWorkspaceOverrides(rows),
  ).flatMap((row) => {
    if (actionMatchesWorkspaceView(row, view)) return [];
    const connectionId = text(row.connection_id);
    const threadId = text(row.gmail_thread_id) || text(row.gmail_message_id);
    if (!connectionId || !threadId) return [];
    const metadata = record(row.metadata);
    const correctedAt =
      text(metadata.email_workspace_corrected_at) ||
      text(row.updated_at) ||
      text(row.executed_at) ||
      text(row.created_at) ||
      text(row.received_at);
    return correctedAt
      ? [{ id: `${connectionId}:${threadId}`, correctedAt }]
      : [];
  });
}

export function gmailQueryForEmailView(view: EmailView): string | null {
  // Focus and Needs Review both start from the complete Gmail Inbox and are
  // split below using Groovy's action state plus conversation history. This
  // lets a reply to something the user sent enter Focus immediately, before
  // the next AI triage run, without moving unrelated new mail out of review.
  if (view === "focus" || view === "inbox") return "in:inbox";
  if (view === "all") return "in:anywhere -in:trash -in:drafts";
  if (view === "sent") return "in:sent";
  if (view === "handled") {
    return (
      `in:anywhere label:"${GROOVY_EMAIL_LABELS.processed}" ` +
      `-label:"${GROOVY_EMAIL_LABELS.unsubscribed}" ` +
      `-label:"${GROOVY_EMAIL_LABELS.spam}" -in:spam -in:trash`
    );
  }
  if (view === "noise") {
    return (
      `in:anywhere {label:"${GROOVY_EMAIL_LABELS.spam}" ` +
      `label:"${GROOVY_EMAIL_LABELS.unsubscribed}"}`
    );
  }
  return null;
}

export function gmailViewUsesLatestThreadMessage(view: EmailView): boolean {
  return (
    view === "focus" ||
    view === "inbox" ||
    view === "sent" ||
    view === "handled" ||
    view === "noise"
  );
}

export function emailViewUsesIndexedActionFallback(view: EmailView): boolean {
  // Focus is an active Inbox queue. Historical classifier records cannot
  // prove that a Gmail conversation is still in the Inbox, so only Gmail's
  // live paginated result may materialize Focus cards. Processed views are
  // label-backed history and can safely retain their indexed fallback.
  return view === "handled" || view === "noise";
}

export function gmailFullDepthPageSizePerMailbox(limit?: number): number {
  // A unified page already fans out to every connected mailbox. Capping each
  // mailbox prevents one 24-card screen from turning into 75+ Gmail calls.
  // Per-mailbox cursors still expose every older message as the user scrolls.
  return Math.min(12, Math.max(1, Math.floor(limit || 12)));
}

export function gmailLivePageSizePerMailbox(
  view: EmailView,
  requestedLimit: number | undefined,
  mailboxCount: number,
): number {
  if (view === "focus" || view === "inbox" || view === "all") {
    // Keep one unified screen within the requested provider budget. The
    // previous fixed 24-conversation budget made a 12-card progressive All
    // Mail request perform 24 detail reads across three mailboxes. Gmail
    // cursors preserve the remaining messages for subsequent early-prefetched
    // pages.
    const requestedBudget = Math.min(
      24,
      Math.max(1, Math.floor(requestedLimit || 24)),
    );
    return Math.min(
      gmailFullDepthPageSizePerMailbox(requestedLimit),
      Math.max(
        1,
        Math.ceil(requestedBudget / Math.max(1, mailboxCount)),
      ),
    );
  }
  const divided = Math.max(
    1,
    Math.ceil((requestedLimit || 40) / Math.max(1, mailboxCount)),
  );
  // These queues already have safe indexed snapshots. Keep each Gmail
  // reconciliation small enough for one serverless invocation and let the
  // existing Gmail cursor progressively fetch the remaining conversations.
  return view === "sent" || view === "handled" || view === "noise"
    ? Math.min(8, divided)
    : divided;
}

export function gmailFeedPageRequestOptions(
  view: EmailView,
  hasCursor: boolean,
): { detailConcurrency?: number; priority?: "interactive" } {
  // Live feed reads are directly visible to the user. Background refreshes use
  // indexed snapshots/deltas, so every request reaching this path can safely
  // move ahead of provider maintenance work without increasing concurrency.
  return view === "all" && hasCursor
    ? { detailConcurrency: 4, priority: "interactive" }
    : { priority: "interactive" };
}

export function actionFromRow(row: RecordLike): EmailActionState | null {
  if (!isActionType(row.recommended_action) || !isActionStatus(row.status)) {
    return null;
  }
  const metadata = record(row.metadata);
  return {
    id: text(row.id),
    type: row.recommended_action,
    status: row.status,
    lane: inferredLane(row),
    confidence: numberOrNull(row.confidence),
    important: numberOrNull(row.p_important),
    spam: numberOrNull(row.p_spam),
    actionable: numberOrNull(row.p_actionable),
    critical: metadata.critical === true,
    reason: text(row.reason),
    summary:
      text(metadata.summary) ||
      text(row.snippet) ||
      text(row.reason),
    keyAsk: text(metadata.key_ask) || text(metadata.keyAsk),
    deadline: text(metadata.deadline) || null,
    aiGenerated: row.recommended_action === "draft_reply",
    model: text(metadata.policy_model) || text(metadata.model) || null,
  };
}

export function draftFromRow(
  row: RecordLike,
  options?: { ownedAddresses?: readonly string[] },
): EmailDraft | null {
  const body = text(row.draft_body);
  const draftId = text(row.gmail_draft_id);
  if (!body && !draftId) return null;
  const metadata = record(row.metadata);
  let attachments: EmailDraft["attachments"] = [];
  try {
    attachments = normalizeEmailDraftAttachments(
      metadata.email_draft_attachments,
    );
  } catch {
    // Corrupt draft metadata should not make the entire mailbox unavailable.
    attachments = [];
  }
  const recipients = sanitizeAutomaticRecipientFields({
    to: stringArray(row.draft_to),
    cc: stringArray(row.draft_cc ?? metadata.draft_cc),
    bcc: stringArray(row.draft_bcc ?? metadata.draft_bcc),
    ownedAddresses: [
      ...(options?.ownedAddresses || []),
      ...stringArray(metadata.owned_addresses),
    ],
  });
  return {
    actionId: text(row.id) || null,
    draftId: draftId || null,
    connectionId: text(row.connection_id),
    threadId: text(row.gmail_thread_id) || null,
    sourceMessageId: text(row.gmail_message_id) || null,
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    subject: text(row.draft_subject),
    body,
    bodyHtml: text(metadata.email_draft_body_html) || null,
    attachments,
    aiGenerated: true,
    untouched: metadata.user_edited !== true,
    updatedAt: text(row.updated_at) || null,
  };
}

export function summaryFromAction(
  row: RecordLike,
  mailbox: EmailMailbox,
): EmailThreadSummary {
  const metadata = record(row.metadata);
  const automaticRecipients = sanitizeAutomaticRecipientFields({
    to: stringArray(row.draft_to),
    ownedAddresses: [
      mailbox.address,
      ...stringArray(metadata.owned_addresses),
    ],
  });
  const sender = {
    name: text(row.sender_name) || text(row.sender_email).split("@")[0],
    email: text(row.sender_email),
  };
  return {
    key: emailThreadSummaryKey({
      connectionId: mailbox.connectionId,
      actionId: text(row.id),
      messageId: text(row.gmail_message_id),
      threadId: text(row.gmail_thread_id),
    }),
    connectionId: mailbox.connectionId,
    mailbox,
    messageId: text(row.gmail_message_id),
    threadId: text(row.gmail_thread_id) || text(row.gmail_message_id),
    senderName: sender.name || "Unknown",
    senderEmail: sender.email,
    recipients: automaticRecipients.to,
    subject: text(row.subject) || "(no subject)",
    snippet: text(row.snippet) || text(row.reason),
    receivedAt:
      text(row.received_at) ||
      text(row.created_at) ||
      new Date(0).toISOString(),
    unread: emailActionIsUnread(row),
    starred: metadata.starred === true,
    hasAttachments: metadata.has_attachments === true,
    direction: "incoming",
    openStatus: null,
    calendarInvite: emailCalendarInviteSummary({
      subject: row.subject,
      metadata: row.metadata,
    }),
    action: actionFromRow(row),
    draft: draftFromRow(row, { ownedAddresses: [mailbox.address] }),
  };
}

export function summaryFromTrackingRow(
  row: RecordLike,
  mailbox: EmailMailbox,
): EmailThreadSummary {
  const metadata = record(row.metadata);
  const recipients = stringArray(
    metadata.email_tracking_recipients || row.draft_to,
  );
  const messageId =
    text(metadata.email_tracking_sent_message_id) ||
    text(row.gmail_message_id);
  const threadId =
    text(metadata.email_tracking_sent_thread_id) ||
    text(row.gmail_thread_id) ||
    messageId;
  return {
    key: emailThreadSummaryKey({
      connectionId: mailbox.connectionId,
      actionId: text(row.id),
      messageId,
      threadId,
    }),
    connectionId: mailbox.connectionId,
    mailbox,
    messageId,
    threadId,
    senderName:
      recipients.length > 1
        ? `${recipients[0]} +${recipients.length - 1}`
        : recipients[0] || "Undisclosed recipients",
    senderEmail: recipients[0] || "",
    recipients,
    subject:
      text(metadata.email_tracking_subject) ||
      text(row.subject) ||
      "(no subject)",
    snippet: text(row.snippet),
    receivedAt:
      text(metadata.email_tracking_sent_at) ||
      text(row.executed_at) ||
      text(row.created_at) ||
      new Date(0).toISOString(),
    unread: false,
    starred: false,
    hasAttachments: false,
    direction: "outgoing",
    openStatus: emailOpenStatusFromTrackingRow(row),
    calendarInvite: null,
    action: null,
    draft: null,
  };
}

export function summaryFromGmail(
  item: GmailThreadListItem,
  mailbox: EmailMailbox,
  actionRow?: RecordLike,
  options?: {
    direction?: "incoming" | "outgoing";
    openStatus?: EmailOpenStatus | null;
  },
): EmailThreadSummary {
  const direction = options?.direction || "incoming";
  const recipients = parseEmailAddresses([item.to, item.cc]);
  const sender =
    direction === "outgoing"
      ? {
          name:
            recipients.length > 1
              ? `${recipients[0]} +${recipients.length - 1}`
              : recipients[0] || "Undisclosed recipients",
          email: recipients[0] || "",
        }
      : parseSender(item.from);
  return {
    key: emailThreadSummaryKey({
      connectionId: mailbox.connectionId,
      actionId: actionRow ? text(actionRow.id) : "",
      messageId: item.id,
      threadId: item.threadId,
    }),
    connectionId: mailbox.connectionId,
    mailbox,
    messageId: item.id,
    threadId: item.threadId || item.id,
    internetMessageId: gmailMessageIdKey(item.messageIdHeader) || undefined,
    toRecipients: parseEmailAddresses(item.to),
    senderName: sender.name,
    senderEmail: sender.email,
    recipients,
    subject: item.subject,
    snippet: item.snippet,
    receivedAt: item.internalDate || item.date || new Date(0).toISOString(),
    unread: item.labelIds.includes("UNREAD"),
    starred: item.labelIds.includes("STARRED"),
    hasAttachments: item.hasAttachments,
    direction,
    openStatus: options?.openStatus || null,
    calendarInvite: emailCalendarInviteSummary({
      subject: item.subject,
      metadata: actionRow?.metadata,
      hasCalendarInvitation: item.hasCalendarInvitation,
    }),
    action: actionRow ? actionFromRow(actionRow) : null,
    draft: actionRow
      ? draftFromRow(actionRow, { ownedAddresses: [mailbox.address] })
      : null,
  };
}

export function emailThreadSummaryKey(args: {
  connectionId: string;
  actionId?: string | null;
  messageId?: string | null;
  threadId?: string | null;
}): string {
  const identity =
    text(args.messageId) ||
    text(args.actionId) ||
    text(args.threadId);
  const kind = text(args.messageId)
    ? "message"
    : text(args.actionId)
      ? "action"
      : "thread";
  return `${text(args.connectionId)}:${kind}:${identity}`;
}

function rank(summary: EmailThreadSummary): number {
  // A live reply can enter Focus before AI triage creates an action row. It is
  // still a Worth Reading item and should rank with other read-lane cards.
  const lane =
    summary.action?.lane ||
    (summary.direction === "incoming" ? "read" : undefined);
  const laneWeight =
    lane === "ready"
      ? 50
      : lane === "decide"
        ? 40
        : lane === "read"
          ? 30
          : lane === "noise"
            ? 10
            : 0;
  const critical = summary.action?.critical ? 20 : 0;
  const actionable = (summary.action?.actionable || 0) * 10;
  const received = Date.parse(summary.receivedAt);
  const recency = Number.isFinite(received) ? Math.max(0, received / 1e12) : 0;
  return laneWeight + critical + actionable + recency;
}

export function compareEmailThreadSummaries(
  a: EmailThreadSummary,
  b: EmailThreadSummary,
): number {
  const ranked = rank(b) - rank(a);
  if (ranked !== 0) return ranked;
  return compareEmailThreadSummariesByRecency(a, b);
}

export function compareEmailThreadSummariesByRecency(
  a: EmailThreadSummary,
  b: EmailThreadSummary,
): number {
  const received =
    (Number.isFinite(Date.parse(b.receivedAt))
      ? Date.parse(b.receivedAt)
      : 0) -
    (Number.isFinite(Date.parse(a.receivedAt))
      ? Date.parse(a.receivedAt)
      : 0);
  if (received !== 0) return received;
  return a.key.localeCompare(b.key);
}

export function emailThreadSummaryComparatorForView(
  view: EmailView,
): typeof compareEmailThreadSummaries {
  return view === "inbox" || view === "sent" || view === "all"
    ? compareEmailThreadSummariesByRecency
    : compareEmailThreadSummaries;
}

function unifiedMailboxCopyScore(summary: EmailThreadSummary): number {
  const mailboxAddress = summary.mailbox.address.trim().toLowerCase();
  const addressedDirectly = (summary.toRecipients || []).some(
    (address) => address.trim().toLowerCase() === mailboxAddress,
  );
  return (
    (summary.draft ? 32 : 0) +
    (summary.action?.lane === "ready" ? 16 : 0) +
    (addressedDirectly ? 8 : 0) +
    (summary.mailbox.isDefaultSender ? 4 : 0) +
    (summary.action ? 2 : 0)
  );
}

function preferredUnifiedMailboxCopy(
  left: EmailThreadSummary,
  right: EmailThreadSummary,
): EmailThreadSummary {
  const leftScore = unifiedMailboxCopyScore(left);
  const rightScore = unifiedMailboxCopyScore(right);
  const preferred =
    leftScore !== rightScore
      ? leftScore > rightScore
        ? left
        : right
      : left.key.localeCompare(right.key) <= 0
        ? left
        : right;
  return {
    ...preferred,
    unread: left.unread || right.unread,
    starred: left.starred || right.starred,
    hasAttachments: left.hasAttachments || right.hasAttachments,
  };
}

export function dedupeEmailConversationSummariesDetailed(
  summaries: readonly EmailThreadSummary[],
): {
  threads: EmailThreadSummary[];
  suppressedMailboxCopies: EmailThreadSummary[];
} {
  // First preserve the newest card for each mailbox-native Gmail thread.
  const perConversation = new Map<string, EmailThreadSummary>();
  for (const summary of summaries) {
    const identity = `${summary.connectionId}:${summary.threadId}`;
    const existing = perConversation.get(identity);
    if (
      !existing ||
      compareEmailThreadSummariesByRecency(summary, existing) < 0
    ) {
      perConversation.set(identity, summary);
    }
  }

  // Gmail assigns different thread/message ids to the same delivery in two
  // connected accounts. The RFC Message-ID is the cross-mailbox identity.
  const unified = new Map<string, EmailThreadSummary>();
  const suppressedMailboxCopies: EmailThreadSummary[] = [];
  for (const summary of perConversation.values()) {
    const identity = summary.internetMessageId
      ? `rfc:${summary.internetMessageId}`
      : `gmail:${summary.connectionId}:${summary.threadId}`;
    const existing = unified.get(identity);
    if (!existing) {
      unified.set(identity, summary);
      continue;
    }
    const preferred = preferredUnifiedMailboxCopy(existing, summary);
    const suppressed = preferred.connectionId === existing.connectionId &&
      preferred.threadId === existing.threadId
      ? summary
      : existing;
    unified.set(identity, preferred);
    if (
      suppressed.connectionId !== preferred.connectionId ||
      suppressed.threadId !== preferred.threadId
    ) {
      suppressedMailboxCopies.push(suppressed);
    }
  }
  return {
    threads: Array.from(unified.values()),
    suppressedMailboxCopies,
  };
}

export function dedupeEmailConversationSummaries(
  summaries: readonly EmailThreadSummary[],
): EmailThreadSummary[] {
  return dedupeEmailConversationSummariesDetailed(summaries).threads;
}

export function actionMatchesWorkspaceView(
  row: RecordLike,
  view: EmailView,
): boolean {
  const lane = inferredLane(row);
  if (view === "focus") {
    return lane === "ready" || lane === "read";
  }
  if (view === "inbox") return lane === "decide";
  if (view === "noise") return lane === "noise";
  if (view === "handled") return lane === "handled";
  return false;
}

const AUTOMATIC_FOCUS_RECOVERY_LIMIT = 4;
const EXPLICIT_FOCUS_RECOVERY_LIMIT = 24;

/**
 * Explicit user placement must not compete with classifier-derived Focus
 * candidates for the small provider-reconciliation budget. Otherwise a few
 * newer automatic classifications can silently push a conversation the user
 * deliberately kept in Focus out of the first page.
 */
export function selectFocusRecoveryCandidates(
  input: readonly RecordLike[],
  requestedLimit = EXPLICIT_FOCUS_RECOVERY_LIMIT,
): RecordLike[] {
  const explicit: RecordLike[] = [];
  const automatic: RecordLike[] = [];
  for (const row of input) {
    const metadata = record(row.metadata);
    if (
      text(metadata.email_workspace_override_view) === "focus" &&
      text(metadata.email_workspace_user_action) === "move_focus"
    ) {
      explicit.push(row);
    } else {
      automatic.push(row);
    }
  }
  const explicitLimit = Math.min(
    EXPLICIT_FOCUS_RECOVERY_LIMIT,
    Math.max(1, Math.floor(requestedLimit)),
  );
  return [
    ...explicit.slice(0, explicitLimit),
    ...automatic.slice(0, AUTOMATIC_FOCUS_RECOVERY_LIMIT),
  ];
}

/**
 * Routes a live Inbox conversation before AI triage has necessarily created
 * an action row. A newest incoming message in a thread that already contains a
 * Sent message is a response to the user and belongs in Focus immediately.
 * Existing AI/user classifications remain authoritative when present.
 */
export function gmailInboxConversationView(args: {
  item: GmailThreadListItem;
  actionRow?: RecordLike;
  direction: "incoming" | "outgoing";
}): "focus" | "inbox" | null {
  if (args.direction !== "incoming") return null;
  // A provider outage is not a classification. Route the live Gmail thread
  // deterministically until the retry succeeds so replies to the user do not
  // get stranded in Needs Review by a transient model failure.
  if (
    args.actionRow &&
    !emailActionIsRetryableModelFailure(args.actionRow)
  ) {
    if (actionMatchesWorkspaceView(args.actionRow, "focus")) return "focus";
    if (actionMatchesWorkspaceView(args.actionRow, "inbox")) return "inbox";
    return null;
  }
  return args.item.threadHasSentMessage ? "focus" : "inbox";
}

/**
 * A pending action remains attached to its original incoming message after the
 * user replies, but a later incoming reply must become the visible Focus card.
 * Gmail's list hydration exposes both the latest thread message and the exact
 * Inbox match, so fall back to that match only while the latest message is the
 * user's own outgoing reply.
 */
export function focusInboxCardMessage(args: {
  item: GmailThreadListItem;
  actionRow?: RecordLike;
  ownedAddresses: readonly string[];
}): GmailThreadListItem {
  const matched = args.item.matchedItem;
  if (
    !args.actionRow ||
    !matched ||
    gmailItemDirection(args.item, args.ownedAddresses) !== "outgoing"
  ) {
    return args.item;
  }
  const unread = args.item.labelIds.includes("UNREAD");
  return {
    ...matched,
    threadHasSentMessage: args.item.threadHasSentMessage,
    labelIds: unread
      ? Array.from(new Set([...matched.labelIds, "UNREAD"]))
      : matched.labelIds.filter((labelId) => labelId !== "UNREAD"),
    hasAttachments: args.item.hasAttachments,
  };
}

/**
 * Materialize an indexed Focus candidate only after Gmail proves that the
 * conversation is still in Inbox. This keeps the first Focus screen complete
 * when a busy mailbox pushes an actionable conversation beyond its first
 * Gmail page, without allowing an archived historical action to reappear.
 */
export function providerVerifiedFocusSummary(args: {
  items: readonly GmailThreadListItem[];
  mailbox: EmailMailbox;
  ownedAddresses: readonly string[];
  actionRow?: RecordLike;
}): EmailThreadSummary | null {
  const latest = latestGmailThreadItem(args.items);
  if (!latest) return null;
  const actionMessageId = args.actionRow
    ? text(args.actionRow.gmail_message_id)
    : "";
  const matchedItem =
    (actionMessageId
      ? args.items.find((item) => item.id === actionMessageId)
      : null) || undefined;
  const conversationItem: GmailThreadListItem = {
    ...latest,
    threadHasSentMessage: args.items.some((candidate) =>
      candidate.labelIds.includes("SENT"),
    ),
    labelIds: args.items.some((candidate) =>
      candidate.labelIds.includes("UNREAD"),
    )
      ? Array.from(new Set([...latest.labelIds, "UNREAD"]))
      : latest.labelIds.filter((labelId) => labelId !== "UNREAD"),
    hasAttachments: args.items.some(
      (candidate) => candidate.hasAttachments,
    ),
    matchedItem,
  };
  const item = focusInboxCardMessage({
    item: conversationItem,
    actionRow: args.actionRow,
    ownedAddresses: args.ownedAddresses,
  });
  if (!item.labelIds.includes("INBOX")) return null;
  const direction = gmailItemDirection(item, args.ownedAddresses);
  if (
    gmailInboxConversationView({
      item,
      actionRow: args.actionRow,
      direction,
    }) !== "focus"
  ) {
    return null;
  }
  return summaryFromGmail(item, args.mailbox, args.actionRow, {
    direction,
  });
}

function actionForLiveMessage(args: {
  connectionId: string;
  messageId: string;
  threadId: string;
  byMessage: Map<string, RecordLike>;
  byThread: Map<string, RecordLike>;
}): RecordLike | undefined {
  const exact = args.byMessage.get(
    `${args.connectionId}:${args.messageId}`,
  );
  if (exact) return exact;

  const legacyThreadAction = args.byThread.get(
    `${args.connectionId}:${args.threadId}`,
  );
  // A newly arrived reply must not inherit an older message's classification
  // merely because both messages belong to the same Gmail thread.
  return legacyThreadAction && !text(legacyThreadAction.gmail_message_id)
    ? legacyThreadAction
    : undefined;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  iteratee: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, limit)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await iteratee(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

async function hydrateLatestConversationSummaries(args: {
  summaries: readonly EmailThreadSummary[];
  mailboxes: readonly EmailMailboxConnection[];
  ownedAddresses: readonly string[];
  signal?: AbortSignal;
}): Promise<EmailThreadSummary[]> {
  const mailboxByConnection = new Map(
    args.mailboxes.map((mailbox) => [mailbox.connectionId, mailbox]),
  );
  // One Gmail thread fetch per card dominates feed latency; a wider pool
  // cuts wall-clock time while staying under Gmail's per-user burst limits
  // (persisted feed limits mean a cold refresh can span up to 96 threads).
  return mapWithConcurrency(args.summaries, 8, async (summary) => {
    const mailbox = mailboxByConnection.get(summary.connectionId);
    if (!mailbox || mailbox.status !== "connected" || !summary.threadId) {
      return summary;
    }
    try {
      const items = await fetchGmailThreadItems({
        mailbox,
        threadId: summary.threadId,
        signal: args.signal,
      });
      const latest = latestGmailThreadItem(items);
      if (!latest) return summary;
      const refreshed = summaryFromGmail(
        latest,
        summary.mailbox,
        undefined,
        {
          direction: gmailItemDirection(latest, args.ownedAddresses),
          openStatus: summary.openStatus,
        },
      );
      return {
        ...refreshed,
        // AI state belongs to the conversation even when a newer reply
        // becomes the card preview.
        action: summary.action,
        draft: summary.draft,
        unread: items.some((item) => item.labelIds.includes("UNREAD")),
        hasAttachments: items.some((item) => item.hasAttachments),
      };
    } catch {
      return summary;
    }
  });
}

// PostgREST caps ordinary reads at 1,000 rows. Fetch the compact action index
// in parallel pages after the first page tells us the exact size. A mature
// mailbox can have thousands of historical triage rows; walking those pages
// serially made every queue navigation pay several network round trips before
// Gmail was even queried.
const EMAIL_ACTION_STATS_PAGE_SIZE = 1_000;
const EMAIL_ACTION_STATS_PAGE_CONCURRENCY = 4;
const EMAIL_ACTION_STAT_SELECT = [
  "id",
  "connection_id",
  "gmail_message_id",
  "gmail_thread_id",
  "sender_email",
  "subject",
  "recommended_action",
  "status",
  "confidence",
  "draft_body",
  "received_at",
  "created_at",
  "updated_at",
  "metadata_override_view:metadata->>email_workspace_override_view",
  "metadata_corrected_at:metadata->>email_workspace_corrected_at",
  "metadata_user_action:metadata->>email_workspace_user_action",
  "metadata_unread:metadata->email_workspace_unread",
  "metadata_read_changed_at:metadata->>email_workspace_read_changed_at",
  "metadata_critical:metadata->critical",
  "metadata_triage_decision_source:metadata->>triage_decision_source",
  "metadata_message_kind:metadata->>message_kind",
  "metadata_calendar_invite:metadata->calendar_invite",
  "metadata_calendar_rsvp_status:metadata->>calendar_rsvp_status",
  "metadata_calendar_rsvp_responded_at:metadata->>calendar_rsvp_responded_at",
  "metadata_message_id_header:metadata->>message_id_header",
  "metadata_tracking_record:metadata->email_tracking_record",
].join(",");

const EMAIL_ACTION_STAT_METADATA_FIELDS = [
  ["metadata_override_view", "email_workspace_override_view"],
  ["metadata_corrected_at", "email_workspace_corrected_at"],
  ["metadata_user_action", "email_workspace_user_action"],
  ["metadata_unread", "email_workspace_unread"],
  ["metadata_read_changed_at", "email_workspace_read_changed_at"],
  ["metadata_critical", "critical"],
  ["metadata_triage_decision_source", "triage_decision_source"],
  ["metadata_message_kind", "message_kind"],
  ["metadata_calendar_invite", "calendar_invite"],
  ["metadata_calendar_rsvp_status", "calendar_rsvp_status"],
  ["metadata_calendar_rsvp_responded_at", "calendar_rsvp_responded_at"],
  ["metadata_message_id_header", "message_id_header"],
  ["metadata_tracking_record", "email_tracking_record"],
] as const;

/** Rebuilds the small metadata shape consumed by feed routing and counters. */
export function emailActionStatRowFromProjection(value: unknown): RecordLike {
  const projected = record(value);
  const metadata: RecordLike = {};
  for (const [source, target] of EMAIL_ACTION_STAT_METADATA_FIELDS) {
    const field = projected[source];
    if (field !== null && field !== undefined) metadata[target] = field;
  }
  const row: RecordLike = { ...projected, metadata };
  for (const [source] of EMAIL_ACTION_STAT_METADATA_FIELDS) {
    delete row[source];
  }
  return row;
}

/**
 * The all-history index stays skinny, but live cards still need the bounded
 * rich rows for draft recipients, HTML, attachments, summaries, and model
 * context. Overlay routing/read corrections from the stat snapshot onto the
 * matching rich row so neither half is lost.
 */
export function emailActionHydrationRows(
  statRows: readonly RecordLike[],
  richRows: readonly RecordLike[],
): RecordLike[] {
  const richById = new Map(
    richRows
      .map((row) => [text(row.id), row] as const)
      .filter(([id]) => Boolean(id)),
  );
  return statRows.map((statRow) => {
    const id = text(statRow.id);
    const richRow = id ? richById.get(id) : undefined;
    if (!richRow) return statRow;
    return {
      ...richRow,
      ...statRow,
      metadata: {
        ...record(richRow.metadata),
        ...record(statRow.metadata),
      },
    };
  });
}

async function loadEmailActionStatRows(args: {
  supabase: SupabaseClient;
  userId: string;
  connectionIds: string[];
  signal?: AbortSignal;
}): Promise<RecordLike[]> {
  if (args.connectionIds.length === 0) return [];
  const snapshotStartedAt = new Date().toISOString();
  const page = async (offset: number, count = false) => {
    let query = args.supabase
      .from("inbox_actions")
      .select(EMAIL_ACTION_STAT_SELECT, count ? { count: "exact" } : undefined)
      .eq("user_id", args.userId)
      .eq("provider", "gmail")
      .in("connection_id", args.connectionIds)
      .lte("created_at", snapshotStartedAt)
      .order("received_at", {
        ascending: false,
        nullsFirst: false,
      })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(
        offset,
        offset + EMAIL_ACTION_STATS_PAGE_SIZE - 1,
      );
    if (args.signal) query = query.abortSignal(args.signal);
    const result = await query;
    if (result.error) throw new Error(result.error.message);
    return {
      count: result.count,
      rows: (result.data || [])
        .map(emailActionStatRowFromProjection)
        .filter((row) => !isEmailTrackingRecord(row)),
    };
  };

  const first = await page(0, true);
  const total = Math.max(first.rows.length, Number(first.count || 0));
  const offsets: number[] = [];
  for (
    let offset = EMAIL_ACTION_STATS_PAGE_SIZE;
    offset < total;
    offset += EMAIL_ACTION_STATS_PAGE_SIZE
  ) {
    offsets.push(offset);
  }
  const rows = [...first.rows];
  for (
    let index = 0;
    index < offsets.length;
    index += EMAIL_ACTION_STATS_PAGE_CONCURRENCY
  ) {
    const pages = await Promise.all(
      offsets
        .slice(index, index + EMAIL_ACTION_STATS_PAGE_CONCURRENCY)
        .map((offset) => page(offset)),
    );
    for (const result of pages) rows.push(...result.rows);
  }
  return applyRelatedCalendarWorkspaceOverrides(
    applyConversationWorkspaceOverrides(rows),
  );
}

export async function loadEmailFeed(args: {
  supabase: SupabaseClient;
  userId: string;
  mailboxes: EmailMailboxConnection[];
  view: EmailView;
  connectionId?: string | null;
  limit?: number;
  cursor?: string | null;
  liveSync?: boolean;
  notificationActionIds?: string[];
  actionUpdatedAfter?: string | null;
  signal?: AbortSignal;
}): Promise<EmailFeedResponse> {
  const ownedAddresses = args.mailboxes
    .map((mailbox) => mailbox.address)
    .filter(Boolean);
  const included = args.mailboxes.filter(
    (mailbox) =>
      args.connectionId
        ? mailbox.connectionId === args.connectionId
        : mailbox.includedInUnified,
  );
  const connectionIds = included.map((mailbox) => mailbox.connectionId);
  const cursor = decodeFeedCursor(
    args.cursor,
    args.view,
    args.connectionId,
  );
  const gmailQuery =
    args.liveSync === false ? null : gmailQueryForEmailView(args.view);
  const previousGmailCursor = cursor?.gmail;
  type GmailPageRequest =
    | {
        result: Awaited<ReturnType<typeof listGmailThreads>>;
        error?: never;
      }
    | { result: null; error?: never }
    | { result?: never; error: unknown };
  const gmailPageRequests = new Map<
    string,
    Promise<GmailPageRequest>
  >();
  if (gmailQuery) {
    const perMailbox = gmailLivePageSizePerMailbox(
      args.view,
      args.limit,
      included.length,
    );
    const requestOptions = gmailFeedPageRequestOptions(
      args.view,
      Boolean(previousGmailCursor),
    );
    for (const mailbox of included) {
      const cursorComplete = Boolean(
        previousGmailCursor &&
          Object.prototype.hasOwnProperty.call(
            previousGmailCursor,
            mailbox.connectionId,
          ) &&
          previousGmailCursor[mailbox.connectionId] === null,
      );
      if (cursorComplete) {
        gmailPageRequests.set(
          mailbox.connectionId,
          Promise.resolve({ result: null }),
        );
        continue;
      }
      // Start Gmail before awaiting the independent action-index reads below.
      // Pagination used to pay those two latencies serially on every scroll.
      gmailPageRequests.set(
        mailbox.connectionId,
        listGmailThreads({
          mailbox,
          query: gmailQuery,
          maxResults: perMailbox,
          pageToken: previousGmailCursor?.[mailbox.connectionId] || null,
          signal: args.signal,
          latestInThread: gmailViewUsesLatestThreadMessage(args.view),
          ...requestOptions,
        })
          .then((result) => ({ result }))
          .catch((error: unknown) => ({ error })),
      );
    }
  }
  let actionQuery = args.supabase
    .from("inbox_actions")
    .select("*")
    .eq("user_id", args.userId)
    .eq("provider", "gmail")
    .order("received_at", {
      ascending: false,
      nullsFirst: false,
    })
    .order("created_at", { ascending: false })
    .limit(250);
  if (args.notificationActionIds?.length) {
    actionQuery = actionQuery.in("id", args.notificationActionIds);
  } else if (args.actionUpdatedAfter) {
    actionQuery = actionQuery.gte("updated_at", args.actionUpdatedAfter);
  }
  const actionDelta =
    Boolean(args.notificationActionIds?.length) ||
    Boolean(args.actionUpdatedAfter);
  const needsTrackingRows =
    args.view === "sent" ||
    (args.view === "all" && args.liveSync === false);
  const trackingQuery =
    needsTrackingRows && connectionIds.length > 0
      ? args.supabase
          .from("inbox_actions")
          .select(
            "id,connection_id,gmail_message_id,gmail_thread_id,sender_email,sender_name,subject,snippet,draft_to,executed_at,metadata,created_at",
          )
          .eq("user_id", args.userId)
          .eq("provider", "gmail")
          .contains("metadata", { email_tracking_record: true })
          .in("connection_id", connectionIds)
          .order("created_at", { ascending: false })
          .limit(500)
      : { data: [], error: null };
  // These indexed sources are independent. The skinny paged stats query
  // covers every conversation, while the richer recent rows stay bounded for
  // card hydration.
  const [actionResult, trackingResult, actionStatRows] = await Promise.all([
    connectionIds.length > 0
      ? actionQuery.in("connection_id", connectionIds)
      : { data: [], error: null },
    trackingQuery,
    actionDelta
      ? Promise.resolve([])
      : loadEmailActionStatRows({
          supabase: args.supabase,
          userId: args.userId,
          connectionIds,
          signal: args.signal,
        }),
  ]);
  if (actionResult.error) throw new Error(actionResult.error.message);
  const actionRows = applyRelatedCalendarWorkspaceOverrides(
    applyConversationWorkspaceOverrides(
      (actionResult.data || [])
        .map((row) => record(row))
        .filter((row) => !isEmailTrackingRecord(row)),
    ),
  );
  const latestActionRows = latestEmailActionRowsByConversation(actionRows);
  const effectiveActionStatRows = actionDelta
    ? actionRows
    : actionStatRows;
  const latestActionStatRows =
    latestEmailActionRowsByConversation(effectiveActionStatRows);
  const actionHydrationRows = emailActionHydrationRows(
    effectiveActionStatRows,
    actionRows,
  );
  const trackingRows = trackingResult.error
    ? []
    : (trackingResult.data || []).map((row) => record(row));
  const trackingByMessage = new Map<string, RecordLike[]>();
  const trackingByThread = new Map<string, RecordLike[]>();
  const appendTrackingRow = (
    map: Map<string, RecordLike[]>,
    key: string,
    row: RecordLike,
  ) => {
    const existing = map.get(key) || [];
    existing.push(row);
    map.set(key, existing);
  };
  for (const row of trackingRows) {
    const metadata = record(row.metadata);
    const connectionId = text(row.connection_id);
    const messageId =
      text(metadata.email_tracking_sent_message_id) ||
      text(row.gmail_message_id);
    const threadId =
      text(metadata.email_tracking_sent_thread_id) ||
      text(row.gmail_thread_id);
    if (messageId) {
      appendTrackingRow(
        trackingByMessage,
        `${connectionId}:${messageId}`,
        row,
      );
    }
    if (threadId) {
      appendTrackingRow(
        trackingByThread,
        `${connectionId}:${threadId}`,
        row,
      );
    }
  }
  const mailboxById = new Map(
    included.map((mailbox) => [
      mailbox.connectionId,
      publicMailbox(mailbox),
    ]),
  );
  const byMessage = new Map<string, RecordLike>();
  const byThread = new Map<string, RecordLike>();
  for (const row of actionHydrationRows) {
    const connectionId = text(row.connection_id);
    const messageId = text(row.gmail_message_id);
    const threadId = text(row.gmail_thread_id);
    if (messageId && !byMessage.has(`${connectionId}:${messageId}`)) {
      byMessage.set(`${connectionId}:${messageId}`, row);
    }
    if (threadId && !byThread.has(`${connectionId}:${threadId}`)) {
      byThread.set(`${connectionId}:${threadId}`, row);
    }
  }
  const referencedCorrections =
    referencedWorkspaceCorrectionIndex(effectiveActionStatRows);

  let threads: EmailThreadSummary[] = [];
  let nextCursor: string | null = null;
  let liveConversationRemovals: Array<{
    id: string;
    correctedAt: string;
  }> = [];
  let liveNeedsReviewCount: number | undefined;
  const syncProblems = new Map<
    string,
    { status: EmailMailbox["status"]; message: string }
  >();
  let providerRetryAfterMs = 0;
  for (const mailbox of included) {
    if (mailbox.status === "connected") continue;
    syncProblems.set(mailbox.connectionId, {
      status: mailbox.status,
      message:
        mailbox.status === "reauth_required"
          ? "Reconnect this mailbox to resume syncing."
          : "This mailbox could not sync. Try again in a moment.",
    });
  }
  if (gmailQuery) {
    // Materialize the already-started Gmail pages from every mailbox.
    // Dividing a unified page evenly starves a busy mailbox whenever the others
    // have fewer messages, making recent Gmail Inbox mail appear to be missing.
    // Returning complete per-mailbox pages also preserves Gmail page-token
    // correctness: no fetched-but-hidden messages are skipped by the next
    // request. The larger fan-out is intentionally limited to Gmail-backed
    // queues where missing a recent message would be misleading.
    const live = await Promise.all(
      included.map(async (mailbox) => {
        const page = await gmailPageRequests.get(mailbox.connectionId);
        if (!page?.error && page?.result === null) {
          return {
            connectionId: mailbox.connectionId,
            nextPageToken: null,
            items: [] as EmailThreadSummary[],
            needsReviewItems: [] as EmailThreadSummary[],
            removedConversations: [] as Array<{
              id: string;
              correctedAt: string;
            }>,
          };
        }
        try {
          if (page?.error) throw page.error;
          if (!page?.result) {
            throw new Error("Gmail page request was not started.");
          }
          const result = page.result;
          const publicIdentity = publicMailbox(mailbox);
          const removedConversations: Array<{
            id: string;
            correctedAt: string;
          }> = [];
          const needsReviewItems: EmailThreadSummary[] = [];
          const items = result.items.flatMap((item) => {
            let routedItem = item;
            let direction = gmailItemDirection(item, ownedAddresses);
            if (args.view === "sent") {
              const matchedMessageId = item.matchedItem?.id || item.id;
              const trackingMessageRows =
                trackingByMessage.get(
                  `${mailbox.connectionId}:${matchedMessageId}`,
                ) || [];
              const trackingThreadRows =
                trackingByThread.get(
                  `${mailbox.connectionId}:${item.threadId}`,
                ) || [];
              const matchingTrackingRows = Array.from(
                new Map(
                  [...trackingMessageRows, ...trackingThreadRows].map(
                    (row) => [text(row.id), row],
                  ),
                ).values(),
              );
              return [
                summaryFromGmail(item, publicIdentity, undefined, {
                  direction,
                  openStatus:
                    emailOpenStatusFromTrackingRows(
                      matchingTrackingRows || [],
                    ) || null,
                }),
              ];
            }
            let actionRow = actionForLiveMessage({
              connectionId: mailbox.connectionId,
              messageId: item.matchedItem?.id || item.id,
              threadId: item.threadId,
              byMessage,
              byThread,
            });
            if (args.view === "handled" || args.view === "noise") {
              const latestActionRow = applyReferencedWorkspaceCorrection({
                item,
                actionRow: actionForLiveMessage({
                  connectionId: mailbox.connectionId,
                  messageId: item.id,
                  threadId: item.threadId,
                  byMessage,
                  byThread,
                }),
                corrections: referencedCorrections,
              });
              if (
                latestActionRow &&
                !actionMatchesWorkspaceView(latestActionRow, args.view)
              ) {
                return [];
              }
              if (item.matchedItem && item.matchedItem.id !== item.id) {
                // A genuinely newer reply reopens the conversation. A reply
                // that already existed when the user acted inherits that
                // correction even when Gmail split it into another mailbox.
                if (!latestActionRow) return [];
                routedItem = item;
                direction = gmailItemDirection(routedItem, ownedAddresses);
              }
              if (latestActionRow) actionRow = latestActionRow;
            }
            if (args.view === "focus" || args.view === "inbox") {
              // A pending action belongs to the exact incoming Gmail message
              // that created it. Keep it visible while the latest message is
              // the user's reply, then promote a newer incoming reply to the
              // card so its preview and unread state stay current.
              routedItem = focusInboxCardMessage({
                item,
                actionRow,
                ownedAddresses,
              });
              direction = gmailItemDirection(routedItem, ownedAddresses);
              actionRow = applyReferencedWorkspaceCorrection({
                item: routedItem,
                actionRow,
                corrections: referencedCorrections,
              });
              const destination = gmailInboxConversationView({
                item: routedItem,
                actionRow,
                direction,
              });
              if (destination === "inbox") {
                needsReviewItems.push(
                  summaryFromGmail(
                    routedItem,
                    publicIdentity,
                    actionRow,
                    { direction },
                  ),
                );
              }
              if (destination !== args.view) {
                if (
                  args.view === "inbox" ||
                  text(
                    record(actionRow?.metadata)
                      .email_workspace_user_action,
                  ) === "referenced_conversation_correction"
                ) {
                  const correctedAt = text(
                    record(actionRow?.metadata)
                      .email_workspace_corrected_at,
                  );
                  removedConversations.push({
                    id: `${mailbox.connectionId}:${item.threadId || item.id}`,
                    correctedAt:
                      correctedAt ||
                      routedItem.internalDate ||
                      item.date ||
                      new Date().toISOString(),
                  });
                }
                return [];
              }
            }
            const summary = summaryFromGmail(
              routedItem,
              publicIdentity,
              actionRow,
              { direction },
            );
            return [summary];
          });
          return {
            connectionId: mailbox.connectionId,
            nextPageToken: result.nextPageToken,
            items,
            needsReviewItems,
            removedConversations,
          };
        } catch (error) {
          if (error instanceof GmailApiError && error.status === 429) {
            providerRetryAfterMs = Math.max(
              providerRetryAfterMs,
              Math.max(1_000, error.retryAfterMs || 7_000),
            );
          }
          const details = error instanceof Error ? error.message : "";
          const needsReauth =
            /authorization|required|reauth|expired|invalid.*token|insufficient.*scope|\\b401\\b|\\b403\\b/i.test(
              details,
            );
          syncProblems.set(mailbox.connectionId, {
            status: needsReauth ? "reauth_required" : "error",
            message: needsReauth
              ? "Reconnect this mailbox to resume syncing."
              : "This mailbox could not sync. Try again in a moment.",
          });
          return {
            connectionId: mailbox.connectionId,
            nextPageToken: null,
            items: [] as EmailThreadSummary[],
            needsReviewItems: [] as EmailThreadSummary[],
            removedConversations: [] as Array<{
              id: string;
              correctedAt: string;
            }>,
          };
        }
      }),
    );
    const gmail = Object.fromEntries(
      live.map((result) => [
        result.connectionId,
        result.nextPageToken,
      ]),
    );
    if (Object.values(gmail).some(Boolean)) {
      nextCursor = encodeFeedCursor({
        v: 1,
        view: args.view,
        connectionId: args.connectionId || null,
        gmail,
      });
    }
    threads = live.flatMap((result) => result.items);
    if (args.view === "focus" || args.view === "inbox") {
      liveNeedsReviewCount = dedupeEmailConversationSummaries(
        live.flatMap((result) => result.needsReviewItems),
      ).length;
    }
    liveConversationRemovals = live.flatMap(
      (result) => result.removedConversations,
    );
    if (args.view === "focus" && !previousGmailCursor) {
      const liveConversationIds = new Set(
        threads.map(
          (thread) => `${thread.connectionId}:${thread.threadId}`,
        ),
      );
      const mailboxByConnection = new Map(
        included.map((mailbox) => [mailbox.connectionId, mailbox]),
      );
      // Most Focus queues are small. Verify only candidates absent from the
      // live Gmail page and keep recovery within a bounded provider budget.
      // Recovery must use the complete skinny action index. The richer card
      // query is intentionally capped at 250 rows, so using it here makes an
      // explicit Focus choice disappear as soon as enough newer mail arrives.
      const missingFocusCandidates = latestActionStatRows
        .filter((row) => actionMatchesWorkspaceView(row, "focus"))
        .filter((row) => {
          const connectionId = text(row.connection_id);
          const threadId =
            text(row.gmail_thread_id) || text(row.gmail_message_id);
          const mailbox = mailboxByConnection.get(connectionId);
          return (
            Boolean(threadId) &&
            mailbox?.status === "connected" &&
            !liveConversationIds.has(`${connectionId}:${threadId}`)
          );
        });
      const candidates = selectFocusRecoveryCandidates(
        missingFocusCandidates,
        args.limit,
      );
      const richActionIds = new Set(actionRows.map((row) => text(row.id)));
      const missingCandidateIds = candidates
        .map((row) => text(row.id))
        .filter((id) => id && !richActionIds.has(id));
      let recoveryRichRows = actionRows;
      if (missingCandidateIds.length > 0) {
        let recoveryQuery = args.supabase
          .from("inbox_actions")
          .select("*")
          .eq("user_id", args.userId)
          .eq("provider", "gmail")
          .in("id", missingCandidateIds);
        if (args.signal) recoveryQuery = recoveryQuery.abortSignal(args.signal);
        const recoveryResult = await recoveryQuery;
        if (!recoveryResult.error) {
          recoveryRichRows = [
            ...actionRows,
            ...(recoveryResult.data || []).map((row) => record(row)),
          ];
        }
      }
      const hydratedCandidates = emailActionHydrationRows(
        candidates,
        recoveryRichRows,
      );
      const verified = await mapWithConcurrency(
        hydratedCandidates,
        4,
        async (row) => {
          const connectionId = text(row.connection_id);
          const threadId =
            text(row.gmail_thread_id) || text(row.gmail_message_id);
          const mailbox = mailboxByConnection.get(connectionId);
          if (!mailbox || !threadId) return null;
          try {
            const items = await fetchGmailThreadItems({
              mailbox,
              threadId,
              signal: args.signal,
            });
            return providerVerifiedFocusSummary({
              items,
              mailbox: publicMailbox(mailbox),
              ownedAddresses,
              actionRow: row,
            });
          } catch {
            // A candidate is never trusted when Gmail cannot verify it.
            return null;
          }
        },
      );
      threads.push(
        ...verified.filter(
          (item): item is EmailThreadSummary => item !== null,
        ),
      );
    }
    if (
      emailViewUsesIndexedActionFallback(args.view) &&
      !previousGmailCursor
    ) {
      // Processed views keep their indexed history while Gmail reconciles the
      // current labels. Focus stays exclusively Gmail-backed so an archived
      // conversation cannot reappear from an old classifier record.
      const fallbackRows = latestActionRows
        .filter((row) => actionMatchesWorkspaceView(row, args.view))
        .map((row) => {
          const mailbox = mailboxById.get(text(row.connection_id));
          return mailbox ? summaryFromAction(row, mailbox) : null;
        })
        .filter((item): item is EmailThreadSummary => item !== null)
        .sort(compareEmailThreadSummaries)
        .slice(0, args.limit || 50);
      threads.push(...fallbackRows);
    }
  } else {
    const snapshotActionRows =
      args.liveSync === false && args.view === "all"
        ? latestActionRows
        : latestActionRows.filter((row) =>
            actionMatchesWorkspaceView(row, args.view),
          );
    threads = snapshotActionRows
      .map((row) => {
        const mailbox = mailboxById.get(text(row.connection_id));
        return mailbox ? summaryFromAction(row, mailbox) : null;
      })
      .filter((item): item is EmailThreadSummary => item !== null);
    if (
      args.liveSync === false &&
      (args.view === "sent" || args.view === "all")
    ) {
      threads.push(
        ...trackingRows
          .filter(
            (row) =>
              record(row.metadata)[
                EMAIL_TRACKING_RECIPIENT_RECORD_KEY
              ] !== true,
          )
          .map((row) => {
            const mailbox = mailboxById.get(text(row.connection_id));
            return mailbox ? summaryFromTrackingRow(row, mailbox) : null;
          })
          .filter((item): item is EmailThreadSummary => item !== null),
      );
    }
  }

  const dedupedFeed = dedupeEmailConversationSummariesDetailed(threads);
  const sortedThreads = dedupedFeed.threads.sort(
    emailThreadSummaryComparatorForView(args.view),
  );
  const duplicateMailboxCopyRemovals = dedupedFeed.suppressedMailboxCopies.map(
    (thread) => ({
      id: `${thread.connectionId}:${thread.threadId}`,
      correctedAt: new Date().toISOString(),
    }),
  );
  const limit = args.limit || 50;
  if (gmailQuery) {
    // Each mailbox page is fetched exactly once. Keep the small rounding
    // surplus so no message gets skipped when several mailboxes are merged.
    threads = sortedThreads;
  } else {
    const offset = Math.max(0, cursor?.offset || 0);
    threads = sortedThreads.slice(offset, offset + limit);
    if (offset + limit < sortedThreads.length) {
      nextCursor = encodeFeedCursor({
        v: 1,
        view: args.view,
        connectionId: args.connectionId || null,
        offset: offset + limit,
      });
    }
    const comparator = emailThreadSummaryComparatorForView(args.view);
    threads =
      args.liveSync === false
        ? threads.sort(comparator)
        : (
            await hydrateLatestConversationSummaries({
              summaries: threads,
              mailboxes: included,
              ownedAddresses,
              signal: args.signal,
            })
          ).sort(comparator);
  }

  const countsByConnection = new Map<
    string,
    { inbox: number; focus: number; drafts: number; noise: number }
  >();
  for (const mailbox of included) {
    countsByConnection.set(mailbox.connectionId, {
      inbox: 0,
      focus: 0,
      drafts: 0,
      noise: 0,
    });
  }
  for (const row of latestActionStatRows) {
    const counts = countsByConnection.get(text(row.connection_id));
    if (!counts) continue;
    const lane = inferredLane(row);
    if (lane === "noise") counts.noise += 1;
  }
  for (const row of latestActionRows) {
    const counts = countsByConnection.get(text(row.connection_id));
    if (!counts) continue;
    const lane = inferredLane(row);
    if (lane === "ready" || lane === "read") counts.focus += 1;
    if (lane === "ready") counts.drafts += 1;
  }
  if (args.view === "focus") {
    const liveFocusByConnection = new Map<string, number>();
    for (const thread of threads) {
      liveFocusByConnection.set(
        thread.connectionId,
        (liveFocusByConnection.get(thread.connectionId) || 0) + 1,
      );
    }
    for (const [connectionId, liveCount] of liveFocusByConnection) {
      const counts = countsByConnection.get(connectionId);
      if (counts) counts.focus = Math.max(counts.focus, liveCount);
    }
  }
  if (args.view === "inbox") {
    for (const thread of threads) {
      const counts = countsByConnection.get(thread.connectionId);
      if (counts) counts.inbox += 1;
    }
  }

  const mailboxes = args.mailboxes.map((mailbox) => {
    const publicIdentity = publicMailbox(
      mailbox,
      countsByConnection.get(mailbox.connectionId),
    );
    const syncProblem = syncProblems.get(mailbox.connectionId);
    return syncProblem
      ? {
          ...publicIdentity,
          status: syncProblem.status,
          statusMessage: syncProblem.message,
        }
      : publicIdentity;
  });
  const stats = emailFeedStats({
    materializedRows: latestActionRows,
    allRows: latestActionStatRows,
    liveNeedsReviewCount,
  });
  if (args.view === "focus") {
    const suppressedFocus = dedupedFeed.suppressedMailboxCopies.filter(
      (thread) =>
        thread.action?.lane === "ready" ||
        thread.action?.lane === "read",
    ).length;
    const suppressedDrafts = dedupedFeed.suppressedMailboxCopies.filter(
      (thread) => thread.action?.lane === "ready",
    ).length;
    stats.focus = Math.max(
      threads.length,
      Math.max(0, stats.focus - suppressedFocus),
    );
    stats.draftsReady = Math.max(
      threads.filter((thread) => thread.action?.lane === "ready").length,
      Math.max(0, stats.draftsReady - suppressedDrafts),
    );
  }
  return {
    schemaVersion: EMAIL_FEED_SCHEMA_VERSION,
    view: args.view,
    mailboxes,
    threads,
    nextCursor,
    ...(providerRetryAfterMs > 0 ? { providerRetryAfterMs } : {}),
    authoritativeRemovedConversations: [
      ...authoritativeEmailConversationRemovals(
        effectiveActionStatRows,
        args.view,
      ),
      ...(actionDelta
        ? emailActionStateConversationRemovals(
            effectiveActionStatRows,
            args.view,
          )
        : []),
      ...liveConversationRemovals,
      ...duplicateMailboxCopyRemovals,
    ],
    warnings: Array.from(syncProblems.entries()).map(([connectionId, problem]) => {
      const mailbox = args.mailboxes.find(
        (item) => item.connectionId === connectionId,
      );
      return `${mailbox?.displayName || mailbox?.address || "A mailbox"}: ${problem.message}`;
    }),
    stats,
  };
}

export async function loadEmailOpenStatusForThread(args: {
  supabase: SupabaseClient;
  userId: string;
  connectionId: string;
  threadId: string;
  messageId?: string | null;
}): Promise<EmailOpenStatus | null> {
  const result = await args.supabase
    .from("inbox_actions")
    .select("id,gmail_message_id,gmail_thread_id,metadata,created_at")
    .eq("user_id", args.userId)
    .eq("provider", "gmail")
    .eq("connection_id", args.connectionId)
    .eq("gmail_thread_id", args.threadId)
    .contains("metadata", { email_tracking_record: true })
    .order("created_at", { ascending: false })
    .limit(500);
  if (result.error) return null;
  const rows = (result.data || []).map((row) => record(row));
  const requestedMessageId = text(args.messageId);
  const matched = rows.find((row) => {
      const metadata = record(row.metadata);
      return (
        requestedMessageId &&
        (text(metadata.email_tracking_sent_message_id) ||
          text(row.gmail_message_id)) === requestedMessageId
      );
    });
  const parentId = text(matched?.id);
  const relatedRows = matched
    ? rows.filter((row) => {
        const metadata = record(row.metadata);
        return (
          row === matched ||
          (metadata[EMAIL_TRACKING_RECIPIENT_RECORD_KEY] === true &&
            text(metadata.email_tracking_parent_record_id) === parentId)
        );
      })
    : rows;
  return emailOpenStatusFromTrackingRows(relatedRows);
}

export async function loadActionDraft(args: {
  supabase: SupabaseClient;
  userId: string;
  actionId: string;
  mailbox: EmailMailboxConnection;
}): Promise<EmailDraft | null> {
  const { data, error } = await args.supabase
    .from("inbox_actions")
    .select("*")
    .eq("id", args.actionId)
    .eq("user_id", args.userId)
    .eq("connection_id", args.mailbox.connectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = record(data);
  const stored = draftFromRow(row, {
    ownedAddresses: [args.mailbox.address],
  });
  if (!stored?.draftId) return stored;
  const live = await fetchGmailDraft({
    mailbox: args.mailbox,
    draftId: stored.draftId,
    actionId: stored.actionId,
    aiGenerated: true,
    untouched: stored.untouched,
  });
  const safeLiveRecipients = live
    ? sanitizeAutomaticRecipientFields({
        to: live.to,
        cc: live.cc,
        bcc: live.bcc,
        ownedAddresses: [
          args.mailbox.address,
          ...stringArray(record(row.metadata).owned_addresses),
        ],
      })
    : null;
  return live
    ? {
        ...live,
        ...safeLiveRecipients,
        bodyHtml: stored.bodyHtml || live.bodyHtml,
        attachments: stored.attachments,
      }
    : stored;
}
