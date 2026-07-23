"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { getRelayUrl } from "@/lib/config/appConfig";

export type RelayStatus = "disconnected" | "connecting" | "ready" | "error";

export type RelayMessage = {
  type: string;
  [key: string]: unknown;
};

const RESUME_STALE_RECONNECT_MS = 45_000;
const RESUME_CHECKING_GRACE_MS = 6_000;
const ONLINE_DEVICE_REVALIDATE_MS = 8_000;

const relayOnlineDevicesCache = new Map<string, RelayMessage>();
let relayOnlineDevicesCacheUserId: string | null = null;

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

function createBrowserInstanceId() {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `browser-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readJwtSubject(accessToken: string): string | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload || typeof globalThis.atob !== "function") return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );
    const parsed = JSON.parse(globalThis.atob(padded)) as { sub?: unknown };
    return typeof parsed.sub === "string" && parsed.sub ? parsed.sub : null;
  } catch {
    return null;
  }
}

async function waitForAccessToken(opts: {
  timeoutMs: number;
  pollEveryMs: number;
}): Promise<string | null> {
  const { timeoutMs, pollEveryMs } = opts;
  const supabase = getSupabaseBrowserClient();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token || null;
      if (accessToken) return accessToken;
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, pollEveryMs));
  }
  return null;
}

export function useRelay({
  enabled = true,
}: {
  enabled?: boolean;
} = {}) {
  const relayUrl = getRelayUrl();
  const [status, setStatus] = useState<RelayStatus>(
    relayUrl ? "disconnected" : "error"
  );
  const [error, setError] = useState<string | null>(
    relayUrl ? null : "NEXT_PUBLIC_RELAY_URL not configured"
  );
  const [userId, setUserId] = useState<string | null>(null);
  const [reconnectTrigger, setReconnectTrigger] = useState(0);
  const [isCheckingConnection, setIsCheckingConnection] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<(msg: RelayMessage) => void>>(new Set());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onlineRevalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onlineRevalidatedDeviceIdsRef = useRef<Set<string>>(new Set());
  const reconnectAttemptsRef = useRef(0);
  // Keep a snapshot of currently-online devices so late subscribers (after refresh/HMR)
  // still get the initial `device_online` events that may have already arrived.
  const onlineDevicesRef = useRef<Map<string, RelayMessage>>(new Map());
  // Track when we last received a message (for detecting stale connections on iOS PWA wake)
  const lastMessageTimeRef = useRef<number>(0);
  const browserInstanceIdRef = useRef<string | null>(null);
  if (browserInstanceIdRef.current == null) {
    browserInstanceIdRef.current = createBrowserInstanceId();
  }

  const subscribe = useCallback((handler: (msg: RelayMessage) => void) => {
    handlersRef.current.add(handler);
    // Replay current online devices for this subscriber (avoids missing initial snapshot).
    for (const msg of onlineDevicesRef.current.values()) {
      try {
        handler(msg);
      } catch {
        // ignore subscriber errors
      }
    }
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const replayOnlineDevicesToSubscribers = useCallback(() => {
    for (const msg of onlineDevicesRef.current.values()) {
      handlersRef.current.forEach((handler) => {
        try {
          handler(msg);
        } catch {
          // ignore subscriber errors
        }
      });
    }
  }, []);

  const send = useCallback((msg: RelayMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    ws.send(
      JSON.stringify({
        ...msg,
        browser_instance_id: browserInstanceIdRef.current,
      })
    );
    return true;
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearCheckingTimer = useCallback(() => {
    if (checkingTimerRef.current) {
      clearTimeout(checkingTimerRef.current);
      checkingTimerRef.current = null;
    }
  }, []);

  const clearOnlineRevalidateTimer = useCallback(() => {
    if (onlineRevalidateTimerRef.current) {
      clearTimeout(onlineRevalidateTimerRef.current);
      onlineRevalidateTimerRef.current = null;
    }
  }, []);

  const finishCheckingConnection = useCallback(() => {
    clearCheckingTimer();
    setIsCheckingConnection(false);
  }, [clearCheckingTimer]);

  const markCheckingConnection = useCallback(
    (durationMs = RESUME_CHECKING_GRACE_MS) => {
      clearCheckingTimer();
      setIsCheckingConnection(true);
      checkingTimerRef.current = setTimeout(() => {
        checkingTimerRef.current = null;
        setIsCheckingConnection(false);
      }, durationMs);
    },
    [clearCheckingTimer]
  );

  const scheduleReconnect = useCallback(
    (reason: string) => {
      if (!enabled) return;
      if (reconnectTimerRef.current) return;
      const attempt = Math.min(reconnectAttemptsRef.current + 1, 8);
      reconnectAttemptsRef.current = attempt;
      const baseDelayMs = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
      const jitterMs = Math.floor(Math.random() * 250);
      const delayMs = baseDelayMs + jitterMs;
      console.log("[useRelay] scheduling reconnect", { reason, attempt, delayMs });
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        setReconnectTrigger((n) => n + 1);
      }, delayMs);
    },
    [enabled]
  );

  const reconnect = useCallback(() => {
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;
    markCheckingConnection();
    setStatus(relayUrl ? "connecting" : "error");
    setError(relayUrl ? null : "NEXT_PUBLIC_RELAY_URL not configured");
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;
    setReconnectTrigger((n) => n + 1);
  }, [clearReconnectTimer, markCheckingConnection, relayUrl]);

  useEffect(() => {
    if (!enabled) return;

    if (!relayUrl) {
      return;
    }

    let cancelled = false;
    let ws: WebSocket | null = null;

    const connect = async () => {
      console.log("[useRelay] connect() starting, relayUrl=", relayUrl);
      markCheckingConnection();
      setStatus("connecting");
      setError(null);

      let accessToken: string | null = null;
      try {
        // Supabase cookie auth can be briefly unavailable right after a hard refresh
        // (INITIAL_SESSION hydration). Wait a bit before declaring "Not signed in".
        accessToken = await waitForAccessToken({
          timeoutMs: 3_000,
          pollEveryMs: 150,
        });
        console.log("[useRelay] got accessToken?", !!accessToken);
      } catch (e) {
        console.error("[useRelay] waitForAccessToken threw:", e);
        if (cancelled) return;
        setStatus("error");
        setError(getErrorMessage(e) || "Supabase not configured");
        finishCheckingConnection();
        scheduleReconnect("access_token_wait_failed");
        return;
      }

      if (!accessToken) {
        console.warn("[useRelay] No access token, user not signed in");
        if (cancelled) return;
        setStatus("disconnected");
        setError("Not signed in");
        finishCheckingConnection();
        scheduleReconnect("missing_access_token");
        return;
      }

      const accessTokenUserId = readJwtSubject(accessToken);
      if (accessTokenUserId) {
        if (
          relayOnlineDevicesCacheUserId &&
          relayOnlineDevicesCacheUserId !== accessTokenUserId
        ) {
          relayOnlineDevicesCache.clear();
          onlineDevicesRef.current.clear();
        }
        relayOnlineDevicesCacheUserId = accessTokenUserId;
        if (relayOnlineDevicesCache.size > 0) {
          onlineDevicesRef.current = new Map(relayOnlineDevicesCache);
          replayOnlineDevicesToSubscribers();
        }
      }

      console.log("[useRelay] Creating WebSocket to", relayUrl);
      ws = new WebSocket(relayUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[useRelay] WebSocket opened, sending browser_hello");
        if (cancelled) return;
        clearReconnectTimer();
        clearOnlineRevalidateTimer();
        reconnectAttemptsRef.current = 0;
        onlineRevalidatedDeviceIdsRef.current = new Set();
        onlineRevalidateTimerRef.current = setTimeout(() => {
          onlineRevalidateTimerRef.current = null;
          for (const deviceId of Array.from(onlineDevicesRef.current.keys())) {
            if (onlineRevalidatedDeviceIdsRef.current.has(deviceId)) continue;
            onlineDevicesRef.current.delete(deviceId);
            relayOnlineDevicesCache.delete(deviceId);
            const offlineMsg: RelayMessage = {
              type: "device_offline",
              device_id: deviceId,
              stale_revalidation: true,
            };
            handlersRef.current.forEach((h) => {
              try {
                h(offlineMsg);
              } catch {
                // ignore subscriber errors
              }
            });
          }
        }, ONLINE_DEVICE_REVALIDATE_MS);
        ws?.send(
          JSON.stringify({
            type: "browser_hello",
            access_token: accessToken,
            browser_instance_id: browserInstanceIdRef.current,
          })
        );
      };

      ws.onmessage = (evt) => {
        let msg: RelayMessage | null = null;
        try {
          msg = JSON.parse(String(evt.data));
        } catch {
          return;
        }
        if (!msg) return;

        // Track last message time for stale connection detection
        lastMessageTimeRef.current = Date.now();

        // Respond to app_ping from relay (keepalive)
        if (msg.type === "app_ping") {
          try {
            ws?.send(JSON.stringify({ type: "app_pong", request_id: msg.request_id, ts: Date.now() }));
          } catch {
            // ignore
          }
          return; // Don't propagate keepalive pings to handlers
        }

        if (msg.type === "device_online") {
          const deviceId = typeof msg.device_id === "string" ? msg.device_id : "";
          console.log("[useRelay] Received device_online, device_id=", deviceId);
          if (deviceId) {
            onlineRevalidatedDeviceIdsRef.current.add(deviceId);
            onlineDevicesRef.current.set(deviceId, msg);
            relayOnlineDevicesCache.set(deviceId, msg);
          }
          finishCheckingConnection();
        } else if (msg.type === "device_offline") {
          const deviceId = typeof msg.device_id === "string" ? msg.device_id : "";
          console.log("[useRelay] Received device_offline, device_id=", deviceId);
          if (deviceId) {
            onlineDevicesRef.current.delete(deviceId);
            relayOnlineDevicesCache.delete(deviceId);
          }
        }

        if (msg.type === "browser_ready") {
          console.log("[useRelay] Received browser_ready, user_id=", msg.user_id);
          const id = (msg.user_id as string) || null;
          if (id && relayOnlineDevicesCacheUserId && relayOnlineDevicesCacheUserId !== id) {
            relayOnlineDevicesCache.clear();
            onlineDevicesRef.current.clear();
          }
          if (id) {
            relayOnlineDevicesCacheUserId = id;
          }
          setUserId(id);
          setStatus("ready");
          finishCheckingConnection();
        }

        if (msg.type === "error") {
          setError(String(msg.error || "Relay error"));
        }

        handlersRef.current.forEach((h) => h(msg!));
      };

      ws.onerror = (evt) => {
        console.error("[useRelay] WebSocket error:", evt);
        if (cancelled) return;
        setStatus("error");
        setError("Relay connection error");
        finishCheckingConnection();
      };

      ws.onclose = (evt) => {
        console.log("[useRelay] WebSocket closed, code=", evt.code, "reason=", evt.reason);
        if (cancelled) return;
        wsRef.current = null;
        // Note: We don't clear onlineDevicesRef here - it will be cleared in onopen
        // when a new connection is established. This allows handlers to remain
        // registered and receive device_online events during reconnection.
        setStatus("disconnected");
        scheduleReconnect(`socket_closed_${evt.code}`);
      };
    };

    connect().catch((e) => {
      if (cancelled) return;
      setStatus("error");
      setError(getErrorMessage(e) || "Failed to connect");
      finishCheckingConnection();
    });

    return () => {
      cancelled = true;
      clearReconnectTimer();
      clearOnlineRevalidateTimer();
      try {
        ws?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, [
    enabled,
    relayUrl,
    reconnectTrigger,
    clearReconnectTimer,
    clearOnlineRevalidateTimer,
    replayOnlineDevicesToSubscribers,
    scheduleReconnect,
    markCheckingConnection,
    finishCheckingConnection,
  ]);

  // Auto-reconnect when app becomes visible (fixes iOS Safari PWA sleep issue).
  // We listen to visibilitychange, pageshow (iOS PWA back-forward cache / app-switcher),
  // and focus (fallback for some Android WebViews) to cover all resume scenarios.
  useEffect(() => {
    if (!enabled) return;

    const checkAndReconnect = (source: string) => {
      markCheckingConnection();
      const ws = wsRef.current;
      const lastMessageAt = lastMessageTimeRef.current || Date.now();
      const msSinceLastMessage = Date.now() - lastMessageAt;
      console.log(`[useRelay] ${source}:`, "ws.readyState:", ws?.readyState, "msSinceLastMessage:", msSinceLastMessage);

      // Reconnect if WebSocket is closed, closing, or appears stale.
      // iOS Safari PWA can have zombie connections that appear open but are actually dead.
      const isStale = msSinceLastMessage > RESUME_STALE_RECONNECT_MS;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING || isStale) {
        console.log(`[useRelay] WebSocket needs reconnect (${source}), calling reconnect()`);
        reconnect();
      } else {
        markCheckingConnection(700);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkAndReconnect("visibilitychange");
      }
    };

    // pageshow fires when iOS PWA is restored from the app switcher (back-forward cache).
    // The persisted flag is true when the page was restored from bfcache.
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        checkAndReconnect("pageshow-persisted");
      }
    };

    // focus fires on some Android WebViews and PWAs that don't fire visibilitychange.
    const handleFocus = () => {
      if (document.visibilityState === "visible") {
        checkAndReconnect("focus");
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handleFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleFocus);
    };
  }, [enabled, reconnect, markCheckingConnection, finishCheckingConnection]);

  useEffect(() => {
    return () => {
      clearCheckingTimer();
      clearOnlineRevalidateTimer();
    };
  }, [clearCheckingTimer, clearOnlineRevalidateTimer]);

  return useMemo(
    () => ({
      status,
      error,
      userId,
      send,
      subscribe,
      reconnect,
      isChecking: isCheckingConnection,
    }),
    [status, error, userId, send, subscribe, reconnect, isCheckingConnection]
  );
}
