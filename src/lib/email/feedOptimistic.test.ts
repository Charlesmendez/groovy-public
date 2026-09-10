import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOptimisticEmailNavigationStats,
  applyOptimisticEmailOperation,
  canHydrateEmailFeedFromCache,
  emailFeedAutoLoadThreshold,
  emailFeedPageSize,
  emailFeedNavigationAction,
  emailFeedResumeAction,
  isCurrentEmailFeedRequest,
  keepSentConversationInFeed,
  localEmailReadAppliesToThread,
  mergeEmailFocusNotificationSnapshot,
  mergeConfirmedSentThread,
  mergeEmailMailboxHealth,
  mergeEmailFeedPage,
  needsReviewNavigationCount,
  nextAutoLoadedEmailFeedDepth,
  preserveStableEmailThreadReferences,
  preserveLocallyReadEmailThreads,
  preserveTransientMailboxFailures,
  removeEmailConversationsClaimedByFeed,
  setEmailConversationUnread,
  shouldAutoLoadEmailFeed,
  shouldLoadMoreEmailNearScrollEnd,
  supportsProgressiveEmailSnapshot,
} from "./feedOptimistic";
import {
  EMAIL_FEED_SCHEMA_VERSION,
  type EmailFeedResponse,
  type EmailThreadSummary,
} from "./types";

const mailbox = {
  connectionId: "gmail-1",
  provider: "gmail" as const,
  address: "owner@example.com",
  displayName: "Work",
  color: "#22d3ee",
  monogram: "WO",
  isDefaultSender: true,
  includedInUnified: true,
  aiInstructions: "",
  status: "connected" as const,
  counts: { inbox: 5, focus: 3, drafts: 1, noise: 2 },
};

const thread: EmailThreadSummary = {
  key: "gmail-1:message:message-1",
  connectionId: "gmail-1",
  mailbox,
  messageId: "message-1",
  threadId: "thread-1",
  senderName: "Alex",
  senderEmail: "alex@example.com",
  recipients: ["owner@example.com"],
  subject: "Tuesday",
  snippet: "Does Tuesday work?",
  receivedAt: "2026-07-27T12:00:00.000Z",
  unread: true,
  starred: false,
  hasAttachments: false,
  direction: "incoming",
  openStatus: null,
  calendarInvite: null,
  action: {
    id: "action-1",
    type: "draft_reply",
    status: "pending",
    lane: "ready",
    confidence: 0.95,
    important: 0.9,
    spam: 0.01,
    actionable: 0.9,
    critical: false,
    reason: "Reply requested",
    summary: "A meeting time needs confirmation.",
    keyAsk: "Confirm Tuesday",
    deadline: null,
    aiGenerated: true,
    model: "test",
  },
  draft: null,
};

test("active inbox queues wait for Gmail while historical views can paint indexed snapshots", () => {
  assert.equal(supportsProgressiveEmailSnapshot("focus"), false);
  assert.equal(supportsProgressiveEmailSnapshot("inbox"), false);
  assert.equal(supportsProgressiveEmailSnapshot("sent"), true);
  assert.equal(supportsProgressiveEmailSnapshot("handled"), true);
  assert.equal(supportsProgressiveEmailSnapshot("noise"), true);
  assert.equal(supportsProgressiveEmailSnapshot("all"), true);
});

test("active queues paint cached membership while Gmail revalidates", () => {
  assert.equal(canHydrateEmailFeedFromCache("focus"), true);
  assert.equal(canHydrateEmailFeedFromCache("inbox"), true);
  assert.equal(canHydrateEmailFeedFromCache("sent"), true);
});

test("a Focus feed rendered in this session is reused across tab switches", () => {
  assert.equal(
    emailFeedNavigationAction({
      view: "focus",
      hasCachedFeed: true,
      renderedInSession: true,
      restoredNavigation: false,
      cachedSavedAt: 9_500,
      now: 10_000,
      refreshCooldownMs: 30_000,
    }),
    "reuse",
  );
  assert.equal(
    emailFeedNavigationAction({
      view: "focus",
      hasCachedFeed: true,
      renderedInSession: true,
      restoredNavigation: false,
      cachedSavedAt: 1_000,
      now: 40_000,
      refreshCooldownMs: 30_000,
    }),
    "refresh",
  );
});

test("a persistent Focus cache paints before this session revalidates it", () => {
  assert.equal(
    emailFeedNavigationAction({
      view: "focus",
      hasCachedFeed: true,
      renderedInSession: false,
      restoredNavigation: false,
      cachedSavedAt: 9_500,
      now: 10_000,
      refreshCooldownMs: 30_000,
    }),
    "refresh",
  );
  assert.equal(
    emailFeedNavigationAction({
      view: "focus",
      hasCachedFeed: true,
      renderedInSession: false,
      restoredNavigation: true,
      cachedSavedAt: 9_500,
      now: 10_000,
      refreshCooldownMs: 30_000,
    }),
    "refresh",
  );
});

test("other persistent queue caches paint immediately and refresh quietly", () => {
  assert.equal(
    emailFeedNavigationAction({
      view: "sent",
      hasCachedFeed: true,
      renderedInSession: false,
      restoredNavigation: false,
      cachedSavedAt: 9_500,
      now: 10_000,
      refreshCooldownMs: 30_000,
    }),
    "refresh",
  );
});

