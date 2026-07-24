"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getDesktopApi, isDesktopShell } from "@/lib/desktop/shell";
import type { ChatNotificationMode } from "@/lib/notifications/push";

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

export function useWebPushNotifications() {
  const [transport, setTransport] =
    useState<NotificationTransport>("web-push");
  const [support, setSupport] = useState<PushSupport>("checking");
  const [configured, setConfigured] = useState(false);
  const [migrationPending, setMigrationPending] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("unsupported");
  const [deviceSubscribed, setDeviceSubscribed] = useState(false);
  const [subscriptionCount, setSubscriptionCount] = useState(0);
  const [preferences, setPreferences] = useState<PushPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
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
        fetch("/api/notifications/push", {
          cache: "no-store",
        }),
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
            ? nativeStatus?.permission === "denied"
              ? "denied"
              : "granted"
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
      setPermission("granted");
      setDeviceSubscribed(true);
      return null;
    }
    if (browserPushSupport() !== "supported") {
      throw new Error(
        "This browser cannot receive background notifications. On iPhone or iPad, add Groovy to your Home Screen first.",
      );
    }
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
    error,
    setError,
    setRoomMode,
    disableThisDevice,
    canDisableDevice: transport === "web-push",
    refresh,
  };
}
