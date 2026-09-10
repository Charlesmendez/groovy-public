import assert from "node:assert/strict";
import test from "node:test";
import {
  emailFocusNotificationCopy,
  emailFocusNotificationUrl,
  emailFocusPrefetchTargets,
  focusArrivalFromAction,
} from "./focusNotifications";

const focusRow = {
  id: "action-1",
  recommended_action: "draft_reply",
  status: "pending",
  sender_name: "Alex",
  sender_email: "alex@example.com",
  subject: "Can you review this?",
  mailbox_label: "Work",
  connection_id: "conn-1",
  gmail_thread_id: "thread-1",
  gmail_message_id: "message-1",
  confidence: 0.96,
  metadata: { auto_execute_planned: false },
};

test("only newly classified Focus actions become notifications", () => {
  assert.deepEqual(focusArrivalFromAction(focusRow), {
    actionId: "action-1",
    senderName: "Alex",
    senderEmail: "alex@example.com",
    subject: "Can you review this?",
    mailboxLabel: "Work",
    connectionId: "conn-1",
    threadId: "thread-1",
    messageId: "message-1",
  });
  assert.equal(
    focusArrivalFromAction({
      ...focusRow,
      recommended_action: "mark_spam",
    }),
    null,
  );
  assert.equal(
    focusArrivalFromAction({
      ...focusRow,
      recommended_action: "archive",
    }),
    null,
  );
  assert.equal(
    focusArrivalFromAction({
      ...focusRow,
      confidence: 0.42,
    }),
    null,
  );
  assert.equal(
    focusArrivalFromAction({
      ...focusRow,
      status: "failed",
    }),
    null,
  );
  assert.equal(
    focusArrivalFromAction({
      ...focusRow,
      metadata: { email_workspace_unread: false },
    }),
    null,
  );
  assert.equal(
    focusArrivalFromAction({
      ...focusRow,
      metadata: { auto_execute_planned: true },
    }),
    null,
  );
  assert.equal(
    focusArrivalFromAction({
      ...focusRow,
      metadata: { email_workspace_user_action: "move_focus" },
    }),
    null,
  );
});

test("Focus notification copy is compact for one email and grouped for many", () => {
  const arrival = focusArrivalFromAction(focusRow);
  assert.ok(arrival);
  assert.deepEqual(emailFocusNotificationCopy([arrival]), {
    title: "Focus · Alex",
    body: "Can you review this?",
  });
  assert.equal(
    emailFocusNotificationCopy([
      arrival,
      { ...arrival, actionId: "action-2", subject: "Second" },
    ]).title,
    "2 emails entered Focus",
  );
});

test("prefetch targets cover batched arrivals so any tap is warm", () => {
  const first = focusArrivalFromAction(focusRow);
  assert.ok(first);
  const second = {
    ...first,
    actionId: "action-2",
    threadId: "thread-2",
    messageId: "message-2",
  };
  assert.deepEqual(emailFocusPrefetchTargets([first, second]), [
    { connectionId: "conn-1", threadId: "thread-1", messageId: "message-1" },
    { connectionId: "conn-1", threadId: "thread-2", messageId: "message-2" },
  ]);
  // Duplicates collapse and untargetable arrivals are skipped.
  assert.deepEqual(
    emailFocusPrefetchTargets([first, first, { ...first, threadId: undefined }]),
    [{ connectionId: "conn-1", threadId: "thread-1", messageId: "message-1" }],
  );
  assert.equal(
    emailFocusPrefetchTargets([
      first,
      { ...first, threadId: "t2" },
      { ...first, threadId: "t3" },
      { ...first, threadId: "t4" },
    ]).length,
    3,
  );
});

test("a single Focus arrival deep-links to its conversation", () => {
  const arrival = focusArrivalFromAction(focusRow);
  assert.ok(arrival);
  assert.equal(
    emailFocusNotificationUrl([arrival]),
    "/email?openConnectionId=conn-1&openThreadId=thread-1&openMessageId=message-1",
  );
  assert.equal(
    emailFocusNotificationUrl([
      arrival,
      { ...arrival, actionId: "action-2" },
    ]),
    "/email",
  );
  assert.equal(
    emailFocusNotificationUrl([
      { ...arrival, connectionId: undefined, threadId: undefined },
    ]),
    "/email",
  );
});