test("a preserved Email screen resumes without a blocking reload", () => {
  assert.equal(
    emailFeedResumeAction({
      currentKey: "focus:all",
      renderedKey: "focus:all",
      lastRequestAt: 9_500,
      now: 10_000,
      refreshCooldownMs: 30_000,
    }),
    "reuse",
  );
  assert.equal(
    emailFeedResumeAction({
      currentKey: "focus:all",
      renderedKey: "focus:all",
      lastRequestAt: 1_000,
      now: 40_000,
      refreshCooldownMs: 30_000,
    }),
    "refresh",
  );
  assert.equal(
    emailFeedResumeAction({
      currentKey: "focus:all",
      renderedKey: "sent:all",
      lastRequestAt: 9_500,
      now: 10_000,
      refreshCooldownMs: 30_000,
    }),
    "not-rendered",
  );
});

test("Needs Review loads historical pages only after deliberate user action", () => {
  assert.equal(shouldAutoLoadEmailFeed("inbox"), false);
  assert.equal(shouldAutoLoadEmailFeed("focus"), false);
  assert.equal(shouldAutoLoadEmailFeed("sent"), true);
  assert.equal(shouldAutoLoadEmailFeed("all"), true);
});

test("All Mail pagination continues beyond the old 96-conversation ceiling", () => {
  assert.equal(
    nextAutoLoadedEmailFeedDepth({
      currentDepth: 96,
      loadedThreadCount: 101,
      pageSize: 24,
    }),
    125,
  );
});

test("All Mail begins loading the next page before the user reaches the bottom", () => {
  assert.equal(emailFeedAutoLoadThreshold("all"), 2_400);
  assert.equal(emailFeedAutoLoadThreshold("sent"), 360);
  assert.equal(emailFeedPageSize("all"), 12);
  assert.equal(emailFeedPageSize("sent"), 24);
  assert.equal(
    shouldLoadMoreEmailNearScrollEnd({
      scrollTop: 0,
      scrollHeight: 3_000,
      clientHeight: 700,
      threshold: emailFeedAutoLoadThreshold("all"),
    }),
    true,
  );
});

test("scroll pagination has a near-bottom fallback when observers miss", () => {
  assert.equal(
    shouldLoadMoreEmailNearScrollEnd({
      scrollTop: 1_200,
      scrollHeight: 2_000,
      clientHeight: 500,
    }),
    true,
  );
  assert.equal(
    shouldLoadMoreEmailNearScrollEnd({
      scrollTop: 400,
      scrollHeight: 2_000,
      clientHeight: 500,
    }),
    false,
  );
});

test("local actions invalidate stale requests in every exclusive inbox", () => {
  for (const view of ["focus", "inbox", "noise", "handled"] as const) {
    assert.equal(
      isCurrentEmailFeedRequest(
        {
          requestId: 7,
          mutationVersion: 2,
          view,
          connectionId: null,
        },
        {
          requestId: 7,
          mutationVersion: 3,
          view,
          connectionId: null,
        },
      ),
      false,
    );
  }
  assert.equal(
    isCurrentEmailFeedRequest(
      {
        requestId: 7,
        mutationVersion: 3,
        view: "inbox",
        connectionId: "gmail-1",
      },
      {
        requestId: 7,
        mutationVersion: 3,
        view: "inbox",
        connectionId: "gmail-1",
      },
    ),
    true,
  );
});

function feed(): EmailFeedResponse {
  return {
    schemaVersion: EMAIL_FEED_SCHEMA_VERSION,
    view: "focus",
    mailboxes: [mailbox],
    threads: [thread],
    nextCursor: "more",
    warnings: [],
    stats: {
      focus: 3,
      processed: 4,
      draftsReady: 1,
      needsReview: 0,
      noiseCaught: 2,
    },
  };
}

test("a Gmail-confirmed send appears immediately and replaces its prior thread card", () => {
  const olderSent = {
    ...thread,
    key: "gmail-1:message:sent-1",
    messageId: "sent-1",
    direction: "outgoing" as const,
    receivedAt: "2026-07-27T12:00:00.000Z",
  };
  const confirmed = {
    ...olderSent,
    key: "gmail-1:message:sent-2",
    messageId: "sent-2",
    receivedAt: "2026-07-27T13:00:00.000Z",
  };
  const sentFeed = {
    ...feed(),
    view: "sent" as const,
    threads: [olderSent],
  };

  const updated = mergeConfirmedSentThread(sentFeed, confirmed);
  assert.deepEqual(updated.threads.map((item) => item.messageId), ["sent-2"]);
  assert.equal(mergeConfirmedSentThread(updated, confirmed), updated);
});

test("confirmed sends never leak into a non-Sent queue", () => {
  const current = feed();
  const confirmed = {
    ...thread,
    direction: "outgoing" as const,
  };
  assert.equal(mergeConfirmedSentThread(current, confirmed), current);
});

