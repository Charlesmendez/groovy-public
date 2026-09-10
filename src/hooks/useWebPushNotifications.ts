"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getDesktopApi,
  isDesktopShell,
  type DesktopNativeNotificationPermission,
} from "@/lib/desktop/shell";
import type { ChatNotificationMode } from "@/lib/notifications/push";
import { NOTIFICATION_AUDIO_UNLOCK_EVENT } from "@/lib/chat/events";

type PushPreference = {
  channel_id: string;
  mode: ChatNotificationMode;
};

type PushApiPayload = {
  configured?: boolean;
  publicKey?: string | null;
  migrationPending?: boolean;
  subscriptionCount?: number;
  preferences?: PushPreference[];
  error?: string;
};

export type PushSupport =
  | "checking"
  | "supported"
  | "insecure"
  | "unsupported";

export type NotificationTransport = "web-push" | "desktop-native";

function browserPushSupport(): PushSupport {
  if (typeof window === "undefined") return "checking";
  if (!window.isSecureContext) return "insecure";
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  return "supported";
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const decoded = window.atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean(
      (window.navigator as Navigator & { standalone?: boolean }).standalone,
    )
  );
}

async function responsePayload(response: Response): Promise<PushApiPayload> {
  return (await response.json().catch(() => ({}))) as PushApiPayload;
}

// Several components mount this hook during boot (settings, room controls,
// install nudge). Share one in-flight config response for a few seconds so a
// cold open issues a single /api/notifications/push request instead of three.
const PUSH_CONFIG_SHARE_MS = 5_000;
let sharedPushConfigFetch: {
  at: number;
  promise: Promise<Response>;
} | null = null;

function fetchPushConfig(): Promise<Response> {
  const now = Date.now();
  if (
    sharedPushConfigFetch &&
    now - sharedPushConfigFetch.at < PUSH_CONFIG_SHARE_MS
  ) {
    return sharedPushConfigFetch.promise.then((response) => response.clone());
  }
  const promise = fetch("/api/notifications/push", { cache: "no-store" });
  const entry = { at: now, promise };
  sharedPushConfigFetch = entry;
  promise.catch(() => {
    if (sharedPushConfigFetch === entry) sharedPushConfigFetch = null;
  });
  return promise.then((response) => response.clone());
}

