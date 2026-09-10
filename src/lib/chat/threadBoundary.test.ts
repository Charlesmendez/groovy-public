import assert from "node:assert/strict";
import test from "node:test";
import {
  messageBelongsToThread,
  threadReplyCounts,
  threadRootId,
} from "./threadBoundary";

test("normalizes a nested reply to its top-level thread root", () => {
  assert.equal(
    threadRootId({
      id: "reply-2",
      thread_root_message_id: "root-1",
    }),
    "root-1",
  );
  assert.equal(threadRootId({ id: "root-1" }), "root-1");
});

test("rejects replies from another thread boundary", () => {
  assert.equal(
    messageBelongsToThread(
      { id: "reply-a", thread_root_message_id: "root-a" },
      "root-a",
    ),
    true,
  );
  assert.equal(
    messageBelongsToThread(
      { id: "reply-b", thread_root_message_id: "root-b" },
      "root-a",
    ),
    false,
  );
});

test("counts replies independently for each thread", () => {
  assert.deepEqual(
    Object.fromEntries(
      threadReplyCounts([
        { id: "root-a" },
        { id: "a-1", thread_root_message_id: "root-a" },
        { id: "a-2", thread_root_message_id: "root-a" },
        { id: "b-1", thread_root_message_id: "root-b" },
      ]),
    ),
    { "root-a": 2, "root-b": 1 },
  );
});
