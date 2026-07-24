import assert from "node:assert/strict";
import test from "node:test";
import {
  incomingUnreadDisposition,
  normalizeUnreadCount,
} from "./unread";

test("unread counts are safe non-negative integers", () => {
  assert.equal(normalizeUnreadCount("4"), 4);
  assert.equal(normalizeUnreadCount(2.9), 2);
  assert.equal(normalizeUnreadCount(-3), 0);
  assert.equal(normalizeUnreadCount("not-a-number"), 0);
});

test("messages from the current user never create unread state", () => {
  assert.equal(
    incomingUnreadDisposition({
      channelId: "channel-1",
      authorType: "user",
      authorUserId: "me",
      currentUserId: "me",
      activeChannelId: "channel-2",
      documentVisible: true,
    }),
    "ignore",
  );
});

test("visible active-room messages are read while other messages are unread", () => {
  const base = {
    channelId: "channel-1",
    authorType: "agent",
    authorUserId: null,
    currentUserId: "me",
    activeChannelId: "channel-1",
  };
  assert.equal(
    incomingUnreadDisposition({ ...base, documentVisible: true }),
    "read",
  );
  assert.equal(
    incomingUnreadDisposition({ ...base, documentVisible: false }),
    "unread",
  );
  assert.equal(
    incomingUnreadDisposition({
      ...base,
      activeChannelId: "channel-2",
      documentVisible: true,
    }),
    "unread",
  );
});
