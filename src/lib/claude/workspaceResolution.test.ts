import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentWorkspaceRoot } from "./workspaceResolution";

test("legacy agents without a workspace may use the connector default", () => {
  assert.deepEqual(
    resolveAgentWorkspaceRoot({
      workspaceId: null,
      rootPath: null,
    }),
    { ok: true, rootPath: "" },
  );
});

test("configured agents fail closed when their workspace lookup is missing", () => {
  const missing = resolveAgentWorkspaceRoot({
    workspaceId: "workspace-1",
    rootPath: "",
  });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.code, "workspace_unavailable");

  const failed = resolveAgentWorkspaceRoot({
    workspaceId: "workspace-1",
    rootPath: "/stale/path",
    lookupFailed: true,
  });
  assert.equal(failed.ok, false);
});

test("configured agents retain the exact trimmed workspace root", () => {
  assert.deepEqual(
    resolveAgentWorkspaceRoot({
      workspaceId: "workspace-1",
      rootPath: " /Users/example/repo ",
      agentDeviceId: "device-1",
      workspaceDeviceId: "device-1",
    }),
    { ok: true, rootPath: "/Users/example/repo" },
  );
});

test("a configured workspace must belong to the agent connector device", () => {
  const mismatch = resolveAgentWorkspaceRoot({
    workspaceId: "workspace-1",
    rootPath: "/Users/example/repo",
    agentDeviceId: "device-1",
    workspaceDeviceId: "device-2",
  });
  assert.equal(mismatch.ok, false);
  if (mismatch.ok) return;
  assert.equal(mismatch.code, "workspace_unavailable");
});