test("sending a Focus reply clears its draft but keeps the conversation visible", () => {
  const focused = {
    ...thread,
    draft: {
      actionId: "action-1",
      draftId: "draft-1",
      connectionId: "gmail-1",
      threadId: "thread-1",
      sourceMessageId: "message-1",
      to: ["alex@example.com"],
      cc: [],
      bcc: [],
      subject: "Re: Tuesday",
      body: "Tuesday works.",
      bodyHtml: null,
      attachments: [],
      aiGenerated: true,
      untouched: false,
      updatedAt: "2026-07-27T12:05:00.000Z",
    },
  } satisfies EmailThreadSummary;
  const currentFeed = { ...feed(), threads: [focused] };
  const result = keepSentConversationInFeed(currentFeed, focused);

  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].threadId, "thread-1");
  assert.equal(result.threads[0].draft, null);
  assert.equal(result.threads[0].action?.lane, "read");
  assert.equal(result.stats.focus, currentFeed.stats.focus);
  assert.equal(result.stats.processed, currentFeed.stats.processed);
  assert.equal(
    result.stats.draftsReady,
    currentFeed.stats.draftsReady - 1,
  );
  assert.equal(result.mailboxes[0].counts.focus, mailbox.counts.focus);
  assert.equal(result.mailboxes[0].counts.drafts, mailbox.counts.drafts - 1);
});

test("marking a focused email done removes it without reloading the feed", () => {
  const updated = applyOptimisticEmailOperation(
    feed(),
    thread,
    "move_handled",
    "focus",
  );
  assert.deepEqual(updated.threads, []);
  assert.equal(updated.stats.focus, 2);
  assert.equal(updated.stats.processed, 5);
  assert.equal(updated.stats.draftsReady, 0);
  assert.equal(updated.mailboxes[0].counts.focus, 2);
});

test("accepted conversation actions remove every card for that Gmail thread", () => {
  const secondMatch = {
    ...thread,
    key: "gmail-1:message:message-2",
    messageId: "message-2",
  };
  const updated = applyOptimisticEmailOperation(
    { ...feed(), threads: [thread, secondMatch] },
    thread,
    "move_handled",
    "focus",
  );
  assert.deepEqual(updated.threads, []);
  assert.equal(updated.stats.focus, 2);
  assert.equal(updated.stats.processed, 5);
});

test("an already-reconciled action does not decrement feed counts twice", () => {
  const alreadyRemoved = { ...feed(), threads: [] };
  const updated = applyOptimisticEmailOperation(
    alreadyRemoved,
    thread,
    "move_handled",
    "focus",
  );
  assert.equal(updated, alreadyRemoved);
});

test("star and unread actions update the existing card in place", () => {
  const starred = applyOptimisticEmailOperation(
    feed(),
    thread,
    "star",
    "focus",
  );
  assert.equal(starred.threads[0].starred, true);
  assert.equal(starred.threads.length, 1);

  const read = applyOptimisticEmailOperation(
    starred,
    starred.threads[0],
    "read",
    "focus",
  );
  assert.equal(read.threads[0].unread, false);
});

test("a local read cutoff does not suppress a newer reply", () => {
  const readAt = Date.parse("2026-07-27T13:00:00.000Z");
  const locallyReadAt = new Map([
    [`${thread.connectionId}:${thread.threadId}`, readAt],
  ]);
  const previouslyRead = { ...thread, unread: true };
  const newerReply = {
    ...thread,
    key: "gmail-1:message:message-2",
    messageId: "message-2",
    snippet: "Here is my reply.",
    receivedAt: "2026-07-27T14:00:00.000Z",
    unread: true,
  };

  assert.equal(
    localEmailReadAppliesToThread(previouslyRead, locallyReadAt),
    true,
  );
  assert.equal(localEmailReadAppliesToThread(newerReply, locallyReadAt), false);
  assert.equal(
    preserveLocallyReadEmailThreads(
      { ...feed(), threads: [previouslyRead] },
      locallyReadAt,
    ).threads[0]?.unread,
    false,
  );
  assert.equal(
    preserveLocallyReadEmailThreads(
      { ...feed(), threads: [newerReply] },
      locallyReadAt,
    ).threads[0]?.unread,
    true,
  );
});

test("opening a conversation clears every result for the same Gmail thread", () => {
  const secondMatch = {
    ...thread,
    key: "gmail-1:message:message-2",
    messageId: "message-2",
  };
  const updated = setEmailConversationUnread(
    { ...feed(), threads: [thread, secondMatch] },
    thread,
    false,
  );
  assert.deepEqual(
    updated.threads.map((item) => item.unread),
    [false, false],
  );
});

test("moving an email to its current view leaves the card visible", () => {
  const handledFeed = { ...feed(), view: "handled" as const };
  const updated = applyOptimisticEmailOperation(
    handledFeed,
    thread,
    "move_handled",
    "handled",
  );
  assert.equal(updated.threads.length, 1);
});

test("classification never removes a message from All Mail", () => {
  const allFeed = { ...feed(), view: "all" as const };
  const updated = applyOptimisticEmailOperation(
    allFeed,
    thread,
    "move_handled",
    "all",
  );
  assert.equal(updated.threads.length, 1);
  assert.equal(updated.stats.focus, 2);
  assert.equal(updated.stats.processed, 5);
});

test("completing a source conversation never removes its Sent copy", () => {
  const sentFeed = { ...feed(), view: "sent" as const };
  const updated = applyOptimisticEmailOperation(
    sentFeed,
    thread,
    "move_handled",
    "sent",
  );
  assert.equal(updated, sentFeed);
  assert.equal(updated.threads.length, 1);
});

