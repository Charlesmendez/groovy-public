import assert from "node:assert/strict";
import test from "node:test";
import {
  matchingPendingApprovalTasks,
  parseTeamChatAgentTaskDecision,
} from "./agentTaskApprovals";

test("parses explicit conversational approval and rejection replies", () => {
  assert.deepEqual(parseTeamChatAgentTaskDecision("approve"), {
    action: "approve",
    taskIdPrefix: null,
  });
  assert.deepEqual(parseTeamChatAgentTaskDecision("Approved."), {
    action: "approve",
    taskIdPrefix: null,
  });
  assert.deepEqual(parseTeamChatAgentTaskDecision("@groovy I reject"), {
    action: "reject",
    taskIdPrefix: null,
  });
  assert.deepEqual(parseTeamChatAgentTaskDecision("rejected task abc123"), {
    action: "reject",
    taskIdPrefix: "abc123",
  });
});

test("does not treat ordinary approval discussion as a decision", () => {
  assert.equal(
    parseTeamChatAgentTaskDecision("I think we should approve this later"),
    null,
  );
  assert.equal(parseTeamChatAgentTaskDecision("approval looks good"), null);
  assert.equal(parseTeamChatAgentTaskDecision("yes"), null);
});

test("matches an optional task id prefix within pending channel tasks", () => {
  const tasks = [
    { id: "abc12345-0000-4000-8000-000000000000" },
    { id: "def67890-0000-4000-8000-000000000000" },
  ];
  assert.deepEqual(matchingPendingApprovalTasks(tasks, null), tasks);
  assert.deepEqual(matchingPendingApprovalTasks(tasks, "abc123"), [tasks[0]]);
  assert.deepEqual(matchingPendingApprovalTasks(tasks, "missing"), []);
});
