import type { EmailWorkspaceOperation } from "@/lib/email/interactions";
import type {
  EmailFeedResponse,
  EmailMailbox,
  EmailThreadSummary,
  EmailView,
} from "@/lib/email/types";

export function supportsProgressiveEmailSnapshot(view: EmailView): boolean {
  return (
    view === "sent" ||
    view === "noise" ||
    view === "handled" ||
    view === "all"
  );
}

export function canHydrateEmailFeedFromCache(view: EmailView): boolean {
  // Every queue paints its last valid snapshot immediately, then revalidates
  // in the background. A briefly stale card is less disruptive than blanking
  // the entire workspace behind a loader, especially after a mobile push.
  void view;
  return true;
}

export function emailFeedNavigationAction(args: {
  view: EmailView;
  hasCachedFeed: boolean;
  renderedInSession: boolean;
  restoredNavigation: boolean;
  cachedSavedAt: number | null;
  now: number;
  refreshCooldownMs: number;
}): "foreground" | "reuse" | "refresh" {
  if (!args.hasCachedFeed) return "foreground";
  if (args.restoredNavigation) return "refresh";
  if (!args.renderedInSession) {
    return canHydrateEmailFeedFromCache(args.view)
      ? "refresh"
      : "foreground";
  }
  const savedAt = args.cachedSavedAt;
  if (savedAt === null || !Number.isFinite(savedAt)) return "refresh";
  return args.now - savedAt >= args.refreshCooldownMs
    ? "refresh"
    : "reuse";
}

export function emailFeedResumeAction(args: {
  currentKey: string | null;
  renderedKey: string | null;
  lastRequestAt: number;
  now: number;
  refreshCooldownMs: number;
}): "not-rendered" | "reuse" | "refresh" {
  if (!args.currentKey || args.renderedKey !== args.currentKey) {
    return "not-rendered";
  }
  return args.now - args.lastRequestAt >= args.refreshCooldownMs
    ? "refresh"
    : "reuse";
}

export function shouldAutoLoadEmailFeed(view: EmailView): boolean {
  // Active inbox queues use deliberate pagination. Otherwise a short first
  // page keeps the sentinel visible, repeatedly appending old pages that the
  // next first-page refresh removes again.
  return view !== "focus" && view !== "inbox";
}

export function emailFeedAutoLoadThreshold(view: EmailView): number {
  // All Mail pages require Gmail metadata hydration for every row. Begin the
  // next page several viewports early so the bounded provider fan-out can
  // finish while the user is still reading the current page.
  return view === "all" ? 2_400 : 360;
}

export function emailFeedPageSize(view: EmailView): number {
  // A unified All Mail page fans out to every connected mailbox and then
  // hydrates every Gmail message. Smaller progressive pages return in fewer
  // request waves; early prefetching keeps the total scroll depth seamless.
  return view === "all" ? 12 : 24;
}

export function nextAutoLoadedEmailFeedDepth(args: {
  currentDepth: number;
  loadedThreadCount: number;
  pageSize: number;
}): number {
  const currentDepth = Number.isFinite(args.currentDepth)
    ? Math.max(0, Math.floor(args.currentDepth))
    : 0;
  const loadedThreadCount = Number.isFinite(args.loadedThreadCount)
    ? Math.max(0, Math.floor(args.loadedThreadCount))
    : 0;
  const pageSize = Number.isFinite(args.pageSize)
    ? Math.max(1, Math.floor(args.pageSize))
    : 1;
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(currentDepth, loadedThreadCount) + pageSize,
  );
}

export function shouldLoadMoreEmailNearScrollEnd(args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  threshold?: number;
}): boolean {
  if (
    !Number.isFinite(args.scrollTop) ||
    !Number.isFinite(args.scrollHeight) ||
    !Number.isFinite(args.clientHeight)
  ) {
    return false;
  }
  const threshold = Number.isFinite(args.threshold)
    ? Math.max(0, Number(args.threshold))
    : 360;
  return (
    args.scrollHeight - args.scrollTop - args.clientHeight <= threshold
  );
}

type EmailFeedRequestIdentity = {
  requestId: number;
  mutationVersion: number;
  view: EmailView | "snippets";
  connectionId: string | null;
};

