"use client";

import { useCallback, useEffect, useState } from "react";

export type LicenseAccessStatus = {
  licensed: boolean;
  hasAccess: boolean;
  accessStatus: "licensed" | "trial" | "trial_available" | "expired";
  requiresPurchase?: boolean;
  trial?: {
    status: "not_started" | "active" | "expired";
    eligible: boolean;
    startedAt: string | null;
    endsAt: string | null;
    remainingMs: number;
    daysRemaining: number;
    durationDays: number;
  };
};

export function useLicenseAccess() {
  const [status, setStatus] = useState<LicenseAccessStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/licenses/status", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Could not check license access");
      setStatus(json as LicenseAccessStatus);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not check license access");
    } finally {
      setLoading(false);
    }
  }, []);

  const startTrial = useCallback(async () => {
    const res = await fetch("/api/licenses/trial/start", { method: "POST" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.trial?.status !== "active") {
      throw new Error(json?.error || "Could not start free trial");
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (status?.accessStatus !== "trial" || !status.trial?.remainingMs) return;
    const timeout = window.setTimeout(
      () => void refresh(),
      Math.min(status.trial.remainingMs + 1_000, 60_000)
    );
    return () => window.clearTimeout(timeout);
  }, [status?.accessStatus, status?.trial?.remainingMs, refresh]);

  return { status, loading, error, refresh, startTrial };
}
