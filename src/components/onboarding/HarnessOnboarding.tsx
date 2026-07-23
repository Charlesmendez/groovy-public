"use client";

/**
 * HarnessOnboarding — full-screen onboarding for the harness product.
 *
 * Steps: welcome → license → desktop/connector_ready → brain → first_agent →
 * first_task → channels → done.
 *
 * Persists progress to /api/user-preferences with
 * onboardingData.flowVersion === "harness_v1". Legacy (classic-flow) steps are
 * mapped once on load — see resolveInitialStep().
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  FolderOpen,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Rocket,
  ScrollText,
  Send,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Terminal,
  UserRound,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useConnectorDevice } from "@/hooks/useConnectorDevice";
import { useWorkerAgents } from "@/hooks/useWorkerAgents";
import { useAgentTasks, type AgentTask } from "@/hooks/useAgentTasks";
import { useSettingsState } from "@/hooks/useSettingsState";
import type { DesktopAutoPairResult } from "@/hooks/useDesktopAutoPair";
import { isDesktopShell, getDesktopApi } from "@/lib/desktop/shell";
import {
  ConnectorPairingSection,
  ConnectorStatusCard,
} from "@/components/onboarding/steps/ConnectorPairingSection";
import { LicenseStep } from "@/components/onboarding/steps/LicenseStep";
import { ApiKeysSection } from "@/components/onboarding/steps/ApiKeysSection";
import { CliAuthSection } from "@/components/onboarding/steps/CliAuthSection";
import { WhatsAppStep, type WhatsAppMode } from "@/components/onboarding/steps/WhatsAppStep";
import { TelegramStep } from "@/components/onboarding/steps/TelegramStep";
import { MODEL_CATALOG } from "@/lib/ai/modelCatalog";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";

type HarnessStep =
  | "welcome"
  | "license"
  | "connector_ready"
  | "brain"
  | "first_agent"
  | "first_task"
  | "channels"
  | "done";

const HARNESS_STEPS: HarnessStep[] = [
  "welcome",
  "license",
  "connector_ready",
  "brain",
  "first_agent",
  "first_task",
  "channels",
  "done",
];

const PROGRESS_STEPS: { id: HarnessStep; label: string }[] = [
  { id: "license", label: "Free trial" },
  { id: "connector_ready", label: "Desktop app" },
  { id: "brain", label: "Brain" },
  { id: "first_agent", label: "First agent" },
  { id: "first_task", label: "First task" },
  { id: "channels", label: "Channels" },
];

/** Shared orchestrator model list ("Auto" = model null → env default). */
const BRAIN_MODELS: Array<{
  id: string | null;
  provider: "anthropic" | "openai" | null;
  label: string;
  hint: string;
}> = [
  { id: null, provider: null, label: "Auto", hint: "Groovy picks — a great default" },
  ...MODEL_CATALOG.flatMap((group) =>
    group.models.map((model) => ({
      id: model.id,
      provider: group.provider,
      label: model.label,
      hint: model.hint || group.group,
    }))
  ),
];

const AGENT_NAME_SUGGESTIONS = ["Scout", "Forge", "Patch", "Nova", "Wrench", "Atlas"];

const FIRST_TASK_PROMPT =
  "List the 5 largest files in this workspace and suggest cleanups";

type OnboardingData = Record<string, unknown>;

/**
 * Resume mapping. Applied once when the saved flow predates harness_v1:
 *   welcome→welcome, license→license, connector→connector_ready,
 *   api_keys→brain, claude_cli→brain, chat_agent→first_agent,
 *   whatsapp→channels*, telegram→channels*, done→done.
 * *rule: resume at the EARLIER of the mapped step and the first incomplete
 * core step among brain/first_agent/first_task (old order put whatsapp and
 * telegram before api_keys, so those users must still get the core steps).
 */
function resolveInitialStep(rawStep: string, data: OnboardingData): HarnessStep {
  if (data.flowVersion === "harness_v1") {
    return HARNESS_STEPS.includes(rawStep as HarnessStep) ? (rawStep as HarnessStep) : "welcome";
  }
  const legacyMap: Record<string, HarnessStep> = {
    welcome: "welcome",
    license: "license",
    connector: "connector_ready",
    api_keys: "brain",
    claude_cli: "brain",
    chat_agent: "first_agent",
    whatsapp: "channels",
    telegram: "channels",
    done: "done",
  };
  const mapped = legacyMap[rawStep] || "welcome";
  if (rawStep === "whatsapp" || rawStep === "telegram") {
    const firstIncompleteCore: HarnessStep | null =
      !data.apiKeyMode && !data.orchestratorModelSet
        ? "brain"
        : !data.firstAgentCreated
          ? "first_agent"
          : !data.firstTaskRun
            ? "first_task"
            : null;
    if (
      firstIncompleteCore &&
      HARNESS_STEPS.indexOf(firstIncompleteCore) < HARNESS_STEPS.indexOf(mapped)
    ) {
      return firstIncompleteCore;
    }
  }
  return mapped;
}

const stepMotion = {
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -24 },
  transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const },
};

type HarnessOnboardingProps = {
  onComplete: () => void;
  autoPair: DesktopAutoPairResult;
};