export function isCurrentEmailFeedRequest(
  request: EmailFeedRequestIdentity,
  current: EmailFeedRequestIdentity,
): boolean {
  return (
    request.requestId === current.requestId &&
    request.mutationVersion === current.mutationVersion &&
    request.view === current.view &&
    request.connectionId === current.connectionId
  );
}

function clampCount(value: number): number {
  return Math.max(0, value);
}

const EXCLUSIVE_EMAIL_QUEUE_VIEWS = new Set<EmailView>([
  "focus",
  "inbox",
  "noise",
  "handled",
]);

function compareByReceivedAt(
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
  return received || a.key.localeCompare(b.key);
}

/**
 * Gmail has already accepted this message, so it is safe to place it in the
 * local Sent snapshot before the slower authoritative mailbox refresh. The
 * Gmail thread identity keeps replies and retries from creating duplicate
 * cards while the live feed catches up.
 */
export function mergeConfirmedSentThread(
  feed: EmailFeedResponse,
  sent: EmailThreadSummary,
  limit = 96,
): EmailFeedResponse {
  if (feed.view !== "sent" || sent.direction !== "outgoing") return feed;
  const sameConversation = (thread: EmailThreadSummary) =>
    thread.connectionId === sent.connectionId &&
    thread.threadId === sent.threadId;
  const existing = feed.threads.find(sameConversation);
  if (existing?.messageId === sent.messageId) return feed;
  return {
    ...feed,
    threads: [sent, ...feed.threads.filter((thread) => !sameConversation(thread))]
      .sort(compareByReceivedAt)
      .slice(0, Math.max(1, limit)),
  };
}

/**
 * Gmail accepted the reply, so its consumed draft can disappear immediately.
 * The conversation itself stays in the current workspace queue until the user
 * explicitly marks it Done or moves it somewhere else.
 */
export function keepSentConversationInFeed(
  feed: EmailFeedResponse,
  sentFrom: Pick<EmailThreadSummary, "connectionId" | "threadId">,
): EmailFeedResponse {
  let clearedReadyCount = 0;
  let clearedDraftCount = 0;
  const threads = feed.threads.map((thread) => {
    if (!sameEmailConversation(thread, sentFrom)) return thread;
    const wasReady = thread.action?.lane === "ready";
    if (!thread.draft && !wasReady) return thread;
    if (thread.draft) clearedDraftCount += 1;
    if (wasReady) clearedReadyCount += 1;
    return {
      ...thread,
      draft: null,
      action: wasReady
        ? { ...thread.action!, lane: "read" as const }
        : thread.action,
    };
  });
  if (
    clearedReadyCount === 0 &&
    clearedDraftCount === 0
  ) {
    return feed;
  }
  return {
    ...feed,
    threads,
    mailboxes: feed.mailboxes.map((mailbox) =>
      mailbox.connectionId === sentFrom.connectionId && clearedDraftCount > 0
        ? {
            ...mailbox,
            counts: {
              ...mailbox.counts,
              drafts: clampCount(mailbox.counts.drafts - clearedDraftCount),
            },
          }
        : mailbox,
    ),
    stats:
      clearedReadyCount > 0
        ? {
            ...feed.stats,
            draftsReady: clampCount(
              feed.stats.draftsReady - clearedReadyCount,
            ),
          }
        : feed.stats,
  };
}

function focusSnapshotRank(summary: EmailThreadSummary): number {
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
  return (
    laneWeight +
    (summary.action?.critical ? 20 : 0) +
    (summary.action?.actionable || 0) * 10
  );
}

function compareFocusSnapshotThreads(
  left: EmailThreadSummary,
  right: EmailThreadSummary,
): number {
  const ranked = focusSnapshotRank(right) - focusSnapshotRank(left);
  return ranked || compareByReceivedAt(left, right);
}

/**
 * A Focus action snapshot is a small delta containing newly classified
 * conversations and/or authoritative removals. Merge it into the last
 * rendered/cached Gmail-verified list so every client can reconcile shared
 * state immediately without hiding the rest of Focus or waiting on Gmail.
 */
