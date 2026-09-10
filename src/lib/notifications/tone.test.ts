import assert from "node:assert/strict";
import test from "node:test";
import { desktopUsesUnifiedNotificationTone } from "./tone";

test("unified notification tone starts with Desktop 0.24.27", () => {
  assert.equal(desktopUsesUnifiedNotificationTone(null), false);
  assert.equal(desktopUsesUnifiedNotificationTone("0.24.26"), false);
  assert.equal(desktopUsesUnifiedNotificationTone("0.24.27"), true);
  assert.equal(desktopUsesUnifiedNotificationTone("0.25.0"), true);
  assert.equal(desktopUsesUnifiedNotificationTone("invalid"), false);
});
