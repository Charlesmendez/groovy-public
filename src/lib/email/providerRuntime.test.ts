import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GmailApiError } from "./gmail";
import {
  EmailProviderBusyError,
  withEmailProviderRequest,
} from "./providerRuntime";

const USER_ID = "11111111-1111-1111-1111-111111111111";

function fakeSupabase(
  handler: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>,
): SupabaseClient {
  return { rpc: handler } as unknown as SupabaseClient;
}

test("reuses a fresh distributed response without executing provider work", async () => {
  let executions = 0;
  const supabase = fakeSupabase(async (name) => {
    assert.equal(name, "claim_email_provider_request");
    return {
      data: [{
        acquired: false,
        cached_payload: { ok: true, source: "shared" },
        cached_at: new Date().toISOString(),
        lease_expires_at: null,
        rate_limited_until: null,
      }],
      error: null,
    };
  });
  const result = await withEmailProviderRequest({
    supabase,
    userId: USER_ID,
    scope: "feed:focus",
    execute: async () => {
      executions += 1;
      return { ok: true, source: "live" };
    },
  });
  assert.equal(executions, 0);
  assert.equal(result.disposition, "fresh-cache");
  assert.deepEqual(result.value, { ok: true, source: "shared" });
});

test("completes an acquired lease with the provider result", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = fakeSupabase(async (name, args) => {
    calls.push({ name, args });
    return name === "claim_email_provider_request"
      ? {
          data: [{ acquired: true, cached_payload: null }],
          error: null,
        }
      : { data: true, error: null };
  });
  const result = await withEmailProviderRequest({
    supabase,
    userId: USER_ID,
    scope: "triage",
    execute: async () => ({ ok: true, discovered: 1 }),
  });
  assert.equal(result.disposition, "live");
  assert.equal(calls[0]?.args.p_user_id, USER_ID);
  assert.equal(calls[1]?.name, "complete_email_provider_request");
  assert.equal(calls[1]?.args.p_user_id, USER_ID);
  assert.deepEqual(calls[1]?.args.p_cached_payload, {
    ok: true,
    discovered: 1,
  });
});

test("records a shared cooldown when Gmail returns a 429", async () => {
  const calls: string[] = [];
  const supabase = fakeSupabase(async (name) => {
    calls.push(name);
    return name === "claim_email_provider_request"
      ? { data: [{ acquired: true }], error: null }
      : { data: true, error: null };
  });
  await assert.rejects(
    withEmailProviderRequest({
      supabase,
      userId: USER_ID,
      scope: "triage",
      execute: async () => {
        throw new GmailApiError("Rate limit exceeded", {
          status: 429,
          retryable: true,
          retryAfterMs: 9_000,
        });
      },
    }),
    /Rate limit exceeded/,
  );
  assert.deepEqual(calls, [
    "claim_email_provider_request",
    "fail_email_provider_request",
  ]);
});

test("records a handled partial-response throttle as a shared cooldown", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = fakeSupabase(async (name, args) => {
    calls.push({ name, args });
    return name === "claim_email_provider_request"
      ? { data: [{ acquired: true }], error: null }
      : { data: true, error: null };
  });
  const result = await withEmailProviderRequest({
    supabase,
    userId: USER_ID,
    scope: "feed:focus",
    serializeProvider: true,
    execute: async () => ({ ok: true, providerRetryAfterMs: 8_500 }),
    retryAfterMsFromValue: (value) => value.providerRetryAfterMs,
  });
  assert.equal(result.disposition, "live");
  assert.equal(calls[0]?.args.p_serialize_provider, true);
  assert.equal(calls[1]?.name, "fail_email_provider_request");
  assert.equal(calls[1]?.args.p_retry_after_ms, 8_500);
});

test("releases a failed lease without discarding the previous cache", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = fakeSupabase(async (name, args) => {
    calls.push({ name, args });
    return name === "claim_email_provider_request"
      ? { data: [{ acquired: true }], error: null }
      : { data: true, error: null };
  });
  await assert.rejects(
    withEmailProviderRequest({
      supabase,
      userId: USER_ID,
      scope: "feed:focus",
      execute: async () => {
        throw new Error("provider failed");
      },
    }),
    /provider failed/,
  );
  assert.equal(calls[1]?.name, "fail_email_provider_request");
  assert.equal(calls[1]?.args.p_retry_after_ms, 0);
});

test("fails safely when another worker owns a lease and no snapshot exists", async () => {
  const supabase = fakeSupabase(async () => ({
    data: [{
      acquired: false,
      cached_payload: null,
      cached_at: null,
      lease_expires_at: new Date(Date.now() + 10_000).toISOString(),
      rate_limited_until: null,
    }],
    error: null,
  }));
  await assert.rejects(
    withEmailProviderRequest({
      supabase,
      userId: USER_ID,
      scope: "feed:focus",
      waitMs: 0,
      execute: async () => ({ ok: true }),
    }),
    (error: unknown) => error instanceof EmailProviderBusyError,
  );
});

test("falls back during a rolling deploy before database functions exist", async () => {
  const supabase = fakeSupabase(async () => ({
    data: null,
    error: { code: "PGRST202", message: "Function is not in schema cache" },
  }));
  const result = await withEmailProviderRequest({
    supabase,
    userId: USER_ID,
    scope: "feed:focus",
    execute: async () => ({ ok: true }),
  });
  assert.equal(result.disposition, "live");
  assert.deepEqual(result.value, { ok: true });
});
