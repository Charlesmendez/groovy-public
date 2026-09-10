export type AgentTaskAccessMode = "read_only" | "read_write";

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseAgentTaskAccessMode(
  value: unknown,
): AgentTaskAccessMode | null {
  return value === "read_only" || value === "read_write" ? value : null;
}

export function isAgentTaskReadOnly(
  resultMeta: Record<string, unknown> | null | undefined,
): boolean {
  const meta = resultMeta || {};
  return (
    meta.access_mode === "read_only" ||
    meta.plan_mode === true ||
    meta.consultation_mode === true
  );
}

/**
 * Background tasks own their harness session. They must not inherit the
 * worker's interactive thread, which can be unrelated or already removed by
 * the local CLI's transcript cleanup.
 */
export function resolveAgentTaskResumeSessionId(
  taskHarnessSessionId: unknown,
): string | null {
  return normalizedString(taskHarnessSessionId);
}

export function verifiedAgentTaskSessionId(args: {
  ok: boolean;
  reportedSessionId: unknown;
}): string | null {
  return args.ok ? normalizedString(args.reportedSessionId) : null;
}

export function nextAgentTaskHarnessSessionId(args: {
  ok: boolean;
  reportedSessionId: unknown;
  previousSessionId: unknown;
  sessionRecoveryAttempted?: boolean;
}): string | null {
  const reported = normalizedString(args.reportedSessionId);
  const previous = normalizedString(args.previousSessionId);
  if (args.ok) return reported || previous;
  if (args.sessionRecoveryAttempted) return null;
  return reported || previous;
}
