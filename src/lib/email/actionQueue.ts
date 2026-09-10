export type EmailActionQueuePhase =
  | "queued"
  | "processing"
  | "retrying"
  | "failed";

type ErrorRecord = {
  status?: unknown;
  payload?: unknown;
};

type RetryPayload = {
  retryable?: unknown;
  retryAfterMs?: unknown;
};

export type EmailActionAttemptState = {
  phase: "processing" | "retrying";
  attempt: number;
  delayMs?: number;
};

export type RunEmailActionWithRetryOptions<Result = void> = {
  execute: () => Promise<Result>;
  onState?: (state: EmailActionAttemptState) => void;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
};

type QueuedTask = {
  key: string;
  run: () => Promise<void>;
};

const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const MAX_SERVER_RETRY_AFTER_MS = 20_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numeric(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function retryableEmailActionError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const source = record(error) as ErrorRecord | null;
  const status = numeric(source?.status);
  const payload = record(source?.payload) as RetryPayload | null;
  if (payload?.retryable === true) return true;
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== null && status >= 500 && status <= 599)
  );
}

export function emailActionRetryDelayMs(
  error: unknown,
  fallbackMs: number,
): number {
  const source = record(error) as ErrorRecord | null;
  const payload = record(source?.payload) as RetryPayload | null;
  const retryAfterMs = numeric(payload?.retryAfterMs);
  if (retryAfterMs === null || retryAfterMs <= 0) return fallbackMs;
  return Math.min(
    MAX_SERVER_RETRY_AFTER_MS,
    Math.max(fallbackMs, retryAfterMs),
  );
}

export async function runEmailActionWithRetry<Result = void>({
  execute,
  onState,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = (delayMs) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    }),
}: RunEmailActionWithRetryOptions<Result>): Promise<Result> {
  for (let attempt = 1; ; attempt += 1) {
    onState?.({ phase: "processing", attempt });
    try {
      return await execute();
    } catch (error) {
      const fallbackDelay = retryDelaysMs[attempt - 1];
      if (
        fallbackDelay === undefined ||
        !retryableEmailActionError(error)
      ) {
        throw error;
      }
      const delayMs = emailActionRetryDelayMs(error, fallbackDelay);
      onState?.({ phase: "retrying", attempt, delayMs });
      await sleep(delayMs);
    }
  }
}

/**
 * A small FIFO used by the email workspace. Each task owns its own success and
 * failure handling; the queue guarantees that a later Gmail mutation never
 * overtakes an earlier one and always continues after a failed task.
 */
export class SerialEmailActionQueue {
  private readonly queuedKeys = new Set<string>();
  private readonly tasks: QueuedTask[] = [];
  private running = false;

  enqueue(task: QueuedTask): boolean {
    if (this.queuedKeys.has(task.key)) return false;
    this.queuedKeys.add(task.key);
    this.tasks.push(task);
    void this.drain();
    return true;
  }

  has(key: string): boolean {
    return this.queuedKeys.has(key);
  }

  get size(): number {
    return this.queuedKeys.size;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.tasks.length > 0) {
        const task = this.tasks.shift();
        if (!task) continue;
        try {
          await task.run();
        } catch {
          // A task is responsible for surfacing its own failure. The queue
          // must still release the key and continue with later user actions.
        } finally {
          this.queuedKeys.delete(task.key);
        }
      }
    } finally {
      this.running = false;
      // An enqueue can land after the loop observes an empty array but before
      // running flips back to false.
      if (this.tasks.length > 0) void this.drain();
    }
  }
}
