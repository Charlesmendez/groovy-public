import assert from "node:assert/strict";
import test from "node:test";

import {
  getScheduleSyncFingerprint,
  shouldDeferScheduledWhatsAppJob,
  shouldPostScheduledWhatsAppStatus,
} from "./schedulerDelivery.mjs";

function statusContext(overrides = {}) {
  return {
    statusPostingEnabled: true,
    kind: "orchestrator",
    hasWhatsAppSender: true,
    isHeartbeat: false,
    didSendWhatsApp: false,
    explicitlyRequiresWhatsAppDelivery: false,
    ...overrides,
  };
}

test("ordinary channel schedules never post scheduler telemetry to WhatsApp", () => {
  assert.equal(shouldPostScheduledWhatsAppStatus(statusContext()), false);
  assert.equal(
    shouldPostScheduledWhatsAppStatus(
      statusContext({ status: "error" }),
    ),
    false,
  );
});

test("an explicitly WhatsApp-bound schedule can report a missing delivery", () => {
  assert.equal(
    shouldPostScheduledWhatsAppStatus(
      statusContext({ explicitlyRequiresWhatsAppDelivery: true }),
    ),
    true,
  );
});

test("successful WhatsApp delivery and heartbeat paths do not add a second status", () => {
  assert.equal(
    shouldPostScheduledWhatsAppStatus(
      statusContext({
        explicitlyRequiresWhatsAppDelivery: true,
        didSendWhatsApp: true,
      }),
    ),
    false,
  );
  assert.equal(
    shouldPostScheduledWhatsAppStatus(
      statusContext({
        explicitlyRequiresWhatsAppDelivery: true,
        isHeartbeat: true,
      }),
    ),
    false,
  );
});

test("schedule fingerprints ignore transport ordering but detect real changes", () => {
  const first = getScheduleSyncFingerprint([
    { id: "b", enabled: true, config: { hour: 8, minute: 15 } },
    { enabled: false, id: "a" },
  ]);
  const reordered = getScheduleSyncFingerprint([
    { id: "a", enabled: false },
    { config: { minute: 15, hour: 8 }, enabled: true, id: "b" },
  ]);
  const changed = getScheduleSyncFingerprint([
    { id: "a", enabled: false },
    { config: { minute: 30, hour: 8 }, enabled: true, id: "b" },
  ]);
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test("WhatsApp-dependent schedules resume as soon as the bridge is healthy", () => {
  assert.equal(
    shouldDeferScheduledWhatsAppJob({
      requiresWhatsApp: true,
      runtimeConfigured: true,
      bridgeReady: false,
    }),
    true,
  );
  assert.equal(
    shouldDeferScheduledWhatsAppJob({
      requiresWhatsApp: true,
      runtimeConfigured: true,
      bridgeReady: true,
    }),
    false,
  );
});

test("missing WhatsApp configuration does not leave a schedule waiting forever", () => {
  assert.equal(
    shouldDeferScheduledWhatsAppJob({
      requiresWhatsApp: true,
      runtimeConfigured: false,
      bridgeReady: false,
    }),
    false,
  );
});
