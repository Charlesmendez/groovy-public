export type EmailView =
  | "focus"
  | "inbox"
  | "sent"
  | "noise"
  | "handled"
  | "all";

export type EmailActionType =
  | "draft_reply"
  | "mark_spam"
  | "unsubscribe"
  | "archive"
  | "label_only";

export type EmailActionStatus =
  | "pending"
  | "approved"
  | "executing"
  | "done"
  | "rejected"
  | "failed";

export type EmailFocusLane = "ready" | "decide" | "read" | "noise" | "handled";

export type EmailMailbox = {
  connectionId: string;
  provider: "gmail";
  address: string;
  displayName: string;
  color: string;
  monogram: string;
  isDefaultSender: boolean;
  includedInUnified: boolean;
  aiInstructions: string;
  status: "connected" | "reauth_required" | "error";
  statusMessage?: string;
  counts: {
    inbox: number;
    focus: number;
    drafts: number;
    noise: number;
  };
};

export type EmailActionState = {
  id: string;
  type: EmailActionType;
  status: EmailActionStatus;
  lane: EmailFocusLane;
  confidence: number | null;
  important: number | null;
  spam: number | null;
  actionable: number | null;
  critical: boolean;
  reason: string;
  summary: string;
  keyAsk: string;
  deadline: string | null;
  aiGenerated: boolean;
  model: string | null;
};

export type EmailDraft = {
  actionId: string | null;
  draftId: string | null;
  connectionId: string;
  threadId: string | null;
  sourceMessageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyHtml: string | null;
  attachments: EmailDraftAttachment[];
  aiGenerated: boolean;
  untouched: boolean;
  updatedAt: string | null;
  inReplyTo?: string | null;
  references?: string | null;
};

export type EmailDraftAttachment = {
  id: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  size: number;
  disposition: "attachment" | "inline";
  contentId: string | null;
};

export type EmailOpenStatus = {
  recipients: string[];
  attribution: "single_recipient" | "group" | "recipient_specific";
  openedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
  recipientStatuses?: Array<{
    recipient: string;
    openedAt: string | null;
    lastOpenedAt: string | null;
    openCount: number;
  }>;
};

export type EmailCalendarResponseStatus =
  | "needsAction"
  | "accepted"
  | "tentative"
  | "declined";

export type EmailCalendarInvite = {
  title: string;
  responseStatus: EmailCalendarResponseStatus;
  respondedAt: string | null;
  eventId: string | null;
  iCalUid: string | null;
  start: string | null;
  end: string | null;
  timeZone: string | null;
  location: string | null;
  htmlLink: string | null;
};

export type EmailReplyTarget = {
  to: string[];
  cc: string[];
  subject: string;
  inReplyTo: string | null;
  references: string | null;
};

export type EmailThreadSummary = {
  key: string;
  connectionId: string;
  mailbox: EmailMailbox;
  messageId: string;
  threadId: string;
  /** Normalized RFC Message-ID used to collapse one delivery across mailboxes. */
  internetMessageId?: string;
  /** Exact To recipients, kept separate from Cc for canonical mailbox choice. */
  toRecipients?: string[];
  senderName: string;
  senderEmail: string;
  recipients: string[];
  subject: string;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  direction: "incoming" | "outgoing";
  openStatus: EmailOpenStatus | null;
  calendarInvite: EmailCalendarInvite | null;
  action: EmailActionState | null;
  draft: EmailDraft | null;
};

export type EmailSearchMatchField =
  | "sender"
  | "recipient"
  | "subject"
  | "content"
  | "mailbox";

export type EmailSearchResult = EmailThreadSummary & {
  searchScore: number;
  matchedFields: EmailSearchMatchField[];
};

export type EmailSearchResponse = {
  query: string;
  results: EmailSearchResult[];
  searchedMailboxCount: number;
  totalMailboxCount: number;
  warnings: string[];
  partial: boolean;
};

export type EmailMessage = {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  sentAt: string;
  body: string;
  htmlBody: string | null;
  /** True when an unusually large message was compacted for browser transport. */
  contentTruncated?: boolean;
  snippet: string;
  isFromUser: boolean;
  reply: EmailReplyTarget;
  replyAll: EmailReplyTarget;
  attachments: Array<{
    id: string;
    partId?: string;
    filename: string;
    mimeType: string;
    size: number;
    contentId?: string;
    inline?: boolean;
  }>;
};

export type EmailContactSuggestion = {
  email: string;
  name: string;
  lastContactAt: string;
  mailboxAddress: string;
  mailboxDisplayName: string;
};

export type EmailThreadDetail = {
  summary: EmailThreadSummary;
  messages: EmailMessage[];
  replyAll: {
    to: string[];
    cc: string[];
    subject: string;
    inReplyTo: string | null;
    references: string | null;
  };
  draft: EmailDraft | null;
};

export type EmailSnippet = {
  id: string;
  name: string;
  shortcut: string;
  mailboxConnectionIds: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export const EMAIL_FEED_SCHEMA_VERSION = 4 as const;

export type EmailFeedResponse = {
  schemaVersion: typeof EMAIL_FEED_SCHEMA_VERSION;
  view: EmailView;
  mailboxes: EmailMailbox[];
  threads: EmailThreadSummary[];
  nextCursor: string | null;
  warnings: string[];
  /**
   * Internal coordination hint. A live feed can still return a useful partial
   * response when one mailbox is throttled; the route uses this value to
   * establish a shared provider cooldown instead of immediately retrying from
   * another serverless worker.
   */
  providerRetryAfterMs?: number;
  authoritativeRemovedConversations?: Array<{
    id: string;
    correctedAt: string;
  }>;
  stats: {
    focus: number;
    processed: number;
    draftsReady: number;
    needsReview: number;
    noiseCaught: number;
  };
};
