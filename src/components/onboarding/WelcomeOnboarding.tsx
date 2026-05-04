"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Sparkles, Key, Check, Eye, EyeOff, ExternalLink, Loader2, ArrowRight,
  CheckCircle2, Download, WifiOff, MessageSquare, Send,
  RefreshCw, AlertCircle, Building2, Smartphone, Server, Terminal, Copy
} from "lucide-react";
import { BillingCardSetupForm } from "@/components/billing/BillingCardSetupForm";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";
import {
  GROOVY_MAC_MIN_SEATS,
  GROOVY_MAC_SEAT_PRICE_USD,
  KAPSO_ALLOWLIST_PRICE_USD,
} from "@/lib/billing/pricing";
import {
  readConnectorPlatformOverride,
  writeConnectorPlatformOverride,
  type ConnectorPlatformOverride,
} from "@/lib/connector/override";
import { detectConnectorPlatformFromNavigator, type ConnectorClientPlatform } from "@/lib/connector/platform";

type Provider = "anthropic" | "openai" | "google";
type LlmKeyMode = "groovy" | "user";
type OnboardingStep = "welcome" | "connector" | "whatsapp" | "telegram" | "api_keys" | "chat_agent" | "claude_cli" | "done";
type PendingPaidAction = "groovy_mac" | "kapso";

const PROVIDER_INFO: Record<Provider, { name: string; placeholder: string; helpUrl: string; description: string }> = {
  anthropic: {
    name: "Anthropic",
    placeholder: "sk-ant-...",
    helpUrl: "https://console.anthropic.com/settings/keys",
    description: "Claude models",
  },
  openai: {
    name: "OpenAI",
    placeholder: "sk-...",
    helpUrl: "https://platform.openai.com/api-keys",
    description: "GPT models",
  },
  google: {
    name: "Google",
    placeholder: "AIza...",
    helpUrl: "https://aistudio.google.com/app/apikey",
    description: "Gemini models",
  },
};

// Step configuration for progress
const STEPS: { id: OnboardingStep; label: string; number: number }[] = [
  { id: "connector", label: "Connector", number: 1 },
  { id: "whatsapp", label: "WhatsApp", number: 2 },
  { id: "telegram", label: "Telegram", number: 3 },
  { id: "api_keys", label: "API Keys", number: 4 },
  { id: "chat_agent", label: "Quick Win", number: 5 },
  { id: "claude_cli", label: "Claude CLI", number: 6 },
];

type WelcomeOnboardingProps = {
  initialStep?: OnboardingStep;
  connectorOnline: boolean;
  pairingRebindFromDeviceId?: string | null;
  onRefreshConnector: () => void;
  onConnectorModeChanged?: (next: "local" | "groovy") => void | Promise<void>;
  onConfigureWhatsApp?: (groupName: string) => Promise<boolean>;
  onDisablePersonalWhatsApp?: () => Promise<boolean>;
  onSaveApiKeys: (keys: Partial<Record<Provider, string>>, mode: LlmKeyMode) => Promise<void>;
  onCreateChatAgent: () => void;
  chatAgentCount: number;
  onComplete: () => void;
};

