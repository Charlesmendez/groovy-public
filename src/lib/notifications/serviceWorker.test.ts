import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

type Listener = (event: {
  data?: { json: () => Record<string, unknown> };
  waitUntil: (promise: Promise<unknown>) => void;
}) => void;

function serviceWorkerHarness(options?: {
  notificationState?:
    | {
        unreadCount: number;
        unreadChannelIds: string[];
        migrationPending?: boolean;
      }
    | null;
  visibleClient?: boolean;
  emailFocusFeed?: Record<string, unknown>;
}) {
  const listeners = new Map<string, Listener>();
  const shown: Array<{
    title: string;
    options: Record<string, unknown>;
  }> = [];
  const closed: string[] = [];
  const badges: number[] = [];
  const clientMessages: unknown[] = [];
  const fetchUrls: string[] = [];
  const cachePuts: Array<{ url: string; response: Response }> = [];
  const operations: string[] = [];
  const existingNotifications = [
    {
      data: { channelId: "channel-unread" },
      close: () => closed.push("channel-unread"),
    },
    {
      data: { channelId: "channel-read" },
      close: () => closed.push("channel-read"),
    },
  ];
  const notificationState =
    options && "notificationState" in options
      ? options.notificationState
      : {
          unreadCount: 2,
          unreadChannelIds: ["channel-unread"],
        };
  const self = {
    location: { origin: "https://www.gogroovy.ai" },
    navigator: {
      setAppBadge: async (count: number) => {
        badges.push(count);
      },
      clearAppBadge: async () => {
        badges.push(0);
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [
        {
          visibilityState: options?.visibleClient ? "visible" : "hidden",
          postMessage: (payload: unknown) => clientMessages.push(payload),
        },
      ],
    },
    registration: {
      getNotifications: async () => existingNotifications,
      showNotification: async (
        title: string,
        notificationOptions: Record<string, unknown>,
      ) => {
        operations.push("notification");
        shown.push({ title, options: notificationOptions });
      },
    },
    addEventListener: (name: string, listener: Listener) => {
      listeners.set(name, listener);
    },
    skipWaiting: () => undefined,
  };
  const context = vm.createContext({
    self,
    URL,
    Set,
    Promise,
    Date,
    Number,
    Array,
    Math,
    AbortController,
    clearTimeout,
    encodeURIComponent,
    Headers,
    Response,
    setTimeout,
    fetch: async (input: string) => {
      fetchUrls.push(input);
      if (input.startsWith("/api/email/feed?")) {
        return new Response(JSON.stringify(options?.emailFocusFeed || {}), {
          status: options?.emailFocusFeed ? 200 : 500,
          headers: {
            "Content-Type": "application/json",
            "X-Groovy-Email-Cache-Scope": "user-1",
          },
        });
      }
      return new Response(JSON.stringify(notificationState || {}), {
        status: notificationState ? 200 : 500,
        headers: { "Content-Type": "application/json" },
      });
    },
    caches: {
      open: async () => ({
        put: async (url: string, response: Response) => {
          operations.push("email-snapshot");
          cachePuts.push({ url, response });
        },
      }),
    },
  });
  vm.runInContext(
    readFileSync(
      new URL("../../../public/sw.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  return {
    listeners,
    shown,
    closed,
    badges,
    clientMessages,
    fetchUrls,
    cachePuts,
    operations,
    reconcile: context.reconcileNotificationState as () => Promise<boolean>,
  };
}

test("email Focus push prepares a user-scoped feed snapshot", async () => {
  const harness = serviceWorkerHarness({
    emailFocusFeed: { ok: true, view: "focus", threads: [] },
  });
  const push = harness.listeners.get("push");
  assert.ok(push);
  let completion: Promise<unknown> | null = null;
  push({
    data: {
      json: () => ({
        type: "email-focus",
        title: "New Focus email",
        body: "Alex sent you a message",
        url: "/email",
        actionIds: ["action-1"],
      }),
    },
    waitUntil: (promise) => {
      completion = promise;
    },
  });
  assert.ok(completion);
  await completion;
  assert.ok(
    harness.fetchUrls.includes(
      "/api/email/feed?view=focus&limit=24&sync=notification&actionId=action-1",
    ),
  );
  assert.equal(
    harness.fetchUrls.includes("/api/email/feed?view=focus&limit=24"),
    false,
  );
  assert.equal(harness.cachePuts.length, 1);
  assert.equal(
    harness.cachePuts[0]?.url,
    "https://www.gogroovy.ai/__groovy/email-focus-snapshot?scope=user-1",
  );
  assert.ok(
    Number(
      harness.cachePuts[0]?.response.headers.get(
        "X-Groovy-Email-Snapshot-At",
      ),
    ) > 0,
  );
  assert.equal(
    harness.cachePuts[0]?.response.headers.get(
      "X-Groovy-Email-Snapshot-Kind",
    ),
    "notification",
  );
  assert.ok(
    harness.operations.indexOf("email-snapshot") <
      harness.operations.indexOf("notification"),
  );
});

test("email Focus push still appears when feed warm-up fails", async () => {
  const harness = serviceWorkerHarness();
  const push = harness.listeners.get("push");
  assert.ok(push);
  let completion: Promise<unknown> | null = null;
  push({
    data: {
      json: () => ({
        type: "email-focus",
        title: "New Focus email",
        body: "Alex sent you a message",
        url: "/email",
      }),
    },
    waitUntil: (promise) => {
      completion = promise;
    },
  });
  assert.ok(completion);
  await completion;
  assert.equal(harness.cachePuts.length, 0);
  assert.equal(harness.shown.length, 1);
});

test("service worker closes read notifications and synchronizes the app badge", async () => {
  const harness = serviceWorkerHarness();
  await harness.reconcile();
  assert.deepEqual(harness.closed, ["channel-read"]);
  assert.deepEqual(harness.badges, [2]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.clientMessages)),
    [
      {
        type: "groovy-notification-state",
        unreadCount: 2,
        unreadChannelIds: ["channel-unread"],
      },
    ],
  );
});

test("test push requests audible vibration options even with a visible client", async () => {
  const harness = serviceWorkerHarness({ visibleClient: true });
  const push = harness.listeners.get("push");
  assert.ok(push);
  let completion: Promise<unknown> | null = null;
  push({
    data: {
      json: () => ({
        type: "test",
        title: "Groovy notifications are ready",
        body: "Test alert",
        url: "/settings/notifications",
        tag: "groovy-notification-test",
        sentAt: Date.now(),
      }),
    },
    waitUntil: (promise) => {
      completion = promise;
    },
  });
  assert.ok(completion);
  await completion;
  assert.equal(harness.shown.length, 1);
  assert.equal(harness.shown[0]?.options.silent, false);
  assert.deepEqual(
    Array.from(harness.shown[0]?.options.vibrate as number[]),
    [120, 60, 120],
  );
  assert.equal(harness.shown[0]?.options.renotify, true);
});

test("message push remains user-visible and audible with a visible client", async () => {
  const harness = serviceWorkerHarness({
    visibleClient: true,
    notificationState: {
      unreadCount: 1,
      unreadChannelIds: ["channel-unread"],
    },
  });
  const push = harness.listeners.get("push");
  assert.ok(push);
  let completion: Promise<unknown> | null = null;
  push({
    data: {
      json: () => ({
        title: "#general · Teammate",
        body: "New message",
        url: "/chat/channel-unread",
        tag: "groovy-chat-channel-unread",
        channelId: "channel-unread",
        messageId: "message-1",
        sentAt: Date.now(),
      }),
    },
    waitUntil: (promise) => {
      completion = promise;
    },
  });
  assert.ok(completion);
  await completion;
  assert.equal(harness.shown.length, 1);
  assert.equal(harness.shown[0]?.options.silent, false);
  assert.equal(
    (harness.shown[0]?.options.data as { channelId?: string }).channelId,
    "channel-unread",
  );
});

test("zero unread notifications clear the Home Screen badge", async () => {
  const harness = serviceWorkerHarness({
    notificationState: { unreadCount: 0, unreadChannelIds: [] },
  });
  await harness.reconcile();
  assert.deepEqual(harness.closed, ["channel-unread", "channel-read"]);
  assert.deepEqual(harness.badges, [0]);
});

test("message push falls back to a badge flag while account state is offline", async () => {
  const harness = serviceWorkerHarness({ notificationState: null });
  const push = harness.listeners.get("push");
  assert.ok(push);
  let completion: Promise<unknown> | null = null;
  push({
    data: {
      json: () => ({
        title: "#general · Teammate",
        body: "New message",
        channelId: "channel-unread",
        messageId: "message-1",
        sentAt: Date.now(),
      }),
    },
    waitUntil: (promise) => {
      completion = promise;
    },
  });
  assert.ok(completion);
  await completion;
  assert.equal(harness.shown.length, 1);
  assert.deepEqual(harness.badges, [1]);
});

test("migration activation never clears existing alerts or badges", async () => {
  const harness = serviceWorkerHarness({
    notificationState: {
      migrationPending: true,
      unreadCount: 0,
      unreadChannelIds: [],
    },
  });
  assert.equal(await harness.reconcile(), false);
  assert.deepEqual(harness.closed, []);
  assert.deepEqual(harness.badges, []);
});
