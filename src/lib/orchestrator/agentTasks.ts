/**
 * Agent task runner — the delegation core of the harness.
 *
 * An agent task is one unit of work the orchestrator (or a schedule, or the
 * API) assigns to a worker agent (Claude Code / Codex CLI on the user's
 * connector). This module owns the full lifecycle:
 *
 *   queued → running → done | failed | canceled
 *          ↳ awaiting_approval → queued (approve) | canceled (reject)
 *
 * Execution is headless: the run payload is built by prepareCodeRun (shared
 * with /api/claude-cli) and executed over the relay internal RPC
 * (callConnectorRpcViaRelay → claude_run on the worker's device). The runner
 * persists the exchange into claude_code_cli_messages so the worker's pane in
 * the dashboard shows delegated work live, records billing usage with agent
 * attribution, mirrors a task event into the orchestrator session, and
 * delivers notifications per the task's `notify` targets.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildInternalRouteAuthHeaders } from "@/lib/internalRouteAuth";
import { getAppUrl } from "@/lib/config/appConfig";
import {
  callConnectorRpcViaRelay,
  startConnectorRpcViaRelay,
} from "@/lib/relay/connectorRpc";
import {
  prepareCodeRun,
  type CodeRunBilling,
} from "@/lib/claude/prepareCodeRun";
import { recordCodeAgentUsage } from "@/lib/billing/recordCodeAgentUsage";
import {
  workerHarnessFromProvider,
  workerPromptLabel,
  type WorkerAgentRosterEntry,
} from "@/lib/agents/types";
import { sendTeamChatPush } from "@/lib/notifications/webPush";

// Device considered online when the connector heartbeat is this recent.
const DEVICE_ONLINE_THRESHOLD_MS = 3 * 60 * 1000;

// Scheduled/headless runs must stay under the route budget (maxDuration 800s).
export const AGENT_TASK_MAX_TIMEOUT_MS = 700_000;
export const AGENT_TASK_DEFAULT_TIMEOUT_MS = 600_000;

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "canceled";

export type AgentTaskNotifyTargets = {
  dashboard?: boolean;
  whatsapp_kapso?: { phoneNumberId: string; to: string } | null;
  whatsapp_web?: {
    threadKey?: string | null;
    chatId?: string | null;
    /** Device running the WhatsApp bridge (may differ from the worker's device). */
    deviceId?: string | null;
  } | null;
  telegram?: boolean;
};

