"use client";

import { useCallback, useState } from "react";
import { AlertTriangle, ArrowRight, Clock3, CreditCard, Loader2, Sparkles } from "lucide-react";
import type { LicenseAccessStatus } from "@/hooks/useLicenseAccess";

function formatDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function LicenseAccessGate({
  status,
  loading,
  error,
  onStartTrial,
}: {
  status: LicenseAccessStatus | null;
  loading: boolean;
  error: string | null;
  onStartTrial: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"trial" | "checkout" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const startCheckout = useCallback(async () => {
    setBusy("checkout");
    setActionError(null);
    try {
      const res = await fetch("/api/licenses/personal/checkout", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || typeof json?.url !== "string") {
        throw new Error(json?.error || "Could not open checkout");
      }
      window.location.href = json.url;
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Could not open checkout");
      setBusy(null);
    }
  }, []);

  const activateTrial = useCallback(async () => {
    setBusy("trial");
    setActionError(null);
    try {
      await onStartTrial();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Could not start trial");
    } finally {
      setBusy(null);
    }
  }, [onStartTrial]);

  if (loading || !status || status.accessStatus === "licensed") return null;

  if (status?.accessStatus === "trial") {
    return (
      <div className="relative z-20 flex shrink-0 items-center justify-between gap-3 border-b border-cyan-400/15 bg-cyan-500/10 px-4 py-2 text-xs text-cyan-50">
        <div className="flex min-w-0 items-center gap-2">
          <Clock3 className="h-4 w-4 shrink-0 text-cyan-300" />
          <span className="truncate">
            <strong>Free trial:</strong> {status.trial?.daysRemaining || 1} day
            {status.trial?.daysRemaining === 1 ? "" : "s"} remaining
            {status.trial?.endsAt ? ` · ends ${formatDate(status.trial.endsAt)}` : ""}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void startCheckout()}
          disabled={busy === "checkout"}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-cyan-300 px-3 py-1.5 font-semibold text-zinc-950 hover:bg-cyan-200 disabled:opacity-60"
        >
          {busy === "checkout" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CreditCard className="h-3.5 w-3.5" />}
          Buy license
        </button>
      </div>
    );
  }

  const canStartTrial = status?.accessStatus === "trial_available";
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#07080b]/95 p-4 backdrop-blur-xl">
      <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-zinc-900 p-7 text-center shadow-2xl shadow-black/60">
        <div
          className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border ${
            canStartTrial
              ? "border-cyan-400/25 bg-cyan-500/10 text-cyan-300"
              : "border-amber-400/25 bg-amber-500/10 text-amber-300"
          }`}
        >
          {canStartTrial ? <Sparkles className="h-7 w-7" /> : <AlertTriangle className="h-7 w-7" />}
        </div>
        <h2 className="mt-5 text-2xl font-semibold text-white">
          {canStartTrial ? "Try Groovy free for 5 days" : "Your free trial has ended"}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-zinc-400">
          {canStartTrial
            ? "No credit card required. Your five days begin when you start the trial, with full access to agents, plans, Skills & Docs, and channels."
            : "Purchase a license to resume your orchestrator, worker agents, schedules, and channels. Your agents, configuration, plans, and history are still safe."}
        </p>

        {(actionError || error) && (
          <div className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-left text-xs text-red-200">
            {actionError || error}
          </div>
        )}

        <div className="mt-6 space-y-2">
          {canStartTrial && (
            <button
              type="button"
              onClick={() => void activateTrial()}
              disabled={busy !== null}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300 disabled:opacity-60"
            >
              {busy === "trial" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {busy === "trial" ? "Starting trial…" : "Start free trial"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void startCheckout()}
            disabled={busy !== null}
            className={`inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold disabled:opacity-60 ${
              canStartTrial
                ? "border border-white/10 text-zinc-200 hover:bg-white/5"
                : "bg-cyan-400 text-zinc-950 hover:bg-cyan-300"
            }`}
          >
            {busy === "checkout" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
            Buy Groovy Personal · $49.99/year
            <ArrowRight className="h-4 w-4" />
          </button>
          <a
            href="/enterprise"
            className="inline-flex w-full items-center justify-center rounded-xl px-4 py-2 text-xs text-zinc-500 hover:text-zinc-300"
          >
            Using Groovy for a company? Contact Enterprise Sales
          </a>
        </div>
      </div>
    </div>
  );
}