export function useWebPushNotifications() {
  const [transport, setTransport] =
    useState<NotificationTransport>("web-push");
  const [support, setSupport] = useState<PushSupport>("checking");
  const [configured, setConfigured] = useState(false);
  const [migrationPending, setMigrationPending] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [permission, setPermission] =
    useState<DesktopNativeNotificationPermission>("unsupported");
  const [deviceSubscribed, setDeviceSubscribed] = useState(false);
  const [subscriptionCount, setSubscriptionCount] = useState(0);
  const [preferences, setPreferences] = useState<PushPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const desktop = isDesktopShell();
    setTransport(desktop ? "desktop-native" : "web-push");
    const nextSupport = desktop ? "checking" : browserPushSupport();
    setSupport(nextSupport);
    if (!desktop) {
      setPermission(
        nextSupport === "supported" ? Notification.permission : "unsupported",
      );
    }
    setLoading(true);
    setError(null);
    try {
      const [response, nativeStatus] = await Promise.all([
        fetchPushConfig(),
        desktop
          ? getDesktopApi().getNativeNotificationStatus()
          : Promise.resolve(null),
      ]);
      const payload = await responsePayload(response);
      if (!response.ok) {
        throw new Error(payload.error || "Could not load notification settings.");
      }
      const nativeSupported = Boolean(nativeStatus?.supported);
      setConfigured(desktop ? nativeSupported : Boolean(payload.configured));
      setMigrationPending(Boolean(payload.migrationPending));
      setPublicKey(payload.publicKey || "");
      setSubscriptionCount(payload.subscriptionCount || 0);
      setPreferences(
        Array.isArray(payload.preferences) ? payload.preferences : [],
      );
      if (desktop) {
        setSupport(nativeSupported ? "supported" : "unsupported");
        setPermission(
          nativeSupported
            ? nativeStatus?.permission || "unknown"
            : "unsupported",
        );
        setDeviceSubscribed(nativeSupported);
      } else if (nextSupport === "supported") {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        setDeviceSubscribed(Boolean(subscription));
      } else {
        setDeviceSubscribed(false);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load notification settings.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (isDesktopShell() || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "groovy-push-subscription-changed") {
        void refresh();
      } else if (event.data?.type === "groovy-notification-state") {
        void refresh();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [refresh]);

  const preferenceMap = useMemo(
    () =>
      new Map(
        preferences.map((preference) => [
          preference.channel_id,
          preference.mode,
        ]),
      ),
    [preferences],
  );

  const ensureDeviceSubscription = useCallback(async () => {
    if (isDesktopShell()) {
      const nativeStatus = await getDesktopApi().getNativeNotificationStatus();
      if (!nativeStatus.supported) {
        throw new Error(
          "Update Groovy Desktop to enable native notifications on this device.",
        );
      }
      if (nativeStatus.permission === "denied") {
        throw new Error(
          "Groovy notifications are blocked in macOS System Settings. Allow them under Notifications, then try again.",
        );
      }
      setTransport("desktop-native");
      setSupport("supported");
      setConfigured(true);
      setPermission(nativeStatus.permission);
      setDeviceSubscribed(true);
      return null;
    }
    if (browserPushSupport() !== "supported") {
      throw new Error(
        "This browser cannot receive background notifications. On iPhone or iPad, add Groovy to your Home Screen first.",
      );
    }
    // This function starts in a click handler. Notify the global bridge before
    // the first await so Web Audio receives the same browser activation and
    // notification tones do not begin only after unrelated product use.
    window.dispatchEvent(new Event(NOTIFICATION_AUDIO_UNLOCK_EVENT));
    if (!configured || !publicKey) {
      throw new Error(
        migrationPending
          ? "Browser notifications are still being activated."
          : "Browser notifications are not configured on this deployment.",
      );
    }
    let nextPermission = Notification.permission;
    if (nextPermission === "default") {
      // This must remain the first awaited permission operation in the click
      // path so iOS retains the user's activation gesture.
      nextPermission = await Notification.requestPermission();
      setPermission(nextPermission);
    }
    if (nextPermission !== "granted") {
      throw new Error(
        "Notifications are blocked for Groovy. Allow them in your browser or device settings, then try again.",
      );
    }

    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      });
    }
    const response = await fetch("/api/notifications/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "subscribe",
        subscription: subscription.toJSON(),
        deviceLabel: isStandaloneDisplay()
          ? "Home Screen app"
          : "Web browser",
      }),
    });
    const payload = await responsePayload(response);
    if (!response.ok) {
      throw new Error(payload.error || "Could not register this device.");
    }
    setDeviceSubscribed(true);
    setSubscriptionCount((current) => Math.max(1, current));
    return subscription;
  }, [configured, migrationPending, publicKey]);

  const setRoomMode = useCallback(
    async (
      channelId: string,
      kind: "channel" | "dm",
      mode: ChatNotificationMode,
    ) => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      try {
        if (kind === "dm" && mode === "mentions") {
          throw new Error("Direct messages support all messages or muted.");
        }
        if (mode !== "off") await ensureDeviceSubscription();
        const response = await fetch("/api/notifications/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "preference",
            channelId,
            mode,
          }),
        });
        const payload = await responsePayload(response);
        if (!response.ok) {
          throw new Error(
            payload.error || "Could not save notification preference.",
          );
        }
        setPreferences((current) => [
          ...current.filter(
            (preference) => preference.channel_id !== channelId,
          ),
          { channel_id: channelId, mode },
        ]);
        window.dispatchEvent(
          new Event("groovy:notification-preferences-changed"),
        );
        return true;
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save notification preference.",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, ensureDeviceSubscription],
  );

  const disableThisDevice = useCallback(async () => {
    if (
      busy ||
      isDesktopShell() ||
      browserPushSupport() !== "supported"
    ) {
      return false;
    }
    setBusy(true);
    setTestStatus(null);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch("/api/notifications/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "unsubscribe",
            endpoint: subscription.endpoint,
          }),
        });
        const payload = await responsePayload(response);
        if (!response.ok) {
          throw new Error(payload.error || "Could not turn notifications off.");
        }
        await subscription.unsubscribe();
      }
      setDeviceSubscribed(false);
      setSubscriptionCount((current) => Math.max(0, current - 1));
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not turn notifications off.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const testThisDevice = useCallback(async () => {
    if (busy || testBusy) return false;
    setTestBusy(true);
    setTestStatus(null);
    setError(null);
    try {
      if (isDesktopShell()) {
        const desktop = getDesktopApi();
        const status = await desktop.getNativeNotificationStatus();
        if (!status.supported) {
          throw new Error(
            "Update Groovy Desktop to send a native test alert.",
          );
        }
        const result = await desktop.testNativeNotification();
        if (!result.requested) {
          throw new Error(
            result.reason === "desktop_update_required"
              ? "Update Groovy Desktop to send a native test alert."
              : "Groovy could not request the native test alert. Open macOS notification settings and allow Groovy.",
          );
        }
        setPermission(status.permission);
        setTestStatus(
          "Test alert requested. If no banner appeared, check Groovy in macOS Notifications and your current Focus mode.",
        );
        return true;
      }
      const subscription = await ensureDeviceSubscription();
      if (!subscription) {
        throw new Error("This device is not connected for browser alerts.");
      }
      const response = await fetch("/api/notifications/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
          endpoint: subscription.endpoint,
        }),
      });
      const payload = await responsePayload(response);
      if (!response.ok) {
        if (response.status === 410) {
          await subscription.unsubscribe().catch(() => false);
          setDeviceSubscribed(false);
          setSubscriptionCount((current) => Math.max(0, current - 1));
        }
        throw new Error(
          payload.error || "The test alert could not be delivered.",
        );
      }
      setTestStatus(
        "Test alert sent. Your system’s notification settings control the final sound and vibration.",
      );
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The test alert could not be delivered.",
      );
      return false;
    } finally {
      setTestBusy(false);
    }
  }, [busy, ensureDeviceSubscription, testBusy]);

  const openNativeNotificationSettings = useCallback(async () => {
    if (!isDesktopShell()) return false;
    setError(null);
    try {
      const result = await getDesktopApi().openNativeNotificationSettings();
      if (result.opened) return true;
      setError(
        result.reason === "desktop_update_required"
          ? "Update Groovy Desktop to open notification settings from the app."
          : "Could not open macOS notification settings.",
      );
      return false;
    } catch {
      setError("Could not open macOS notification settings.");
      return false;
    }
  }, []);

  return {
    transport,
    support,
    configured,
    migrationPending,
    permission,
    deviceSubscribed,
    subscriptionCount,
    preferenceMap,
    loading,
    busy,
    testBusy,
    testStatus,
    error,
    setError,
    setRoomMode,
    disableThisDevice,
    testThisDevice,
    openNativeNotificationSettings,
    canDisableDevice: transport === "web-push",
    canTestDevice:
      support === "supported" &&
      configured &&
      !migrationPending &&
      (transport === "desktop-native" || deviceSubscribed),
    canOpenNativeNotificationSettings:
      transport === "desktop-native" && support === "supported",
    refresh,
  };
}
