import { normalizeTokenUsage, type NormalizedTokenUsage } from "@/lib/billing/usage";

export type UsageChargeType = "groovy_key" | "external_key_fee" | "no_charge";

export const GROOVY_KEY_FEE_RATE_BPS = 2000;
export const EXTERNAL_KEY_FEE_RATE_BPS = 2000;
export const GROOVY_FEE_RATE_BPS = GROOVY_KEY_FEE_RATE_BPS;
export const GROOVY_FEE_RATE = GROOVY_KEY_FEE_RATE_BPS / 10_000;
export const GROOVY_MAC_MIN_SEATS = 10;
export const GROOVY_MAC_SEAT_PRICE_USD = 15;
export const KAPSO_ALLOWLIST_PRICE_USD = 2;

type PricingUsdPerMillion = {
  input: number;
  output: number;
  /** Price per million tokens read from prompt cache (Anthropic: 10% of input) */
  cacheRead?: number;
  /** Price per million tokens written to prompt cache (Anthropic: 125% of input) */
  cacheWrite?: number;
};

const PRICING_ALIASES: Array<{ match: RegExp; pricing: PricingUsdPerMillion; key: string }> = [
  { match: /^claude-opus-4[.-]7/i, pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, key: "claude-opus-4-7" },
  { match: /^claude-opus-4[.-]6/i, pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, key: "claude-opus-4-6" },
  { match: /^claude-sonnet-4[.-]6/i, pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, key: "claude-sonnet-4-6" },
  { match: /^claude-sonnet-4[.-]5/i, pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, key: "claude-sonnet-4-5" },
  { match: /^claude-haiku-4[.-]5/i, pricing: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }, key: "claude-haiku-4-5" },
  { match: /^gpt-5\.5-pro/i, pricing: { input: 30, output: 180 }, key: "gpt-5.5-pro" },
  { match: /^gpt-5\.5/i, pricing: { input: 5, output: 30, cacheRead: 0.5 }, key: "gpt-5.5" },
  { match: /^gpt-5\.4-codex-mini/i, pricing: { input: 0.75, output: 6, cacheRead: 0.075 }, key: "gpt-5.4-codex-mini" },
  { match: /^gpt-5\.4-mini/i, pricing: { input: 0.75, output: 4.5, cacheRead: 0.075 }, key: "gpt-5.4-mini" },
  { match: /^gpt-5\.4/i, pricing: { input: 2.5, output: 15, cacheRead: 0.25 }, key: "gpt-5.4" },
  { match: /^gpt-5-mini/i, pricing: { input: 0.3, output: 1.2 }, key: "gpt-5-mini" },
];

