import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createXai } from "@ai-sdk/xai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

export type ProviderId = "openai" | "anthropic" | "xai" | "google";
export const ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";
const DEFAULT_ORCHESTRATOR_ANTHROPIC_MODEL = "claude-opus-4-6";
const DEFAULT_ORCHESTRATOR_OPENAI_MODEL = "gpt-4o";
const DEFAULT_COMPUTER_USE_MODEL = "claude-sonnet-4-6";
const DEFAULT_COMPUTER_USE_BETA = "computer-use-2025-11-24";
const DEFAULT_FILES_AGENT_MODEL = "claude-opus-4-6";
const DEFAULT_DATAGRAN_CHAT_MODEL = "claude-opus-4-6";

function firstNonEmptyEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function coerceAnthropicModel(
  raw: string | undefined,
  fallbackModel: string,
  source: string
): string {
  const requested = (raw || "").trim();
  const resolved = resolveAnthropicModel(requested || fallbackModel);
  if (resolved.toLowerCase().startsWith("claude-")) {
    return resolved;
  }
  console.warn(
    `[modelResolver] Ignoring non-Anthropic model from ${source}: "${requested || "<empty>"}". Using "${fallbackModel}".`
  );
  return resolveAnthropicModel(fallbackModel);
}

export function getOrchestratorAnthropicModel(): string {
  const raw =
    firstNonEmptyEnv(
      "ORCH_ANTHROPIC_MODEL",
      "ORCHESTRATOR_ANTHROPIC_MODEL",
      "ORCH_MODEL",
      "ORCHESTRATOR_MODEL"
    ) || DEFAULT_ORCHESTRATOR_ANTHROPIC_MODEL;
  return coerceAnthropicModel(
    raw,
    DEFAULT_ORCHESTRATOR_ANTHROPIC_MODEL,
    "ORCH_ANTHROPIC_MODEL/ORCHESTRATOR_ANTHROPIC_MODEL/ORCH_MODEL/ORCHESTRATOR_MODEL"
  );
}

export function getOrchestratorOpenAiModel(): string {
  return (
    firstNonEmptyEnv(
      "ORCH_OPENAI_MODEL",
      "ORCHESTRATOR_OPENAI_MODEL"
    ) || DEFAULT_ORCHESTRATOR_OPENAI_MODEL
  );
}

export function getOrchestratorAgentSdkFallbackModel(): string {
  const raw =
    firstNonEmptyEnv(
      "ORCH_AGENT_SDK_MODEL",
      "ORCHESTRATOR_AGENT_SDK_MODEL"
    ) || getOrchestratorAnthropicModel();
  return coerceAnthropicModel(
    raw,
    getOrchestratorAnthropicModel(),
    "ORCH_AGENT_SDK_MODEL/ORCHESTRATOR_AGENT_SDK_MODEL"
  );
}

export function getComputerUseModel(): string {
  const raw =
    firstNonEmptyEnv(
      "COMPUTER_USE_MODEL",
      "BROWSER_AGENT_MODEL",
      "ORCH_COMPUTER_USE_MODEL"
    ) || DEFAULT_COMPUTER_USE_MODEL;
  return coerceAnthropicModel(
    raw,
    DEFAULT_COMPUTER_USE_MODEL,
    "COMPUTER_USE_MODEL/BROWSER_AGENT_MODEL/ORCH_COMPUTER_USE_MODEL"
  );
}

export function getComputerUseBeta(): string {
  return (
    firstNonEmptyEnv(
      "COMPUTER_USE_BETA",
      "BROWSER_AGENT_COMPUTER_USE_BETA"
    ) || DEFAULT_COMPUTER_USE_BETA
  );
}

export function getFilesAgentModel(): string {
  return coerceAnthropicModel(
    firstNonEmptyEnv("FILES_AGENT_MODEL"),
    DEFAULT_FILES_AGENT_MODEL,
    "FILES_AGENT_MODEL"
  );
}

export function getDatagranChatModel(): string {
  return coerceAnthropicModel(
    firstNonEmptyEnv("DATAGRAN_CHAT_MODEL"),
    DEFAULT_DATAGRAN_CHAT_MODEL,
    "DATAGRAN_CHAT_MODEL"
  );
}

// Map display/shorthand names to actual API model identifiers
const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  // Opus models
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-opus-4.5": "claude-opus-4-5-20251101",
  "claude-opus-4": "claude-opus-4-20250514",
  "claude-opus-4.1": "claude-opus-4-1-20250805",
  // Sonnet models
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4.5": "claude-sonnet-4-5-20250929",
  "claude-sonnet-4": "claude-sonnet-4-20250514",
  "claude-sonnet-3.7": "claude-3-7-sonnet-20250219",
  "claude-sonnet-3.5": "claude-3-5-sonnet-20241022",
  // Haiku models
  "claude-haiku-4.5": "claude-haiku-4-5-20251001",
  // Legacy alias: 3.5 id is no longer available in current Anthropic API.
  "claude-haiku-3.5": "claude-haiku-4-5-20251001",
};

