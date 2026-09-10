import assert from "node:assert/strict";
import test from "node:test";
import { mergeChronologicalChatTimeline } from "./timelineEntries";

test("active work stays before a message sent after the work started", () => {
  const entries = mergeChronologicalChatTimeline(
    [
      { id: "trigger", created_at: "2026-07-30T18:00:00.000Z" },
      { id: "follow-up", created_at: "2026-07-30T18:00:05.000Z" },
    ],
    [
      {
        key: "agent-run",
        startedAt: "2026-07-30T18:00:01.000Z",
        value: "working",
      },
    ],
  );

  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === "message" ? entry.message.id : entry.work,
    ),
    ["trigger", "working", "follow-up"],
  );
});

test("work started by the newest message renders after that message", () => {
  const entries = mergeChronologicalChatTimeline(
    [{ id: "trigger", created_at: "2026-07-30T18:00:00.000Z" }],
    [
      {
        key: "agent-run",
        startedAt: "2026-07-30T18:00:00.100Z",
        value: "working",
      },
    ],
  );

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["message", "work"],
  );
});

test("delegated work renders after its Mind response even when it started first", () => {
  const entries = mergeChronologicalChatTimeline(
    [
      { id: "user-request", created_at: "2026-07-30T18:00:00.000Z" },
      { id: "mind-response", created_at: "2026-07-30T18:00:02.000Z" },
      { id: "later-message", created_at: "2026-07-30T18:00:03.000Z" },
    ],
    [
      {
        key: "delegated-agent-run",
        startedAt: "2026-07-30T18:00:01.000Z",
        anchorMessageId: "mind-response",
        value: "working",
      },
    ],
  );

  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === "message" ? entry.message.id : entry.work,
    ),
    ["user-request", "mind-response", "working", "later-message"],
  );
  assert.equal(entries[2].timestamp, "2026-07-30T18:00:01.000Z");
});

test("work with an unloaded anchor keeps its chronological position", () => {
  const entries = mergeChronologicalChatTimeline(
    [
      { id: "trigger", created_at: "2026-07-30T18:00:00.000Z" },
      { id: "follow-up", created_at: "2026-07-30T18:00:05.000Z" },
    ],
    [
      {
        key: "agent-run",
        startedAt: "2026-07-30T18:00:01.000Z",
        anchorMessageId: "not-loaded",
        value: "working",
      },
    ],
  );

  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === "message" ? entry.message.id : entry.work,
    ),
    ["trigger", "working", "follow-up"],
  );
});

test("work older than the loaded message window pins after the newest message", () => {
  const entries = mergeChronologicalChatTimeline(
    [
      { id: "oldest-loaded", created_at: "2026-07-30T18:00:00.000Z" },
      { id: "newest", created_at: "2026-07-30T19:00:00.000Z" },
    ],
    [
      {
        key: "stale-approval",
        startedAt: "2026-07-29T09:00:00.000Z",
        value: "needs-approval",
      },
    ],
  );

  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === "message" ? entry.message.id : entry.work,
    ),
    ["oldest-loaded", "newest", "needs-approval"],
  );
  // The card keeps its true timestamp for display even when repositioned.
  assert.equal(entries[2].timestamp, "2026-07-29T09:00:00.000Z");
});

test("multiple out-of-window work items keep their relative order at the end", () => {
  const entries = mergeChronologicalChatTimeline(
    [{ id: "only-loaded", created_at: "2026-07-30T18:00:00.000Z" }],
    [
      {
        key: "older-task",
        startedAt: "2026-07-28T10:00:00.000Z",
        value: "older",
      },
      {
        key: "newer-task",
        startedAt: "2026-07-29T10:00:00.000Z",
        value: "newer",
      },
    ],
  );

  assert.deepEqual(
    entries.map((entry) =>
      entry.kind === "message" ? entry.message.id : entry.work,
    ),
    ["only-loaded", "older", "newer"],
  );
});

test("work stays chronological when no messages are loaded", () => {
  const entries = mergeChronologicalChatTimeline(
    [],
    [
      {
        key: "agent-run",
        startedAt: "2026-07-30T18:00:00.000Z",
        value: "working",
      },
    ],
  );

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["work"],
  );
});
