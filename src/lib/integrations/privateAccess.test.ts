import assert from "node:assert/strict";
import test from "node:test";
import { canUseWorkspaceIntegration } from "./privateAccess";

test("a Gmail owner can use their own connection", () => {
  assert.equal(
    canUseWorkspaceIntegration({
      provider: "gmail",
      actorUserId: "owner",
      ownerUserId: "owner",
    }),
    true,
  );
});

test("workspace membership alone does not expose the owner's Gmail", () => {
  assert.equal(
    canUseWorkspaceIntegration({
      provider: "gmail",
      actorUserId: "member",
      ownerUserId: "owner",
    }),
    false,
  );
});

test("the Gmail-specific rule does not change other integration sharing", () => {
  assert.equal(
    canUseWorkspaceIntegration({
      provider: "google_calendar",
      actorUserId: "member",
      ownerUserId: "owner",
    }),
    true,
  );
});
