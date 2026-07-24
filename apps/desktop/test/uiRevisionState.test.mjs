import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { UiRevisionState } = require("../dist/main/uiRevisionState.js");

test("establishes the first observed revision as the loaded baseline", () => {
  const state = new UiRevisionState();

  assert.deepEqual(state.observe("revision-a"), { state: "idle" });
  assert.deepEqual(state.getStatus(), { state: "idle" });
});

test("keeps a detected revision pending until a reload completes", () => {
  const state = new UiRevisionState();
  state.observe("revision-a");

  assert.deepEqual(state.observe("revision-b"), {
    state: "ready",
    revision: "revision-b",
  });
  assert.deepEqual(state.observe("revision-b"), {
    state: "ready",
    revision: "revision-b",
  });

  assert.equal(state.beginReload(), "revision-b");
  assert.deepEqual(state.getStatus(), {
    state: "reloading",
    revision: "revision-b",
  });
  assert.equal(state.completeReload(), "revision-b");
  assert.deepEqual(state.getStatus(), { state: "idle" });
});

test("retains a pending revision when a reload fails", () => {
  const state = new UiRevisionState();
  state.observe("revision-a");
  state.observe("revision-b");
  state.beginReload();

  assert.deepEqual(state.failReload(), {
    state: "ready",
    revision: "revision-b",
  });
  assert.equal(state.beginReload(), "revision-b");
});

test("does not lose a newer deployment observed during a reload", () => {
  const state = new UiRevisionState();
  state.observe("revision-a");
  state.observe("revision-b");
  state.beginReload();

  state.observe("revision-c");
  assert.equal(state.completeReload(), "revision-b");
  assert.deepEqual(state.getStatus(), {
    state: "ready",
    revision: "revision-c",
  });
});

test("clears a pending update when production rolls back to the loaded revision", () => {
  const state = new UiRevisionState();
  state.observe("revision-a");
  state.observe("revision-b");

  assert.deepEqual(state.observe("revision-a"), { state: "idle" });
});
