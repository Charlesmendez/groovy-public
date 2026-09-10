export class EmptyModelResponseError extends Error {
  readonly finishReason: string | null;

  constructor(finishReason?: string | null) {
    super(
      `The model stream completed without assistant text, a usable tool result, or a continuation request${
        finishReason ? ` (finish reason: ${finishReason})` : ""
      }.`,
    );
    this.name = "EmptyModelResponseError";
    this.finishReason = finishReason || null;
  }
}

export class ModelStreamCompletionError extends Error {
  readonly finishReason: string;

  constructor(finishReason: string) {
    super(`The model stream ended with finish reason "${finishReason}".`);
    this.name = "ModelStreamCompletionError";
    this.finishReason = finishReason;
  }
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message.trim()) return value.message.trim();
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error", "detail"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
    try {
      const serialized = JSON.stringify(value);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Fall through to the generic message.
    }
  }
  return "The model stream failed without an error message.";
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * AI SDK full streams surface provider failures as `error` events. Preserve
 * common status fields so the orchestrator's retry/key-fallback logic can make
 * the same decision it would make for a normally thrown provider error.
 */
export function modelStreamEventError(value: unknown): Error {
  if (value instanceof Error) return value;

  // Responses API stream errors arrive as
  // { type: "error", error: { type, code, message, ... } }. Normalize the
  // nested provider error so callers see the actionable message and code
  // instead of a serialized wrapper object.
  const source = errorRecord(value);
  const nested = errorRecord(source?.error);
  const details = nested || source;
  const error = new Error(errorMessage(details || value), { cause: value });
  const target = error as Error & Record<string, unknown>;
  for (const key of [
    "status",
    "statusCode",
    "responseBody",
    "code",
    "type",
    "param",
  ]) {
    if (details?.[key] !== undefined) {
      target[key] = details[key];
    } else if (source?.[key] !== undefined) {
      target[key] = source[key];
    }
  }
  return error;
}

function isQuotaSignal(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "insufficient_quota" ||
    normalized === "quota_exceeded" ||
    normalized === "billing_hard_limit_reached" ||
    normalized.includes("exceeded your current quota") ||
    normalized.includes("available quota is exhausted")
  );
}

/**
 * Detect non-transient account/project quota exhaustion without confusing it
 * with ordinary request-per-minute or token-per-minute rate limits.
 */
export function isInsufficientQuotaError(
  value: unknown,
  depth = 0,
): boolean {
  if (depth > 5 || value == null) return false;
  if (typeof value === "string") return isQuotaSignal(value);
  if (value instanceof Error) {
    if (isQuotaSignal(value.message)) return true;
    const record = value as Error & Record<string, unknown>;
    for (const key of ["code", "type", "responseBody", "cause"]) {
      if (isInsufficientQuotaError(record[key], depth + 1)) return true;
    }
    return false;
  }
  if (typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  for (const key of [
    "code",
    "type",
    "message",
    "error",
    "cause",
    "responseBody",
  ]) {
    if (isInsufficientQuotaError(record[key], depth + 1)) return true;
  }
  return false;
}

export function quotaExhaustedResponseText(args: {
  provider: string;
  keyMode: "groovy" | "user";
}): string {
  const providerName =
    args.provider === "openai"
      ? "OpenAI"
      : args.provider === "anthropic"
        ? "Anthropic"
        : args.provider;
  return args.keyMode === "groovy"
    ? `${providerName} returned insufficient_quota: Groovy's managed ${providerName} API key has no available credits or has reached its spend limit. Restore the provider billing or limits, or switch ${providerName} to your own funded API key in Settings.`
    : `${providerName} returned insufficient_quota: the project linked to your ${providerName} API key has no available credits or has reached its spend limit. Check the provider billing and limits, or choose another configured provider.`;
}

export function assertUsableModelRound(args: {
  text: string;
  toolOutputText?: string | null;
  connectorExecuteCount?: number;
  hasUiOpenCode?: boolean;
  hasBrowserTask?: boolean;
  generatedFileCount?: number;
  attachedFileCount?: number;
  finishReason?: string | null;
}): void {
  const usable =
    Boolean(args.text.trim()) ||
    Boolean(args.toolOutputText?.trim()) ||
    (args.connectorExecuteCount || 0) > 0 ||
    args.hasUiOpenCode === true ||
    args.hasBrowserTask === true ||
    (args.generatedFileCount || 0) > 0 ||
    (args.attachedFileCount || 0) > 0;
  if (!usable) throw new EmptyModelResponseError(args.finishReason);
}
