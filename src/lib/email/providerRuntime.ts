import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GmailApiError } from "@/lib/email/gmail";

const DEFAULT_LEASE_MS = 65_000;
const DEFAULT_FRESH_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_WAIT_MS = 4_000;
const WAIT_STEP_MS = 200;

type RuntimeClaimRow = {
  acquired?: unknown;
  cached_payload?: unknown;
  cached_at?: unknown;
  lease_expires_at?: unknown;
  rate_limited_until?: unknown;
};

export type EmailProviderRequestDisposition =
  | "live"
  | "fresh-cache"
  | "stale-cache";

export class EmailProviderBusyError extends Error {
  readonly status = 503;
  readonly retryAfterMs: number;

  constructor(
    message = "Email synchronization is already in progress.",
    retryAfterMs = 1_000,
  ) {
    super(message);
    this.name = "EmailProviderBusyError";
    this.retryAfterMs = Math.max(250, retryAfterMs);
  }
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function claimRow(value: unknown): RuntimeClaimRow | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" && !Array.isArray(row)
    ? (row as RuntimeClaimRow)
    : null;
}

function runtimeUnavailable(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const message =
    typeof candidate?.message === "string" ? candidate.message : "";
  return (
    code === "PGRST202" ||
    code === "42883" ||
    /claim_email_provider_request|schema cache|function .* does not exist/i.test(
      message,
    )
  );
}