export function mergeEmailFocusNotificationSnapshot(
  current: EmailFeedResponse,
  notification: EmailFeedResponse,
  maxThreads: number,
): EmailFeedResponse {
  if (current.view !== "focus" || notification.view !== "focus") {
    return notification;
  }
  const removalByConversation = new Map(
    (notification.authoritativeRemovedConversations || []).map(
      (removal) => [removal.id, Date.parse(removal.correctedAt)],
    ),
  );
  const isRemoved = (thread: EmailThreadSummary) => {
    const removedAt = removalByConversation.get(
      emailConversationIdentity(thread),
    );
    if (removedAt === undefined) return false;
    const receivedAt = Date.parse(thread.receivedAt);
    return (
      !Number.isFinite(removedAt) ||
      !Number.isFinite(receivedAt) ||
      receivedAt <= removedAt
    );
  };
  const retainedCurrent = current.threads.filter(
    (thread) => !isRemoved(thread),
  );
  const removedThreads = current.threads.filter(isRemoved);
  const existingIdentities = new Set(
    retainedCurrent.map(emailConversationIdentity),
  );
  const merged = new Map<string, EmailThreadSummary>();
  for (const thread of retainedCurrent) {
    merged.set(emailConversationIdentity(thread), thread);
  }
  for (const thread of notification.threads) {
    if (isRemoved(thread)) continue;
    merged.set(emailConversationIdentity(thread), thread);
  }
  const newThreads = notification.threads.filter(
    (thread) =>
      !isRemoved(thread) &&
      !existingIdentities.has(emailConversationIdentity(thread)),
  );
  const threads = Array.from(merged.values())
    .sort(compareFocusSnapshotThreads)
    .slice(0, Math.max(1, maxThreads));
  const newReady = newThreads.filter(
    (thread) => thread.action?.lane === "ready",
  ).length;
  const removedReady = removedThreads.filter(
    (thread) => thread.action?.lane === "ready",
  ).length;
  const notificationMailboxById = new Map(
    notification.mailboxes.map((mailbox) => [mailbox.connectionId, mailbox]),
  );
  const currentMailboxIds = new Set(
    current.mailboxes.map((mailbox) => mailbox.connectionId),
  );
  const mergedMailboxes = [
    ...current.mailboxes,
    ...notification.mailboxes.filter(
      (mailbox) => !currentMailboxIds.has(mailbox.connectionId),
    ),
  ];
  const addedByMailbox = new Map<string, { focus: number; drafts: number }>();
  const removedByMailbox = new Map<
    string,
    { focus: number; drafts: number }
  >();
  for (const thread of newThreads) {
    const counts = addedByMailbox.get(thread.connectionId) || {
      focus: 0,
      drafts: 0,
    };
    counts.focus += 1;
    if (thread.action?.lane === "ready") counts.drafts += 1;
    addedByMailbox.set(thread.connectionId, counts);
  }
  for (const thread of removedThreads) {
    const counts = removedByMailbox.get(thread.connectionId) || {
      focus: 0,
      drafts: 0,
    };
    counts.focus += 1;
    if (thread.action?.lane === "ready") counts.drafts += 1;
    removedByMailbox.set(thread.connectionId, counts);
  }
  return {
    ...current,
    mailboxes: mergedMailboxes.map((mailbox) => {
      const latest = notificationMailboxById.get(mailbox.connectionId);
      const added = addedByMailbox.get(mailbox.connectionId);
      const removed = removedByMailbox.get(mailbox.connectionId);
      if (!currentMailboxIds.has(mailbox.connectionId)) {
        return latest || mailbox;
      }
      return {
        ...(latest || mailbox),
        counts: {
          ...(latest?.counts || mailbox.counts),
          focus: Math.max(
            latest?.counts.focus || 0,
            mailbox.counts.focus -
              (removed?.focus || 0) +
              (added?.focus || 0),
          ),
          drafts: Math.max(
            latest?.counts.drafts || 0,
            mailbox.counts.drafts -
              (removed?.drafts || 0) +
              (added?.drafts || 0),
          ),
        },
      };
    }),
    threads,
    stats: {
      ...current.stats,
      focus: Math.max(
        threads.length,
        notification.stats.focus,
        current.stats.focus - removedThreads.length + newThreads.length,
      ),
      draftsReady: Math.max(
        threads.filter((thread) => thread.action?.lane === "ready").length,
        notification.stats.draftsReady,
        current.stats.draftsReady - removedReady + newReady,
      ),
    },
    authoritativeRemovedConversations: Array.from(
      new Map(
        [
          ...(current.authoritativeRemovedConversations || []),
          ...(notification.authoritativeRemovedConversations || []),
        ].map((removal) => [removal.id, removal]),
      ).values(),
    ),
  };
}

