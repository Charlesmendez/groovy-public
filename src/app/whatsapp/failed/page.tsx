"use client";

import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";

export default function WhatsappFailedPage() {
  const error = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("error_code");
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900/80 p-6 text-center">
        <AlertTriangle className="w-7 h-7 mx-auto text-amber-400" />
        <div className="text-sm text-zinc-200 mt-3">WhatsApp setup failed.</div>
        {error && <div className="text-xs text-zinc-500 mt-2">Error: {error}</div>}
      </div>
    </div>
  );
}
