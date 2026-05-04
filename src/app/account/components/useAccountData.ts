"use client";

import { useEffect, useState } from "react";
import type { DownloadsStatus, LicenseStatus } from "./types";

export function useLicenseStatus() {
  const [data, setData] = useState<LicenseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/licenses/status", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as LicenseStatus | null;
      if (!res.ok) throw new Error(json?.error || "Failed to load license");
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load license");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return { data, loading, error, refresh };
}

export function useDownloadsStatus() {
  const [data, setData] = useState<DownloadsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/downloads", { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as DownloadsStatus | null;
        if (!res.ok) throw new Error(json?.error || "Failed to load downloads");
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load downloads");
      } finally {
        setLoading(false);
      }
    }
    run();
  }, []);

  return { data, loading, error };
}