function targetViewForOperation(
  operation: EmailWorkspaceOperation,
): EmailView | null {
  if (operation === "archive" || operation === "move_handled") {
    return "handled";
  }
  if (operation === "spam" || operation === "move_noise") return "noise";
  if (operation === "move_focus") return "focus";
  if (operation === "move_inbox") return "inbox";
  return null;
}

function sourceQueueView(
  thread: EmailThreadSummary,
  currentView: EmailView,
): EmailView | null {
  if (
    currentView === "focus" ||
    currentView === "inbox" ||
    currentView === "noise" ||
    currentView === "handled"
  ) {
    return currentView;
  }
  if (thread.action?.lane === "ready" || thread.action?.lane === "read") {
    return "focus";
  }
  if (thread.action?.lane === "decide") return "inbox";
  if (thread.action?.lane === "noise") return "noise";
  if (thread.action?.lane === "handled") return "handled";
  if (thread.direction === "incoming") return "inbox";
  return null;
}

export function applyOptimisticEmailNavigationStats(
  stats: EmailFeedResponse["stats"],
  thread: EmailThreadSummary,
  operation: EmailWorkspaceOperation,
  currentView: EmailView,
): EmailFeedResponse["stats"] {
  const targetView = targetViewForOperation(operation);
  const sourceView = sourceQueueView(thread, currentView);
  if (!targetView || !sourceView || targetView === sourceView) return stats;

  const next = { ...stats };
  if (sourceView === "focus") {
    next.focus = clampCount(next.focus - 1);
    if (thread.action?.lane === "ready") {
      next.draftsReady = clampCount(next.draftsReady - 1);
    }
  } else if (sourceView === "inbox") {
    next.needsReview = clampCount(next.needsReview - 1);
  } else if (sourceView === "handled") {
    next.processed = clampCount(next.processed - 1);
  } else if (sourceView === "noise") {
    next.noiseCaught = clampCount(next.noiseCaught - 1);
  }
  if (targetView === "focus") next.focus += 1;
  if (targetView === "inbox") next.needsReview += 1;
  if (targetView === "handled") next.processed += 1;
  if (targetView === "noise") next.noiseCaught += 1;
  return next;
}

function sameEmailConversation(
  left: Pick<EmailThreadSummary, "connectionId" | "threadId">,
  right: Pick<EmailThreadSummary, "connectionId" | "threadId">,
): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.threadId === right.threadId
  );
}

/**
 * A Gmail conversation can belong to only one workspace queue. When a live
 * feed positively materializes it in one queue, remove any cached copy from
 * the other exclusive queues instead of waiting for those queues to refresh.
 */
export function removeEmailConversationsClaimedByFeed(
  cached: EmailFeedResponse,
  authoritative: EmailFeedResponse,
): EmailFeedResponse {
  if (
    cached.view === authoritative.view ||
    !EXCLUSIVE_EMAIL_QUEUE_VIEWS.has(cached.view) ||
    !EXCLUSIVE_EMAIL_QUEUE_VIEWS.has(authoritative.view) ||
    authoritative.threads.length === 0
  ) {
    return cached;
  }
  const claimed = new Set(
    authoritative.threads.map(emailConversationIdentity),
  );
  const removed = cached.threads.filter((thread) =>
    claimed.has(emailConversationIdentity(thread)),
  );
  if (removed.length === 0) return cached;

  const removedByConnection = new Map<string, number>();
  for (const thread of removed) {
    removedByConnection.set(
      thread.connectionId,
      (removedByConnection.get(thread.connectionId) || 0) + 1,
    );
  }
  const stats = { ...cached.stats };
  if (cached.view === "focus") {
    stats.focus = clampCount(stats.focus - removed.length);
    stats.draftsReady = clampCount(
      stats.draftsReady -
        removed.filter((thread) => thread.action?.lane === "ready").length,
    );
  } else if (cached.view === "inbox") {
    stats.needsReview = clampCount(stats.needsReview - removed.length);
  } else if (cached.view === "noise") {
    stats.noiseCaught = clampCount(stats.noiseCaught - removed.length);
  } else if (cached.view === "handled") {
    stats.processed = clampCount(stats.processed - removed.length);
  }

  return {
    ...cached,
    threads: cached.threads.filter(
      (thread) => !claimed.has(emailConversationIdentity(thread)),
    ),
    mailboxes: cached.mailboxes.map((mailbox) => {
      const removedCount = removedByConnection.get(mailbox.connectionId) || 0;
      if (removedCount === 0) return mailbox;
      const counts = { ...mailbox.counts };
      if (cached.view === "focus") {
        counts.focus = clampCount(counts.focus - removedCount);
      } else if (cached.view === "inbox") {
        counts.inbox = clampCount(counts.inbox - removedCount);
      } else if (cached.view === "noise") {
        counts.noise = clampCount(counts.noise - removedCount);
      }
      return { ...mailbox, counts };
    }),
    stats,
  };
}

