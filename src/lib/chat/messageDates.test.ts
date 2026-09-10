import assert from "node:assert/strict";
import test from "node:test";
import {
  formatChatCalendarDate,
  isDifferentChatCalendarDate,
} from "./messageDates";

test("starts the timeline and each new local calendar date with a separator", () => {
  assert.equal(
    isDifferentChatCalendarDate(null, "2026-07-28T14:00:00.000Z"),
    true,
  );
  assert.equal(
    isDifferentChatCalendarDate(
      "2026-07-28T14:00:00.000Z",
      "2026-07-28T15:00:00.000Z",
    ),
    false,
  );
  assert.equal(
    isDifferentChatCalendarDate(
      "2026-07-27T14:00:00.000Z",
      "2026-07-28T14:00:00.000Z",
    ),
    true,
  );
});

test("uses friendly labels for today and yesterday", () => {
  const now = new Date(2026, 6, 28, 12, 0, 0);
  assert.equal(
    formatChatCalendarDate(new Date(2026, 6, 28, 8, 0, 0).toISOString(), now),
    "Today",
  );
  assert.equal(
    formatChatCalendarDate(new Date(2026, 6, 27, 22, 0, 0).toISOString(), now),
    "Yesterday",
  );
});