test("Done from All Mail updates canonical counts without hiding the message", () => {
  const allFeed = {
    ...feed(),
    view: "all" as const,
    stats: { ...feed().stats, focus: 8, processed: 3 },
  };
  const updatedStats = applyOptimisticEmailNavigationStats(
    allFeed.stats,
    thread,
    "move_handled",
    "all",
  );
  assert.deepEqual(updatedStats, {
    ...allFeed.stats,
    focus: 7,
    processed: 4,
    draftsReady: 0,
  });
});

test("incremental pages append without duplicating existing conversations", () => {
  const second = {
    ...thread,
    key: "gmail-1:message:message-2",
    threadId: "thread-2",
    messageId: "message-2",
  };
  const page = {
    ...feed(),
    threads: [thread, second],
    nextCursor: null,
  };
  const merged = mergeEmailFeedPage(feed(), page, 24);
  assert.deepEqual(
    merged.threads.map((item) => item.key),
    ["gmail-1:message:message-1", "gmail-1:message:message-2"],
  );
  assert.equal(merged.nextCursor, null);
});

test("a push delta adds new Focus mail without hiding the cached queue", () => {
  const arrival = {
    ...thread,
    key: "gmail-1:message:message-2",
    messageId: "message-2",
    threadId: "thread-2",
    subject: "Just arrived",
    receivedAt: "2026-07-28T12:00:00.000Z",
  };
  const notification = {
    ...feed(),
    threads: [arrival],
    stats: { ...feed().stats, focus: 1, draftsReady: 1 },
  };
  const merged = mergeEmailFocusNotificationSnapshot(
    feed(),
    notification,
    24,
  );
  assert.deepEqual(
    merged.threads.map((item) => item.subject),
    ["Just arrived", "Tuesday"],
  );
  assert.equal(merged.stats.focus, 4);
  assert.equal(merged.stats.draftsReady, 2);
  assert.equal(merged.mailboxes[0]?.counts.focus, 4);
});

test("a repeated push replaces its conversation without double-counting", () => {
  const notification = {
    ...feed(),
    threads: [{ ...thread, subject: "Updated subject" }],
    stats: { ...feed().stats, focus: 1 },
  };
  const merged = mergeEmailFocusNotificationSnapshot(
    feed(),
    notification,
    24,
  );
  assert.equal(merged.threads.length, 1);
  assert.equal(merged.threads[0]?.subject, "Updated subject");
  assert.equal(merged.stats.focus, 3);
});

test("a push delta can populate an empty cold-start Focus cache", () => {
  const notification = {
    ...feed(),
    threads: [{ ...thread, subject: "Cold-start arrival" }],
    stats: { ...feed().stats, focus: 1, draftsReady: 1 },
    mailboxes: [
      {
        ...feed().mailboxes[0],
        counts: { ...feed().mailboxes[0].counts, focus: 1, drafts: 1 },
      },
    ],
  };
  const current = {
    ...feed(),
    threads: [],
    mailboxes: [],
    stats: { ...feed().stats, focus: 0, draftsReady: 0 },
  };
  const merged = mergeEmailFocusNotificationSnapshot(
    current,
    notification,
    24,
  );
  assert.equal(merged.threads[0]?.subject, "Cold-start arrival");
  assert.equal(merged.mailboxes[0]?.connectionId, thread.connectionId);
  assert.equal(merged.mailboxes[0]?.counts.focus, 1);
  assert.equal(merged.stats.focus, 1);
});

test("an action-state delta removes a completed card before Gmail reloads", () => {
  const notification = {
    ...feed(),
    threads: [],
    stats: { ...feed().stats, focus: 0, draftsReady: 0 },
    mailboxes: [
      {
        ...feed().mailboxes[0],
        counts: { ...feed().mailboxes[0].counts, focus: 0, drafts: 0 },
      },
    ],
    authoritativeRemovedConversations: [
      {
        id: `${thread.connectionId}:${thread.threadId}`,
        correctedAt: "2026-07-28T12:00:00.000Z",
      },
    ],
  };
  const merged = mergeEmailFocusNotificationSnapshot(
    feed(),
    notification,
    24,
  );
  assert.equal(merged.threads.length, 0);
  assert.equal(merged.stats.focus, 2);
  assert.equal(merged.stats.draftsReady, 0);
  assert.equal(merged.mailboxes[0]?.counts.focus, 2);
  assert.equal(merged.mailboxes[0]?.counts.drafts, 0);
});

test("incremental pages deduplicate different messages from one conversation", () => {
  const latestReply = {
    ...thread,
    key: "gmail-1:message:latest",
    messageId: "latest",
    receivedAt: "2026-07-28T12:00:00.000Z",
  };
  const olderReply = {
    ...thread,
    key: "gmail-1:message:older",
    messageId: "older",
    receivedAt: "2026-07-28T10:00:00.000Z",
  };
  const otherConversation = {
    ...thread,
    key: "gmail-1:message:other",
    messageId: "other",
    threadId: "thread-2",
    receivedAt: "2026-07-28T09:00:00.000Z",
  };
  const current = {
    ...feed(),
    view: "inbox" as const,
    threads: [latestReply],
  };
  const page = {
    ...current,
    threads: [olderReply, otherConversation],
  };

  const merged = mergeEmailFeedPage(current, page, 24);
  assert.deepEqual(
    merged.threads.map((item) => item.messageId),
    ["latest", "other"],
  );
});

