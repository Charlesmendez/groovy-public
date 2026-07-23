import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelMessage } from "ai";
import type { ConnectorClientPlatform } from "@/lib/connector/platform";
import type { BranchControllerSettings } from "./branchController";
import type { HarnessProfile } from "./harnessProfiles";
import {
  finalizeWorkerBranch,
  getActiveBranchCount,
  abortStaleWorkerBranches,
  spawnWorkerBranches,
} from "./runtimeGraph";
import type { ConnectorExecute, FilesAgentSession, GeneratedFileRef } from "./runOrchestratorRound";

type ToolResultInput = {
  toolCallId: string;
  toolName: string;
  result: string;
};

export type ParallelBranchConnectorToolResultInput = ToolResultInput & {
  branchId: string;
};

export type ParallelBranchRuntimeContext = {
  orchestratorAgentId: string;
  orchestratorSessionId?: string | null;
  epochId: string;
  appBaseUrl?: string;
  deviceId: string;
  connectorPlatform?: ConnectorClientPlatform;
  obsidianVaultPath?: string | null;
  codeTerminalId?: string | null;
  codeWorkspaceRootPath?: string | null;
  filesAgent?: FilesAgentSession | null;
  aiChatAgents?: Array<{ id: string; name: string; systemPrompt?: string }>;
  webPixelNames?: string[];
  localTimezone?: string;
  scheduledMode?: boolean;
  traceId?: string;
  harnessProfile?: HarnessProfile | null;
};

type ParallelBranchWorkerResult = {
  branchId: string;
  title: string;
  goal: string;
  status: "completed" | "aborted" | "failed" | "connector_required" | "ui_open_code_required";
  summary: string;
  toolCallsExecuted: string[];
  generatedFiles?: GeneratedFileRef[];
};

type ParallelBranchWorkerState = {
  branchId: string;
  title: string;
  goal: string;
  history: ModelMessage[];
  budgetRemaining: number;
  waitingForConnector: boolean;
  pendingToolResults?: ToolResultInput[];
  result?: ParallelBranchWorkerResult;
};

export type ParallelBranchRuntimeState = {
  version: 1;
  requestedTasks: number;
  launchedTasks: number;
  skippedTasks: number;
  branchController: BranchControllerSettings;
  context: ParallelBranchRuntimeContext;
  workers: ParallelBranchWorkerState[];
  pendingConnectorExecutes?: ParallelBranchBatchConnectorExecute[];
};

export type ParallelBranchBatchConnectorExecute = ConnectorExecute & {
  branchId: string;
  branchTitle: string;
  branchGoal: string;
};

export type ParallelBranchBatchEnvelope =
  | {
      version: 1;
      kind: "final";
      result: {
        requestedTasks: number;
        launchedTasks: number;
        skippedTasks: number;
        branchController: BranchControllerSettings;
        results: ParallelBranchWorkerResult[];
      };
    }
  | {
      version: 1;
      kind: "needs_connector";
      state: ParallelBranchRuntimeState;
      connectorExecutes: ParallelBranchBatchConnectorExecute[];
    };

type StartParallelBranchRuntimeArgs = {
  supabase: SupabaseClient;
  userId: string;
  parentBranchId: string;
  branchController: BranchControllerSettings;
  context: ParallelBranchRuntimeContext;
  tasks: Array<{ title?: string | null; goal: string }>;
  sharedContext?: string | null;
  cookies?: string;
  deviceToken?: string | null;
};