async function rpc(
  supabase: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> {
  return (supabase.rpc as unknown as (
    name: string,
    parameters: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>)(fn, args);
}

async function claim(args: {
  supabase: SupabaseClient;
  userId: string;
  provider: string;
  scope: string;
  token: string;
  leaseMs: number;
  freshMs: number;
  serializeProvider: boolean;
}): Promise<{ row: RuntimeClaimRow | null; unavailable: boolean }> {
  const result = await rpc(args.supabase, "claim_email_provider_request", {
    p_user_id: args.userId,
    p_provider: args.provider,
    p_request_scope: args.scope,
    p_lease_token: args.token,
    p_lease_ms: args.leaseMs,
    p_fresh_ms: args.freshMs,
    p_serialize_provider: args.serializeProvider,
  });
  if (result.error) {
    if (runtimeUnavailable(result.error)) return { row: null, unavailable: true };
    throw result.error;
  }
  return { row: claimRow(result.data), unavailable: false };
}

async function release(args: {
  supabase: SupabaseClient;
  userId: string;
  provider: string;
  scope: string;
  token: string;
  payload?: unknown;
  retryAfterMs?: number;
  failed?: boolean;
}): Promise<void> {
  const failed = args.failed === true || Number(args.retryAfterMs || 0) > 0;
  const result = await rpc(
    args.supabase,
    failed ? "fail_email_provider_request" : "complete_email_provider_request",
    failed
      ? {
          p_user_id: args.userId,
          p_provider: args.provider,
          p_request_scope: args.scope,
          p_lease_token: args.token,
          p_retry_after_ms: Math.max(0, Number(args.retryAfterMs || 0)),
        }
      : {
          p_user_id: args.userId,
          p_provider: args.provider,
          p_request_scope: args.scope,
          p_lease_token: args.token,
          p_cached_payload: args.payload ?? null,
        },
  );
  if (result.error && !runtimeUnavailable(result.error)) throw result.error;
}

function cachedValue<T>(row: RuntimeClaimRow, maxAgeMs: number): T | null {
  if (row.cached_payload === undefined || row.cached_payload === null) return null;
  const cachedAt = timestamp(row.cached_at);
  if (!cachedAt || Date.now() - cachedAt > maxAgeMs) return null;
  return row.cached_payload as T;
}

function cooldownError(row: RuntimeClaimRow): GmailApiError | null {
  const limitedUntil = timestamp(row.rate_limited_until);
  if (!limitedUntil || limitedUntil <= Date.now()) return null;
  return new GmailApiError("Gmail is temporarily rate limited.", {
    status: 429,
    retryable: true,
    retryAfterMs: Math.max(1_000, limitedUntil - Date.now()),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one expensive provider operation per authenticated user and request
 * scope, even when several browser windows reach different Vercel workers.
 * The database functions are intentionally optional during a rolling deploy:
 * old environments fall back to the existing local behavior until the
 * migration is present.
 */
export async function withEmailProviderRequest<T>(args: {
  supabase: SupabaseClient;
  userId: string;
  provider?: string;
  scope: string;
  execute: () => Promise<T>;
  leaseMs?: number;
  freshMs?: number;
  staleMs?: number;
  waitMs?: number;
  cache?: boolean;
  serializeProvider?: boolean;
  retryAfterMsFromValue?: (value: T) => number;
}): Promise<{ value: T; disposition: EmailProviderRequestDisposition }> {
  const provider = args.provider || "gmail";
  const leaseMs = Math.max(1_000, args.leaseMs ?? DEFAULT_LEASE_MS);
  const freshMs = Math.max(0, args.freshMs ?? DEFAULT_FRESH_MS);
  const staleMs = Math.max(freshMs, args.staleMs ?? DEFAULT_STALE_MS);
  const waitMs = Math.max(0, args.waitMs ?? DEFAULT_WAIT_MS);
  const token = randomUUID();
  const startedAt = Date.now();

  let first = true;
  while (true) {
    const acquired = await claim({
      supabase: args.supabase,
      userId: args.userId,
      provider,
      scope: args.scope,
      token,
      leaseMs,
      freshMs,
      serializeProvider: args.serializeProvider === true,
    });
    if (acquired.unavailable) {
      return { value: await args.execute(), disposition: "live" };
    }
    const row = acquired.row;
    if (!row) throw new EmailProviderBusyError();

    const cooldown = cooldownError(row);
    if (cooldown) {
      const stale = cachedValue<T>(row, staleMs);
      if (stale !== null) return { value: stale, disposition: "stale-cache" };
      throw cooldown;
    }

    if (row.acquired === true) {
      try {
        const value = await args.execute();
        const retryAfterMs = Math.max(
          0,
          Number(args.retryAfterMsFromValue?.(value) || 0),
        );
        await release({
          supabase: args.supabase,
          userId: args.userId,
          provider,
          scope: args.scope,
          token,
          ...(retryAfterMs > 0
            ? { retryAfterMs }
            : args.cache === false
              ? {}
              : { payload: value }),
        }).catch((error: unknown) => {
          // Coordination is an optimization. A transient database error must
          // not turn an otherwise successful provider response into a failed
          // user-visible refresh.
          console.warn("[email/provider-runtime] completion failed", {
            provider,
            scope: args.scope,
            message: error instanceof Error ? error.message : "Unknown error",
          });
        });
        return { value, disposition: "live" };
      } catch (error) {
        const retryAfterMs =
          error instanceof GmailApiError && error.status === 429
            ? Math.max(1_000, error.retryAfterMs || 7_000)
            : 0;
        await release({
          supabase: args.supabase,
          userId: args.userId,
          provider,
          scope: args.scope,
          token,
          failed: true,
          ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
        }).catch(() => undefined);
        throw error;
      }
    }

    const fresh = cachedValue<T>(row, freshMs);
    if (fresh !== null) return { value: fresh, disposition: "fresh-cache" };

    if (Date.now() - startedAt >= waitMs) {
      const stale = cachedValue<T>(row, staleMs);
      if (stale !== null) return { value: stale, disposition: "stale-cache" };
      const leaseUntil = timestamp(row.lease_expires_at);
      throw new EmailProviderBusyError(
        undefined,
        leaseUntil > Date.now()
          ? Math.min(2_000, leaseUntil - Date.now())
          : 1_000,
      );
    }

    await sleep(first ? Math.min(100, WAIT_STEP_MS) : WAIT_STEP_MS);
    first = false;
  }
}
