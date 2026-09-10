/** Server-owned provider receipts. Never accept these fields from model output.
 * Components are observations, not invoices or authorization to execute work. */
export type HarnessUsageObservation = {
  id: string;
  provider: string;
  model: string;
  usage: unknown;
  /** Only a cost explicitly returned by the provider; not a pricing fallback. */
  providerCostUsd?: number | null;
};
export type UsageComponent = {
  id: string;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  provider_cost_usd: number | null;
};
export type HarnessUsageReceipt = {
  version: 1;
  status: "partial" | "reported";
  observed_at: string;
  components: UsageComponent[];
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 1_000_000_000
    ? value
    : null;
const first = (...values: unknown[]): number | null => {
  for (const value of values) {
    const parsed = count(value);
    if (parsed !== null) return parsed;
  }
  return null;
};

export function usageComponent(
  observation: HarnessUsageObservation,
): UsageComponent {
  if (
    ![observation.id, observation.provider, observation.model].every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 255,
    )
  )
    throw new Error("invalid_usage_identity");
  const u = record(observation.usage),
    details = record(u.inputTokenDetails);
  const cached = first(
    details.cacheReadTokens,
    u.cacheReadInputTokens,
    u.cachedInputTokens,
    u.cached_input_tokens,
    u.cache_read_input_tokens,
    record(u.prompt_tokens_details).cached_tokens,
  );
  const written = first(
    details.cacheWriteTokens,
    u.cacheWriteInputTokens,
    u.cache_creation_input_tokens,
  );
  let input = first(
    u.inputTokens,
    u.input_tokens,
    u.promptTokens,
    u.prompt_tokens,
  );
  const output = first(
    u.outputTokens,
    u.output_tokens,
    u.completionTokens,
    u.completion_tokens,
  );
  // Direct Anthropic counters exclude cache buckets. AI SDK inputTokens already
  // includes them. Claude Agent SDK modelUsage is translated separately below.
  if (
    u.inputTokens === undefined &&
    u.input_tokens !== undefined &&
    (u.cache_read_input_tokens !== undefined ||
      u.cache_creation_input_tokens !== undefined) &&
    input !== null
  )
    input = count(input + (cached ?? 0) + (written ?? 0));
  const validCache = input !== null && (cached ?? 0) + (written ?? 0) <= input;
  return {
    id: observation.id,
    provider: observation.provider,
    model: observation.model,
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: validCache ? cached : null,
    cache_write_input_tokens: validCache ? written : null,
    provider_cost_usd:
      typeof observation.providerCostUsd === "number" &&
      Number.isFinite(observation.providerCostUsd) &&
      observation.providerCostUsd >= 0 &&
      observation.providerCostUsd <= 1_000_000
        ? observation.providerCostUsd
        : null,
  };
}

/** SDK ModelUsage.inputTokens is uncached; every model is a separate component.
 * Never label a multi-model map as usage of the selected/default model. */
export function agentSdkUsageObservations(input: {
  id: string;
  model: string;
  modelUsage?: unknown;
  usage?: unknown;
  totalCostUsd?: unknown;
}): HarnessUsageObservation[] {
  const entries = Object.entries(record(input.modelUsage));
  if (entries.length)
    return entries.map(([model, raw]) => {
      const u = record(raw);
      return {
        id: `${input.id}:${model}`,
        provider: "anthropic",
        model,
        usage: {
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          cache_read_input_tokens: u.cacheReadInputTokens,
          cache_creation_input_tokens: u.cacheCreationInputTokens,
        },
        providerCostUsd: typeof u.costUSD === "number" ? u.costUSD : null,
      };
    });
  return [
    {
      id: input.id,
      provider: "anthropic",
      model: input.model,
      usage: input.usage,
      providerCostUsd:
        typeof input.totalCostUsd === "number" ? input.totalCostUsd : null,
    },
  ];
}

/** Serialized persistence prevents overlapping callbacks from replacing a newer
 * snapshot. A failed save is retried as data only, never by rerunning a model. */
export function createUsageRecorder(
  save: (receipt: HarnessUsageReceipt) => Promise<void>,
  now = () => new Date(),
) {
  const components = new Map<string, UsageComponent>();
  let pending = Promise.resolve();
  let incomplete = false;
  const snapshot = (finished: boolean): HarnessUsageReceipt => ({
    version: 1,
    status:
      finished &&
      !incomplete &&
      components.size > 0 &&
      [...components.values()].every(
        (item) => item.input_tokens !== null && item.output_tokens !== null,
      )
        ? "reported"
        : "partial",
    observed_at: now().toISOString(),
    components: [...components.values()].map((value) => ({ ...value })),
  });
  const persist = (finished: boolean) => {
    const value = snapshot(finished);
    const attempt = pending.then(() => save(value));
    pending = attempt.catch(() => {});
    return attempt;
  };
  return {
    markIncomplete() {
      incomplete = true;
    },
    async observe(observation: HarnessUsageObservation) {
      try {
        const component = usageComponent(observation),
          previous = components.get(component.id);
        if (
          previous &&
          JSON.stringify(previous) !== JSON.stringify(component)
        ) {
          incomplete = true;
          return;
        }
        if (!previous && components.size >= 128) {
          incomplete = true;
          return;
        }
        components.set(component.id, component);
        await persist(false);
      } catch {
        incomplete = true; /* Accounting failure cannot trigger harness fallback/re-execution. */
      }
    },
    async finish(finished: boolean) {
      await persist(finished);
      return snapshot(finished);
    },
    snapshot: () => snapshot(false),
  };
}
