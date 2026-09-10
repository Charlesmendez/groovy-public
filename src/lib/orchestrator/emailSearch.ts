import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GmailApiError,
  loadGmailMailboxes,
  listGmailThreads,
  type EmailMailboxConnection,
  type GmailThreadListItem,
  type GmailThreadListResult,
} from "@/lib/email/gmail";

export const DEFAULT_CONNECTED_GMAIL_QUERY =
  "in:inbox is:unread newer_than:1d -from:me";
export const MAX_CONNECTED_GMAIL_RESULTS = 25;

const DEFAULT_RESULT_LIMIT = 10;
const MAILBOX_CONCURRENCY = 3;
const MAX_QUERY_LENGTH = 512;

export type ConnectedGmailSearchWarningCode =
  | "mailbox_not_found"
  | "mailbox_needs_reauth"
  | "mailbox_unavailable"
  | "no_mailboxes"
  | "no_included_mailboxes"
  | "query_truncated"
  | "results_truncated";

export type ConnectedGmailSearchWarning = {
  code: ConnectedGmailSearchWarningCode;
  message: string;
  mailbox?: {
    connectionId: string;
    displayName: string;
    address: string;
  };
};

export type ConnectedGmailSearchMessage = {
  id: string;
  threadId: string;
  mailbox: {
    connectionId: string;
    displayName: string;
    address: string;
  };
  from: string;
  subject: string;
  receivedAt: string;
  snippet: string;
  unread: boolean;
  hasAttachments: boolean;
};

export type ConnectedGmailSearchMailboxResult = {
  connectionId: string;
  displayName: string;
  address: string;
  status: "ok" | "error";
  estimatedMatches: number;
  returnedMessages: number;
  hasMore: boolean;
};

export type ConnectedGmailSearchResult = {
  provider: "gmail";
  query: string;
  counts: {
    configuredMailboxes: number;
    selectedMailboxes: number;
    successfulMailboxes: number;
    failedMailboxes: number;
    estimatedMatches: number;
    returnedMessages: number;
    unreadMessages: number;
  };
  messages: ConnectedGmailSearchMessage[];
  mailboxes: ConnectedGmailSearchMailboxResult[];
  warnings: ConnectedGmailSearchWarning[];
  partial: boolean;
};

export type ConnectedGmailSearchDependencies = {
  loadGmailMailboxes: (args: {
    supabase: SupabaseClient;
    userId: string;
    verifyProfile?: boolean;
  }) => Promise<EmailMailboxConnection[]>;
  listGmailThreads: (args: {
    mailbox: EmailMailboxConnection;
    query?: string;
    maxResults?: number;
    signal?: AbortSignal;
    latestInThread?: boolean;
    detailConcurrency?: number;
    priority?: "interactive";
  }) => Promise<GmailThreadListResult>;
};

const defaultDependencies: ConnectedGmailSearchDependencies = {
  loadGmailMailboxes,
  listGmailThreads,
};

function publicMailbox(mailbox: EmailMailboxConnection) {
  return {
    connectionId: mailbox.connectionId,
    displayName: mailbox.displayName,
    address: mailbox.address,
  };
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_RESULT_LIMIT;
  return Math.min(
    MAX_CONNECTED_GMAIL_RESULTS,
    Math.max(1, Math.floor(value as number)),
  );
}

function messageTimestamp(item: GmailThreadListItem): number {
  const matched = item.matchedItem || item;
  const numeric = Number(matched.internalDate);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(matched.internalDate || matched.date);
  return Number.isFinite(parsed) ? parsed : 0;
}

function receivedAt(item: GmailThreadListItem): string {
  const timestamp = messageTimestamp(item);
  const matched = item.matchedItem || item;
  return timestamp > 0
    ? new Date(timestamp).toISOString()
    : matched.internalDate || matched.date;
}

function publicMessage(
  mailbox: EmailMailboxConnection,
  item: GmailThreadListItem,
): ConnectedGmailSearchMessage {
  // latestInThread keeps one result per conversation, while matchedItem is the
  // exact message that satisfied the Gmail query. Surface the match so a
  // search for unread mail cannot accidentally describe a later sent reply.
  const matched = item.matchedItem || item;
  return {
    id: matched.id,
    threadId: item.threadId || matched.threadId,
    mailbox: publicMailbox(mailbox),
    from: matched.from,
    subject: matched.subject,
    receivedAt: receivedAt(item),
    snippet: matched.snippet,
    unread: matched.labelIds.some(
      (label) => label.trim().toUpperCase() === "UNREAD",
    ),
    hasAttachments: matched.hasAttachments,
  };
}

