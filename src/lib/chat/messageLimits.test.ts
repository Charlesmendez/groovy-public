import assert from "node:assert/strict";
import test from "node:test";
import {
  chatMessageLengthError,
  MAX_CHAT_MESSAGE_CHARACTERS,
} from "./messageLimits";

test("accepts chat messages at the server limit", () => {
  assert.equal(chatMessageLengthError("a".repeat(MAX_CHAT_MESSAGE_CHARACTERS)), null);
});

test("measures trimmed content like the message API", () => {
  assert.equal(
    chatMessageLengthError(`  ${"a".repeat(MAX_CHAT_MESSAGE_CHARACTERS)}  `),
    null,
  );
});

test("explains an oversized message and confirms the draft is retained", () => {
  const error = chatMessageLengthError(
    "a".repeat(MAX_CHAT_MESSAGE_CHARACTERS + 1),
  );
  assert.match(error || "", /40,001 \/ 40,000 characters/);
  assert.match(error || "", /draft has been kept/i);
});

