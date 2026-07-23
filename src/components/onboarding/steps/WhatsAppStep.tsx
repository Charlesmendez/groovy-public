"use client";

/**
 * WhatsAppStep — personal WhatsApp bridge + Kapso company WhatsApp setup.
 *
 * Extracted (behavior-preserving) from WelcomeOnboarding.tsx: render block was
 * lines 1369-1653, plus the Kapso billing-card machinery it used
 * (refreshBillingStatus 295-310, startCardSetup 352-383,
 * ensureCardBeforeProvisioning 385-399 [kapso path], startKapsoSetupLink
 * 490-513, handleCardSetupSuccess 515-529 [kapso path]).
 */

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertCircle, ArrowRight, Building2, CheckCircle2, Smartphone } from "lucide-react";
import { BillingCardSetupForm } from "@/components/billing/BillingCardSetupForm";
import { KAPSO_ALLOWLIST_PRICE_USD } from "@/lib/billing/pricing";
import { useEdition } from "@/hooks/useEdition";

export type WhatsAppMode = "personal" | "company" | "skip";

type WhatsAppStepProps = {
  connectorOnline: boolean;
  connectorMode?: "local" | "groovy";
  groovyMacReady?: boolean;
  personalWhatsAppConnected?: boolean;
  initialMode?: WhatsAppMode | null;
  /** Persist the selected mode (e.g. saveStep). */
  onModeChange?: (mode: WhatsAppMode) => void;
  onConfigureWhatsApp?: (groupName: string) => Promise<boolean>;
  onDisablePersonalWhatsApp?: () => Promise<boolean>;
  onBack?: () => void;
  onContinue: (mode: WhatsAppMode) => void;
  hideHeader?: boolean;
  title?: string;
  subtitle?: string;
};