test("incremental Inbox pages remain newest-first across mailboxes", () => {
  const older = {
    ...thread,
    receivedAt: "2026-07-28T10:00:00.000Z",
  };
  const newer = {
    ...thread,
    key: "gmail-2:message:message-2",
    connectionId: "gmail-2",
    threadId: "thread-2",
    messageId: "message-2",
    receivedAt: "2026-07-28T12:00:00.000Z",
  };
  const inboxFeed = {
    ...feed(),
    view: "inbox" as const,
    threads: [older],
  };
  const page = {
    ...inboxFeed,
    threads: [newer],
    nextCursor: null,
  };

  const merged = mergeEmailFeedPage(inboxFeed, page, 24);
  assert.deepEqual(
    merged.threads.map((item) => item.key),
    [newer.key, older.key],
  );
});

test("Needs Review count never falls back to historical action stats", () => {
  const focusFeed = {
    ...feed(),
    stats: { ...feed().stats, needsReview: 250 },
  };
  assert.equal(
    needsReviewNavigationCount(focusFeed, null),
    0,
  );
  assert.equal(needsReviewNavigationCount(focusFeed, 11), 11);
  assert.equal(
    needsReviewNavigationCount(
      {
        ...focusFeed,
        view: "inbox",
        threads: [thread, { ...thread, key: "second" }],
      },
      null,
    ),
    2,
  );
  assert.equal(
    needsReviewNavigationCount(
      {
        ...focusFeed,
        view: "inbox",
        threads: [thread, { ...thread, key: "second" }],
      },
      11,
    ),
    2,
  );
});

test("incremental All Mail pages remain newest-first across mailboxes", () => {
  const older = {
    ...thread,
    receivedAt: "2026-07-28T10:00:00.000Z",
  };
  const newer = {
    ...thread,
    key: "gmail-2:message:message-2",
    connectionId: "gmail-2",
    threadId: "thread-2",
    messageId: "message-2",
    receivedAt: "2026-07-28T12:00:00.000Z",
  };
  const allFeed = {
    ...feed(),
    view: "all" as const,
    threads: [older],
  };
  const merged = mergeEmailFeedPage(
    allFeed,
    { ...allFeed, threads: [newer], nextCursor: null },
    24,
  );
  assert.deepEqual(
    merged.threads.map((item) => item.key),
    [newer.key, older.key],
  );
});

test("chronological pagination never drops fetched Gmail messages", () => {
  const pageThreads = Array.from({ length: 4 }, (_, index) => ({
    ...thread,
    key: `gmail-1:message:page-${index}`,
    messageId: `page-${index}`,
    threadId: `page-thread-${index}`,
    receivedAt: `2026-07-28T0${index + 1}:00:00.000Z`,
  }));
  const merged = mergeEmailFeedPage(
    { ...feed(), view: "all", threads: [thread] },
    {
      ...feed(),
      view: "all",
      threads: pageThreads,
      nextCursor: "next-page",
    },
    2,
  );
  assert.equal(merged.threads.length, 5);
  assert.equal(merged.nextCursor, "next-page");
});

test("quiet refreshes preserve unchanged card references", () => {
  const refreshed = {
    ...feed(),
    threads: [
      {
        ...thread,
        mailbox: {
          ...thread.mailbox,
          counts: { ...thread.mailbox.counts, focus: 2 },
        },
      },
    ],
  };
  const stable = preserveStableEmailThreadReferences(feed(), refreshed);
  assert.equal(stable.threads[0], thread);
});

test("quiet Needs Review refresh leaves the current review order in place", () => {
  const older = {
    ...thread,
    receivedAt: "2026-07-28T10:00:00.000Z",
  };
  const newer = {
    ...thread,
    key: "gmail-1:message:message-2",
    messageId: "message-2",
    threadId: "thread-2",
    receivedAt: "2026-07-28T12:00:00.000Z",
  };
  const current = {
    ...feed(),
    view: "inbox" as const,
    threads: [older, newer],
  };
  const fresh = { ...current, threads: [newer, older] };
  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(
    stable.threads.map((item) => item.key),
    [older.key, newer.key],
  );
  assert.equal(stable.threads[0], older);
  assert.equal(stable.threads[1], newer);
});

test("quiet Needs Review refresh retains already loaded older pages", () => {
  const oldest = {
    ...thread,
    key: "gmail-1:message:oldest",
    messageId: "oldest",
    threadId: "oldest-thread",
    receivedAt: "2026-07-28T08:00:00.000Z",
  };
  const older = {
    ...thread,
    key: "gmail-1:message:older",
    messageId: "older",
    threadId: "older-thread",
    receivedAt: "2026-07-28T10:00:00.000Z",
  };
  const newest = {
    ...thread,
    key: "gmail-1:message:newest",
    messageId: "newest",
    threadId: "newest-thread",
    receivedAt: "2026-07-28T12:00:00.000Z",
  };
  const current = {
    ...feed(),
    view: "inbox" as const,
    threads: [older, oldest],
  };
  const fresh = {
    ...current,
    threads: [newest, older],
    nextCursor: "older-page",
  };
  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(
    stable.threads.map((item) => item.key),
    [newest.key, older.key, oldest.key],
  );
  assert.equal(stable.threads[1], older);
  assert.equal(stable.threads[2], oldest);
});

