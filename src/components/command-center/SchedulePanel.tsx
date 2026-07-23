"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  X,
  RefreshCw,
  Clock,
  Trash2,
  PauseCircle,
  PlayCircle,
  SkipForward,
  Copy,
  Loader2,
  History,
  ChevronDown,
  ChevronUp,
  Pencil,
} from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  MODEL_CATALOG,
  catalogModelLabel,
  inferProviderForModelId,
  reasoningEffortsForModel,
} from "@/lib/ai/modelCatalog";

type ScheduledJob = {
  id: string;
  name: string;
  device_id?: string | null;
  kind?: "shell" | "orchestrator" | string;
  command: string | null;
  task?: unknown;
  schedule: unknown;
  enabled: boolean;
  skip_next_run: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_exit_code: number | null;
  updated_at: string | null;
  session_id?: string | null;
  session_title?: string | null;
  target_agent_id?: string | null;
  target_agent_name?: string | null;
};

type WorkerOption = {
  id: string;
  name: string;
  harness: "claude" | "codex";
  configured: boolean;
};

type ScheduledJobRun = {
  id: string;
  job_id: string;
  status: string;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
  created_at: string;
};

type ScheduledModelOverride = {
  provider: "anthropic" | "openai";
  model: string;
  reasoningEffort: string | null;
} | null;

function getScheduledModelOverride(task: unknown): ScheduledModelOverride {
  const taskObj =
    task && typeof task === "object" && !Array.isArray(task)
      ? (task as Record<string, unknown>)
      : null;
  const options =
    taskObj?.options && typeof taskObj.options === "object" && !Array.isArray(taskObj.options)
      ? (taskObj.options as Record<string, unknown>)
      : null;
  const model = typeof options?.model_name === "string" ? options.model_name.trim() : "";
  if (!model) return null;
  const providerRaw =
    typeof options?.model_provider === "string" ? options.model_provider.trim() : "";
  return {
    provider:
      providerRaw === "anthropic" || providerRaw === "openai"
        ? providerRaw
        : inferProviderForModelId(model),
    model,
    reasoningEffort:
      typeof options?.reasoning_effort === "string" && options.reasoning_effort.trim()
        ? options.reasoning_effort.trim()
        : null,
  };
}

function withScheduledModelOverride(
  task: unknown,
  override: ScheduledModelOverride
): Record<string, unknown> {
  const taskObj =
    task && typeof task === "object" && !Array.isArray(task)
      ? { ...(task as Record<string, unknown>) }
      : {};
  const options =
    taskObj.options && typeof taskObj.options === "object" && !Array.isArray(taskObj.options)
      ? { ...(taskObj.options as Record<string, unknown>) }
      : {};
  delete options.model_name;
  delete options.model_provider;
  delete options.reasoning_effort;
  if (override) {
    options.model_name = override.model;
    options.model_provider = override.provider;
    if (override.reasoningEffort) options.reasoning_effort = override.reasoningEffort;
  }
  taskObj.options = options;
  return taskObj;
}

function getOrchestratorTaskMessage(task: unknown): string {
  const taskObj =
    task && typeof task === "object" && !Array.isArray(task)
      ? (task as { message?: unknown })
      : null;
  const msg = taskObj && typeof taskObj.message === "string" ? taskObj.message.trim() : "";
  return msg;
}

function getJobSummary(j: ScheduledJob): { label: string; detail: string } {
  const kind = (j.kind || "shell") as string;
  if (kind === "orchestrator") {
    const msg = getOrchestratorTaskMessage(j.task);
    return { label: "orchestrator", detail: msg || "(no task)" };
  }
  return { label: "shell", detail: (j.command || "").trim() || "(no command)" };
}

