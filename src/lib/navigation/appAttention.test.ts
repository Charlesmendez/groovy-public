import assert from "node:assert/strict";
import test from "node:test";
import {
  appAreaAttentionDetail,
  appAttentionAreaForHref,
  normalizeAppAreaAttentionCount,
} from "./appAttention";

test("main navigation maps attention only to message areas", () => {
  assert.equal(appAttentionAreaForHref("/dashboard"), null);
  assert.equal(appAttentionAreaForHref("/chat"), "chat");
  assert.equal(appAttentionAreaForHref("/email"), "email");
});

test("navigation attention accepts bounded non-negative counts", () => {
  assert.equal(normalizeAppAreaAttentionCount(3.9), 3);
  assert.equal(normalizeAppAreaAttentionCount(-2), 0);
  assert.equal(normalizeAppAreaAttentionCount("12"), 12);
  assert.equal(normalizeAppAreaAttentionCount(Number.POSITIVE_INFINITY), 0);
  assert.deepEqual(appAreaAttentionDetail({ area: "chat", count: "2" }), {
    area: "chat",
    count: 2,
  });
  assert.equal(appAreaAttentionDetail({ area: "dashboard", count: 1 }), null);
});
