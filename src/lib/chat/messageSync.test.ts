import assert from "node:assert/strict";
import test from "node:test";
import {
  chatMessageSyncCursorMatches,
  latestPersistedChatMessageCursor,
  parseChatMessageSyncCursor,
} from "./messageSync";

const firstId = "11111111-1111-4111-8111-111111111111";
const latestId = "22222222-2222-4222-8222-222222222222";

test("message sync cursor validation rejects partial and invalid cursors", () => {
  assert.equal(parseChatMessageSyncCursor(firstId, undefined), null);
  assert.equal(
    parseChatMessageSyncCursor("not-a-uuid", "2026-08-11T12:00:00Z"),
    null,
  );
  assert.deepEqual(
    parseChatMessageSyncCursor(firstId, "2026-08-11T12:00:00Z"),
    { id: firstId, createdAt: "2026-08-11T12:00:00Z" },
  );
});

test("latest timeline cursor ignores optimistic rows and thread replies", () => {
  assert.deepEqual(
    latestPersistedChatMessageCursor([
      {
        id: firstId,
        created_at: "2026-08-11T12:00:00Z",
        thread_root_message_id: null,
      },
      {
        id: latestId,
        created_at: "2026-08-11T12:02:00Z",
        thread_root_message_id: firstId,
      },
      {
        id: "optimistic:pending",
        created_at: "2026-08-11T12:03:00Z",
        thread_root_message_id: null,
        metadata: { client_pending: true },
      },
    ]),
    { id: firstId, createdAt: "2026-08-11T12:00:00Z" },
  );
});

test("latest timeline cursor compares real instants instead of timestamp text", () => {
  assert.deepEqual(
    latestPersistedChatMessageCursor([
      {
        id: firstId,
        created_at: "2026-08-11T13:00:00+01:00",
        thread_root_message_id: null,
      },
      {
        id: latestId,
        created_at: "2026-08-11T12:30:00Z",
        thread_root_message_id: null,
      },
    ]),
    { id: latestId, createdAt: "2026-08-11T12:30:00Z" },
  );
});

test("message sync cursor comparison requires both id and timestamp", () => {
  const cursor = { id: latestId, createdAt: "2026-08-11T12:02:00Z" };
  assert.equal(chatMessageSyncCursorMatches(cursor, { ...cursor }), true);
  assert.equal(
    chatMessageSyncCursorMatches(cursor, {
      ...cursor,
      createdAt: "2026-08-11T12:03:00Z",
    }),
    false,
  );
  assert.equal(chatMessageSyncCursorMatches(cursor, null), false);
  assert.equal(chatMessageSyncCursorMatches(null, null), false);
});
