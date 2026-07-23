"use client";

/**
 * LicenseStep — license purchase / status section.
 *
 * Extracted (behavior-preserving) from WelcomeOnboarding.tsx: render block was
 * lines 728-912, plus the supporting license state/handlers (types lines 30-42,
 * formatOnboardingDate 76-85, state 152-156, refreshLicenseStatus 312-327,
 * startPersonalCheckout 329-350). Self-contained: loads /api/licenses/status on
 * mount and drives Stripe checkout itself.
 */

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEdition } from "@/hooks/useEdition";

export type OnboardingLicenseStatus = {
  licensed?: boolean;
  status?: string;
  canManageLicense?: boolean;
  accessStatus?: "licensed" | "trial" | "trial_available" | "expired";
  hasAccess?: boolean;
  trial?: {
    status?: "not_started" | "active" | "expired";
    eligible?: boolean;
    startedAt?: string | null;
    endsAt?: string | null;
    daysRemaining?: number;
    durationDays?: number;
  };
  license?: {
    payload?: {
      license_type?: string;
      status?: string;
      valid_until?: string;
      max_devices?: number | null;
    };
  };
};

function formatOnboardingDate(value?: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

type LicenseStepProps = {
  /** Called when paid access or the free trial allows setup to continue. */
  onContinue: () => void;
  title?: string;
  subtitle?: string;
};

export function LicenseStep({
  onContinue,
  title = "Try Groovy free for 5 days",
  subtitle = "Explore the full agent harness before buying. No credit card is required; choose a license only if you want to keep using Groovy after your trial.",
}: LicenseStepProps) {
  const edition = useEdition();
  const [licenseStatus, setLicenseStatus] = useState<OnboardingLicenseStatus | null>(null);
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [trialLoading, setTrialLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const refreshLicenseStatus = useCallback(async () => {
    setLicenseLoading(true);
    setCheckoutError(null);
    try {
      const res = await fetch("/api/licenses/status", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as OnboardingLicenseStatus & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(
          typeof json?.error === "string"
            ? json.error
            : `Failed to load license (HTTP ${res.status})`
        );
      }
      setLicenseStatus(json);
    } catch (e) {
      setCheckoutError(e instanceof Error ? e.message : "Failed to load license");
    } finally {
      setLicenseLoading(false);
    }
  }, []);

  const startPersonalCheckout = useCallback(async () => {
    setCheckoutLoading(true);
    setCheckoutError(null);
    try {
      const res = await fetch("/api/licenses/personal/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent("/dashboard")}`;
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok || typeof json?.url !== "string") {
        throw new Error(typeof json?.error === "string" ? json.error : "Unable to start checkout");
      }
      window.location.href = json.url;
    } catch (e) {
      setCheckoutError(e instanceof Error ? e.message : "Unable to start checkout");
      setCheckoutLoading(false);
    }
  }, []);

  const startTrial = useCallback(async () => {
    setTrialLoading(true);
    setCheckoutError(null);
    try {
      const res = await fetch("/api/licenses/trial/start", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as OnboardingLicenseStatus & {
        error?: string;
      };
      if (!res.ok || json?.trial?.status !== "active") {
        throw new Error(json?.error || "Could not start your free trial");
      }
      setLicenseStatus((current) => ({ ...(current || {}), ...json }));
      onContinue();
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Could not start your free trial");
    } finally {
      setTrialLoading(false);
    }
  }, [onContinue]);

  useEffect(() => {
    if (edition.loading) return;
    if (edition.selfHosted) {
      onContinue();
      return;
    }
    refreshLicenseStatus().catch(() => {});
  }, [edition.loading, edition.selfHosted, onContinue, refreshLicenseStatus]);

  if (edition.loading || edition.selfHosted) {
    return (
      <div className="relative z-10 flex min-h-52 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-cyan-300" />
        <span className="ml-3 text-sm text-zinc-400">
          {edition.selfHosted ? "Self-hosted edition enabled" : "Loading edition…"}
        </span>
      </div>
    );
  }

  const activeLicensePayload = licenseStatus?.license?.payload;
  const hasActiveLicense = Boolean(licenseStatus?.licensed && activeLicensePayload);
  const trial = licenseStatus?.trial;
  const trialActive = trial?.status === "active";
  const trialAvailable = trial?.status === "not_started" && trial?.eligible === true;
  const trialExpired = trial?.status === "expired" || licenseStatus?.accessStatus === "expired";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="relative z-10"
    >
      <div className="text-center mb-8">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-500/20 bg-cyan-500/10">
          <Sparkles className="h-7 w-7 text-cyan-300" />
        </div>
        <h2 className="text-2xl font-semibold text-white mb-2">{title}</h2>
        <p className="mx-auto max-w-xl text-sm leading-relaxed text-zinc-500">{subtitle}</p>
      </div>

      {checkoutError ? (
        <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">
          {checkoutError}
        </div>
      ) : null}

      {hasActiveLicense ? (
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-100">
                <ShieldCheck className="h-4 w-4" />
                License found
              </div>
              <div className="mt-2 text-lg font-semibold text-white">
                {activeLicensePayload?.license_type === "personal"
                  ? "Groovy Personal"
                  : activeLicensePayload?.license_type || "Groovy License"}
              </div>
              <p className="mt-1 text-sm text-emerald-100/80">
                Status: {activeLicensePayload?.status || licenseStatus?.status || "active"} · Valid
                until {formatOnboardingDate(activeLicensePayload?.valid_until)}
              </p>
              <p className="mt-2 text-xs text-emerald-100/70">
                You can manage your license key, devices, downloads, source snapshots, and Stripe
                billing from the account portal.
              </p>
            </div>
            <a
              href="/account/license"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-400/30 px-4 py-2 text-sm font-medium text-emerald-100 hover:bg-emerald-400/10"
            >
              Open license
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          <button
            type="button"
            onClick={onContinue}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-400 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300 sm:w-auto"
          >
            Continue setup
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div
            className={`rounded-2xl border p-6 ${
              trialExpired
                ? "border-amber-400/30 bg-amber-500/10"
                : "border-cyan-400/30 bg-gradient-to-br from-cyan-500/15 to-violet-500/10"
            }`}
          >
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-cyan-100">
                  <Sparkles className="h-4 w-4" />
                  {trialActive
                    ? "Your free trial is active"
                    : trialExpired
                      ? "Your free trial has ended"
                      : "5-day free trial"}
                </div>
                <h3 className="mt-2 text-2xl font-semibold text-white">
                  {trialActive
                    ? `${trial?.daysRemaining || 1} day${trial?.daysRemaining === 1 ? "" : "s"} remaining`
                    : trialExpired
                      ? "Choose a license to continue"
                      : "Use Groovy free — no credit card"}
                </h3>
                <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-300">
                  {trialActive
                    ? `You have full product access until ${formatOnboardingDate(trial?.endsAt)}. We’ll keep the remaining time visible in the dashboard.`
                    : trialExpired
                      ? "Your agents and orchestrator are paused. Your configuration and history are safe and return immediately after purchase."
                      : "Create agents, plan projects, execute tasks, and connect channels. The trial starts only when you click below."}
                </p>
              </div>
              {trialActive ? (
                <button
                  type="button"
                  onClick={onContinue}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-cyan-400 px-5 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300"
                >
                  Continue setup <ArrowRight className="h-4 w-4" />
                </button>
              ) : trialAvailable ? (
                <button
                  type="button"
                  onClick={startTrial}
                  disabled={trialLoading}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-cyan-400 px-5 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300 disabled:opacity-60"
                >
                  {trialLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {trialLoading ? "Starting trial…" : "Start free trial"}
                </button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-cyan-500/25 bg-cyan-500/10 p-5">
            <div className="text-xs uppercase tracking-wider text-cyan-200/80">Personal</div>
            <h3 className="mt-2 text-xl font-semibold text-white">Groovy Personal</h3>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-3xl font-semibold text-white">$49.99</span>
              <span className="text-sm text-zinc-400">per year</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-zinc-300">
              For one individual using Groovy on personal, non-commercial projects.
            </p>
            <ul className="mt-4 space-y-2 text-sm text-zinc-300">
              {[
                "1 personal user",
                "2 activated devices",
                "Downloads and current source while active",
                "Bring your own OpenAI, Anthropic, Google, Azure, Bedrock, Groq, or Mistral keys",
              ].map((item) => (
                <li key={item} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 flex-none text-cyan-300" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={startPersonalCheckout}
              disabled={checkoutLoading}
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-400 px-4 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {checkoutLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {checkoutLoading ? "Opening Checkout..." : "Buy Personal"}
            </button>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
            <div className="text-xs uppercase tracking-wider text-zinc-500">Company use</div>
            <h3 className="mt-2 text-xl font-semibold text-white">Groovy Enterprise</h3>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              Use this path for employers, teams, client work, revenue-generating projects, private
              deployments, source access terms, or reseller rights.
            </p>
            <ul className="mt-4 space-y-2 text-sm text-zinc-300">
              {[
                "Commercial license by agreement",
                "Self-hosting and internal modification rights",
                "Optional source snapshots and support",
                "Reseller billing only when explicitly authorized",
              ].map((item) => (
                <li key={item} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 flex-none text-zinc-400" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <a
              href="/enterprise"
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-4 py-3 text-sm font-semibold text-white hover:bg-white/10"
            >
              Contact Sales
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
          </div>
        </div>
      )}

      <div className="mt-5 rounded-2xl border border-white/10 bg-black/30 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-medium text-white">Already paid?</div>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              Refresh the license status or open the account portal to see your key, devices,
              downloads, billing, and source snapshots.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={refreshLicenseStatus}
              disabled={licenseLoading}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10 disabled:opacity-60"
            >
              {licenseLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Refresh
            </button>
            <a
              href="/account/license"
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10"
            >
              Account portal
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </div>

    </motion.div>
  );
}
