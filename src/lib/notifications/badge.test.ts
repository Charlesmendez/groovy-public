import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeNotificationBadgeCount,
  notificationBadgeLabel,
  notificationUnreadState,
  titleWithNotificationBadge,
  totalNotificationBadgeCount,
} from "./badge";

test("notification badge counts are normalized and bounded for display", () => {
  assert.equal(normalizeNotificationBadgeCount(-4), 0);
  assert.equal(normalizeNotificationBadgeCount(3.8), 3);
  assert.equal(normalizeNotificationBadgeCount("invalid"), 0);
  assert.equal(notificationBadgeLabel(99), "99");
  assert.equal(notificationBadgeLabel(100), "99+");
  assert.equal(totalNotificationBadgeCount([2, 3.9, -1, "4"]), 9);
});

test("notification unread state includes only channels needing attention", () => {
  assert.deepEqual(
    notificationUnreadState([
      ["channel-a", 2],
      ["channel-b", 0],
      ["channel-c", 3.9],
      ["", 8],
    ]),
    {
      unreadCount: 5,
      unreadChannelIds: ["channel-a", "channel-c"],
    },
  );
});

test("notification titles replace their existing badge prefix", () => {
  assert.equal(
    titleWithNotificationBadge("GROOVY | Command Center", 4),
    "(4) GROOVY | Command Center",
  );
  assert.equal(
    titleWithNotificationBadge("(4) GROOVY | Command Center", 120),
    "(99+) GROOVY | Command Center",
  );
  assert.equal(
    titleWithNotificationBadge("(99+) GROOVY | Command Center", 0),
    "GROOVY | Command Center",
  );
});