export function HarnessOnboarding({ onComplete, autoPair }: HarnessOnboardingProps) {
  const supabase = getSupabaseBrowserClient();
  const connectorInstallGuide = useConnectorInstallGuide();

  // ---- Environment / identity ----
  const [inDesktopShell, setInDesktopShell] = useState(false);
  useEffect(() => {
    setInDesktopShell(isDesktopShell());
  }, []);
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      setUserId(user?.id || null);
    })();
  }, [supabase]);

  // ---- Harness plumbing ----
  const device = useConnectorDevice();
  const workers = useWorkerAgents({
    relay: device.relay,
    activeDeviceId: device.activeDeviceId,
  });
  const taskFeed = useAgentTasks({ userId });
  const settings = useSettingsState(userId);
  // ---- Step machine ----
  const [step, setStep] = useState<HarnessStep>("welcome");
  const [loaded, setLoaded] = useState(false);
  const onboardingDataRef = useRef<OnboardingData>({});

  const persist = useCallback(
    (payload: { onboardingStep?: HarnessStep; onboardingData?: OnboardingData }) => {
      const data = { flowVersion: "harness_v1", ...(payload.onboardingData || {}) };
      onboardingDataRef.current = { ...onboardingDataRef.current, ...data };
      return fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, onboardingData: data }),
      }).catch(() => {});
    },
    []
  );

  const goToStep = useCallback(
    (next: HarnessStep, dataUpdates?: OnboardingData) => {
      setStep(next);
      void persist({ onboardingStep: next, onboardingData: dataUpdates });
    },
    [persist]
  );

  // ---- Restored state ----
  const [firstAgentId, setFirstAgentId] = useState<string | null>(null);
  const [firstTaskId, setFirstTaskId] = useState<string | null>(null);
  const [savedWhatsAppMode, setSavedWhatsAppMode] = useState<WhatsAppMode | null>(null);
  const [heartbeatChannel, setHeartbeatChannel] = useState<"whatsapp" | "telegram" | "both">(
    "whatsapp"
  );

  // Load prefs once; apply resume mapping when the saved flow is pre-harness.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/user-preferences", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        const data: OnboardingData =
          json?.onboardingData && typeof json.onboardingData === "object"
            ? (json.onboardingData as OnboardingData)
            : {};
        onboardingDataRef.current = data;
        const rawStep = typeof json?.onboardingStep === "string" ? json.onboardingStep : "welcome";
        const resolved = resolveInitialStep(rawStep, data);
        setStep(resolved);
        if (typeof data.firstAgentCreated === "string") setFirstAgentId(data.firstAgentCreated);
        if (typeof data.firstTaskRun === "string") setFirstTaskId(data.firstTaskRun);
        if (
          data.whatsappMode === "personal" ||
          data.whatsappMode === "company" ||
          data.whatsappMode === "skip"
        ) {
          setSavedWhatsAppMode(data.whatsappMode);
        }
        if (
          json?.heartbeatChannel === "whatsapp" ||
          json?.heartbeatChannel === "telegram" ||
          json?.heartbeatChannel === "both"
        ) {
          setHeartbeatChannel(json.heartbeatChannel);
        }
        // Stamp the flow version once so the mapping never re-applies.
        if (data.flowVersion !== "harness_v1") {
          void persist({ onboardingStep: resolved });
        }
      } catch {
        // start fresh at welcome
      } finally {
        setLoaded(true);
      }
    })();
  }, [persist]);

  // Welcome auto-advance.
  useEffect(() => {
    if (!loaded || step !== "welcome") return;
    const t = setTimeout(() => goToStep("license"), 2500);
    return () => clearTimeout(t);
  }, [loaded, step, goToStep]);

  // ---- Brain step state ----
  const [brainSelection, setBrainSelection] = useState<{
    provider: "anthropic" | "openai" | null;
    model: string | null;
  }>({ provider: null, model: null });
  const [brainSaving, setBrainSaving] = useState(false);
  const [brainError, setBrainError] = useState<string | null>(null);
  const [keysSavedMode, setKeysSavedMode] = useState<"groovy" | "user" | null>(null);
  const [cliOpen, setCliOpen] = useState(false);

  useEffect(() => {
    if (step !== "brain") return;
    fetch("/api/orchestrator/model", { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        setBrainSelection({
          provider: json?.provider === "openai" ? "openai" : json?.model ? "anthropic" : null,
          model: typeof json?.model === "string" ? json.model : null,
        });
      })
      .catch(() => {});
  }, [step]);

  const pickBrainModel = useCallback(
    async (choice: (typeof BRAIN_MODELS)[number]) => {
      setBrainSaving(true);
      setBrainError(null);
      const prev = brainSelection;
      setBrainSelection({ provider: choice.provider, model: choice.id });
      try {
        const res = await fetch("/api/orchestrator/model", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: choice.provider, model: choice.id }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(typeof json?.error === "string" ? json.error : "Failed to save model");
        }
        void persist({ onboardingData: { orchestratorModelSet: true } });
      } catch (e) {
        setBrainSelection(prev);
        setBrainError(e instanceof Error ? e.message : "Failed to save model");
      } finally {
        setBrainSaving(false);
      }
    },
    [brainSelection, persist]
  );

  // ---- First agent step state ----
  const [agentName, setAgentName] = useState("");
  const [agentHarness, setAgentHarness] = useState<"claude" | "codex">("claude");
  const [workspace, setWorkspace] = useState<{ id: string; rootPath: string } | null>(null);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  const selectedAgentCliInstalled =
    agentHarness === "claude"
      ? device.capabilities.claudeCliInstalled === true
      : device.capabilities.codexCliInstalled === true;
  const canCreateAgent =
    device.connectorOnline &&
    !!agentName.trim() &&
    !!workspace &&
    selectedAgentCliInstalled &&
    !creatingAgent;

  const handlePickWorkspace = useCallback(async () => {
    setPickingWorkspace(true);
    setAgentError(null);
    try {
      const picked = await workers.pickWorkspace();
      if (picked) setWorkspace(picked);
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : "Failed to pick a folder");
    } finally {
      setPickingWorkspace(false);
    }
  }, [workers]);

  const handleCreateAgent = useCallback(async () => {
    if (!canCreateAgent) return;
    setCreatingAgent(true);
    setAgentError(null);
    try {
      const created = await workers.createAgent({
        name: agentName.trim(),
        harness: agentHarness,
        workspace: workspace
          ? { id: workspace.id, rootPath: workspace.rootPath }
          : null,
      });
      if (!created) {
        setAgentError("Could not create the agent. Check that the connector is online and retry.");
        return;
      }
      setFirstAgentId(created.id);
      goToStep("first_task", { firstAgentCreated: created.id });
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : "Could not create the agent.");
    } finally {
      setCreatingAgent(false);
    }
  }, [canCreateAgent, workers, agentName, agentHarness, workspace, goToStep]);

  // ---- First task step state ----
  const [taskPrompt, setTaskPrompt] = useState(FIRST_TASK_PROMPT);
  const [submittingTask, setSubmittingTask] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [localTask, setLocalTask] = useState<AgentTask | null>(null);
  const fallbackTaskKicksRef = useRef(new Set<string>());

  const liveTask: AgentTask | null = useMemo(() => {
    if (!firstTaskId) return null;
    return taskFeed.tasks.find((t) => t.id === firstTaskId) || localTask;
  }, [firstTaskId, taskFeed.tasks, localTask]);

  const firstTaskAgent = useMemo(
    () => workers.agents.find((a) => a.id === firstAgentId) || null,
    [workers.agents, firstAgentId]
  );
  const queuedFirstTaskId = liveTask?.status === "queued" ? liveTask.id : null;
  const refreshTaskFeed = taskFeed.refresh;

  // The normal create route delivers a detached internal kick. If that
  // delivery is lost (for example, a stale local NEXT_PUBLIC_APP_URL), use
  // the user's existing cookie session to re-drive the same durable task.
  // runAgentTask claims queued → running atomically, so duplicate delivery is
  // harmless when the original kick did arrive.
  useEffect(() => {
    if (!queuedFirstTaskId) return;
    const taskId = queuedFirstTaskId;
    if (fallbackTaskKicksRef.current.has(taskId)) return;

    const timer = window.setTimeout(() => {
      fallbackTaskKicksRef.current.add(taskId);
      void (async () => {
        try {
          const res = await fetch("/api/agents/tasks/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId }),
          });
          if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            fallbackTaskKicksRef.current.delete(taskId);
            setTaskError(
              typeof json?.error === "string"
                ? json.error
                : `Task dispatch failed (HTTP ${res.status})`
            );
            return;
          }
          setTaskError(null);
          window.setTimeout(() => void refreshTaskFeed(), 750);
        } catch (error) {
          fallbackTaskKicksRef.current.delete(taskId);
          setTaskError(error instanceof Error ? error.message : "Task dispatch failed");
        }
      })();
    }, 4_000);

    return () => window.clearTimeout(timer);
  }, [queuedFirstTaskId, refreshTaskFeed]);

  const handleRunFirstTask = useCallback(async () => {
    if (!firstAgentId || !taskPrompt.trim() || submittingTask) return;
    setSubmittingTask(true);
    setTaskError(null);
    try {
      const res = await fetch("/api/agents/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: firstAgentId, prompt: taskPrompt.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.task?.id) {
        throw new Error(typeof json?.error === "string" ? json.error : "Failed to start the task");
      }
      const task = json.task as AgentTask;
      setLocalTask(task);
      setFirstTaskId(task.id);
      void persist({ onboardingData: { firstTaskRun: task.id } });
      void taskFeed.refresh();
    } catch (e) {
      setTaskError(e instanceof Error ? e.message : "Failed to start the task");
    } finally {
      setSubmittingTask(false);
    }
  }, [firstAgentId, taskPrompt, submittingTask, persist, taskFeed]);

  // ---- Channels step state ----
  const [channelsTab, setChannelsTab] = useState<"whatsapp" | "telegram" | "heartbeat">(
    "whatsapp"
  );

  const writeConnectorWhatsAppConfig = useCallback(
    async (enabled: boolean, groupName: string): Promise<boolean> => {
      const deviceId = device.activeDeviceId;
      if (!deviceId || !device.relayConnected) return false;
      const config = {
        whatsapp_enabled: enabled,
        whatsapp_group_name: enabled ? groupName.trim() : "",
        whatsapp_app_url: window.location.origin,
      };
      // Best-effort persistence so the connector keeps the config after restarts.
      try {
        const { data } = await supabase
          .from("devices")
          .select("connector_config")
          .eq("id", deviceId)
          .limit(1)
          .maybeSingle();
        const current =
          data?.connector_config &&
          typeof data.connector_config === "object" &&
          !Array.isArray(data.connector_config)
            ? (data.connector_config as Record<string, unknown>)
            : {};
        await supabase
          .from("devices")
          .update({ connector_config: { ...current, ...config } })
          .eq("id", deviceId);
      } catch {
        // ignore; live config below is what matters for the QR flow
      }
      return await new Promise<boolean>((resolve) => {
        const requestId = `cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let settled = false;
        let unsub: (() => void) | null = null;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          unsub?.();
          resolve(ok);
        };
        const timer = window.setTimeout(() => finish(false), 20_000);
        unsub = device.relay.subscribe((msg) => {
          const m = msg as { request_id?: string; ok?: boolean };
          if (String(m.request_id || "") !== requestId) return;
          finish(m.ok !== false);
        });
        try {
          device.relay.send({
            type: "connector_configure",
            request_id: requestId,
            device_id: deviceId,
            config,
            restart: true,
          });
        } catch {
          finish(false);
        }
      });
    },
    [device.activeDeviceId, device.relayConnected, device.relay, supabase]
  );

  const saveHeartbeatChannel = useCallback(
    (channel: "whatsapp" | "telegram" | "both") => {
      setHeartbeatChannel(channel);
      fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heartbeatChannel: channel }),
      }).catch(() => {});
    },
    []
  );

  // ---- Done ----
  const [finishing, setFinishing] = useState(false);
  const handleFinish = useCallback(async () => {
    setFinishing(true);
    try {
      await fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboardingCompleted: true }),
      });
    } catch {
      // still complete locally
    }
    onComplete();
  }, [onComplete]);

  // ---- Desktop connector stage derivation ----
  const desktopStage: 0 | 1 | 2 = device.connectorOnline
    ? 2
    : autoPair.state === "pairing" || autoPair.state === "ready"
      ? 1
      : 0;

  const currentProgressIndex = PROGRESS_STEPS.findIndex((s) => s.id === step);

  if (!loaded) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-primary,#0a0a0f)]">
        <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg-primary,#0a0a0f)] overflow-y-auto">
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/4 w-[560px] h-[560px] bg-cyan-500/[0.06] rounded-full blur-[160px]" />
        <div className="absolute -bottom-40 right-1/4 w-[480px] h-[480px] bg-violet-500/[0.06] rounded-full blur-[160px]" />
      </div>

      {/* Progress dots */}
      {step !== "welcome" && step !== "done" && (
        <div className="fixed left-0 right-0 top-6 z-20 flex justify-center px-4">
          <div className="flex items-center gap-2 rounded-full border border-white/5 bg-black/40 px-4 py-2 backdrop-blur-xl">
            {PROGRESS_STEPS.map((s, i) => {
              const isActive = s.id === step;
              const isCompleted = currentProgressIndex >= 0 && i < currentProgressIndex;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    if (isCompleted) goToStep(s.id);
                  }}
                  className={`group flex items-center gap-1.5 ${isCompleted ? "cursor-pointer" : "cursor-default"}`}
                  title={s.label}
                >
                  <span
                    className={`block h-2 w-2 rounded-full transition-all ${
                      isActive
                        ? "w-5 bg-cyan-400"
                        : isCompleted
                          ? "bg-cyan-500/60 group-hover:bg-cyan-400"
                          : "bg-zinc-700"
                    }`}
                  />
                  <span
                    className={`hidden sm:block text-[10px] transition-colors ${
                      isActive ? "text-white" : isCompleted ? "text-zinc-400" : "text-zinc-600"
                    }`}
                  >
                    {s.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="relative min-h-screen w-full flex items-center justify-center px-6 py-24">
        <div className="w-full max-w-3xl">
          <AnimatePresence mode="wait">
            {/* 1. Welcome */}
            {step === "welcome" && (
              <motion.div key="welcome" {...stepMotion} className="relative z-10 text-center">
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.15 }}
                  className="mx-auto mb-10 flex h-20 w-20 items-center justify-center rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/20 to-violet-500/10"
                >
                  <Zap className="h-10 w-10 text-cyan-400" />
                </motion.div>
                <motion.h1
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.35 }}
                  className="mb-4 text-4xl font-semibold tracking-tight text-white"
                >
                  Your AI workforce,
                  <br />
                  <span className="bg-gradient-to-r from-cyan-400 to-violet-400 bg-clip-text text-transparent">
                    running on your machines.
                  </span>
                </motion.h1>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.6 }}
                  className="text-lg text-zinc-400"
                >
                  Let&apos;s hire your first agent. It takes about two minutes.
                </motion.p>
              </motion.div>
            )}

            {/* 2. License */}
            {step === "license" && (
              <LicenseStep
                key="license"
                title="Start with 5 days free"
                onContinue={() => goToStep("connector_ready")}
              />
            )}

            {/* 3. Desktop app / connector ready */}
            {step === "connector_ready" && (
              <motion.div key="connector_ready" {...stepMotion} className="relative z-10">
                <div className="mb-8 text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-500/20 bg-cyan-500/10">
                    {device.connectorOnline ? (
                      <Wifi className="h-7 w-7 text-emerald-400" />
                    ) : (
                      <WifiOff className="h-7 w-7 text-cyan-300" />
                    )}
                  </div>
                  <h2 className="mb-2 text-2xl font-semibold text-white">
                    {device.connectorOnline
                      ? "Your machine is ready"
                      : inDesktopShell
                        ? "Setting up your machine"
                        : connectorInstallGuide.platform === "windows"
                          ? "Install the Groovy Connector"
                          : "Install Groovy Desktop"}
                  </h2>
                  <p className="text-sm text-zinc-500">
                    {device.connectorOnline
                      ? "The built-in connector is online. Continue to choose your orchestrator model."
                      : inDesktopShell
                        ? "Groovy Desktop is starting its built-in connector and linking this machine."
                        : connectorInstallGuide.platform === "windows"
                          ? "Groovy Desktop is currently available for macOS. On Windows, install and pair the standalone connector."
                          : "Groovy Desktop includes the connector. Install one app, then sign in — there is no separate connector install."}
                  </p>
                </div>

                {inDesktopShell ? (
                  <div className="rounded-2xl border border-white/10 bg-zinc-900/80 p-6">
                    <div className="space-y-4">
                      {(
                        [
                          { label: "Starting connector", stage: 0 },
                          { label: "Linking to your account", stage: 1 },
                          { label: "Connected", stage: 2 },
                        ] as const
                      ).map(({ label, stage }) => {
                        const isDone =
                          desktopStage > stage || (stage === 2 && device.connectorOnline);
                        const isCurrent = desktopStage === stage && !isDone;
                        const failed = autoPair.state === "error" && isCurrent;
                        return (
                          <div key={label} className="flex items-center gap-3">
                            {isDone ? (
                              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
                            ) : failed ? (
                              <AlertCircle className="h-5 w-5 shrink-0 text-red-400" />
                            ) : isCurrent ? (
                              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-cyan-400" />
                            ) : (
                              <span className="block h-5 w-5 shrink-0 rounded-full border border-zinc-700" />
                            )}
                            <span
                              className={`text-sm ${
                                isDone
                                  ? "text-emerald-300"
                                  : isCurrent
                                    ? "text-white"
                                    : "text-zinc-500"
                              }`}
                            >
                              {label}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {autoPair.state === "error" && (
                      <div className="mt-5 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                        <div className="flex items-start gap-2 text-sm text-red-200">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{autoPair.error || "The connector could not be paired."}</span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={autoPair.retry}
                            className="inline-flex items-center gap-2 rounded-lg bg-red-500/15 border border-red-500/30 px-3 py-2 text-xs font-medium text-red-100 hover:bg-red-500/25 transition-all"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                            Retry
                          </button>
                          <button
                            type="button"
                            onClick={() => void getDesktopApi().openLogs()}
                            className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 hover:bg-white/10 transition-all"
                          >
                            <ScrollText className="h-3.5 w-3.5" />
                            Open logs
                          </button>
                        </div>
                      </div>
                    )}

                    {autoPair.state === "account_mismatch" && (
                      <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
                        <p className="text-sm text-amber-200">
                          This machine is paired to a different Groovy account.
                        </p>
                        <button
                          type="button"
                          onClick={autoPair.switchAccount}
                          className="mt-3 inline-flex items-center gap-2 rounded-lg bg-amber-500/15 border border-amber-500/30 px-3 py-2 text-xs font-medium text-amber-100 hover:bg-amber-500/25 transition-all"
                        >
                          <UserRound className="h-3.5 w-3.5" />
                          Pair with this account instead
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <BrowserConnectorSetup
                    connectorOnline={device.connectorOnline}
                    onRefreshConnector={device.refresh}
                    desktopDownloadSupported={connectorInstallGuide.platform !== "windows"}
                  />
                )}

                <div className="mt-6 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => goToStep("license")}
                    className="rounded-xl px-5 py-3 text-sm text-zinc-400 transition-all hover:bg-white/5 hover:text-white"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={!device.connectorOnline}
                    onClick={() => goToStep("brain")}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-500 px-5 py-3 text-sm font-medium text-black transition-all hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {device.connectorOnline ? "Connected — continue" : "Waiting for connector…"}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
                {!device.connectorOnline && (
                  <p className="mt-3 text-center text-xs text-zinc-600">
                    Stuck?{" "}
                    <button
                      type="button"
                      onClick={() => goToStep("brain")}
                      className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
                    >
                      Skip for now
                    </button>{" "}
                    — you can connect later from the dashboard.
                  </p>
                )}
              </motion.div>
            )}

            {/* 4. Brain */}
            {step === "brain" && (
              <motion.div key="brain" {...stepMotion} className="relative z-10">
                <div className="mb-8 text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-violet-500/20 bg-violet-500/10">
                    <Brain className="h-7 w-7 text-violet-300" />
                  </div>
                  <h2 className="mb-2 text-2xl font-semibold text-white">Choose the brain</h2>
                  <p className="text-sm text-zinc-500">
                    The orchestrator plans and routes tasks to your agents. Workers keep their own
                    models.
                  </p>
                </div>

                <div className="space-y-5">
                  {/* Model picker */}
                  <div className="rounded-2xl border border-white/10 bg-zinc-900/80 p-5">
                    <div className="mb-3 text-sm font-medium text-white">Orchestrator model</div>
                    {brainError && (
                      <div className="mb-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2.5 text-xs text-red-300">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        {brainError}
                        <button
                          type="button"
                          onClick={() => setBrainError(null)}
                          className="ml-auto text-zinc-500 hover:text-white"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                      {BRAIN_MODELS.map((m) => {
                        const isSelected = brainSelection.model === m.id;
                        return (
                          <button
                            key={m.label}
                            type="button"
                            disabled={brainSaving}
                            onClick={() => void pickBrainModel(m)}
                            className={`rounded-xl border p-3 text-left transition-all disabled:opacity-60 ${
                              isSelected
                                ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-100"
                                : "border-white/10 bg-black/30 text-zinc-300 hover:border-white/20 hover:bg-white/5"
                            }`}
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium">{m.label}</span>
                              {isSelected && <Check className="h-3.5 w-3.5 text-cyan-300" />}
                            </div>
                            <div className="mt-0.5 text-[10px] text-zinc-500">{m.hint}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Provider keys */}
                  <div className="rounded-2xl border border-white/10 bg-zinc-900/80 p-5">
                    <div className="mb-1 text-sm font-medium text-white">Provider keys</div>
                    <p className="mb-4 text-xs text-zinc-500">
                      {settings.serverProviderKeysAllowed
                        ? "Add your own API keys or use keys configured by this self-hosted deployment."
                        : "Connect at least one model provider account. No credit card is required for Groovy's trial; model usage is billed directly by your provider."}
                    </p>
                    {keysSavedMode ? (
                      <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-300">
                        <CheckCircle2 className="h-4 w-4" />
                        {keysSavedMode === "user"
                          ? "Your API keys are saved and encrypted."
                          : "Using server provider keys."}
                        <button
                          type="button"
                          onClick={() => setKeysSavedMode(null)}
                          className="ml-auto text-xs text-zinc-400 underline underline-offset-2 hover:text-white"
                        >
                          Change
                        </button>
                      </div>
                    ) : (
                      <ApiKeysSection
                        hideHeader
                        allowServerProviderKeys={settings.serverProviderKeysAllowed}
                        onSaveApiKeys={settings.saveKeys}
                        onSaved={(mode) => {
                          setKeysSavedMode(mode);
                          void persist({ onboardingData: { apiKeyMode: mode } });
                        }}
                      />
                    )}
                  </div>

                  {/* CLI auth (collapsible) */}
                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/80">
                    <button
                      type="button"
                      onClick={() => setCliOpen((v) => !v)}
                      className="flex w-full items-center gap-3 p-5 text-left transition-colors hover:bg-white/5"
                    >
                      <Terminal className="h-4 w-4 text-cyan-300" />
                      <div className="flex-1">
                        <div className="text-sm font-medium text-white">
                          How your agents authenticate
                        </div>
                        <div className="text-xs text-zinc-500">
                          Install and sign in to Claude Code or Codex CLI
                        </div>
                      </div>
                      <ChevronDown
                        className={`h-4 w-4 text-zinc-500 transition-transform ${cliOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    <AnimatePresence initial={false}>
                      {cliOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.22 }}
                        >
                          <div className="px-5 pb-5">
                            <CliAuthSection
                              claudeInstalled={device.capabilities.claudeCliInstalled}
                              codexInstalled={device.capabilities.codexCliInstalled}
                              connectorVersion={device.connectorVersion}
                              codexDetectionUnavailable={
                                device.connectorOnline &&
                                device.capabilities.codexCliInstalled === null &&
                                device.connectorOutdated
                              }
                              onUpdateConnector={
                                device.supportsInPlaceUpdate ? device.updateConnector : undefined
                              }
                            />
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                <div className="mt-6 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => goToStep("connector_ready")}
                    className="rounded-xl px-5 py-3 text-sm text-zinc-400 transition-all hover:bg-white/5 hover:text-white"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      goToStep("first_agent", {
                        orchestratorModelSet: true,
                      })
                    }
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-500 px-5 py-3 text-sm font-medium text-black transition-all hover:bg-cyan-400"
                  >
                    Continue
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </motion.div>
            )}

            {/* 5. First agent */}
            {step === "first_agent" && (
              <motion.div key="first_agent" {...stepMotion} className="relative z-10">
                <div className="mb-8 text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-500/20 bg-cyan-500/10">
                    <Bot className="h-7 w-7 text-cyan-300" />
                  </div>
                  <h2 className="mb-2 text-2xl font-semibold text-white">
                    Create a worker for your orchestrator
                  </h2>
                  <p className="text-sm text-zinc-500">
                    Your orchestrator is already configured. Now give it a worker that can execute
                    delegated tasks on this machine.
                  </p>
                </div>

                <div className="mb-5 rounded-2xl border border-violet-500/20 bg-violet-500/5 p-4">
                  <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                    <div className="flex flex-1 items-center gap-3 rounded-xl border border-violet-500/20 bg-black/20 p-3">
                      <Brain className="h-5 w-5 shrink-0 text-violet-300" />
                      <div>
                        <div className="text-xs font-medium text-white">Orchestrator</div>
                        <div className="text-[11px] text-zinc-500">Already configured · plans and delegates</div>
                      </div>
                    </div>
                    <ArrowRight className="mx-auto h-4 w-4 rotate-90 text-zinc-600 sm:rotate-0" />
                    <div className="flex flex-1 items-center gap-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-3">
                      <Bot className="h-5 w-5 shrink-0 text-cyan-300" />
                      <div>
                        <div className="text-xs font-medium text-white">Worker agent</div>
                        <div className="text-[11px] text-zinc-400">You are creating this · executes the work</div>
                      </div>
                    </div>
                  </div>
                  <p className="mt-3 text-center text-[11px] leading-relaxed text-zinc-500">
                    The worker uses the selected coding harness and can work only inside the folder
                    you choose below.
                  </p>
                </div>

                {!device.connectorOnline && (
                  <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">
                    <WifiOff className="h-4 w-4 shrink-0" />
                    Connector offline — agents need a machine.
                    <button
                      type="button"
                      onClick={() => goToStep("connector_ready")}
                      className="ml-auto text-xs underline underline-offset-2 hover:text-white"
                    >
                      Reconnect
                    </button>
                  </div>
                )}

                <div className="space-y-5 rounded-2xl border border-white/10 bg-zinc-900/80 p-6">
                  {/* Name */}
                  <div>
                    <label className="mb-1.5 block text-xs text-zinc-400">Worker name</label>
                    <input
                      type="text"
                      value={agentName}
                      autoFocus
                      onChange={(e) => setAgentName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && canCreateAgent) void handleCreateAgent();
                      }}
                      placeholder="e.g. Scout"
                      className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-white placeholder-zinc-600 outline-none transition-colors focus:border-cyan-500/50"
                    />
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {AGENT_NAME_SUGGESTIONS.map((name) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => setAgentName(name)}
                          className={`rounded-full border px-2.5 py-1 text-[11px] transition-all ${
                            agentName === name
                              ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-200"
                              : "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
                          }`}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Harness */}
                  <div>
                    <label className="mb-1.5 block text-xs text-zinc-400">
                      Worker harness <span className="text-zinc-600">· how it executes tasks</span>
                    </label>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {(
                        [
                          {
                            id: "claude" as const,
                            label: "Claude Code",
                            hint: "Anthropic's coding agent",
                            installed: device.capabilities.claudeCliInstalled,
                            icon: SquareTerminal,
                          },
                          {
                            id: "codex" as const,
                            label: "Codex CLI",
                            hint: "OpenAI's coding agent",
                            installed: device.capabilities.codexCliInstalled,
                            icon: Terminal,
                          },
                        ]
                      ).map((h) => (
                        <button
                          key={h.id}
                          type="button"
                          disabled={h.installed !== true}
                          onClick={() => setAgentHarness(h.id)}
                          className={`rounded-xl border p-4 text-left transition-all ${
                            agentHarness === h.id
                              ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-100"
                              : "border-white/10 bg-black/30 text-zinc-400 hover:border-white/20"
                          } disabled:cursor-not-allowed disabled:opacity-45`}
                        >
                          <div className="flex items-center gap-2">
                            <h.icon className="h-4 w-4" />
                            <span className="text-sm font-medium text-white">{h.label}</span>
                            {h.installed === true ? (
                              <span className="ml-auto rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                                Detected
                              </span>
                            ) : h.installed === false ? (
                              <span className="ml-auto rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                                Not detected
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 text-[11px] text-zinc-500">{h.hint}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Workspace */}
                  <div>
                    <label className="mb-1.5 block text-xs text-zinc-400">
                      Worker workspace <span className="text-cyan-400/80">(required)</span>
                    </label>
                    {workspace ? (
                      <div className="flex items-center gap-2 rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3">
                        <FolderOpen className="h-4 w-4 shrink-0 text-cyan-300" />
                        <span className="truncate font-mono text-xs text-zinc-200">
                          {workspace.rootPath}
                        </span>
                        <button
                          type="button"
                          onClick={() => setWorkspace(null)}
                          className="ml-auto text-xs text-zinc-500 hover:text-white"
                        >
                          Clear
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={pickingWorkspace || !device.connectorOnline}
                        onClick={handlePickWorkspace}
                        className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-zinc-300 transition-all hover:border-white/20 hover:bg-white/5 disabled:opacity-50"
                      >
                        {pickingWorkspace ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Waiting for the folder picker…
                          </>
                        ) : (
                          <>
                            <FolderOpen className="h-4 w-4" />
                            Choose a folder on your machine
                          </>
                        )}
                      </button>
                    )}
                    <p className="mt-1.5 text-[11px] text-zinc-600">
                      Choose the project folder this agent is allowed to work in. You can change it later.
                    </p>
                  </div>

                  {agentError && (
                    <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      <span className="flex-1">{agentError}</span>
                      <button
                        type="button"
                        onClick={() => setAgentError(null)}
                        className="text-xs text-zinc-500 hover:text-white"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>

                <div className="mt-6 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => goToStep("brain")}
                    className="rounded-xl px-5 py-3 text-sm text-zinc-400 transition-all hover:bg-white/5 hover:text-white"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={!canCreateAgent}
                    onClick={handleCreateAgent}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-500 px-5 py-3 text-sm font-medium text-black transition-all hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {creatingAgent ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Creating worker…
                      </>
                    ) : (
                      <>
                        Create worker agent
                        <ArrowRight className="h-4 w-4" />
                      </>
                    )}
                  </button>
                </div>
                <p className="mt-3 text-center text-xs text-zinc-600">
                  <button
                    type="button"
                    onClick={() => goToStep("first_task")}
                    className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
                  >
                    Skip for now
                  </button>
                </p>
              </motion.div>
            )}

            {/* 6. First task */}
            {step === "first_task" && (
              <motion.div key="first_task" {...stepMotion} className="relative z-10">
                <div className="mb-8 text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-violet-500/20 bg-violet-500/10">
                    <Play className="h-7 w-7 text-violet-300" />
                  </div>
                  <h2 className="mb-2 text-2xl font-semibold text-white">
                    Put {firstTaskAgent?.name || "your agent"} to work
                  </h2>
                  <p className="text-sm text-zinc-500">
                    Give it a first task and watch it run — this is the whole point.
                  </p>
                </div>

                {!firstAgentId ? (
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-5 text-center">
                    <p className="text-sm text-amber-200">
                      No agent yet — create one first to run a task.
                    </p>
                    <button
                      type="button"
                      onClick={() => goToStep("first_agent")}
                      className="mt-3 inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-medium text-black hover:bg-cyan-400 transition-all"
                    >
                      <Bot className="h-4 w-4" />
                      Create an agent
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4 rounded-2xl border border-white/10 bg-zinc-900/80 p-6">
                    <div>
                      <label className="mb-1.5 block text-xs text-zinc-400">Task prompt</label>
                      <textarea
                        value={taskPrompt}
                        onChange={(e) => setTaskPrompt(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            void handleRunFirstTask();
                          }
                        }}
                        rows={3}
                        className="w-full resize-none rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder-zinc-600 outline-none transition-colors focus:border-cyan-500/50"
                      />
                    </div>

                    {taskError && (
                      <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        <span className="flex-1">{taskError}</span>
                        <button
                          type="button"
                          onClick={() => void handleRunFirstTask()}
                          className="text-xs underline underline-offset-2 hover:text-white"
                        >
                          Retry
                        </button>
                      </div>
                    )}

                    {!liveTask ? (
                      <button
                        type="button"
                        disabled={!taskPrompt.trim() || submittingTask}
                        onClick={handleRunFirstTask}
                        className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-500 px-4 py-3 text-sm font-medium text-black transition-all hover:bg-cyan-400 disabled:opacity-40"
                      >
                        {submittingTask ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Dispatching…
                          </>
                        ) : (
                          <>
                            <Send className="h-4 w-4" />
                            Run task
                          </>
                        )}
                      </button>
                    ) : (
                      <div className="space-y-3 rounded-xl border border-white/10 bg-black/40 p-4">
                        {/* Status track */}
                        <div className="flex items-center gap-2">
                          {(["queued", "running", "done"] as const).map((stage, i) => {
                            const status = liveTask.status;
                            const stageIdx =
                              status === "queued" ? 0 : status === "running" ? 1 : 2;
                            const isDone = i < stageIdx || (i === 2 && status === "done");
                            const isCurrent = i === stageIdx && status !== "done";
                            const failed =
                              (status === "failed" || status === "canceled") && i === stageIdx;
                            return (
                              <div key={stage} className="flex flex-1 items-center gap-2">
                                {isDone ? (
                                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                                ) : failed ? (
                                  <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
                                ) : isCurrent ? (
                                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cyan-400" />
                                ) : (
                                  <span className="block h-4 w-4 shrink-0 rounded-full border border-zinc-700" />
                                )}
                                <span
                                  className={`text-xs capitalize ${
                                    isDone
                                      ? "text-emerald-300"
                                      : isCurrent
                                        ? "text-white"
                                        : "text-zinc-600"
                                  }`}
                                >
                                  {stage}
                                </span>
                                {i < 2 && <span className="h-px flex-1 bg-zinc-800" />}
                              </div>
                            );
                          })}
                        </div>

                        {liveTask.status === "failed" && (
                          <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-200">
                            {liveTask.error || "The task failed."}
                            <button
                              type="button"
                              onClick={() => {
                                setLocalTask(null);
                                setFirstTaskId(null);
                              }}
                              className="ml-2 underline underline-offset-2 hover:text-white"
                            >
                              Try again
                            </button>
                          </div>
                        )}

                        {liveTask.result_text && (
                          <motion.pre
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/5 bg-zinc-950/80 p-3 font-mono text-xs leading-relaxed text-zinc-300"
                          >
                            {liveTask.result_text}
                          </motion.pre>
                        )}

                        {liveTask.status === "done" && (
                          <div className="flex items-center gap-2 text-sm text-emerald-300">
                            <Sparkles className="h-4 w-4" />
                            Your workforce just did its first job.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-6 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => goToStep("first_agent")}
                    className="rounded-xl px-5 py-3 text-sm text-zinc-400 transition-all hover:bg-white/5 hover:text-white"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => goToStep("channels")}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-medium transition-all ${
                      liveTask?.status === "done"
                        ? "bg-cyan-500 text-black hover:bg-cyan-400"
                        : "border border-white/10 text-zinc-300 hover:bg-white/5"
                    }`}
                  >
                    {liveTask
                      ? liveTask.status === "done"
                        ? "Continue"
                        : "Continue — it keeps running"
                      : "Skip for now"}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </motion.div>
            )}

            {/* 7. Channels */}
            {step === "channels" && (
              <motion.div key="channels" {...stepMotion} className="relative z-10">
                <div className="mb-6 text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-500/20 bg-cyan-500/10">
                    <MessageSquare className="h-7 w-7 text-cyan-300" />
                  </div>
                  <h2 className="mb-2 text-2xl font-semibold text-white">
                    Reach your workforce anywhere
                  </h2>
                  <p className="text-sm text-zinc-500">
                    Optional — connect chat channels and pick where heartbeats go.
                  </p>
                </div>

                {/* Tabs */}
                <div className="mb-4 flex justify-center gap-1 rounded-full border border-white/5 bg-black/40 p-1 backdrop-blur-xl">
                  {(
                    [
                      { id: "whatsapp" as const, label: "WhatsApp", icon: Smartphone },
                      { id: "telegram" as const, label: "Telegram", icon: Send },
                      { id: "heartbeat" as const, label: "Heartbeat", icon: Zap },
                    ]
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setChannelsTab(tab.id)}
                      className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium transition-all ${
                        channelsTab === tab.id
                          ? "bg-cyan-500/15 text-cyan-200"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      <tab.icon className="h-3.5 w-3.5" />
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
                  {channelsTab === "whatsapp" && (
                    <WhatsAppStep
                      hideHeader
                      connectorOnline={device.connectorOnline}
                      personalWhatsAppConnected={device.health.whatsappStatus === "healthy"}
                      initialMode={
                        savedWhatsAppMode ||
                        (device.health.whatsappStatus === "healthy" ? "personal" : null)
                      }
                      onModeChange={(mode) => {
                        setSavedWhatsAppMode(mode);
                        void persist({ onboardingData: { whatsappMode: mode } });
                      }}
                      onConfigureWhatsApp={(groupName) =>
                        writeConnectorWhatsAppConfig(true, groupName)
                      }
                      onDisablePersonalWhatsApp={() => writeConnectorWhatsAppConfig(false, "")}
                      onContinue={() => setChannelsTab("telegram")}
                    />
                  )}
                  {channelsTab === "telegram" && (
                    <TelegramStep
                      hideHeader
                      onModeChange={(mode) =>
                        void persist({ onboardingData: { telegramMode: mode } })
                      }
                      onContinue={() => setChannelsTab("heartbeat")}
                    />
                  )}
                  {channelsTab === "heartbeat" && (
                    <div>
                      <p className="mb-4 text-sm text-zinc-400">
                        Heartbeats are short periodic updates from your agents. Where should they
                        go?
                      </p>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        {(
                          [
                            { id: "whatsapp" as const, label: "WhatsApp" },
                            { id: "telegram" as const, label: "Telegram" },
                            { id: "both" as const, label: "Both" },
                          ]
                        ).map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => saveHeartbeatChannel(c.id)}
                            className={`rounded-xl border p-4 text-center text-sm transition-all ${
                              heartbeatChannel === c.id
                                ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-100"
                                : "border-white/10 bg-black/30 text-zinc-400 hover:border-white/20"
                            }`}
                          >
                            {heartbeatChannel === c.id && (
                              <Check className="mx-auto mb-1 h-4 w-4 text-cyan-300" />
                            )}
                            {c.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-6 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => goToStep("first_task")}
                    className="rounded-xl px-5 py-3 text-sm text-zinc-400 transition-all hover:bg-white/5 hover:text-white"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => goToStep("done")}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-500 px-5 py-3 text-sm font-medium text-black transition-all hover:bg-cyan-400"
                  >
                    Finish setup
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-3 text-center text-xs text-zinc-600">
                  <button
                    type="button"
                    onClick={() => goToStep("done")}
                    className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
                  >
                    Skip channels
                  </button>
                </p>
              </motion.div>
            )}

            {/* 8. Done */}
            {step === "done" && (
              <motion.div key="done" {...stepMotion} className="relative z-10 text-center">
                <motion.div
                  initial={{ scale: 0.7, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 220, damping: 18 }}
                  className="mx-auto mb-8 flex h-20 w-20 items-center justify-center rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/15 to-cyan-500/10"
                >
                  <Rocket className="h-10 w-10 text-emerald-400" />
                </motion.div>
                <motion.h2
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.15 }}
                  className="mb-3 text-3xl font-semibold text-white"
                >
                  Your workforce is on the clock.
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3 }}
                  className="mx-auto mb-10 max-w-md text-zinc-400"
                >
                  Agents on your machines, an orchestrator to run them, and a command bar to tell
                  them what matters. Go delegate something.
                </motion.p>
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.45 }}
                >
                  <button
                    type="button"
                    onClick={handleFinish}
                    disabled={finishing}
                    className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-8 py-3.5 text-sm font-semibold text-black transition-all hover:bg-cyan-400 disabled:opacity-60"
                  >
                    {finishing ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Opening the dashboard…
                      </>
                    ) : (
                      <>
                        Enter the dashboard
                        <ArrowRight className="h-4 w-4" />
                      </>
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

/** Browser (non-desktop-shell) connector setup: download CTA + standalone fallback. */
function BrowserConnectorSetup({
  connectorOnline,
  onRefreshConnector,
  desktopDownloadSupported,
}: {
  connectorOnline: boolean;
  onRefreshConnector: () => void;
  desktopDownloadSupported: boolean;
}) {
  const [showStandalone, setShowStandalone] = useState(false);

  if (connectorOnline) {
    return (
      <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.07] p-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/25 bg-emerald-500/10">
            <CheckCircle2 className="h-6 w-6 text-emerald-400" />
          </span>
          <div>
            <p className="text-base font-medium text-emerald-200">Groovy is ready</p>
            <p className="mt-1 text-sm text-zinc-400">
              The connector inside Groovy Desktop is online and ready to run agents.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!desktopDownloadSupported) {
    return (
      <div className="grid gap-4 md:grid-cols-[1fr,260px]">
        <div className="space-y-5 rounded-2xl border border-white/10 bg-zinc-900/80 p-6">
          <div>
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
              Windows setup
            </span>
            <h3 className="mt-4 text-lg font-semibold text-white">Install the standalone connector</h3>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              Groovy Desktop is currently macOS-only. The Windows connector provides the same local
              agent runtime and requires a one-time pairing code.
            </p>
          </div>
          <ConnectorPairingSection />
        </div>
        <ConnectorStatusCard
          connectorOnline={connectorOnline}
          onRefreshConnector={onRefreshConnector}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-zinc-900/80 p-6">
        <div className="flex flex-col items-center text-center">
          <span className="mb-3 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">
            Recommended
          </span>
          <h3 className="text-lg font-semibold text-white">Install one app</h3>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-zinc-400">
            Groovy Desktop contains the connector that runs agents on your machine. You do not
            need to download or pair the standalone connector separately.
          </p>

          <div className="my-5 grid w-full gap-2 text-left sm:grid-cols-3">
            {[
              ["1", "Download", "Get the signed Groovy DMG."],
              ["2", "Install", "Drag Groovy to Applications."],
              ["3", "Open & sign in", "The connector starts and pairs itself."],
            ].map(([number, title, description]) => (
              <div key={number} className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-md bg-cyan-500/15 text-[10px] font-semibold text-cyan-300">
                    {number}
                  </span>
                  <span className="text-xs font-medium text-zinc-200">{title}</span>
                </div>
                <p className="mt-2 text-[10px] leading-4 text-zinc-500">{description}</p>
              </div>
            ))}
          </div>

          <a
            href="/account/downloads?recommended=desktop"
            className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-6 py-3 text-sm font-semibold text-black transition-all hover:bg-cyan-400"
          >
            <Download className="h-4 w-4" />
            Download Groovy for macOS
          </a>
          <p className="mt-2 text-[10px] text-zinc-600">macOS 12+ · Apple Silicon</p>

          <button
            type="button"
            onClick={() => setShowStandalone((v) => !v)}
            className="mt-5 text-xs text-zinc-500 underline underline-offset-2 transition-colors hover:text-zinc-300"
          >
            Advanced: install only the standalone connector
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {showStandalone && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="grid gap-4 md:grid-cols-[1fr,260px]">
              <div className="space-y-5 rounded-2xl border border-white/10 bg-zinc-900/80 p-6">
                <ConnectorPairingSection />
              </div>
              <ConnectorStatusCard
                connectorOnline={connectorOnline}
                onRefreshConnector={onRefreshConnector}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!showStandalone && (
        <div className="flex items-center justify-center gap-2 text-xs text-zinc-600">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Waiting for Groovy Desktop to connect…
          <button
            type="button"
            onClick={onRefreshConnector}
            className="underline underline-offset-2 hover:text-zinc-300"
          >
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
