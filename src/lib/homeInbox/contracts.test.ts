import assert from "node:assert/strict";
import test from "node:test";
import {
  HomeInboxError,
  parseCompletion,
  parseDecisionClaim,
  parseDecisionMetadata,
  parseModelDecision,
} from "./contracts";
import { claim, decisionId, ids, item } from "./fixtures.test-support";

test("strict decision protocol accepts the Home/Inbox receipt shape", () => {
  assert.deepEqual(parseDecisionMetadata({ items: [item] }), [item]);
  assert.deepEqual(parseDecisionClaim(claim(), ids, decisionId), claim());
  assert.deepEqual(
    parseDecisionClaim(
      { decision_id: decisionId, execute: false, status: "claimed" },
      ids,
      decisionId,
    ),
    { decision_id: decisionId, execute: false, status: "claimed" },
  );
  assert.deepEqual(
    parseCompletion(
      {
        decision_id: decisionId,
        recorded: true,
        replay: false,
        applied: false,
      },
      decisionId,
    ),
    { recorded: true, replay: false, applied: false },
  );
});
test("different tenant/project/funnel/harness/decision or invalid identity fails closed", () => {
  for (const key of [
    "tenant_id",
    "project_id",
    "funnel_id",
    "funnel_lead_id",
    "conversation_id",
  ] as const) {
    const value = claim();
    value.context[key] = "not-authorized";
    assert.throws(
      () => parseDecisionClaim(value, ids, decisionId),
      HomeInboxError,
    );
  }
  assert.throws(() =>
    parseDecisionClaim({ ...claim(), harness_ref: "another" }, ids, decisionId),
  );
  assert.throws(() => parseDecisionClaim(claim(), ids, ids.tenantId));
});
test("extra instructions/actions and unbounded inputs never cross the claim boundary", () => {
  for (const value of [
    { ...claim(), schedule: "tomorrow" },
    { ...claim(), inputs: { profile: { id: "fake" } } },
    { ...claim(), inputs: { score: Infinity } },
    { ...claim(), inputs: { secret: "x".repeat(1025) } },
    { ...claim(), inputs: JSON.parse('{"__proto__":"escape"}') },
    { ...claim(), outcomes: [claim().outcomes[0], claim().outcomes[0]] },
    { ...claim(), expires_at: "yesterday" },
  ])
    assert.throws(() => parseDecisionClaim(value, ids, decisionId));
  assert.throws(() =>
    parseDecisionMetadata({ items: [item], token: "secret" }),
  );
  assert.throws(() => parseDecisionMetadata({ items: Array(51).fill(item) }));
});
test("only configured outcomes and a summary are accepted from a model", () => {
  assert.deepEqual(
    parseModelDecision(
      '{"outcome_key":"review","summary":"  Needs context  "}',
      claim(),
    ),
    { outcome_key: "review", summary: "Needs context" },
  );
  for (const value of [
    '{"outcome_key":"send","summary":null}',
    '{"outcome_key":"keep","summary":null,"usage":{"input_tokens":0}}',
    '{"outcome_key":"keep","summary":null,"message":"hello"}',
    '```json\n{"outcome_key":"keep","summary":null}\n```',
    "not JSON",
  ])
    assert.throws(() => parseModelDecision(value, claim()));
});
