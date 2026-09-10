import assert from "node:assert/strict";
import test from "node:test";
import {
  chatMessageDeliveryConfirmed,
  mergeChatMessages,
  reconcileChatMessages,
  reconcileChatMessagesAfterRequest,
  reconcileLatestChatMessageWindow,
  type MergeableChatMessage,
} from "./messageMerge";

function message(
  id: string,
  createdAt: string,
  metadata: Record<string, unknown> = {},
): MergeableChatMessage {
  return { id, created_at: createdAt, metadata };
}

test("a confirmed message replaces its optimistic counterpart", () => {
  const pending = message("optimistic:client-1", "2026-07-24T10:00:00Z", {
    client_message_id: "client-1",
    client_pending: true,
  });
  const confirmed = message("server-1", "2026-07-24T10:00:01Z", {
    client_message_id: "client-1",
  });

  assert.deepEqual(mergeChatMessages([pending], [confirmed]), [confirmed]);
});

test("delivery confirmation recognizes new sends by their client id", () => {
  const confirmed = message("server-1", "2026-07-24T10:00:01Z", {
    client_message_id: "client-1",
  });

  assert.equal(
    chatMessageDeliveryConfirmed([confirmed], {
      clientMessageId: "client-1",
      content: "Hello",
    }),
    true,
  );
});

test("delivery confirmation recognizes edits only after the content matches", () => {
  const stale = {
    ...message("server-1", "2026-07-24T10:00:01Z"),
    content: "Before",
  };
  const edited = { ...stale, content: "After" };
  const attempt = {
    clientMessageId: "edit-1",
    resendMessageId: "server-1",
    content: "After",
  };

  assert.equal(chatMessageDeliveryConfirmed([stale], attempt), false);
  assert.equal(chatMessageDeliveryConfirmed([edited], attempt), true);
});

test("an edited optimistic message replaces the original row in place", () => {
  const original = message("server-1", "2026-07-24T10:00:00Z");
  const edited = message("server-1", "2026-07-24T10:00:00Z", {
    client_message_id: "edit-1",
    client_pending: true,
  });

  assert.deepEqual(mergeChatMessages([original], [edited]), [edited]);
});

test("a stale refresh cannot overwrite a newer edited message", () => {
  const edited = message("server-1", "2026-07-24T10:00:00Z", {
    edited_at: "2026-07-24T10:05:00Z",
  });
  const stale = message("server-1", "2026-07-24T10:00:00Z");

  assert.deepEqual(mergeChatMessages([edited], [stale]), [edited]);
});

test("a newer server edit replaces the currently displayed edit", () => {
  const edited = message("server-1", "2026-07-24T10:00:00Z", {
    edited_at: "2026-07-24T10:05:00Z",
  });
  const newer = message("server-1", "2026-07-24T10:00:00Z", {
    edited_at: "2026-07-24T10:06:00Z",
  });

  assert.deepEqual(mergeChatMessages([edited], [newer]), [newer]);
});

test("an optimistic edit survives an older in-flight refresh", () => {
  const optimisticEdit = message("server-1", "2026-07-24T10:00:00Z", {
    client_message_id: "edit-1",
    client_pending: true,
    edited_at: "2026-07-24T10:05:00Z",
  });
  const stale = message("server-1", "2026-07-24T10:00:00Z");

  assert.deepEqual(
    mergeChatMessages([optimisticEdit], [stale]),
    [optimisticEdit],
  );
});

test("full reconciliation preserves a confirmed edit newer than its response snapshot", () => {
  const edited = message("server-1", "2026-07-24T10:00:00Z", {
    edited_at: "2026-07-24T10:05:00Z",
  });
  const stale = message("server-1", "2026-07-24T10:00:00Z");

  assert.deepEqual(reconcileChatMessages([edited], [stale]), [edited]);
});

test("reconciliation preserves only optimistic messages absent from the server", () => {
  const existing = message("server-0", "2026-07-24T09:59:00Z");
  const pending = message("optimistic:client-1", "2026-07-24T10:00:00Z", {
    client_message_id: "client-1",
    client_pending: true,
  });

  assert.deepEqual(
    reconcileChatMessages([existing, pending], [existing]),
    [existing, pending],
  );
});

test("reconciliation removes an optimistic duplicate once it is authoritative", () => {
  const pending = message("optimistic:client-1", "2026-07-24T10:00:00Z", {
    client_message_id: "client-1",
    client_pending: true,
  });
  const confirmed = message("server-1", "2026-07-24T10:00:01Z", {
    client_message_id: "client-1",
  });

  assert.deepEqual(
    reconcileChatMessages([pending], [confirmed]),
    [confirmed],
  );
});

test("request reconciliation preserves a confirmed message that arrived live", () => {
  const existing = message("server-0", "2026-07-24T09:59:00Z");
  const liveReply = message("server-live", "2026-07-24T10:00:01Z");
  const requestSnapshotIds = new Set([existing.id]);

  assert.deepEqual(
    reconcileChatMessagesAfterRequest(
      [existing, liveReply],
      [existing],
      requestSnapshotIds,
    ),
    [existing, liveReply],
  );
});

test("latest-window reconciliation repairs missed inserts and deletes", () => {
  const older = message("server-old", "2026-07-24T09:00:00Z");
  const windowStart = message("server-window", "2026-07-24T09:30:00Z");
  const deleted = message("server-deleted", "2026-07-24T10:00:00Z");
  const retained = message("server-retained", "2026-07-24T10:01:00Z");
  const inserted = message("server-inserted", "2026-07-24T10:02:00Z");

  assert.deepEqual(
    reconcileLatestChatMessageWindow(
      [older, windowStart, deleted, retained],
      [windowStart, retained, inserted],
      { hasOlder: true },
    ),
    [older, windowStart, retained, inserted],
  );
});

test("empty latest-window reconciliation preserves pending and thread messages", () => {
  const persisted = message("server-1", "2026-07-24T10:00:00Z");
  const pending = message("optimistic:1", "2026-07-24T10:01:00Z", {
    client_pending: true,
  });
  const thread = {
    ...message("thread-1", "2026-07-24T10:02:00Z"),
    thread_root_message_id: "server-1",
  };

  assert.deepEqual(
    reconcileLatestChatMessageWindow([persisted, pending, thread], [], {
      hasOlder: false,
    }),
    [pending, thread],
  );
});
