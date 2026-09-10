"use client";

import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DatagranProvider } from "@/lib/datagran/prompts";

type Props = {
  provider: DatagranProvider;
  agentId?: string;
  recipientTracking?: boolean;
};

function prettyProvider(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function DesktopDatagranConnect({
  provider,
  agentId,
  recipientTracking,
}: Props) {
  const [scriptReady, setScriptReady] = useState(false);
  const [status, setStatus] = useState<
    "loading" | "connecting" | "success" | "error"
  >("loading");
  const [error, setError] = useState("");
  const startedRef = useRef(false);
  const completingRef = useRef(false);

  useEffect(() => {
    if (window.DatagranLink) {
      setScriptReady(true);
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.datagran.io/embed/link.js"]',
    );
    const script = existing || document.createElement("script");
    const onLoad = () => setScriptReady(true);
    const onError = () => {
      setError("The secure connection window could not load.");
      setStatus("error");
    };
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    if (!existing) {
      script.src = "https://www.datagran.io/embed/link.js";
      script.async = true;
      document.head.appendChild(script);
    }
    return () => {
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };
  }, []);

  const start = useCallback(async () => {
    if (!window.DatagranLink) {
      setError("The secure connection window is still loading.");
      setStatus("error");
      return;
    }
    setStatus("connecting");
    setError("");
    completingRef.current = false;
    try {
      const tokenResponse = await fetch("/api/datagran/link-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(agentId ? { agentId } : { provider }),
          ...(recipientTracking ? { recipientTracking: true } : {}),
        }),
      });
      const tokenPayload = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok) {
        throw new Error(
          String(tokenPayload?.error || "Failed to start connection"),
        );
      }
      const linkToken = String(
        tokenPayload?.linkToken || tokenPayload?.link_token || "",
      );
      if (!linkToken) {
        throw new Error("The integration service did not return a connection token.");
      }

      window.DatagranLink.open({
        linkToken,
        autoCloseOnSuccess: true,
        onSuccess: async (payload) => {
          if (completingRef.current) return;
          completingRef.current = true;
          try {
            const connectionId = String(payload.connection_id || "").trim();
            if (!connectionId) {
              throw new Error("The provider did not return a connection.");
            }
            const saveResponse = agentId
              ? await fetch("/api/datagran/connection", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ agentId, connectionId }),
                })
              : await fetch("/api/agents", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    type: "datagran",
                    name: prettyProvider(provider),
                    datagranProvider: provider,
                    connectionId,
                  }),
                });
            const savePayload = await saveResponse.json().catch(() => ({}));
            if (!saveResponse.ok) {
              throw new Error(
                String(savePayload?.error || "Failed to save connection"),
              );
            }
            window.DatagranLink?.close?.();
            setStatus("success");
          } catch (cause) {
            completingRef.current = false;
            setError(
              cause instanceof Error
                ? cause.message
                : "Failed to save the connection.",
            );
            setStatus("error");
          }
        },
        onExit: () => {
          if (completingRef.current) return;
          setError("The connection window was closed before it finished.");
          setStatus("error");
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start connection.",
      );
      setStatus("error");
    }
  }, [agentId, provider, recipientTracking]);

  useEffect(() => {
    if (!scriptReady || startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [scriptReady, start]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#09090b] px-6 py-12 text-white">
      <section className="w-full max-w-lg rounded-3xl border border-white/10 bg-white/[0.035] p-8 text-center shadow-2xl">
        {status === "success" ? (
          <>
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-300" />
            <h1 className="mt-5 text-2xl font-semibold">
              {prettyProvider(provider)} connected
            </h1>
            <p className="mt-3 text-sm leading-6 text-zinc-400">
              You can close this browser tab and return to Groovy Desktop.
            </p>
          </>
        ) : (
          <>
            {status === "loading" || status === "connecting" ? (
              <Loader2 className="mx-auto h-11 w-11 animate-spin text-cyan-300" />
            ) : (
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-red-400/10 text-red-300">
                !
              </div>
            )}
            <h1 className="mt-5 text-2xl font-semibold">
              Connect {prettyProvider(provider)}
            </h1>
            <p className="mt-3 text-sm leading-6 text-zinc-400">
              {status === "loading"
                ? "Preparing the secure connection…"
                : status === "connecting"
                  ? "Complete the provider authorization window to continue."
                  : error || "The connection could not be completed."}
            </p>
            {status === "error" ? (
              <button
                type="button"
                onClick={() => void start()}
                className="mx-auto mt-6 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm font-medium transition hover:bg-white/10"
              >
                <RefreshCw className="h-4 w-4" />
                Try again
              </button>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