function mailboxFailureWarning(
  mailbox: EmailMailboxConnection,
  error: unknown,
): ConnectedGmailSearchWarning {
  const needsReauth =
    mailbox.status === "reauth_required" ||
    (error instanceof GmailApiError && error.needsReauth);
  return {
    code: needsReauth ? "mailbox_needs_reauth" : "mailbox_unavailable",
    message: needsReauth
      ? `${mailbox.displayName || mailbox.address || "A Gmail mailbox"} needs to be reconnected before it can be searched.`
      : `${mailbox.displayName || mailbox.address || "A Gmail mailbox"} could not be searched right now.`,
    mailbox: publicMailbox(mailbox),
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(values.length, Math.max(1, concurrency)) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await fn(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function searchConnectedGmail(
  args: {
    supabase: SupabaseClient;
    userId: string;
    query?: string;
    connectionIds?: string[];
    limit?: number;
    signal?: AbortSignal;
  },
  dependencies: ConnectedGmailSearchDependencies = defaultDependencies,
): Promise<ConnectedGmailSearchResult> {
  const warnings: ConnectedGmailSearchWarning[] = [];
  const rawQuery = args.query?.trim() || DEFAULT_CONNECTED_GMAIL_QUERY;
  const query = rawQuery.slice(0, MAX_QUERY_LENGTH);
  if (query.length !== rawQuery.length) {
    warnings.push({
      code: "query_truncated",
      message: `The Gmail search query was shortened to ${MAX_QUERY_LENGTH} characters.`,
    });
  }
  const limit = boundedLimit(args.limit);
  const allMailboxes = await dependencies.loadGmailMailboxes({
    supabase: args.supabase,
    userId: args.userId,
    verifyProfile: false,
  });
  const requestedIds = Array.from(
    new Set(
      (args.connectionIds || [])
        .map((connectionId) => connectionId.trim())
        .filter(Boolean),
    ),
  );
  const mailboxById = new Map(
    allMailboxes.map((mailbox) => [mailbox.connectionId, mailbox]),
  );
  const selectedMailboxes =
    requestedIds.length > 0
      ? requestedIds
          .map((connectionId) => mailboxById.get(connectionId))
          .filter(
            (mailbox): mailbox is EmailMailboxConnection => Boolean(mailbox),
          )
      : allMailboxes.filter((mailbox) => mailbox.includedInUnified);

  for (const connectionId of requestedIds) {
    if (mailboxById.has(connectionId)) continue;
    warnings.push({
      code: "mailbox_not_found",
      message: "One requested Gmail mailbox is not available to this account.",
    });
  }
  if (allMailboxes.length === 0) {
    warnings.push({
      code: "no_mailboxes",
      message: "No Gmail mailboxes are connected.",
    });
  } else if (selectedMailboxes.length === 0 && requestedIds.length === 0) {
    warnings.push({
      code: "no_included_mailboxes",
      message: "No Gmail mailboxes are included in the unified inbox.",
    });
  }

  const perMailboxLimit = Math.min(
    MAX_CONNECTED_GMAIL_RESULTS,
    Math.max(1, Math.ceil(limit / Math.max(1, selectedMailboxes.length)) + 1),
  );
  type MailboxAttempt =
    | {
        mailbox: EmailMailboxConnection;
        status: "ok";
        result: GmailThreadListResult;
      }
    | {
        mailbox: EmailMailboxConnection;
        status: "error";
        warning: ConnectedGmailSearchWarning;
      };
  const attempts = await mapWithConcurrency(
    selectedMailboxes,
    MAILBOX_CONCURRENCY,
    async (mailbox): Promise<MailboxAttempt> => {
      try {
        const result = await dependencies.listGmailThreads({
          mailbox,
          query,
          maxResults: perMailboxLimit,
          signal: args.signal,
          latestInThread: true,
          detailConcurrency: 3,
          priority: "interactive",
        });
        return { mailbox, status: "ok", result };
      } catch (error) {
        if (
          args.signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          throw error;
        }
        return {
          mailbox,
          status: "error",
          warning: mailboxFailureWarning(mailbox, error),
        };
      }
    },
  );

  const successful = attempts.filter(
    (attempt): attempt is Extract<MailboxAttempt, { status: "ok" }> =>
      attempt.status === "ok",
  );
  const failed = attempts.filter(
    (attempt): attempt is Extract<MailboxAttempt, { status: "error" }> =>
      attempt.status === "error",
  );
  warnings.push(...failed.map((attempt) => attempt.warning));

  const allMessages = successful
    .flatMap((attempt) =>
      attempt.result.items.map((item) => ({
        timestamp: messageTimestamp(item),
        message: publicMessage(attempt.mailbox, item),
      })),
    )
    .sort((left, right) => right.timestamp - left.timestamp);
  const messages = allMessages.slice(0, limit).map(({ message }) => message);
  const estimatedMatches = successful.reduce(
    (total, attempt) => total + Math.max(0, attempt.result.resultSizeEstimate),
    0,
  );
  const truncated =
    allMessages.length > messages.length ||
    successful.some(
      (attempt) =>
        Boolean(attempt.result.nextPageToken) ||
        attempt.result.resultSizeEstimate > attempt.result.items.length,
    );
  if (truncated) {
    warnings.push({
      code: "results_truncated",
      message: `Only the ${messages.length} most recent matching messages are included.`,
    });
  }

  return {
    provider: "gmail",
    query,
    counts: {
      configuredMailboxes: allMailboxes.length,
      selectedMailboxes: selectedMailboxes.length,
      successfulMailboxes: successful.length,
      failedMailboxes: failed.length,
      estimatedMatches,
      returnedMessages: messages.length,
      unreadMessages: messages.filter((message) => message.unread).length,
    },
    messages,
    mailboxes: attempts.map((attempt) =>
      attempt.status === "ok"
        ? {
            ...publicMailbox(attempt.mailbox),
            status: "ok" as const,
            estimatedMatches: Math.max(
              0,
              attempt.result.resultSizeEstimate,
            ),
            returnedMessages: attempt.result.items.length,
            hasMore:
              Boolean(attempt.result.nextPageToken) ||
              attempt.result.resultSizeEstimate > attempt.result.items.length,
          }
        : {
            ...publicMailbox(attempt.mailbox),
            status: "error" as const,
            estimatedMatches: 0,
            returnedMessages: 0,
            hasMore: false,
          },
    ),
    warnings,
    partial:
      failed.length > 0 ||
      truncated ||
      requestedIds.some((connectionId) => !mailboxById.has(connectionId)) ||
      query.length !== rawQuery.length,
  };
}
