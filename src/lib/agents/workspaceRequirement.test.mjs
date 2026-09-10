import assert from "node:assert/strict";
import test from "node:test";
import { isWorkspaceRequiredForAgentCreation } from "./workspaceRequirement.mjs";

test("allows ordinary mobile agents to start without a workspace", () => {
  assert.equal(
    isWorkspaceRequiredForAgentCreation({ mobileUi: true, requiredWorkspaceRoot: null }),
    false,
  );
});

test("keeps workspace selection required for desktop agents", () => {
  assert.equal(
    isWorkspaceRequiredForAgentCreation({ mobileUi: false, requiredWorkspaceRoot: null }),
    true,
  );
});

test("keeps plan executors tied to their project on every device", () => {
  for (const mobileUi of [false, true]) {
    assert.equal(
      isWorkspaceRequiredForAgentCreation({
        mobileUi,
        requiredWorkspaceRoot: "/projects/groovy",
      }),
      true,
    );
  }
});
