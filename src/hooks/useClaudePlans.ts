"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ClaudePlan = {
  provider?: "claude" | "codex";
  workspaceRoot: string;
  filename: string;
  title: string;
  content: string;
  modifiedAt: string;
  sizeBytes: number;
  sourcePath?: string;
  sessionId?: string;
};

type RelayMsg = { type: string; [key: string]: unknown };

type UseClaudePlansOpts = {
  relaySend: (msg: RelayMsg) => boolean;
  relaySubscribe: (handler: (msg: RelayMsg) => void) => () => void;
  relayStatus: string;
  activeDeviceId: string | null;
  workspaceRoots: string[];
};

const PLANS_SCAN_TIMEOUT_MS = 150_000;
const LATE_PLANS_RESULT_ACCEPT_MS = 5 * 60_000;

export function useClaudePlans({
  relaySend,
  relaySubscribe,
  relayStatus,
  activeDeviceId,
  workspaceRoots,
}: UseClaudePlansOpts) {
  const [plans, setPlans] = useState<ClaudePlan[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const timedOutRequestRef = useRef<{ requestId: string; timedOutAt: number } | null>(null);
  const isLoadingRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return relaySubscribe((msg) => {
      const resultRequestId = typeof msg.request_id === "string" ? msg.request_id : "";
      const activeRequestId = requestIdRef.current;
      const timedOutRequest = timedOutRequestRef.current;
      const matchesActiveRequest = Boolean(activeRequestId && resultRequestId === activeRequestId);
      const matchesRecentTimedOutRequest = Boolean(
        timedOutRequest &&
          resultRequestId === timedOutRequest.requestId &&
          Date.now() - timedOutRequest.timedOutAt <= LATE_PLANS_RESULT_ACCEPT_MS
      );

      if (
        msg.type !== "claude_plans_list_result" ||
        (!matchesActiveRequest && !matchesRecentTimedOutRequest)
      )
        return;

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (matchesActiveRequest) {
        requestIdRef.current = null;
      }
      if (matchesRecentTimedOutRequest) {
        timedOutRequestRef.current = null;
      }
      isLoadingRef.current = false;
      setIsLoading(false);

      if (!msg.ok) {
        setError(typeof msg.error === "string" ? msg.error : "Failed to fetch plans");
        return;
      }

      const raw = Array.isArray(msg.plans) ? msg.plans : [];
      setPlans(
        raw.map((p: Record<string, unknown>) => ({
          provider: p.provider === "codex" ? "codex" : "claude",
          workspaceRoot: String(p.workspaceRoot || ""),
          filename: String(p.filename || ""),
          title: String(p.title || ""),
          content: String(p.content || ""),
          modifiedAt: String(p.modifiedAt || ""),
          sizeBytes: typeof p.sizeBytes === "number" ? p.sizeBytes : 0,
          sourcePath: typeof p.sourcePath === "string" ? p.sourcePath : undefined,
          sessionId: typeof p.sessionId === "string" ? p.sessionId : undefined,
        }))
      );
      setError(null);
    });
  }, [relaySubscribe]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      timedOutRequestRef.current = null;
    };
  }, []);

  const refresh = useCallback(() => {
    if (isLoadingRef.current) return;
    if (relayStatus !== "ready" || !activeDeviceId) {
      setError(!activeDeviceId ? "No device connected" : "Connector not ready");
      return;
    }

    const requestId = `plans-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    requestIdRef.current = requestId;
    timedOutRequestRef.current = null;
    isLoadingRef.current = true;
    setIsLoading(true);
    setError(null);

    const sent = relaySend({
      type: "claude_plans_list",
      request_id: requestId,
      device_id: activeDeviceId,
      workspace_roots: workspaceRoots,
    });
    if (!sent) {
      requestIdRef.current = null;
      isLoadingRef.current = false;
      setIsLoading(false);
      setError("Failed to send plans request to connector");
      return;
    }

    timeoutRef.current = setTimeout(() => {
      if (requestIdRef.current !== requestId) return;
      requestIdRef.current = null;
      timedOutRequestRef.current = { requestId, timedOutAt: Date.now() };
      isLoadingRef.current = false;
      timeoutRef.current = null;
      setIsLoading(false);
      setError("Timed out scanning workspaces for plans");
    }, PLANS_SCAN_TIMEOUT_MS);
  }, [activeDeviceId, relaySend, relayStatus, workspaceRoots]);

  return { plans, isLoading, error, refresh };
}