// Models that support extended thinking
// https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
const ANTHROPIC_EXTENDED_THINKING_MODELS = new Set([
  // Opus
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  // Sonnet
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
  // Haiku
  "claude-haiku-4-5-20251001",
  // Display names (for convenience)
  "claude-opus-4.6",
  "claude-opus-4.5",
  "claude-opus-4.1",
  "claude-opus-4",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-sonnet-3.7",
  "claude-haiku-4.5",
]);

function resolveAnthropicModel(model: string): string {
  return ANTHROPIC_MODEL_MAP[model] || model;
}

function supportsAnthropicContext1MBeta(model: string): boolean {
  const resolved = resolveAnthropicModel(model).toLowerCase();
  return /claude-(sonnet|opus)-4-(6|5)/i.test(resolved);
}

export function getAnthropicContextProviderOptions(
  provider: ProviderId,
  model: string
): { anthropic: { betas: string[] } } | undefined {
  if (provider !== "anthropic") return undefined;
  if (!supportsAnthropicContext1MBeta(model)) return undefined;
  return { anthropic: { betas: [ANTHROPIC_CONTEXT_1M_BETA] } };
}

function supportsAnthropicAdaptiveThinking(model: string): boolean {
  const resolved = resolveAnthropicModel(model).toLowerCase();
  return /claude-(sonnet|opus)-4-6/i.test(resolved);
}

export function getAnthropicReasoningProviderOptions(
  provider: ProviderId,
  model: string,
  args?: { enableThinking?: boolean }
): { anthropic: { betas?: string[]; thinking?: { type: "adaptive" } } } | undefined {
  const base = getAnthropicContextProviderOptions(provider, model);
  if (provider !== "anthropic") return base;
  if (!args?.enableThinking) return base;
  if (!supportsAnthropicAdaptiveThinking(model)) return base;
  return {
    anthropic: {
      ...(base?.anthropic || {}),
      thinking: { type: "adaptive" },
    },
  };
}

export function getModelContextBudget(
  provider: ProviderId,
  model: string,
  providerOptions?: { anthropic?: { betas?: string[] } }
): {
  contextWindowTokens: number;
  compactionTriggerTokens: number;
  keepRecentTokens: number;
} {
  let contextWindowTokens = 128_000;
  if (provider === "anthropic") contextWindowTokens = 200_000;

  const enabledBetas = providerOptions?.anthropic?.betas || [];
  const has1MBeta =
    provider === "anthropic" &&
    supportsAnthropicContext1MBeta(model) &&
    enabledBetas.includes(ANTHROPIC_CONTEXT_1M_BETA);
  if (has1MBeta) contextWindowTokens = 1_000_000;

  // Leave room for system prompt, tool schemas, and generation headroom.
  const compactionTriggerTokens = has1MBeta
    ? 700_000
    : Math.max(120_000, Math.floor(contextWindowTokens * 0.75));
  const keepRecentTokens = has1MBeta
    ? 180_000
    : Math.max(40_000, Math.floor(contextWindowTokens * 0.2));

  return {
    contextWindowTokens,
    compactionTriggerTokens,
    keepRecentTokens,
  };
}

export function supportsExtendedThinking(provider: string, model: string): boolean {
  if (provider !== "anthropic") return provider === "openai";
  const resolvedModel = resolveAnthropicModel(model);
  return ANTHROPIC_EXTENDED_THINKING_MODELS.has(resolvedModel) || 
         ANTHROPIC_EXTENDED_THINKING_MODELS.has(model);
}

/**
 * Get the Groovy (server-side) API key for a provider from env vars
 */
export function getGroovyApiKey(provider: ProviderId): string | undefined {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "google":
      // Support both GEMINI_API_KEY and GOOGLE_GENERATIVE_AI_API_KEY
      return process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
    case "xai":
      return process.env.XAI_API_KEY;
    default:
      return undefined;
  }
}

export function resolveChatModel(
  provider: ProviderId,
  model: string,
  opts?: { apiKey?: string }
): LanguageModel {
  // If no user apiKey provided, fall back to Groovy's server-side env var
  const effectiveKey = opts?.apiKey || getGroovyApiKey(provider);
  
  switch (provider) {
    case "openai": {
      const openai = createOpenAI(effectiveKey ? { apiKey: effectiveKey } : {});
      return openai(model);
    }
    case "anthropic": {
      const anthropic = createAnthropic(effectiveKey ? { apiKey: effectiveKey } : {});
      return anthropic(resolveAnthropicModel(model));
    }
    case "xai": {
      const xai = createXai(effectiveKey ? { apiKey: effectiveKey } : {});
      return xai(model);
    }
    case "google": {
      const google = createGoogleGenerativeAI(effectiveKey ? { apiKey: effectiveKey } : {});
      return google(model);
    }
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

