import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileParallelConnectorResults,
  type PendingParallelConnectorCall,
} from "./parallelBranchResults";

function pending(
  branchId: string,
  toolCallId: string,
  toolName: string,
): PendingParallelConnectorCall {
  return {
    branchId,
    toolCallId,
    toolName,
  };
}

test("partial connector results leave unmatched calls pending", () => {
  const result = reconcileParallelConnectorResults({
    pending: [
      pending("branch-a", "call-1", "terminal_exec"),
      pending("branch-a", "call-2", "terminal_exec"),
      pending("branch-b", "call-3", "terminal_exec"),
    ],
    incoming: [
      {
        branchId: "branch-a",
        toolCallId: "call-1",
        toolName: "terminal_exec",
        result: "first",
      },
    ],
  });

  assert.deepEqual(result.acceptedByBranch.get("branch-a"), [
    { toolCallId: "call-1", toolName: "terminal_exec", result: "first" },
  ]);
  assert.deepEqual(
    result.remaining.map((row) => `${row.branchId}:${row.toolCallId}`),
    ["branch-a:call-2", "branch-b:call-3"],
  );
});

test("unknown, mismatched, and duplicate connector results are ignored", () => {
  const result = reconcileParallelConnectorResults({
    pending: [pending("branch-a", "call-1", "terminal_exec")],
    incoming: [
      {
        branchId: "branch-a",
        toolCallId: "unknown",
        toolName: "terminal_exec",
        result: "unknown",
      },
      {
        branchId: "branch-a",
        toolCallId: "call-1",
        toolName: "browser_task",
        result: "wrong tool",
      },
      {
        branchId: "branch-a",
        toolCallId: "call-1",
        toolName: "terminal_exec",
        result: "accepted",
      },
      {
        branchId: "branch-a",
        toolCallId: "call-1",
        toolName: "terminal_exec",
        result: "duplicate",
      },
    ],
  });

  assert.deepEqual(result.acceptedByBranch.get("branch-a"), [
    {
      toolCallId: "call-1",
      toolName: "terminal_exec",
      result: "accepted",
    },
  ]);
  assert.deepEqual(result.remaining, []);
});
