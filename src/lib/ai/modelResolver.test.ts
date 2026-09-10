import assert from "node:assert/strict";
import test from "node:test";
import {
  getAnthropicContextProviderOptions,
  getAnthropicReasoningProviderOptions,
  getModelContextBudget,
  supportsExtendedThinking,
} from "./modelResolver";

test("uses native 1M context for Opus 4.8 and Opus 5", () => {
  for (const model of ["claude-opus-4-8", "claude-opus-5"]) {
    assert.equal(
      getAnthropicContextProviderOptions("anthropic", model),
      undefined,
    );
    assert.equal(
      getModelContextBudget("anthropic", model).contextWindowTokens,
      1_000_000,
    );
  }
});

test("recognizes adaptive thinking for current Opus models", () => {
  for (const model of ["claude-opus-4-8", "claude-opus-5"]) {
    assert.equal(supportsExtendedThinking("anthropic", model), true);
    assert.deepEqual(
      getAnthropicReasoningProviderOptions("anthropic", model, {
        enableThinking: true,
      }),
      { anthropic: { thinking: { type: "adaptive" } } },
    );
  }
});
