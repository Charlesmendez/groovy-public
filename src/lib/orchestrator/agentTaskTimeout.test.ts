import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_AGENT_RUN_TIMEOUT_MS,
  appendTimeoutContinuationNotice,
  isCodeAgentTimeoutResult,
  shouldContinueTimedOutCodeAgent,
  timeoutContinuationCount,
} from "./agentTaskTimeout";

test("code-agent runs use a thirty-minute execution window", () => {
  assert.equal(CODE_AGENT_RUN_TIMEOUT_MS, 1_800_000);
});

test("recognizes connector and relay timeout results", () => {
  assert.equal(isCodeAgentTimeoutResult({ timed_out: true }), true);
  assert.equal(
    isCodeAgentTimeoutResult({
      error: "codex_run timed out after 1800000ms",
    }),
    true,
  );
  assert.equal(isCodeAgentTimeoutResult({ error: "relay_timeout" }), true);
  assert.equal(isCodeAgentTimeoutResult({ error: "permission_denied" }), false);
});

test("continues a timed-out session only once", () => {
  const result = { timed_out: true };
  assert.equal(
    shouldContinueTimedOutCodeAgent({
      result,
      resultMeta: {},
      sessionId: "session-1",
    }),
    true,
  );
  assert.equal(
    shouldContinueTimedOutCodeAgent({
      result,
      resultMeta: { timeout_continuation_count: 1 },
      sessionId: "session-1",
    }),
    false,
  );
  assert.equal(
    shouldContinueTimedOutCodeAgent({
      result,
      resultMeta: {},
      sessionId: null,
    }),
    false,
  );
});

test("normalizes continuation counts and preserves partial progress", () => {
  assert.equal(timeoutContinuationCount({ timeout_continuation_count: 2.9 }), 2);
  assert.match(
    appendTimeoutContinuationNotice("Mapped the workflow.", 1),
    /Mapped the workflow\.[\s\S]*Automatically continuing/,
  );
});