function roundUsd(n: number): number {
  return Math.round((n + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function toPositiveNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeModelName(model?: string | null): { key: string; pricing: PricingUsdPerMillion } | null {
  const trimmed = model?.trim() || "";
  if (trimmed) {
    for (const entry of PRICING_ALIASES) {
      if (entry.match.test(trimmed)) {
        return { key: entry.key, pricing: entry.pricing };
      }
    }
  }
  // Billing policy is explicitly pegged to Opus pricing.
  const fallback = PRICING_ALIASES[0];
  return fallback ? { key: fallback.key, pricing: fallback.pricing } : null;
}

export function normalizeUsageChargeType(value?: string | null): UsageChargeType {
  if (value === "external_key_fee" || value === "no_charge" || value === "groovy_key") {
    return value;
  }
  return "groovy_key";
}

export function usageChargeTypeForKeyMode(keyMode?: string | null): UsageChargeType {
  return keyMode === "groovy" ? "groovy_key" : "external_key_fee";
}

function splitTotalTokens(totalTokens: number): { inputTokens: number; outputTokens: number } {
  // Conservative default split when we only have total tokens.
  const outputTokens = Math.max(0, Math.round(totalTokens * 0.25));
  const inputTokens = Math.max(0, totalTokens - outputTokens);
  return { inputTokens, outputTokens };
}

export type UsageChargeBreakdown = {
  chargeType: UsageChargeType;
  modelPriceKey: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelCostUsd: number;
  groovyFeeUsd: number;
  totalChargeUsd: number;
  feeRateBps: number;
};

export function computeUsageChargeBreakdown(args: {
  model?: string | null;
  usage?: unknown | null;
  modelCostUsdOverride?: number | null;
  chargeType?: UsageChargeType | string | null;
}): UsageChargeBreakdown | null {
  const chargeType = normalizeUsageChargeType(args.chargeType);
  const override = toPositiveNumber(args.modelCostUsdOverride);
  const normalized = normalizeTokenUsage(args.usage) as NormalizedTokenUsage | null;
  const modelInfo = normalizeModelName(args.model || null);
  if (!normalized || !modelInfo) {
    if (!override || !modelInfo) return null;
  }

  const inferredTotal =
    typeof normalized?.totalTokens === "number"
      ? normalized.totalTokens
      : typeof normalized?.inputTokens === "number" && typeof normalized?.outputTokens === "number"
        ? normalized.inputTokens + normalized.outputTokens
        : 0;
  const hasUsableTokenUsage = Number.isFinite(inferredTotal) && inferredTotal > 0;
  if (!override && !hasUsableTokenUsage) return null;

  let inputTokens = typeof normalized?.inputTokens === "number" ? normalized.inputTokens : undefined;
  let outputTokens = typeof normalized?.outputTokens === "number" ? normalized.outputTokens : undefined;
  let totalTokens = inferredTotal;

  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    const split = splitTotalTokens(Math.max(0, totalTokens));
    inputTokens = typeof inputTokens === "number" ? inputTokens : split.inputTokens;
    outputTokens = typeof outputTokens === "number" ? outputTokens : split.outputTokens;
  }

  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    totalTokens = Math.max(0, (inputTokens || 0) + (outputTokens || 0));
  }

  // Cache-aware cost calculation: when cache token details are available,
  // bill each bucket at its specific rate for accurate savings tracking.
  const pricing = modelInfo!.pricing;
  const hasCacheDetails =
    typeof normalized?.cacheReadInputTokens === "number" ||
    typeof normalized?.cacheWriteInputTokens === "number";

  let computedModelCost: number;
  if (hasCacheDetails && (pricing.cacheRead != null || pricing.cacheWrite != null)) {
    const noCacheTokens = Math.max(0, normalized?.noCacheInputTokens || 0);
    const cacheReadTokens = Math.max(0, normalized?.cacheReadInputTokens || 0);
    const cacheWriteTokens = Math.max(0, normalized?.cacheWriteInputTokens || 0);
    computedModelCost = roundUsd(
      (noCacheTokens * pricing.input +
        cacheReadTokens * (pricing.cacheRead ?? pricing.input) +
        cacheWriteTokens * (pricing.cacheWrite ?? pricing.input) +
        Math.max(0, outputTokens || 0) * pricing.output) /
        1_000_000
    );
  } else {
    computedModelCost = roundUsd(
      ((Math.max(0, inputTokens || 0) * pricing.input) +
        (Math.max(0, outputTokens || 0) * pricing.output)) /
        1_000_000
    );
  }
  const modelCostUsd = hasUsableTokenUsage ? computedModelCost : override || computedModelCost;
  if (!Number.isFinite(modelCostUsd) || modelCostUsd <= 0) return null;

  const feeRateBps =
    chargeType === "external_key_fee"
      ? EXTERNAL_KEY_FEE_RATE_BPS
      : chargeType === "no_charge"
        ? 0
        : GROOVY_KEY_FEE_RATE_BPS;
  const groovyFeeUsd = feeRateBps > 0 ? roundUsd(modelCostUsd * (feeRateBps / 10_000)) : 0;
  const totalChargeUsd =
    chargeType === "external_key_fee"
      ? groovyFeeUsd
      : chargeType === "no_charge"
        ? 0
        : roundUsd(modelCostUsd + groovyFeeUsd);

  return {
    chargeType,
    modelPriceKey: modelInfo!.key,
    inputTokens: Math.max(0, Math.round(inputTokens || 0)),
    outputTokens: Math.max(0, Math.round(outputTokens || 0)),
    totalTokens: Math.max(0, Math.round(totalTokens)),
    modelCostUsd,
    groovyFeeUsd,
    totalChargeUsd,
    feeRateBps,
  };
}

export type TopupBreakdown = {
  amountUsd: number;
  amountCents: number;
  modelCostUsd: number;
  modelCostCents: number;
  groovyFeeUsd: number;
  groovyFeeCents: number;
  feeRateBps: number;
};

export function splitTopupBreakdown(amountUsd: number): TopupBreakdown | null {
  const normalized = toPositiveNumber(amountUsd);
  if (!normalized) return null;
  const amountCents = Math.round(normalized * 100);
  if (amountCents <= 0) return null;

  const modelCostCents = Math.round(amountCents / (1 + GROOVY_FEE_RATE));
  const groovyFeeCents = Math.max(0, amountCents - modelCostCents);
  const modelCostUsd = roundUsd(modelCostCents / 100);
  const groovyFeeUsd = roundUsd(groovyFeeCents / 100);

  return {
    amountUsd: roundUsd(amountCents / 100),
    amountCents,
    modelCostUsd,
    modelCostCents,
    groovyFeeUsd,
    groovyFeeCents,
    feeRateBps: GROOVY_FEE_RATE_BPS,
  };
}
