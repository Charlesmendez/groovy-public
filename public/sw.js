/* Groovy Web Push service worker. Keep this file dependency-free so browsers
 * can update it reliably even when an application bundle changes. */

const DEFAULT_URL = "/chat";
const ICON_URL = "/Sloth_no_bg2.png";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

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

async function isNotificationStillUnread(payload) {
  if (
    typeof payload.channelId !== "string" ||
    typeof payload.messageId !== "string"
  ) {
    return true;
  }
  try {
    const statusUrl = new URL("/api/notifications/push", self.location.origin);
    statusUrl.searchParams.set("channelId", payload.channelId);
    statusUrl.searchParams.set("messageId", payload.messageId);
    const response = await fetch(statusUrl.href, {
      cache: "no-store",
      credentials: "include",
    });
    if (!response.ok) return true;
    const result = await response.json();
    return result?.shouldNotify !== false;
  } catch {
    // A transient eligibility check must not swallow a genuinely new alert.
    return true;
  }
}

self.addEventListener("push", (event) => {
  const payload = safePayload(event);
  const url = safeAppUrl(payload.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const targetPath = new URL(url).pathname;
      const alreadyReading = windows.some((client) => {
        try {
          return (
            client.visibilityState === "visible" &&
            new URL(client.url).pathname === targetPath
          );
        } catch {
          return false;
        }
      });
      if (alreadyReading) return;
      if (!(await isNotificationStillUnread(payload))) return;

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
          data: {
            url,
            channelId:
              typeof payload.channelId === "string"
                ? payload.channelId
                : null,
            messageId:
              typeof payload.messageId === "string"
                ? payload.messageId
                : null,
          },
        },
      );
      if (self.navigator && "setAppBadge" in self.navigator) {
        try {
          await self.navigator.setAppBadge();
        } catch {
          // Badging is optional and controlled separately by the OS.
        }
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (
    event.data?.type !== "groovy-channel-read" ||
    typeof event.data.channelId !== "string"
  ) {
    return;
  }
  const tag = `groovy-chat-${event.data.channelId}`.slice(0, 180);
  event.waitUntil(
    self.registration
      .getNotifications({ tag })
      .then((notifications) => {
        for (const notification of notifications) notification.close();
      })
      .catch(() => undefined),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeAppUrl(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if ("navigate" in client) {
          await client.navigate(url);
        }
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
    })(),
  );
});

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
