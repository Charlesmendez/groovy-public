export type NormalizedTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Non-cached input tokens (Anthropic cache-aware billing) */
  noCacheInputTokens?: number;
  /** Tokens read from Anthropic prompt cache */
  cacheReadInputTokens?: number;
  /** Tokens written to Anthropic prompt cache */
  cacheWriteInputTokens?: number;
};

function toInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const i = Math.trunc(n);
  return i >= 0 ? i : undefined;
}

/**
 * Normalize token usage objects coming from different SDKs/providers.
 * We keep this intentionally permissive because upstream shapes vary.
 */
export function normalizeTokenUsage(usage: unknown): NormalizedTokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  // Common shapes
  const inputTokens =
    toInt(u.inputTokens) ??
    toInt(u.input_tokens) ??
    toInt(u.promptTokens) ??
    toInt(u.prompt_tokens);
  const outputTokens =
    toInt(u.outputTokens) ??
    toInt(u.output_tokens) ??
    toInt(u.completionTokens) ??
    toInt(u.completion_tokens);
  const totalTokens =
    toInt(u.totalTokens) ??
    toInt(u.total_tokens) ??
    (typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : undefined);

  // Extract cache token details from multiple SDK shapes:
  // Shape 1 - Vercel AI SDK LanguageModelUsage: inputTokenDetails.{noCacheTokens, cacheReadTokens, cacheWriteTokens}
  // Shape 2 - Direct Anthropic SDK: {input_tokens (non-cached), cache_creation_input_tokens, cache_read_input_tokens}
  // Shape 3 - Vercel raw wrapper: raw.{cache_creation_input_tokens, cache_read_input_tokens}
  const details = (u.inputTokenDetails && typeof u.inputTokenDetails === "object"
    ? u.inputTokenDetails
    : null) as Record<string, unknown> | null;
  const raw = (u.raw && typeof u.raw === "object" ? u.raw : null) as Record<string, unknown> | null;

  const cacheReadInputTokens =
    toInt(details?.cacheReadTokens) ??
    toInt(u.cacheReadInputTokens) ??          // Already-normalized (idempotent re-entry)
    toInt(u.cachedInputTokens) ??
    toInt(u.cached_input_tokens) ??
    toInt(u.cache_read_input_tokens) ??
    toInt(raw?.cache_read_input_tokens);

  const cacheWriteInputTokens =
    toInt(details?.cacheWriteTokens) ??
    toInt(u.cacheWriteInputTokens) ??         // Already-normalized (idempotent re-entry)
    toInt(u.cache_creation_input_tokens) ??
    toInt(raw?.cache_creation_input_tokens);

  // For noCacheInputTokens: only fall through to u.input_tokens when we have
  // evidence of caching (at least one cache field present). Otherwise, input_tokens
  // is just the regular total and should NOT be labeled as "no cache".
  const hasCacheEvidence =
    typeof cacheReadInputTokens === "number" || typeof cacheWriteInputTokens === "number";
  const inputTokensIncludeCache =
    typeof toInt(u.cachedInputTokens) === "number" ||
    typeof toInt(u.cached_input_tokens) === "number";

  const noCacheInputTokens =
    toInt(details?.noCacheTokens) ??
    toInt(u.noCacheInputTokens) ??           // Already-normalized (idempotent re-entry)
    (inputTokensIncludeCache && typeof inputTokens === "number"
      ? Math.max(0, inputTokens - (cacheReadInputTokens || 0) - (cacheWriteInputTokens || 0))
      : undefined) ??
    // Direct Anthropic SDK: input_tokens is the non-cached count — only use when
    // cache tokens are also present, otherwise input_tokens is just the total.
    (hasCacheEvidence ? toInt(u.input_tokens) ?? toInt(raw?.input_tokens) : undefined);

  // For Direct Anthropic SDK (Shape 2): input_tokens is only the non-cached count,
  // NOT the total. When cache tokens are present and we only got input_tokens from
  // the snake_case field (i.e. Shape 2), compute the real total as:
  //   total_input = input_tokens + cache_creation + cache_read
  // Shape 1 (Vercel SDK) already provides inputTokens as the correct total.
  let effectiveInputTokens = inputTokens;
  if (
    typeof effectiveInputTokens !== "number" ||
    (typeof noCacheInputTokens === "number" &&
      effectiveInputTokens === noCacheInputTokens &&
      (typeof cacheReadInputTokens === "number" || typeof cacheWriteInputTokens === "number") &&
      !inputTokensIncludeCache &&
      // Only adjust when inputTokens came from input_tokens (snake_case), not inputTokens (camelCase).
      // Vercel SDK sets inputTokens (camelCase) as the correct total already.
      toInt(u.inputTokens) == null)
  ) {
    effectiveInputTokens =
      (noCacheInputTokens || 0) +
      (cacheReadInputTokens || 0) +
      (cacheWriteInputTokens || 0);
  }

  const effectiveTotalTokens =
    // If we adjusted inputTokens, recompute totalTokens too
    effectiveInputTokens !== inputTokens && typeof effectiveInputTokens === "number" && typeof outputTokens === "number"
      ? effectiveInputTokens + outputTokens
      : totalTokens;

  if (
    typeof effectiveInputTokens !== "number" &&
    typeof outputTokens !== "number" &&
    typeof effectiveTotalTokens !== "number"
  ) {
    return null;
  }

  return {
    inputTokens: effectiveInputTokens,
    outputTokens,
    totalTokens: effectiveTotalTokens,
    ...(typeof noCacheInputTokens === "number" ? { noCacheInputTokens } : {}),
    ...(typeof cacheReadInputTokens === "number" ? { cacheReadInputTokens } : {}),
    ...(typeof cacheWriteInputTokens === "number" ? { cacheWriteInputTokens } : {}),
  };
}

