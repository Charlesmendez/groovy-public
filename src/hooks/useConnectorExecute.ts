"use client";

/**
 * Browser-side connector execution callback for useOrchestrator's
 * `needs_connector` rounds.
 *
 * Faithful extraction of dashboard/page.tsx:
 * - pendingConnectorRequests map + timeout constants (~lines 1958-2016)
 * - relay subscription that resolves pending requests by request_id, skipping
 *   `claude_run_progress` streaming updates (~lines 2101-2114)
 * - cancelPendingConnectorRequests unmount cleanup with best-effort
 *   `browser_task_cancel` (~lines 2154-2191)
 * - handleConnectorExecute (~lines 2193-2402), including the
 *   `whatsapp_send_media` media-url signing/local-path rewrite.
 *
 * All connector types the old handler supports (claude_run, terminal_exec,
 * whatsapp_*, site_*, sqlite_*, linkdb_*, file_*, obsidian_*, browser_* etc.)
 * flow through the same generic send/await protocol; per-type behavior lives
 * in the timeout mapping and the whatsapp_send_media params rewrite.
 */

import { useCallback, useEffect, useRef } from "react";
import type { useRelay } from "@/hooks/useRelay";
import type { ConnectorExecuteCallback } from "@/hooks/useOrchestrator";

const CONNECTOR_DEFAULT_TIMEOUT_MS = 30_000;
const CONNECTOR_CREDENTIAL_TIMEOUT_MS = 120_000;
const CONNECTOR_BROWSER_TASK_TIMEOUT_MS = 13 * 60 * 1000;
const CONNECTOR_TERMINAL_TIMEOUT_MS = 10 * 60 * 1000;
const CONNECTOR_CLAUDE_RUN_TIMEOUT_MS = 20 * 60 * 1000;
const CONNECTOR_CLAUDE_RUN_WAIT_TIMEOUT_MS = CONNECTOR_CLAUDE_RUN_TIMEOUT_MS + 120_000;
const CONNECTOR_SITE_DEV_START_TIMEOUT_MS = 210_000;

function getConnectorTimeoutMs(type: string, payload?: Record<string, unknown>): number {
  // Credential prompts require human input; allow 2 minutes.
  if (type === "browser_credential_request") return CONNECTOR_CREDENTIAL_TIMEOUT_MS;
  // Browser task runs can legitimately take several minutes (Playwright + Claude loop).
  if (type === "browser_task_run") return CONNECTOR_BROWSER_TASK_TIMEOUT_MS;
  // Terminal commands (e.g., create-next-app, npm install) frequently exceed 30s.
  if (type === "terminal_exec") {
    const requested = Number(payload?.timeout_ms);
    if (Number.isFinite(requested) && requested > 0) {
      // Give a small buffer over connector-side timeout to account for relay latency.
      return Math.min(Math.max(CONNECTOR_DEFAULT_TIMEOUT_MS, requested + 10_000), 15 * 60 * 1000);
    }
    return CONNECTOR_TERMINAL_TIMEOUT_MS;
  }
  // Interactive Claude PTY steps often pause while Claude thinks, so they need
  // the same long timeout treatment as other terminal-style operations.
  if (type === "terminal_step") {
    const requested = Number(payload?.max_wait_ms);
    if (Number.isFinite(requested) && requested > 0) {
      return Math.min(Math.max(CONNECTOR_DEFAULT_TIMEOUT_MS, requested + 10_000), 15 * 60 * 1000);
    }
    return CONNECTOR_TERMINAL_TIMEOUT_MS;
  }
  // Headless Claude runs are long-running by design.
  if (type === "claude_run") {
    const requested = Number(payload?.timeout_ms);
    if (Number.isFinite(requested) && requested > 0) {
      return Math.min(
        Math.max(CONNECTOR_DEFAULT_TIMEOUT_MS, requested + 10_000),
        CONNECTOR_CLAUDE_RUN_WAIT_TIMEOUT_MS
      );
    }
    return CONNECTOR_CLAUDE_RUN_WAIT_TIMEOUT_MS;
  }
  // site_dev_start can include dependency installs + readiness checks.
  if (type === "site_dev_start") return CONNECTOR_SITE_DEV_START_TIMEOUT_MS;
  return CONNECTOR_DEFAULT_TIMEOUT_MS;
}

type ConnectorResult = { ok: boolean; error?: string; [key: string]: unknown };

type PendingConnectorRequest = {
  resolve: (result: ConnectorResult) => void;
  timeout: ReturnType<typeof setTimeout>;
  requestType: string;
  deviceId: string;
};