test("quiet Focus refresh retains deliberately loaded older Gmail pages", () => {
  const older = {
    ...thread,
    key: "gmail-1:message:older-focus",
    messageId: "older-focus",
    threadId: "older-focus-thread",
    receivedAt: "2026-07-27T10:00:00.000Z",
  };
  const current = {
    ...feed(),
    view: "focus" as const,
    threads: [thread, older],
  };
  const fresh = {
    ...current,
    threads: [thread],
    nextCursor: "older-page",
  };

  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(
    stable.threads.map((item) => item.key),
    [thread.key, older.key],
  );
  assert.equal(stable.threads[1], older);
});

test("quiet All Mail refresh preserves loaded pages and their continuation cursor", () => {
  const older = {
    ...thread,
    key: "gmail-1:message:older-all",
    messageId: "older-all",
    threadId: "older-all-thread",
    receivedAt: "2026-07-27T08:00:00.000Z",
  };
  const refreshedCurrent = {
    ...thread,
    key: "gmail-1:message:current-preview",
    messageId: "current-preview",
    snippet: "Updated preview",
  };
  const arrival = {
    ...thread,
    key: "gmail-1:message:arrival-all",
    messageId: "arrival-all",
    threadId: "arrival-all-thread",
    receivedAt: "2026-07-28T12:00:00.000Z",
  };
  const current = {
    ...feed(),
    view: "all" as const,
    threads: [thread, older],
    nextCursor: "cursor-after-loaded-pages",
  };
  const fresh = {
    ...current,
    threads: [arrival, refreshedCurrent],
    nextCursor: "cursor-after-first-page",
  };

  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(
    stable.threads.map((item) => item.messageId),
    [arrival.messageId, refreshedCurrent.messageId, older.messageId],
  );
  assert.equal(stable.threads[1], refreshedCurrent);
  assert.equal(stable.threads[2], older);
  assert.equal(stable.nextCursor, "cursor-after-loaded-pages");
});

test("quiet Needs Review refresh prepends only new mail", () => {
  const older = {
    ...thread,
    key: "gmail-1:message:older",
    messageId: "older",
    threadId: "older-thread",
    receivedAt: "2026-07-28T10:00:00.000Z",
  };
  const newest = {
    ...thread,
    key: "gmail-1:message:newest",
    messageId: "newest",
    threadId: "newest-thread",
    receivedAt: "2026-07-28T12:00:00.000Z",
  };
  const arrival = {
    ...thread,
    key: "gmail-1:message:arrival",
    messageId: "arrival",
    threadId: "arrival-thread",
    receivedAt: "2026-07-28T13:00:00.000Z",
  };
  const current = {
    ...feed(),
    view: "inbox" as const,
    threads: [newest, older],
  };
  const fresh = {
    ...current,
    threads: [arrival, older, newest],
  };

  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(
    stable.threads.map((item) => item.key),
    [arrival.key, newest.key, older.key],
  );
  assert.equal(stable.threads[1], newest);
  assert.equal(stable.threads[2], older);
});

test("quiet Needs Review refresh never removes a visible conversation", () => {
  const current = {
    ...feed(),
    view: "inbox" as const,
    threads: [thread],
  };
  const fresh = {
    ...current,
    threads: [],
    stats: { ...current.stats, needsReview: 0 },
  };

  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(stable.threads, [thread]);
});

test("an explicit action from another client removes a visible active-queue conversation", () => {
  for (const view of ["focus", "inbox"] as const) {
    const current = {
      ...feed(),
      view,
      threads: [thread],
    };
    const fresh = {
      ...current,
      threads: [],
      authoritativeRemovedConversations: [
        {
          id: `${thread.connectionId}:${thread.threadId}`,
          correctedAt: "2026-07-28T12:00:00.000Z",
        },
      ],
    };

    const stable = preserveStableEmailThreadReferences(current, fresh);
    assert.deepEqual(stable.threads, []);
  }
});

test("a conversation materialized in Focus is removed from cached Needs Review", () => {
  const needsReview = {
    ...feed(),
    view: "inbox" as const,
    threads: [thread],
    stats: { ...feed().stats, needsReview: 1 },
    mailboxes: feed().mailboxes.map((mailbox) => ({
      ...mailbox,
      counts: { ...mailbox.counts, inbox: 1 },
    })),
  };
  const focus = {
    ...feed(),
    view: "focus" as const,
    threads: [thread],
  };

  const reconciled = removeEmailConversationsClaimedByFeed(
    needsReview,
    focus,
  );
  assert.deepEqual(reconciled.threads, []);
  assert.equal(reconciled.stats.needsReview, 0);
  assert.equal(reconciled.mailboxes[0]?.counts.inbox, 0);
});

test("exclusive queue reconciliation leaves unrelated conversations intact", () => {
  const another = {
    ...thread,
    key: "gmail-1:message:another",
    messageId: "another",
    threadId: "another-thread",
  };
  const needsReview = {
    ...feed(),
    view: "inbox" as const,
    threads: [thread, another],
  };
  const focus = {
    ...feed(),
    view: "focus" as const,
    threads: [thread],
  };

  assert.deepEqual(
    removeEmailConversationsClaimedByFeed(needsReview, focus).threads,
    [another],
  );
});

