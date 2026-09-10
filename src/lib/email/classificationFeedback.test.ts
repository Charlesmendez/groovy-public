import assert from "node:assert/strict";
import test from "node:test";
import {
  isEmailClassificationCorrection,
  shouldRecordEmailClassificationFeedback,
} from "./classificationFeedback";

test("only queue-classification moves create sender learning feedback", () => {
  assert.equal(shouldRecordEmailClassificationFeedback("move_focus"), true);
  assert.equal(shouldRecordEmailClassificationFeedback("move_inbox"), true);
  assert.equal(shouldRecordEmailClassificationFeedback("move_noise"), true);
  assert.equal(shouldRecordEmailClassificationFeedback("move_handled"), false);
  assert.equal(shouldRecordEmailClassificationFeedback("archive"), false);
});

test("historical handled feedback is excluded from classifier guidance", () => {
  assert.equal(isEmailClassificationCorrection("focus"), true);
  assert.equal(isEmailClassificationCorrection("inbox"), true);
  assert.equal(isEmailClassificationCorrection("noise"), true);
  assert.equal(isEmailClassificationCorrection("handled"), false);
  assert.equal(isEmailClassificationCorrection("archive"), false);
});
