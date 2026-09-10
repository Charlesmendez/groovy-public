import assert from "node:assert/strict";
import test from "node:test";
import { mindContinuationPending } from "./mindContinuation";

test("a terminal delegated task keeps the Mind continuation visibly pending", () => {
  assert.equal(
    mindContinuationPending([
      {
        metadata: {
          kind: "agent_task_result",
          task_id: "task-1",
          orchestrator_followup_pending: true,
        },
      },
    ]),
    true,
  );
});

test("a Mind continuation response clears the worker handoffs it consumed", () => {
  assert.equal(
    mindContinuationPending([
      {
        metadata: {
          kind: "agent_task_result",
          task_id: "task-1",
          orchestrator_followup_pending: true,
        },
      },
      {
        metadata: {
          kind: "agent_task_result",
          task_id: "task-2",
          orchestrator_followup_pending: true,
        },
      },
      {
        metadata: {
          kind: "agent_task_orchestrator_result",
          task_id: "task-1",
          task_ids: ["task-1", "task-2"],
        },
      },
    ]),
    false,
  );
});

test("one Agent continuation cannot hide another pending Agent handoff", () => {
  assert.equal(
    mindContinuationPending([
      {
        metadata: {
          kind: "agent_task_result",
          task_id: "task-1",
          orchestrator_followup_pending: true,
        },
      },
      {
        metadata: {
          kind: "agent_task_result",
          task_id: "task-2",
          orchestrator_followup_pending: true,
        },
      },
      {
        metadata: {
          kind: "agent_task_orchestrator_result",
          task_id: "task-1",
        },
      },
    ]),
    true,
  );
});

test("ordinary worker results do not invent a Mind continuation", () => {
  assert.equal(
    mindContinuationPending([
      { metadata: { kind: "agent_task_result" } },
    ]),
    false,
  );
});

test("a server-cleared handoff cannot leave the Mind loader stuck", () => {
  assert.equal(
    mindContinuationPending([
      {
        metadata: {
          kind: "agent_task_result",
          task_id: "task-1",
          orchestrator_followup_pending: false,
        },
      },
    ]),
    false,
  );
});
