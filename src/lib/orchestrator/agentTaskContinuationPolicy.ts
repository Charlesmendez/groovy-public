export type AgentTaskContinuationTarget =
  | { kind: "dashboard" }
  | { kind: "team_chat"; channelId: string };

type ContinuationCandidate = {
  id?: unknown;
  source?: unknown;
  status?: unknown;
  orchestrator_session_id?: unknown;
  requested_channel?: unknown;
  trace_id?: unknown;
  turn_id?: unknown;
  result_meta?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeAgentTaskContinuationDepth(value: unknown): number {
  const depth = Number(value);
  return Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
}

export function nextAgentTaskContinuationDepth(
  tasks: Array<Pick<ContinuationCandidate, "result_meta">>,
): number {
  return (
    Math.max(
      0,
      ...tasks.map((task) =>
        normalizeAgentTaskContinuationDepth(
          record(task.result_meta).orchestrator_continuation_depth,
        ),
      ),
    ) + 1
  );
}

export function agentTaskContinuationLimitReached(args: {
  depth: unknown;
  maxTurns: unknown;
}): boolean {
  const maxTurns = Number(args.maxTurns);
  const normalizedMax = Number.isFinite(maxTurns)
    ? Math.max(1, Math.floor(maxTurns))
    : 8;
  return normalizeAgentTaskContinuationDepth(args.depth) >= normalizedMax;
}

function identifier(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A model round can fan out to several durable workers. Trace id is the most
 * precise grouping key; turn id is retained as a fallback for older tasks.
 * Session-wide grouping is intentionally forbidden because it can combine
 * unrelated human turns that happen to share one orchestrator session.
 */
export function sameAgentTaskDelegationGroup(
  left: ContinuationCandidate,
  right: ContinuationCandidate,
): boolean {
  const leftTraceId = identifier(left.trace_id);
  const rightTraceId = identifier(right.trace_id);
  if (leftTraceId || rightTraceId) {
    return Boolean(leftTraceId && leftTraceId === rightTraceId);
  }

  const leftTurnId = identifier(left.turn_id);
  const rightTurnId = identifier(right.turn_id);
  if (leftTurnId || rightTurnId) {
    return Boolean(leftTurnId && leftTurnId === rightTurnId);
  }

  const leftId = identifier(left.id);
  const rightId = identifier(right.id);
  return Boolean(leftId && leftId === rightId);
}

export function hasOpenAgentTaskDelegation(
  tasks: Array<Pick<ContinuationCandidate, "status">>,
): boolean {
  return tasks.some(
    (task) =>
      task.status === "queued" ||
      task.status === "running" ||
      task.status === "awaiting_approval",
  );
}

/**
 * Approval-only rounds may respond with the approval request. Every task that
 * has actually started (or already terminated quickly) must instead finish
 * through the durable controller continuation.
 */
export function shouldDeferAgentTaskFinal(
  tasks: Array<Pick<ContinuationCandidate, "status">>,
): boolean {
  return tasks.some((task) => task.status !== "awaiting_approval");
}

/**
 * Only asynchronous tasks created by the orchestrator re-enter its controller
 * loop. Inline waits already return their result to the same model turn, while
 * API-created tasks are direct worker conversations.
 */
export function resolveAgentTaskContinuationTarget(
  task: ContinuationCandidate,
): AgentTaskContinuationTarget | null {
  if (
    task.source !== "orchestrator" ||
    (task.status !== "done" &&
      task.status !== "failed" &&
      task.status !== "canceled") ||
    typeof task.orchestrator_session_id !== "string" ||
    !task.orchestrator_session_id.trim()
  ) {
    return null;
  }

  const meta = record(task.result_meta);
  if (
    meta.orchestrator_wait_inline === true ||
    meta.consultation_mode === true
  ) {
    return null;
  }

  const requestedChannel =
    typeof task.requested_channel === "string"
      ? task.requested_channel.trim()
      : "";
  if (!requestedChannel || requestedChannel === "dashboard") {
    return { kind: "dashboard" };
  }

  const prefix = "team_chat:";
  if (requestedChannel.startsWith(prefix)) {
    const channelId = requestedChannel.slice(prefix.length).trim();
    return channelId ? { kind: "team_chat", channelId } : null;
  }

  // WhatsApp, Telegram, schedules, and public API threads keep their existing
  // delivery adapters until they can preserve a full controller continuation.
  return null;
}
