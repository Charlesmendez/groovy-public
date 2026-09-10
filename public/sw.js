/* Groovy Web Push service worker. Keep this file dependency-free so browsers
 * can update it reliably even when an application bundle changes. */

const DEFAULT_URL = "/chat";
const ICON_URL = "/icon-192.png";
const STATIC_CACHE = "groovy-static-v1";
const STATIC_CACHE_PREFIX = "groovy-static-";
const EMAIL_FOCUS_SNAPSHOT_CACHE = "groovy-email-focus-snapshot-v1";
const EMAIL_FOCUS_SNAPSHOT_PATH = "/__groovy/email-focus-snapshot";
const EMAIL_FOCUS_SNAPSHOT_SCOPE_HEADER = "X-Groovy-Email-Cache-Scope";
const EMAIL_FOCUS_SNAPSHOT_AT_HEADER = "X-Groovy-Email-Snapshot-At";
const EMAIL_FOCUS_SNAPSHOT_KIND_HEADER = "X-Groovy-Email-Snapshot-Kind";
const EMAIL_THREAD_SNAPSHOT_CACHE = "groovy-email-thread-v1";
const EMAIL_THREAD_SNAPSHOT_PATH = "/__groovy/email-thread";
const EMAIL_THREAD_SNAPSHOT_AT_HEADER = "X-Groovy-Email-Thread-At";
const EMAIL_THREAD_PREFETCH_LIMIT = 3;
const EMAIL_THREAD_CACHE_MAX_ENTRIES = 24;
const EMAIL_FOCUS_NOTIFICATION_WARMUP_TIMEOUT_MS = 2_500;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients
        .claim()
        .then(() => reconcileNotificationState())
        .catch(() => undefined),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) =>
                  key.startsWith(STATIC_CACHE_PREFIX) && key !== STATIC_CACHE,
              )
              .map((key) => caches.delete(key)),
          ),
        )
        .catch(() => undefined),
    ]),
  );
});

/* Hashed build assets are immutable, so serving them cache-first removes the
 * biggest chunk of network work from a cold app launch. Documents and API
 * calls are deliberately left untouched. */
self.addEventListener("fetch", (event) => {
  // Local dev assets are not content-hashed; caching them serves stale code.
  if (
    self.location.hostname === "localhost" ||
    self.location.hostname === "127.0.0.1"
  ) {
    return;
  }
  const request = event.request;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  const cacheable =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/icon-192.png" ||
    url.pathname === "/icon-512.png" ||
    url.pathname === "/icon-maskable-512.png";
  if (!cacheable) return;
  event.respondWith(
    caches
      .open(STATIC_CACHE)
      .then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone()).catch(() => undefined);
          trimStaticCache(cache).catch(() => undefined);
        }
        return response;
      })
      // Cache API failures (storage pressure, private mode) must degrade to
      // the network, never to a failed request.
      .catch(() => fetch(request)),
  );
});

/* Hashed asset names change every deploy, so old entries accumulate; FIFO
 * trimming keeps the cache bounded without tracking timestamps. */
const STATIC_CACHE_MAX_ENTRIES = 300;
async function trimStaticCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - STATIC_CACHE_MAX_ENTRIES;
  for (let index = 0; index < excess; index += 1) {
    await cache.delete(keys[index]).catch(() => undefined);
  }
}

function safePayload(event) {
  if (!event.data) {
    return {
      title: "Groovy",
      body: "You have a new message.",
      url: DEFAULT_URL,
      tag: "groovy-chat",
    };
  }
  try {
    const value = event.data.json();
    return value && typeof value === "object" ? value : {};
  } catch {
    return {
      title: "Groovy",
      body: event.data.text() || "You have a new message.",
      url: DEFAULT_URL,
      tag: "groovy-chat",
    };
  }
}

function safeAppUrl(value) {
  try {
    const url = new URL(
      typeof value === "string" ? value : DEFAULT_URL,
      self.location.origin,
    );
    return url.origin === self.location.origin ? url.href : self.location.origin + DEFAULT_URL;
  } catch {
    return self.location.origin + DEFAULT_URL;
  }
}

