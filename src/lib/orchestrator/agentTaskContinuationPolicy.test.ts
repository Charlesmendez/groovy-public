import assert from "node:assert/strict";
import test from "node:test";
import {
  agentTaskContinuationLimitReached,
  hasOpenAgentTaskDelegation,
  nextAgentTaskContinuationDepth,
  resolveAgentTaskContinuationTarget,
  sameAgentTaskDelegationGroup,
  shouldDeferAgentTaskFinal,
} from "./agentTaskContinuationPolicy";

const completedOrchestratorTask = {
  source: "orchestrator",
  status: "done",
  orchestrator_session_id: "session-1",
  requested_channel: "dashboard",
  result_meta: {},
};

test("dashboard orchestrator tasks resume after asynchronous completion", () => {
  assert.deepEqual(
    resolveAgentTaskContinuationTarget(completedOrchestratorTask),
    { kind: "dashboard" },
  );
  assert.deepEqual(
    resolveAgentTaskContinuationTarget({
      ...completedOrchestratorTask,
      status: "failed",
    }),
    { kind: "dashboard" },
  );
  assert.deepEqual(
    resolveAgentTaskContinuationTarget({
      ...completedOrchestratorTask,
      status: "canceled",
    }),
    { kind: "dashboard" },
  );
});

test("delegation groups use the exact model trace instead of the whole session", () => {
  const first = { id: "task-1", trace_id: "trace-1", turn_id: "turn-1" };
  assert.equal(
    sameAgentTaskDelegationGroup(first, {
      id: "task-2",
      trace_id: "trace-1",
      turn_id: "turn-1",
    }),
    true,
  );
  assert.equal(
    sameAgentTaskDelegationGroup(first, {
      id: "task-3",
      trace_id: "trace-2",
      turn_id: "turn-1",
    }),
    false,
  );
});

test("legacy delegation groups fall back to turn id and never session scope", () => {
  assert.equal(
    sameAgentTaskDelegationGroup(
      { id: "task-1", trace_id: null, turn_id: "turn-1" },
      { id: "task-2", trace_id: null, turn_id: "turn-1" },
    ),
    true,
  );
  assert.equal(
    sameAgentTaskDelegationGroup(
      { id: "task-1", trace_id: null, turn_id: null },
      { id: "task-2", trace_id: null, turn_id: null },
    ),
    false,
  );
});

test("open worker groups block synthesis until every task is terminal", () => {
  assert.equal(
    hasOpenAgentTaskDelegation([{ status: "done" }, { status: "running" }]),
    true,
  );
  assert.equal(
    hasOpenAgentTaskDelegation([
      { status: "done" },
      { status: "failed" },
      { status: "canceled" },
    ]),
    false,
  );
});

test("started workers defer the initial final while approval-only rounds can explain the gate", () => {
  assert.equal(
    shouldDeferAgentTaskFinal([{ status: "awaiting_approval" }]),
    false,
  );
  assert.equal(
    shouldDeferAgentTaskFinal([
      { status: "awaiting_approval" },
      { status: "queued" },
    ]),
    true,
  );
  assert.equal(shouldDeferAgentTaskFinal([{ status: "failed" }]), true);
});

test("Team Chat orchestrator tasks resume inside their originating channel", () => {
  assert.deepEqual(
    resolveAgentTaskContinuationTarget({
      ...completedOrchestratorTask,
      requested_channel: "team_chat:channel-1",
    }),
    { kind: "team_chat", channelId: "channel-1" },
  );
});

test("direct worker DMs never invoke an orchestrator continuation", () => {
  assert.equal(
    resolveAgentTaskContinuationTarget({
      ...completedOrchestratorTask,
      source: "api",
      requested_channel: "team_chat:agent-dm",
    }),
    null,
  );
});

test("inline worker results stay in their existing orchestrator turn", () => {
  assert.equal(
    resolveAgentTaskContinuationTarget({
      ...completedOrchestratorTask,
      result_meta: { orchestrator_wait_inline: true },
    }),
    null,
  );
  assert.equal(
    resolveAgentTaskContinuationTarget({
      ...completedOrchestratorTask,
      result_meta: { consultation_mode: true },
    }),
    null,
  );
});

test("unsupported external delivery adapters keep their existing behavior", () => {
  assert.equal(
    resolveAgentTaskContinuationTarget({
      ...completedOrchestratorTask,
      requested_channel: "whatsapp_web",
    }),
    null,
  );
});

test("parallel first-wave results advance one shared continuation generation", () => {
  assert.equal(
    nextAgentTaskContinuationDepth([
      { result_meta: { orchestrator_continuation_depth: 0 } },
      { result_meta: { orchestrator_continuation_depth: 0 } },
    ]),
    1,
  );
  assert.equal(
    nextAgentTaskContinuationDepth([
      { result_meta: { orchestrator_continuation_depth: 2 } },
      { result_meta: { orchestrator_continuation_depth: 3 } },
    ]),
    4,
  );
});

test("asynchronous handoffs stop at the configured continuation limit", () => {
  assert.equal(
    agentTaskContinuationLimitReached({ depth: 7, maxTurns: 8 }),
    false,
  );
  assert.equal(
    agentTaskContinuationLimitReached({ depth: 8, maxTurns: 8 }),
    true,
  );
});
