import { strict as assert } from "node:assert";
import test from "node:test";
import { normalizeWorkspaceInviteEmail } from "./workspaceInvites";

test("workspace invite emails are normalized", () => {
  assert.equal(
    normalizeWorkspaceInviteEmail("  Person@Company.COM "),
    "person@company.com",
  );
});

test("workspace invite emails reject malformed and oversized values", () => {
  assert.equal(normalizeWorkspaceInviteEmail(null), null);
  assert.equal(normalizeWorkspaceInviteEmail("person"), null);
  assert.equal(normalizeWorkspaceInviteEmail("person@company"), null);
  assert.equal(normalizeWorkspaceInviteEmail("person @company.com"), null);
  assert.equal(
    normalizeWorkspaceInviteEmail(`${"a".repeat(245)}@company.com`),
    null,
  );
});