export type AgentTaskRow = {
  id: string;
  user_id: string;
  workspace_id: string | null;
  orchestrator_session_id: string | null;
  agent_id: string;
  status: AgentTaskStatus;
  title: string | null;
  prompt: string;
  context: string | null;
  result_text: string | null;
  result_meta: Record<string, unknown>;
  error: string | null;
  harness_session_id: string | null;
  trace_id: string | null;
  turn_id: string | null;
  requested_channel: string | null;
  notify: AgentTaskNotifyTargets;
  approval: Record<string, unknown>;
  source: "orchestrator" | "schedule" | "api";
  scheduled_job_id: string | null;
  scheduled_run_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function teamChatChannelId(requestedChannel: string | null | undefined) {
  const prefix = "team_chat:";
  if (!requestedChannel?.startsWith(prefix)) return null;
  return requestedChannel.slice(prefix.length).trim();
}

async function assertTeamChatAgentMembership(
  admin: SupabaseClient,
  args: {
    requestedChannel: string | null | undefined;
    agentId: string;
  },
): Promise<void> {
  const channelId = teamChatChannelId(args.requestedChannel);
  if (channelId === null) return;
  if (!channelId) {
    throw new Error(
      "Agent task denied: the Team Chat channel scope is invalid.",
    );
  }
  const { data: channelMembership, error: channelMembershipError } =
    await admin
      .from("chat_channel_members")
      .select("id")
      .eq("channel_id", channelId)
      .eq("member_type", "agent")
      .eq("agent_id", args.agentId)
      .maybeSingle();
  if (channelMembershipError) {
    throw new Error(
      `Agent task denied: channel roster verification failed (${channelMembershipError.message}).`,
    );
  }
  if (!channelMembership) {
    throw new Error(
      "Agent task denied: this agent is not selected for the Team Chat channel.",
    );
  }
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export async function listWorkerAgents(
  userId: string,
  opts?: { supabase?: SupabaseClient }
): Promise<WorkerAgentRosterEntry[]> {
  const supabase = opts?.supabase || createSupabaseAdminClient();

  const { data: rows, error } = await supabase
    .from("agents")
    .select(
      "id, name, created_at, claude_code_agent_configs!inner(device_id, workspace_id, code_cli_provider, model, emoji, color)"
    )
    .eq("user_id", userId)
    .eq("type", "claude-code")
    .order("created_at", { ascending: true });
  if (error || !rows) return [];

  const deviceIds = new Set<string>();
  const workspaceIds = new Set<string>();
  const roster: WorkerAgentRosterEntry[] = [];

  for (const row of rows) {
    const r = row as {
      id?: unknown;
      name?: unknown;
      created_at?: unknown;
      claude_code_agent_configs?: unknown;
    };
    const id = asString(r.id);
    const name = asString(r.name);
    const rawConfig = Array.isArray(r.claude_code_agent_configs)
      ? r.claude_code_agent_configs[0]
      : r.claude_code_agent_configs;
    if (!id || !name || !rawConfig || typeof rawConfig !== "object") continue;
    const config = rawConfig as {
      device_id?: unknown;
      workspace_id?: unknown;
      code_cli_provider?: unknown;
      model?: unknown;
      emoji?: unknown;
      color?: unknown;
    };
    const deviceId = asString(config.device_id);
    const workspaceId = asString(config.workspace_id);
    if (deviceId) deviceIds.add(deviceId);
    if (workspaceId) workspaceIds.add(workspaceId);
    roster.push({
      id,
      name,
      harness: workerHarnessFromProvider(config.code_cli_provider),
      model: asString(config.model),
      deviceId,
      workspaceId,
      emoji: asString(config.emoji),
      color: asString(config.color),
      createdAt: asString(r.created_at) || undefined,
    });
  }

  // Device online heuristics (connector heartbeats update devices.last_seen).
  const deviceOnline = new Map<string, boolean>();
  if (deviceIds.size > 0) {
    const { data: devices } = await supabase
      .from("devices")
      .select("id, last_seen")
      .in("id", Array.from(deviceIds));
    for (const device of devices || []) {
      const d = device as { id?: unknown; last_seen?: unknown };
      const id = asString(d.id);
      if (!id) continue;
      const lastSeen = asString(d.last_seen);
      deviceOnline.set(
        id,
        !!lastSeen && Date.now() - new Date(lastSeen).getTime() < DEVICE_ONLINE_THRESHOLD_MS
      );
    }
  }

  const workspaceRoots = new Map<string, string>();
  if (workspaceIds.size > 0) {
    const { data: workspaces } = await supabase
      .from("device_workspaces")
      .select("id, root_path")
      .in("id", Array.from(workspaceIds));
    for (const workspace of workspaces || []) {
      const w = workspace as { id?: unknown; root_path?: unknown };
      const id = asString(w.id);
      const rootPath = asString(w.root_path);
      if (id && rootPath) workspaceRoots.set(id, rootPath);
    }
  }

  for (const entry of roster) {
    entry.deviceOnline = entry.deviceId ? deviceOnline.get(entry.deviceId) === true : false;
    entry.workspaceRootPath = entry.workspaceId
      ? workspaceRoots.get(entry.workspaceId) || null
      : null;
    entry.promptLabel = workerPromptLabel(entry);
  }

  return roster;
}

export type ResolveWorkerAgentResult =
  | { ok: true; agent: WorkerAgentRosterEntry }
  | { ok: false; error: "not_found" | "ambiguous"; candidates?: string[] };

export async function resolveWorkerAgentByRef(
  userId: string,
  ref: string,
  opts?: { roster?: WorkerAgentRosterEntry[]; supabase?: SupabaseClient }
): Promise<ResolveWorkerAgentResult> {
  const needle = (ref || "").trim();
  if (!needle) return { ok: false, error: "not_found" };
  const roster = opts?.roster || (await listWorkerAgents(userId, { supabase: opts?.supabase }));

  const byId = roster.find((agent) => agent.id === needle);
  if (byId) return { ok: true, agent: byId };

  const lower = needle.toLowerCase();
  const nameMatches = roster.filter((agent) => agent.name.toLowerCase() === lower);
  if (nameMatches.length === 1) return { ok: true, agent: nameMatches[0] };
  if (nameMatches.length > 1) {
    return { ok: false, error: "ambiguous", candidates: nameMatches.map((a) => a.name) };
  }

  // Forgiving prefix match ("Fix" → "Fixter") only when unambiguous.
  const prefixMatches = roster.filter((agent) => agent.name.toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1) return { ok: true, agent: prefixMatches[0] };
  if (prefixMatches.length > 1) {
    return { ok: false, error: "ambiguous", candidates: prefixMatches.map((a) => a.name) };
  }

  return { ok: false, error: "not_found" };
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

export async function createAgentTask(args: {
  userId: string;
  agentId: string;
  prompt: string;
  title?: string | null;
  context?: string | null;
  orchestratorSessionId?: string | null;
  requestedChannel?: string | null;
  notify?: AgentTaskNotifyTargets;
  requireApproval?: boolean;
  /** Read-only plan mode: the worker drafts a plan instead of making changes. */
  planMode?: boolean;
  /** Additional lifecycle metadata (planning session, consultation depth, etc.). */
  resultMeta?: Record<string, unknown>;
  source?: "orchestrator" | "schedule" | "api";
  scheduledJobId?: string | null;
  scheduledRunId?: string | null;
  traceId?: string | null;
  turnId?: string | null;
}): Promise<AgentTaskRow> {
  const admin = createSupabaseAdminClient();
  await assertTeamChatAgentMembership(admin, {
    requestedChannel: args.requestedChannel,
    agentId: args.agentId,
  });
  const status: AgentTaskStatus = args.requireApproval ? "awaiting_approval" : "queued";
  const { data, error } = await admin
    .from("agent_tasks")
    .insert({
      user_id: args.userId,
      agent_id: args.agentId,
      prompt: args.prompt,
      title: args.title || summarizeTitle(args.prompt),
      context: args.context || null,
      orchestrator_session_id: args.orchestratorSessionId || null,
      requested_channel: args.requestedChannel || null,
      notify: args.notify || {},
      approval: args.requireApproval ? { required: true } : {},
      result_meta: {
        ...(args.resultMeta || {}),
        ...(args.planMode ? { plan_mode: true } : {}),
      },
      status,
      source: args.source || "orchestrator",
      scheduled_job_id: args.scheduledJobId || null,
      scheduled_run_id: args.scheduledRunId || null,
      trace_id: args.traceId || null,
      turn_id: args.turnId || null,
    })
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`Failed to create agent task: ${error?.message || "unknown"}`);
  }
  return data as AgentTaskRow;
}

export async function getAgentTask(
  userId: string,
  taskId: string
): Promise<AgentTaskRow | null> {
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("agent_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as AgentTaskRow | null) || null;
}

async function updateAgentTask(
  taskId: string,
  patch: Record<string, unknown>
): Promise<AgentTaskRow | null> {
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("agent_tasks")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .select("*")
    .maybeSingle();
  return (data as AgentTaskRow | null) || null;
}

function summarizeTitle(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

// ---------------------------------------------------------------------------
// Diff extraction (TS port of the relay's persistence parser so headless runs
// produce the same message shape the dashboard already renders)
// ---------------------------------------------------------------------------

type ParsedDiff = {
  filename: string;
  content: string;
  additions: number;
  deletions: number;
};

function parseDiffBlock(content: string): ParsedDiff {
  const lines = String(content || "").split("\n");
  let filename = "file";
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const match = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (match) filename = match[1];
    } else if (line.startsWith("--- ") && filename === "file") {
      const match = line.match(/^--- (?:a\/)?(.+)$/);
      if (match && match[1] !== "/dev/null") filename = match[1];
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  return { filename, content, additions, deletions };
}

function extractDiffsFromContent(content: string): {
  cleanContent: string;
  diffs: ParsedDiff[];
} {
  const diffs: ParsedDiff[] = [];
  const diffBlockRegex = /```diff\n([\s\S]*?)```/g;
  let cleanContent = String(content || "");
  let match: RegExpExecArray | null;

  while ((match = diffBlockRegex.exec(content)) !== null) {
    const diffContent = match[1].trim();
    if (diffContent) {
      diffs.push(parseDiffBlock(diffContent));
    }
  }

  cleanContent = cleanContent.replace(diffBlockRegex, "").trim();
  return { cleanContent, diffs };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type RunAgentTaskResult = {
  task: AgentTaskRow;
  ok: boolean;
  resultText: string;
  error: string | null;
  accepted?: boolean;
};

type PersistedTaskRunBilling = CodeRunBilling & {
  requestId: string;
};

function readPersistedTaskRunBilling(
  value: unknown
): PersistedTaskRunBilling | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const requestId = asString(record.requestId);
  const codeCliProvider =
    record.codeCliProvider === "codex" || record.codeCliProvider === "claude"
      ? record.codeCliProvider
      : null;
  const provider =
    record.provider === "openai" || record.provider === "anthropic"
      ? record.provider
      : null;
  const authMethod =
    record.authMethod === "cli_token" ||
    record.authMethod === "api_key" ||
    record.authMethod === "local_codex_login"
      ? record.authMethod
      : null;
  const authOrigin =
    record.authOrigin === "user" || record.authOrigin === "local"
      ? record.authOrigin
      : null;
  if (
    !requestId ||
    !codeCliProvider ||
    !provider ||
    !authMethod ||
    !authOrigin ||
    record.billable !== true ||
    record.chargeType !== "external_key_fee"
  ) {
    return null;
  }
  return {
    requestId,
    billable: true,
    chargeType: "external_key_fee",
    provider,
    codeCliProvider,
    authMethod,
    authOrigin,
  };
}

async function failClaimedAgentTask(args: {
  task: AgentTaskRow;
  error: string;
  consumedTransferIds?: string[];
}): Promise<RunAgentTaskResult> {
  const admin = createSupabaseAdminClient();
  await restoreTransfers(admin, args.consumedTransferIds || []).catch(() => {});
  const { data: updated } = await admin
    .from("agent_tasks")
    .update({
      status: "failed",
      error: args.error,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.task.id)
    .eq("status", "running")
    .select("*")
    .maybeSingle();
  if (!updated) {
    const current = await getAgentTask(args.task.user_id, args.task.id);
    if (current?.status === "canceled") {
      await kickNextQueuedTaskForAgent(current).catch(() => {});
      return {
        task: current,
        ok: false,
        resultText: "",
        error: current.error || "stopped_by_team_member",
      };
    }
  }
  const finalTask =
    (updated as AgentTaskRow | null) ||
    { ...args.task, status: "failed" as const, error: args.error };
  await appendTaskEventToOrchestratorSession(admin, finalTask, "failed").catch(() => {});
  await appendTaskEventToTeamChat(admin, finalTask, "failed").catch(() => {});
  await notifyTaskFinished(finalTask).catch(() => {});
  await kickNextQueuedTaskForAgent(finalTask).catch(() => {});
  return { task: finalTask, ok: false, resultText: "", error: args.error };
}

async function finalizeAgentTaskConnectorResult(args: {
  task: AgentTaskRow;
  rpcResult: Record<string, unknown>;
  userEmail?: string | null;
  billing: PersistedTaskRunBilling;
  consumedTransferIds?: string[];
}): Promise<RunAgentTaskResult> {
  const admin = createSupabaseAdminClient();
  const { task, rpcResult, billing } = args;
  const ok = rpcResult.ok !== false;
  const rawResult =
    typeof rpcResult.result === "string"
      ? rpcResult.result
      : rpcResult.result && typeof rpcResult.result === "object"
        ? JSON.stringify(rpcResult.result)
        : "";
  const errorText = asString(rpcResult.error);
  const resultSessionId = asString(rpcResult.session_id);
  const durationMs = Number.isFinite(Number(rpcResult.duration_ms))
    ? Number(rpcResult.duration_ms)
    : null;
  const model = asString(rpcResult.model);
  const costUsd = Number.isFinite(Number(rpcResult.cost_usd))
    ? Number(rpcResult.cost_usd)
    : Number.isFinite(Number(rpcResult.total_cost_usd))
      ? Number(rpcResult.total_cost_usd)
      : null;

  const baseContent = rawResult.trim();
  const forwardedDiffs = Array.isArray(rpcResult.diffs)
    ? (rpcResult.diffs as unknown[])
    : [];
  const composedContent = errorText
    ? baseContent
      ? `${baseContent}\n\nError: ${errorText}`
      : `Error: ${errorText}`
    : baseContent ||
      (forwardedDiffs.length > 0
        ? "Completed. See file changes below."
        : "Completed.");
  const { cleanContent, diffs: textDiffs } =
    extractDiffsFromContent(composedContent);
  const streamDiffs = forwardedDiffs.map((diff) =>
    parseDiffBlock(String(diff))
  );
  const persistedDiffs = streamDiffs.length > 0 ? streamDiffs : textDiffs;
  const content = cleanContent || composedContent;

  if (resultSessionId) {
    await admin
      .from("claude_code_cli_threads")
      .upsert(
        {
          user_id: task.user_id,
          claude_code_agent_id: task.agent_id,
          claude_session_id: resultSessionId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,claude_code_agent_id" }
      )
      .then(({ error }) => {
        if (error) {
          console.warn("[agentTasks] thread upsert failed:", error.message);
        }
      });
  }

  await admin
    .from("claude_code_cli_messages")
    .insert({
      user_id: task.user_id,
      claude_code_agent_id: task.agent_id,
      role: "assistant",
      content,
      diffs: persistedDiffs.length > 0 ? persistedDiffs : null,
      cost_usd: costUsd,
      duration_ms: durationMs,
      model: model || undefined,
    })
    .then(({ error }) => {
      if (error) {
        console.warn("[agentTasks] message insert failed:", error.message);
      }
    });

  await recordCodeAgentUsage({
    userId: task.user_id,
    userEmail: args.userEmail || null,
    agentId: task.agent_id,
    requestId: billing.requestId,
    billing: {
      billable: billing.billable,
      chargeType: billing.chargeType,
      provider: billing.provider,
      codeCliProvider: billing.codeCliProvider,
      authMethod: billing.authMethod,
      authOrigin: billing.authOrigin,
    },
    result: {
      ok,
      model,
      sessionId: resultSessionId,
      durationMs,
      usage: rpcResult.usage ?? null,
      totalCostUsd: costUsd,
    },
    source: "agent_task",
  }).catch((error) => {
    console.warn(
      "[agentTasks] usage recording failed:",
      error instanceof Error ? error.message : String(error)
    );
  });

  const finalStatus: AgentTaskStatus = ok ? "done" : "failed";
  const { data: updated } = await admin
    .from("agent_tasks")
    .update({
      status: finalStatus,
      result_text: content,
      result_meta: {
        ...((task.result_meta as Record<string, unknown> | null) || {}),
        live_status: finalStatus,
        progress_updated_at: new Date().toISOString(),
        diffCount: persistedDiffs.length,
        diffs:
          persistedDiffs.length > 0 ? persistedDiffs.slice(0, 20) : undefined,
        sessionId: resultSessionId,
        durationMs,
        model,
        costUsd,
        partial: rpcResult.partial === true || undefined,
        timedOut: rpcResult.timed_out === true || undefined,
      },
      error: ok ? null : errorText || "run_failed",
      harness_session_id: resultSessionId || task.harness_session_id || null,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", task.id)
    .eq("status", "running")
    .select("*")
    .maybeSingle();

  if (!updated) {
    const current = await getAgentTask(task.user_id, task.id);
    if (current?.status === "canceled") {
      if (!ok) {
        await restoreTransfers(admin, args.consumedTransferIds || []).catch(() => {});
      }
      await kickNextQueuedTaskForAgent(current).catch(() => {});
      return {
        task: current,
        ok: false,
        resultText: "",
        error: current.error || "stopped_by_team_member",
      };
    }
  }

  const finalTask =
    (updated as AgentTaskRow | null) ||
    ({
      ...task,
      status: finalStatus,
      result_text: content,
      error: ok ? null : errorText || "run_failed",
    } as AgentTaskRow);

  if (!ok) {
    await restoreTransfers(admin, args.consumedTransferIds || []).catch(() => {});
  }
  await appendTaskEventToOrchestratorSession(
    admin,
    finalTask,
    finalStatus
  ).catch(() => {});
  await appendTaskEventToTeamChat(admin, finalTask, finalStatus).catch(() => {});
  await notifyTaskFinished(finalTask).catch(() => {});
  await kickNextQueuedTaskForAgent(finalTask).catch(() => {});

  return {
    task: finalTask,
    ok,
    resultText: content,
    error: ok ? null : errorText || "run_failed",
  };
}

/**
 * Execute a queued agent task end-to-end. Returns the final task row.
 * Safe to call concurrently: only a queued task transitions to running.
 */
export async function runAgentTask(args: {
  taskId: string;
  userId: string;
  userEmail?: string | null;
  timeoutMs?: number;
  detached?: boolean;
  completionBaseUrl?: string | null;
}): Promise<RunAgentTaskResult> {
  const admin = createSupabaseAdminClient();

  // Claim atomically: queued → running (no-op if another runner claimed it).
  const { data: claimed, error: claimError } = await admin
    .from("agent_tasks")
    .update({ status: "running", started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", args.taskId)
    .eq("user_id", args.userId)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();

  if (!claimed) {
    const existing = await getAgentTask(args.userId, args.taskId);
    if (!existing) throw new Error("agent_task_not_found");
    return {
      task: existing,
      ok: existing.status === "done",
      resultText: existing.result_text || "",
      error:
        claimError?.code === "23505" && existing.status === "queued"
          ? "agent_busy"
          : existing.status === "awaiting_approval"
          ? "task_awaiting_approval"
          : existing.status === "running"
            ? "task_already_running"
            : existing.error,
    };
  }

  const task = claimed as AgentTaskRow;

  // Transfers consumed for this run; restored if the run fails so the
  // handoff briefing isn't lost.
  let consumedTransferIds: string[] = [];

  const fail = (error: string): Promise<RunAgentTaskResult> =>
    failClaimedAgentTask({
      task,
      error,
      consumedTransferIds,
    });

  try {
    // A worker may have been removed while its task was waiting in the queue.
    // Revalidate at execution time so stale queued work cannot outlive the
    // channel authorization that created it.
    await assertTeamChatAgentMembership(admin, {
      requestedChannel: task.requested_channel,
      agentId: task.agent_id,
    });
  } catch {
    return fail("team_chat_agent_not_selected");
  }

  // Load worker config for device routing.
  const { data: config } = await admin
    .from("claude_code_agent_configs")
    .select("device_id, code_cli_provider")
    .eq("agent_id", task.agent_id)
    .eq("user_id", task.user_id)
    .maybeSingle();
  const deviceId = asString((config as { device_id?: unknown } | null)?.device_id);
  if (!config || !deviceId) {
    return fail("worker_agent_not_configured");
  }

  // Resolve resume session: prefer the task's own harness session, else the
  // worker's persistent thread.
  let sessionId = asString(task.harness_session_id);
  if (!sessionId) {
    const { data: thread } = await admin
      .from("claude_code_cli_threads")
      .select("claude_session_id")
      .eq("user_id", task.user_id)
      .eq("claude_code_agent_id", task.agent_id)
      .maybeSingle();
    sessionId = asString((thread as { claude_session_id?: unknown } | null)?.claude_session_id);
  }

  // Fold in any pending context transfers targeted at this agent.
  const consumedTransfers = await consumePendingTransfers(
    admin,
    task.user_id,
    task.agent_id
  ).catch(() => null);
  consumedTransferIds = consumedTransfers?.ids || [];

  const contextBlocks = [task.context?.trim(), consumedTransfers?.block].filter(
    (block): block is string => !!block
  );
  const promptWithContext = contextBlocks.length
    ? `${contextBlocks.join("\n\n")}\n\n${task.prompt.trim()}`
    : task.prompt.trim();

  const timeoutMs = Math.min(
    Math.max(30_000, Math.trunc(args.timeoutMs || AGENT_TASK_DEFAULT_TIMEOUT_MS)),
    AGENT_TASK_MAX_TIMEOUT_MS
  );

  // Show the delegated prompt in the worker's pane immediately.
  await admin
    .from("claude_code_cli_messages")
    .insert({
      user_id: task.user_id,
      claude_code_agent_id: task.agent_id,
      role: "user",
      content: task.title && task.title !== task.prompt
        ? `[Task] ${promptWithContext}`
        : promptWithContext,
    })
    .then(() => {});

  const taskMeta = (task.result_meta as Record<string, unknown> | null) || {};
  const isConsultationMode = taskMeta.consultation_mode === true;
  const isPlanMode = taskMeta.plan_mode === true;
  const isReadOnlyMode = isPlanMode || isConsultationMode;
  const scheduledModel = asString(taskMeta.scheduled_model);
  const scheduledReasoningEffort = asString(taskMeta.scheduled_reasoning_effort);

  const consultationPrompt = isConsultationMode
    ? `${promptWithContext}

You are the repository expert consulting an orchestrator that will write the final implementation plan. Explore the actual codebase thoroughly, but do not make changes.

Return a repository evidence brief in markdown with these exact sections:
1. Repository snapshot — current git commit, branch, dirty/clean state.
2. Current architecture — how the relevant behavior works today.
3. Evidence — relevant files, symbols, and line ranges, with what each proves.
4. Dependencies and data flow — upstream/downstream components and persistence boundaries.
5. Tests and verification — existing coverage and commands the implementation should run.
6. Risks and constraints — compatibility, migrations, security, performance, and UX concerns.
7. Recommended implementation shape — architecture guidance, not a final step-by-step plan.
8. Open questions — only questions that cannot be answered from the repository.

Use concrete evidence. Do not invent files or behavior. Do NOT edit, write, commit, install, or mutate anything.`
    : null;

  const prepared = await prepareCodeRun({
    supabase: admin,
    userId: task.user_id,
    userEmail: args.userEmail || null,
    agentId: task.agent_id,
    prompt: isConsultationMode
      ? consultationPrompt!
      : isPlanMode
      ? `${promptWithContext}\n\nProduce a concrete, step-by-step implementation plan (markdown, with a short title on the first line). Do NOT make any changes — plan only.`
      : promptWithContext,
    sessionId,
    timeoutMs,
    planMode: isReadOnlyMode,
    model: scheduledModel,
    reasoningEffort: scheduledReasoningEffort,
    billingSource: "agent_task",
  });

  if (!prepared.ok) {
    return fail(prepared.error);
  }

  const persistedBilling: PersistedTaskRunBilling = {
    requestId: prepared.requestId,
    billable: prepared.billing.billable,
    chargeType: prepared.billing.chargeType,
    provider: prepared.billing.provider,
    codeCliProvider: prepared.billing.codeCliProvider,
    authMethod: prepared.billing.authMethod,
    authOrigin: prepared.billing.authOrigin,
  };
  const liveTaskMeta = {
    ...taskMeta,
    relay_request_id: prepared.requestId,
    live_status: "running",
    live_text: "",
    live_tools: [],
    progress_updated_at: new Date().toISOString(),
    task_run_billing: persistedBilling,
    consumed_transfer_ids: consumedTransferIds,
  };
  const runningTask =
    (await updateAgentTask(task.id, {
      result_meta: liveTaskMeta,
    })) || { ...task, result_meta: liveTaskMeta };

  const canceledBeforeDispatch = await getAgentTask(task.user_id, task.id);
  if (canceledBeforeDispatch?.status === "canceled") {
    return {
      task: canceledBeforeDispatch,
      ok: false,
      resultText: "",
      error: canceledBeforeDispatch.error || "stopped_by_team_member",
      accepted: false,
    };
  }

  if (args.detached === true) {
    const completionBaseUrl = asString(args.completionBaseUrl);
    if (!completionBaseUrl) {
      return fail("missing_agent_task_completion_url");
    }

    let completionUrl: string;
    try {
      completionUrl = new URL(
        "/api/agents/tasks/complete",
        completionBaseUrl
      ).toString();
    } catch {
      return fail("invalid_agent_task_completion_url");
    }

    try {
      await startConnectorRpcViaRelay({
        userId: task.user_id,
        deviceId,
        rpcType: "claude_run",
        payload: prepared.payload,
        timeoutMs: timeoutMs + 30_000,
        requestId: prepared.requestId,
        taskId: task.id,
        taskMeta: liveTaskMeta,
        completionUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("device_not_online")) {
        return failClaimedAgentTask({
          task: runningTask,
          error: "worker_device_offline",
          consumedTransferIds,
        });
      }
      return failClaimedAgentTask({
        task: runningTask,
        error: message || "connector_rpc_start_failed",
        consumedTransferIds,
      });
    }

    const canceledAfterDispatch = await getAgentTask(task.user_id, task.id);
    if (canceledAfterDispatch?.status === "canceled") {
      await callConnectorRpcViaRelay({
        userId: task.user_id,
        deviceId,
        rpcType: "claude_run_cancel",
        payload: {
          target_request_id: prepared.requestId,
          agent_id: task.agent_id,
          cancel_all_for_agent: false,
        },
        timeoutMs: 15_000,
      }).catch(() => null);
      return {
        task: canceledAfterDispatch,
        ok: false,
        resultText: "",
        error: canceledAfterDispatch.error || "stopped_by_team_member",
        accepted: true,
      };
    }

    return {
      task: runningTask,
      ok: true,
      resultText: "",
      error: null,
      accepted: true,
    };
  }

  let rpcResult: Record<string, unknown>;
  try {
    rpcResult = await callConnectorRpcViaRelay({
      userId: task.user_id,
      deviceId,
      rpcType: "claude_run",
      payload: prepared.payload,
      timeoutMs: timeoutMs + 30_000,
      requestId: prepared.requestId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("device_not_online")) {
      return fail("worker_device_offline");
    }
    return fail(message || "connector_rpc_failed");
  }

  return finalizeAgentTaskConnectorResult({
    task: runningTask,
    rpcResult,
    userEmail: args.userEmail || null,
    billing: persistedBilling,
    consumedTransferIds,
  });
}

export async function completeAgentTaskFromConnector(args: {
  taskId: string;
  userId: string;
  requestId: string;
  rpcResult: Record<string, unknown>;
  userEmail?: string | null;
}): Promise<RunAgentTaskResult> {
  const task = await getAgentTask(args.userId, args.taskId);
  if (!task) {
    throw new Error("agent_task_not_found");
  }
  if (task.status === "done" || task.status === "failed" || task.status === "canceled") {
    return {
      task,
      ok: task.status === "done",
      resultText: task.result_text || "",
      error: task.error,
    };
  }
  if (task.status !== "running") {
    throw new Error(`agent_task_not_running:${task.status}`);
  }

  const taskMeta = (task.result_meta as Record<string, unknown> | null) || {};
  const expectedRequestId = asString(taskMeta.relay_request_id);
  if (!expectedRequestId || expectedRequestId !== args.requestId) {
    throw new Error("agent_task_request_mismatch");
  }
  const billing = readPersistedTaskRunBilling(taskMeta.task_run_billing);
  if (!billing || billing.requestId !== args.requestId) {
    throw new Error("agent_task_billing_context_missing");
  }
  const consumedTransferIds = Array.isArray(taskMeta.consumed_transfer_ids)
    ? taskMeta.consumed_transfer_ids
        .map((value) => asString(value))
        .filter((value): value is string => !!value)
    : [];

  return finalizeAgentTaskConnectorResult({
    task,
    rpcResult: args.rpcResult,
    userEmail: args.userEmail || null,
    billing,
    consumedTransferIds,
  });
}

/** Start the oldest queued task after an agent releases its single run slot. */
async function kickNextQueuedTaskForAgent(finishedTask: AgentTaskRow): Promise<void> {
  const admin = createSupabaseAdminClient();
  const { data: next } = await admin
    .from("agent_tasks")
    .select("id, user_id")
    .eq("user_id", finishedTask.user_id)
    .eq("agent_id", finishedTask.agent_id)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!next?.id || !next.user_id) return;
  kickAgentTask({ taskId: String(next.id), userId: String(next.user_id) });
}

// ---------------------------------------------------------------------------
// Orchestrator session mirroring + notifications
// ---------------------------------------------------------------------------

async function appendTaskEventToOrchestratorSession(
  admin: SupabaseClient,
  task: AgentTaskRow,
  status: AgentTaskStatus
): Promise<void> {
  if (!task.orchestrator_session_id) return;

  const { data: agent } = await admin
    .from("agents")
    .select("name")
    .eq("id", task.agent_id)
    .maybeSingle();
  const agentName = asString((agent as { name?: unknown } | null)?.name) || "worker agent";

  const summary =
    status === "done"
      ? `✅ ${agentName} finished "${task.title || "task"}".`
      : `❌ ${agentName} failed "${task.title || "task"}"${task.error ? `: ${task.error}` : ""}.`;
  const resultPreview = (task.result_text || "").trim();
  const content = resultPreview
    ? `${summary}\n\n${resultPreview.length > 1500 ? `${resultPreview.slice(0, 1500)}\n...[truncated]` : resultPreview}`
    : summary;

  await admin.from("orchestrator_messages").insert({
    user_id: task.user_id,
    session_id: task.orchestrator_session_id,
    role: "assistant",
    content,
    trace_id: task.trace_id,
    metadata: {
      kind: "task_event",
      taskId: task.id,
      agentId: task.agent_id,
      agentName,
      status,
      diffCount: (task.result_meta as { diffCount?: number } | null)?.diffCount || 0,
    },
  });

  // Nudge the session so the dashboard re-sorts it to the top.
  await admin
    .from("orchestrator_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", task.orchestrator_session_id)
      .then(() => {});
}

async function appendTaskEventToTeamChat(
  admin: SupabaseClient,
  task: AgentTaskRow,
  status: AgentTaskStatus,
): Promise<void> {
  const prefix = "team_chat:";
  if (!task.requested_channel?.startsWith(prefix)) return;
  const channelId = task.requested_channel.slice(prefix.length).trim();
  if (!channelId) return;

  // Service-role writes still honor the channel roster: a removed worker may
  // not continue speaking as a channel member after its task completes.
  const { data: membership } = await admin
    .from("chat_channel_members")
    .select("id")
    .eq("channel_id", channelId)
    .eq("member_type", "agent")
    .eq("agent_id", task.agent_id)
    .maybeSingle();
  if (!membership) return;

  const { data: existing } = await admin
    .from("chat_messages")
    .select("id")
    .eq("channel_id", channelId)
    .contains("metadata", { kind: "agent_task_result", task_id: task.id })
    .limit(1)
    .maybeSingle();
  if (existing) return;

  const { data: agent } = await admin
    .from("agents")
    .select("name")
    .eq("id", task.agent_id)
    .maybeSingle();
  const agentName =
    asString((agent as { name?: unknown } | null)?.name) || "Worker agent";
  const statusLine =
    status === "done"
      ? `${agentName} finished "${task.title || "task"}".`
      : `${agentName} failed "${task.title || "task"}"${task.error ? `: ${task.error}` : ""}.`;
  const result = (task.result_text || "").trim();
  const unbounded = result ? `${statusLine}\n\n${result}` : statusLine;
  const content =
    unbounded.length > 40_000
      ? `${unbounded.slice(0, 39_980)}\n...[truncated]`
      : unbounded;

  const { data: message, error } = await admin
    .from("chat_messages")
    .insert({
      channel_id: channelId,
      author_type: "agent",
      author_agent_id: task.agent_id,
      content,
      metadata: {
        kind: "agent_task_result",
        task_id: task.id,
        status,
        agent_name: agentName,
        title: task.title || "Task",
        trace_id: task.trace_id,
        diff_count:
          (task.result_meta as { diffCount?: number } | null)?.diffCount || 0,
      },
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await sendTeamChatPush({
    admin,
    channelId,
    messageId: String(message.id),
    authorType: "agent",
    authorLabel: agentName,
    content,
  }).catch((cause) => {
    console.warn("[team-chat] agent completion push delivery failed", {
      channelId,
      taskId: task.id,
      error: cause instanceof Error ? cause.message : "Unknown push error",
    });
  });
}

/**
 * Ping the requesting channel that a task needs approval.
 * The reply commands ("approve <id8>") are parsed by executeAgentTaskCommand.
 */
export async function notifyTaskAwaitingApproval(task: AgentTaskRow): Promise<void> {
  const notify = task.notify || {};
  const shortId = task.id.slice(0, 8);
  const body = `🛡️ Task needs your approval: "${task.title || task.prompt.slice(0, 80)}"\n\nReply "approve ${shortId}" or "reject ${shortId}".`;

  const kapso = notify.whatsapp_kapso;
  if (kapso && kapso.phoneNumberId && kapso.to) {
    try {
      const { sendKapsoText } = await import("@/lib/whatsapp/kapso");
      await sendKapsoText({ phoneNumberId: kapso.phoneNumberId, to: kapso.to, body });
    } catch (error) {
      console.warn(
        "[agentTasks] kapso approval notify failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  await sendBridgeNotification(task, body, "approval").catch(() => {});
}

/**
 * Send a message through the personal WhatsApp bridge. Routes via the device
 * recorded in notify.whatsapp_web (the bridge's device, captured at request
 * time) — the worker's device may be a different machine without a bridge.
 */
async function sendBridgeNotification(
  task: AgentTaskRow,
  body: string,
  label: string
): Promise<void> {
  const bridge = task.notify?.whatsapp_web;
  if (!bridge || !bridge.chatId) return;
  try {
    let deviceId = asString(bridge.deviceId);
    if (!deviceId) {
      // Legacy rows without a recorded bridge device: fall back to the
      // worker's device (best effort).
      const admin = createSupabaseAdminClient();
      const { data: config } = await admin
        .from("claude_code_agent_configs")
        .select("device_id")
        .eq("agent_id", task.agent_id)
        .eq("user_id", task.user_id)
        .maybeSingle();
      deviceId = asString((config as { device_id?: unknown } | null)?.device_id);
    }
    if (!deviceId) return;
    await callConnectorRpcViaRelay({
      userId: task.user_id,
      deviceId,
      rpcType: "whatsapp_send_text",
      payload: { chat_id: bridge.chatId, text: body },
      timeoutMs: 60_000,
    });
  } catch (error) {
    console.warn(
      `[agentTasks] bridge ${label} notify failed:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function notifyTaskFinished(task: AgentTaskRow): Promise<void> {
  const notify = task.notify || {};

  const admin = createSupabaseAdminClient();
  const { data: agent } = await admin
    .from("agents")
    .select("name")
    .eq("id", task.agent_id)
    .maybeSingle();
  const agentName = asString((agent as { name?: unknown } | null)?.name) || "worker agent";

  const statusLine =
    task.status === "done"
      ? `✅ ${agentName} finished: ${task.title || "task"}`
      : `❌ ${agentName} failed: ${task.title || "task"}${task.error ? ` (${task.error})` : ""}`;
  const preview = (task.result_text || "").replace(/\s+/g, " ").trim();
  const body = preview
    ? `${statusLine}\n\n${preview.length > 600 ? `${preview.slice(0, 600)}…` : preview}`
    : statusLine;

  // WhatsApp (Kapso Business API)
  const kapso = notify.whatsapp_kapso;
  if (kapso && kapso.phoneNumberId && kapso.to) {
    try {
      const { sendKapsoText } = await import("@/lib/whatsapp/kapso");
      await sendKapsoText({ phoneNumberId: kapso.phoneNumberId, to: kapso.to, body });
    } catch (error) {
      console.warn(
        "[agentTasks] kapso notify failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // WhatsApp (personal bridge) — routed via the bridge's own device.
  await sendBridgeNotification(task, body, "completion").catch(() => {});
}

// ---------------------------------------------------------------------------
// Approval + reconciliation
// ---------------------------------------------------------------------------

export async function approveAgentTask(args: {
  userId: string;
  taskId: string;
  decidedBy?: string;
}): Promise<AgentTaskRow | null> {
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("agent_tasks")
    .update({
      status: "queued",
      approval: {
        required: true,
        approved: true,
        decided_by: args.decidedBy || "user",
        decided_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.taskId)
    .eq("user_id", args.userId)
    .eq("status", "awaiting_approval")
    .select("*")
    .maybeSingle();
  return (data as AgentTaskRow | null) || null;
}

export async function rejectAgentTask(args: {
  userId: string;
  taskId: string;
  decidedBy?: string;
}): Promise<AgentTaskRow | null> {
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("agent_tasks")
    .update({
      status: "canceled",
      approval: {
        required: true,
        approved: false,
        decided_by: args.decidedBy || "user",
        decided_at: new Date().toISOString(),
      },
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.taskId)
    .eq("user_id", args.userId)
    .eq("status", "awaiting_approval")
    .select("*")
    .maybeSingle();
  return (data as AgentTaskRow | null) || null;
}

// ---------------------------------------------------------------------------
// Chat approval commands ("approve <task-id-prefix>" from WhatsApp/Telegram)
// ---------------------------------------------------------------------------

const TASK_COMMAND_REGEX = /^(approve|reject)\s+(?:task\s+)?([a-f0-9][a-f0-9-]{5,})\s*$/i;

/**
 * Handle "approve abc123" / "reject abc123" replies from chat channels.
 * The id may be a prefix of the task uuid (min 6 chars). Returns handled=false
 * when the text is not a task command (numeric inbox aliases don't match).
 */
export async function executeAgentTaskCommand(args: {
  userId: string;
  text: string;
  decidedBy?: string;
}): Promise<{ handled: boolean; reply?: string }> {
  const match = args.text.trim().match(TASK_COMMAND_REGEX);
  if (!match) return { handled: false };
  const action = match[1].toLowerCase() as "approve" | "reject";
  const idPrefix = match[2].toLowerCase();

  const admin = createSupabaseAdminClient();
  const { data: pending } = await admin
    .from("agent_tasks")
    .select("id, title, agent_id")
    .eq("user_id", args.userId)
    .eq("status", "awaiting_approval")
    .order("created_at", { ascending: false })
    .limit(25);

  const matches = (pending || []).filter((row) =>
    String((row as { id: string }).id).toLowerCase().startsWith(idPrefix)
  );
  if (matches.length === 0) {
    // No awaiting task matches — this probably wasn't a task command at all
    // ("approve accede", "reject deadbeef"): let the other command layers
    // (inbox actions, the orchestrator) handle the message.
    return { handled: false };
  }
  if (matches.length > 1) {
    return {
      handled: true,
      reply: `Multiple tasks match "${idPrefix}" — use more characters of the task id.`,
    };
  }

  const task = matches[0] as { id: string; title: string | null; agent_id: string };
  if (action === "approve") {
    const approved = await approveAgentTask({
      userId: args.userId,
      taskId: task.id,
      decidedBy: args.decidedBy || "chat",
    });
    if (!approved) {
      return { handled: true, reply: "That task is no longer awaiting approval." };
    }
    kickAgentTask({ taskId: task.id, userId: args.userId });
    return {
      handled: true,
      reply: `Approved — "${task.title || "task"}" is running. I'll message you when it finishes.`,
    };
  }

  const rejected = await rejectAgentTask({
    userId: args.userId,
    taskId: task.id,
    decidedBy: args.decidedBy || "chat",
  });
  if (!rejected) {
    return { handled: true, reply: "That task is no longer awaiting approval." };
  }
  return { handled: true, reply: `Rejected — "${task.title || "task"}" was canceled.` };
}

// ---------------------------------------------------------------------------
// Scheduled worker jobs (Part B)
// ---------------------------------------------------------------------------

export type ScheduledWorkerJobResult =
  | { ok: true; kind: "final"; traceId: string | null; text: string }
  | {
      ok: true;
      kind: "needs_connector";
      traceId: string;
      partialText: string;
      connectorExecutes: Array<{
        toolCallId: string;
        toolName: string;
        connectorType: string;
        connectorParams: Record<string, unknown>;
      }>;
    }
  | { ok: false; error: string; retryable: boolean };

/**
 * Execute a worker-targeted scheduled job: create an agent_tasks row and run
 * it via the headless task runner. Delivery:
 * - dashboard: agent_tasks realtime + schedule_run_report (no extra work)
 * - whatsapp: one needs_connector round (heartbeat pattern) sent by the
 *   TICKING connector
 * - telegram: handled by the route (server-side send) using the returned text
 */
export async function runScheduledWorkerJob(args: {
  jobId: string;
  jobName: string | null;
  userId: string;
  userEmail: string | null;
  targetAgentId: string;
  message: string;
  delivery: { dashboard?: boolean; whatsapp?: boolean; telegram?: boolean } | null;
  maxChars?: number | null;
  workerTimeoutMs?: number | null;
  incomingWhatsAppThreadKey?: string | null;
  scheduledWhatsAppChatId?: string | null;
  scheduledWhatsAppRecipientQuery?: string | null;
  scheduledRunId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}): Promise<ScheduledWorkerJobResult & { text?: string; deliverTelegram?: boolean }> {
  const admin = createSupabaseAdminClient();

  // Validate the target still exists and is configured.
  const { data: agentRow } = await admin
    .from("agents")
    .select("id, name, type")
    .eq("id", args.targetAgentId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (!agentRow || (agentRow as { type?: string }).type !== "claude-code") {
    return { ok: false, error: "target_agent_missing", retryable: false };
  }
  const agentName = asString((agentRow as { name?: unknown }).name) || "worker agent";

  const { data: config } = await admin
    .from("claude_code_agent_configs")
    .select("device_id")
    .eq("agent_id", args.targetAgentId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (!config || !asString((config as { device_id?: unknown }).device_id)) {
    // No silent fallback to the orchestrator — the user chose a specific worker.
    return { ok: false, error: "worker_agent_not_configured", retryable: false };
  }

  const scheduledRunId = asString(args.scheduledRunId);
  let task: AgentTaskRow | null = null;
  let reusedTask = false;
  if (scheduledRunId) {
    const { data: existing } = await admin
      .from("agent_tasks")
      .select("*")
      .eq("user_id", args.userId)
      .eq("scheduled_job_id", args.jobId)
      .eq("scheduled_run_id", scheduledRunId)
      .maybeSingle();
    task = (existing as AgentTaskRow | null) || null;
    reusedTask = !!task;
  }

  if (!task) {
    try {
      task = await createAgentTask({
        userId: args.userId,
        agentId: args.targetAgentId,
        prompt: args.message,
        title: args.jobName ? `Schedule: ${args.jobName}` : null,
        requestedChannel: "schedule",
        notify: { dashboard: true },
        source: "schedule",
        resultMeta: {
          ...(args.model ? { scheduled_model: args.model } : {}),
          ...(args.reasoningEffort
            ? { scheduled_reasoning_effort: args.reasoningEffort }
            : {}),
        },
        scheduledJobId: args.jobId,
        scheduledRunId,
      });
    } catch (error) {
      // Two server invocations can overlap when the connector times out just
      // as the first response is completing. The unique scheduled-run index
      // picks the winner; the loser reuses that row instead of failing or
      // creating duplicate side effects.
      if (!scheduledRunId) throw error;
      const { data: racedTask } = await admin
        .from("agent_tasks")
        .select("*")
        .eq("user_id", args.userId)
        .eq("scheduled_job_id", args.jobId)
        .eq("scheduled_run_id", scheduledRunId)
        .maybeSingle();
      if (!racedTask) throw error;
      task = racedTask as AgentTaskRow;
      reusedTask = true;
    }
  }

  if (reusedTask && (task.status === "running" || task.status === "queued")) {
    // The original server invocation may still be executing after a client
    // timeout. Ask the connector to retry status later; never start a second
    // harness run for the same scheduled occurrence.
    return { ok: false, error: "worker_run_in_progress", retryable: true };
  } else if (task.status === "failed") {
    const { data: reset } = await admin
      .from("agent_tasks")
      .update({
        status: "queued",
        error: null,
        started_at: null,
        finished_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", task.id)
      .eq("user_id", args.userId)
      .eq("status", "failed")
      .select("*")
      .maybeSingle();
    if (!reset) return { ok: false, error: "worker_run_retry_conflict", retryable: true };
    task = reset as AgentTaskRow;
  }

  const timeoutMs = Math.min(
    Math.max(30_000, Math.trunc(args.workerTimeoutMs || AGENT_TASK_DEFAULT_TIMEOUT_MS)),
    AGENT_TASK_MAX_TIMEOUT_MS
  );

  const outcome: RunAgentTaskResult =
    task.status === "done"
      ? {
          task,
          ok: true,
          resultText: task.result_text || "Completed.",
          error: null,
        }
      : await runAgentTask({
          taskId: task.id,
          userId: args.userId,
          userEmail: args.userEmail,
          timeoutMs,
        });

  if (!outcome.ok) {
    const error = outcome.error || "worker_run_failed";
    return {
      ok: false,
      error: `${error} (agent: ${agentName})`,
      retryable: error === "worker_device_offline" || error === "agent_busy",
    };
  }

  const resultText = outcome.resultText || "Completed.";
  const traceId = `sched-task-${task.id.slice(0, 8)}`;

  // WhatsApp delivery via the ticking connector (heartbeat pattern).
  if (args.delivery?.whatsapp) {
    let maxChars = 3000;
    const requested = Number(args.maxChars);
    if (Number.isFinite(requested) && requested > 200) maxChars = Math.floor(requested);
    maxChars = Math.max(200, Math.min(3500, maxChars));
    const header = `[${agentName}] ${args.jobName || "Scheduled task"}\n\n`;
    const available = Math.max(200, maxChars - header.length);
    const body =
      resultText.length > available
        ? `${resultText.slice(0, Math.max(0, available - 1)).trimEnd()}…`
        : resultText;
    const explicitChatId = asString(args.scheduledWhatsAppChatId);
    const recipientQuery = asString(args.scheduledWhatsAppRecipientQuery);
    const incomingChatId = asString(args.incomingWhatsAppThreadKey);
    const useExplicitTarget = !!(explicitChatId || recipientQuery);
    const toolName = useExplicitTarget ? "whatsapp_send_text" : "whatsapp_send_default_group";
    return {
      ok: true,
      kind: "needs_connector",
      traceId,
      partialText: `${header}${body}`,
      text: resultText,
      deliverTelegram: args.delivery?.telegram === true,
      connectorExecutes: [
        {
          toolCallId: `sched-wa-${Date.now()}`,
          toolName,
          connectorType: toolName,
          connectorParams: {
            text: `${header}${body}`,
            chat_id: explicitChatId || incomingChatId || undefined,
            recipient_query: recipientQuery || undefined,
          },
        },
      ],
    };
  }

  return {
    ok: true,
    kind: "final",
    traceId,
    text: resultText,
    deliverTelegram: args.delivery?.telegram === true,
  };
}

// ---------------------------------------------------------------------------
// Context transfer
// ---------------------------------------------------------------------------

export async function transferContext(args: {
  userId: string;
  fromAgentRef: string;
  toAgentRef: string;
  instructions?: string | null;
  provider?: "anthropic" | "openai";
  apiKey?: string;
}): Promise<
  | { ok: true; transferId: string; fromAgent: string; toAgent: string; summaryPreview: string }
  | { ok: false; error: string }
> {
  const admin = createSupabaseAdminClient();
  const roster = await listWorkerAgents(args.userId, { supabase: admin });

  const to = await resolveWorkerAgentByRef(args.userId, args.toAgentRef, { roster });
  if (!to.ok) {
    return {
      ok: false,
      error:
        to.error === "ambiguous"
          ? `Multiple agents match "${args.toAgentRef}": ${(to.candidates || []).join(", ")}`
          : `No worker agent named "${args.toAgentRef}"`,
    };
  }

  // Source: a worker agent by ref, or "orchestrator" for the orchestrator session.
  let sourceKind: "worker_thread" | "orchestrator_session" = "worker_thread";
  let fromAgentId: string | null = null;
  let fromLabel = args.fromAgentRef;
  let sourceMessages: Array<{ role: string; content: string }> = [];

  if (args.fromAgentRef.trim().toLowerCase() === "orchestrator") {
    sourceKind = "orchestrator_session";
    fromLabel = "Orchestrator";
    const { data: session } = await admin
      .from("orchestrator_sessions")
      .select("id")
      .eq("user_id", args.userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const sessionId = asString((session as { id?: unknown } | null)?.id);
    if (!sessionId) return { ok: false, error: "No orchestrator session found" };
    const { data: messages } = await admin
      .from("orchestrator_messages")
      .select("role, content")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(60);
    sourceMessages = ((messages || []) as Array<{ role: string; content: string }>).reverse();
  } else {
    const from = await resolveWorkerAgentByRef(args.userId, args.fromAgentRef, { roster });
    if (!from.ok) {
      return {
        ok: false,
        error:
          from.error === "ambiguous"
            ? `Multiple agents match "${args.fromAgentRef}": ${(from.candidates || []).join(", ")}`
            : `No worker agent named "${args.fromAgentRef}"`,
      };
    }
    fromAgentId = from.agent.id;
    fromLabel = from.agent.name;
    const { data: messages } = await admin
      .from("claude_code_cli_messages")
      .select("role, content")
      .eq("user_id", args.userId)
      .eq("claude_code_agent_id", from.agent.id)
      .order("created_at", { ascending: false })
      .limit(60);
    sourceMessages = ((messages || []) as Array<{ role: string; content: string }>).reverse();
  }

  if (sourceMessages.length === 0) {
    return { ok: false, error: `No history to transfer from ${fromLabel}` };
  }

  const { summarizeForTransfer } = await import("@/lib/orchestrator/compaction");
  const { summary } = await summarizeForTransfer(
    sourceMessages.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: String(m.content || ""),
    })),
    args.provider || "anthropic",
    args.apiKey
  );

  const finalSummary = args.instructions
    ? `${summary}\n\nHandoff instructions: ${args.instructions.trim()}`
    : summary;

  const { data: transfer, error } = await admin
    .from("context_transfers")
    .insert({
      user_id: args.userId,
      from_agent_id: fromAgentId,
      to_agent_id: to.agent.id,
      summary: finalSummary,
      source_kind: sourceKind,
      source_ref: fromLabel,
    })
    .select("id")
    .single();
  if (error || !transfer) {
    return { ok: false, error: `Failed to store transfer: ${error?.message || "unknown"}` };
  }

  // Make the handoff visible in the target agent's pane.
  await admin
    .from("claude_code_cli_messages")
    .insert({
      user_id: args.userId,
      claude_code_agent_id: to.agent.id,
      role: "user",
      content: `[Context received from ${fromLabel}]\n\n${finalSummary}`,
    })
    .then(() => {});

  return {
    ok: true,
    transferId: String((transfer as { id: unknown }).id),
    fromAgent: fromLabel,
    toAgent: to.agent.name,
    summaryPreview:
      finalSummary.length > 400 ? `${finalSummary.slice(0, 400)}…` : finalSummary,
  };
}

/**
 * Consume pending (unconsumed) context transfers for an agent, returning a
 * prompt block to prepend. Marks them consumed.
 */
async function consumePendingTransfers(
  admin: SupabaseClient,
  userId: string,
  agentId: string
): Promise<{ block: string; ids: string[] } | null> {
  const { data: pending } = await admin
    .from("context_transfers")
    .select("id, summary, source_ref")
    .eq("user_id", userId)
    .eq("to_agent_id", agentId)
    .is("consumed_at", null)
    .order("created_at", { ascending: true })
    .limit(5);
  if (!pending || pending.length === 0) return null;

  const ids = pending.map((row) => String((row as { id: unknown }).id));
  await admin
    .from("context_transfers")
    .update({ consumed_at: new Date().toISOString() })
    .in("id", ids)
    .then(() => {});

  const blocks = pending.map((row) => {
    const r = row as { summary?: unknown; source_ref?: unknown };
    return `[CONTEXT FROM ${asString(r.source_ref) || "another agent"}]\n${String(r.summary || "")}`;
  });
  return { block: blocks.join("\n\n"), ids };
}

/** Restore transfers when the run they were consumed for failed. */
async function restoreTransfers(admin: SupabaseClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await admin
    .from("context_transfers")
    .update({ consumed_at: null })
    .in("id", ids)
    .then(() => {});
}

export const AGENT_TASK_RUN_SCOPE = "agent_task_run";

/**
 * Fire-and-forget execution kick.
 *
 * The task always executes inside the durable run endpoint's OWN invocation
 * (it 202s immediately and runs the task in its `after()` with maxDuration
 * 800). Never run the task inline here — the kicking route (task create,
 * approvals, webhooks) has no such budget and the platform would kill the
 * run mid-flight, stranding the task in `running`.
 */
export function kickAgentTask(args: {
  taskId: string;
  userId: string;
  userEmail?: string | null;
  /** Prefer the origin of the request that created/approved the task. */
  baseUrl?: string | null;
}): void {
  const fire = async () => {
    try {
      const baseUrl =
        (args.baseUrl || "").trim() ||
        getAppUrl();
      const headers = buildInternalRouteAuthHeaders({
        userId: args.userId,
        scope: AGENT_TASK_RUN_SCOPE,
      });
      if (!headers["x-groovy-internal-auth"]) {
        console.warn(
          "[agentTasks] kick skipped: internal auth unavailable (RELAY_JWT_SECRET unset) — task will be picked up by the reconciler"
        );
        return;
      }
      // The endpoint responds 202 immediately; awaiting it only waits for
      // delivery, not for the run.
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/agents/tasks/run`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ taskId: args.taskId, userEmail: args.userEmail || null }),
      });
      if (!res.ok) {
        console.warn(`[agentTasks] kick delivery failed: HTTP ${res.status}`);
      }
    } catch (error) {
      console.warn(
        "[agentTasks] detached kick failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  // Prefer after() so the kick survives the response flush; fall back to an
  // immediate detached fire in non-request contexts.
  import("next/server")
    .then((mod) => {
      const after = (mod as { after?: (fn: () => void | Promise<void>) => void }).after;
      if (typeof after === "function") {
        after(fire);
      } else {
        void fire();
      }
    })
    .catch(() => {
      void fire();
    });
}

/**
 * Re-drive stale tasks: queued tasks that never started, and running tasks
 * whose runner died (no update within the max run budget). Invoked from the
 * scheduler tick as a best-effort reconciler.
 */
export async function reconcileStaleAgentTasks(userId?: string): Promise<{
  requeued: number;
  failed: number;
}> {
  const admin = createSupabaseAdminClient();
  const staleRunningCutoff = new Date(
    Date.now() - (AGENT_TASK_MAX_TIMEOUT_MS + 5 * 60 * 1000)
  ).toISOString();

  let failed = 0;
  {
    let query = admin
      .from("agent_tasks")
      .update({
        status: "failed",
        error: "runner_lost",
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("status", "running")
      .lt("updated_at", staleRunningCutoff);
    if (userId) query = query.eq("user_id", userId);
    const { data } = await query.select("id");
    failed = (data || []).length;
  }

  // Re-kick queued tasks whose original kick never landed (lost fetch,
  // missing internal auth, crashed run endpoint).
  let requeued = 0;
  {
    let query = admin
      .from("agent_tasks")
      .select("id, user_id")
      .eq("status", "queued")
      .lt("created_at", new Date(Date.now() - 60_000).toISOString());
    if (userId) query = query.eq("user_id", userId);
    const { data } = await query.limit(20);
    for (const row of data || []) {
      const task = row as { id: string; user_id: string };
      kickAgentTask({ taskId: task.id, userId: task.user_id });
      requeued += 1;
    }
  }

  return { requeued, failed };
}
