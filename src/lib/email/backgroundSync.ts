export const EMAIL_DISCOVERY_INTERVAL_MS = 15_000;
export const EMAIL_DISCOVERY_STARTUP_DELAY_MS = 2_000;
export const EMAIL_DISCOVERY_RETRY_BASE_MS = 30_000;
export const EMAIL_DISCOVERY_MAX_BACKOFF_MS = 5 * 60_000;

export function shouldCoalesceEmailFeedRequest(args: {
  sameScope: boolean;
  requestInFlight: boolean;
  append: boolean;
  hasCursor: boolean;
}): boolean {
  return (
    args.sameScope &&
    args.requestInFlight &&
    !args.append &&
    !args.hasCursor
  );
}

export function emailDiscoveryDelayAfterFailure(args: {
  status: number;
  consecutiveFailures: number;
}): number {
  if (args.status === 401 || args.status === 403 || args.status === 409) {
    return EMAIL_DISCOVERY_MAX_BACKOFF_MS;
  }
  const attempt = Math.max(1, Math.floor(args.consecutiveFailures));
  const transient =
    args.status === 0 ||
    args.status === 429 ||
    args.status === 503 ||
    args.status >= 500;
  if (!transient) return 60_000;
  return Math.min(
    EMAIL_DISCOVERY_MAX_BACKOFF_MS,
    EMAIL_DISCOVERY_RETRY_BASE_MS * 2 ** Math.min(4, attempt - 1),
  );
}