export function useConnectorExecute(args: {
  relay: ReturnType<typeof useRelay>;
  activeDeviceId: string | null;
}): {
  connectorExecute: ConnectorExecuteCallback;
} {
  const { relay, activeDeviceId } = args;

  const pendingConnectorRequests = useRef<Map<string, PendingConnectorRequest>>(new Map());
  const relayStatusRef = useRef(relay.status);
  const activeDeviceIdRef = useRef<string | null>(activeDeviceId);
  const relaySubscribe = relay.subscribe;
  const relaySend = relay.send;

  useEffect(() => {
    relayStatusRef.current = relay.status;
  }, [relay.status]);

  useEffect(() => {
    activeDeviceIdRef.current = activeDeviceId;
  }, [activeDeviceId]);

  // After refresh/HMR, relay + device_online can lag. Poll refs for a short window
  // (mirrors ensureActiveDeviceIdReady, dashboard/page.tsx ~line 1720).
  const ensureActiveDeviceIdReady = useCallback(async () => {
    for (let i = 0; i < 20; i++) {
      if (activeDeviceIdRef.current) return activeDeviceIdRef.current;
      const rs = relayStatusRef.current as unknown as string;
      if (rs === "error") return null;
      await new Promise((r) => setTimeout(r, 150));
    }
    return activeDeviceIdRef.current;
  }, []);

  // Resolve pending requests from relay responses (dashboard/page.tsx ~lines 2101-2114).
  useEffect(() => {
    if (!relaySubscribe) return;

    const unsub = relaySubscribe((msg) => {
      const msgType = (msg as { type?: string }).type;
      const requestId = (msg as { request_id?: string }).request_id;

      if (requestId && pendingConnectorRequests.current.has(requestId)) {
        // Streaming updates (e.g. claude_run_progress) should not resolve the
        // pending request; wait for the terminal result event.
        if (msgType === "claude_run_progress") {
          return;
        }
        const pending = pendingConnectorRequests.current.get(requestId)!;
        clearTimeout(pending.timeout);
        pendingConnectorRequests.current.delete(requestId);
        pending.resolve(msg as unknown as ConnectorResult);
      }
    });

    return unsub;
  }, [relaySubscribe]);

  const cancelPendingConnectorRequests = useCallback(
    (origin: "user" | "unmount") => {
      const pendingMap = pendingConnectorRequests.current;
      for (const [requestId, pending] of pendingMap.entries()) {
        if (origin === "user" && !requestId.startsWith("req-")) {
          continue;
        }
        clearTimeout(pending.timeout);
        if (pending.requestType === "browser_task_run" && pending.deviceId) {
          try {
            relaySend({
              type: "browser_task_cancel",
              request_id: `cancel-${origin}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              device_id: pending.deviceId,
              target_request_id: requestId,
            });
          } catch {
            // ignore best-effort cleanup failures
          }
        }
        try {
          pending.resolve({ ok: false, error: "cancelled" });
        } catch {
          // no-op
        }
        pendingMap.delete(requestId);
      }
    },
    [relaySend]
  );

  // Best-effort cleanup: if the tab reloads/closes mid browser_task_run, ask the
  // connector to abort in-flight tasks so they don't keep running orphaned.
  useEffect(() => {
    return () => {
      cancelPendingConnectorRequests("unmount");
    };
  }, [cancelPendingConnectorRequests]);

  const connectorExecute = useCallback<ConnectorExecuteCallback>(
    async (params): Promise<ConnectorResult> => {
      // Use ref for current status to avoid stale closure issues
      const currentStatus = relayStatusRef.current as unknown as string;
      if (currentStatus !== "ready") {
        // Relay may briefly go through "connecting" during HMR/refresh; retry with backoff
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 300 + i * 100)); // 300ms, 400ms, 500ms, ...
          const retryStatus = relayStatusRef.current as unknown as string;
          if (retryStatus === "ready") break;
        }
        const finalStatus = relayStatusRef.current as unknown as string;
        if (finalStatus !== "ready") {
          return {
            ok: false,
            error: "Connector not connected. Start the Groovy Connector on your machine.",
          };
        }
      }
      const resolvedDeviceId = activeDeviceIdRef.current || (await ensureActiveDeviceIdReady());
      if (!resolvedDeviceId) {
        return {
          ok: false,
          error:
            "No local device selected/online. Start the Groovy Connector and then click the connector pill to reconnect.",
        };
      }

      let connectorParams: Record<string, unknown> = { ...(params.params || {}) };
      if (params.type === "whatsapp_send_media") {
        const rawUrl =
          typeof connectorParams.url === "string" ? connectorParams.url.trim() : "";
        const storagePath =
          typeof connectorParams.storage_path === "string"
            ? connectorParams.storage_path.trim()
            : "";
        const explicitLocalPath =
          typeof connectorParams.local_path === "string"
            ? connectorParams.local_path.trim()
            : "";
        const fileId =
          typeof connectorParams.file_id === "string"
            ? connectorParams.file_id.trim()
            : "";
        const inferredLocalPathFromStorage = (() => {
          if (explicitLocalPath || !storagePath) return "";
          if (/^[a-z]+:\/\//i.test(storagePath)) return "";
          if (storagePath.startsWith("~/") || storagePath.startsWith("~\\")) return storagePath;
          if (storagePath.startsWith("/") || storagePath.startsWith("\\")) return storagePath;
          if (/^[a-zA-Z]:[\\/]/.test(storagePath)) return storagePath;
          return "";
        })();
        const localPath = explicitLocalPath || inferredLocalPathFromStorage;
        const inferredStoragePathFromUrl = (() => {
          if (!rawUrl) return "";
          try {
            const parsed = new URL(rawUrl);
            const markers = [
              "/storage/v1/object/sign/chat_uploads/",
              "/storage/v1/object/public/chat_uploads/",
              "/storage/v1/object/authenticated/chat_uploads/",
            ];
            for (const marker of markers) {
              const idx = parsed.pathname.indexOf(marker);
              if (idx < 0) continue;
              const raw = parsed.pathname.slice(idx + marker.length).replace(/^\/+/, "");
              return raw ? decodeURIComponent(raw) : "";
            }
            return "";
          } catch {
            return "";
          }
        })();

        if (localPath) {
          connectorParams = {
            ...connectorParams,
            local_path: localPath,
          };
        } else if (storagePath || fileId || inferredStoragePathFromUrl) {
          let usedSignedUrl = false;
          try {
            const sessionIdFromParams =
              typeof params.sessionId === "string" ? params.sessionId.trim() : "";
            const sessionIdFromPayload =
              typeof connectorParams.orchestrator_session_id === "string"
                ? String(connectorParams.orchestrator_session_id).trim()
                : "";
            const sessionIdForMedia = sessionIdFromPayload || sessionIdFromParams;
            if (!sessionIdForMedia) {
              return {
                ok: false,
                error: "No active session available to validate media send.",
              };
            }
            const signRes = await fetch("/api/orchestrator/media-url", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sessionId: sessionIdForMedia,
                ...((storagePath || inferredStoragePathFromUrl)
                  ? { storagePath: storagePath || inferredStoragePathFromUrl }
                  : {}),
                ...(fileId ? { fileId } : {}),
              }),
            });
            const signJson = (await signRes.json().catch(() => null)) as
              | { url?: unknown; filename?: unknown; error?: unknown }
              | null;
            const signedUrl =
              signJson && typeof signJson.url === "string" ? signJson.url.trim() : "";
            if (signRes.ok && signedUrl) {
              const filename =
                signJson && typeof signJson.filename === "string"
                  ? signJson.filename.trim()
                  : "";
              connectorParams = {
                ...connectorParams,
                url: signedUrl,
                ...(
                  !(
                    typeof connectorParams.filename === "string" &&
                    connectorParams.filename.trim()
                  ) && filename
                    ? { filename }
                    : {}
                ),
              };
              usedSignedUrl = true;
            } else if (signRes.status === 400 || signRes.status === 403) {
              const err =
                signJson && typeof signJson.error === "string"
                  ? signJson.error
                  : "Media URL was rejected for this session.";
              return { ok: false, error: err };
            } else if (!rawUrl) {
              const err =
                signJson && typeof signJson.error === "string"
                  ? signJson.error
                  : "Failed to resolve media URL.";
              return { ok: false, error: err };
            }
          } catch (e) {
            if (!rawUrl) {
              const err = e instanceof Error ? e.message : "Failed to resolve media URL.";
              return { ok: false, error: err };
            }
          }
          if (!usedSignedUrl && rawUrl) {
            connectorParams = { ...connectorParams, url: rawUrl };
          }
        } else if (!rawUrl) {
          return {
            ok: false,
            error: "whatsapp_send_media requires url, local_path, or storage_path/file_id.",
          };
        }
      }

      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      return new Promise((resolve) => {
        const timeoutMs = getConnectorTimeoutMs(params.type, connectorParams);
        // Set timeout
        const timeout = setTimeout(() => {
          pendingConnectorRequests.current.delete(requestId);
          if (params.type === "browser_task_run") {
            try {
              relaySend({
                type: "browser_task_cancel",
                request_id: `cancel-timeout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                device_id: resolvedDeviceId,
                target_request_id: requestId,
              });
            } catch {
              // ignore best-effort cancellation failures
            }
          }
          resolve({
            ok: false,
            error: `Connector request timed out (${Math.round(timeoutMs / 1000)}s)`,
          });
        }, timeoutMs);

        pendingConnectorRequests.current.set(requestId, {
          resolve,
          timeout,
          requestType: params.type,
          deviceId: resolvedDeviceId,
        });

        // Send to connector
        relaySend({
          type: params.type,
          request_id: requestId,
          device_id: resolvedDeviceId,
          ...connectorParams,
        });
      });
    },
    [relaySend, ensureActiveDeviceIdReady]
  );

  return { connectorExecute };
}
