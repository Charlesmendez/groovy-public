"use client";

/**
 * DesktopUpdateBadge — small header pill reflecting Groovy Desktop
 * auto-update progress. Renders nothing in plain browsers or when idle.
 */

import { useDesktopUpdater } from "@/hooks/useDesktopUpdater";

export function DesktopUpdateBadge({
  autoCheckKey = null,
}: {
  autoCheckKey?: string | null;
}) {
  const updater = useDesktopUpdater({ autoCheckKey });
  const status = updater.status;

  if (!updater.desktop || !status) return null;

  if (
    status.state === "checking" ||
    status.state === "available" ||
    status.state === "downloading"
  ) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-zinc-800 text-zinc-400">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
        {status.state === "checking"
          ? "Checking for update…"
          : status.version
            ? `Groovy ${status.version} downloading…`
            : "Update downloading…"}
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
        onClick={() => void updater.installUpdate()}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/15 transition-all"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
        {status.version ? `Groovy ${status.version} ready — Restart` : "Update ready — Restart"}
      </button>
    );
  }

  if (status.state === "error") {
    return (
      <button
        type="button"
        onClick={() => void updater.checkForUpdates()}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-red-500/10 text-red-300 border border-red-500/20 hover:bg-red-500/15 transition-all"
        title={status.error || "Desktop update check failed"}
      >
        Update check failed — Retry
      </button>
    );
  }

  return null;
}
