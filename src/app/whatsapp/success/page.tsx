"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

export default function WhatsappSuccessPage() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/whatsapp/kapso/redirect${window.location.search}`, {
          method: "GET",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || "Failed to finalize setup");
        setDone(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to finalize setup");
      }
    })();
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900/80 p-6 text-center">
        {!done && !error && (
          <>
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-cyan-400" />
            <div className="text-sm text-zinc-300 mt-3">Finalizing WhatsApp setup…</div>
          </>
        )}
        {done && (
          <>
            <CheckCircle2 className="w-7 h-7 mx-auto text-emerald-400" />
            <div className="text-sm text-zinc-200 mt-3">WhatsApp connected.</div>
            <div className="text-xs text-zinc-500 mt-2">You can close this tab.</div>
          </>
        )}
        {error && (
          <>
            <div className="text-sm text-amber-300">Setup completed, but we couldn’t finalize.</div>
            <div className="text-xs text-zinc-500 mt-2">{error}</div>
          </>
        )}
      </div>
    </div>
  );
}