type ContinueParallelBranchRuntimeArgs = {
  supabase: SupabaseClient;
  userId: string;
  state: ParallelBranchRuntimeState;
  toolResults?: ParallelBranchConnectorToolResultInput[];
  cookies?: string;
  deviceToken?: string | null;
};

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncateText(value: string, max = 2400): string {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...(truncated)`;
}

function cloneMessages(messages: ModelMessage[]): ModelMessage[] {
  return (messages || []).map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? JSON.parse(JSON.stringify(message.content))
      : message.content,
  }));
}

function buildWorkerMessage(args: {
  title: string;
  goal: string;
  sharedContext?: string | null;
}): string {
  return [
    `Hidden worker branch: ${args.title}`,
    args.sharedContext ? `Shared context:\n${args.sharedContext}` : null,
    `Your only subtask:\n${args.goal}`,
    "Work independently. Return concise findings, evidence, and any concrete outputs needed by the parent branch.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildToolResultsHistoryMessage(toolResults: ToolResultInput[]): ModelMessage | null {
  const safe = (toolResults || []).filter(
    (tr) =>
      typeof tr?.toolCallId === "string" &&
      typeof tr?.toolName === "string" &&
      typeof tr?.result === "string"
  );
  if (safe.length === 0) return null;
  const resultsText = safe
    .map((tr) => {
      let text = tr.result;
      if (text.length > 8000) {
        text = `${text.slice(0, 8000)}\n...[truncated]`;
      }
      return `<tool_result name="${tr.toolName}" tool_call_id="${tr.toolCallId}">\n${text}\n</tool_result>`;
    })
    .join("\n\n");
  return {
    role: "user",
    content:
      `[SYSTEM: Tool execution results from your previous request]\n\n${resultsText}\n\n` +
      `IMPORTANT: These are the results from the local connector work you requested. ` +
      `Process them and either finish the worker task or call the next tool you need.`,
  };
}

function normalizeIncomingToolResults(
  toolResults: ParallelBranchConnectorToolResultInput[] | undefined
): Map<string, ToolResultInput[]> {
  const grouped = new Map<string, ToolResultInput[]>();
  for (const raw of toolResults || []) {
    const branchId = asTrimmed(raw.branchId);
    const toolCallId = asTrimmed(raw.toolCallId);
    const toolName = asTrimmed(raw.toolName);
    const result = typeof raw.result === "string" ? raw.result : "";
    if (!branchId || !toolCallId || !toolName || !result) continue;
    const current = grouped.get(branchId) || [];
    current.push({ toolCallId, toolName, result });
    grouped.set(branchId, current);
  }
  return grouped;
}

function finalizeBatchResult(
  state: ParallelBranchRuntimeState
): Extract<ParallelBranchBatchEnvelope, { kind: "final" }> {
  return {
    version: 1,
    kind: "final",
    result: {
      requestedTasks: state.requestedTasks,
      launchedTasks: state.launchedTasks,
      skippedTasks: state.skippedTasks,
      branchController: state.branchController,
      results: state.workers
        .map((worker) => worker.result)
        .filter((result): result is ParallelBranchWorkerResult => !!result),
    },
  };
}

function buildUiOpenCodeAbortResult(worker: ParallelBranchWorkerState): ParallelBranchWorkerResult {
  return {
    branchId: worker.branchId,
    title: worker.title,
    goal: worker.goal,
    status: "ui_open_code_required",
    summary:
      "Worker branch requested an interactive UI code session, which is not supported inside hidden branch fanout.",
    toolCallsExecuted: [],
  };
}

function buildBudgetLimitAbortResult(worker: ParallelBranchWorkerState): ParallelBranchWorkerResult {
  return {
    branchId: worker.branchId,
    title: worker.title,
    goal: worker.goal,
    status: "aborted",
    summary: "Worker branch exhausted its Branch Controller execution budget before completion.",
    toolCallsExecuted: [],
  };
}

async function completeWorker(
  supabase: SupabaseClient,
  userId: string,
  worker: ParallelBranchWorkerState,
  result: ParallelBranchWorkerResult,
  reason?: string
) {
  worker.waitingForConnector = false;
  worker.pendingToolResults = undefined;
  worker.result = result;
  await finalizeWorkerBranch({
    supabase,
    userId,
    branchId: worker.branchId,
    status: result.status === "completed" ? "merged" : "aborted",
    summary: result.summary,
    reason:
      reason ||
      (result.status === "completed"
        ? "runtime_branch_parallel_completed"
        : "runtime_branch_parallel_aborted"),
    payload: {
      title: result.title,
      goal: result.goal,
      status: result.status,
      toolCallsExecuted: result.toolCallsExecuted,
      generatedFiles: result.generatedFiles || [],
    },
  });
}

async function advanceParallelBranchRuntime(args: ContinueParallelBranchRuntimeArgs): Promise<ParallelBranchBatchEnvelope> {
  const { supabase, userId, state } = args;
  const incomingResultsByBranch = normalizeIncomingToolResults(args.toolResults);
  const existingPendingConnectorExecutes = Array.isArray(state.pendingConnectorExecutes)
    ? state.pendingConnectorExecutes
    : [];
  if (incomingResultsByBranch.size > 0) {
    state.pendingConnectorExecutes = existingPendingConnectorExecutes.filter(
      (execute) => !incomingResultsByBranch.has(execute.branchId)
    );
  }

  for (const worker of state.workers) {
    if (worker.result) continue;
    const incoming = incomingResultsByBranch.get(worker.branchId) || [];
    if (incoming.length === 0) continue;
    const historyMessage = buildToolResultsHistoryMessage(incoming);
    if (historyMessage) {
      worker.history = [...cloneMessages(worker.history), historyMessage];
    }
    worker.pendingToolResults = incoming;
    worker.waitingForConnector = false;
  }

  const connectorExecutes: ParallelBranchBatchConnectorExecute[] = [];
  const activeBranchCount = await getActiveBranchCount({
    supabase,
    userId,
    agentId: state.context.orchestratorAgentId,
    epochId: state.context.epochId,
  });
  const { runOrchestratorRound } = await import("./runOrchestratorRound");

  const runnableWorkers = state.workers.filter((worker) => !worker.result && !worker.waitingForConnector);
  if (runnableWorkers.length > 0) {
    await Promise.all(
      runnableWorkers.map(async (worker) => {
        if (worker.budgetRemaining <= 0) {
          await completeWorker(
            supabase,
            userId,
            worker,
            buildBudgetLimitAbortResult(worker),
            "budget_limit_hit"
          );
          return;
        }
        try {
          const round = await runOrchestratorRound({
            supabase,
            userId,
            appBaseUrl: state.context.appBaseUrl,
            deviceId: state.context.deviceId,
            connectorPlatform: state.context.connectorPlatform,
            obsidianVaultPath: state.context.obsidianVaultPath || null,
            codeTerminalId: state.context.codeTerminalId || null,
            codeWorkspaceRootPath: state.context.codeWorkspaceRootPath || null,
            history: cloneMessages(worker.history),
            message: "",
            profile: state.context.harnessProfile,
            memoryEnabled: false,
            cookies: args.cookies,
            deviceToken: args.deviceToken || undefined,
            aiChatAgents: state.context.aiChatAgents,
            webPixelNames: state.context.webPixelNames,
            filesAgent: state.context.filesAgent || null,
            localTimezone: state.context.localTimezone,
            scheduledMode: state.context.scheduledMode === true,
            orchestratorAgentId: state.context.orchestratorAgentId,
            orchestratorSessionId: state.context.orchestratorSessionId || null,
            branchControllerSettings: state.branchController,
            maxSteps: Math.max(1, worker.budgetRemaining),
            runtimeScopeOverride: {
              agentId: state.context.orchestratorAgentId,
              epochId: state.context.epochId,
              branchId: worker.branchId,
              branchTurnCount: 0,
              activeBranchCount,
            },
            branchRole: "worker",
            branchGoal: worker.goal,
            traceId: state.context.traceId
              ? `${state.context.traceId}-branch-${worker.branchId.slice(0, 8)}`
              : undefined,
          });
          const spentBudget = Math.max(
            1,
            Array.isArray(round.toolCallsExecuted) ? round.toolCallsExecuted.length : 0
          );
          worker.budgetRemaining = Math.max(0, worker.budgetRemaining - spentBudget);

          if (round.kind === "final") {
            await completeWorker(supabase, userId, worker, {
              branchId: worker.branchId,
              title: worker.title,
              goal: worker.goal,
              status: "completed",
              summary: truncateText(round.text || "(empty worker result)"),
              toolCallsExecuted: round.toolCallsExecuted,
              generatedFiles: round.generatedFiles || [],
            });
            return;
          }

          if (round.kind === "needs_connector") {
            worker.waitingForConnector = true;
            worker.pendingToolResults = undefined;
            for (const execute of round.connectorExecutes) {
              connectorExecutes.push({
                ...execute,
                branchId: worker.branchId,
                branchTitle: worker.title,
                branchGoal: worker.goal,
              });
            }
            return;
          }

          const result =
            round.kind === "ui_open_code"
              ? buildUiOpenCodeAbortResult(worker)
              : {
                  branchId: worker.branchId,
                  title: worker.title,
                  goal: worker.goal,
                  status: "aborted" as const,
                  summary: truncateText(
                    round.partialText || "Worker branch could not complete inside hidden branch fanout."
                  ),
                  toolCallsExecuted: round.toolCallsExecuted,
                };
          await completeWorker(
            supabase,
            userId,
            worker,
            result,
            round.kind === "ui_open_code" ? "ui_open_code_required" : "runtime_branch_parallel_aborted"
          );
        } catch (error) {
          await completeWorker(
            supabase,
            userId,
            worker,
            {
              branchId: worker.branchId,
              title: worker.title,
              goal: worker.goal,
              status: "failed",
              summary: truncateText(
                error instanceof Error ? error.message : "Worker branch failed."
              ),
              toolCallsExecuted: [],
            },
            "worker_exception"
          );
        }
      })
    );
  }

  if (connectorExecutes.length > 0) {
    const combinedPendingConnectorExecutes = [
      ...(Array.isArray(state.pendingConnectorExecutes) ? state.pendingConnectorExecutes : []),
      ...connectorExecutes,
    ];
    state.pendingConnectorExecutes = combinedPendingConnectorExecutes;
    return {
      version: 1,
      kind: "needs_connector",
      state,
      connectorExecutes: combinedPendingConnectorExecutes,
    };
  }

  const stillWaiting = state.workers.some((worker) => !worker.result && worker.waitingForConnector);
  if (stillWaiting && Array.isArray(state.pendingConnectorExecutes) && state.pendingConnectorExecutes.length > 0) {
    return {
      version: 1,
      kind: "needs_connector",
      state,
      connectorExecutes: state.pendingConnectorExecutes,
    };
  }

  return finalizeBatchResult(state);
}

export async function startParallelBranchRuntime(
  args: StartParallelBranchRuntimeArgs
): Promise<ParallelBranchBatchEnvelope> {
  const { supabase, userId, context, tasks } = args;
  const normalizedTasks = (tasks || [])
    .map((task, index) => {
      const goal = asTrimmed(task.goal);
      if (!goal) return null;
      const title = asTrimmed(task.title) || `worker-${index + 1}`;
      return { title, goal };
    })
    .filter((task): task is { title: string; goal: string } => !!task);
  if (normalizedTasks.length === 0) {
    throw new Error("runtime_branch_parallel requires at least one non-empty task goal.");
  }

  let currentActive = await getActiveBranchCount({
    supabase,
    userId,
    agentId: context.orchestratorAgentId,
    epochId: context.epochId,
  });
  const maxBranches = Number(args.branchController.maxBranches);
  const maxBranchesLabel =
    Number.isFinite(maxBranches) && maxBranches > 0 ? Math.floor(maxBranches) : null;
  let availableSlots =
    Number.isFinite(maxBranches) && maxBranches > 0
      ? Math.max(0, Math.floor(maxBranches) - currentActive)
      : normalizedTasks.length;

  if (availableSlots <= 0) {
    const aborted = await abortStaleWorkerBranches({
      supabase,
      userId,
      agentId: context.orchestratorAgentId,
      epochId: context.epochId,
    });
    if (aborted > 0) {
      currentActive = await getActiveBranchCount({
        supabase,
        userId,
        agentId: context.orchestratorAgentId,
        epochId: context.epochId,
      });
      availableSlots =
        Number.isFinite(maxBranches) && maxBranches > 0
          ? Math.max(0, Math.floor(maxBranches) - currentActive)
          : normalizedTasks.length;
    }
  }

  if (availableSlots <= 0) {
    throw new Error(
      `Branch Controller blocked parallel spawning: active branches are already at the configured limit (${currentActive}/${maxBranchesLabel ?? "n/a"}).`
    );
  }

  const spawned = await spawnWorkerBranches({
    supabase,
    userId,
    agentId: context.orchestratorAgentId,
    epochId: context.epochId,
    parentBranchId: args.parentBranchId,
    maxBranches: args.branchController.maxBranches,
    tasks: normalizedTasks,
  });
  if (spawned.length === 0) {
    throw new Error("Failed to allocate worker branches.");
  }

  const workerStates: ParallelBranchWorkerState[] = spawned.map((branch) => ({
    branchId: branch.branchId,
    title: branch.title,
    goal: branch.goal,
    budgetRemaining: Math.max(1, args.branchController.maxTurnsPerBranch),
    waitingForConnector: false,
    history: [
      {
        role: "user",
        content: buildWorkerMessage({
          title: branch.title,
          goal: branch.goal,
          sharedContext: args.sharedContext || null,
        }),
      },
    ],
  }));

  return advanceParallelBranchRuntime({
    supabase,
    userId,
    cookies: args.cookies,
    deviceToken: args.deviceToken || undefined,
    state: {
      version: 1,
      requestedTasks: normalizedTasks.length,
      launchedTasks: spawned.length,
      skippedTasks: Math.max(0, normalizedTasks.length - spawned.length),
      branchController: args.branchController,
      context,
      workers: workerStates,
    },
  });
}

export async function continueParallelBranchRuntime(
  args: ContinueParallelBranchRuntimeArgs
): Promise<ParallelBranchBatchEnvelope> {
  return advanceParallelBranchRuntime(args);
}
