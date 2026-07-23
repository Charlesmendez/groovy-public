"use client";

/**
 * DesktopUpdateBadge — small header pill reflecting Groovy Desktop
 * auto-update progress. Renders nothing in plain browsers or when idle.
 */

import { useEffect, useState } from "react";
import { getDesktopApi, isDesktopShell, type DesktopUpdateStatus } from "@/lib/desktop/shell";

export function DesktopUpdateBadge() {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);

  useEffect(() => {
    if (!isDesktopShell()) return;
    const api = getDesktopApi();
    let cancelled = false;
    const unsubscribe = api.onUpdateStatus((next) => setStatus(next));
    // Seed the initial state so an update already in flight is visible.
    void api
      .getUpdateStatus()
      .then((initial) => {
        if (!cancelled) setStatus((prev) => prev ?? initial);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!status) return null;

  if (status.state === "available" || status.state === "downloading") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-zinc-800 text-zinc-400">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
        {status.version ? `Groovy ${status.version} downloading…` : "Update downloading…"}
        {typeof status.percent === "number" && (
          <span className="text-[10px] opacity-70">{Math.round(status.percent)}%</span>
        )}
      </span>
    );
  }

  if (status.state === "ready") {
    return (
      <button
        type="button"
        onClick={() => void getDesktopApi().quitAndInstall()}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/15 transition-all"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
        {status.version ? `Groovy ${status.version} ready — Restart` : "Update ready — Restart"}
      </button>
    );
  }

  return null;
}
