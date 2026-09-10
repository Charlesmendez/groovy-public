import assert from "node:assert/strict";
import test from "node:test";
import {
  chatRoundChangesScheduledTasks,
  resolveChatRoundText,
} from "./orchestratorResponse";

test("keeps a normal final assistant response", () => {
  assert.equal(
    resolveChatRoundText({ kind: "final", text: "Here is the result." }),
    "Here is the result.",
  );
});

test("extracts a delegated task message from wrapped tool output", () => {
  assert.equal(
    resolveChatRoundText({
      kind: "final",
      text: "",
      toolOutputText: JSON.stringify({
        success: true,
        result: { message: "Task queued on Groovy." },
      }),
    }),
    "Task queued on Groovy.",
  );
});

test("rejects an empty turn instead of recording a false success", () => {
  assert.throws(
    () =>
      resolveChatRoundText({ kind: "final", text: "", toolOutputText: "" }),
    /empty final response/,
  );
});

test("explains unsupported connector round trips", () => {
  assert.equal(
    resolveChatRoundText({ kind: "needs_connector" }),
    "This channel turn could not be completed without a local connector.",
  );
});

test("detects schedule mutations without treating reads as changes", () => {
  assert.equal(
    chatRoundChangesScheduledTasks({
      kind: "final",
      text: "Created.",
      toolCallsExecuted: ["schedule_create"],
    }),
    true,
  );
  assert.equal(
    chatRoundChangesScheduledTasks({
      kind: "final",
      text: "Here are your schedules.",
      toolCallsExecuted: ["schedule_list"],
    }),
    false,
  );
  assert.equal(
    chatRoundChangesScheduledTasks({
      kind: "final",
      text: "Updated.",
      toolCallsExecuted: ["schedule_update"],
    }),
    true,
  );
  assert.equal(
    chatRoundChangesScheduledTasks({
      kind: "final",
      text: "Done.",
      toolCallsExecuted: ["schedule_pause", "schedule_resume"],
    }),
    true,
  );
});
