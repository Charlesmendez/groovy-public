import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveHarnessProfile,
  type OrchestratorProfileRow,
} from "./harnessProfiles";

function profile(
  id: string,
  ownership: { workspaceId?: string; userId?: string },
): OrchestratorProfileRow {
  return {
    id,
    workspace_id: ownership.workspaceId || null,
    user_id: ownership.userId || null,
    name: id,
    slug: id,
    description: null,
    persona_prompt: null,
    purpose: null,
    tone: null,
    custom_instructions: null,
    authorization_stance: "operator",
    model: null,
    tool_policy: { mode: "all" },
    agent_roster: null,
    memory_scope: "shared",
    surface: "internal",
    widget_config: null,
    is_default: false,
    cloned_from: null,
  };
}

function fakeSupabase(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] || [])];
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        is(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        in(column: string, values: unknown[]) {
          rows = rows.filter((row) => values.includes(row[column]));
          return query;
        },
        order() {
          return query;
        },
        limit(count: number) {
          rows = rows.slice(0, count);
          return query;
        },
        async maybeSingle() {
          return { data: rows[0] || null, error: null };
        },
      };
      return query;
    },
  };
}

test("explicit profile wins over sticky and default candidates", async () => {
  const explicit = profile("explicit", { userId: "user-1" });
  const sticky = profile("sticky", { userId: "user-1" });
  const resolved = await resolveHarnessProfile(
    fakeSupabase({
      orchestrator_profiles: [explicit, sticky],
      workspace_members: [],
    }),
    {
      userId: "user-1",
      explicitProfileId: "explicit",
      sessionProfileId: "sticky",
    },
  );
  assert.equal(resolved?.id, "explicit");
});

test("workspace profile access is revoked when its creator leaves the workspace", async () => {
  const workspaceProfile = profile("workspace-mind", {
    workspaceId: "workspace-1",
  });
  const resolved = await resolveHarnessProfile(
    fakeSupabase({
      orchestrator_profiles: [workspaceProfile],
      workspace_members: [],
    }),
    {
      userId: "former-creator",
      explicitProfileId: workspaceProfile.id,
    },
  );
  assert.equal(resolved, null);
});

test("current workspace operators can resolve a workspace profile", async () => {
  const workspaceProfile = profile("workspace-mind", {
    workspaceId: "workspace-1",
  });
  const resolved = await resolveHarnessProfile(
    fakeSupabase({
      orchestrator_profiles: [workspaceProfile],
      workspace_members: [
        {
          workspace_id: "workspace-1",
          user_id: "member-1",
          role: "member",
        },
      ],
    }),
    {
      userId: "member-1",
      explicitProfileId: workspaceProfile.id,
    },
  );
  assert.equal(resolved?.id, workspaceProfile.id);
});