export type PricingUsdPerMillion = { input: number; output: number };

// Minimal mapping for now; headless code-agent defaults are Opus/GPT class models.
// If we add more models later, extend this map.
export const MODEL_PRICING_USD_PER_MILLION: Record<string, PricingUsdPerMillion> = {
  // https://platform.claude.com/docs/en/about-claude/pricing
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-codex-mini": { input: 0.75, output: 6 },
};

const MODEL_PRICING_ALIASES: Array<{ match: RegExp; pricing: PricingUsdPerMillion }> = [
  { match: /^claude-opus-4[.-]7/i, pricing: MODEL_PRICING_USD_PER_MILLION["claude-opus-4-7"] },
  { match: /^claude-opus-4[.-]6/i, pricing: MODEL_PRICING_USD_PER_MILLION["claude-opus-4-6"] },
  { match: /^claude-sonnet-4[.-]6/i, pricing: MODEL_PRICING_USD_PER_MILLION["claude-sonnet-4-6"] },
  { match: /^claude-sonnet-4[.-]5/i, pricing: MODEL_PRICING_USD_PER_MILLION["claude-sonnet-4-5"] },
  { match: /^claude-haiku-4[.-]5/i, pricing: MODEL_PRICING_USD_PER_MILLION["claude-haiku-4-5"] },
  { match: /^gpt-5\.5-pro/i, pricing: MODEL_PRICING_USD_PER_MILLION["gpt-5.5-pro"] },
  { match: /^gpt-5\.5/i, pricing: MODEL_PRICING_USD_PER_MILLION["gpt-5.5"] },
  { match: /^gpt-5\.4-codex-mini/i, pricing: MODEL_PRICING_USD_PER_MILLION["gpt-5.4-codex-mini"] },
  { match: /^gpt-5\.4-mini/i, pricing: MODEL_PRICING_USD_PER_MILLION["gpt-5.4-mini"] },
  { match: /^gpt-5\.4/i, pricing: MODEL_PRICING_USD_PER_MILLION["gpt-5.4"] },
];

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.25;
  return Math.max(0, Math.min(1, n));
}

export type EstimatedTokens = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimationReason: string;
};

/**
 * Estimate tokens from a single blended USD cost.
 *
 * We only have 1 equation: cost = in*T_in + out*T_out, but 2 unknowns.
 * So we assume a stable output ratio and compute a blended USD/token.
 *
 * This is only used when the CLI doesn't return explicit token counts.
 */
export function estimateTokensFromCostUsd(args: {
  totalCostUsd: number;
  model: string;
  outputRatio?: number;
}): EstimatedTokens | null {
  const totalCostUsd = args.totalCostUsd;
  if (!Number.isFinite(totalCostUsd) || totalCostUsd <= 0) return null;

  const model = args.model.trim();
  const pricing =
    MODEL_PRICING_USD_PER_MILLION[model] ||
    MODEL_PRICING_ALIASES.find((entry) => entry.match.test(model))?.pricing ||
    null;
  if (!pricing) return null;

  const r = clamp01(typeof args.outputRatio === "number" ? args.outputRatio : 0.25);
  const blendedUsdPerToken =
    (((1 - r) * pricing.input + r * pricing.output) / 1_000_000);
  if (!Number.isFinite(blendedUsdPerToken) || blendedUsdPerToken <= 0) return null;

  const totalTokens = Math.max(0, Math.round(totalCostUsd / blendedUsdPerToken));
  const inputTokens = Math.max(0, Math.round(totalTokens * (1 - r)));
  const outputTokens = Math.max(0, totalTokens - inputTokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimationReason: `from_total_cost_usd:model=${args.model};output_ratio=${r}`,
  };
}
