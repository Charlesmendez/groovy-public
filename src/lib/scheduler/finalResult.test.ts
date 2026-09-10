import assert from "node:assert/strict";
import test from "node:test";
import { isIncompleteScheduledFinal } from "./finalResult";

test("scheduled finals reject queued and future-work acknowledgements", () => {
  assert.equal(
    isIncompleteScheduledFinal("The browser extraction task has been queued."),
    true,
  );
  assert.equal(
    isIncompleteScheduledFinal("I'll check the report and continue shortly."),
    true,
  );
});

test("scheduled finals accept completed content and known summaries", () => {
  assert.equal(
    isIncompleteScheduledFinal(
      "Good morning! My alarm clock and I had a fight. It won by snooze decision.",
    ),
    false,
  );
  assert.equal(
    isIncompleteScheduledFinal("Weekly summary: 14 tasks completed."),
    false,
  );
  assert.equal(isIncompleteScheduledFinal(""), false);
});
