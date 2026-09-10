import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEmailWorkspaceCorrectionToFeed,
  applyEmailWorkspaceCorrectionsToFeed,
  emailTrackingCompletedSendIdentity,
  emailWorkspaceCorrectionFromRow,
  emailWorkspaceCorrectionRemovesFromView,
  emailWorkspacePlacementAppliesToThread,
  emailWorkspaceReadStateAppliesToThread,
  emailWorkspaceOperationForTargetView,
  publishEmailWorkspaceCorrection,
  recentEmailWorkspaceCorrections,
  type EmailWorkspaceCorrection,
} from "./workspaceSync";
import type { EmailFeedResponse, EmailThreadSummary } from "./types";

test("identifies only the tracking write that completes a send", () => {
  const completedAt = "2026-08-24T17:00:00.000Z";
  const sent = {
    id: "tracking-1",
    updated_at: completedAt,
    metadata: {
      email_tracking_record: true,
      email_send_state: "sent",
      email_send_completed_at: completedAt,
    },
  };
  assert.equal(
    emailTrackingCompletedSendIdentity(sent, {
      metadata: { email_send_state: "sending" },
    }),
    `tracking-1:${completedAt}`,
  );
  assert.equal(emailTrackingCompletedSendIdentity(sent, sent), "");
  assert.equal(
    emailTrackingCompletedSendIdentity(
      {
        ...sent,
        updated_at: "2026-08-24T17:05:00.000Z",
        metadata: {
          email_tracking_record: true,
          email_send_state: "sent",
          email_send_completed_at: completedAt,
          email_tracking_open_count: 1,
        },
      },
      { id: "tracking-1" },
    ),
    "",
  );
  assert.equal(
    emailTrackingCompletedSendIdentity(
      {
        id: "tracking-2",
        updated_at: completedAt,
        metadata: {
          email_tracking_record: true,
          email_send_state: "sending",
          email_send_completed_at: completedAt,
        },
      },
      { id: "tracking-2" },
    ),
    "",
  );
});

test("identifies a recovered send without a normal completion timestamp", () => {
  const recoveredAt = "2026-08-24T17:00:00.000Z";
  assert.equal(
    emailTrackingCompletedSendIdentity({
      id: "tracking-recovered",
      updated_at: "2026-08-24T13:00:00-04:00",
      metadata: {
        email_tracking_record: true,
        email_send_state: "sent",
        email_send_recovered_at: recoveredAt,
      },
    }),
    `tracking-recovered:${recoveredAt}`,
  );
});

test("parses a persisted cross-device email correction", () => {
  const correction = emailWorkspaceCorrectionFromRow({
    user_id: "user-1",
    connection_id: "mailbox-1",
    gmail_thread_id: "thread-1",
    metadata: {
      email_workspace_override_view: "handled",
      email_workspace_corrected_at: "2026-08-06T20:00:00.000Z",
    },
  });
  assert.deepEqual(correction, {
    userId: "user-1",
    connectionId: "mailbox-1",
    threadId: "thread-1",
    targetView: "handled",
    targetViewChangedAt: "2026-08-06T20:00:00.000Z",
    correctedAt: "2026-08-06T20:00:00.000Z",
  });
  assert.equal(emailWorkspaceCorrectionRemovesFromView(correction!, "focus"), true);
  assert.equal(emailWorkspaceCorrectionRemovesFromView(correction!, "handled"), false);
  assert.equal(emailWorkspaceOperationForTargetView("handled"), "move_handled");

  const thread = {
    key: "mailbox-1:thread-1",
    connectionId: "mailbox-1",
    threadId: "thread-1",
  } as EmailThreadSummary;
  const feed = {
    schemaVersion: 4,
    view: "focus",
    threads: [thread],
    mailboxes: [],
    nextCursor: null,
    warnings: [],
    stats: {
      focus: 1,
      processed: 0,
      draftsReady: 0,
      needsReview: 0,
      noiseCaught: 0,
    },
  } satisfies EmailFeedResponse;
  const reconciled = applyEmailWorkspaceCorrectionToFeed(feed, correction!);
  assert.equal(reconciled.threads.length, 0);
  assert.equal(reconciled.stats.focus, 0);
  assert.equal(reconciled.stats.processed, 1);
});

