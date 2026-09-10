import assert from "node:assert/strict";
import test from "node:test";
import { canMarkEmailDone, getEmailSwipeActions } from "./interactions";

test("every active Focus lane, including Worth Reading, can be marked Done", () => {
  assert.equal(canMarkEmailDone("focus"), true);
  assert.equal(canMarkEmailDone("inbox"), true);
  assert.equal(canMarkEmailDone("noise"), true);
  assert.equal(canMarkEmailDone("handled"), false);
  assert.equal(canMarkEmailDone("sent"), false);
  assert.equal(canMarkEmailDone("all"), true);
});

test("Focus, Needs Review, and All Mail use Done on the right and Noise on the left", () => {
  for (const view of ["focus", "inbox", "all"] as const) {
    const actions = getEmailSwipeActions(view);
    assert.equal(actions.right.operation, "move_handled");
    assert.equal(actions.right.label, "Done");
    assert.equal(actions.left.operation, "move_noise");
  }
});

test("Noise makes both swipe directions useful without trapping the email", () => {
  const actions = getEmailSwipeActions("noise");
  assert.equal(actions.right.operation, "move_inbox");
  assert.equal(actions.right.label, "Needs Review");
  assert.equal(actions.left.operation, "move_handled");
});

test("AI-focused mail returns to Focus when recovered", () => {
  for (const view of ["noise", "handled"] as const) {
    const actions = getEmailSwipeActions(view, { recoverToFocus: true });
    assert.equal(actions.right.operation, "move_focus");
    assert.equal(actions.right.label, "Focus");
  }
});

test("Handled non-focus mail can be corrected in either direction", () => {
  const actions = getEmailSwipeActions("handled");
  assert.equal(actions.right.operation, "move_inbox");
  assert.equal(actions.right.label, "Needs Review");
  assert.equal(actions.left.operation, "move_noise");
});
