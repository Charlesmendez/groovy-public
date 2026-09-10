import assert from "node:assert/strict";
import test from "node:test";

import { createExecutableTools } from "./executableTools";
import { executeTool, type ToolExecutionContext } from "./toolExecutor";

function context(canCreateSkills: boolean): ToolExecutionContext {
  return {
    userId: "workspace-owner",
    deviceId: "connector-device",
    channelSkillManagement: {
      workspaceId: "workspace-1",
      channelId: "channel-1",
      actorUserId: "speaker-1",
      canCreateSkills,
    },
  };
}

test("channel skill authoring is exposed only for an admin-authorized speaker", () => {
  const adminTools = createExecutableTools(context(true));
  const creatorTools = createExecutableTools(context(false));

  assert.ok(adminTools.create_channel_skill);
  assert.ok(adminTools.update_channel_skill_actions);
  assert.ok(adminTools.assign_channel_skill);
  assert.equal(creatorTools.create_channel_skill, undefined);
  assert.equal(creatorTools.update_channel_skill_actions, undefined);
  assert.ok(creatorTools.assign_channel_skill);
});

test("workspace assignment tools are exposed only for an admin-authorized speaker", () => {
  const adminContext = context(true);
  adminContext.workspaceAssignmentManagement = {
    workspaceId: "workspace-1",
    actorUserId: "speaker-1",
  };
  const adminTools = createExecutableTools(adminContext);
  const creatorTools = createExecutableTools(context(false));

  assert.ok(adminTools.assign_skill_or_doc);
  assert.ok(adminTools.list_workspace_secret_assignments);
  assert.ok(adminTools.set_workspace_secret_assignment);
  assert.equal(creatorTools.assign_skill_or_doc, undefined);
  assert.equal(creatorTools.list_workspace_secret_assignments, undefined);
  assert.equal(creatorTools.set_workspace_secret_assignment, undefined);
});

test("channel metadata without a tool policy does not acquire workspace mutation authority", async () => {
  for (const name of ["assign_skill_or_doc", "remove_skill_or_doc_assignment"]) {
    const result = await executeTool(name, {}, context(false));
    assert.equal(result.success, false);
    assert.match(result.error || "", /verified admin/);
  }
});
