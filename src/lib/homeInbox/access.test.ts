import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireDecisionProfile, requireProfileAdmin } from "./access";
import { ids, profile } from "./fixtures.test-support";

function adminClient(
  row: Record<string, unknown> | null,
  role: string | null = null,
  failed = false,
) {
  const checks: string[] = [];
  const admin = {
    from(table: string) {
      checks.push(table);
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data:
            table === "orchestrator_profiles" ? row : role ? { role } : null,
          error: failed ? { message: "db unavailable" } : null,
        }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { admin, checks };
}
const row = {
  id: profile.id,
  user_id: ids.tenantId,
  workspace_id: null,
  name: "Scoped Mind",
  tool_policy: { mode: "allowlist", tools: [] },
};
test("personal Mind owner is allowed; matching email or another user is not", async () => {
  const { admin } = adminClient(row);
  assert.equal(
    (await requireProfileAdmin(admin, profile.id, ids.tenantId)).workspaceId,
    null,
  );
  await assert.rejects(() =>
    requireProfileAdmin(admin, profile.id, ids.projectId),
  );
});
test("workspace role is rechecked and only admin can manage bindings", async () => {
  for (const role of ["member", "guest", "viewer", "operator", null]) {
    const { admin, checks } = adminClient(
      { ...row, workspace_id: ids.projectId },
      role,
    );
    await assert.rejects(() =>
      requireProfileAdmin(admin, profile.id, ids.tenantId),
    );
    assert.deepEqual(checks, ["orchestrator_profiles", "workspace_members"]);
  }
  const { admin } = adminClient(
    { ...row, workspace_id: ids.projectId },
    "admin",
  );
  assert.equal(
    (await requireProfileAdmin(admin, profile.id, ids.tenantId)).workspaceId,
    ids.projectId,
  );
});
test("missing profile or failed authorization lookup never falls back to default", async () => {
  for (const admin of [
    adminClient(null).admin,
    adminClient(row, null, true).admin,
  ])
    await assert.rejects(() =>
      requireProfileAdmin(admin, profile.id, ids.tenantId),
    );
});
test("unsafe and not-yet-supported Mind capabilities fail readiness visibly", () => {
  assert.doesNotThrow(() => requireDecisionProfile(profile));
  for (const change of [
    { surface: "internal" as const },
    { authorizationStance: "operator" as const },
    { memoryScope: "shared" as const },
    { inheritWorkspaceIntegrations: true },
    { inheritWorkspaceSkills: true },
    { toolPolicy: { mode: "all" as const } },
    {
      toolPolicy: {
        mode: "allowlist" as const,
        tools: ["data_query"],
        dataSources: ["salesforce"],
      },
    },
    { toolPolicy: { mode: "allowlist" as const, tools: ["run_skill_action"] } },
  ])
    assert.throws(() => requireDecisionProfile({ ...profile, ...change }));
});

test("Home discovery and reads are an explicit pair, not permission to use general data_query", () => {
  assert.doesNotThrow(() =>
    requireDecisionProfile({
      ...profile,
      toolPolicy: {
        mode: "allowlist",
        tools: ["home_data_operations", "home_data_read"],
      },
    }),
  );
  for (const tools of [
    ["home_data_read"],
    ["home_data_operations"],
    ["home_data_read", "home_data_operations", "data_query"],
  ])
    assert.throws(() =>
      requireDecisionProfile({
        ...profile,
        toolPolicy: { mode: "allowlist", tools },
      }),
    );
});
