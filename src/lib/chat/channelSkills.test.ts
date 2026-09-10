import assert from "node:assert/strict";
import test from "node:test";
import { canManageChannelSkills } from "./channelSkills";

test("only admins and full-member channel creators manage channel skills", () => {
  assert.equal(
    canManageChannelSkills({
      actorUserId: "admin",
      channelCreatedBy: "creator",
      workspaceRole: "admin",
    }),
    true,
  );
  assert.equal(
    canManageChannelSkills({
      actorUserId: "creator",
      channelCreatedBy: "creator",
      workspaceRole: "member",
    }),
    true,
  );
  assert.equal(
    canManageChannelSkills({
      actorUserId: "member",
      channelCreatedBy: "creator",
      workspaceRole: "member",
    }),
    false,
  );
  assert.equal(
    canManageChannelSkills({
      actorUserId: "creator",
      channelCreatedBy: "creator",
      workspaceRole: "guest",
    }),
    false,
  );
});