test("a provider duplicate marker removes only the extra mailbox copy", () => {
  const duplicate = {
    ...thread,
    key: "gmail-2:message:duplicate-message",
    connectionId: "gmail-2",
    threadId: "duplicate-thread",
    messageId: "duplicate-message",
    mailbox: {
      ...thread.mailbox,
      connectionId: "gmail-2",
      address: "alias@example.com",
    },
  };
  const current = {
    ...feed(),
    view: "focus" as const,
    threads: [thread, duplicate],
  };
  const fresh = {
    ...current,
    threads: [thread],
    authoritativeRemovedConversations: [
      {
        id: `${duplicate.connectionId}:${duplicate.threadId}`,
        correctedAt: "2026-07-28T12:00:00.000Z",
      },
    ],
  };

  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(stable.threads, [thread]);
});

test("a reply received after an explicit action reopens the conversation", () => {
  const reply = {
    ...thread,
    key: "gmail-1:message:reply-after-done",
    messageId: "reply-after-done",
    receivedAt: "2026-07-29T12:00:00.000Z",
  };
  const current = {
    ...feed(),
    view: "inbox" as const,
    threads: [reply],
  };
  const fresh = {
    ...current,
    threads: [],
    authoritativeRemovedConversations: [
      {
        id: `${thread.connectionId}:${thread.threadId}`,
        correctedAt: "2026-07-28T12:00:00.000Z",
      },
    ],
  };

  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(stable.threads, [reply]);
});

test("a fresh reply replaces its pre-action card despite an old removal cutoff", () => {
  const reply = {
    ...thread,
    key: "gmail-1:message:fresh-reply",
    messageId: "fresh-reply",
    snippet: "A new question after Done",
    receivedAt: "2026-07-29T12:00:00.000Z",
  };
  const current = {
    ...feed(),
    view: "inbox" as const,
    threads: [thread],
  };
  const fresh = {
    ...current,
    threads: [reply],
    authoritativeRemovedConversations: [
      {
        id: `${thread.connectionId}:${thread.threadId}`,
        correctedAt: "2026-07-28T12:00:00.000Z",
      },
    ],
  };

  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.equal(stable.threads.length, 1);
  assert.equal(stable.threads[0]?.messageId, "fresh-reply");
  assert.equal(stable.threads[0]?.snippet, "A new question after Done");
});

test("a new reply updates its existing Needs Review conversation once", () => {
  const reply = {
    ...thread,
    key: "gmail-1:message:new-reply",
    messageId: "new-reply",
    snippet: "The latest reply",
    receivedAt: "2026-07-28T13:00:00.000Z",
  };
  const current = {
    ...feed(),
    view: "inbox" as const,
    threads: [thread],
  };
  const fresh = {
    ...current,
    threads: [reply],
  };

  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.equal(stable.threads.length, 1);
  assert.equal(stable.threads[0]?.messageId, "new-reply");
  assert.equal(stable.threads[0]?.snippet, "The latest reply");
});

test("quiet refreshes do not reorder cards already visible to the user", () => {
  const second = {
    ...thread,
    key: "gmail-1:message:message-2",
    messageId: "message-2",
    threadId: "thread-2",
    action: null,
  };
  const current = { ...feed(), threads: [thread, second] };
  const fresh = { ...feed(), threads: [second, thread] };
  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(
    stable.threads.map((item) => item.key),
    [thread.key, second.key],
  );
});

test("new arrivals appear above the stable card order", () => {
  const second = {
    ...thread,
    key: "gmail-1:message:message-2",
    messageId: "message-2",
    threadId: "thread-2",
    action: null,
  };
  const arrival = {
    ...thread,
    key: "gmail-1:message:message-3",
    messageId: "message-3",
    threadId: "thread-3",
    action: null,
  };
  const current = { ...feed(), threads: [thread, second] };
  const fresh = { ...feed(), threads: [arrival, second, thread] };
  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(
    stable.threads.map((item) => item.key),
    [arrival.key, thread.key, second.key],
  );
});

test("Sent refresh preserves known tracking across a newer conversation preview", () => {
  const trackedStatus = {
    recipients: ["recipient@example.com"],
    attribution: "single_recipient" as const,
    openedAt: "2026-07-28T12:05:00.000Z",
    lastOpenedAt: "2026-07-28T12:06:00.000Z",
    openCount: 2,
  };
  const current = {
    ...feed(),
    view: "sent" as const,
    threads: [
      {
        ...thread,
        direction: "outgoing" as const,
        messageId: "tracked-message",
        openStatus: trackedStatus,
      },
    ],
  };
  const fresh = {
    ...current,
    threads: [
      {
        ...current.threads[0],
        key: "gmail-1:message:newer-preview",
        messageId: "newer-preview",
        openStatus: null,
      },
    ],
  };

  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.equal(stable.threads.length, 1);
  assert.equal(stable.threads[0]?.messageId, "newer-preview");
  assert.equal(stable.threads[0]?.openStatus, trackedStatus);
});

