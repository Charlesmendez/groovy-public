import assert from "node:assert/strict";
import test from "node:test";
import {
  isAgentTaskReadOnly,
  nextAgentTaskHarnessSessionId,
  parseAgentTaskAccessMode,
  resolveAgentTaskResumeSessionId,
  verifiedAgentTaskSessionId,
} from "./agentTaskExecutionPolicy";

test("delegated task access mode is explicit", () => {
  assert.equal(parseAgentTaskAccessMode("read_only"), "read_only");
  assert.equal(parseAgentTaskAccessMode("read_write"), "read_write");
  assert.equal(parseAgentTaskAccessMode(undefined), null);
  assert.equal(parseAgentTaskAccessMode("analysis"), null);
});

test("plan and consultation tasks are always read-only", () => {
  assert.equal(isAgentTaskReadOnly({ access_mode: "read_only" }), true);
  assert.equal(isAgentTaskReadOnly({ plan_mode: true }), true);
  assert.equal(isAgentTaskReadOnly({ consultation_mode: true }), true);
  assert.equal(isAgentTaskReadOnly({ access_mode: "read_write" }), false);
});

test("independent tasks only resume their own harness session", () => {
  assert.equal(resolveAgentTaskResumeSessionId(null), null);
  assert.equal(resolveAgentTaskResumeSessionId(" task-session "), "task-session");
});

test("failed runs cannot verify a persistent interactive session", () => {
  assert.equal(
    verifiedAgentTaskSessionId({
      ok: false,
      reportedSessionId: "stale-session",
    }),
    null,
  );
  assert.equal(
    verifiedAgentTaskSessionId({
      ok: true,
      reportedSessionId: "fresh-session",
    }),
    "fresh-session",
  );
});

test("a discarded resume is removed from the task after failed recovery", () => {
  assert.equal(
    nextAgentTaskHarnessSessionId({
      ok: false,
      reportedSessionId: null,
      previousSessionId: "stale-session",
      sessionRecoveryAttempted: true,
    }),
    null,
  );
  assert.equal(
    nextAgentTaskHarnessSessionId({
      ok: true,
      reportedSessionId: "fresh-session",
      previousSessionId: "stale-session",
      sessionRecoveryAttempted: true,
    }),
    "fresh-session",
  );
});