test("accepted Done corrections suppress stale refreshes without hiding a newer reply", () => {
  const correctedAt = "2026-08-06T20:00:00.000Z";
  const correction = {
    userId: "user-1",
    connectionId: "mailbox-1",
    threadId: "thread-1",
    targetView: "handled",
    targetViewChangedAt: correctedAt,
    correctedAt,
  } satisfies EmailWorkspaceCorrection;
  const staleThread = {
    key: "mailbox-1:message-1",
    connectionId: "mailbox-1",
    threadId: "thread-1",
    receivedAt: "2026-08-06T19:00:00.000Z",
  } as EmailThreadSummary;
  const unrelated = {
    ...staleThread,
    key: "mailbox-1:message-2",
    threadId: "thread-2",
  };
  const staleRefresh = {
    schemaVersion: 4,
    view: "focus",
    threads: [staleThread, unrelated],
    mailboxes: [],
    nextCursor: null,
    warnings: [],
    stats: {
      focus: 2,
      processed: 0,
      draftsReady: 0,
      needsReview: 0,
      noiseCaught: 0,
    },
  } satisfies EmailFeedResponse;

  const reconciled = applyEmailWorkspaceCorrectionsToFeed(staleRefresh, [
    correction,
  ]);
  assert.deepEqual(reconciled.threads, [unrelated]);
  assert.equal(reconciled.stats.focus, 1);
  assert.equal(reconciled.stats.processed, 1);
  assert.deepEqual(reconciled.authoritativeRemovedConversations, [
    { id: "mailbox-1:thread-1", correctedAt },
  ]);

  const newerReply = {
    ...staleThread,
    key: "mailbox-1:new-reply",
    receivedAt: "2026-08-06T21:00:00.000Z",
  };
  const refreshedWithReply = applyEmailWorkspaceCorrectionsToFeed(
    { ...staleRefresh, threads: [newerReply, unrelated] },
    [correction],
  );
  assert.deepEqual(refreshedWithReply.threads, [newerReply, unrelated]);
  assert.deepEqual(refreshedWithReply.authoritativeRemovedConversations, [
    { id: "mailbox-1:thread-1", correctedAt },
  ]);
});

test("a newer move back into a queue clears its older local removal marker", () => {
  const handledAt = "2026-08-06T20:00:00.000Z";
  const focusedAt = "2026-08-06T21:00:00.000Z";
  const feed = {
    schemaVersion: 4,
    view: "focus",
    threads: [],
    mailboxes: [],
    nextCursor: null,
    warnings: [],
    authoritativeRemovedConversations: [
      { id: "mailbox-1:thread-1", correctedAt: handledAt },
    ],
    stats: {
      focus: 0,
      processed: 1,
      draftsReady: 0,
      needsReview: 0,
      noiseCaught: 0,
    },
  } satisfies EmailFeedResponse;

  const restored = applyEmailWorkspaceCorrectionsToFeed(feed, [
    {
      userId: "user-1",
      connectionId: "mailbox-1",
      threadId: "thread-1",
      targetView: "focus",
      targetViewChangedAt: focusedAt,
      correctedAt: focusedAt,
    },
  ]);

  assert.deepEqual(restored.authoritativeRemovedConversations, []);
});

test("ignores rows that are not explicit workspace corrections", () => {
  assert.equal(
    emailWorkspaceCorrectionFromRow({
      user_id: "user-1",
      connection_id: "mailbox-1",
      gmail_thread_id: "thread-1",
      metadata: {},
    }),
    null,
  );
});

test("replays a persisted read-state change without moving the conversation", () => {
  const correction = emailWorkspaceCorrectionFromRow({
    user_id: "user-1",
    connection_id: "mailbox-1",
    gmail_thread_id: "thread-1",
    metadata: {
      email_workspace_unread: false,
      email_workspace_read_changed_at: "2026-08-14T15:00:00.000Z",
    },
  });
  assert.deepEqual(correction, {
    userId: "user-1",
    connectionId: "mailbox-1",
    threadId: "thread-1",
    unread: false,
    readChangedAt: "2026-08-14T15:00:00.000Z",
    correctedAt: "2026-08-14T15:00:00.000Z",
  });

  const thread = {
    key: "mailbox-1:thread-1",
    connectionId: "mailbox-1",
    threadId: "thread-1",
    unread: true,
  } as EmailThreadSummary;
  const feed = {
    schemaVersion: 4,
    view: "focus",
    threads: [thread],
    mailboxes: [],
    nextCursor: null,
    warnings: [],
    stats: {
      focus: 1,
      processed: 0,
      draftsReady: 0,
      needsReview: 0,
      noiseCaught: 0,
    },
  } satisfies EmailFeedResponse;
  const reconciled = applyEmailWorkspaceCorrectionToFeed(feed, correction!);
  assert.equal(reconciled.threads.length, 1);
  assert.equal(reconciled.threads[0]?.unread, false);
  assert.deepEqual(reconciled.stats, feed.stats);
  assert.equal(
    emailWorkspaceCorrectionRemovesFromView(correction!, "focus"),
    false,
  );
});

test("replays corrections published before the workspace mounts", () => {
  const correction = {
    userId: "late-workspace-user",
    connectionId: "mailbox-1",
    threadId: "thread-1",
    unread: false,
    correctedAt: "2026-08-14T16:00:00.000Z",
  } as const;
  publishEmailWorkspaceCorrection(correction);
  assert.deepEqual(
    recentEmailWorkspaceCorrections("late-workspace-user"),
    [
      {
        ...correction,
        readChangedAt: correction.correctedAt,
      },
    ],
  );
  assert.deepEqual(recentEmailWorkspaceCorrections("another-user"), []);
});

