import assert from "node:assert/strict";
import test from "node:test";
import { resolveProviderCostUsd } from "./usageCost";

test("derives provider value for historical included Codex usage", () => {
  const result = resolveProviderCostUsd({
    model: "gpt-5.6-sol",
    inputTokens: 63_084_080,
    outputTokens: 216_821,
    totalTokens: 63_300_901,
    storedModelCostUsd: 0,
    meta: {
      noCacheInputTokens: 2_146_864,
      cacheReadInputTokens: 60_937_216,
      cacheWriteInputTokens: 0,
    },
  });

  assert.deepEqual(result, { costUsd: 47.707558, derived: true });
});

test("preserves a positive provider cost recorded at event time", () => {
  const result = resolveProviderCostUsd({
    model: "gpt-5.6-sol",
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
    storedModelCostUsd: 3.25,
  });

  assert.deepEqual(result, { costUsd: 3.25, derived: false });
});

test("does not invent value for an unmetered event", () => {
  const result = resolveProviderCostUsd({
    model: "gpt-5.6-sol",
    storedModelCostUsd: 0,
  });

  assert.deepEqual(result, { costUsd: 0, derived: false });
});

test("does not apply fallback billing rates when the model is unknown", () => {
  const result = resolveProviderCostUsd({
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
    storedModelCostUsd: 0,
  });

  assert.deepEqual(result, { costUsd: 0, derived: false });
});
