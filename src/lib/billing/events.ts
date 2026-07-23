import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeTokenUsage, type NormalizedTokenUsage } from "@/lib/billing/usage";
import {
  computeUsageChargeBreakdown,
  EXTERNAL_KEY_FEE_RATE_BPS,
  GROOVY_FEE_RATE_BPS,
  normalizeUsageChargeType,
  type UsageChargeType,
} from "@/lib/billing/pricing";
import {
  coerceChargeTypeForTokenBillingPolicy,
  resolveWorkspaceTokenBillingPolicy,
} from "@/lib/billing/policy";

export type BillingUsageEventInput = {
  workspaceId: string;
  userId: string;
  turnId: string;
  traceId: string;
  source: string;
  spanId?: string;
  provider?: string | null;
  model?: string | null;
  usage?: NormalizedTokenUsage | unknown | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  estimated?: boolean;
  estimationReason?: string | null;
  modelCostUsd?: number | null;
  groovyFeeUsd?: number | null;
  totalChargeUsd?: number | null;
  feeRateBps?: number | null;
  billable?: boolean;
  chargeType?: UsageChargeType | string | null;
  /** Agent this usage is attributed to (worker, orchestrator runtime, or system agent). */
  agentId?: string | null;
  /** Harness that produced the usage: "claude" | "codex" | null for direct API calls. */
  harness?: string | null;
  meta?: Record<string, unknown>;
};

