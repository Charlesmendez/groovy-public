/**
 * Curated model catalog for user-facing pickers (orchestrator brain,
 * heartbeat digest, worker overrides). Any model id outside the catalog is
 * also allowed everywhere via custom entry — the catalog is a convenience,
 * not an allowlist.
 */

export type CatalogProvider = "anthropic" | "openai";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type CatalogModel = {
  id: string;
  label: string;
  hint?: string;
};

export type CatalogGroup = {
  provider: CatalogProvider;
  group: string;
  models: CatalogModel[];
};

export const MODEL_CATALOG: CatalogGroup[] = [
  {
    provider: "anthropic",
    group: "Claude",
    models: [
      { id: "claude-fable-5", label: "Fable 5", hint: "most capable" },
      { id: "claude-opus-4-7", label: "Opus 4.7", hint: "strong planner" },
      { id: "claude-opus-4-6", label: "Opus 4.6" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "balanced" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "fast + cheap" },
    ],
  },
  {
    provider: "openai",
    group: "OpenAI",
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", hint: "maximum capability" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", hint: "balanced default" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "fast + efficient" },
      { id: "gpt-5.5", label: "GPT-5.5", hint: "previous flagship" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o mini", hint: "fast + cheap" },
    ],
  },
];

export function catalogModelLabel(modelId: string | null | undefined): string {
  if (!modelId) return "Auto";
  for (const group of MODEL_CATALOG) {
    const found = group.models.find((m) => m.id === modelId);
    if (found) return found.label;
  }
  return modelId;
}

/** Best-effort provider inference for custom model ids. */
export function inferProviderForModelId(modelId: string): CatalogProvider {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3")) {
    return "openai";
  }
  return "anthropic";
}

export function reasoningEffortsForModel(
  modelId: string | null | undefined,
  surface: "api" | "cli" = "api"
): ReasoningEffort[] {
  const model = String(modelId || "").toLowerCase();
  if (model.startsWith("gpt-5.6")) return ["none", "low", "medium", "high", "xhigh", "max"];
  if (model.startsWith("gpt-5.5")) return ["none", "low", "medium", "high", "xhigh"];
  if (/^claude-(fable-5|opus-4-7)/.test(model)) {
    return surface === "cli"
      ? ["low", "medium", "high", "xhigh", "max"]
      : ["low", "medium", "high", "max"];
  }
  if (/^claude-(opus-4-(6|5)|sonnet-4-6)/.test(model)) {
    return ["low", "medium", "high", "max"];
  }
  return [];
}