function formatSchedule(s: unknown): string {
  if (!s || typeof s !== "object") return "unknown";
  const t = (s as { type?: unknown }).type;
  if (t === "once") {
    const runAt = (s as { run_at?: unknown }).run_at;
    return typeof runAt === "string" ? `once @ ${runAt}` : "once";
  }
  if (t === "daily") {
    const hour = (s as { hour?: unknown }).hour;
    const minute = (s as { minute?: unknown }).minute;
    if (typeof hour === "number" && typeof minute === "number") {
      return `daily (local) @ ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    return "daily";
  }
  if (t === "weekly") {
    const weekday = (s as { weekday?: unknown }).weekday;
    const hour = (s as { hour?: unknown }).hour;
    const minute = (s as { minute?: unknown }).minute;
    const wd =
      typeof weekday === "number"
        ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday] || "?"
        : "?";
    if (typeof hour === "number" && typeof minute === "number") {
      return `weekly (local) ${wd} @ ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    return `weekly ${wd}`;
  }
  if (t === "interval_minutes") {
    const minutes = (s as { minutes?: unknown }).minutes;
    return typeof minutes === "number" ? `every ${minutes}m` : "interval";
  }
  return typeof t === "string" ? t : "unknown";
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function JobRunCard({
  run,
  isExpanded,
  onToggle,
}: {
  run: ScheduledJobRun;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const status = String(run.status || "unknown");
  const statusClasses =
    status === "success"
      ? "border-emerald-500/30 text-emerald-300 bg-emerald-500/10"
      : status === "skipped"
        ? "border-amber-500/30 text-amber-300 bg-amber-500/10"
        : "border-red-500/30 text-red-300 bg-red-500/10";

  const dur =
    typeof run.duration_ms === "number" && Number.isFinite(run.duration_ms)
      ? run.duration_ms < 1000
        ? `${Math.round(run.duration_ms)}ms`
        : `${(run.duration_ms / 1000).toFixed(1)}s`
      : null;

  const output = (run.stdout || run.stderr || run.error || "").trim();
  const preview = output.length > 120 ? output.slice(0, 120).trimEnd() + "…" : output;

  return (
    <div className="rounded-xl border border-white/5 bg-black/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${statusClasses}`}>
              {status}
            </span>
            {dur && <span className="text-[10px] text-zinc-500">{dur}</span>}
            <span className="text-[10px] text-zinc-600">
              {formatRelativeTime(run.created_at)}
            </span>
          </div>
          {preview && !isExpanded && (
            <div className="text-[11px] text-zinc-500 mt-1.5 font-mono truncate">
              {preview}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {output && (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(output);
                } catch {
                  // ignore
                }
              }}
              className="p-1.5 rounded-lg bg-white/5 text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Copy output"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onToggle}
            className="p-1.5 rounded-lg bg-white/5 text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            title={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="mt-3 space-y-2">
          {run.stdout && (
            <div className="rounded-lg border border-white/5 bg-black/30 p-2.5">
              <div className="text-[10px] text-zinc-500 mb-1">stdout</div>
              <div className="text-[11px] text-zinc-200 font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {run.stdout}
              </div>
            </div>
          )}
          {run.stderr && (
            <div className="rounded-lg border border-white/5 bg-black/30 p-2.5">
              <div className="text-[10px] text-zinc-500 mb-1">stderr</div>
              <div className="text-[11px] text-zinc-200 font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {run.stderr}
              </div>
            </div>
          )}
          {run.error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-2.5">
              <div className="text-[10px] text-red-300 mb-1">error</div>
              <div className="text-[11px] text-red-200 font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {run.error}
              </div>
            </div>
          )}
          {!run.stdout && !run.stderr && !run.error && (
            <div className="text-[11px] text-zinc-600 italic">(no output)</div>
          )}
        </div>
      )}
    </div>
  );
}

