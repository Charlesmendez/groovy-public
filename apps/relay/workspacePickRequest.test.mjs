import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverOrDeferWorkspacePickResult,
  detachWorkspacePickBrowser,
  rebindWorkspacePickBrowser,
} from "./workspacePickRequest.mjs";

function pendingWorkspacePick(browserWs = { id: "original" }) {
  return {
    type: "workspace_pick",
    browserWs,
    browserInstanceId: "browser-1",
    userId: "user-1",
    deviceId: "device-1",
    completedPayload: null,
    disconnectedAt: null,
  };
}

test("rebinds an in-flight folder pick before delivering its result", () => {
  const originalBrowser = { id: "original" };
  const reconnectedBrowser = { id: "reconnected" };
  const pending = pendingWorkspacePick(originalBrowser);
  const sent = [];

  assert.equal(detachWorkspacePickBrowser(pending, originalBrowser, 123), true);
  assert.equal(pending.browserWs, null);
  assert.equal(pending.disconnectedAt, 123);

  assert.deepEqual(
    rebindWorkspacePickBrowser(pending, {
      browserWs: reconnectedBrowser,
      browserInstanceId: "browser-1",
      userId: "user-1",
      send: (ws, payload) => {
        sent.push({ ws, payload });
        return true;
      },
    }),
    { matched: true, delivered: false },
  );

  const payload = { type: "workspace_added", request_id: "request-1", ok: true };
  assert.equal(
    deliverOrDeferWorkspacePickResult(pending, payload, (ws, nextPayload) => {
      sent.push({ ws, payload: nextPayload });
      return true;
    }),
    true,
  );
  assert.deepEqual(sent, [{ ws: reconnectedBrowser, payload }]);
});

test("replays a folder result that arrives between disconnect and reconnect", () => {
  const originalBrowser = { id: "original" };
  const reconnectedBrowser = { id: "reconnected" };
  const pending = pendingWorkspacePick(originalBrowser);
  const payload = { type: "workspace_added", request_id: "request-1", ok: true };
  const sent = [];

  detachWorkspacePickBrowser(pending, originalBrowser);
  assert.equal(deliverOrDeferWorkspacePickResult(pending, payload, () => false), false);
  assert.equal(pending.completedPayload, payload);

  assert.deepEqual(
    rebindWorkspacePickBrowser(pending, {
      browserWs: reconnectedBrowser,
      browserInstanceId: "browser-1",
      userId: "user-1",
      send: (ws, nextPayload) => {
        sent.push({ ws, payload: nextPayload });
        return true;
      },
    }),
    { matched: true, delivered: true },
  );
  assert.deepEqual(sent, [{ ws: reconnectedBrowser, payload }]);
  assert.equal(pending.completedPayload, null);
});

test("does not hand a deferred folder result to another browser instance", () => {
  const pending = pendingWorkspacePick(null);
  pending.completedPayload = { type: "workspace_added", request_id: "request-1", ok: true };

  assert.deepEqual(
    rebindWorkspacePickBrowser(pending, {
      browserWs: { id: "other" },
      browserInstanceId: "browser-2",
      userId: "user-1",
      send: () => {
        throw new Error("result must not be sent");
      },
    }),
    { matched: false, delivered: false },
  );
  assert.ok(pending.completedPayload);
});
