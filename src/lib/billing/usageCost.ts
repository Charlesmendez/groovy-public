import { computeUsageChargeBreakdown } from "@/lib/billing/pricing";

export type ProviderCostResolution = {
  costUsd: number;
  derived: boolean;
};

type UsageCostArgs = {
  model?: string | null;
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  storedModelCostUsd?: unknown;
  meta?: Record<string, unknown> | null;
};

function finiteNumber(value: unknown): number | null {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return typeof number === "number" && number >= 0 ? number : null;
}

function firstPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = finiteNumber(value);
    if (typeof number === "number" && number > 0) return number;
  }
  return null;
}

/**
 * Resolve the API-equivalent value of a usage event without changing what the
 * customer was actually charged. Historical included/no-charge events often
 * persisted a zero model cost even though their token telemetry is complete.
 */
export function resolveProviderCostUsd(args: UsageCostArgs): ProviderCostResolution {
  const storedCost = firstPositiveNumber(
    args.storedModelCostUsd,
    args.meta?.upstreamCostUsd,
    args.meta?.totalCostUsd,
    args.meta?.total_cost_usd,
    args.meta?.costUsd,
    args.meta?.cost_usd,
    args.meta?.modelCostUsd,
    args.meta?.model_cost_usd,
  );
  if (storedCost) return { costUsd: storedCost, derived: false };
  if (!args.model?.trim()) return { costUsd: 0, derived: false };

  const cacheReadInputTokens =
    nonNegativeNumber(args.meta?.cacheReadInputTokens) ??
    nonNegativeNumber(args.meta?.cache_read_input_tokens) ??
    nonNegativeNumber(args.meta?.cacheReadTokens);
  const cacheWriteInputTokens =
    nonNegativeNumber(args.meta?.cacheWriteInputTokens) ??
    nonNegativeNumber(args.meta?.cache_creation_input_tokens) ??
    nonNegativeNumber(args.meta?.cacheWriteTokens);
  const hasCacheDetails =
    typeof cacheReadInputTokens === "number" ||
    typeof cacheWriteInputTokens === "number";

  const explicitInputTokens = nonNegativeNumber(args.inputTokens);
  const explicitOutputTokens = nonNegativeNumber(args.outputTokens);
  const explicitTotalTokens = nonNegativeNumber(args.totalTokens);
  const cacheRead = cacheReadInputTokens || 0;
  const cacheWrite = cacheWriteInputTokens || 0;
  const recordedNoCacheInputTokens =
    nonNegativeNumber(args.meta?.noCacheInputTokens) ??
    nonNegativeNumber(args.meta?.no_cache_input_tokens);
  const noCacheInputTokens = hasCacheDetails
    ? recordedNoCacheInputTokens ??
      Math.max(0, (explicitInputTokens || 0) - cacheRead - cacheWrite)
    : null;
  const cacheAwareInputTokens = hasCacheDetails
    ? (noCacheInputTokens || 0) + cacheRead + cacheWrite
    : null;
  const inputTokens =
    typeof cacheAwareInputTokens === "number"
      ? Math.max(explicitInputTokens || 0, cacheAwareInputTokens)
      : explicitInputTokens;
  const outputTokens =
    explicitOutputTokens ??
    (typeof explicitTotalTokens === "number" && typeof inputTokens === "number"
      ? Math.max(0, explicitTotalTokens - inputTokens)
      : null);
  const totalTokens = Math.max(
    explicitTotalTokens || 0,
    (inputTokens || 0) + (outputTokens || 0),
  );

  const breakdown = computeUsageChargeBreakdown({
    model: args.model,
    usage: {
      inputTokens: inputTokens || 0,
      outputTokens: outputTokens || 0,
      totalTokens,
      ...(hasCacheDetails
        ? {
            noCacheInputTokens: noCacheInputTokens || 0,
            cacheReadInputTokens: cacheRead,
            cacheWriteInputTokens: cacheWrite,
          }
        : {}),
    },
    chargeType: "no_charge",
  });

  return {
    costUsd: breakdown?.modelCostUsd || 0,
    derived: Boolean(breakdown?.modelCostUsd),
  };
}
