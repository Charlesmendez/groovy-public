import assert from "node:assert/strict";
import test from "node:test";
import {
  createHarnessThreadToken,
  verifyHarnessThreadToken,
} from "./threadToken";

test("publishable thread tokens are bound to their embedding origin", () => {
  const prior = process.env.HARNESS_THREAD_TOKEN_SECRET;
  process.env.HARNESS_THREAD_TOKEN_SECRET = "test-thread-token-secret";
  try {
    const token = createHarnessThreadToken({
      threadId: "thread-1",
      keyId: "key-1",
      requestOrigin: "https://support.example",
    });
    assert.equal(
      verifyHarnessThreadToken({
        token,
        threadId: "thread-1",
        keyId: "key-1",
        requestOrigin: "https://support.example",
      }),
      true,
    );
    assert.equal(
      verifyHarnessThreadToken({
        token,
        threadId: "thread-1",
        keyId: "key-1",
        requestOrigin: "https://shop.example",
      }),
      false,
    );
  } finally {
    if (prior === undefined) delete process.env.HARNESS_THREAD_TOKEN_SECRET;
    else process.env.HARNESS_THREAD_TOKEN_SECRET = prior;
  }
});
