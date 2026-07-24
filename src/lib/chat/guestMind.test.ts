import assert from "node:assert/strict";
import test from "node:test";
import { isGuestSafeMind } from "./guestMind";

test("accepts guest-safe database profile fields", () => {
  assert.equal(
    isGuestSafeMind({
      surface: "external",
      authorization_stance: "restricted",
      memory_scope: "profile",
      inherit_workspace_skills: false,
      inherit_workspace_integrations: false,
    }),
    true,
  );
});

test("accepts resolved harness profile fields", () => {
  assert.equal(
    isGuestSafeMind({
      surface: "external",
      authorizationStance: "restricted",
      memoryScope: "profile",
      inheritWorkspaceSkills: false,
      inheritWorkspaceIntegrations: false,
    }),
    true,
  );
});

test("rejects default, internal, operator, and shared-memory profiles", () => {
  assert.equal(isGuestSafeMind(null), false);
  assert.equal(
    isGuestSafeMind({
      surface: "internal",
      authorization_stance: "restricted",
      memory_scope: "profile",
      inherit_workspace_skills: false,
      inherit_workspace_integrations: false,
    }),
    false,
  );
  assert.equal(
    isGuestSafeMind({
      surface: "external",
      authorization_stance: "operator",
      memory_scope: "profile",
      inherit_workspace_skills: false,
      inherit_workspace_integrations: false,
    }),
    false,
  );
  assert.equal(
    isGuestSafeMind({
      surface: "external",
      authorization_stance: "restricted",
      memory_scope: "shared",
      inherit_workspace_skills: false,
      inherit_workspace_integrations: false,
    }),
    false,
  );
  assert.equal(
    isGuestSafeMind({
      surface: "external",
      authorization_stance: "restricted",
      memory_scope: "profile",
      inherit_workspace_skills: true,
      inherit_workspace_integrations: false,
    }),
    false,
  );
  assert.equal(
    isGuestSafeMind({
      surface: "external",
      authorization_stance: "restricted",
      memory_scope: "profile",
      inherit_workspace_skills: false,
      inherit_workspace_integrations: true,
    }),
    false,
  );
});
