"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";

export function BuyPersonalButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoStartedRef = useRef(false);

  const startCheckout = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/licenses/personal/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent("/pricing?checkout=personal")}`;
        return;
      }
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.url) {
        throw new Error(json?.error || "Unable to start checkout");
      }
      window.location.href = json.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start checkout");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoStartedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") !== "personal") return;
    autoStartedRef.current = true;
    startCheckout();
  }, [startCheckout]);

  return (
    <div className="mt-7">
      <button
        type="button"
        onClick={startCheckout}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {loading ? "Opening Checkout..." : "Buy Personal"}
        <ArrowRight className="h-4 w-4" />
      </button>
      {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
    </div>
  );
}