async function loadNotificationState() {
  try {
    const response = await fetch("/api/notifications/push?state=1", {
      cache: "no-store",
      credentials: "include",
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload?.migrationPending === true) return null;
    const unreadCount = Number(payload?.unreadCount);
    if (
      !Number.isFinite(unreadCount) ||
      !Array.isArray(payload?.unreadChannelIds)
    ) {
      return null;
    }
    return {
      unreadCount: Math.max(0, Math.floor(unreadCount)),
      unreadChannelIds: payload.unreadChannelIds.filter(
        (channelId) => typeof channelId === "string",
      ),
    };
  } catch {
    return null;
  }
}

async function applyAppBadge(unreadCount) {
  if (!self.navigator || !("setAppBadge" in self.navigator)) return;
  try {
    if (unreadCount > 0) {
      await self.navigator.setAppBadge(Math.min(unreadCount, 999));
    } else if ("clearAppBadge" in self.navigator) {
      await self.navigator.clearAppBadge();
    }
  } catch {
    // System badge settings remain under the user's control.
  }
}

async function reconcileNotificationState() {
  const state = await loadNotificationState();
  if (!state) return false;
  const unreadChannels = new Set(state.unreadChannelIds);
  try {
    const notifications = await self.registration.getNotifications();
    for (const notification of notifications) {
      const channelId = notification.data?.channelId;
      if (
        typeof channelId === "string" &&
        !unreadChannels.has(channelId)
      ) {
        notification.close();
      }
    }
  } catch {
    // Badge reconciliation still proceeds if notification enumeration fails.
  }
  await applyAppBadge(state.unreadCount);
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    client.postMessage({
      type: "groovy-notification-state",
      unreadCount: state.unreadCount,
      unreadChannelIds: state.unreadChannelIds,
    });
  }
  return true;
}

function emailFocusSnapshotUrl(scope) {
  const url = new URL(EMAIL_FOCUS_SNAPSHOT_PATH, self.location.origin);
  url.searchParams.set("scope", scope);
  return url.href;
}

