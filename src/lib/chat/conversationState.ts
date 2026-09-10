export function updateKeyedValue<T>(
  current: ReadonlyMap<string, T>,
  key: string,
  fallback: T,
  update: (value: T) => T,
): Map<string, T> {
  const nextValue = update(current.get(key) ?? fallback);
  const next = new Map(current);
  next.set(key, nextValue);
  return next;
}

export function updatePendingCount(
  current: ReadonlyMap<string, number>,
  key: string,
  delta: 1 | -1,
): Map<string, number> {
  const next = new Map(current);
  const count = Math.max(0, (current.get(key) || 0) + delta);
  if (count === 0) next.delete(key);
  else next.set(key, count);
  return next;
}

export function keyedOperationPending(
  current: ReadonlyMap<string, number>,
  key: string | null | undefined,
): boolean {
  return Boolean(key && (current.get(key) || 0) > 0);
}

export function chatWorkspaceActivationState({
  hasActivated,
  visible,
}: {
  hasActivated: boolean;
  visible: boolean;
}): { hasActivated: boolean; shouldReconcile: boolean } {
  return {
    hasActivated: hasActivated || visible,
    shouldReconcile: hasActivated && visible,
  };
}

/**
 * Keep the optimistic Mind card mounted until the authoritative work refresh
 * has committed. Releasing first creates a one-render gap before the live run
 * or delegated task appears.
 */
export async function handoffPendingOrchestratorStart({
  refreshActiveWork,
  releasePending,
}: {
  refreshActiveWork: () => Promise<unknown>;
  releasePending: () => void;
}): Promise<void> {
  try {
    await refreshActiveWork();
  } catch {
    // The normal active-work poll can recover; the pending send must still be
    // released so a failed refresh cannot leave the starting card forever.
  } finally {
    releasePending();
  }
}

export function shouldFollowTimelineGrowth({
  sticksToBottom,
  hasNewer,
  restoringHistory,
}: {
  sticksToBottom: boolean;
  hasNewer: boolean;
  restoringHistory: boolean;
}): boolean {
  return sticksToBottom && !hasNewer && !restoringHistory;
}
