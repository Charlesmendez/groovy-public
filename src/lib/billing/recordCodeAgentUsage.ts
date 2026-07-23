/**
 * Shared code-agent usage recording.
 *
 * Records a worker-agent harness run (Claude CLI / Codex CLI) into
 * billing_usage_events with agent + harness attribution, and settles the
 * Groovy usage debit when billable. Used by:
 * - POST /api/claude-cli/usage (browser path, after billing-token verification)
 * - the server-side agent task runner (which constructed the billing context
 *   itself and needs no token round-trip)
 */

import { insertBillingUsageEventBestEffort } from "@/lib/billing/events";
import { settleGroovyUsageDebitBestEffort } from "@/lib/billing/guard";
import { getOrCreateWorkspaceIdForUser } from "@/lib/billing/workspace";
import { estimateTokensFromCostUsd, normalizeTokenUsage } from "@/lib/billing/usage";

export type CodeAgentUsageBillingContext = {
  billable: boolean;
  chargeType: "groovy_key" | "external_key_fee" | "no_charge";
  provider: "anthropic" | "openai";
  codeCliProvider: "claude" | "codex";
  authMethod: "api_key" | "cli_token" | "local_codex_login";
  authOrigin: "groovy" | "user" | "local";
};

export type CodeAgentUsageResultInput = {
  ok?: boolean | null;
  model?: string | null;
  sessionId?: string | null;
  durationMs?: number | null;
  usage?: unknown;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  totalCostUsd?: number | null;
};

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function fallbackCodeAgentModel(billing: CodeAgentUsageBillingContext): string | null {
  if (
    billing.provider === "openai" ||
    billing.codeCliProvider === "codex" ||
    billing.authMethod === "local_codex_login"
  ) {
    return "gpt-5.5";
  }
  if (billing.provider === "anthropic" || billing.codeCliProvider === "claude") {
    return "claude-opus-4-7";
  }
  return null;
}

export async function recordCodeAgentUsage(args: {
  userId: string;
  userEmail: string | null;
  agentId: string;
  requestId: string;
  billing: CodeAgentUsageBillingContext;
  result: CodeAgentUsageResultInput;
  /** Billing source bucket (defaults to code_agent_cli). */
  source?: string;
}): Promise<{
  recorded: boolean;
  reason?: string;
  billable: boolean;
  chargeType: string;
  unmetered: boolean;
}> {
  const { userId, userEmail, agentId, requestId, billing, result } = args;
  const source = args.source || "code_agent_cli";

  const workspaceId = await getOrCreateWorkspaceIdForUser({
    userId,
    email: userEmail || null,
  }).catch((e) => {
    console.warn(
      "[recordCodeAgentUsage] getOrCreateWorkspaceIdForUser failed:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  });
  if (!workspaceId) {
    return {
      recorded: false,
      reason: "no_billing_workspace",
      billable: false,
      chargeType: "no_charge",
      unmetered: true,
    };
  }

  const usage = result.usage;
  const normalizedUsage = normalizeTokenUsage(usage || result);
  const totalCostUsd = asFiniteNumber(result.totalCostUsd);
  const model =
    typeof result.model === "string" && result.model.trim() ? result.model.trim() : null;
  const modelForEstimation = model || fallbackCodeAgentModel(billing);

  let inputTokens = asFiniteNumber(result.inputTokens) ?? normalizedUsage?.inputTokens ?? null;
  let outputTokens = asFiniteNumber(result.outputTokens) ?? normalizedUsage?.outputTokens ?? null;
  let totalTokens = asFiniteNumber(result.totalTokens) ?? normalizedUsage?.totalTokens ?? null;
  let estimated = false;
  let estimationReason: string | null = null;

  if (
    (typeof totalTokens !== "number" || totalTokens <= 0) &&
    typeof totalCostUsd === "number" &&
    totalCostUsd > 0 &&
    modelForEstimation
  ) {
    const est = estimateTokensFromCostUsd({
      totalCostUsd,
      model: modelForEstimation,
      outputRatio: 0.25,
    });
    if (est) {
      inputTokens = est.inputTokens;
      outputTokens = est.outputTokens;
      totalTokens = est.totalTokens;
      estimated = true;
      estimationReason = est.estimationReason;
    }
  }

  const hasPositiveTokenUsage =
    (typeof inputTokens === "number" && inputTokens > 0) ||
    (typeof outputTokens === "number" && outputTokens > 0) ||
    (typeof totalTokens === "number" && totalTokens > 0);
  const hasPositiveCostUsage = typeof totalCostUsd === "number" && totalCostUsd > 0;
  if (!hasPositiveTokenUsage) {
    inputTokens = null;
    outputTokens = null;
    totalTokens = null;
  }

  const durationMs = asFiniteNumber(result.durationMs);
  const modelForStorage = model || modelForEstimation;
  const meta = {
    agentId,
    codeCliProvider: billing.codeCliProvider,
    authMethod: billing.authMethod,
    authOrigin: billing.authOrigin,
    upstreamCostUsd: totalCostUsd,
    modelForEstimation: estimated && !model ? modelForEstimation : undefined,
    durationMs,
    sessionId:
      typeof result.sessionId === "string" && result.sessionId.trim()
        ? result.sessionId.trim()
        : null,
    noUsageReturned: !hasPositiveTokenUsage && !hasPositiveCostUsage,
    runOk: typeof result.ok === "boolean" ? result.ok : null,
  };

  await insertBillingUsageEventBestEffort({
    workspaceId,
    userId,
    turnId: requestId,
    traceId: requestId,
    source,
    spanId: "main",
    provider: billing.provider,
    model: modelForStorage,
    agentId,
    harness: billing.codeCliProvider,
    usage,
    inputTokens,
    outputTokens,
    totalTokens,
    estimated,
    estimationReason,
    modelCostUsd: typeof totalCostUsd === "number" ? totalCostUsd : null,
    billable: hasPositiveTokenUsage || hasPositiveCostUsage ? billing.billable : false,
    chargeType:
      hasPositiveTokenUsage || hasPositiveCostUsage ? billing.chargeType : "no_charge",
    meta,
  });

  if (billing.billable && (hasPositiveTokenUsage || hasPositiveCostUsage)) {
    await settleGroovyUsageDebitBestEffort({
      workspaceId,
      userId,
      traceId: requestId,
      turnId: requestId,
      source,
      spanId: "main",
      model: modelForStorage,
      usage: normalizedUsage || { inputTokens, outputTokens, totalTokens },
      modelCostUsdOverride: typeof totalCostUsd === "number" ? totalCostUsd : null,
      chargeType: billing.chargeType,
      meta,
    }).catch(() => {});
  }

  return {
    recorded: true,
    billable: hasPositiveTokenUsage || hasPositiveCostUsage ? billing.billable : false,
    chargeType:
      hasPositiveTokenUsage || hasPositiveCostUsage ? billing.chargeType : "no_charge",
    unmetered: !hasPositiveTokenUsage && !hasPositiveCostUsage,
  };
}
