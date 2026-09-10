import assert from "node:assert/strict";
import test from "node:test";
import {
  TEAM_CHAT_CONTROLLABLE_ORCHESTRATOR_RUN_STATUSES,
  TEAM_CHAT_VISIBLE_ORCHESTRATOR_RUN_STATUSES,
} from "./orchestratorRunState";

test("finalizing orchestrator runs remain visible but cannot be controlled", () => {
  assert.equal(
    TEAM_CHAT_VISIBLE_ORCHESTRATOR_RUN_STATUSES.includes("finalizing"),
    true,
  );
  assert.equal(
    (
      TEAM_CHAT_CONTROLLABLE_ORCHESTRATOR_RUN_STATUSES as readonly string[]
    ).includes("finalizing"),
    false,
  );
});
