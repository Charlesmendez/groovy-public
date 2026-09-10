import assert from "node:assert/strict";
import test from "node:test";
import {
  chatMessagePageInfo,
  decodeChatMessageCursor,
  encodeChatMessageCursor,
  newerThanChatMessageCursor,
  olderThanChatMessageCursor,
  parseChatMessagePageSize,
} from "@/lib/chat/messagePagination";

const first = {
  id: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-07-26T19:00:00.000Z",
};
const last = {
  id: "22222222-2222-4222-8222-222222222222",
  created_at: "2026-07-26T20:00:00.000Z",
};

test("chat message cursor round-trips a stable timestamp and id", () => {
  const encoded = encodeChatMessageCursor(first);
  assert.deepEqual(decodeChatMessageCursor(encoded), {
    createdAt: first.created_at,
    id: first.id,
  });
  assert.equal(decodeChatMessageCursor("not-a-cursor"), null);
});

test("chat message cursor creates strict composite boundaries", () => {
  const cursor = decodeChatMessageCursor(encodeChatMessageCursor(first));
  assert.ok(cursor);
  assert.equal(
    olderThanChatMessageCursor(cursor),
    `created_at.lt.${first.created_at},and(created_at.eq.${first.created_at},id.lt.${first.id})`,
  );
  assert.equal(
    newerThanChatMessageCursor(cursor),
    `created_at.gt.${first.created_at},and(created_at.eq.${first.created_at},id.gt.${first.id})`,
  );
});

test("chat message page sizes are bounded", () => {
  assert.equal(parseChatMessagePageSize(null), 50);
  assert.equal(parseChatMessagePageSize("25"), 25);
  assert.equal(parseChatMessagePageSize("1000"), 100);
  assert.equal(parseChatMessagePageSize("invalid"), 50);
});

test("chat message page info exposes only usable cursors", () => {
  assert.deepEqual(
    chatMessagePageInfo([first, last], {
      hasOlder: true,
      hasNewer: true,
    }),
    {
      hasOlder: true,
      olderCursor: encodeChatMessageCursor(first),
      hasNewer: true,
      newerCursor: encodeChatMessageCursor(last),
    },
  );
  assert.deepEqual(
    chatMessagePageInfo([], { hasOlder: true, hasNewer: true }),
    {
      hasOlder: true,
      olderCursor: null,
      hasNewer: true,
      newerCursor: null,
    },
  );
});
