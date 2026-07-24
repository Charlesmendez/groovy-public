import assert from "node:assert/strict";
import test from "node:test";
import {
  isMessageUnreadAtCursor,
  isSameOriginMutation,
  messageMentionsRecipient,
  notificationExcerpt,
  parseBrowserPushSubscription,
  parseChatNotificationMode,
  pushTopicForChannel,
} from "./push";

test("push subscriptions require HTTPS endpoints and bounded base64url keys", () => {
  assert.equal(
    parseBrowserPushSubscription({
      endpoint: "https://push.example.test/subscription/123",
      expirationTime: null,
      keys: {
        p256dh: "abcdefghijklmnopqrstuvwxyz0123456789_-",
        auth: "abcdefghijklmno_",
      },
    }).ok,
    true,
  );
  assert.equal(
    parseBrowserPushSubscription({
      endpoint: "http://push.example.test/subscription/123",
      keys: {
        p256dh: "abcdefghijklmnopqrstuvwxyz0123456789",
        auth: "abcdefghijklmno",
      },
    }).ok,
    false,
  );
  assert.equal(
    parseBrowserPushSubscription({
      endpoint: "https://127.0.0.1/push",
      keys: {
        p256dh: "abcdefghijklmnopqrstuvwxyz0123456789",
        auth: "abcdefghijklmno",
      },
    }).ok,
    false,
  );
  assert.equal(
    parseBrowserPushSubscription({
      endpoint: "https://push.example.test/subscription/123",
      keys: { p256dh: "not base64!", auth: "abcdefghijklmno" },
    }).ok,
    false,
  );
});

test("notification modes are closed by default", () => {
  assert.equal(parseChatNotificationMode("all"), "all");
  assert.equal(parseChatNotificationMode("mentions"), "mentions");
  assert.equal(parseChatNotificationMode("off"), "off");
  assert.equal(parseChatNotificationMode("workspace"), null);
  assert.equal(parseChatNotificationMode(undefined), null);
});

test("same-origin mutation validation rejects cross-site browser writes", () => {
  const sameOrigin = new Request("https://groovy.example/api/notifications/push", {
    method: "POST",
    headers: {
      Origin: "https://groovy.example",
      "Sec-Fetch-Site": "same-origin",
    },
  });
  const crossOrigin = new Request("https://groovy.example/api/notifications/push", {
    method: "POST",
    headers: {
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "cross-site",
    },
  });
  assert.equal(isSameOriginMutation(sameOrigin), true);
  assert.equal(isSameOriginMutation(crossOrigin), false);
});

test("mention matching uses bounded user handles", () => {
  assert.equal(
    messageMentionsRecipient({
      content: "Can you check this @charles?",
      email: "charles@example.com",
    }),
    true,
  );
  assert.equal(
    messageMentionsRecipient({
      content: "This is for @charleson.",
      email: "charles@example.com",
    }),
    false,
  );
  assert.equal(
    messageMentionsRecipient({
      content: "Could @CarlosMendez review this?",
      name: "Carlos Mendez",
    }),
    true,
  );
});

test("notification previews collapse whitespace and code blocks", () => {
  assert.equal(
    notificationExcerpt("Hello\n\n```js\nsecret()\n```\nworld"),
    "Hello [code] world",
  );
  assert.equal(notificationExcerpt("abcdefgh", 5), "abcd…");
});

test("durable read cursors suppress delayed messages", () => {
  assert.equal(
    isMessageUnreadAtCursor({
      messageCreatedAt: "2026-07-24T16:00:00.000Z",
      lastReadAt: "2026-07-24T16:00:01.000Z",
    }),
    false,
  );
  assert.equal(
    isMessageUnreadAtCursor({
      messageCreatedAt: "2026-07-24T16:00:02.000Z",
      lastReadAt: "2026-07-24T16:00:01.000Z",
    }),
    true,
  );
  assert.equal(
    isMessageUnreadAtCursor({
      messageCreatedAt: "invalid",
      lastReadAt: null,
    }),
    true,
  );
});

test("push topics stay within the Web Push 32-character limit", () => {
  assert.ok(
    pushTopicForChannel("12345678-1234-1234-1234-123456789012").length <= 32,
  );
});
