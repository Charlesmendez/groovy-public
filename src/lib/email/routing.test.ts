import assert from "node:assert/strict";
import test from "node:test";
import {
  routeEmailClassification,
  shouldAutoExecuteEmailAction,
} from "./routing";

test("high-confidence classifications route independently of Gmail mutation approval", () => {
  assert.equal(
    routeEmailClassification({
      action: "draft_reply",
      status: "pending",
      confidence: 0.8,
    }),
    "focus",
  );
  assert.equal(
    routeEmailClassification({
      action: "mark_spam",
      status: "pending",
      confidence: 0.8,
    }),
    "noise",
  );
  assert.equal(
    routeEmailClassification({
      action: "label_only",
      status: "done",
      confidence: 0.9,
    }),
    "focus",
  );
});

test("unclassified, uncertain, failed, and pending archive mail needs review", () => {
  assert.equal(routeEmailClassification({}), "needs_review");
  assert.equal(
    routeEmailClassification({
      action: "label_only",
      status: "pending",
      confidence: 0.79,
    }),
    "needs_review",
  );
  assert.equal(
    routeEmailClassification({
      action: "label_only",
      status: "done",
      confidence: 0.79,
    }),
    "needs_review",
  );
  assert.equal(
    routeEmailClassification({
      action: "mark_spam",
      status: "failed",
      confidence: 0.99,
    }),
    "needs_review",
  );
  assert.equal(
    routeEmailClassification({
      action: "archive",
      status: "pending",
      confidence: 0.9,
    }),
    "needs_review",
  );
  assert.equal(
    routeEmailClassification({
      action: "unsubscribe",
      status: "pending",
      confidence: 0.99,
    }),
    "noise",
  );
  assert.equal(
    routeEmailClassification({
      action: "mark_spam",
      status: "pending",
      confidence: 0.99,
    }),
    "noise",
  );
  assert.equal(
    routeEmailClassification({
      action: "draft_reply",
      status: "pending",
      confidence: 0.99,
      critical: true,
    }),
    "focus",
  );
});

test("completed Gmail mutations remain in their actual workflow destination", () => {
  assert.equal(
    routeEmailClassification({
      action: "mark_spam",
      status: "done",
      confidence: 0.5,
    }),
    "noise",
  );
  assert.equal(
    routeEmailClassification({
      action: "unsubscribe",
      status: "done",
      confidence: 0.5,
    }),
    "noise",
  );
  assert.equal(
    routeEmailClassification({
      action: "archive",
      status: "done",
      confidence: 0.5,
    }),
    "handled",
  );
});

test("completed label-only bookkeeping does not mark external work handled", () => {
  assert.equal(
    routeEmailClassification({
      action: "label_only",
      status: "done",
      confidence: 0.95,
    }),
    "focus",
  );
  assert.equal(
    routeEmailClassification({
      action: "label_only",
      status: "done",
      confidence: 0.95,
      critical: true,
    }),
    "focus",
  );
});

test("explicit user placement overrides the classifier", () => {
  assert.equal(
    routeEmailClassification({
      action: "mark_spam",
      status: "done",
      confidence: 1,
      override: "focus",
    }),
    "focus",
  );
  assert.equal(
    routeEmailClassification({
      action: "draft_reply",
      status: "pending",
      confidence: 1,
      override: "inbox",
    }),
    "needs_review",
  );
});

test("Gmail mutations retain stricter safety thresholds", () => {
  assert.equal(
    shouldAutoExecuteEmailAction({
      action: "mark_spam",
      requested: true,
      confidence: 0.929,
    }),
    false,
  );
  assert.equal(
    shouldAutoExecuteEmailAction({
      action: "mark_spam",
      requested: true,
      confidence: 0.93,
    }),
    true,
  );
  assert.equal(
    shouldAutoExecuteEmailAction({
      action: "archive",
      requested: true,
      confidence: 0.879,
    }),
    false,
  );
  assert.equal(
    shouldAutoExecuteEmailAction({
      action: "archive",
      requested: true,
      confidence: 0.88,
    }),
    true,
  );
  assert.equal(
    shouldAutoExecuteEmailAction({
      action: "unsubscribe",
      requested: true,
      confidence: 1,
    }),
    false,
  );
});
