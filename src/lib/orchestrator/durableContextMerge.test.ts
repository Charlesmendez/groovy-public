import assert from "node:assert/strict";
import test from "node:test";
import type { ModelMessage } from "ai";
import { reconcileCurrentUserMessage } from "./durableContextMerge";

test("does not replace or duplicate a newly persisted current turn", () => {
  const durableHistory: ModelMessage[] = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
  ];
  const result = reconcileCurrentUserMessage({
    durableHistory,
    callerHistory: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ],
    currentMessage: "second question",
  });

  assert.deepEqual(result, durableHistory);
});

test("appends the current request instead of an older caller turn", () => {
  const result = reconcileCurrentUserMessage({
    durableHistory: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ],
    callerHistory: [{ role: "user", content: "first question" }],
    currentMessage: "second question",
  });

  assert.deepEqual(result.at(-1), {
    role: "user",
    content: "second question",
  });
});

test("preserves matching multipart caller content", () => {
  const multipart = {
    role: "user" as const,
    content: [
      { type: "image" as const, image: "base64-image" },
      { type: "text" as const, text: "analyze this" },
    ],
  };
  const result = reconcileCurrentUserMessage({
    durableHistory: [{ role: "user", content: "analyze this" }],
    callerHistory: [multipart],
    currentMessage: "analyze this",
  });

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], multipart);
});

test("uses parsed fallback content when the current turn is not persisted", () => {
  const result = reconcileCurrentUserMessage({
    durableHistory: [],
    callerHistory: [],
    currentMessage: "/browser open the report",
    fallbackContent: "open the report",
  });

  assert.deepEqual(result, [
    { role: "user", content: "open the report" },
  ]);
});
