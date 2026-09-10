import { randomUUID } from "node:crypto";
import { readHomeJson } from "./boundedJson";
import {
  HomeInboxError,
  invalidProtocol,
  parseCompletion,
  parseDecisionClaim,
  parseDecisionMetadata,
  record,
  type DecisionScope,
  type DecisionResult,
} from "./contracts";

export function homeInboxOrigin(): string {
  const raw = process.env.DATAGRAN_HOME_URL || "https://home.datagran.io";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HomeInboxError(
      "home_origin_invalid",
      "Configure the Home server origin.",
      503,
    );
  }
  const local =
    process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new HomeInboxError(
      "home_origin_invalid",
      "Configure a secure Home server origin, not a callback URL.",
      503,
    );
  return url.origin;
}
export function createHomePlatformInvoker(
  scope: Pick<DecisionScope, "tenantId" | "projectId">,
  key: string,
  fetcher: typeof fetch = fetch,
  pinnedOrigin = homeInboxOrigin(),
) {
  const origin = homeInboxOrigin();
  if (pinnedOrigin !== origin)
    throw new HomeInboxError(
      "home_origin_changed",
      "This binding belongs to a different Home origin. Reconnect it explicitly.",
    );
  return async function invoke(
    capability: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      strictDataReceipt?: boolean;
    } = {},
  ) {
    const invocationId = randomUUID();
    const body = JSON.stringify({
      invocation_id: invocationId,
      tenant_id: scope.tenantId,
      project_id: scope.projectId,
      capability,
      idempotency_key: idempotencyKey,
      input,
    });
    if (Buffer.byteLength(body, "utf8") > 16_384)
      throw new HomeInboxError(
        "home_request_size",
        "The Home request is too large.",
        400,
      );
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await fetcher(`${origin}/api/platform/tools/invoke`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body,
        cache: "no-store",
        redirect: "error",
        signal,
      });
    } catch {
      throw new HomeInboxError(
        "home_request_uncertain",
        "Home did not acknowledge the request. Do not repeat model execution.",
        503,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HomeInboxError(
        "home_request_rejected",
        "Home did not authorize or acknowledge the request. Missing evidence is not an empty result.",
        response.status >= 500 ? 503 : 409,
      );
    }
    const payload = await readHomeJson(response, 576 * 1024, signal).catch(
      () => null,
    );
    if (
      !record(payload) ||
      payload.ok !== true ||
      payload.invocation_id !== invocationId ||
      !record(payload.receipt) ||
      payload.receipt.tenant_id !== scope.tenantId ||
      payload.receipt.project_id !== scope.projectId ||
      payload.receipt.capability !== capability
    )
      invalidProtocol();
    if (
      options.strictDataReceipt &&
      (payload.error !== null ||
        Object.keys(payload).sort().join(",") !==
          "data,error,invocation_id,ok,receipt" ||
        Object.keys(payload.receipt).sort().join(",") !==
          "capability,completed_at,project_id,tenant_id" ||
        typeof payload.receipt.completed_at !== "string" ||
        !/^\d{4}-\d\d-\d\dT/.test(payload.receipt.completed_at) ||
        !Number.isFinite(Date.parse(payload.receipt.completed_at)))
    )
      invalidProtocol();
    return payload.data;
  };
}

export function createHomeInboxClient(
  scope: DecisionScope,
  key: string,
  fetcher: typeof fetch = fetch,
  pinnedOrigin = homeInboxOrigin(),
) {
  const invoke = createHomePlatformInvoker(scope, key, fetcher, pinnedOrigin);
  return {
    async list(limit = 10) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new HomeInboxError(
          "invalid_limit",
          "Provide a limit from 1 to 50.",
          400,
        );
      return parseDecisionMetadata(
        await invoke(
          "inbox.decisions.list",
          { harness_ref: scope.harnessRef, limit },
          `list-${randomUUID()}`,
        ),
      );
    },
    async claim(decisionId: string, retryKey: string) {
      return parseDecisionClaim(
        await invoke(
          "inbox.decisions.claim",
          { harness_ref: scope.harnessRef, decision_id: decisionId },
          retryKey,
        ),
        scope,
        decisionId,
      );
    },
    async complete(decisionId: string, token: string, result: DecisionResult) {
      return parseCompletion(
        await invoke(
          "inbox.decisions.complete",
          {
            harness_ref: scope.harnessRef,
            decision_id: decisionId,
            claim_token: token,
            result,
          },
          `result-${decisionId}`,
        ),
        decisionId,
      );
    },
  };
}
