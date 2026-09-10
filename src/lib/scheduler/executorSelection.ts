function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

/**
 * A worker-owned schedule must run on that worker's connector. The account's
 * preferred/recent connector is only a fallback for orchestrator-owned jobs.
 */
export function resolveScheduledExecutionDeviceId(args: {
  fallbackDeviceId: unknown;
  workerDeviceId?: unknown;
}): string | null {
  return (
    optionalString(args.workerDeviceId) ||
    optionalString(args.fallbackDeviceId)
  );
}
