import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseEmailAssistTier,
  EMAIL_MODEL_NAME,
  EMAIL_MODEL_PROVIDER,
  getEmailReasoningEffort,
} from "./modelRouting";

test("every email workload is pinned to OpenAI Luna", () => {
  assert.equal(EMAIL_MODEL_PROVIDER, "openai");
  assert.equal(EMAIL_MODEL_NAME, "gpt-5.6-luna");
  assert.equal(getEmailReasoningEffort("fast"), "none");
  assert.equal(getEmailReasoningEffort("quality"), "low");
  assert.equal(getEmailReasoningEffort("escalation"), "low");
});

test("writing assistance escalates invisibly only for difficult revisions", () => {
  assert.equal(chooseEmailAssistTier({ task: "complete" }), "fast");
  assert.equal(chooseEmailAssistTier({ task: "rewrite" }), "quality");
  assert.equal(
    chooseEmailAssistTier({
      task: "steer",
      instruction: "You missed the nuance. Start over and be careful.",
    }),
    "escalation",
  );
});
