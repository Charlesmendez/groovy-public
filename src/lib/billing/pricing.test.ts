import assert from "node:assert/strict";
import test from "node:test";
import {
  computeUsageChargeBreakdown,
  getModelPricingUsdPerMillion,
} from "./pricing";

test("current catalog models resolve to their own pricing tiers", () => {
  assert.deepEqual(getModelPricingUsdPerMillion("gpt-5.6-sol"), {
    key: "gpt-5.6-sol",
    pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  });
  assert.deepEqual(getModelPricingUsdPerMillion("gpt-5.6-terra"), {
    key: "gpt-5.6-terra",
    pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  });
  assert.deepEqual(getModelPricingUsdPerMillion("gpt-5.6-luna"), {
    key: "gpt-5.6-luna",
    pricing: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  });
  assert.deepEqual(getModelPricingUsdPerMillion("claude-fable-5"), {
    key: "claude-fable-5",
    pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  });
});

test("current models no longer fall through to the Opus billing fallback", () => {
  const luna = computeUsageChargeBreakdown({
    model: "gpt-5.6-luna",
    usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
    chargeType: "groovy_key",
  });
  assert.equal(luna?.modelPriceKey, "gpt-5.6-luna");
  assert.equal(luna?.modelCostUsd, 0.2);

  const fable = computeUsageChargeBreakdown({
    model: "claude-fable-5",
    usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
    chargeType: "groovy_key",
  });
  assert.equal(fable?.modelPriceKey, "claude-fable-5");
  assert.equal(fable?.modelCostUsd, 10);
});

test("included usage retains its cache-aware provider value while charging zero", () => {
  const codex = computeUsageChargeBreakdown({
    model: "gpt-5.6-sol",
    usage: {
      inputTokens: 63_084_080,
      outputTokens: 216_821,
      totalTokens: 63_300_901,
      noCacheInputTokens: 2_146_864,
      cacheReadInputTokens: 60_937_216,
      cacheWriteInputTokens: 0,
    },
    chargeType: "no_charge",
  });

  assert.equal(codex?.modelCostUsd, 47.707558);
  assert.equal(codex?.totalChargeUsd, 0);
});
