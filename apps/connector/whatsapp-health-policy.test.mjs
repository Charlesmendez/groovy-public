import assert from "node:assert/strict";
import test from "node:test";
import {
  isWhatsAppBatteryProtectionStop,
  shouldCountWhatsAppFailureTowardAutoRestart,
} from "./whatsappHealthPolicy.mjs";

test("battery protection stops cannot trigger connector restart churn", () => {
  for (const reason of [
    "resource_circuit_open",
    "whatsapp_supported_browser_not_found:Chrome 150+",
    "whatsapp_profile_rotation_failed:EPERM",
  ]) {
    assert.equal(isWhatsAppBatteryProtectionStop("whatsapp_bridge_start_failed", reason), true);
    assert.equal(
      shouldCountWhatsAppFailureTowardAutoRestart({
        schedulerScoped: false,
        source: "whatsapp_bridge_start_failed",
        reason,
      }),
      false
    );
  }
});

test("ordinary nonscheduler failures still count toward recovery", () => {
  assert.equal(
    shouldCountWhatsAppFailureTowardAutoRestart({
      schedulerScoped: false,
      source: "disconnected",
      reason: "browser disconnected",
    }),
    true
  );
  assert.equal(
    shouldCountWhatsAppFailureTowardAutoRestart({
      schedulerScoped: true,
      source: "scheduler_whatsapp_send_failed",
      reason: "browser disconnected",
    }),
    false
  );
});
