import assert from "node:assert/strict";
import test from "node:test";
import {
  getWhatsAppRecycleCheckIntervalMs,
  getWhatsAppRecycleDecision,
  getWhatsAppRecycleRetryCooldownMs,
  shouldCheckWhatsAppRecycle,
} from "./platform/whatsapp/recycle.mjs";

const HOUR = 60 * 60_000;

function decision(overrides = {}) {
  return getWhatsAppRecycleDecision({
    nowMs: 10 * HOUR,
    lastRecycleAtMs: 4 * HOUR,
    lastBridgeActivityAtMs: 9 * HOUR,
    recycleIntervalMs: 6 * HOUR,
    recycleIdleMs: 5 * 60_000,
    recycleMaxAgeMs: 8 * HOUR,
    memoryRssBytes: 0,
    memoryLimitBytes: 5 * 1024 ** 3,
    activeBridgeOperations: 0,
    ready: true,
    qrPending: false,
    authFailure: false,
    disconnected: false,
    ...overrides,
  });
}

test("recycles after the configured interval when meaningfully idle", () => {
  assert.deepEqual(decision(), {
    due: true,
    reason: "idle_interval",
    ageMs: 6 * HOUR,
    idleMs: HOUR,
    forced: false,
  });
});

test("does not recycle an active operation", () => {
  assert.equal(decision({ activeBridgeOperations: 1 }).reason, "active_operation");
});

test("waits for meaningful idle time before a normal recycle", () => {
  const result = decision({ lastBridgeActivityAtMs: 10 * HOUR - 60_000 });
  assert.equal(result.due, false);
  assert.equal(result.reason, "not_idle");
});

test("forces a bounded recycle at maximum age between operations", () => {
  const result = decision({
    lastRecycleAtMs: 2 * HOUR,
    lastBridgeActivityAtMs: 10 * HOUR - 1_000,
  });
  assert.equal(result.due, true);
  assert.equal(result.reason, "max_age");
  assert.equal(result.forced, true);
});

test("forces a recycle when the browser process tree reaches its memory limit", () => {
  const result = decision({
    lastRecycleAtMs: 9.9 * HOUR,
    lastBridgeActivityAtMs: 10 * HOUR - 1_000,
    memoryRssBytes: 5.2 * 1024 ** 3,
  });
  assert.equal(result.due, true);
  assert.equal(result.reason, "memory_limit");
  assert.equal(result.forced, true);
});

test("memory pressure never interrupts an active bridge operation", () => {
  const result = decision({
    activeBridgeOperations: 1,
    memoryRssBytes: 8 * 1024 ** 3,
  });
  assert.equal(result.due, false);
  assert.equal(result.reason, "active_operation");
});

test("checks lifecycle policy frequently without changing the recycle cadence", () => {
  assert.equal(getWhatsAppRecycleCheckIntervalMs(6 * HOUR), 60_000);
  assert.equal(getWhatsAppRecycleCheckIntervalMs(45_000), 45_000);
  assert.equal(getWhatsAppRecycleCheckIntervalMs(0), 0);
});

test("memory pressure retries sooner than time-based recycle failures", () => {
  assert.equal(getWhatsAppRecycleRetryCooldownMs("memory_limit", 6 * HOUR), 2 * 60_000);
  assert.equal(getWhatsAppRecycleRetryCooldownMs("recovery_retry", 6 * HOUR), 5 * 60_000);
  assert.equal(getWhatsAppRecycleRetryCooldownMs("idle_interval", 6 * HOUR), 15 * 60_000);
});

test("retries a failed recycle when the bridge never becomes ready", () => {
  const result = decision({ ready: false, recoveryPending: true });
  assert.equal(result.due, true);
  assert.equal(result.reason, "recovery_retry");
  assert.equal(result.forced, true);
});

test("does not recycle a bridge that is merely still starting", () => {
  const result = decision({ ready: false, recoveryPending: false });
  assert.equal(result.due, false);
  assert.equal(result.reason, "bridge_not_ready");
});

test("does not recovery-recycle when user intervention is required", () => {
  for (const blockedState of [
    { qrPending: true },
    { authFailure: true },
    { disconnected: true },
  ]) {
    const result = decision({
      ready: false,
      recoveryPending: true,
      ...blockedState,
    });
    assert.equal(result.due, false);
    assert.equal(result.reason, "bridge_not_ready");
  }
});

test("rechecks immediately after a background operation releases the bridge", () => {
  const input = {
    nowMs: 60_000,
    lastCheckAtMs: 0,
    checkIntervalMs: 60_000,
  };
  assert.equal(
    shouldCheckWhatsAppRecycle({ ...input, activeBridgeOperations: 1 }),
    false
  );
  assert.equal(
    shouldCheckWhatsAppRecycle({ ...input, activeBridgeOperations: 0 }),
    true
  );
  assert.equal(
    shouldCheckWhatsAppRecycle({
      nowMs: 119_999,
      lastCheckAtMs: 60_000,
      checkIntervalMs: 60_000,
      activeBridgeOperations: 0,
    }),
    false
  );
});
