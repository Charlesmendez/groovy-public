const RECOVERY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

// Chromium reports ERR_ABORTED when a navigation is intentionally replaced by
// another navigation. Retrying it can interrupt a healthy redirect or reload.
export const ERR_ABORTED = -3;

type TimerHandle = unknown;

type HostedPageRecoveryOptions = {
  recover: () => Promise<void>;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
  onScheduled?: (details: {
    reason: string;
    attempt: number;
    delayMs: number;
  }) => void;
  onRecoveryError?: (error: unknown) => void;
};

export function shouldRecoverFailedLoad(
  errorCode: number,
  isMainFrame: boolean
): boolean {
  return isMainFrame && errorCode !== ERR_ABORTED;
}

export function hostedPageRecoveryDelayMs(attempt: number): number {
  const index = Math.min(
    Math.max(0, Math.floor(attempt)),
    RECOVERY_DELAYS_MS.length - 1
  );
  return RECOVERY_DELAYS_MS[index];
}

export function isHostedPageUrl(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Chromium can replace a failed hosted navigation with an internal error page
 * without emitting did-fail-load. Once loading has stopped, any non-empty,
 * non-startup URL outside the configured app origin is therefore unhealthy.
 */
export function shouldRecoverUnexpectedPage(
  url: string,
  origin: string,
  isLoadingMainFrame: boolean
): boolean {
  if (isLoadingMainFrame || !url || url === "about:blank") return false;
  return !isHostedPageUrl(url, origin);
}

export function hostedPageRecoveryUrl(
  currentUrl: string,
  origin: string,
  fallbackUrl: string
): string {
  return isHostedPageUrl(currentUrl, origin) ? currentUrl : fallbackUrl;
}

/**
 * Coalesces main-frame and renderer failures into one bounded retry loop.
 * A successful hosted-page load resets the backoff. Failures raised while a
 * recovery load is in flight are retried after that load promise settles.
 */
export class HostedPageRecovery {
  private readonly recover: () => Promise<void>;
  private readonly schedule: (
    callback: () => void,
    delayMs: number
  ) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;
  private readonly onScheduled?: HostedPageRecoveryOptions["onScheduled"];
  private readonly onRecoveryError?: HostedPageRecoveryOptions["onRecoveryError"];
  private timer: TimerHandle | null = null;
  private attempt = 0;
  private inFlight = false;
  private failedWhileInFlight = false;
  private disposed = false;

  constructor(options: HostedPageRecoveryOptions) {
    this.recover = options.recover;
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return timer;
      });
    this.cancel =
      options.cancel ??
      ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.onScheduled = options.onScheduled;
    this.onRecoveryError = options.onRecoveryError;
  }

  noteFailure(reason: string): void {
    if (this.disposed) return;
    if (this.inFlight) {
      this.failedWhileInFlight = true;
      return;
    }
    if (this.timer !== null) return;

    const attempt = this.attempt + 1;
    const delayMs = hostedPageRecoveryDelayMs(this.attempt);
    this.attempt = attempt;
    this.onScheduled?.({ reason, attempt, delayMs });
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.runRecovery();
    }, delayMs);
  }

  noteSuccess(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.inFlight = false;
    this.failedWhileInFlight = false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  private async runRecovery(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    this.inFlight = true;
    this.failedWhileInFlight = false;
    try {
      await this.recover();
      if (this.failedWhileInFlight) {
        throw new Error("Hosted page failed while recovery was in flight");
      }
      this.noteSuccess();
    } catch (error) {
      this.inFlight = false;
      this.failedWhileInFlight = false;
      this.onRecoveryError?.(error);
      this.noteFailure("recovery load failed");
    }
  }
}