export function SchedulePanel({
  isOpen,
  onClose,
  onTriggerJob,
  runningJobIds,
}: {
  isOpen: boolean;
  onClose: () => void;
  onTriggerJob?: (jobId: string, deviceId?: string | null) => void;
  runningJobIds?: Set<string>;
}) {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [runs, setRuns] = useState<ScheduledJobRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [editingPrompt, setEditingPrompt] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [workerOptions, setWorkerOptions] = useState<WorkerOption[]>([]);
  const [retargetingJobId, setRetargetingJobId] = useState<string | null>(null);
  const [updatingModelJobId, setUpdatingModelJobId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("scheduled_jobs")
        .select(
          "id,name,device_id,kind,command,task,schedule,enabled,skip_next_run,last_run_at,last_status,last_exit_code,updated_at,session_id,target_agent_id,orchestrator_sessions(title),target_agent:agents!scheduled_jobs_target_agent_id_fkey(name)"
        )
        .order("updated_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      // Map joined session title + target agent, filter out heartbeat jobs
      const mapped = (
        (data || []) as Array<
          ScheduledJob & {
            orchestrator_sessions?: { title?: string } | null;
            target_agent?: { name?: string } | null;
          }
        >
      ).map((j) => ({
        ...j,
        session_title: j.orchestrator_sessions?.title || null,
        target_agent_name: j.target_agent?.name || null,
        orchestrator_sessions: undefined,
        target_agent: undefined,
      }));
      const visible = mapped.filter((j) => {
        const t = j.task as Record<string, unknown> | null;
        return !(t && (t.type === "heartbeat_v1" || t.ui_hidden === true));
      });
      setJobs(visible);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("scheduled_job_runs")
        .select(
          "id,job_id,status,exit_code,started_at,finished_at,duration_ms,stdout,stderr,error,created_at"
        )
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      setRuns((data as ScheduledJobRun[]) || []);
    } catch {
      // Silently fail - runs are optional
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshRuns()]);
  }, [refresh, refreshRuns]);

  const updateJob = useCallback(
    async (jobId: string, patch: Record<string, unknown>) => {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from("scheduled_jobs")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", jobId);
      if (error) throw error;
      await refresh();
    },
    [refresh]
  );

  const deleteJob = useCallback(
    async (jobId: string) => {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.from("scheduled_jobs").delete().eq("id", jobId);
      if (error) throw error;
      setExpandedJobId(null);
      await refresh();
    },
    [refresh]
  );

  const refreshWorkerOptions = useCallback(async () => {
    try {
      const supabase = getSupabaseBrowserClient();
      const { data } = await supabase
        .from("agents")
        .select("id, name, claude_code_agent_configs!inner(code_cli_provider,device_id)")
        .eq("type", "claude-code")
        .order("created_at", { ascending: true });
      setWorkerOptions(
        ((data || []) as Array<{
          id: string;
          name: string;
          claude_code_agent_configs?:
            | Array<{ code_cli_provider?: string; device_id?: string | null }>
            | { code_cli_provider?: string; device_id?: string | null }
            | null;
        }>).map((row) => {
          const config = Array.isArray(row.claude_code_agent_configs)
            ? row.claude_code_agent_configs[0]
            : row.claude_code_agent_configs;
          return {
            id: row.id,
            name: row.name,
            harness:
              config?.code_cli_provider === "codex" ? ("codex" as const) : ("claude" as const),
            configured: typeof config?.device_id === "string" && config.device_id.length > 0,
          };
        })
      );
    } catch {
      // picker degrades to Orchestrator-only
    }
  }, []);

  const retargetJob = useCallback(
    async (job: ScheduledJob, targetAgentId: string | null) => {
      setRetargetingJobId(job.id);
      try {
        const supabase = getSupabaseBrowserClient();
        const currentOverride = getScheduledModelOverride(job.task);
        const nextWorker = workerOptions.find((worker) => worker.id === targetAgentId);
        const expectedProvider = nextWorker
          ? nextWorker.harness === "codex"
            ? "openai"
            : "anthropic"
          : null;
        const clearIncompatibleOverride =
          !!currentOverride && !!expectedProvider && currentOverride.provider !== expectedProvider;
        let latestTask = job.task;
        if (clearIncompatibleOverride) {
          const { data: latestJob, error: readError } = await supabase
            .from("scheduled_jobs")
            .select("task")
            .eq("id", job.id)
            .maybeSingle();
          if (readError) throw readError;
          latestTask = latestJob?.task ?? job.task;
        }
        const { error } = await supabase
          .from("scheduled_jobs")
          .update({
            target_agent_id: targetAgentId,
            ...(clearIncompatibleOverride
              ? { task: withScheduledModelOverride(latestTask, null) }
              : {}),
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        if (error) throw error;
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRetargetingJobId(null);
      }
    },
    [refresh, workerOptions]
  );

  const updateScheduledModel = useCallback(
    async (job: ScheduledJob, override: ScheduledModelOverride) => {
      setUpdatingModelJobId(job.id);
      setError(null);
      try {
        const supabase = getSupabaseBrowserClient();
        const { data: latestJob, error: readError } = await supabase
          .from("scheduled_jobs")
          .select("task")
          .eq("id", job.id)
          .maybeSingle();
        if (readError) throw readError;
        const { error: updateError } = await supabase
          .from("scheduled_jobs")
          .update({
            task: withScheduledModelOverride(latestJob?.task ?? job.task, override),
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        if (updateError) throw updateError;
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUpdatingModelJobId(null);
      }
    },
    [refresh]
  );

  useEffect(() => {
    if (!isOpen) return;
    refreshAll().catch(() => {});
    refreshWorkerOptions().catch(() => {});
  }, [isOpen, refreshAll, refreshWorkerOptions]);

  // Group runs by job_id
  const runsByJobId = useMemo(() => {
    const map = new Map<string, ScheduledJobRun[]>();
    for (const run of runs) {
      const existing = map.get(run.job_id) || [];
      existing.push(run);
      map.set(run.job_id, existing);
    }
    return map;
  }, [runs]);

  const topJobs = useMemo(() => jobs.slice(0, 50), [jobs]);

  const beginPromptEdit = useCallback((job: ScheduledJob) => {
    if ((job.kind || "shell") !== "orchestrator") return;
    setEditingJobId(job.id);
    setEditingPrompt(getOrchestratorTaskMessage(job.task));
    setError(null);
  }, []);

  const cancelPromptEdit = useCallback(() => {
    setEditingJobId(null);
    setEditingPrompt("");
  }, []);

  const savePromptEdit = useCallback(async () => {
    if (!editingJobId) return;
    const nextPrompt = editingPrompt.trim();
    if (!nextPrompt) {
      setError("Task prompt cannot be empty.");
      return;
    }

    setSavingEdit(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: updatePromptError } = await supabase.rpc(
        "scheduled_job_set_orchestrator_prompt",
        {
          p_job_id: editingJobId,
          p_message: nextPrompt,
        }
      );
      if (updatePromptError) {
        throw updatePromptError;
      }
      await refresh();
      setEditingJobId(null);
      setEditingPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingEdit(false);
    }
  }, [editingJobId, editingPrompt, refresh]);

  const isPromptSaveInFlightForJob = useCallback(
    (jobId: string) => savingEdit && editingJobId === jobId,
    [savingEdit, editingJobId]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="relative w-full max-w-2xl mx-4 bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-blue-400" />
            <div>
              <h3 className="text-lg font-semibold text-white">Scheduled Jobs</h3>
              <p className="text-[11px] text-zinc-500">
                Orchestrator or worker-owned tasks, run by an awake connected machine
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refreshAll()}
              disabled={loading || runsLoading}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 text-zinc-200 hover:bg-white/10 disabled:opacity-50 transition-colors text-sm"
            >
              <RefreshCw className={`w-4 h-4 ${loading || runsLoading ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto">
          {error && <div className="text-sm text-red-400 mb-3">{error}</div>}

          {topJobs.length === 0 && !loading ? (
            <div className="text-center py-10">
              <div className="text-sm text-zinc-400">
                Create one by telling the Orchestrator when the task should run and which agent
                should own it.
              </div>
              <div className="text-xs text-zinc-600 mt-2">
                Try:{" "}
                <span className="text-zinc-300">
                  &quot;Every day at 7:30, have Scout triage new issues.&quot;
                </span>
              </div>
              <div className="text-[11px] text-zinc-600 mt-3">
                The selected agent keeps its own harness, workspace, model, skills, and docs.
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {topJobs.map((j) => {
                const summary = getJobSummary(j);
                const jobRuns = runsByJobId.get(j.id) || [];
                const isExpanded = expandedJobId === j.id;
                const runCount = jobRuns.length;
                const isEditingPrompt = editingJobId === j.id;
                const isOrchestratorJob = (j.kind || "shell") === "orchestrator";
                const isSavingPromptForThisJob = isPromptSaveInFlightForJob(j.id);
                const scheduledModel = getScheduledModelOverride(j.task);
                const targetWorker = workerOptions.find(
                  (worker) => worker.id === j.target_agent_id
                );
                const modelGroups = j.target_agent_id
                  ? MODEL_CATALOG.filter((group) =>
                      targetWorker?.harness === "codex"
                        ? group.provider === "openai"
                        : group.provider === "anthropic"
                    )
                  : MODEL_CATALOG;
                const modelIsInCatalog = modelGroups.some((group) =>
                  group.models.some((model) => model.id === scheduledModel?.model)
                );
                const scheduledEfforts = reasoningEffortsForModel(
                  scheduledModel?.model,
                  j.target_agent_id ? "cli" : "api"
                );

                return (
                  <div
                    key={j.id}
                    className="rounded-2xl border border-white/10 bg-black/20 overflow-hidden"
                  >
                    {/* Job header */}
                    <div className="p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 text-zinc-400 bg-white/5">
                              {summary.label}
                            </span>
                            {isOrchestratorJob && (
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded-full border ${
                                  j.target_agent_id
                                    ? "border-cyan-500/30 text-cyan-300 bg-cyan-500/10"
                                    : "border-white/10 text-zinc-500 bg-white/5"
                                }`}
                                title="Which agent runs this schedule"
                              >
                                → {j.target_agent_name || "Orchestrator"}
                              </span>
                            )}
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded-full border ${
                                j.enabled
                                  ? "border-emerald-500/30 text-emerald-300 bg-emerald-500/10"
                                  : "border-zinc-600/40 text-zinc-400 bg-white/5"
                              }`}
                            >
                              {j.enabled ? "enabled" : "paused"}
                            </span>
                            {j.skip_next_run && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full border border-amber-500/30 text-amber-300 bg-amber-500/10">
                                skip next
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-white font-medium">
                            {j.name || "Scheduled task"}
                          </div>
                          <div className="text-xs text-zinc-500 mt-1">
                            <span className="text-zinc-400">{formatSchedule(j.schedule)}</span>
                            {j.last_run_at && (
                              <>
                                {" · "}
                                last:{" "}
                                <span
                                  className={
                                    j.last_status === "success"
                                      ? "text-emerald-400"
                                      : j.last_status === "error"
                                        ? "text-red-400"
                                        : "text-zinc-400"
                                  }
                                >
                                  {j.last_status || "unknown"}
                                </span>
                              </>
                            )}
                          </div>
                          {j.session_title && (
                            <div className="text-[10px] text-zinc-500 mt-1">
                              Agent: <span className="text-cyan-400">{j.session_title}</span>
                            </div>
                          )}
                          {isOrchestratorJob && (
                            <div className="mt-1.5 space-y-1.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="w-10 shrink-0 text-[10px] text-zinc-500">Runs on</span>
                                <select
                                  value={j.target_agent_id || ""}
                                  disabled={retargetingJobId === j.id || loading || savingEdit}
                                  onChange={(e) =>
                                    void retargetJob(j, e.target.value || null)
                                  }
                                  className="min-w-0 max-w-full rounded-md border border-white/10 bg-black/30 px-1.5 py-1 text-[10px] text-zinc-300 outline-none focus:border-cyan-400/40 disabled:opacity-50"
                                >
                                  <option value="">Orchestrator (default)</option>
                                  {workerOptions.map((worker) => (
                                    <option
                                      key={worker.id}
                                      value={worker.id}
                                      disabled={!worker.configured && j.target_agent_id !== worker.id}
                                    >
                                      {worker.name} ({worker.harness === "codex" ? "Codex" : "Claude Code"})
                                      {!worker.configured ? " — setup needed" : ""}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="w-10 shrink-0 text-[10px] text-zinc-500">Model</span>
                                <select
                                  value={scheduledModel?.model || ""}
                                  disabled={updatingModelJobId === j.id || loading || savingEdit}
                                  onChange={(event) => {
                                    const model = event.target.value;
                                    void updateScheduledModel(
                                      j,
                                      model
                                        ? {
                                            provider: inferProviderForModelId(model),
                                            model,
                                            reasoningEffort: null,
                                          }
                                        : null
                                    );
                                  }}
                                  className="min-w-0 max-w-full rounded-md border border-white/10 bg-black/30 px-1.5 py-1 text-[10px] text-zinc-300 outline-none focus:border-cyan-400/40 disabled:opacity-50"
                                  title="Model used only by this scheduled task"
                                >
                                  <option value="">
                                    {j.target_agent_id ? "Agent default" : "Orchestrator default"}
                                  </option>
                                  {scheduledModel && !modelIsInCatalog && (
                                    <option value={scheduledModel.model}>
                                      {catalogModelLabel(scheduledModel.model)} (custom)
                                    </option>
                                  )}
                                  {modelGroups.map((group) => (
                                    <optgroup key={group.provider} label={group.group}>
                                      {group.models.map((model) => (
                                        <option key={model.id} value={model.id}>
                                          {model.label}{model.hint ? ` — ${model.hint}` : ""}
                                        </option>
                                      ))}
                                    </optgroup>
                                  ))}
                                </select>
                                {scheduledModel && scheduledEfforts.length > 0 && (
                                  <select
                                    value={scheduledModel.reasoningEffort || ""}
                                    disabled={updatingModelJobId === j.id || loading || savingEdit}
                                    onChange={(event) =>
                                      void updateScheduledModel(j, {
                                        ...scheduledModel,
                                        reasoningEffort: event.target.value || null,
                                      })
                                    }
                                    className="min-w-0 rounded-md border border-white/10 bg-black/30 px-1.5 py-1 text-[10px] text-zinc-300 outline-none focus:border-cyan-400/40 disabled:opacity-50"
                                    title="Reasoning effort for this scheduled task"
                                  >
                                    <option value="">Default effort</option>
                                    {scheduledEfforts.map((effort) => (
                                      <option key={effort} value={effort}>
                                        {effort === "xhigh"
                                          ? "Extra high"
                                          : effort.charAt(0).toUpperCase() + effort.slice(1)}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            </div>
                          )}
                          {isEditingPrompt ? (
                            <div className="mt-2">
                              <textarea
                                value={editingPrompt}
                                onChange={(e) => setEditingPrompt(e.target.value)}
                                disabled={savingEdit || loading}
                                className="w-full rounded-lg bg-black/30 border border-white/10 px-2.5 py-2 text-xs text-zinc-100 font-mono resize-y min-h-[72px] focus:outline-none focus:ring-1 focus:ring-cyan-400/60"
                                placeholder="Task prompt"
                              />
                              <div className="mt-2 flex items-center gap-2">
                                <button
                                  onClick={() => savePromptEdit()}
                                  disabled={savingEdit || loading}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-60 transition-colors text-xs"
                                >
                                  {savingEdit ? (
                                    <>
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      Saving...
                                    </>
                                  ) : (
                                    "Save prompt"
                                  )}
                                </button>
                                <button
                                  onClick={() => cancelPromptEdit()}
                                  disabled={savingEdit || loading}
                                  className="px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 disabled:opacity-60 transition-colors text-xs"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="text-xs text-zinc-600 mt-2 font-mono line-clamp-2">
                              {summary.detail}
                            </div>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="w-full shrink-0 sm:w-auto">
                          <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                            {onTriggerJob && (
                              <button
                                onClick={() => onTriggerJob(j.id, j.device_id || null)}
                                disabled={
                                  loading || runningJobIds?.has(j.id) || isSavingPromptForThisJob
                                }
                                className={`inline-flex h-11 min-h-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors sm:h-9 sm:px-2.5 ${
                                  runningJobIds?.has(j.id)
                                    ? "bg-blue-500/20 border-blue-500/30 text-blue-200"
                                    : "bg-emerald-500/10 border-emerald-500/20 text-emerald-200 hover:bg-emerald-500/20"
                                } disabled:opacity-70`}
                                title={
                                  runningJobIds?.has(j.id)
                                    ? "Job is running..."
                                    : isSavingPromptForThisJob
                                      ? "Saving prompt..."
                                      : "Run this job now"
                                }
                              >
                                {runningJobIds?.has(j.id) ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <PlayCircle className="w-3.5 h-3.5" />
                                )}
                                {runningJobIds?.has(j.id) ? "Running" : "Run"}
                              </button>
                            )}
                            {isOrchestratorJob && (
                              <button
                                onClick={() =>
                                  isEditingPrompt ? cancelPromptEdit() : beginPromptEdit(j)
                                }
                                disabled={loading || savingEdit}
                                className={`flex h-11 w-11 min-h-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-50 sm:h-9 sm:w-9 ${
                                  isEditingPrompt
                                    ? "bg-cyan-500/15 border-cyan-500/30 text-cyan-200"
                                    : "bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10"
                                }`}
                                title={isEditingPrompt ? "Cancel prompt edit" : "Edit task prompt"}
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              onClick={() => updateJob(j.id, { enabled: !j.enabled })}
                              disabled={loading || savingEdit}
                              className="flex h-11 w-11 min-h-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-zinc-300 transition-colors hover:bg-white/10 disabled:opacity-50 sm:h-9 sm:w-9"
                              title={j.enabled ? "Pause job" : "Resume job"}
                            >
                              {j.enabled ? (
                                <PauseCircle className="w-4 h-4" />
                              ) : (
                                <PlayCircle className="w-4 h-4 text-emerald-300" />
                              )}
                            </button>
                            <button
                              onClick={() => updateJob(j.id, { skip_next_run: true })}
                              disabled={loading || savingEdit || !j.enabled}
                              className="flex h-11 w-11 min-h-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-zinc-300 transition-colors hover:bg-white/10 disabled:opacity-50 sm:h-9 sm:w-9"
                              title="Skip next run"
                            >
                              <SkipForward className="w-4 h-4 text-amber-300" />
                            </button>
                            <button
                              onClick={async () => {
                                const ok = window.confirm(
                                  "Delete this scheduled job? This cannot be undone."
                                );
                                if (!ok) return;
                                await deleteJob(j.id);
                              }}
                              disabled={loading || savingEdit}
                              className="flex h-11 w-11 min-h-0 items-center justify-center rounded-lg border border-red-500/20 bg-red-500/10 text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50 sm:h-9 sm:w-9"
                              title="Delete job"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* History toggle button */}
                      <button
                        onClick={() => setExpandedJobId(isExpanded ? null : j.id)}
                        className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-white/5 border border-white/5 text-zinc-400 hover:text-zinc-200 hover:bg-white/10 transition-colors text-xs"
                      >
                        <History className="w-3.5 h-3.5" />
                        <span>
                          {isExpanded ? "Hide history" : `Run history`}
                          {runCount > 0 && (
                            <span className="ml-1 text-zinc-500">({runCount})</span>
                          )}
                        </span>
                        {isExpanded ? (
                          <ChevronUp className="w-3.5 h-3.5 ml-auto" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 ml-auto" />
                        )}
                      </button>
                    </div>

                    {/* Expanded runs section */}
                    {isExpanded && (
                      <div className="border-t border-white/5 bg-black/30 p-4">
                        {runsLoading ? (
                          <div className="text-xs text-zinc-500 text-center py-4">
                            Loading runs...
                          </div>
                        ) : jobRuns.length === 0 ? (
                          <div className="text-xs text-zinc-500 text-center py-4">
                            No runs yet for this job.
                          </div>
                        ) : (
                          <div className="space-y-2 max-h-64 overflow-y-auto">
                            {jobRuns.slice(0, 20).map((run) => (
                              <JobRunCard
                                key={run.id}
                                run={run}
                                isExpanded={expandedRunId === run.id}
                                onToggle={() =>
                                  setExpandedRunId(expandedRunId === run.id ? null : run.id)
                                }
                              />
                            ))}
                            {jobRuns.length > 20 && (
                              <div className="text-xs text-zinc-600 text-center pt-2">
                                Showing 20 of {jobRuns.length} runs
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