export function WelcomeOnboarding({ 
  initialStep,
  connectorOnline,
  pairingRebindFromDeviceId = null,
  onRefreshConnector,
  onConnectorModeChanged,
  onConfigureWhatsApp,
  onDisablePersonalWhatsApp,
  onSaveApiKeys,
  onCreateChatAgent,
  chatAgentCount,
  onComplete,
}: WelcomeOnboardingProps) {
  const connectorGuide = useConnectorInstallGuide();
  const [step, setStep] = useState<OnboardingStep>(initialStep || "welcome");
  const [selectedMode, setSelectedMode] = useState<LlmKeyMode | null>(null);
  const [connectorMode, setConnectorMode] = useState<"local" | "groovy">("local");
  const [workspaceRole, setWorkspaceRole] = useState<"admin" | "member" | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [workspaceHasGroovyMac, setWorkspaceHasGroovyMac] = useState<boolean | null>(null);
  const [autoSelectedGroovyMac, setAutoSelectedGroovyMac] = useState(false);
  const didAutoDefaultConnectorModeRef = useRef(false);
  const hasSavedConnectorModeRef = useRef(false);
  const [groovyMacRequest, setGroovyMacRequest] = useState<{
    id: string;
    status: string;
    status_detail?: string | null;
    device_online?: boolean;
    device_last_seen?: string | null;
  } | null>(null);
  const [groovyMacLoading, setGroovyMacLoading] = useState(false);
  const [whatsappMode, setWhatsappMode] = useState<"personal" | "company" | "skip" | null>(null);
  const [whatsappGroupName, setWhatsappGroupName] = useState("Groovy");
  const [whatsappConnecting, setWhatsappConnecting] = useState(false);
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [telegramMode, setTelegramMode] = useState<"connect" | "skip" | null>(null);
  const [telegramBotTokenInput, setTelegramBotTokenInput] = useState("");
  const [telegramConnecting, setTelegramConnecting] = useState(false);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [telegramBotUsername, setTelegramBotUsername] = useState<string | null>(null);
  const [kapsoSetupLinkUrl, setKapsoSetupLinkUrl] = useState<string | null>(null);
  const [workspaceMemberCount, setWorkspaceMemberCount] = useState(1);
  const [billingCardOnFile, setBillingCardOnFile] = useState<boolean | null>(null);
  const [showCardSetup, setShowCardSetup] = useState(false);
  const [stripeSetupClientSecret, setStripeSetupClientSecret] = useState<string | null>(null);
  const [stripePublishableKey, setStripePublishableKey] = useState<string | null>(null);
  const [pendingPaidAction, setPendingPaidAction] = useState<PendingPaidAction | null>(null);
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [showKeys, setShowKeys] = useState<Partial<Record<Provider, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!!initialStep);
  const [refreshingConnector, setRefreshingConnector] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingCopied, setPairingCopied] = useState(false);
  const [platformOverride, setPlatformOverride] = useState<ConnectorPlatformOverride>("auto");
  const [detectedPlatform, setDetectedPlatform] = useState<ConnectorClientPlatform>("unknown");
  const groovyMacReady =
    groovyMacRequest?.status === "ready" || groovyMacRequest?.status === "connector_online";
  const groovyMacBilledSeats = Math.max(GROOVY_MAC_MIN_SEATS, workspaceMemberCount);
  const groovyMacEstimatedMonthlyUsd = groovyMacBilledSeats * GROOVY_MAC_SEAT_PRICE_USD;

  // Load saved step from API on mount
  useEffect(() => {
    if (initialStep) return;
    
    (async () => {
      try {
        const res = await fetch("/api/user-preferences");
        const json = await res.json().catch(() => ({}));
        const validSteps: OnboardingStep[] = ["welcome", "connector", "whatsapp", "telegram", "api_keys", "chat_agent", "claude_cli", "done"];
        if (json.onboardingStep && validSteps.includes(json.onboardingStep)) {
          setStep(json.onboardingStep);
          // Restore saved data
        if (json.onboardingData?.apiKeyMode) {
            setSelectedMode(json.onboardingData.apiKeyMode);
          }
        if (json.onboardingData?.connectorMode) {
          setConnectorMode(json.onboardingData.connectorMode as "local" | "groovy");
          hasSavedConnectorModeRef.current = true;
        }
        if (json.onboardingData?.whatsappMode) {
          setWhatsappMode(json.onboardingData.whatsappMode as "personal" | "company" | "skip");
        }
        }
      } catch {
        // ignore
      } finally {
        setLoaded(true);
      }
    })();
  }, [initialStep]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refreshPlatform = () => {
      setPlatformOverride(readConnectorPlatformOverride());
      setDetectedPlatform(detectConnectorPlatformFromNavigator(window.navigator));
    };
    refreshPlatform();
    const onOverrideChanged = () => refreshPlatform();
    window.addEventListener("groovy:connector:platformOverrideChanged", onOverrideChanged);
    return () => {
      window.removeEventListener("groovy:connector:platformOverrideChanged", onOverrideChanged);
    };
  }, []);

  // Load workspace info (used to clarify Groovy Mac permissions)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/workspaces/current", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.workspace) {
          setWorkspaceRole(json.workspace.role === "admin" ? "admin" : "member");
          setWorkspaceName(typeof json.workspace.name === "string" ? json.workspace.name : null);
          const memberCount = Array.isArray(json.workspace.members) ? json.workspace.members.length : 0;
          setWorkspaceMemberCount(memberCount > 0 ? memberCount : 1);
        }

        // Also load Groovy Mac availability for this workspace (for clear onboarding defaults/messages).
        const hmRes = await fetch("/api/hosted-macs/request", { cache: "no-store" });
        const hmJson = await hmRes.json().catch(() => ({}));
        if (hmRes.ok) {
          const status = typeof hmJson?.request?.status === "string" ? String(hmJson.request.status) : "";
          const hasDeviceId = typeof hmJson?.device?.device_id === "string" && !!hmJson.device.device_id;
          const hasGroovyMac = hasDeviceId || status === "ready" || status === "connector_online";
          setWorkspaceHasGroovyMac(hasGroovyMac);

          if (hmJson?.request?.id) {
            setGroovyMacRequest({
              id: String(hmJson.request.id),
              status: String(hmJson.request.status || ""),
              status_detail:
                typeof hmJson.request.status_detail === "string" ? hmJson.request.status_detail : null,
              device_online: Boolean(hmJson.device?.online),
              device_last_seen: hmJson.device?.last_seen ? String(hmJson.device.last_seen) : null,
            });
          } else {
            setGroovyMacRequest(null);
          }
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  // Invited members: if workspace already has a Groovy Mac, default to it (user can switch explicitly).
  useEffect(() => {
    if (!loaded) return;
    if (hasSavedConnectorModeRef.current) return;
    if (didAutoDefaultConnectorModeRef.current) return;
    if (workspaceRole !== "member") return;
    if (workspaceHasGroovyMac !== true) return;

    didAutoDefaultConnectorModeRef.current = true;
    setAutoSelectedGroovyMac(true);
    setConnectorMode("groovy");
    // Persist the default so dashboards/settings stay consistent.
    fetch("/api/user-preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingData: { connectorMode: "groovy" } }),
    }).catch(() => {});
    hasSavedConnectorModeRef.current = true;
    try {
      onConnectorModeChanged?.("groovy");
    } catch {
      // ignore
    }
  }, [loaded, workspaceRole, workspaceHasGroovyMac, onConnectorModeChanged]);

  // Save step to API
  const saveStep = useCallback(async (newStep: OnboardingStep, data?: Record<string, unknown>) => {
    try {
      await fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          onboardingStep: newStep,
          onboardingData: data,
        }),
      });
    } catch {
      // ignore
    }
  }, []);

  const refreshBillingStatus = useCallback(async (): Promise<boolean | null> => {
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
  }, []);

  const startCardSetup = useCallback(async (): Promise<boolean> => {
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
  }, []);

  const ensureCardBeforeProvisioning = useCallback(
    async (action: PendingPaidAction): Promise<boolean> => {
      const cardOnFile = await refreshBillingStatus();
      if (cardOnFile === true) {
        return true;
      }
      setPendingPaidAction(action);
      const started = await startCardSetup();
      if (!started) {
        setPendingPaidAction(null);
      }
      return false;
    },
    [refreshBillingStatus, startCardSetup]
  );

  useEffect(() => {
    if (!loaded) return;
    refreshBillingStatus().catch(() => {});
  }, [loaded, refreshBillingStatus]);

  // Auto-advance from welcome
  useEffect(() => {
    if (!loaded) return;
    if (step === "welcome") {
      const t = setTimeout(() => {
        setStep("connector");
        saveStep("connector");
      }, 2500);
      return () => clearTimeout(t);
    }
  }, [step, loaded, saveStep]);

  const handleRefreshConnector = async () => {
    setRefreshingConnector(true);
    onRefreshConnector();
    // Wait a bit for the connector status to update
    await new Promise(r => setTimeout(r, 2000));
    setRefreshingConnector(false);
  };

  const refreshGroovyMacRequest = async () => {
    setGroovyMacLoading(true);
    try {
      const res = await fetch("/api/hosted-macs/request", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.request) {
        const status = typeof json?.request?.status === "string" ? String(json.request.status) : "";
        const hasDeviceId = typeof json?.device?.device_id === "string" && !!json.device.device_id;
        const hasGroovyMac = hasDeviceId || status === "ready" || status === "connector_online";
        setWorkspaceHasGroovyMac(hasGroovyMac);
        setGroovyMacRequest({
          id: json.request.id,
          status: json.request.status,
          status_detail: json.request.status_detail || null,
          device_online: Boolean(json.device?.online),
          device_last_seen: json.device?.last_seen ? String(json.device.last_seen) : null,
        });
      } else if (res.ok) {
        setWorkspaceHasGroovyMac(false);
        setGroovyMacRequest(null);
      }
    } finally {
      setGroovyMacLoading(false);
    }
  };

  const requestGroovyMacCore = async () => {
    setGroovyMacLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hosted-macs/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to request Groovy Mac");
      if (json.request) {
        setGroovyMacRequest({
          id: json.request.id,
          status: json.request.status,
          status_detail: json.request.status_detail || null,
          device_online: Boolean(json.device?.online),
          device_last_seen: json.device?.last_seen ? String(json.device.last_seen) : null,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to request Groovy Mac");
    } finally {
      setGroovyMacLoading(false);
    }
  };

  const requestGroovyMac = async () => {
    const canProceed = await ensureCardBeforeProvisioning("groovy_mac");
    if (!canProceed) return;
    await requestGroovyMacCore();
  };

  const startKapsoSetupLink = async (): Promise<boolean> => {
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
  };

  const handleCardSetupSuccess = async () => {
    const action = pendingPaidAction;
    setPendingPaidAction(null);
    setShowCardSetup(false);
    setStripeSetupClientSecret(null);
    setStripePublishableKey(null);
    await refreshBillingStatus();
    if (action === "groovy_mac") {
      await requestGroovyMacCore();
      return;
    }
    if (action === "kapso") {
      await startKapsoSetupLink();
    }
  };

  const generatePairingCode = async () => {
    setPairingLoading(true);
    try {
      const res = await fetch("/api/devices/pairing-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          pairingRebindFromDeviceId ? { rebindFromDeviceId: pairingRebindFromDeviceId } : {}
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to generate code");
      setPairingCode(String(json.code || ""));
    } catch (err) {
      console.error("Failed to generate pairing code:", err);
    } finally {
      setPairingLoading(false);
    }
  };

  const copyPairingCode = async () => {
    if (!pairingCode) return;
    await navigator.clipboard.writeText(pairingCode);
    setPairingCopied(true);
    setTimeout(() => setPairingCopied(false), 1500);
  };

  const setPlatformOverridePreference = (next: ConnectorPlatformOverride) => {
    setPlatformOverride(next);
    writeConnectorPlatformOverride(next);
  };

  const goToStep = (newStep: OnboardingStep, data?: Record<string, unknown>) => {
    setStep(newStep);
    saveStep(newStep, data);
    setError(null);
  };

  useEffect(() => {
    if (connectorMode === "groovy") {
      refreshGroovyMacRequest().catch(() => {});
    }
  }, [connectorMode]);

  // When using Groovy Mac, auto-refresh status in the background so the user
  // sees "online/offline" without manual refresh.
  useEffect(() => {
    if (connectorMode !== "groovy") return;
    if (!groovyMacRequest?.id) return;
    const t = setInterval(() => {
      refreshGroovyMacRequest().catch(() => {});
    }, 10_000);
    return () => clearInterval(t);
  }, [connectorMode, groovyMacRequest?.id]);

  const handleApiModeSelect = async (mode: LlmKeyMode) => {
    setSelectedMode(mode);
    if (mode === "groovy") {
      // Save immediately and move on
      setSaving(true);
      try {
        await onSaveApiKeys({}, mode);
        goToStep("chat_agent", { apiKeyMode: mode });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save");
      } finally {
        setSaving(false);
      }
    }
    // If "user" mode, they'll fill in keys and click continue
  };

  const handleApiKeysSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      const keysToSave = Object.fromEntries(
        Object.entries(keys).filter(([, v]) => v && v.trim())
      );
      await onSaveApiKeys(keysToSave, "user");
      goToStep("chat_agent", { apiKeyMode: "user" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleFinish = async () => {
    setSaving(true);
    try {
      await fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboardingCompleted: true }),
      });
      onComplete();
    } catch {
      onComplete(); // Still complete even if API fails
    }
  };

  const hasAtLeastOneKey = Object.values(keys).some((v) => v && v.trim());
  const currentStepIndex = STEPS.findIndex((s) => s.id === step);

  if (!loaded) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950">
        <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950 overflow-y-auto">
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/5 via-transparent to-purple-500/5 pointer-events-none" />
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Progress - show after welcome */}
      {step !== "welcome" && step !== "done" && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-20">
          <div className="flex items-center gap-1">
            {STEPS.map((s, i) => {
              const isActive = s.id === step;
              const isCompleted = i < currentStepIndex;
              return (
                <div key={s.id} className="flex items-center">
                  {i > 0 && (
                    <div className={`w-12 h-0.5 transition-colors ${isCompleted ? "bg-cyan-500" : "bg-zinc-700"}`} />
                  )}
                  <div className="flex flex-col items-center gap-1">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium transition-all ${
                        isActive
                          ? "bg-cyan-500 text-black"
                          : isCompleted
                            ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                            : "bg-zinc-800 text-zinc-500 border border-zinc-700"
                      }`}
                    >
                      {isCompleted ? <Check className="w-4 h-4" /> : s.number}
                    </div>
                    <span className={`text-[10px] whitespace-nowrap ${isActive ? "text-white" : "text-zinc-500"}`}>
                      {s.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="relative min-h-screen w-full flex items-center justify-center px-6 py-24">
        <div className="w-full max-w-3xl">
          <AnimatePresence mode="wait">
          {/* Welcome Step */}
          {step === "welcome" && (
            <motion.div
              key="welcome"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="text-center relative z-10"
            >
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.2 }}
                className="w-20 h-20 mx-auto mb-8 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-cyan-500/5 border border-cyan-500/20 flex items-center justify-center"
              >
                <Sparkles className="w-10 h-10 text-cyan-400" />
              </motion.div>
              <motion.h1
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="text-3xl font-semibold text-white mb-4"
              >
                Welcome to Groovy
              </motion.h1>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.6 }}
                className="text-zinc-400 text-lg"
              >
                We are committed to making your onboarding as smooth as possible.
              </motion.p>
            </motion.div>
          )}

          {/* Step 1: Connector */}
          {step === "connector" && (
            <motion.div
              key="connector"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="relative z-10"
            >
              <div className="text-center mb-8">
                <h2 className="text-2xl font-semibold text-white mb-2">
                  Step 1: Install Groovy Connector
                </h2>
                <p className="text-zinc-500 text-sm">
                  Choose where Groovy runs tools (Browser/Files/Code)
                </p>
              </div>

              <div className="grid md:grid-cols-[1fr,280px] gap-4">
                {/* Left: Mode + Instructions */}
                <div className="bg-zinc-900/80 border border-white/10 rounded-2xl p-6 space-y-5">
                  {workspaceRole === "member" && (
                    <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                      <div className="text-[10px] text-zinc-400 uppercase tracking-wider">Team workspace</div>
                      <div className="text-sm text-white font-medium mt-1">
                        You were invited to {workspaceName ? workspaceName : "a workspace"}.
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                        {workspaceHasGroovyMac === true ? (
                          <>
                            This workspace has a shared <span className="text-zinc-300">Groovy Mac</span>.{" "}
                            {connectorMode === "groovy" ? (
                              <>
                                {autoSelectedGroovyMac ? "We selected it by default" : "It’s selected"}.
                                {" "}You can switch to <span className="text-zinc-300">Local</span> if you want to use
                                your own computer.
                              </>
                            ) : (
                              <>
                                You&apos;re currently set to <span className="text-zinc-300">Local</span>. You can switch
                                to <span className="text-zinc-300">Groovy Mac</span> if you want the shared connector.
                              </>
                            )}
                          </>
                        ) : workspaceHasGroovyMac === false ? (
                          <>
                            This workspace doesn&apos;t have a Groovy Mac yet, so <span className="text-zinc-300">Local</span>{" "}
                            is selected. Ask your admin if you want a shared Groovy Mac for the team.
                          </>
                        ) : (
                          <>Checking your workspace connector…</>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setConnectorMode("local");
                        setAutoSelectedGroovyMac(false);
                        saveStep("connector", { connectorMode: "local" });
                        try {
                          onConnectorModeChanged?.("local");
                        } catch {
                          // ignore
                        }
                      }}
                      className={`p-4 rounded-2xl border text-left transition-all ${
                        connectorMode === "local"
                          ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
                          : "bg-black/30 border-white/10 text-zinc-400 hover:border-white/20"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Smartphone className="w-4 h-4" />
                        <span className="text-sm font-medium">
                          {connectorGuide.platform === "windows" ? "Your Windows PC" : "Your Mac"}
                        </span>
                      </div>
                      <div className="text-[11px] mt-1 opacity-80">
                        Install connector locally. Fastest setup.
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConnectorMode("groovy");
                        setAutoSelectedGroovyMac(false);
                        saveStep("connector", { connectorMode: "groovy" });
                        try {
                          onConnectorModeChanged?.("groovy");
                        } catch {
                          // ignore
                        }
                      }}
                      className={`p-4 rounded-2xl border text-left transition-all ${
                        connectorMode === "groovy"
                          ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
                          : "bg-black/30 border-white/10 text-zinc-400 hover:border-white/20"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Server className="w-4 h-4" />
                        <span className="text-sm font-medium">Groovy Mac</span>
                        {autoSelectedGroovyMac && workspaceRole === "member" && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-200">
                            Default
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] mt-1 opacity-80">
                        We provision a Mac for your workspace.
                      </div>
                    </button>
                  </div>

                  {connectorMode === "groovy" ? (
                    <div className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-3">
                      <div className="text-sm text-white font-medium">Groovy Mac request</div>
                      <div className="text-xs text-zinc-500">
                        We&apos;ll provision a dedicated Mac for your workspace{workspaceName ? ` (${workspaceName})` : ""}.
                        This can take up to 1 hour.
                      </div>
                      <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 text-[11px] text-cyan-100/90">
                        Pricing: <span className="text-white">${GROOVY_MAC_SEAT_PRICE_USD} per workspace member/month</span> with a{" "}
                        <span className="text-white">minimum of {GROOVY_MAC_MIN_SEATS} seats</span>. Your workspace has{" "}
                        <span className="text-white">{workspaceMemberCount}</span> member
                        {workspaceMemberCount === 1 ? "" : "s"}, so current billed seats are{" "}
                        <span className="text-white">{groovyMacBilledSeats}</span> (~$
                        {groovyMacEstimatedMonthlyUsd}/month).
                      </div>
                      <div className="text-[11px] text-zinc-500">
                        Payment method:{" "}
                        {billingCardOnFile === true ? (
                          <span className="text-emerald-300">card on file</span>
                        ) : billingCardOnFile === false ? (
                          <span className="text-amber-300">required before provisioning</span>
                        ) : (
                          <span className="text-zinc-400">checking...</span>
                        )}
                      </div>
                      {groovyMacRequest ? (
                        <div className="text-xs text-cyan-200">
                          Status: <span className="text-white">{groovyMacRequest.status}</span>
                          {groovyMacRequest.status_detail ? ` · ${groovyMacRequest.status_detail}` : ""}
                          {typeof groovyMacRequest.device_online === "boolean" && (
                            <>
                              {" "}
                              · Connector:{" "}
                              <span className={groovyMacRequest.device_online ? "text-emerald-300" : "text-zinc-400"}>
                                {groovyMacRequest.device_online ? "online" : "offline"}
                              </span>
                            </>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs text-zinc-500">
                          {workspaceRole === "admin"
                            ? "No request yet."
                            : "No Groovy Mac requested yet. Ask your workspace admin."}
                        </div>
                      )}
                      <div className="flex gap-2">
                        {workspaceRole === "admin" ? (
                          <button
                            type="button"
                            onClick={requestGroovyMac}
                            disabled={groovyMacLoading || !!groovyMacRequest}
                            className="px-3 py-2 rounded-xl bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 text-xs disabled:opacity-50"
                          >
                            {groovyMacRequest
                              ? "Requested"
                              : billingCardOnFile === false
                                ? "Add card + request"
                                : "Request Groovy Mac"}
                          </button>
                        ) : (
                          <div className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-zinc-400 text-xs">
                            Only admins can request a Groovy Mac.
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={refreshGroovyMacRequest}
                          disabled={groovyMacLoading}
                          className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-zinc-300 text-xs"
                        >
                          {groovyMacLoading ? "Checking…" : "Refresh"}
                        </button>
                      </div>
                      <div className="text-[11px] text-zinc-500">
                        When it&apos;s ready, it will show as <span className="text-zinc-300">Connector: online</span>{" "}
                        here and in Settings.
                      </div>
                      {showCardSetup &&
                      pendingPaidAction === "groovy_mac" &&
                      stripeSetupClientSecret &&
                      stripePublishableKey ? (
                        <div className="rounded-xl border border-white/10 bg-black/30 p-3 space-y-2">
                          <div className="text-xs text-zinc-300">
                            Add a card to continue with Groovy Mac provisioning.
                          </div>
                          <BillingCardSetupForm
                            clientSecret={stripeSetupClientSecret}
                            publishableKey={stripePublishableKey}
                            onError={(message) => setError(message || null)}
                            onSuccess={handleCardSetupSuccess}
                            onCancel={() => {
                              setShowCardSetup(false);
                              setPendingPaidAction(null);
                              setStripeSetupClientSecret(null);
                              setStripePublishableKey(null);
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <>
                  <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="text-[11px] text-zinc-400 mb-2">Install guide platform</div>
                    <div className="flex flex-wrap gap-2">
                      {(["auto", "macos", "windows"] as ConnectorPlatformOverride[]).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setPlatformOverridePreference(p)}
                          className={`px-2.5 py-1.5 rounded-lg border text-[11px] transition-all ${
                            platformOverride === p
                              ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
                              : "bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10"
                          }`}
                        >
                          {p === "auto" ? "Auto" : p === "macos" ? "macOS" : "Windows"}
                        </button>
                      ))}
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-2">
                      Detected:{" "}
                      <span className="text-zinc-300">
                        {detectedPlatform === "unknown"
                          ? "unknown"
                          : detectedPlatform === "macos"
                            ? "macOS"
                            : "Windows"}
                      </span>
                    </div>
                  </div>

                  {/* Step 1: Download */}
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-cyan-500 text-black flex items-center justify-center text-sm font-bold shrink-0">
                      1
                    </div>
                    <div className="flex-1 pt-1">
                      <h3 className="text-sm font-medium text-white mb-2">Download the app</h3>
                      <a
                        href={connectorGuide.downloadUrl}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cyan-500 text-black font-medium hover:bg-cyan-400 transition-colors text-sm"
                      >
                        <Download className="w-4 h-4" />
                        {connectorGuide.ctaLabel}
                      </a>
                    </div>
                  </div>

                  {/* Step 2: Install */}
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-zinc-700 text-white flex items-center justify-center text-sm font-bold shrink-0">
                      2
                    </div>
                    <div className="flex-1 pt-1">
                      <h3 className="text-sm font-medium text-white mb-1">Install it</h3>
                      <p className="text-xs text-zinc-400 leading-relaxed mb-2">
                        {connectorGuide.platform === "windows"
                          ? "Run the installer, then open Groovy Connector from your Start Menu."
                          : "Open the downloaded file and drag the app to your Applications folder. Then open it from Applications."}
                      </p>
                      {connectorGuide.platform !== "windows" && (
                        <div className="text-[11px] text-zinc-500 mb-2">
                          After installing, <span className="text-zinc-300">eject “Groovy Connector”</span> from Finder (it’s just the installer disk).
                        </div>
                      )}
                      <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <p className="text-[11px] text-amber-200/80 leading-relaxed">
                          {connectorGuide.platform === "windows" ? (
                            <>
                              <span className="font-medium">Windows showing SmartScreen?</span> Click
                              {" "}More info{" "}then{" "}Run anyway.
                            </>
                          ) : (
                            <>
                              <span className="font-medium">Mac showing a warning?</span> Go to System Settings → Privacy &amp; Security, scroll down and click &quot;Open Anyway&quot;.
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Step 3: Generate code FIRST */}
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-zinc-700 text-white flex items-center justify-center text-sm font-bold shrink-0">
                      3
                    </div>
                    <div className="flex-1 pt-1">
                      <h3 className="text-sm font-medium text-white mb-1">Generate pairing code</h3>
                      <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                        Generate a code here <span className="text-amber-300">before</span> opening the app. You&apos;ll paste it when the app starts.
                      </p>
                      
                      {!pairingCode ? (
                        <button
                          type="button"
                          onClick={generatePairingCode}
                          disabled={pairingLoading}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-500/15 border border-cyan-500/20 text-cyan-200 hover:bg-cyan-500/20 transition-colors text-sm disabled:opacity-50"
                        >
                          {pairingLoading ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Generating...
                            </>
                          ) : (
                            <>
                              <Key className="w-4 h-4" />
                              Generate Pairing Code
                            </>
                          )}
                        </button>
                      ) : (
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-black/40 border border-cyan-500/30">
                            <code className="text-lg text-cyan-400 tracking-wider font-mono">{pairingCode}</code>
                          </div>
                          <button
                            type="button"
                            onClick={copyPairingCode}
                            className="px-3 py-2 rounded-lg text-xs text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 transition-all"
                          >
                            {pairingCopied ? "Copied!" : "Copy"}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Step 4: Open app and paste code */}
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-zinc-700 text-white flex items-center justify-center text-sm font-bold shrink-0">
                      4
                    </div>
                    <div className="flex-1 pt-1">
                      <h3 className="text-sm font-medium text-white mb-1">Open the app &amp; paste code</h3>
                      <p className="text-xs text-zinc-400 leading-relaxed">
                        Open <span className="text-white">Groovy Connector</span> and paste the pairing code when prompted.
                      </p>
                    </div>
                  </div>
                    </>
                  )}
                </div>

                {/* Right: Status Card */}
                {connectorMode === "groovy" ? (
                  <div className="rounded-2xl p-5 flex flex-col items-center justify-center text-center bg-zinc-900/80 border border-white/10">
                    <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-cyan-500/10">
                      <Server className="w-8 h-8 text-cyan-300" />
                    </div>
                    <h3 className="text-lg font-semibold mb-1 text-white">
                      {groovyMacRequest ? "Provisioning" : "Not requested"}
                    </h3>
                    <p className="text-xs text-zinc-500 mb-4">
                      {groovyMacRequest
                        ? `Status: ${groovyMacRequest.status}`
                        : "Request a Groovy Mac to continue"}
                    </p>
                    <button
                      type="button"
                      onClick={refreshGroovyMacRequest}
                      disabled={groovyMacLoading}
                      className="px-4 py-2 rounded-xl text-sm flex items-center gap-2 transition-all bg-white/5 text-zinc-300 hover:bg-white/10"
                    >
                      <RefreshCw className={`w-4 h-4 ${groovyMacLoading ? "animate-spin" : ""}`} />
                      {groovyMacLoading ? "Checking..." : "Check status"}
                    </button>
                  </div>
                ) : (
                  <div className={`rounded-2xl p-5 flex flex-col items-center justify-center text-center ${
                    connectorOnline 
                      ? "bg-emerald-500/10 border border-emerald-500/20" 
                      : "bg-zinc-900/80 border border-white/10"
                  }`}>
                    <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 ${
                      connectorOnline 
                        ? "bg-emerald-500/20" 
                        : "bg-zinc-800"
                    }`}>
                      {connectorOnline ? (
                        <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                      ) : (
                        <WifiOff className="w-8 h-8 text-zinc-500" />
                      )}
                    </div>
                    
                    <h3 className={`text-lg font-semibold mb-1 ${
                      connectorOnline ? "text-emerald-400" : "text-white"
                    }`}>
                      {connectorOnline ? "Connected" : "Not connected"}
                    </h3>
                    
                    <p className="text-xs text-zinc-500 mb-4">
                      {connectorOnline 
                        ? "Your connector is online and ready" 
                        : "Follow the steps to connect"}
                    </p>

                    <button
                      type="button"
                      onClick={handleRefreshConnector}
                      disabled={refreshingConnector}
                      className={`px-4 py-2 rounded-xl text-sm flex items-center gap-2 transition-all ${
                        connectorOnline
                          ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
                          : "bg-white/5 text-zinc-300 hover:bg-white/10"
                      }`}
                    >
                      <RefreshCw className={`w-4 h-4 ${refreshingConnector ? "animate-spin" : ""}`} />
                      {refreshingConnector ? "Checking..." : "Check connection"}
                    </button>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => goToStep("whatsapp", { connectorMode })}
                  className="flex-1 px-5 py-3 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 transition-all flex items-center justify-center gap-2"
                >
                  {connectorMode === "local" ? (connectorOnline ? "Continue" : "Skip for now") : "Continue"}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
              {!connectorOnline && (
                <p className="text-center text-xs text-zinc-600 mt-3">
                  You can connect later from Settings
                </p>
              )}
            </motion.div>
          )}

          {/* Step 2: WhatsApp */}
          {step === "whatsapp" && (
            <motion.div
              key="whatsapp"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="relative z-10"
            >
              <div className="text-center mb-8">
                <h2 className="text-2xl font-semibold text-white mb-2">
                  Step 2: Connect WhatsApp (optional)
                </h2>
                <p className="text-zinc-500 text-sm">
                  Choose how your team chats with Groovy
                </p>
                <p className="mt-2 text-xs text-amber-300">
                  Personal WhatsApp requires creating a group first. Kapso (Company WhatsApp) does not use groups.
                </p>
              </div>

              <div className="grid gap-4">
                <button
                  type="button"
                  onClick={() => {
                    setWhatsappMode("personal");
                    saveStep("whatsapp", { whatsappMode: "personal" });
                  }}
                  className={`p-5 rounded-2xl border text-left transition-all ${
                    whatsappMode === "personal"
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
                        Supports <span className="text-white">groups + DMs</span>. Requires a one‑time QR/code scan.
                      </div>
                      <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-200">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        You must create a WhatsApp group first.
                      </div>
                      {connectorMode === "groovy" && !groovyMacReady && (
                        <div className="text-[11px] text-amber-300 mt-2">
                          Groovy Mac must be ready before you can scan the QR.
                        </div>
                      )}
                    </div>
                  </div>
                </button>

                {whatsappMode === "personal" && (
                  <div className="p-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 space-y-3">
                    <div className="p-4 rounded-xl bg-amber-500/10 border-2 border-amber-500/40 space-y-2">
                      <div className="flex items-center gap-2 text-amber-100">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <p className="text-base font-semibold">
                          Required before connecting Personal WhatsApp
                        </p>
                      </div>
                      <p className="text-sm text-amber-100/95 leading-relaxed">
                        Create a WhatsApp group on your phone first, then enter the exact group name below.
                        Example: <span className="text-white font-medium">&quot;Groovy&quot;</span>. Add at least
                        one contact so the group can be created (they can leave after).
                      </p>
                      <p className="text-xs text-amber-200/90">
                        This requirement is only for <span className="font-medium">Personal WhatsApp</span>.{" "}
                        <span className="font-medium">Kapso (Company WhatsApp) does not use groups.</span>
                      </p>
                    </div>
                    <div>
                      <label className="text-xs text-zinc-400 block mb-1">WhatsApp group name (exact, case-sensitive)</label>
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
                  </div>
                )}

                <button
                  type="button"
                  onClick={async () => {
                    setWhatsappMode("company");
                    setWhatsappConnected(false);
                    saveStep("whatsapp", { whatsappMode: "company" });
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
                    whatsappMode === "company"
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
                        We create a company number automatically. <span className="text-white">DMs only</span> (no groups).
                      </div>
                      <div className="text-[11px] text-amber-300 mt-2">
                        Requires Meta (Facebook) Business access. If you don’t have a Business yet, Kapso/Meta will guide you to create one during setup.
                      </div>
                    </div>
                  </div>
                </button>

                {whatsappMode === "company" && !kapsoSetupLinkUrl && (
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-[12px] text-amber-200/90">
                    You’ll be taken to Meta login. If you don’t have a Business Manager/WABA yet, the flow will guide you to create/select one and grant access.
                  </div>
                )}
                {whatsappMode === "company" && (
                  <div className="rounded-2xl border border-purple-500/20 bg-purple-500/5 p-4 text-[12px] text-purple-100/90">
                    Pricing: <span className="text-white">${KAPSO_ALLOWLIST_PRICE_USD} per allowlisted phone/month</span>. You control cost by
                    how many numbers are in the DM allowlist.
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
                {whatsappMode === "company" && (
                  <div className="rounded-2xl border border-white/10 bg-black/30 p-4 text-[12px] text-zinc-300">
                    After setup, you must <span className="text-white">allowlist</span> the phone numbers that can DM this workspace (Settings → Company WhatsApp → DM allowlist). Team members can optionally{" "}
                    <span className="text-white">verify</span> their number to map DMs to their user.
                  </div>
                )}
                {showCardSetup &&
                pendingPaidAction === "kapso" &&
                stripeSetupClientSecret &&
                stripePublishableKey ? (
                  <div className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-2">
                    <div className="text-xs text-zinc-300">
                      Add a card to continue with Kapso setup.
                    </div>
                    <BillingCardSetupForm
                      clientSecret={stripeSetupClientSecret}
                      publishableKey={stripePublishableKey}
                      onError={(message) => setError(message || null)}
                      onSuccess={handleCardSetupSuccess}
                      onCancel={() => {
                        setShowCardSetup(false);
                        setPendingPaidAction(null);
                        setStripeSetupClientSecret(null);
                        setStripePublishableKey(null);
                      }}
                    />
                  </div>
                ) : null}
                {whatsappMode === "company" && kapsoSetupLinkUrl && (
                  <div className="rounded-2xl border border-purple-500/20 bg-purple-500/5 p-4 text-sm space-y-3">
                    <div className="text-purple-200">
                      Complete the Kapso setup in the new tab, then click &quot;I&apos;ve completed setup&quot; below.
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
                {whatsappMode === "company" && kapsoSetupLinkUrl && (
                  <button
                    type="button"
                    onClick={() => goToStep("telegram", { whatsappMode: "company" })}
                    className="w-full px-5 py-3 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 font-medium text-sm hover:bg-emerald-500/30 transition-all"
                  >
                    I&apos;ve completed setup → Continue
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setWhatsappMode("skip");
                    saveStep("whatsapp", { whatsappMode: "skip" });
                  }}
                  className={`p-4 rounded-2xl border text-left transition-all ${
                    whatsappMode === "skip"
                      ? "bg-white/10 border-white/20 text-white"
                      : "bg-black/30 border-white/10 text-zinc-400 hover:border-white/20"
                  }`}
                >
                  Skip for now
                </button>
              </div>

              <div className="flex items-center gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => goToStep("connector")}
                  className="px-5 py-3 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-all"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (whatsappMode === "company") {
                      // Create setup link first - user must complete it before continuing
                      if (!kapsoSetupLinkUrl) {
                        const canProceed = await ensureCardBeforeProvisioning("kapso");
                        if (!canProceed) return;
                        await startKapsoSetupLink();
                        return;
                      }
                      // If link exists but not opened, open it
                      window.open(kapsoSetupLinkUrl, "_blank");
                      return;
                    }
                    goToStep("telegram", { whatsappMode: whatsappMode || "skip" });
                  }}
                  className="flex-1 px-5 py-3 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 transition-all flex items-center justify-center gap-2"
                >
                  {whatsappMode === "company" ? (
                    kapsoSetupLinkUrl
                      ? "Open Kapso Setup"
                      : billingCardOnFile === false
                        ? "Add card + start Kapso setup"
                        : "Start Kapso Setup"
                  ) : (
                    <>
                      Continue
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          )}

          {/* Step 3: Telegram */}
          {step === "telegram" && (
            <motion.div
              key="telegram"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="relative z-10"
            >
              <div className="text-center mb-8">
                <h2 className="text-2xl font-semibold text-white mb-2">
                  Step 3: Connect Telegram (optional)
                </h2>
                <p className="text-zinc-500 text-sm">
                  Connect a Telegram bot to chat with Groovy and receive heartbeats
                </p>
              </div>

              <div className="grid gap-4">
                <button
                  type="button"
                  onClick={() => {
                    setTelegramMode("connect");
                    saveStep("telegram", { telegramMode: "connect" });
                  }}
                  className={`p-5 rounded-2xl border text-left transition-all ${
                    telegramMode === "connect"
                      ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-200"
                      : "bg-zinc-900/80 border-white/10 text-zinc-400 hover:border-white/20"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center shrink-0">
                      <Send className="w-5 h-5 text-cyan-300" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-white">Connect Telegram Bot</div>
                      <div className="text-xs text-zinc-500 mt-1">
                        Create a bot via <span className="text-white">@BotFather</span>, paste the token below. Works with groups, DMs, and forum topics.
                      </div>
                    </div>
                  </div>
                </button>

                {telegramMode === "connect" && !telegramConnected && (
                  <div className="p-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 space-y-4">
                    <div className="space-y-2">
                      <div className="text-xs text-zinc-400">
                        <span className="text-white font-medium">1.</span> Open Telegram and message{" "}
                        <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">@BotFather</a>
                      </div>
                      <div className="text-xs text-zinc-400">
                        <span className="text-white font-medium">2.</span> Send <code className="text-cyan-400">/newbot</code>, choose a name and username
                      </div>
                      <div className="text-xs text-zinc-400">
                        <span className="text-white font-medium">3.</span> Copy the bot token and paste it below
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-zinc-400 block mb-1">Bot token from @BotFather</label>
                      <input
                        type="password"
                        value={telegramBotTokenInput}
                        onChange={(e) => setTelegramBotTokenInput(e.target.value)}
                        placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                        className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white text-sm font-mono focus:outline-none focus:border-cyan-500/40"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={!telegramBotTokenInput.trim() || telegramConnecting}
                      onClick={async () => {
                        setTelegramConnecting(true);
                        setError(null);
                        try {
                          const res = await fetch("/api/telegram/setup", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "connect", botToken: telegramBotTokenInput.trim() }),
                          });
                          const json = await res.json().catch(() => ({}));
                          if (!res.ok) {
                            setError(json.error || "Failed to connect bot");
                            return;
                          }
                          setTelegramConnected(true);
                          setTelegramBotUsername(json.botUsername || null);
                          setTelegramBotTokenInput("");
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Connection failed");
                        } finally {
                          setTelegramConnecting(false);
                        }
                      }}
                      className="w-full px-4 py-2.5 rounded-xl bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 font-medium text-sm hover:bg-cyan-500/30 transition-all disabled:opacity-50"
                    >
                      {telegramConnecting ? "Connecting..." : "Connect Bot"}
                    </button>
                  </div>
                )}

                {telegramMode === "connect" && telegramConnected && (
                  <div className="p-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 space-y-3">
                    <div className="flex items-center gap-2 text-emerald-300 text-sm">
                      <CheckCircle2 className="w-4 h-4" />
                      Connected as @{telegramBotUsername}
                    </div>
                    <div className="text-xs text-zinc-400 space-y-1.5">
                      <div><span className="text-white font-medium">Next:</span> Add the bot to a Telegram group and send <code className="text-cyan-400">/register</code> to activate it.</div>
                      <div>You can also DM the bot directly for private conversations.</div>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setTelegramMode("skip");
                    saveStep("telegram", { telegramMode: "skip" });
                  }}
                  className={`p-4 rounded-2xl border text-left transition-all ${
                    telegramMode === "skip"
                      ? "bg-white/10 border-white/20 text-white"
                      : "bg-black/30 border-white/10 text-zinc-400 hover:border-white/20"
                  }`}
                >
                  Skip for now
                </button>
              </div>

              <div className="flex items-center gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => goToStep("whatsapp")}
                  className="px-5 py-3 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-all"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => goToStep("api_keys", { telegramMode: telegramMode || "skip" })}
                  className="flex-1 px-5 py-3 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 transition-all flex items-center justify-center gap-2"
                >
                  Continue
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          )}

          {/* Step 4: API Keys */}
          {step === "api_keys" && (
            <motion.div
              key="api_keys"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="relative z-10"
            >
              <div className="text-center mb-8">
                <h2 className="text-2xl font-semibold text-white mb-2">
                  Step 4: Choose your API keys
                </h2>
                <p className="text-zinc-500 text-sm">
                  You can change this anytime in settings.
                </p>
              </div>

              {!selectedMode ? (
                <div className="grid gap-4">
                  <motion.button
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                    onClick={() => handleApiModeSelect("groovy")}
                    disabled={saving}
                    className="group relative p-6 rounded-2xl bg-zinc-900/80 border border-white/10 text-left transition-all hover:border-cyan-500/30 hover:bg-zinc-900 disabled:opacity-50"
                  >
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center shrink-0">
                        <Sparkles className="w-6 h-6 text-cyan-400" />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-lg font-medium text-white mb-1">Use server provider keys</h3>
                        <p className="text-sm text-zinc-500">
                          For self-hosted deployments where you control the configured server environment keys.
                        </p>
                      </div>
                      <ArrowRight className="w-5 h-5 text-zinc-600 group-hover:text-cyan-400 transition-colors mt-1" />
                    </div>
                  </motion.button>

                  <motion.button
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                    onClick={() => setSelectedMode("user")}
                    disabled={saving}
                    className="group relative p-6 rounded-2xl bg-zinc-900/80 border border-white/10 text-left transition-all hover:border-cyan-500/30 hover:bg-zinc-900 disabled:opacity-50"
                  >
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                        <Key className="w-6 h-6 text-zinc-400" />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-lg font-medium text-white mb-1">Use my own API keys</h3>
                        <p className="text-sm text-zinc-500">
                          Recommended. You control your provider account, usage, and billing.
                        </p>
                      </div>
                      <ArrowRight className="w-5 h-5 text-zinc-600 group-hover:text-cyan-400 transition-colors mt-1" />
                    </div>
                  </motion.button>
                </div>
              ) : (
                <div className="bg-zinc-900/80 border border-white/10 rounded-2xl p-6 space-y-5">
                  <div className="p-3 rounded-xl bg-cyan-500/5 border border-cyan-500/10">
                    <p className="text-xs text-cyan-400/90">
                      Only add the provider keys you think you will use most. Your keys are encrypted with AES-256-GCM.
                    </p>
                  </div>

                  {(Object.keys(PROVIDER_INFO) as Provider[]).map((provider) => {
                    const info = PROVIDER_INFO[provider];
                    const hasValue = keys[provider] && keys[provider]!.trim();
                    return (
                      <div key={provider} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <div>
                            <label className="text-sm font-medium text-zinc-300">{info.name}</label>
                            <span className="text-xs text-zinc-600 ml-2">{info.description}</span>
                          </div>
                          <a
                            href={info.helpUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition-colors"
                          >
                            Get key
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                        <div className="relative">
                          <input
                            type={showKeys[provider] ? "text" : "password"}
                            value={keys[provider] || ""}
                            onChange={(e) => setKeys((prev) => ({ ...prev, [provider]: e.target.value }))}
                            placeholder={info.placeholder}
                            className="w-full px-4 py-3 pr-10 rounded-xl bg-black/40 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors font-mono text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => setShowKeys((prev) => ({ ...prev, [provider]: !prev[provider] }))}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                          >
                            {showKeys[provider] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        {hasValue && (
                          <div className="flex items-center gap-1.5 text-emerald-400 text-xs">
                            <Check className="w-3 h-3" />
                            Ready
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {error && (
                    <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      {error}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    if (selectedMode) {
                      setSelectedMode(null);
                      setKeys({});
                    } else {
                      goToStep("telegram");
                    }
                  }}
                  className="px-5 py-3 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-all"
                >
                  Back
                </button>
                {selectedMode && (
                  <button
                    type="button"
                    onClick={handleApiKeysSubmit}
                    disabled={saving}
                    className="flex-1 px-5 py-3 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Saving...
                      </>
                    ) : hasAtLeastOneKey ? (
                      "Continue"
                    ) : (
                      "Skip for now"
                    )}
                    <ArrowRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            </motion.div>
          )}

          {/* Step 3: Create AI Chat Agent */}
          {step === "chat_agent" && (
            <motion.div
              key="chat_agent"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="relative z-10"
            >
              <div className="text-center mb-8">
                <h2 className="text-2xl font-semibold text-white mb-2">
                  Step 5: Create your first AI agent
                </h2>
                <p className="text-zinc-500 text-sm">
                  Quick win! Create an AI Chat agent and start chatting right away.
                </p>
              </div>

              <div className="bg-zinc-900/80 border border-white/10 rounded-2xl p-6 space-y-6">
                <div className="p-4 rounded-xl bg-rose-500/5 border border-rose-500/10">
                  <p className="text-sm text-rose-200/80 mb-3">
                    We recommend creating a general-purpose agent to start:
                  </p>
                  <ul className="text-xs text-zinc-400 space-y-2">
                    <li className="flex items-start gap-2">
                      <span className="text-rose-400">•</span>
                      <span><strong className="text-zinc-300">NanoBanana Pro Images</strong> - Google Gemini for image generation</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-rose-400">•</span>
                      <span><strong className="text-zinc-300">General Assistant</strong> - GPT-4o for everyday tasks</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-rose-400">•</span>
                      <span><strong className="text-zinc-300">Code Expert</strong> - Claude Sonnet for coding help</span>
                    </li>
                  </ul>
                </div>

                {chatAgentCount > 0 ? (
                  <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-3">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    <span className="text-sm text-emerald-300">
                      You have {chatAgentCount} AI Chat agent{chatAgentCount > 1 ? "s" : ""} created!
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={onCreateChatAgent}
                    className="w-full p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-200 hover:bg-rose-500/15 transition-colors flex items-center justify-center gap-2"
                  >
                    <MessageSquare className="w-5 h-5" />
                    Create AI Chat Agent
                  </button>
                )}
              </div>

              <div className="flex items-center gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => goToStep("api_keys")}
                  className="px-5 py-3 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-all"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => goToStep("claude_cli")}
                  className="flex-1 px-5 py-3 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 transition-all flex items-center justify-center gap-2"
                >
                  {chatAgentCount > 0 ? "Continue" : "Skip for now"}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          )}

          {/* Step 6: Claude CLI */}
          {step === "claude_cli" && (
            <motion.div
              key="claude_cli"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="relative z-10"
            >
              <div className="text-center mb-8">
                <h2 className="text-2xl font-semibold text-white mb-2">
                  Step 6: Install Claude CLI
                </h2>
                <p className="text-zinc-500 text-sm">
                  Required for Code Agent and Browser Agent to work
                </p>
              </div>

              <div className="bg-zinc-900/80 border border-white/10 rounded-2xl p-6 space-y-6">
                <div className="p-4 rounded-xl bg-amber-500/5 border border-amber-500/10">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-sm text-amber-200/90">
                      Groovy uses Claude CLI to code and control the browser on your computer.
                      You need to install it on the machine running the connector.
                    </p>
                  </div>
                </div>

                {/* Install command */}
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-cyan-500 text-black flex items-center justify-center text-sm font-bold shrink-0">
                    1
                  </div>
                  <div className="flex-1 pt-1">
                    <h3 className="text-sm font-medium text-white mb-2">Install Claude CLI</h3>
                    <p className="text-xs text-zinc-400 mb-3">
                      Run this command in your {connectorGuide.platform === "windows" ? "PowerShell" : "terminal"}:
                    </p>
                    <div className="relative group">
                      <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-black/60 border border-white/10 font-mono text-sm text-cyan-300 overflow-x-auto">
                        <Terminal className="w-4 h-4 text-zinc-500 shrink-0" />
                        <code>{connectorGuide.platform === "windows"
                          ? "irm https://claude.ai/install.ps1 | iex"
                          : "curl -fsSL https://claude.ai/install.sh | bash"}</code>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(
                            connectorGuide.platform === "windows"
                              ? "irm https://claude.ai/install.ps1 | iex"
                              : "curl -fsSL https://claude.ai/install.sh | bash"
                          );
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 rounded-lg text-xs text-zinc-500 hover:text-white bg-white/5 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <a
                      href="https://code.claude.com/docs/en/overview"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 mt-2 text-xs text-zinc-500 hover:text-cyan-300 transition-colors"
                    >
                      Claude CLI documentation
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>

                {/* Setup token recommendation */}
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-zinc-700 text-white flex items-center justify-center text-sm font-bold shrink-0">
                    2
                  </div>
                  <div className="flex-1 pt-1">
                    <h3 className="text-sm font-medium text-white mb-1">Set up a CLI token (recommended)</h3>
                    <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                      After installing, run this to generate an OAuth token for Claude CLI.
                      After onboarding, paste it in Settings → API Keys → Claude CLI.
                    </p>
                    <div className="relative group">
                      <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-black/60 border border-white/10 font-mono text-sm text-cyan-300">
                        <Terminal className="w-4 h-4 text-zinc-500 shrink-0" />
                        <code>claude setup-token</code>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText("claude setup-token");
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 rounded-lg text-xs text-zinc-500 hover:text-white bg-white/5 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="text-[11px] text-zinc-600 mt-2">
                      This lets Claude CLI run without interactive login (headless runs).
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => goToStep("chat_agent")}
                  className="px-5 py-3 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-all"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => goToStep("done")}
                  className="flex-1 px-5 py-3 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 transition-all flex items-center justify-center gap-2"
                >
                  Continue
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </motion.div>
          )}

          {/* Done Step */}
          {step === "done" && (
            <motion.div
              key="done"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="text-center relative z-10"
            >
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.1 }}
                className="w-20 h-20 mx-auto mb-6 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center"
              >
                <CheckCircle2 className="w-10 h-10 text-emerald-400" />
              </motion.div>

              <motion.h2
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
                className="text-2xl font-semibold text-white mb-3"
              >
                You&apos;re all set!
              </motion.h2>

              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="text-zinc-400 mb-8 max-w-md mx-auto"
              >
                Your Groovy command center is ready. Start chatting, browsing, or managing your files.
              </motion.p>

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="flex items-center gap-3 max-w-sm mx-auto"
              >
                <button
                  type="button"
                  onClick={() => goToStep("claude_cli")}
                  disabled={saving}
                  className="px-5 py-3 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-all disabled:opacity-50"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleFinish}
                  disabled={saving}
                  className="flex-1 px-6 py-3 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                >
                  {saving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Finishing...
                    </>
                  ) : (
                    "Get Started"
                  )}
                </button>
              </motion.div>
            </motion.div>
          )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
