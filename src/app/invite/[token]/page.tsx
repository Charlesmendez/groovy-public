"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";

export default function InviteAcceptPage() {
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === "string" ? params.token : "";
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("Missing invite token");
      return;
    }

    (async () => {
      try {
        const res = await fetch("/api/workspaces/invites/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 401) {
          const next = `/invite/${encodeURIComponent(token)}`;
          router.replace(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        if (!res.ok) throw new Error(json?.error || "Failed to accept invite");
        setStatus("done");
        const destination =
          typeof json?.destination === "string" &&
          json.destination.startsWith("/")
            ? json.destination
            : "/dashboard";
        setTimeout(() => router.push(`${destination}?joined=1`), 1000);
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Failed to accept invite");
      }
    })();
  }, [token, router]);

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900/80 p-6 text-center">
        {status === "loading" && (
          <>
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-cyan-400" />
            <div className="text-sm text-zinc-300 mt-3">Joining workspace…</div>
          </>
        )}
        {status === "done" && (
          <>
            <CheckCircle2 className="w-7 h-7 mx-auto text-emerald-400" />
            <div className="text-sm text-zinc-200 mt-3">Invite accepted. Redirecting…</div>
          </>
        )}
        {status === "error" && (
          <>
            <AlertTriangle className="w-7 h-7 mx-auto text-amber-400" />
            <div className="text-sm text-zinc-200 mt-3">Could not accept invite.</div>
            {error && <div className="text-xs text-zinc-500 mt-2">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