test("quiet Sent refresh never removes a visible conversation", () => {
  const markConversation = {
    ...thread,
    direction: "outgoing" as const,
    recipients: ["mark@acculynx.com"],
    subject: "Thanks for the call this morning",
  };
  const current = {
    ...feed(),
    view: "sent" as const,
    threads: [markConversation],
  };
  const fresh = {
    ...current,
    threads: [],
  };

  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(stable.threads, [markConversation]);
});

test("Sent keeps a temporarily omitted latest conversation at the top", () => {
  const latestMarkConversation = {
    ...thread,
    key: "gmail-1:message:mark-latest",
    messageId: "mark-latest",
    threadId: "thread-mark",
    direction: "outgoing" as const,
    recipients: ["mark@acculynx.com"],
    subject: "Re: Re: Thank you.",
    receivedAt: "2026-07-30T14:46:00.000Z",
  };
  const olderConversation = {
    ...thread,
    key: "gmail-1:message:older",
    messageId: "older",
    threadId: "thread-older",
    direction: "outgoing" as const,
    subject: "Re: Thanks for the call this morning",
    receivedAt: "2026-07-30T12:54:00.000Z",
  };
  const current = {
    ...feed(),
    view: "sent" as const,
    // Reproduce the bad cached order from the screenshots.
    threads: [olderConversation, latestMarkConversation],
  };
  const fresh = {
    ...current,
    // Gmail can briefly omit a message that search/tracking already indexed.
    threads: [olderConversation],
  };

  const stable = preserveStableEmailThreadReferences(current, fresh);
  assert.deepEqual(
    stable.threads.map((item) => item.messageId),
    ["mark-latest", "older"],
  );
});

test("Sent refresh never attaches tracking status to an incoming reply", () => {
  const current = {
    ...feed(),
    view: "sent" as const,
    threads: [
      {
        ...thread,
        direction: "outgoing" as const,
        openStatus: {
          recipients: ["recipient@example.com"],
          attribution: "single_recipient" as const,
          openedAt: "2026-07-28T12:05:00.000Z",
          lastOpenedAt: "2026-07-28T12:05:00.000Z",
          openCount: 1,
        },
      },
    ],
  };
  const fresh = {
    ...current,
    threads: [
      {
        ...current.threads[0],
        direction: "incoming" as const,
        openStatus: null,
      },
    ],
  };

  const preserved = preserveStableEmailThreadReferences(current, fresh);
  assert.equal(preserved.threads[0]?.openStatus, null);
});

test("Sent refresh keeps newer provider tracking data authoritative", () => {
  const current = {
    ...feed(),
    view: "sent" as const,
    threads: [
      {
        ...thread,
        direction: "outgoing" as const,
        openStatus: {
          recipients: ["recipient@example.com"],
          attribution: "single_recipient" as const,
          openedAt: null,
          lastOpenedAt: null,
          openCount: 0,
        },
      },
    ],
  };
  const providerStatus = {
    recipients: ["recipient@example.com"],
    attribution: "single_recipient" as const,
    openedAt: "2026-07-28T12:05:00.000Z",
    lastOpenedAt: "2026-07-28T12:06:00.000Z",
    openCount: 3,
  };
  const fresh = {
    ...current,
    threads: [
      {
        ...current.threads[0],
        openStatus: providerStatus,
      },
    ],
  };

  const preserved = preserveStableEmailThreadReferences(current, fresh);
  assert.equal(preserved.threads[0]?.openStatus, providerStatus);
});

test("mailbox health can arrive after the list without changing counts", () => {
  const updated = mergeEmailMailboxHealth(feed(), [
    {
      ...mailbox,
      address: "verified@example.com",
      status: "reauth_required",
      statusMessage: "Reconnect Gmail.",
      counts: { inbox: 0, focus: 0, drafts: 0, noise: 0 },
    },
  ]);
  assert.equal(updated.mailboxes[0].address, "verified@example.com");
  assert.equal(updated.mailboxes[0].status, "reauth_required");
  assert.deepEqual(updated.mailboxes[0].counts, mailbox.counts);
  assert.equal(
    updated.threads[0].mailbox,
    updated.mailboxes[0],
  );
});

test("a transient profile probe cannot mark a working mailbox unavailable", () => {
  const updated = mergeEmailMailboxHealth(feed(), [
    {
      ...mailbox,
      address: "verified@example.com",
      status: "error",
      statusMessage: "Rate limit exceeded",
      counts: { inbox: 0, focus: 0, drafts: 0, noise: 0 },
    },
  ]);
  assert.equal(updated.mailboxes[0].address, "verified@example.com");
  assert.equal(updated.mailboxes[0].status, "connected");
  assert.equal(updated.mailboxes[0].statusMessage, undefined);
});

test("a transient background sync failure keeps cached mailbox messages", () => {
  const fresh = {
    ...feed(),
    mailboxes: [
      {
        ...mailbox,
        status: "error" as const,
        statusMessage: "Rate limit exceeded",
      },
    ],
    threads: [],
    warnings: ["Work: could not sync"],
  };
  const updated = preserveTransientMailboxFailures(feed(), fresh);
  assert.equal(updated.mailboxes[0].status, "connected");
  assert.equal(updated.threads[0], thread);
  assert.deepEqual(updated.warnings, fresh.warnings);
});
