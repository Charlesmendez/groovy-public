import assert from "node:assert/strict";
import test from "node:test";
import { privateEmailCredentialUserId } from "./toolExecutor";

test("private Email credentials always belong to the authenticated runtime user", () => {
  assert.equal(
    privateEmailCredentialUserId({
      userId: "signed-in-member",
      integrationOwnerUserId: "workspace-capability-owner",
    }),
    "signed-in-member",
  );
});