function updateMailboxCounts(
  feed: EmailFeedResponse,
  thread: EmailThreadSummary,
  currentView: EmailView,
  targetView: EmailView,
): EmailFeedResponse["mailboxes"] {
  return feed.mailboxes.map((mailbox) => {
    if (mailbox.connectionId !== thread.connectionId) return mailbox;
    const counts = { ...mailbox.counts };
    if (currentView === "inbox") counts.inbox = clampCount(counts.inbox - 1);
    if (currentView === "focus") counts.focus = clampCount(counts.focus - 1);
    if (currentView === "noise") counts.noise = clampCount(counts.noise - 1);
    if (targetView === "inbox") counts.inbox += 1;
    if (targetView === "focus") counts.focus += 1;
    if (targetView === "noise") counts.noise += 1;
    if (currentView === "focus" && thread.action?.lane === "ready") {
      counts.drafts = clampCount(counts.drafts - 1);
    }
    return { ...mailbox, counts };
  });
}

/**
 * Reconciles an accepted email action into the current feed without waiting
 * for a full Gmail refresh. The server remains the source of truth.
 */
export function applyOptimisticEmailOperation(
  feed: EmailFeedResponse,
  thread: EmailThreadSummary,
  operation: EmailWorkspaceOperation,
  currentView: EmailView,
): EmailFeedResponse {
  if (operation === "star" || operation === "unstar") {
    const starred = operation === "star";
    return {
      ...feed,
      threads: feed.threads.map((item) =>
        item.key === thread.key ? { ...item, starred } : item,
      ),
    };
  }
  if (operation === "read" || operation === "unread") {
    return setEmailConversationUnread(
      feed,
      thread,
      operation === "unread",
    );
  }

  const targetView = targetViewForOperation(operation);
  if (!targetView || targetView === currentView) return feed;
  const containsConversation = feed.threads.some((item) =>
    sameEmailConversation(item, thread),
  );
  if (!containsConversation) return feed;
  if (currentView === "sent") {
    // Queue placement never removes a message from Sent history. A reply send
    // first inserts its confirmed Sent card and then completes the source
    // Focus conversation locally.
    return feed;
  }
  if (currentView === "all") {
    // All Mail is intentionally non-exclusive. Keep the message visible while
    // still reconciling the canonical queue totals.
    return {
      ...feed,
      stats: applyOptimisticEmailNavigationStats(
        feed.stats,
        thread,
        operation,
        currentView,
      ),
    };
  }

  const stats = applyOptimisticEmailNavigationStats(
    feed.stats,
    thread,
    operation,
    currentView,
  );

  return {
    ...feed,
    mailboxes: updateMailboxCounts(feed, thread, currentView, targetView),
    threads: feed.threads.filter(
      (item) => !sameEmailConversation(item, thread),
    ),
    stats,
  };
}

export function setEmailConversationUnread(
  feed: EmailFeedResponse,
  thread: Pick<EmailThreadSummary, "connectionId" | "threadId">,
  unread: boolean,
): EmailFeedResponse {
  let changed = false;
  const threads = feed.threads.map((item) => {
    if (
      item.connectionId !== thread.connectionId ||
      item.threadId !== thread.threadId ||
      item.unread === unread
    ) {
      return item;
    }
    changed = true;
    return { ...item, unread };
  });
  return changed ? { ...feed, threads } : feed;
}

