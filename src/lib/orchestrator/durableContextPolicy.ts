export type DurableContextScopeFilter = {
  epochId?: string | null;
  branchId?: string | null;
  useBranchScope?: boolean;
};

const ROLLUP_TRIGGER_MESSAGES = 160;
const ROLLUP_TRIGGER_CHARS = 300_000;
const KEEP_RECENT_MESSAGES = 80;
const KEEP_RECENT_CHARS = 120_000;

export function durableContextScopeKey(
  filter: DurableContextScopeFilter,
): string {
  if (filter.useBranchScope && filter.branchId) {
    return `branch:${filter.branchId}`;
  }
  if (filter.epochId) return `epoch:${filter.epochId}`;
  return "session";
}

export function checkpointRollupCount(
  messages: Array<{ content: string }>,
): number {
  const totalChars = messages.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  if (
    messages.length <= ROLLUP_TRIGGER_MESSAGES &&
    totalChars <= ROLLUP_TRIGGER_CHARS
  ) {
    return 0;
  }

  let keptMessages = 0;
  let keptChars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const nextChars = messages[index].content.length;
    if (
      keptMessages > 0 &&
      (keptMessages >= KEEP_RECENT_MESSAGES ||
        keptChars + nextChars > KEEP_RECENT_CHARS)
    ) {
      break;
    }
    keptMessages += 1;
    keptChars += nextChars;
  }
  return Math.max(0, messages.length - Math.max(1, keptMessages));
}
