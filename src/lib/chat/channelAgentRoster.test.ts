import { strict as assert } from "node:assert";
import test from "node:test";
import {
  channelAgentIds,
  directAgentMessageTargetId,
  isAgentDirectMessageForRecipient,
  selectedChannelAgents,
} from "./channelAgentRoster";

test("channel agent ids are normalized, unique, and agent-only", () => {
  assert.deepEqual(
    channelAgentIds([
      { member_type: "user", agent_id: "outside" },
      { member_type: "agent", agent_id: " alpha " },
      { member_type: "agent", agent_id: "alpha" },
      { member_type: "agent", agent_id: null },
      { member_type: "orchestrator", agent_id: "outside" },
    ]),
    ["alpha"],
  );
});

test("mention rosters contain every selected agent and no unselected agent", () => {
  const agents = [
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
    { id: "shadow", name: "Shadow" },
  ];
  const selected = selectedChannelAgents(agents, [
    { member_type: "agent", agent_id: "beta" },
    { member_type: "agent", agent_id: "alpha" },
  ]);

  // Workspace ordering stays stable while membership is authoritative.
  assert.deepEqual(
    selected.map((agent) => agent.id),
    ["alpha", "beta"],
  );
  assert.equal(selected.some((agent) => agent.id === "shadow"), false);
});

test("direct Agent DMs are resolved only from one authoritative Agent member", () => {
  const members = [
    { member_type: "user", user_id: "user-1", agent_id: null },
    { member_type: "orchestrator", agent_id: null },
    { member_type: "agent", agent_id: "agent-1" },
  ];

  assert.equal(
    directAgentMessageTargetId({ kind: "dm", members }),
    "agent-1",
  );
  assert.equal(
    isAgentDirectMessageForRecipient({
      kind: "dm",
      agentId: "agent-1",
      members,
    }),
    true,
  );
});

test("channel slugs and ambiguous Agent rosters cannot define a direct Agent DM", () => {
  assert.equal(
    directAgentMessageTargetId({
      kind: "channel",
      members: [{ member_type: "agent", agent_id: "agent-1" }],
    }),
    null,
  );
  assert.equal(
    directAgentMessageTargetId({
      kind: "dm",
      members: [
        { member_type: "agent", agent_id: "agent-1" },
        { member_type: "agent", agent_id: "agent-2" },
      ],
    }),
    null,
  );
  assert.equal(
    directAgentMessageTargetId({ kind: "dm", members: [] }),
    null,
  );
  assert.equal(
    directAgentMessageTargetId({
      kind: "dm",
      members: [
        { member_type: "user", user_id: "user-1" },
        { member_type: "user", user_id: "user-2" },
        { member_type: "agent", agent_id: "agent-1" },
      ],
    }),
    null,
  );
});
