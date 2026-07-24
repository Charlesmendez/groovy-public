import { strict as assert } from "node:assert";
import test from "node:test";
import {
  channelAgentIds,
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