export function mergeEmailFeedPage(
  current: EmailFeedResponse,
  page: EmailFeedResponse,
  maxThreads: number,
): EmailFeedResponse {
  if (current.view !== page.view) return page;
  const threads = new Map<string, EmailThreadSummary>();
  for (const thread of [...current.threads, ...page.threads]) {
    const identity = emailConversationIdentity(thread);
    const existing = threads.get(identity);
    if (
      !existing ||
      compareByReceivedAt(thread, existing) < 0
    ) {
      threads.set(identity, thread);
    }
  }
  const mergedThreads = Array.from(threads.values());
  if (
    page.view === "inbox" ||
    page.view === "sent" ||
    page.view === "all"
  ) {
    mergedThreads.sort(compareByReceivedAt);
  }
  // Gmail page tokens advance past every fetched item. Truncating a merged
  // chronological page would permanently skip the removed messages on the
  // next request, which is worse than retaining a modest per-mailbox surplus.
  if (
    page.view !== "inbox" &&
    page.view !== "sent" &&
    page.view !== "all"
  ) {
    mergedThreads.splice(maxThreads);
  }
  const mailboxes = page.mailboxes.map((mailbox) => {
    if (page.view !== "inbox") return mailbox;
    return {
      ...mailbox,
      counts: {
        ...mailbox.counts,
        inbox: mergedThreads.filter(
          (thread) => thread.connectionId === mailbox.connectionId,
        ).length,
      },
    };
  });
  return {
    ...page,
    mailboxes,
    threads: mergedThreads,
  };
}

export function needsReviewNavigationCount(
  currentFeed: EmailFeedResponse,
  prefetchedCount: number | null,
): number {
  return currentFeed.view === "inbox"
    ? currentFeed.threads.length
    : (prefetchedCount ?? 0);
}

function emailConversationIdentity(
  thread: Pick<EmailThreadSummary, "connectionId" | "threadId">,
): string {
  return `${thread.connectionId}:${thread.threadId}`;
}

export function localEmailReadAppliesToThread(
  thread: Pick<EmailThreadSummary, "connectionId" | "threadId" | "receivedAt">,
  locallyReadAt: ReadonlyMap<string, number>,
): boolean {
  const readAt = locallyReadAt.get(emailConversationIdentity(thread));
  if (readAt === undefined) return false;
  const receivedAt = Date.parse(thread.receivedAt);
  return !Number.isFinite(receivedAt) || receivedAt <= readAt;
}

/**
 * Keeps a just-read card from flashing unread while Gmail catches up, without
 * carrying that read state forward to a reply received later in the thread.
 */
export function preserveLocallyReadEmailThreads(
  feed: EmailFeedResponse,
  locallyReadAt: ReadonlyMap<string, number>,
): EmailFeedResponse {
  let changed = false;
  const threads = feed.threads.map((thread) => {
    if (
      !thread.unread ||
      !localEmailReadAppliesToThread(thread, locallyReadAt)
    ) {
      return thread;
    }
    changed = true;
    return { ...thread, unread: false };
  });
  return changed ? { ...feed, threads } : feed;
}

function threadRenderSignature(thread: EmailThreadSummary): string {
  return JSON.stringify({
    ...thread,
    mailbox: {
      connectionId: thread.mailbox.connectionId,
      address: thread.mailbox.address,
      displayName: thread.mailbox.displayName,
      color: thread.mailbox.color,
      monogram: thread.mailbox.monogram,
      status: thread.mailbox.status,
      statusMessage: thread.mailbox.statusMessage,
    },
  });
}

function preserveKnownSentOpenStatuses(
  current: EmailFeedResponse,
  fresh: EmailFeedResponse,
): EmailFeedResponse {
  if (current.view !== "sent" || fresh.view !== "sent") return fresh;
  const statusByConversation = new Map(
    current.threads
      .filter(
        (thread) =>
          thread.direction === "outgoing" && thread.openStatus !== null,
      )
      .map((thread) => [
        emailConversationIdentity(thread),
        thread.openStatus,
      ]),
  );
  if (statusByConversation.size === 0) return fresh;
  let changed = false;
  const threads = fresh.threads.map((thread) => {
    if (thread.direction !== "outgoing" || thread.openStatus !== null) {
      return thread;
    }
    const knownStatus = statusByConversation.get(
      emailConversationIdentity(thread),
    );
    if (!knownStatus) return thread;
    changed = true;
    return { ...thread, openStatus: knownStatus };
  });
  return changed ? { ...fresh, threads } : fresh;
}

