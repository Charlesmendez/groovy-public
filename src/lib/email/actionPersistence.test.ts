import assert from "node:assert/strict";
import test from "node:test";
import {
  closeCoveredPendingInboxActions,
  EmailWorkspacePersistenceError,
  persistEmailWorkspaceActionMutation,
  requirePersistedEmailWorkspaceActionId,
} from "./actionPersistence";

test("a stored workspace action returns its id", () => {
  assert.equal(
    requirePersistedEmailWorkspaceActionId({
      data: { id: "action-1" },
      error: null,
    }),
    "action-1",
  );
});

test("a failed workspace history write is not treated as success", () => {
  assert.throws(
    () =>
      requirePersistedEmailWorkspaceActionId({
        data: null,
        error: { message: "database unavailable" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof EmailWorkspacePersistenceError);
      assert.equal(error.details, "database unavailable");
      return true;
    },
  );
});

test("a workspace history write without an id is retried", () => {
  assert.throws(
    () =>
      requirePersistedEmailWorkspaceActionId({
        data: null,
        error: null,
      }),
    EmailWorkspacePersistenceError,
  );
});

test("workspace mutations use the scoped atomic metadata RPC", async () => {
  let rpcName = "";
  let rpcArgs: Record<string, unknown> = {};
  const supabase = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcName = name;
      rpcArgs = args;
      return {
        maybeSingle: async () => ({
          data: {
            action_id: "action-1",
            action_updated_at: "2026-08-24T20:00:00.000Z",
            closed_sibling_count: 2,
          },
          error: null,
        }),
      };
    },
  } as unknown as Parameters<
    typeof persistEmailWorkspaceActionMutation
  >[0]["supabase"];

  const result = await persistEmailWorkspaceActionMutation({
    supabase,
    userId: "user-1",
    actionId: "action-1",
    changedAt: "2026-08-24T20:00:00.000Z",
    metadataPatch: {
      email_workspace_override_view: "handled",
    },
    expectedStatus: "executing",
    status: "done",
    executedAt: "2026-08-24T20:00:00.000Z",
    closeActiveSiblings: true,
    correctionCutoff: "2026-08-24T20:00:00.000Z",
  });

  assert.equal(rpcName, "apply_email_workspace_action_mutation");
  assert.deepEqual(rpcArgs, {
    p_action_id: "action-1",
    p_user_id: "user-1",
    p_metadata_patch: {
      email_workspace_override_view: "handled",
    },
    p_changed_at: "2026-08-24T20:00:00.000Z",
    p_expected_status: "executing",
    p_status: "done",
    p_executed_at: "2026-08-24T20:00:00.000Z",
    p_close_active_siblings: true,
    p_correction_cutoff: "2026-08-24T20:00:00.000Z",
  });
  assert.deepEqual(result, {
    actionId: "action-1",
    updatedAt: "2026-08-24T20:00:00.000Z",
    closedSiblingCount: 2,
  });
});

test("covered pending actions are closed with one scoped batch RPC", async () => {
  let rpcName = "";
  let rpcArgs: Record<string, unknown> = {};
  const supabase = {
    async rpc(name: string, args: Record<string, unknown>) {
      rpcName = name;
      rpcArgs = args;
      return {
        data: [
          {
            action_id: "action-1",
            action_updated_at: "2026-08-24T21:00:00.000Z",
          },
        ],
        error: null,
      };
    },
  } as unknown as Parameters<
    typeof closeCoveredPendingInboxActions
  >[0]["supabase"];

  const result = await closeCoveredPendingInboxActions({
    supabase,
    userId: "user-1",
    actionIds: ["action-1", "action-1", ""],
    changedAt: "2026-08-24T21:00:00.000Z",
  });

  assert.equal(rpcName, "close_covered_pending_inbox_actions");
  assert.deepEqual(rpcArgs, {
    p_action_ids: ["action-1"],
    p_user_id: "user-1",
    p_changed_at: "2026-08-24T21:00:00.000Z",
  });
  assert.deepEqual(result, [
    {
      actionId: "action-1",
      updatedAt: "2026-08-24T21:00:00.000Z",
    },
  ]);
});
