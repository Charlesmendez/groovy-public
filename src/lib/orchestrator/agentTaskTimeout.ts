export const CODE_AGENT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const CODE_AGENT_RELAY_TIMEOUT_MS =
  CODE_AGENT_RUN_TIMEOUT_MS + 2 * 60 * 1000;
export const CODE_AGENT_TIMEOUT_CONTINUATIONS = 1;

export const CODE_AGENT_TIMEOUT_CONTINUE_PROMPT =
  "Continue from where you left off. Do not repeat completed tool calls or duplicate file edits. Finish the current task and return the final answer directly.";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isCodeAgentTimeoutResult(
  result: Record<string, unknown>,
): boolean {
  if (result.timed_out === true) return true;
  const error = nonEmptyString(result.error);
  return !!error && /\b(?:timed out|time limit|relay_timeout)\b/i.test(error);
}

export function timeoutContinuationCount(
  resultMeta: Record<string, unknown> | null | undefined,
): number {
  const raw = Number(resultMeta?.timeout_continuation_count);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}

export function shouldContinueTimedOutCodeAgent(args: {
  result: Record<string, unknown>;
  resultMeta: Record<string, unknown> | null | undefined;
  sessionId: string | null | undefined;
}): boolean {
  return (
    isCodeAgentTimeoutResult(args.result) &&
    !!nonEmptyString(args.sessionId) &&
    timeoutContinuationCount(args.resultMeta) <
      CODE_AGENT_TIMEOUT_CONTINUATIONS
  );
}

export function appendTimeoutContinuationNotice(
  liveText: unknown,
  attempt: number,
): string {
  const prior = typeof liveText === "string" ? liveText.trimEnd() : "";
  const notice =
    `Time limit reached. Automatically continuing from the same agent session ` +
    `(attempt ${attempt}/${CODE_AGENT_TIMEOUT_CONTINUATIONS})…`;
  return prior ? `${prior}\n\n— ${notice} —\n\n` : `${notice}\n\n`;
}