function preserveStableEmailThreadReferencesInternal(
  current: EmailFeedResponse,
  fresh: EmailFeedResponse,
): EmailFeedResponse {
  if (current.view !== fresh.view) return fresh;
  if (fresh.view === "focus" || fresh.view === "inbox") {
    const authoritativeRemovals = new Map(
      (fresh.authoritativeRemovedConversations || []).map(
        (removal) => [
          removal.id,
          Date.parse(removal.correctedAt),
        ],
      ),
    );
    const isAuthoritativelyRemoved = (
      thread: EmailThreadSummary,
    ): boolean => {
      const removedAt = authoritativeRemovals.get(
        emailConversationIdentity(thread),
      );
      if (removedAt === undefined) return false;
      const receivedAt = Date.parse(thread.receivedAt);
      return (
        !Number.isFinite(removedAt) ||
        !Number.isFinite(receivedAt) ||
        receivedAt <= removedAt
      );
    };
    const freshByConversation = new Map<string, EmailThreadSummary>();
    for (const thread of fresh.threads) {
      const identity = emailConversationIdentity(thread);
      if (!freshByConversation.has(identity)) {
        freshByConversation.set(identity, thread);
      }
    }
    const currentConversations = new Set(
      current.threads.map(emailConversationIdentity),
    );
    const newConversations = new Set<string>();
    const newThreads = fresh.threads
      .filter((thread) => {
        const identity = emailConversationIdentity(thread);
        if (
          isAuthoritativelyRemoved(thread) ||
          currentConversations.has(identity) ||
          newConversations.has(identity)
        ) {
          return false;
        }
        newConversations.add(identity);
        return true;
      })
      .sort(compareByReceivedAt);
    const retainedThreads = current.threads.flatMap((existing) => {
      const identity = emailConversationIdentity(existing);
      const updated = freshByConversation.get(identity);
      if (updated) {
        if (isAuthoritativelyRemoved(updated)) return [];
        return [
          threadRenderSignature(existing) ===
          threadRenderSignature(updated)
            ? existing
            : updated,
        ];
      }
      if (isAuthoritativelyRemoved(existing)) return [];
      return [existing];
    });
    return {
      ...fresh,
      // New mail is additive: prepend arrivals while leaving already loaded
      // pages in place. A first-page refresh cannot make a visible card
      // disappear; an accepted user operation still supplies a removal marker.
      threads: [...newThreads, ...retainedThreads],
    };
  }
  if (fresh.view === "sent" || fresh.view === "all") {
    const freshByConversation = new Map<string, EmailThreadSummary>();
    for (const thread of fresh.threads) {
      const identity = emailConversationIdentity(thread);
      if (!freshByConversation.has(identity)) {
        freshByConversation.set(identity, thread);
      }
    }
    const currentConversations = new Set(
      current.threads.map(emailConversationIdentity),
    );
    const newConversations = new Set<string>();
    const newThreads = fresh.threads.filter((thread) => {
      const identity = emailConversationIdentity(thread);
      if (
        currentConversations.has(identity) ||
        newConversations.has(identity)
      ) {
        return false;
      }
      newConversations.add(identity);
      return true;
    });
    const retainedConversations = new Set<string>();
    const retainedThreads = current.threads.flatMap((existing) => {
      const identity = emailConversationIdentity(existing);
      if (retainedConversations.has(identity)) return [];
      retainedConversations.add(identity);
      const updated = freshByConversation.get(identity);
      if (!updated) return [existing];
      return [
        threadRenderSignature(existing) === threadRenderSignature(updated)
          ? existing
          : updated,
      ];
    });
    const retainedLoadedPage =
      fresh.view === "all" &&
      retainedThreads.some(
        (thread) =>
          !freshByConversation.has(emailConversationIdentity(thread)),
      );
    return {
      ...fresh,
      // A first-page refresh of All Mail must preserve both its loaded pages
      // and the cursor beyond them. Resetting to the fresh cursor would make
      // scrolling re-fetch those same pages. Sent likewise retains visible
      // conversations because Gmail can briefly omit a just-sent message.
      nextCursor: retainedLoadedPage
        ? current.nextCursor
        : fresh.nextCursor,
      threads: [...newThreads, ...retainedThreads].sort(compareByReceivedAt),
    };
  }
  const freshByKey = new Map(
    fresh.threads.map((thread) => [thread.key, thread]),
  );
  const currentKeys = new Set(current.threads.map((thread) => thread.key));
  const newThreads = fresh.threads.filter(
    (thread) => !currentKeys.has(thread.key),
  );
  const retainedThreads = current.threads.flatMap((existing) => {
    const updated = freshByKey.get(existing.key);
    if (!updated) return [];
    return [
      threadRenderSignature(existing) === threadRenderSignature(updated)
        ? existing
        : updated,
    ];
  });
  return {
    ...fresh,
    // A quiet refresh may add or remove cards, but it must never move an
    // existing card under the pointer. New arrivals appear above the stable
    // stack; deliberate view navigation can adopt a fully fresh order.
    threads: [...newThreads, ...retainedThreads],
  };
}