async function refreshEmailFocusSnapshot(options = {}) {
  if (typeof caches === "undefined") return false;
  const actionIds = Array.isArray(options.actionIds)
    ? Array.from(
        new Set(
          options.actionIds.filter(
            (value) =>
              typeof value === "string" &&
              /^[a-zA-Z0-9_-]{6,128}$/.test(value),
          ),
        ),
      ).slice(0, 12)
    : [];
  const notificationSnapshot = actionIds.length > 0;
  if (!notificationSnapshot) return false;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    EMAIL_FOCUS_NOTIFICATION_WARMUP_TIMEOUT_MS,
  );
  try {
    const request = new URL("/api/email/feed", self.location.origin);
    request.searchParams.set("view", "focus");
    request.searchParams.set("limit", "24");
    request.searchParams.set("sync", "notification");
    for (const actionId of actionIds) {
      request.searchParams.append("actionId", actionId);
    }
    const response = await fetch(`${request.pathname}${request.search}`, {
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const scope = response.headers.get(EMAIL_FOCUS_SNAPSHOT_SCOPE_HEADER);
    if (!scope) return false;
    const headers = new Headers(response.headers);
    const savedAt = Date.now();
    headers.set(EMAIL_FOCUS_SNAPSHOT_AT_HEADER, String(savedAt));
    headers.set(
      EMAIL_FOCUS_SNAPSHOT_KIND_HEADER,
      "notification",
    );
    const snapshot = new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    const cache = await caches.open(EMAIL_FOCUS_SNAPSHOT_CACHE);
    await cache.put(emailFocusSnapshotUrl(scope), snapshot);
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const client of windows) {
      client.postMessage({
        type: "groovy-email-focus-snapshot",
        scope,
        savedAt,
      });
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function emailThreadSnapshotUrl(scope, connectionId, threadId) {
  const url = new URL(EMAIL_THREAD_SNAPSHOT_PATH, self.location.origin);
  url.searchParams.set("scope", scope);
  url.searchParams.set("connectionId", connectionId);
  url.searchParams.set("threadId", threadId);
  return url.href;
}

/* A push wakes this worker while the page is suspended. Spending that window
 * on the message bodies is what makes a notification tap render the email
 * immediately instead of starting a Gmail round trip after the app boots. */
async function prefetchEmailThreadBodies(payload) {
  if (typeof caches === "undefined") return;
  const targets = Array.isArray(payload && payload.threadTargets)
    ? payload.threadTargets
        .filter(
          (target) =>
            target &&
            typeof target.connectionId === "string" &&
            typeof target.threadId === "string",
        )
        .slice(0, EMAIL_THREAD_PREFETCH_LIMIT)
    : [];
  if (targets.length === 0) return;
  const cache = await caches.open(EMAIL_THREAD_SNAPSHOT_CACHE);
  await Promise.all(
    targets.map(async (target) => {
      try {
        const request = new URL("/api/email/thread", self.location.origin);
        request.searchParams.set("connectionId", target.connectionId);
        request.searchParams.set("threadId", target.threadId);
        if (typeof target.messageId === "string" && target.messageId) {
          request.searchParams.set("messageId", target.messageId);
        }
        if (typeof target.mailboxAddress === "string" && target.mailboxAddress) {
          request.searchParams.set("mailboxAddress", target.mailboxAddress);
        }
        const response = await fetch(request.href, {
          cache: "no-store",
          credentials: "include",
        });
        if (!response.ok) return;
        const scope = response.headers.get(EMAIL_FOCUS_SNAPSHOT_SCOPE_HEADER);
        if (!scope) return;
        const headers = new Headers(response.headers);
        headers.set(EMAIL_THREAD_SNAPSHOT_AT_HEADER, String(Date.now()));
        await cache.put(
          emailThreadSnapshotUrl(scope, target.connectionId, target.threadId),
          new Response(await response.arrayBuffer(), {
            status: response.status,
            statusText: response.statusText,
            headers,
          }),
        );
      } catch {
        // A failed warm-up only costs the old behaviour: fetch on tap.
      }
    }),
  );
  try {
    const keys = await cache.keys();
    for (let index = 0; index < keys.length - EMAIL_THREAD_CACHE_MAX_ENTRIES; index += 1) {
      await cache.delete(keys[index]).catch(() => undefined);
    }
  } catch {
    // Trimming is best effort.
  }
}

self.addEventListener("push", (event) => {
  const payload = safePayload(event);
  const url = safeAppUrl(payload.url);
  event.waitUntil(
    (async () => {
      const emailFeedWarmup =
        payload.type === "email-focus" &&
        Array.isArray(payload.actionIds) &&
        payload.actionIds.length > 0
          ? refreshEmailFocusSnapshot({ actionIds: payload.actionIds })
          : null;
      const emailThreadWarmup =
        payload.type === "email-focus"
          ? prefetchEmailThreadBodies(payload).catch(() => undefined)
          : null;
      if (emailFeedWarmup) {
        // Treat the notification as a readiness signal: by the time it is
        // visible, the Focus list is already cached. The fetch has a strict
        // timeout, so a Gmail outage can delay but never suppress the alert.
        await emailFeedWarmup;
      }
      // Every Web Push event remains user-visible, as required by iOS/iPadOS.
      // The authoritative unread reconciliation immediately below closes
      // stale channel notifications and synchronizes the Home Screen badge.
      await self.registration.showNotification(
        typeof payload.title === "string" ? payload.title.slice(0, 160) : "Groovy",
        {
          body:
            typeof payload.body === "string"
              ? payload.body.slice(0, 240)
              : "You have a new message.",
          icon: ICON_URL,
          badge: ICON_URL,
          tag:
            typeof payload.tag === "string"
              ? payload.tag.slice(0, 180)
              : "groovy-chat",
          renotify: true,
          silent: false,
          vibrate: [120, 60, 120],
          timestamp:
            Number.isFinite(Number(payload.sentAt))
              ? Number(payload.sentAt)
              : Date.now(),
          data: {
            url,
            type:
              typeof payload.type === "string"
                ? payload.type
                : "message",
            channelId:
              typeof payload.channelId === "string"
                ? payload.channelId
                : null,
            messageId:
              typeof payload.messageId === "string"
                ? payload.messageId
                : null,
          },
          actions:
            payload.type === "email-focus"
              ? [{ action: "open", title: "Open Focus" }]
              : typeof payload.channelId === "string"
              ? [
                  { action: "open", title: "Open conversation" },
                  { action: "mark-read", title: "Mark as read" },
                ]
              : [{ action: "open", title: "Open Groovy" }],
        },
      );
      if (payload.type === "email-focus") {
        // iOS suspends page JavaScript in the background, but a Web Push wakes
        // this worker. Use that brief window to prepare the next Focus screen
        // and the bodies of the conversations that triggered it. The warm-up
        // starts before notification rendering so a quick tap does not add
        // that rendering latency to the inbox refresh.
        await emailThreadWarmup;
      }
      const reconciled = await reconcileNotificationState();
      if (!reconciled && typeof payload.channelId === "string") {
        // If the account state cannot be reached (for example while offline),
        // show at least a badge flag until the next foreground reconciliation.
        await applyAppBadge(1);
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "groovy-reconcile-notifications") {
    event.waitUntil(reconcileNotificationState());
    return;
  }
  if (
    event.data?.type !== "groovy-channel-read" ||
    typeof event.data.channelId !== "string"
  ) {
    return;
  }
  const tag = `groovy-chat-${event.data.channelId}`.slice(0, 180);
  event.waitUntil(
    Promise.all([
      self.registration
        .getNotifications({ tag })
        .then((notifications) => {
          for (const notification of notifications) notification.close();
        })
        .catch(() => undefined),
      reconcileNotificationState(),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeAppUrl(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      if (
        event.action === "mark-read" &&
        typeof event.notification.data?.channelId === "string"
      ) {
        try {
          const response = await fetch(
            `/api/chat/channels/${encodeURIComponent(
              event.notification.data.channelId,
            )}/read`,
            {
              method: "POST",
              credentials: "include",
              cache: "no-store",
            },
          );
          if (!response.ok) {
            throw new Error("Could not mark this conversation as read");
          }
          const windows = await self.clients.matchAll({
            type: "window",
            includeUncontrolled: true,
          });
          for (const client of windows) {
            client.postMessage({
              type: "groovy-channel-read",
              channelId: event.notification.data.channelId,
            });
          }
          await reconcileNotificationState();
          return;
        } catch {
          // If the device was offline, opening the room is the safest fallback.
        }
      }
      return openAppUrl(url);
    })(),
  );
});

/* Ask a running window to navigate client-side (no document reload). Resolves
 * false when the page does not answer, e.g. an app version predating the
 * navigation bridge. */
function requestSoftNavigate(client, url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) =>
        finish(Boolean(event.data && event.data.ok === true));
      client.postMessage({ type: "groovy-open-url", url }, [channel.port2]);
      // A live page answers in a few milliseconds. Waiting longer just delays
      // the reload fallback for the suspended windows iOS keeps around.
      setTimeout(() => finish(false), 300);
    } catch {
      finish(false);
    }
  });
}

async function openAppUrl(url) {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const ranked = windows.slice().sort((left, right) => {
    const focusScore = (client) => (client.focused ? 2 : 0);
    const visibleScore = (client) =>
      client.visibilityState === "visible" ? 1 : 0;
    return (
      focusScore(right) + visibleScore(right) -
      (focusScore(left) + visibleScore(left))
    );
  });
  // Only the best-ranked window gets the soft-navigation handshake so a pile
  // of dormant tabs cannot add multiple 900ms timeouts to a notification tap.
  for (let index = 0; index < ranked.length; index += 1) {
    const client = ranked[index];
    if (index === 0 && (await requestSoftNavigate(client, url))) {
      if ("focus" in client) await client.focus().catch(() => undefined);
      return;
    }
    // Reloading an app window is the compatibility fallback only.
    if ("navigate" in client) {
      try {
        await client.navigate(url);
        if ("focus" in client) return client.focus();
      } catch {
        // A discarded window cannot navigate; try the next one.
      }
    }
  }
  return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        client.postMessage({ type: "groovy-push-subscription-changed" });
      }
    })(),
  );
});