export function WhatsAppStep({
  connectorOnline,
  connectorMode = "local",
  groovyMacReady = false,
  personalWhatsAppConnected = false,
  initialMode = null,
  onModeChange,
  onConfigureWhatsApp,
  onDisablePersonalWhatsApp,
  onBack,
  onContinue,
  hideHeader = false,
  title = "Step 3: Connect WhatsApp (optional)",
  subtitle = "Choose how your team chats with Groovy",
}: WhatsAppStepProps) {
  const edition = useEdition();
  const [whatsappMode, setWhatsappMode] = useState<WhatsAppMode | null>(initialMode);
  const [whatsappGroupName, setWhatsappGroupName] = useState("Groovy");
  const [whatsappConnecting, setWhatsappConnecting] = useState(false);
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [reconfigurePersonal, setReconfigurePersonal] = useState(false);
  const [kapsoSetupLinkUrl, setKapsoSetupLinkUrl] = useState<string | null>(null);
  const [billingCardOnFile, setBillingCardOnFile] = useState<boolean | null>(null);
  const [showCardSetup, setShowCardSetup] = useState(false);
  const [stripeSetupClientSecret, setStripeSetupClientSecret] = useState<string | null>(null);
  const [stripePublishableKey, setStripePublishableKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedWhatsAppMode =
    whatsappMode ?? (personalWhatsAppConnected ? "personal" : null);
  const effectiveWhatsAppMode =
    edition.selfHosted && selectedWhatsAppMode === "company"
      ? "skip"
      : selectedWhatsAppMode;

  const refreshBillingStatus = useCallback(async (): Promise<boolean | null> => {
    if (edition.selfHosted) return null;
    try {
      const res = await fetch("/api/billing/status", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBillingCardOnFile(null);
        return null;
      }
      const cardOnFile = json?.cardOnFile === true;
      setBillingCardOnFile(cardOnFile);
      return cardOnFile;
    } catch {
      setBillingCardOnFile(null);
      return null;
    }
  }, [edition.selfHosted]);

  useEffect(() => {
    if (edition.loading || edition.selfHosted) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/billing/status", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        setBillingCardOnFile(res.ok ? json?.cardOnFile === true : null);
      } catch {
        if (!cancelled) setBillingCardOnFile(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [edition.loading, edition.selfHosted]);

  const startCardSetup = useCallback(async (): Promise<boolean> => {
    if (edition.selfHosted) return false;
    setError(null);
    try {
      const res = await fetch("/api/billing/stripe/setup-intent", {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof json?.error === "string" ? json.error : "Failed to start card setup");
        return false;
      }
      const clientSecret =
        typeof json?.clientSecret === "string" && json.clientSecret.trim()
          ? json.clientSecret.trim()
          : "";
      const publishableKey =
        typeof json?.publishableKey === "string" && json.publishableKey.trim()
          ? json.publishableKey.trim()
          : "";
      if (!clientSecret || !publishableKey) {
        setError("Missing Stripe setup details from server.");
        return false;
      }
      setStripeSetupClientSecret(clientSecret);
      setStripePublishableKey(publishableKey);
      setShowCardSetup(true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start card setup");
      return false;
    }
  }, [edition.selfHosted]);

  const startKapsoSetupLink = useCallback(async (): Promise<boolean> => {
    if (edition.selfHosted) return false;
    const res = await fetch("/api/workspaces/company-whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setup_link" }),
    }).catch(() => null);
    if (!res) {
      setError("Failed to start Kapso setup");
      return false;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(typeof json?.error === "string" ? json.error : "Failed to start Kapso setup");
      return false;
    }
    if (json?.setupLinkUrl) {
      const setupUrl = String(json.setupLinkUrl);
      setKapsoSetupLinkUrl(setupUrl);
      window.open(setupUrl, "_blank");
      return true;
    }
    setError("Kapso setup link not available right now.");
    return false;
  }, [edition.selfHosted]);

  const ensureCardBeforeKapso = useCallback(async (): Promise<boolean> => {
    const cardOnFile = await refreshBillingStatus();
    if (cardOnFile === true) return true;
    await startCardSetup();
    return false;
  }, [refreshBillingStatus, startCardSetup]);

  const handleCardSetupSuccess = async () => {
    setShowCardSetup(false);
    setStripeSetupClientSecret(null);
    setStripePublishableKey(null);
    await refreshBillingStatus();
    await startKapsoSetupLink();
  };

  const selectMode = (mode: WhatsAppMode) => {
    setWhatsappMode(mode);
    onModeChange?.(mode);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="relative z-10"
    >
      {!hideHeader && (
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-white mb-2">{title}</h2>
          <p className="text-zinc-500 text-sm">{subtitle}</p>
          <p className="mt-2 text-xs text-amber-300">
            {edition.selfHosted
              ? "Personal WhatsApp requires creating a group first."
              : "Personal WhatsApp requires creating a group first. Kapso (Company WhatsApp) does not use groups."}
          </p>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid gap-4">
        <button
          type="button"
          onClick={() => selectMode("personal")}
          className={`p-5 rounded-2xl border text-left transition-all ${
            effectiveWhatsAppMode === "personal"
              ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
              : "bg-zinc-900/80 border-white/10 text-zinc-400 hover:border-white/20"
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center shrink-0">
              <Smartphone className="w-5 h-5 text-cyan-300" />
            </div>
            <div>
              <div className="text-sm font-medium text-white">Personal WhatsApp</div>
              <div className="text-xs text-zinc-500 mt-1">
                Supports <span className="text-white">groups + DMs</span>.{" "}
                {personalWhatsAppConnected
                  ? "Your existing WhatsApp Web session is connected."
                  : "Requires a one-time QR/code scan."}
              </div>
              {personalWhatsAppConnected ? (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-medium text-emerald-200">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  Existing connection detected
                </div>
              ) : (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-200">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  You must create a WhatsApp group first.
                </div>
              )}
              {connectorMode === "groovy" && !groovyMacReady && (
                <div className="text-[11px] text-amber-300 mt-2">
                  Groovy Mac must be ready before you can scan the QR.
                </div>
              )}
            </div>
          </div>
        </button>

        {effectiveWhatsAppMode === "personal" && (
          <div className="p-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 space-y-3">
            {personalWhatsAppConnected && !reconfigurePersonal ? (
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-emerald-100">
                      Your existing Personal WhatsApp is ready
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-emerald-100/70">
                      Groovy preserved your linked WhatsApp Web session and existing group binding.
                      Continue below—there is no need to create another group or scan a new QR code.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setWhatsappConnected(false);
                        setReconfigurePersonal(true);
                      }}
                      className="mt-3 text-xs text-zinc-400 underline underline-offset-2 transition-colors hover:text-white"
                    >
                      Reconnect or change group
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
            <div className="p-4 rounded-xl bg-amber-500/10 border-2 border-amber-500/40 space-y-2">
              <div className="flex items-center gap-2 text-amber-100">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <p className="text-base font-semibold">
                  Required before connecting Personal WhatsApp
                </p>
              </div>
              <p className="text-sm text-amber-100/95 leading-relaxed">
                Create a WhatsApp group on your phone first, then enter the exact group name below.
                Example: <span className="text-white font-medium">&quot;Groovy&quot;</span>. Add at
                least one contact so the group can be created (they can leave after).
              </p>
              <p className="text-xs text-amber-200/90">
                This requirement is only for <span className="font-medium">Personal WhatsApp</span>.
                {!edition.selfHosted ? (
                  <>
                    {" "}
                    <span className="font-medium">Kapso (Company WhatsApp) does not use groups.</span>
                  </>
                ) : null}
              </p>
            </div>
            <div>
              <label className="text-xs text-zinc-400 block mb-1">
                WhatsApp group name (exact, case-sensitive)
              </label>
              <input
                type="text"
                value={whatsappGroupName}
                onChange={(e) => setWhatsappGroupName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white text-sm focus:outline-none focus:border-cyan-500/40"
                placeholder="Groovy"
              />
            </div>
            {!connectorOnline ? (
              <div className="text-[11px] text-amber-300">
                Connector must be connected first. Complete step 1, then come back here.
              </div>
            ) : whatsappConnected ? (
              <div className="flex items-center gap-2 text-emerald-300 text-sm">
                <CheckCircle2 className="w-4 h-4" />
                WhatsApp connecting — scan the QR code in the window that opened on your machine.
              </div>
            ) : (
              <button
                type="button"
                disabled={!whatsappGroupName.trim() || whatsappConnecting}
                onClick={async () => {
                  if (!onConfigureWhatsApp) return;
                  setWhatsappConnecting(true);
                  const ok = await onConfigureWhatsApp(whatsappGroupName.trim());
                  setWhatsappConnecting(false);
                  if (ok) setWhatsappConnected(true);
                }}
                className="w-full px-4 py-2.5 rounded-xl bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 font-medium text-sm hover:bg-cyan-500/30 transition-all disabled:opacity-50"
              >
                {whatsappConnecting ? "Connecting..." : "Connect WhatsApp"}
              </button>
            )}
            <p className="text-[11px] text-zinc-500">
              This will open WhatsApp Web on your machine. Scan the QR code with your phone to link.
            </p>
              </>
            )}
          </div>
        )}

        {!edition.selfHosted ? (
          <>
        <button
          type="button"
          onClick={async () => {
            selectMode("company");
            setWhatsappConnected(false);
            // If the user switches to Kapso, disable personal WhatsApp on connector.
            if (onDisablePersonalWhatsApp) {
              try {
                await onDisablePersonalWhatsApp();
              } catch {
                // ignore; user can still continue with Kapso setup
              }
            }
          }}
          className={`p-5 rounded-2xl border text-left transition-all ${
            effectiveWhatsAppMode === "company"
              ? "bg-purple-500/15 border-purple-500/40 text-purple-200"
              : "bg-zinc-900/80 border-white/10 text-zinc-400 hover:border-white/20"
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center shrink-0">
              <Building2 className="w-5 h-5 text-purple-300" />
            </div>
            <div>
              <div className="text-sm font-medium text-white">Company WhatsApp (Kapso)</div>
              <div className="text-xs text-zinc-500 mt-1">
                We create a company number automatically.{" "}
                <span className="text-white">DMs only</span> (no groups).
              </div>
              <div className="text-[11px] text-amber-300 mt-2">
                Requires Meta (Facebook) Business access. If you don’t have a Business yet,
                Kapso/Meta will guide you to create one during setup.
              </div>
            </div>
          </div>
        </button>

        {effectiveWhatsAppMode === "company" && !kapsoSetupLinkUrl && (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-[12px] text-amber-200/90">
            You’ll be taken to Meta login. If you don’t have a Business Manager/WABA yet, the flow
            will guide you to create/select one and grant access.
          </div>
        )}
        {effectiveWhatsAppMode === "company" && (
          <div className="rounded-2xl border border-purple-500/20 bg-purple-500/5 p-4 text-[12px] text-purple-100/90">
            Pricing:{" "}
            <span className="text-white">
              ${KAPSO_ALLOWLIST_PRICE_USD} per allowlisted phone/month
            </span>
            . You control cost by how many numbers are in the DM allowlist.
            <div className="mt-1 text-[11px] text-zinc-400">
              Payment method:{" "}
              {billingCardOnFile === true ? (
                <span className="text-emerald-300">card on file</span>
              ) : billingCardOnFile === false ? (
                <span className="text-amber-300">required before setup</span>
              ) : (
                <span className="text-zinc-500">checking...</span>
              )}
            </div>
          </div>
        )}
        {effectiveWhatsAppMode === "company" && (
          <div className="rounded-2xl border border-white/10 bg-black/30 p-4 text-[12px] text-zinc-300">
            After setup, you must <span className="text-white">allowlist</span> the phone numbers
            that can DM this workspace (Settings → Company WhatsApp → DM allowlist). Team members
            can optionally <span className="text-white">verify</span> their number to map DMs to
            their user.
          </div>
        )}
        {showCardSetup && stripeSetupClientSecret && stripePublishableKey ? (
          <div className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-2">
            <div className="text-xs text-zinc-300">Add a card to continue with Kapso setup.</div>
            <BillingCardSetupForm
              clientSecret={stripeSetupClientSecret}
              publishableKey={stripePublishableKey}
              onError={(message) => setError(message || null)}
              onSuccess={handleCardSetupSuccess}
              onCancel={() => {
                setShowCardSetup(false);
                setStripeSetupClientSecret(null);
                setStripePublishableKey(null);
              }}
            />
          </div>
        ) : null}
        {effectiveWhatsAppMode === "company" && kapsoSetupLinkUrl && (
          <div className="rounded-2xl border border-purple-500/20 bg-purple-500/5 p-4 text-sm space-y-3">
            <div className="text-purple-200">
              Complete the Kapso setup in the new tab, then click &quot;I&apos;ve completed
              setup&quot; below.
            </div>
            <a
              href={kapsoSetupLinkUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-purple-200 underline"
            >
              Open setup link again
            </a>
          </div>
        )}
        {effectiveWhatsAppMode === "company" && kapsoSetupLinkUrl && (
          <button
            type="button"
            onClick={() => onContinue("company")}
            className="w-full px-5 py-3 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 font-medium text-sm hover:bg-emerald-500/30 transition-all"
          >
            I&apos;ve completed setup → Continue
          </button>
        )}
          </>
        ) : null}

        <button
          type="button"
          onClick={() => selectMode("skip")}
          className={`p-4 rounded-2xl border text-left transition-all ${
            effectiveWhatsAppMode === "skip"
              ? "bg-white/10 border-white/20 text-white"
              : "bg-black/30 border-white/10 text-zinc-400 hover:border-white/20"
          }`}
        >
          Skip for now
        </button>
      </div>

      <div className="flex items-center gap-3 mt-6">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="px-5 py-3 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-all"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={async () => {
            if (edition.selfHosted && effectiveWhatsAppMode === "company") {
              selectMode("skip");
              onContinue("skip");
              return;
            }
            if (effectiveWhatsAppMode === "company") {
              // Create setup link first - user must complete it before continuing
              if (!kapsoSetupLinkUrl) {
                const canProceed = await ensureCardBeforeKapso();
                if (!canProceed) return;
                await startKapsoSetupLink();
                return;
              }
              // If link exists but not opened, open it
              window.open(kapsoSetupLinkUrl, "_blank");
              return;
            }
            const mode = effectiveWhatsAppMode || "skip";
            onModeChange?.(mode);
            onContinue(mode);
          }}
          className="flex-1 px-5 py-3 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 transition-all flex items-center justify-center gap-2"
        >
          {effectiveWhatsAppMode === "company" ? (
            kapsoSetupLinkUrl ? (
              "Open Kapso Setup"
            ) : billingCardOnFile === false ? (
              "Add card + start Kapso setup"
            ) : (
              "Start Kapso Setup"
            )
          ) : (
            <>
              Continue
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    </motion.div>
  );
}
