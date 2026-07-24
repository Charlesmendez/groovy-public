import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeNotificationDeduper,
  parseNativeChatNotificationPayload,
} from "../dist/main/nativeChatNotifications.js";

const validPayload = {
  messageId: "11111111-1111-4111-8111-111111111111",
  channelId: "22222222-2222-4222-8222-222222222222",
  title: "#launch · Groovy",
  body: "The task is complete.",
  url: "/chat/22222222-2222-4222-8222-222222222222",
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
