"use client";

import { useEffect, useState } from "react";
import {
  getDesktopApi,
  isDesktopShell,
  type DesktopUiUpdateStatus,
} from "@/lib/desktop/shell";

export function DesktopUiUpdateBanner() {
  const [status, setStatus] = useState<DesktopUiUpdateStatus | null>(null);

  useEffect(() => {
    if (!isDesktopShell()) return;
    const api = getDesktopApi();
    let cancelled = false;
    const unsubscribe = api.onUiUpdateStatus((next) => setStatus(next));

    void api
      .getUiUpdateStatus()
      .then((initial) => {
        if (!cancelled) setStatus(initial);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!status || status.state === "idle") return null;

  return (
    <aside
      aria-live="polite"
      aria-label="Groovy interface update"
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-[10000] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-2xl border border-cyan-400/25 bg-zinc-950/95 px-4 py-3 text-white shadow-2xl shadow-black/50 backdrop-blur-xl"
    >
      <span
        aria-hidden="true"
        className={`h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-400 ${
          status.state === "reloading" ? "animate-pulse" : ""
        }`}
      />
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          {status.state === "reloading"
            ? "Refreshing Groovy…"
            : "A Groovy update is ready"}
        </p>
        {status.state === "ready" && (
          <p className="text-xs text-zinc-400">
            Refresh now to use the latest interface.
          </p>
        )}
      </div>
      {status.state === "ready" && (
        <button
          type="button"
          onClick={() => void getDesktopApi().reloadUi()}
          className="ml-1 shrink-0 rounded-xl bg-cyan-400 px-3 py-2 text-xs font-semibold text-zinc-950 transition-colors hover:bg-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
        >
          Refresh now
        </button>
      )}
    </aside>
  );
}
