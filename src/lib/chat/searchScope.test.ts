import assert from "node:assert/strict";
import test from "node:test";
import { chatSearchRoomScopeLabel } from "./searchScope";

test("formats channel and DM search scopes like Slack", () => {
  assert.equal(
    chatSearchRoomScopeLabel({ kind: "channel", name: "groovy" }),
    "in:#groovy",
  );
  assert.equal(
    chatSearchRoomScopeLabel({ kind: "dm", name: "Carlos Mendez" }),
    "in:@Carlos Mendez",
  );
});