export function preserveStableEmailThreadReferences(
  current: EmailFeedResponse,
  fresh: EmailFeedResponse,
): EmailFeedResponse {
  return preserveStableEmailThreadReferencesInternal(
    current,
    preserveKnownSentOpenStatuses(current, fresh),
  );
}

export function preserveTransientMailboxFailures(
  current: EmailFeedResponse,
  fresh: EmailFeedResponse,
): EmailFeedResponse {
  if (current.view !== fresh.view) return fresh;
  const currentMailboxByConnection = new Map(
    current.mailboxes.map((mailbox) => [mailbox.connectionId, mailbox]),
  );
  const transientFailures = new Set(
    fresh.mailboxes
      .filter((mailbox) => {
        const prior = currentMailboxByConnection.get(mailbox.connectionId);
        return prior?.status === "connected" && mailbox.status === "error";
      })
      .map((mailbox) => mailbox.connectionId),
  );
  if (transientFailures.size === 0) return fresh;

  const freshKeys = new Set(fresh.threads.map((thread) => thread.key));
  const retained = current.threads.filter(
    (thread) =>
      transientFailures.has(thread.connectionId) &&
      !freshKeys.has(thread.key),
  );
  return {
    ...fresh,
    mailboxes: fresh.mailboxes.map((mailbox) => {
      if (!transientFailures.has(mailbox.connectionId)) return mailbox;
      return currentMailboxByConnection.get(mailbox.connectionId) || mailbox;
    }),
    threads: [...fresh.threads, ...retained],
  };
}

export function mergeEmailMailboxHealth(
  feed: EmailFeedResponse,
  health: EmailMailbox[],
): EmailFeedResponse {
  const healthByConnection = new Map(
    health.map((mailbox) => [mailbox.connectionId, mailbox]),
  );
  const mailboxes = feed.mailboxes.map((mailbox) => {
    const fresh = healthByConnection.get(mailbox.connectionId);
    if (!fresh) return mailbox;
    // A profile probe is advisory. Do not turn a working mailbox red because
    // a concurrent Gmail list/search briefly exhausted upstream quota. A real
    // authentication failure remains authoritative and is shown immediately.
    const transientProbeFailure =
      mailbox.status === "connected" && fresh.status === "error";
    return {
      ...fresh,
      ...(transientProbeFailure
        ? {
            status: mailbox.status,
            statusMessage: mailbox.statusMessage,
          }
        : {}),
      counts: mailbox.counts,
    };
  });
  const mailboxByConnection = new Map(
    mailboxes.map((mailbox) => [mailbox.connectionId, mailbox]),
  );
  return {
    ...feed,
    mailboxes,
    threads: feed.threads.map((thread) => {
      const mailbox = mailboxByConnection.get(thread.connectionId);
      return mailbox && mailbox !== thread.mailbox
        ? { ...thread, mailbox }
        : thread;
    }),
  };
}