test("keeps queue and read timestamps independent on a persisted action row", () => {
  const correction = emailWorkspaceCorrectionFromRow({
    user_id: "mixed-correction-user",
    connection_id: "mailbox-1",
    gmail_thread_id: "thread-1",
    metadata: {
      email_workspace_override_view: "handled",
      email_workspace_corrected_at: "2026-08-14T12:00:00.000Z",
      email_workspace_unread: false,
      email_workspace_read_changed_at: "2026-08-14T14:00:00.000Z",
    },
  });

  assert.deepEqual(correction, {
    userId: "mixed-correction-user",
    connectionId: "mailbox-1",
    threadId: "thread-1",
    targetView: "handled",
    targetViewChangedAt: "2026-08-14T12:00:00.000Z",
    unread: false,
    readChangedAt: "2026-08-14T14:00:00.000Z",
    correctedAt: "2026-08-14T14:00:00.000Z",
  });
});

test("Done before a new reply cannot remove that reply after it is read", () => {
  const correction = emailWorkspaceCorrectionFromRow({
    user_id: "reply-after-done-user",
    connection_id: "mailbox-1",
    gmail_thread_id: "thread-1",
    metadata: {
      email_workspace_override_view: "handled",
      email_workspace_corrected_at: "2026-08-14T12:00:00.000Z",
      email_workspace_unread: false,
      email_workspace_read_changed_at: "2026-08-14T14:00:00.000Z",
    },
  });
  assert.ok(correction);
  const reply = {
    key: "mailbox-1:message:new-reply",
    connectionId: "mailbox-1",
    threadId: "thread-1",
    receivedAt: "2026-08-14T13:00:00.000Z",
    unread: true,
  } as EmailThreadSummary;
  const feed = {
    schemaVersion: 4,
    view: "focus",
    threads: [reply],
    mailboxes: [],
    nextCursor: null,
    warnings: [],
    stats: {
      focus: 1,
      processed: 0,
      draftsReady: 0,
      needsReview: 0,
      noiseCaught: 0,
    },
  } satisfies EmailFeedResponse;

  const reconciled = applyEmailWorkspaceCorrectionToFeed(feed, correction);
  assert.equal(reconciled.threads.length, 1);
  assert.equal(reconciled.threads[0]?.unread, false);
  assert.deepEqual(reconciled.stats, feed.stats);
  assert.equal(
    emailWorkspacePlacementAppliesToThread(correction, reply),
    false,
  );
});

test("a newer read-only correction does not advance an older Done timestamp", () => {
  const userId = "independent-correction-user";
  publishEmailWorkspaceCorrection({
    userId,
    connectionId: "mailbox-1",
    threadId: "thread-1",
    targetView: "handled",
    targetViewChangedAt: "2026-08-14T12:00:00.000Z",
    correctedAt: "2026-08-14T12:00:00.000Z",
  });
  publishEmailWorkspaceCorrection({
    userId,
    connectionId: "mailbox-1",
    threadId: "thread-1",
    unread: false,
    readChangedAt: "2026-08-14T14:00:00.000Z",
    correctedAt: "2026-08-14T14:00:00.000Z",
  });

  assert.deepEqual(recentEmailWorkspaceCorrections(userId), [
    {
      userId,
      connectionId: "mailbox-1",
      threadId: "thread-1",
      targetView: "handled",
      targetViewChangedAt: "2026-08-14T12:00:00.000Z",
      unread: false,
      readChangedAt: "2026-08-14T14:00:00.000Z",
      correctedAt: "2026-08-14T14:00:00.000Z",
    },
  ]);
});

test("an old read marker cannot mark a later reply read", () => {
  const correction = {
    userId: "old-read-user",
    connectionId: "mailbox-1",
    threadId: "thread-1",
    unread: false,
    readChangedAt: "2026-08-14T12:00:00.000Z",
    correctedAt: "2026-08-14T12:00:00.000Z",
  } satisfies EmailWorkspaceCorrection;
  const reply = {
    key: "mailbox-1:message:new-reply",
    connectionId: "mailbox-1",
    threadId: "thread-1",
    receivedAt: "2026-08-14T13:00:00.000Z",
    unread: true,
  } as EmailThreadSummary;
  const current = {
    schemaVersion: 4,
    view: "focus",
    threads: [reply],
    mailboxes: [],
    nextCursor: null,
    warnings: [],
    stats: {
      focus: 1,
      processed: 0,
      draftsReady: 0,
      needsReview: 0,
      noiseCaught: 0,
    },
  } satisfies EmailFeedResponse;

  assert.equal(emailWorkspaceReadStateAppliesToThread(correction, reply), false);
  assert.equal(applyEmailWorkspaceCorrectionToFeed(current, correction), current);
});
