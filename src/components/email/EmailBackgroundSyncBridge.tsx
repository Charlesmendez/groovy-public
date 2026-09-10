"use client";

import { useEffect } from "react";
import { getDesktopApi } from "@/lib/desktop/shell";
import {
  EMAIL_DISCOVERY_INTERVAL_MS,
  EMAIL_DISCOVERY_MAX_BACKOFF_MS,
  EMAIL_DISCOVERY_STARTUP_DELAY_MS,
  emailDiscoveryDelayAfterFailure,
} from "@/lib/email/backgroundSync";
import { writeEmailBackgroundFocusSnapshot } from "@/lib/email/backgroundFeedCache";
import { isEmailFeedResponse } from "@/lib/email/feedCache";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export const EMAIL_BACKGROUND_SYNC_EVENT = "groovy:email-background-sync";

const CROSS_TAB_LEASE_MS = EMAIL_DISCOVERY_INTERVAL_MS - 2_000;
const LEASE_HEARTBEAT_MS = 5_000;

function leaseKey(userId: string): string {
  return `groovy:email-background-sync:${userId}`;
}

function claimLease(userId: string): boolean {
  try {
    const key = leaseKey(userId);
    const lastStarted = Number(window.localStorage.getItem(key) || 0);
    if (Date.now() - lastStarted < CROSS_TAB_LEASE_MS) return false;
    window.localStorage.setItem(key, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}

function renewLease(userId: string): void {
  try {
    window.localStorage.setItem(leaseKey(userId), String(Date.now()));
  } catch {
    // The in-flight guard still prevents duplicate work in this window.
  }
}

export function EmailBackgroundSyncBridge() {
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel("groovy-email-background-sync");
    let disposed = false;
    let inFlight: Promise<void> | null = null;
    let userId = "";
    let readyAt = Number.POSITIVE_INFINITY;
    let nextAllowedAt = Number.POSITIVE_INFINITY;
    let consecutiveFailures = 0;
    let timer: number | null = null;

    const schedule = (delayMs: number) => {
      if (disposed || !userId) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        run();
      }, Math.max(0, delayMs));
    };

    const announce = (
      scope: string,
      options: {
        remote?: boolean;
        snapshotReady?: boolean;
        liveRefresh?: boolean;
        syncedAt?: number;
        actionIds?: string[];
      } = {},
    ) => {
      const detail = {
        userId: scope,
        syncedAt: options.syncedAt ?? Date.now(),
        remote: options.remote === true,
        snapshotReady: options.snapshotReady === true,
        liveRefresh: options.liveRefresh === true,
        actionIds: options.actionIds || [],
      };
      window.dispatchEvent(
        new CustomEvent(EMAIL_BACKGROUND_SYNC_EVENT, { detail }),
      );
      if (!options.remote) channel?.postMessage(detail);
    };

    const warmFocusSnapshot = async (
      scope: string,
      actionIds: string[],
    ): Promise<boolean> => {
      if (actionIds.length === 0) return false;
      const params = new URLSearchParams({
        view: "focus",
        limit: "24",
        sync: "delta",
      });
      for (const actionId of actionIds.slice(0, 50)) {
        params.append("actionId", actionId);
      }
      const response = await fetch(`/api/email/feed?${params.toString()}`, {
        cache: "no-store",
      }).catch(() => null);
      if (!response?.ok || disposed || userId !== scope) return false;
      const payload: unknown = await response.json().catch(() => null);
      if (!isEmailFeedResponse(payload, "focus")) return false;
      return writeEmailBackgroundFocusSnapshot({
        scope,
        feed: payload,
        kind: "notification",
      });
    };

    const run = () => {
      const scope = userId;
      if (!scope || disposed || inFlight) {
        return;
      }
      const now = Date.now();
      const blockedUntil = Math.max(readyAt, nextAllowedAt);
      if (now < blockedUntil) {
        schedule(blockedUntil - now);
        return;
      }
      if (!claimLease(scope)) {
        schedule(EMAIL_DISCOVERY_INTERVAL_MS);
        return;
      }
      const leaseHeartbeat = window.setInterval(
        () => renewLease(scope),
        LEASE_HEARTBEAT_MS,
      );
      const task = (async () => {
        // User placement decisions outrank discovery. A temporary Gmail
        // throttle leaves a durable pending intent; retry it in isolation so
        // triage reads cannot consume the same provider budget in this cycle.
        const providerSyncResponse = await fetch("/api/email/action/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          cache: "no-store",
        }).catch(() => null);
        if (disposed || userId !== scope) return;
        if (!providerSyncResponse?.ok) {
          consecutiveFailures += 1;
          nextAllowedAt =
            Date.now() +
            emailDiscoveryDelayAfterFailure({
              status: providerSyncResponse?.status || 0,
              consecutiveFailures,
            });
          return;
        }
        const providerSync = (await providerSyncResponse
          .json()
          .catch(() => null)) as {
          found?: number;
          attempted?: number;
          pending?: number;
          retryAfterMs?: number;
          actionIds?: string[];
        } | null;
        const providerActionIds = Array.isArray(providerSync?.actionIds)
          ? providerSync.actionIds.filter(
              (value): value is string =>
                typeof value === "string" && Boolean(value.trim()),
            )
          : [];
        if (providerActionIds.length > 0) {
          announce(scope, { actionIds: providerActionIds });
        }
        if (Number(providerSync?.found || 0) > 0) {
          consecutiveFailures = 0;
          nextAllowedAt =
            Date.now() +
            Math.max(
              EMAIL_DISCOVERY_INTERVAL_MS,
              Math.min(
                Number(providerSync?.retryAfterMs || 0),
                EMAIL_DISCOVERY_MAX_BACKOFF_MS,
              ),
            );
          return;
        }

        const triageResponse = await fetch("/api/email/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          cache: "no-store",
        }).catch(() => null);
        if (disposed || userId !== scope) return;
        if (!triageResponse?.ok) {
          consecutiveFailures += 1;
          nextAllowedAt =
            Date.now() +
            emailDiscoveryDelayAfterFailure({
              status: triageResponse?.status || 0,
              consecutiveFailures,
            });
          return;
        }
        consecutiveFailures = 0;
        nextAllowedAt = Date.now() + EMAIL_DISCOVERY_INTERVAL_MS;
        const payload = (await triageResponse.json().catch(() => null)) as {
          result?: {
            pendingActionIds?: string[];
            focusArrivals?: Array<{ actionId?: string }>;
          };
          discovery?: {
            newMessages?: number;
            remaining?: number;
            requiresLiveRefresh?: boolean;
          };
        } | null;
        const pendingActionIds = Array.isArray(
          payload?.result?.pendingActionIds,
        )
          ? payload.result.pendingActionIds
          : [];
        const focusArrivals = Array.isArray(
          payload?.result?.focusArrivals,
        )
          ? payload.result.focusArrivals
          : [];
        const actionIds = Array.from(
          new Set([
            ...pendingActionIds,
            ...focusArrivals.map(
              (arrival) => arrival.actionId || "",
            ),
          ].filter((value): value is string =>
            typeof value === "string" && Boolean(value.trim()),
          )),
        ).slice(0, 50);
        // Triage already fetched and persisted every new message. Build the
        // durable notification snapshot from those exact action rows instead
        // of immediately paying for a second Gmail list/detail fan-out.
        if (actionIds.length > 0 && !disposed && userId === scope) {
          const snapshotReady = await warmFocusSnapshot(scope, actionIds);
          if (!disposed && userId === scope) {
            announce(scope, {
              snapshotReady,
              actionIds,
              liveRefresh:
                payload?.discovery?.requiresLiveRefresh === true,
            });
          }
        } else if (
          payload?.discovery?.requiresLiveRefresh === true &&
          !disposed &&
          userId === scope
        ) {
          announce(scope, { liveRefresh: true });
        }
      })().finally(() => {
        window.clearInterval(leaseHeartbeat);
        renewLease(scope);
        if (inFlight === task) inFlight = null;
        if (!disposed && userId === scope) {
          schedule(Math.max(0, nextAllowedAt - Date.now()));
        }
      });
      inFlight = task;
    };

    const activate = (delayMs = 0) => {
      if (!userId || disposed) return;
      const now = Date.now();
      if (now < nextAllowedAt) {
        schedule(nextAllowedAt - now);
        return;
      }
      schedule(delayMs);
    };

    const start = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || disposed) return;
      userId = user.id;
      readyAt = Date.now() + EMAIL_DISCOVERY_STARTUP_DELAY_MS;
      nextAllowedAt = readyAt;
      activate(EMAIL_DISCOVERY_STARTUP_DELAY_MS);
    };
    const onOnline = () => {
      consecutiveFailures = 0;
      nextAllowedAt = Date.now();
      activate();
    };
    const onFocus = () => activate();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") activate();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.userId === userId) {
        announce(userId, {
          remote: true,
          snapshotReady: event.data?.snapshotReady === true,
          liveRefresh: event.data?.liveRefresh === true,
          actionIds: Array.isArray(event.data?.actionIds)
            ? event.data.actionIds.filter(
                (value: unknown): value is string =>
                  typeof value === "string" && Boolean(value),
              )
            : [],
          syncedAt:
            typeof event.data?.syncedAt === "number"
              ? event.data.syncedAt
              : undefined,
        });
      }
    };
    channel?.addEventListener("message", onMessage);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribeResume = getDesktopApi().onSystemResume(() => activate());
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      userId = session?.user?.id || "";
      if (!userId) {
        readyAt = Number.POSITIVE_INFINITY;
        nextAllowedAt = Number.POSITIVE_INFINITY;
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        return;
      }
      if (event === "SIGNED_IN") {
        consecutiveFailures = 0;
        readyAt = Date.now() + EMAIL_DISCOVERY_STARTUP_DELAY_MS;
        nextAllowedAt = readyAt;
        activate(EMAIL_DISCOVERY_STARTUP_DELAY_MS);
      }
    });
    void start();

    return () => {
      disposed = true;
      subscription.unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
      unsubscribeResume();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      channel?.removeEventListener("message", onMessage);
      channel?.close();
    };
  }, []);

  return null;
}