export async function insertBillingUsageEventBestEffort(input: BillingUsageEventInput) {
  try {
    const admin = createSupabaseAdminClient();

    const normalized =
      input.usage ? normalizeTokenUsage(input.usage) : null;
    const hasCacheDetails =
      typeof normalized?.cacheReadInputTokens === "number" ||
      typeof normalized?.cacheWriteInputTokens === "number";

    // Direct CLI/SDK payloads can expose input_tokens as non-cached input only.
    // When cache details are present, store the normalized cache-aware totals.
    const inputTokens =
      hasCacheDetails && typeof normalized?.inputTokens === "number"
        ? normalized.inputTokens
        : typeof input.inputTokens === "number"
        ? input.inputTokens
        : normalized?.inputTokens;
    const outputTokens =
      typeof input.outputTokens === "number"
        ? input.outputTokens
        : normalized?.outputTokens;
    const normalizedTotalTokens =
      normalized?.totalTokens ??
      (typeof normalized?.inputTokens === "number" && typeof normalized?.outputTokens === "number"
        ? normalized.inputTokens + normalized.outputTokens
        : undefined);
    const totalTokens =
      hasCacheDetails && typeof normalizedTotalTokens === "number"
        ? normalizedTotalTokens
        : typeof input.totalTokens === "number"
        ? input.totalTokens
        : normalizedTotalTokens ??
          (typeof inputTokens === "number" && typeof outputTokens === "number"
            ? inputTokens + outputTokens
            : undefined);

    const requestedChargeType = normalizeUsageChargeType(input.chargeType);
    const tokenBillingPolicy = await resolveWorkspaceTokenBillingPolicy({
      workspaceId: input.workspaceId,
      admin,
    });
    const chargeType =
      input.billable === false || requestedChargeType === "no_charge"
        ? "no_charge"
        : coerceChargeTypeForTokenBillingPolicy({
            requestedChargeType,
            policy: tokenBillingPolicy,
          });
    const billable = chargeType !== "no_charge";

    // Pass the full normalized object (including cache token fields) so that
    // computeUsageChargeBreakdown can apply cache-aware pricing when available.
    const charge = billable
      ? computeUsageChargeBreakdown({
          model: input.model || null,
          usage: normalized ?? { inputTokens, outputTokens, totalTokens },
          modelCostUsdOverride:
            typeof input.modelCostUsd === "number" ? input.modelCostUsd : null,
          chargeType,
        }) || null
      : null;

    const row = {
      workspace_id: input.workspaceId,
      user_id: input.userId,
      turn_id: input.turnId,
      trace_id: input.traceId,
      source: input.source,
      span_id: input.spanId || "main",
      provider: input.provider || null,
      model: input.model || null,
      agent_id: input.agentId || null,
      harness: input.harness || null,
      input_tokens: typeof inputTokens === "number" ? inputTokens : null,
      output_tokens: typeof outputTokens === "number" ? outputTokens : null,
      total_tokens: typeof totalTokens === "number" ? totalTokens : null,
      estimated: input.estimated === true,
      estimation_reason: input.estimationReason || null,
      billable,
      charge_type: chargeType,
      model_cost_usd:
        !billable
          ? 0
          : charge?.modelCostUsd ??
            (typeof input.modelCostUsd === "number" ? input.modelCostUsd : null),
      groovy_fee_usd:
        !billable
          ? 0
          : charge?.groovyFeeUsd ??
            (typeof input.groovyFeeUsd === "number" ? input.groovyFeeUsd : null),
      total_charge_usd:
        !billable
          ? 0
          : charge?.totalChargeUsd ??
            (typeof input.totalChargeUsd === "number" ? input.totalChargeUsd : null),
      fee_rate_bps:
        !billable
          ? 0
          : charge?.feeRateBps ??
            (typeof input.feeRateBps === "number" ? input.feeRateBps : null) ??
            (chargeType === "external_key_fee" ? EXTERNAL_KEY_FEE_RATE_BPS : GROOVY_FEE_RATE_BPS),
      meta: {
        ...(input.meta || {}),
        billable,
        chargeType,
        tokenBillingPolicy: tokenBillingPolicy.reason,
        resellerBillingEnabled: tokenBillingPolicy.resellerBillingEnabled,
        tokenConsumptionBillingEnabled: tokenBillingPolicy.tokenConsumptionBillingEnabled,
        ...(typeof normalized?.noCacheInputTokens === "number"
          ? { noCacheInputTokens: normalized.noCacheInputTokens }
          : {}),
        ...(typeof normalized?.cacheReadInputTokens === "number"
          ? { cacheReadInputTokens: normalized.cacheReadInputTokens }
          : {}),
        ...(typeof normalized?.cacheWriteInputTokens === "number"
          ? { cacheWriteInputTokens: normalized.cacheWriteInputTokens }
          : {}),
      },
    };

    // Idempotent: unique(workspace_id, trace_id, source, span_id)
    const { error } = await admin
      .from("billing_usage_events")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .upsert(row as any, {
        onConflict: "workspace_id,trace_id,source,span_id",
        ignoreDuplicates: true,
      });

    if (error) {
      console.warn("[billing] insert billing_usage_events failed:", error.message);
    }
  } catch (err) {
    console.warn(
      "[billing] insert billing_usage_events threw:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

export type BillingToolEventInput = {
  workspaceId: string;
  userId: string;
  turnId: string;
  traceId: string;
  toolCallId: string;
  toolName: string;
  agent?: string | null;
  /** Agent row this tool invocation is attributed to (uuid; supplements the legacy text label). */
  agentId?: string | null;
  meta?: Record<string, unknown>;
};

export async function insertBillingToolEventBestEffort(input: BillingToolEventInput) {
  try {
    const admin = createSupabaseAdminClient();

    const row = {
      workspace_id: input.workspaceId,
      user_id: input.userId,
      turn_id: input.turnId,
      trace_id: input.traceId,
      tool_call_id: input.toolCallId,
      tool_name: input.toolName,
      agent: input.agent || null,
      agent_id: input.agentId || null,
      meta: input.meta || {},
    };

    // Idempotent: unique(workspace_id, trace_id, tool_call_id)
    const { error } = await admin
      .from("billing_tool_events")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .upsert(row as any, {
        onConflict: "workspace_id,trace_id,tool_call_id",
        ignoreDuplicates: true,
      });

    if (error) {
      console.warn("[billing] insert billing_tool_events failed:", error.message);
    }
  } catch (err) {
    console.warn(
      "[billing] insert billing_tool_events threw:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

export async function insertBillingToolEventsBestEffort(inputs: BillingToolEventInput[]) {
  try {
    const rows = (inputs || [])
      .filter(
        (i) =>
          i &&
          typeof i.workspaceId === "string" &&
          typeof i.userId === "string" &&
          typeof i.turnId === "string" &&
          typeof i.traceId === "string" &&
          typeof i.toolCallId === "string" &&
          typeof i.toolName === "string"
      )
      .map((i) => ({
        workspace_id: i.workspaceId,
        user_id: i.userId,
        turn_id: i.turnId,
        trace_id: i.traceId,
        tool_call_id: i.toolCallId,
        tool_name: i.toolName,
        agent: i.agent || null,
        agent_id: i.agentId || null,
        meta: i.meta || {},
      }));

    if (rows.length === 0) return;

    const admin = createSupabaseAdminClient();
    const { error } = await admin
      .from("billing_tool_events")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .upsert(rows as any, {
        onConflict: "workspace_id,trace_id,tool_call_id",
        ignoreDuplicates: true,
      });

    if (error) {
      console.warn("[billing] bulk insert billing_tool_events failed:", error.message);
    }
  } catch (err) {
    console.warn(
      "[billing] bulk insert billing_tool_events threw:",
      err instanceof Error ? err.message : String(err)
    );
  }
}
