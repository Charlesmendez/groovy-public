import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeNotificationSettingsUrl,
  nativeNotificationStatus,
} from "../dist/main/nativeNotificationSupport.js";

test("native notification capability is not reported as permission", () => {
  assert.deepEqual(nativeNotificationStatus(true), {
    supported: true,
    permission: "unknown",
  });
  assert.deepEqual(nativeNotificationStatus(false), {
    supported: false,
    permission: "unsupported",
  });
});

test("native notification settings deep-link is macOS-only", () => {
  assert.equal(
    nativeNotificationSettingsUrl("darwin"),
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension?ai.gogroovy.desktop",
  );
  assert.equal(nativeNotificationSettingsUrl("win32"), null);
  assert.equal(nativeNotificationSettingsUrl("linux"), null);
});
