"use client";

/**
 * HarnessDashboard — the agent super app.
 *
 * Layout:
 *   header      — brand, connector status, usage, settings
 *   worker grid — your agents, working side by side
 *   command bar — talk to the orchestrator (model picker, @mentions)
 *   side rail   — the orchestrator's chat + live task feed
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  CalendarClock,
  ChevronRight,
  FileText,
  Loader2,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Plug,
  Settings,
  Wifi,
  WifiOff,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useOrchestrator } from "@/hooks/useOrchestrator";
import { useConnectorDevice } from "@/hooks/useConnectorDevice";
import { useConnectorExecute } from "@/hooks/useConnectorExecute";
import { useWorkerAgents } from "@/hooks/useWorkerAgents";
import { useWorkerGrid } from "@/hooks/useWorkerGrid";
import { useAgentTasks } from "@/hooks/useAgentTasks";
import { useSettingsState } from "@/hooks/useSettingsState";
import { useOnboardingGate } from "@/hooks/useOnboardingGate";
import { useConnectorInstallGuide } from "@/lib/connector/installGuide";
import { HarnessOnboarding } from "@/components/onboarding/HarnessOnboarding";
import { HarnessChecklist } from "@/components/onboarding/HarnessChecklist";
import { useDesktopAutoPair } from "@/hooks/useDesktopAutoPair";
import { useLicenseAccess } from "@/hooks/useLicenseAccess";
import { DesktopUpdateBadge } from "@/components/desktop/DesktopUpdateBadge";
import { LicenseAccessGate } from "@/components/licensing/LicenseAccessGate";
import { MIN_CONNECTOR_VERSION } from "@/lib/connector/version";
import { WorkerGrid } from "@/components/harness/WorkerGrid";
import {
  OrchestratorBar,
  type OrchestratorModelSelection,
} from "@/components/harness/OrchestratorBar";
import { OrchestratorRail } from "@/components/harness/OrchestratorRail";
import { NewAgentModal } from "@/components/harness/NewAgentModal";
import { TransferContextModal } from "@/components/harness/TransferContextModal";
import { AgentDrawer } from "@/components/harness/AgentDrawer";
import { SettingsModal } from "@/components/command-center/SettingsModal";
import { SchedulePanel } from "@/components/command-center/SchedulePanel";
import { PlansBrowser } from "@/components/claude/PlansBrowser";
import { useClaudePlans, type ClaudePlan } from "@/hooks/useClaudePlans";
import { canonicalWorkspacePath } from "@/lib/workspaces/path";
import { AppNav } from "@/components/AppNav";

export default function HarnessDashboard() {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const connectorGuide = useConnectorInstallGuide();
  // Inside the Groovy Desktop shell this silently pairs the bundled connector
  // to the signed-in account; the connector status pill reflects the result.
  const desktopAutoPair = useDesktopAutoPair();

  // ---- Auth ----
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  useEffect(() => {
    (async () => {
      const {
        data: { user: authedUser },
        error,
      } = await supabase.auth.getUser();
      if (error || !authedUser) {
        router.push("/login");
        return;
      }
      setUser({ id: authedUser.id, email: authedUser.email || undefined });
      setAuthLoading(false);
    })();
  }, [supabase, router]);

  // ---- Device / relay ----
  const device = useConnectorDevice();
  const { connectorExecute } = useConnectorExecute({
    relay: device.relay,
    activeDeviceId: device.activeDeviceId,
  });

  // ---- Orchestrator ----
  const orchestrator = useOrchestrator({ onConnectorExecute: connectorExecute });

  // ---- Workers + grid + tasks ----
  const workers = useWorkerAgents({
    relay: device.relay,
    activeDeviceId: device.activeDeviceId,
  });
  const grid = useWorkerGrid();
  const taskFeed = useAgentTasks({ userId: user?.id || null });

  // ---- Onboarding gate (harness flow) ----
  const onboarding = useOnboardingGate();
  const licenseAccess = useLicenseAccess();
  const onboardingFirstAgentId =
    typeof onboarding.onboardingData.firstAgentCreated === "string"
      ? onboarding.onboardingData.firstAgentCreated
      : null;
  const onboardingAgentAddedToGrid =
    typeof onboarding.onboardingData.onboardingAgentAddedToGrid === "string"
      ? onboarding.onboardingData.onboardingAgentAddedToGrid
      : null;
  const onboardingGridHandoffRef = useRef<string | null>(null);

  // ---- Settings ----
  const settings = useSettingsState(user?.id || null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSchedules, setShowSchedules] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<ClaudePlan | null>(null);
  const [runningScheduledJobs, setRunningScheduledJobs] = useState<Set<string>>(new Set());
  const scheduledJobRequestIdsRef = useRef<Map<string, string>>(new Map());
  const scheduledJobTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearRunningScheduledJob = useCallback((jobId: string) => {
    const timeout = scheduledJobTimeoutsRef.current.get(jobId);
    if (timeout) clearTimeout(timeout);
    scheduledJobTimeoutsRef.current.delete(jobId);
    for (const [requestId, requestedJobId] of scheduledJobRequestIdsRef.current) {
      if (requestedJobId === jobId) scheduledJobRequestIdsRef.current.delete(requestId);
    }
    setRunningScheduledJobs((prev) => {
      if (!prev.has(jobId)) return prev;
      const next = new Set(prev);
      next.delete(jobId);
      return next;
    });
  }, []);

  useEffect(
    () => () => {
      for (const timeout of scheduledJobTimeoutsRef.current.values()) clearTimeout(timeout);
      scheduledJobTimeoutsRef.current.clear();
      scheduledJobRequestIdsRef.current.clear();
    },
    []
  );

  useEffect(
    () =>
      device.relay.subscribe((message) => {
        const type = (message as { type?: unknown }).type;
        if (type === "schedule_status_result") {
          if ((message as { ok?: unknown }).ok !== true) return;
          const activeJobIdsValue = (message as unknown as { active_job_ids?: unknown })
            .active_job_ids;
          const activeJobIds = new Set(
            Array.isArray(activeJobIdsValue)
              ? activeJobIdsValue
                  .map((value) => String(value || ""))
                  .filter(Boolean)
              : []
          );
          for (const jobId of scheduledJobTimeoutsRef.current.keys()) {
            if (!activeJobIds.has(jobId)) clearRunningScheduledJob(jobId);
          }
          setRunningScheduledJobs(activeJobIds);
          return;
        }
        if (type !== "schedule_run_report" && type !== "schedule_trigger_result") return;
        const requestId = String((message as { request_id?: unknown }).request_id || "");
        const jobId =
          String((message as { job_id?: unknown }).job_id || "") ||
          scheduledJobRequestIdsRef.current.get(requestId) ||
          "";
        if (!jobId) return;
        if (
          type === "schedule_run_report" ||
          (message as { ok?: unknown }).ok === false
        ) {
          clearRunningScheduledJob(jobId);
        }
      }),
    [clearRunningScheduledJob, device.relay]
  );

  useEffect(() => {
    if (!showSchedules || device.relay.status !== "ready" || !device.activeDeviceId) return;
    device.relay.send({
      type: "schedule_status_request",
      request_id: `schedule-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      device_id: device.activeDeviceId,
    });
  }, [device.activeDeviceId, device.relay, device.relay.status, showSchedules]);

  const triggerScheduledJob = useCallback(
    (jobId: string, jobDeviceId?: string | null) => {
      const targetDeviceId = jobDeviceId?.trim() || device.activeDeviceId;
      if (!targetDeviceId || device.relay.status !== "ready") return;
      const requestId = `trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sent = device.relay.send({
        type: "schedule_trigger",
        request_id: requestId,
        device_id: targetDeviceId,
        job_id: jobId,
      });
      if (sent) {
        scheduledJobRequestIdsRef.current.set(requestId, jobId);
        const priorTimeout = scheduledJobTimeoutsRef.current.get(jobId);
        if (priorTimeout) clearTimeout(priorTimeout);
        scheduledJobTimeoutsRef.current.set(
          jobId,
          setTimeout(() => clearRunningScheduledJob(jobId), 30 * 60 * 1000)
        );
        setRunningScheduledJobs((prev) => new Set(prev).add(jobId));
      }
    },
    [clearRunningScheduledJob, device.activeDeviceId, device.relay]
  );

  const planWorkspaceRoots = useMemo(
    () =>
      Array.from(
        new Set(
          workers.agents
            .map((agent) => agent.workspaceRootPath)
            .filter((root): root is string => !!root)
        )
      ),
    [workers.agents]
  );
  const plans = useClaudePlans({
    relaySend: device.relay.send,
    relaySubscribe: device.relay.subscribe,
    relayStatus: device.relay.status,
    activeDeviceId: device.activeDeviceId,
    workspaceRoots: planWorkspaceRoots,
  });

  const queuePlanExecution = useCallback(
    async (plan: ClaudePlan, agentId: string) => {
      const agent = workers.agents.find((candidate) => candidate.id === agentId);
      const normalizedPlanRoot = canonicalWorkspacePath(plan.workspaceRoot);
      const normalizedAgentRoot = canonicalWorkspacePath(agent?.workspaceRootPath);
      if (!agent || !normalizedAgentRoot || normalizedAgentRoot !== normalizedPlanRoot) {
        return {
          ok: false,
          error: `Choose an agent attached to ${plan.workspaceRoot}. Plans cannot run against a different project.`,
        };
      }
      const res = await fetch("/api/agents/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: agentId,
          title: `Execute plan: ${plan.title || plan.filename}`,
          prompt: `Execute the approved plan from ${plan.filename}. Follow it step by step, verify the result, and report what you completed.`,
          context: `[APPROVED PLAN]\n${plan.content}`,
          expectedWorkspaceRoot: plan.workspaceRoot,
        }),
      });
      if (res.ok) {
        void taskFeed.refresh();
        setShowPlans(false);
      }
      const body = await res.json().catch(() => ({}));
      return {
        ok: res.ok,
        error: !res.ok && typeof body?.error === "string" ? body.error : undefined,
      };
    },
    [taskFeed, workers.agents]
  );

  const handleExecutePlan = useCallback(
    async (
      plan: ClaudePlan,
      target: { type: "orchestrator" } | { type: "agent"; agentId: string } | { type: "new_agent" }
    ) => {
      if (target.type === "agent") {
        return queuePlanExecution(plan, target.agentId);
      }
      if (target.type === "orchestrator") {
        const result = await orchestrator.sendMessage(
          `Execute this approved implementation plan for workspace ${plan.workspaceRoot}. Route the work to an agent attached to that exact workspace, monitor it, and report the verified result.\n\n[APPROVED PLAN: ${plan.filename}]\n${plan.content}`,
          {
            memoryEnabled: true,
            deviceId: device.connectorOnline ? device.activeDeviceId || undefined : undefined,
          }
        );
        if (!result?.ok) {
          return {
            ok: false,
            error: result?.error || "Could not send this plan to the orchestrator",
          };
        }
        setShowPlans(false);
        setRailOpen(true);
        return { ok: true };
      }
      setPendingPlan(plan);
      setShowPlans(false);
      setShowNewAgent(true);
      return { ok: true };
    },
    [device.activeDeviceId, device.connectorOnline, orchestrator, queuePlanExecution]
  );

  // ---- Orchestrator model selection ----
  const [modelSelection, setModelSelection] = useState<OrchestratorModelSelection>({
    provider: null,
    model: null,
    reasoningEffort: null,
  });
  const modelSelectionSaveIdRef = useRef(0);
  useEffect(() => {
    if (!user) return;
    fetch("/api/orchestrator/model", { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        setModelSelection({
          provider: json?.provider === "openai" ? "openai" : json?.model ? "anthropic" : null,
          model: typeof json?.model === "string" ? json.model : null,
          reasoningEffort:
            typeof json?.reasoningEffort === "string" ? json.reasoningEffort : null,
        });
      })
      .catch(() => {});
  }, [user]);
  const changeModel = useCallback(async (selection: OrchestratorModelSelection) => {
    const saveId = ++modelSelectionSaveIdRef.current;
    try {
      const response = await fetch("/api/orchestrator/model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || saveId !== modelSelectionSaveIdRef.current) return;
      setModelSelection({
        provider: json?.provider === "openai" ? "openai" : json?.model ? "anthropic" : null,
        model: typeof json?.model === "string" ? json.model : null,
        reasoningEffort:
          typeof json?.reasoningEffort === "string" ? json.reasoningEffort : null,
      });
    } catch {}
  }, []);

  // ---- UI state ----
  const [railOpen, setRailOpen] = useState(true);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [focusedAgentActive, setFocusedAgentActive] = useState(false);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [configureAgentId, setConfigureAgentId] = useState<string | null>(null);
  const [transferFromId, setTransferFromId] = useState<string | null>(null);
  const gridHydrated = grid.hydrated;
  const gridPanes = grid.panes;
  const addGridPane = grid.addPane;
  const latestOrchestratorMessage = useMemo(
    () => [...orchestrator.messages].reverse().find((message) => message.role === "assistant"),
    [orchestrator.messages]
  );
  const mobileOpenTaskCount = useMemo(
    () =>
      taskFeed.tasks.filter((task) =>
        ["queued", "running", "awaiting_approval"].includes(task.status)
      ).length,
    [taskFeed.tasks]
  );
  const mobileApprovalCount = useMemo(
    () => taskFeed.tasks.filter((task) => task.status === "awaiting_approval").length,
    [taskFeed.tasks]
  );

  // First-run nicety: populate the grid with existing agents — but ONLY when
  // no stored layout exists. A user-authored empty layout stays empty.
  useEffect(() => {
    if (!grid.hydrated || workers.isLoading) return;
    if (grid.hydrationSource !== "none") return;
    if (grid.panes.length === 0 && workers.agents.length > 0) {
      for (const agent of workers.agents.slice(0, 4)) {
        grid.addPane(agent.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.hydrated, grid.hydrationSource, workers.isLoading]);

  // Finishing onboarding can reveal a previously saved legacy grid. Preserve
  // that layout, but append the worker created during onboarding exactly once.
  // Without this handoff the worker exists (and can run tasks) yet remains
  // invisible because stored layouts intentionally suppress auto-population.
  useEffect(() => {
    if (!onboarding.loaded || onboarding.onboardingCompleted !== true) return;
    if (!gridHydrated || workers.isLoading || !onboardingFirstAgentId) return;
    if (onboardingAgentAddedToGrid === onboardingFirstAgentId) return;
    if (onboardingGridHandoffRef.current === onboardingFirstAgentId) return;
    if (!workers.agents.some((agent) => agent.id === onboardingFirstAgentId)) return;

    onboardingGridHandoffRef.current = onboardingFirstAgentId;
    if (!gridPanes.some((pane) => pane.agentId === onboardingFirstAgentId)) {
      addGridPane(onboardingFirstAgentId);
    }
    void fetch("/api/user-preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        onboardingData: { onboardingAgentAddedToGrid: onboardingFirstAgentId },
      }),
    });
  }, [
    onboarding.loaded,
    onboarding.onboardingCompleted,
    onboardingFirstAgentId,
    onboardingAgentAddedToGrid,
    gridHydrated,
    gridPanes,
    addGridPane,
    workers.isLoading,
    workers.agents,
  ]);

  const handleSend = useCallback(
    (message: string, files?: File[]) => {
      orchestrator.sendMessage(message, {
        memoryEnabled: true,
        deviceId: device.connectorOnline ? device.activeDeviceId || undefined : undefined,
        files,
      });
      setRailOpen(true);
    },
    [orchestrator, device.connectorOnline, device.activeDeviceId]
  );

  const handleApprovePlan = useCallback(
    async (taskId: string, executeAgent?: string) => {
      const res = await fetch(`/api/agents/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve_plan", executeAgent }),
      });
      const body = await res.json().catch(() => ({}));
      void taskFeed.refresh();
      return {
        ok: res.ok,
        error:
          !res.ok && typeof body?.error === "string" ? body.error : undefined,
      };
    },
    [taskFeed]
  );

  const handleUpdatePlan = useCallback(
    async (taskId: string, plan: string) => {
      const res = await fetch(`/api/agents/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_plan", plan }),
      });
      const body = await res.json().catch(() => ({}));
      void taskFeed.refresh();
      return {
        ok: res.ok,
        error:
          !res.ok && typeof body?.error === "string" ? body.error : undefined,
      };
    },
    [taskFeed]
  );

  const handleInvestigatePlan = useCallback(
    (input: { planningSessionId: string; agentName: string; objective: string }) => {
      void orchestrator.sendMessage(
        `Investigate this plan further with ${input.agentName}. Focus only on material gaps, contradictions, or risks that could change the implementation.\n\nPlanning session: ${input.planningSessionId}\nObjective: ${input.objective}\n\nUse consult_agent with planning_session_id ${input.planningSessionId}, then revise the evidence-backed plan and call finalize_plan again. Do not make repository changes.`,
        {
          memoryEnabled: true,
          deviceId: device.connectorOnline ? device.activeDeviceId || undefined : undefined,
        }
      );
      setRailOpen(true);
    },
    [orchestrator, device.connectorOnline, device.activeDeviceId]
  );

  // Deep-linked orchestrator asks (e.g. the usage page's "Analyze & optimize").
  const deepLinkHandledRef = useRef(false);
  useEffect(() => {
    // Wait for the session list to settle so the auto-select in loadSessions
    // can't switch the rail away from the deep-linked conversation mid-stream.
    if (authLoading || orchestrator.isLoading || deepLinkHandledRef.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("ask") !== "optimize-costs") return;
    deepLinkHandledRef.current = true;
    params.delete("ask");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`
    );
    handleSend(
      "Run a usage_report for the last 30 days and analyze my spend by agent and model. " +
        "Where task success rates allow it, recommend cheaper model mixes per agent " +
        "(including switching worker model overrides or the orchestrator brain), with " +
        "estimated monthly savings. Be concrete about which agent/model to change and why."
    );
  }, [authLoading, orchestrator.isLoading, handleSend]);

  const handleCreateAgent = useCallback(
    async (input: {
      name: string;
      harness: "claude" | "codex";
      model: string | null;
      reasoningEffort: string | null;
      workspace: { id: string; rootPath: string } | null;
    }) => {
      const created = await workers.createAgent({
        name: input.name,
        harness: input.harness,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        workspace: input.workspace
          ? { id: input.workspace.id, rootPath: input.workspace.rootPath }
          : null,
      });
      if (created) {
        grid.addPane(created.id);
        if (pendingPlan) {
          const plan = pendingPlan;
          setPendingPlan(null);
          void queuePlanExecution(plan, created.id);
        }
        return true;
      }
      return false;
    },
    [workers, grid, pendingPlan, queuePlanExecution]
  );

  const transferFromAgent = useMemo(
    () => workers.agents.find((a) => a.id === transferFromId) || null,
    [workers.agents, transferFromId]
  );
  const configureAgent = useMemo(
    () => workers.agents.find((a) => a.id === configureAgentId) || null,
    [workers.agents, configureAgentId]
  );

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[var(--bg-primary)] flex items-center justify-center">
        <div className="w-10 h-10 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="app-viewport-shell w-full max-w-full bg-[var(--bg-primary)] flex flex-col overflow-hidden">
      {/* Ambient background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-cyan-500/[0.04] rounded-full blur-[160px]" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-violet-500/[0.04] rounded-full blur-[160px]" />
      </div>

      {/* Header */}
      <header className="relative z-10 shrink-0 border-b border-white/5 bg-[var(--bg-primary)]/80 backdrop-blur-xl">
        <div className="px-4 py-2 flex items-center gap-3">
          <Image
            src="/Groovy_no_bg.png"
            alt="Groovy"
            width={140}
            height={40}
            className="h-8 sm:h-10 w-auto"
            unoptimized
            priority
          />
          <AppNav />

          {/* Connector status */}
          <button
            type="button"
            onClick={() => {
              device.refresh();
              setShowSettings(true);
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-all hover:opacity-90 ${
              device.connectorOnline
                ? "bg-emerald-500/10 text-emerald-400"
                : device.relayConnected
                  ? "bg-zinc-800 text-zinc-300"
                  : "bg-zinc-800 text-zinc-500"
            }`}
          >
            {device.connectorOnline ? (
              <Wifi className="w-3 h-3" />
            ) : (
              <WifiOff className="w-3 h-3" />
            )}
            <span className="hidden sm:inline">
              {device.connectorOnline
                ? "Connector online"
                : device.relayConnected
                  ? "Connector offline"
                  : "Relay offline"}
            </span>
            {device.connectorOnline && device.connectorVersion && (
              <span className="hidden lg:inline text-[10px] opacity-70">v{device.connectorVersion}</span>
            )}
          </button>
          {device.connectorOutdated &&
            (device.supportsInPlaceUpdate ? (
              <button
                type="button"
                onClick={device.updateConnector}
                className="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/15 transition-all"
              >
                <AlertTriangle className="w-2.5 h-2.5" />
                Update v{MIN_CONNECTOR_VERSION}
              </button>
            ) : (
              <a
                href={connectorGuide.downloadUrl}
                className="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/15 transition-all"
              >
                Download v{MIN_CONNECTOR_VERSION}
              </a>
            ))}
          <DesktopUpdateBadge />

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowPlans(true)}
              className="h-8 rounded-lg flex items-center gap-1.5 px-2 text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Plans"
            >
              <FileText className="w-4 h-4" />
              <span className="hidden xl:inline text-xs font-medium">Plans</span>
            </button>
            <a
              href="/settings/skills"
              className="h-8 rounded-lg flex items-center gap-1.5 px-2 text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Skills & instruction docs"
            >
              <BookOpen className="w-4 h-4" />
              <span className="hidden lg:inline text-xs font-medium">Skills &amp; Docs</span>
            </a>
            <a
              href="/settings/integrations"
              className="h-8 rounded-lg flex items-center gap-1.5 px-2 text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Integrations"
            >
              <Plug className="w-4 h-4" />
              <span className="hidden xl:inline text-xs font-medium">Integrations</span>
            </a>
            <button
              type="button"
              onClick={() => setShowSchedules(true)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
              title="Schedules"
            >
              <CalendarClock className="w-4 h-4" />
            </button>
            <a
              href="/settings/usage"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
              title="Usage & cost"
            >
              <BarChart3 className="w-4 h-4" />
            </a>
            <a
              href="/settings"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </a>
            <button
              onClick={() => setRailOpen((v) => !v)}
              className="w-8 h-8 rounded-lg hidden md:flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
              title={railOpen ? "Hide orchestrator rail" : "Show orchestrator rail"}
            >
              {railOpen ? (
                <PanelRightClose className="w-4 h-4" />
              ) : (
                <PanelRightOpen className="w-4 h-4" />
              )}
            </button>
            <button
              onClick={() => setMobileRailOpen(true)}
              className="w-8 h-8 rounded-lg flex md:hidden items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
              title="Show tasks and orchestrator history"
            >
              <PanelRightOpen className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {onboarding.loaded && onboarding.onboardingCompleted === true && (
        <LicenseAccessGate
          status={licenseAccess.status}
          loading={licenseAccess.loading}
          error={licenseAccess.error}
          onStartTrial={licenseAccess.startTrial}
        />
      )}

      {/* Main */}
      <div className="relative z-10 flex min-h-0 min-w-0 max-w-full flex-1 overflow-x-clip">
        <main className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-x-clip">
          <div className="flex-1 min-h-0">
            <WorkerGrid
              panes={grid.panes}
              agents={workers.agents}
              openByAgent={taskFeed.openByAgent}
              gridCols={grid.gridCols}
              onAddAgent={() => setShowNewAgent(true)}
              onShowAgent={grid.addPane}
              onHideAgent={grid.removeAgentPanes}
              onGridColsChange={grid.setGridCols}
              onConfigure={setConfigureAgentId}
              onTransferContext={setTransferFromId}
              onMovePane={grid.movePane}
              onRemovePane={grid.removePane}
              onFocusedAgentChange={setFocusedAgentActive}
            />
          </div>

          {/* Command bar */}
          {!focusedAgentActive && (
            <div className="shrink-0 px-4 pb-[calc(1rem+var(--safe-area-inset-bottom))] pt-1">
              {(orchestrator.isStreaming || latestOrchestratorMessage || mobileOpenTaskCount > 0) && (
              <button
                type="button"
                onClick={() => setMobileRailOpen(true)}
                className="mb-1.5 flex h-9 min-h-0 w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-zinc-900/90 px-2.5 text-left shadow-md backdrop-blur md:hidden"
                aria-label="Open orchestrator activity"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-cyan-500/10 text-cyan-300">
                  {orchestrator.isStreaming ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <MessageSquare className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="shrink-0 text-[10px] font-medium text-zinc-300">
                  {orchestrator.isStreaming ? "Working" : "Update"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-500" aria-live="polite">
                  {orchestrator.isStreaming
                    ? orchestrator.streamingContent || "Thinking…"
                    : latestOrchestratorMessage?.content || "Open orchestrator"}
                </span>
                {mobileOpenTaskCount > 0 && (
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] ${
                      mobileApprovalCount > 0
                        ? "bg-amber-400 text-black"
                        : "bg-cyan-400/15 text-cyan-300"
                    }`}
                  >
                    {mobileApprovalCount || mobileOpenTaskCount}
                  </span>
                )}
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
              </button>
              )}
              <OrchestratorBar
                agents={workers.agents}
                isStreaming={orchestrator.isStreaming}
                modelSelection={modelSelection}
                onModelChange={changeModel}
                onSend={handleSend}
                onCancel={orchestrator.cancelStream}
              />
            </div>
          )}
        </main>

        {/* Rail */}
        {railOpen && (
          <aside className="w-[340px] shrink-0 hidden md:flex flex-col min-h-0">
            <OrchestratorRail
              messages={orchestrator.messages}
              isStreaming={orchestrator.isStreaming}
              streamingContent={orchestrator.streamingContent}
              tasks={taskFeed.tasks}
              agents={workers.agents}
              onTaskAction={(taskId, action) => void taskFeed.act(taskId, action)}
              onApprovePlan={handleApprovePlan}
              onUpdatePlan={handleUpdatePlan}
              onInvestigatePlan={handleInvestigatePlan}
            />
          </aside>
        )}

        {mobileRailOpen && (
          <div className="fixed inset-0 z-40 md:hidden bg-black/60 backdrop-blur-sm">
            <aside className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col border-l border-white/10 bg-[var(--bg-primary)] shadow-2xl">
              <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/5 px-3">
                <span className="text-sm font-medium text-white">Tasks &amp; orchestrator</span>
                <button
                  type="button"
                  onClick={() => setMobileRailOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/10 hover:text-white"
                  aria-label="Close tasks and orchestrator history"
                >
                  <PanelRightClose className="h-4 w-4" />
                </button>
              </div>
              <OrchestratorRail
                messages={orchestrator.messages}
                isStreaming={orchestrator.isStreaming}
                streamingContent={orchestrator.streamingContent}
                tasks={taskFeed.tasks}
                agents={workers.agents}
                onTaskAction={(taskId, action) => void taskFeed.act(taskId, action)}
                onApprovePlan={handleApprovePlan}
                onUpdatePlan={handleUpdatePlan}
                onInvestigatePlan={handleInvestigatePlan}
              />
            </aside>
          </div>
        )}
      </div>

      {/* Modals */}
      <NewAgentModal
        isOpen={showNewAgent}
        onClose={() => {
          setShowNewAgent(false);
          setPendingPlan(null);
        }}
        onCreate={handleCreateAgent}
        onPickWorkspace={workers.pickWorkspace}
        claudeCliInstalled={device.capabilities.claudeCliInstalled}
        codexCliInstalled={device.capabilities.codexCliInstalled}
        connectorOnline={device.connectorOnline}
        requiredWorkspaceRoot={pendingPlan?.workspaceRoot || null}
      />
      <TransferContextModal
        isOpen={!!transferFromAgent}
        fromAgent={transferFromAgent}
        agents={workers.agents}
        onClose={() => setTransferFromId(null)}
      />
      <AgentDrawer
        agent={configureAgent}
        capabilities={device.capabilities}
        connectorOnline={device.connectorOnline}
        onClose={() => setConfigureAgentId(null)}
        onUpdateAgent={workers.updateAgent}
        onRenameAgent={workers.renameAgent}
        onDeleteAgent={async (agentId) => {
          const ok = await workers.deleteAgent(agentId);
          if (ok) {
            grid.removeAgentPanes(agentId);
            setConfigureAgentId(null);
          }
          return ok;
        }}
        onPickWorkspace={workers.pickWorkspace}
        onRefreshAgents={workers.refresh}
      />
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        onSave={settings.saveKeys}
        currentKeys={settings.apiKeys}
        currentKeyMode={settings.llmKeyMode}
        currentKeyModes={settings.llmKeyModes}
        serverProviderKeysAllowed={settings.serverProviderKeysAllowed}
        currentUserEmail={user?.email || null}
        currentOrchestratorSessionId={orchestrator.currentSessionId}
        currentOrchestratorAgentId={orchestrator.getAgentIdForSession(
          orchestrator.currentSessionId
        )}
        focusSection={undefined}
        onSignOut={async () => {
          await supabase.auth.signOut();
          router.push("/login");
        }}
        onConnectorModeChanged={device.setConnectorMode}
        activeDeviceId={device.activeDeviceId}
        connectorOnline={device.connectorOnline}
        connectorVersion={device.connectorVersion}
        minConnectorVersion={MIN_CONNECTOR_VERSION}
        connectorSupportsInPlaceUpdate={device.supportsInPlaceUpdate}
        connectorDownloadUrl={connectorGuide.downloadUrl}
        onRefreshConnector={device.refresh}
        onRestartConnector={device.restartConnector}
        onUpdateConnector={device.updateConnector}
      />
      <SchedulePanel
        isOpen={showSchedules}
        onClose={() => setShowSchedules(false)}
        onTriggerJob={triggerScheduledJob}
        runningJobIds={runningScheduledJobs}
      />
      {showPlans && (
        <div className="fixed inset-0 z-50 bg-black/70 p-3 backdrop-blur-sm sm:p-6">
          <div className="mx-auto h-full max-w-5xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl">
            <PlansBrowser
              plans={plans.plans}
              isLoading={plans.isLoading}
              error={plans.error}
              onRefresh={plans.refresh}
              codeAgents={workers.agents.map((agent) => ({
                id: agent.id,
                name: agent.name,
                codeCliProvider: agent.harness,
                deviceId: agent.deviceId,
                workspaceRootPath: agent.workspaceRootPath,
              }))}
              onExecute={handleExecutePlan}
              onClose={() => setShowPlans(false)}
            />
          </div>
        </div>
      )}

      {/* Onboarding overlay / post-onboarding checklist */}
      {onboarding.loaded && onboarding.onboardingCompleted === false && (
        <HarnessOnboarding
          autoPair={desktopAutoPair}
          onComplete={() => void onboarding.refetch()}
        />
      )}
      {onboarding.loaded && onboarding.onboardingCompleted === true && (
        <HarnessChecklist
          onboardingData={onboarding.onboardingData}
          connectorOnline={device.connectorOnline}
          agentsCount={workers.agents.length}
          tasksCount={taskFeed.tasks.length}
          onAddAgent={() => setShowNewAgent(true)}
        />
      )}
    </div>
  );
}
