import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeNotificationDeduper,
  parseNativeBadgeCount,
  parseNativeChatNotificationPayload,
} from "../dist/main/nativeChatNotifications.js";

const validPayload = {
  messageId: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  title: "#launch · Groovy",
  body: "The task is complete.",
  url: "/chat/22222222-2222-4222-8222-222222222222",
  silent: false,
};

test("native notification payloads only permit bounded chat routes", () => {
  assert.deepEqual(parseNativeChatNotificationPayload(validPayload), validPayload);
  assert.equal(
    parseNativeChatNotificationPayload({
      ...validPayload,
      url: "https://attacker.example",
    }),
    null
  );
  assert.equal(
    parseNativeChatNotificationPayload({
      ...validPayload,
      channelId: "not-a-channel",
    }),
    null
  );
  assert.equal(
    parseNativeChatNotificationPayload({
      ...validPayload,
      body: "x".repeat(501),
    }),
    null
  );
});

test("native notification payloads accept an explicit silent banner", () => {
  assert.deepEqual(parseNativeChatNotificationPayload({
    ...validPayload,
    silent: true,
  }), {
    ...validPayload,
    silent: true,
  });
});

test("native notification deduplication is bounded", () => {
  const deduper = new NativeNotificationDeduper(2);
  deduper.add("first");
  deduper.add("second");
  assert.equal(deduper.has("first"), true);
  deduper.add("third");
  assert.equal(deduper.has("first"), false);
  assert.equal(deduper.has("second"), true);
  assert.equal(deduper.has("third"), true);
});

test("native badge counts are finite non-negative integers", () => {
  assert.equal(parseNativeBadgeCount(0), 0);
  assert.equal(parseNativeBadgeCount(42), 42);
  assert.equal(parseNativeBadgeCount(100_000), 9_999);
  assert.equal(parseNativeBadgeCount(-1), null);
  assert.equal(parseNativeBadgeCount(1.5), null);
  assert.equal(parseNativeBadgeCount("4"), null);
});
