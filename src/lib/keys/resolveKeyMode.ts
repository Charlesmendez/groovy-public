/**
 * Per-provider key mode resolution.
 *
 * Determines, for each LLM provider, whether to use the user's own key
 * or the deployment's server-side provider key. Supports both per-provider modes (new)
 * and the legacy global mode (backward compat).
 *
 * Resolution order:
 *   1. Per-provider `apiKeyModes` from user_preferences.onboarding_data
 *   2. Legacy global mode from cookie `groovy_llm_mode`
 *   3. Legacy global mode from `onboarding_data.apiKeyMode`
 *   4. Default: "user". Customers bring their own provider keys by default.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import {
  getOrchestratorAnthropicModel,
  getOrchestratorOpenAiModel,
} from "@/lib/ai/modelResolver";
import {
  isServerKeyEligibleProvider,
  serverProviderKeysAllowed,
} from "@/lib/keys/providerKeyPolicy";

export type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "claude_cli"
  | "codex_cli"
  | "azure_openai"
  | "aws_bedrock"
  | "groq"
  | "mistral"
  | "other";
export type LlmKeyMode = "groovy" | "user";
export type KeyModes = Partial<Record<Provider, LlmKeyMode>>;

const LLM_KEY_MODE_COOKIE = "groovy_llm_mode";
const LLM_PROVIDERS: Provider[] = ["anthropic", "openai", "google", "xai"];
const EXTRA_PROVIDER_KEYS: Provider[] = ["azure_openai", "aws_bedrock", "groq", "mistral", "other"];
const HEADLESS_PROVIDER: Provider = "claude_cli";
const CODEX_HEADLESS_PROVIDER: Provider = "codex_cli";

function isClaudeCliOAuthToken(value: string): boolean {
  return value.trim().toLowerCase().startsWith("sk-ant-oat");
}

export type ResolvedKeys = {
  /** Effective per-provider modes */
  keyModes: KeyModes;
  /** Legacy global mode (for backward-compat paths that still use it) */
  globalMode: LlmKeyMode;
  /** Decrypted user keys (only for providers where mode=user and key exists) */
  userKeys: Partial<Record<Provider, string>>;
  /** Which provider+model to use for the main LLM call */
  provider: "anthropic" | "openai";
  modelName: string;
  /** The API key to use for the main LLM call (null = use server env) */
  apiKey: string | null;
  /** Claude headless CLI token (only when claude_cli mode=user and token stored) */
  claudeCliToken: string | null;
  /** Codex headless CLI API key (only when codex_cli mode=user and key stored) */
  codexCliApiKey: string | null;
};

/**
 * Resolve key modes + decrypt user keys for all providers.
 *
 * @param userId - The user's UUID
 * @param supabase - Admin or server Supabase client
 * @param cookies - Raw cookie header (can be empty for non-browser contexts)
 */
export async function resolveKeys(
  userId: string,
  supabase: SupabaseClient,
  cookies?: string
): Promise<ResolvedKeys> {
  // 1. Load user_preferences for per-provider modes + legacy apiKeyMode
  const { data: prefs } = await supabase
    .from("user_preferences")
    .select("onboarding_data")
    .eq("user_id", userId)
    .maybeSingle();

  const od = (prefs?.onboarding_data as Record<string, unknown>) || {};
  const storedKeyModes = (od.apiKeyModes as KeyModes) || {};
  const legacyApiKeyMode = od.apiKeyMode as string | undefined;

  const allowServerProviderKeys = serverProviderKeysAllowed();

  // 2. Legacy global mode: cookie → DB → default "user"
  let globalMode: LlmKeyMode = "user";
  const cookie = cookies || "";
  const modeMatch = cookie.match(
    new RegExp(`(?:^|;\\s*)${LLM_KEY_MODE_COOKIE}=(groovy|user)(?:;|$)`)
  );
  if (modeMatch?.[1] === "groovy" || modeMatch?.[1] === "user") {
    globalMode = modeMatch[1] as LlmKeyMode;
  } else if (legacyApiKeyMode === "groovy" || legacyApiKeyMode === "user") {
    globalMode = legacyApiKeyMode;
  }
  if (!allowServerProviderKeys) globalMode = "user";

  // 3. Build effective per-provider modes (per-provider > global fallback).
  // Headless mode selections are independent, but customer-owned LLM keys remain
  // the default for normal model providers.
  const providers: Provider[] = [...LLM_PROVIDERS, HEADLESS_PROVIDER, CODEX_HEADLESS_PROVIDER, ...EXTRA_PROVIDER_KEYS];
  const keyModes: KeyModes = {};
  for (const provider of LLM_PROVIDERS) {
    const storedMode = storedKeyModes[provider];
    keyModes[provider] = !allowServerProviderKeys
      ? "user"
      : storedMode === "groovy" || storedMode === "user"
        ? storedMode
        : globalMode;
  }
  const headlessStoredMode = storedKeyModes[HEADLESS_PROVIDER];
  keyModes[HEADLESS_PROVIDER] =
    headlessStoredMode === "groovy" || headlessStoredMode === "user"
      ? headlessStoredMode
      : "groovy";
  const codexHeadlessStoredMode = storedKeyModes[CODEX_HEADLESS_PROVIDER];
  keyModes[CODEX_HEADLESS_PROVIDER] =
    codexHeadlessStoredMode === "groovy" || codexHeadlessStoredMode === "user"
      ? codexHeadlessStoredMode
      : "groovy";
  for (const provider of EXTRA_PROVIDER_KEYS) {
    const storedMode = storedKeyModes[provider];
    keyModes[provider] =
      !allowServerProviderKeys && isServerKeyEligibleProvider(provider)
        ? "user"
        : storedMode === "groovy" || storedMode === "user"
          ? storedMode
          : "user";
  }

  // 4. Load user keys for providers that are set to "user"
  const userProviders = providers.filter((p) => keyModes[p] === "user");
  const userKeys: Partial<Record<Provider, string>> = {};

  if (userProviders.length > 0) {
    const { data: keyRows } = await supabase
      .from("user_api_keys")
      .select("provider, api_key_enc")
      .eq("user_id", userId)
      .in("provider", userProviders);

    for (const row of keyRows || []) {
      if (row.api_key_enc) {
        try {
          userKeys[row.provider as Provider] = decryptLlmApiKey(row.api_key_enc);
        } catch {
          // skip broken keys
        }
      }
    }
  }

  // Guardrail: users sometimes paste Claude CLI OAuth token (sk-ant-oat...)
  // into Anthropic API key. That token is valid for headless CLI flows only,
  // not Anthropic model API calls.
  const anthropicUserKey = userKeys.anthropic;
  if (
    keyModes.anthropic === "user" &&
    anthropicUserKey &&
    isClaudeCliOAuthToken(anthropicUserKey)
  ) {
    if (!userKeys.claude_cli) {
      // Salvage a misfiled token so headless CLI can still work.
      userKeys.claude_cli = anthropicUserKey;
    }
    delete userKeys.anthropic;
    if (allowServerProviderKeys && process.env.ANTHROPIC_API_KEY) {
      console.warn(
        "[resolveKeys] Anthropic user key looks like Claude CLI OAuth token; falling back to Groovy Anthropic key."
      );
      keyModes.anthropic = "groovy";
    } else {
      console.warn(
        "[resolveKeys] Anthropic user key looks like Claude CLI OAuth token; it will not be used for Anthropic model API calls."
      );
    }
  }

  // 5. Determine main LLM provider + apiKey
  let provider: "anthropic" | "openai" = "anthropic";
  let modelName = getOrchestratorAnthropicModel();
  let apiKey: string | null = null;

  const anthropicMode = keyModes.anthropic;
  const openaiMode = keyModes.openai;

  const anthropicAvailable =
    anthropicMode === "user" ? !!userKeys.anthropic : !!process.env.ANTHROPIC_API_KEY;
  const openaiAvailable =
    openaiMode === "user" ? !!userKeys.openai : !!process.env.OPENAI_API_KEY;

  // Prefer Anthropic if available, else fall back to OpenAI.
  if (anthropicAvailable) {
    provider = "anthropic";
    modelName = getOrchestratorAnthropicModel();
    apiKey = anthropicMode === "user" ? (userKeys.anthropic || null) : null;
  } else if (openaiAvailable) {
    provider = "openai";
    modelName = getOrchestratorOpenAiModel();
    apiKey = openaiMode === "user" ? (userKeys.openai || null) : null;
  } else {
    // Leave defaults; caller should handle missing keys.
    provider = "anthropic";
    modelName = getOrchestratorAnthropicModel();
    apiKey = null;
  }

  // 6. Claude headless CLI token
  const claudeCliToken =
    keyModes.claude_cli === "user" && userKeys.claude_cli
      ? userKeys.claude_cli
      : null;

  // 7. Codex headless CLI API key
  const codexCliApiKey =
    keyModes.codex_cli === "user" && userKeys.codex_cli
      ? userKeys.codex_cli
      : null;

  return {
    keyModes,
    globalMode,
    userKeys,
    provider,
    modelName,
    apiKey,
    claudeCliToken,
    codexCliApiKey,
  };
}

/**
 * Build the apiKeys + claudeCliToken bag for ToolExecutionContext.
 */
export function buildToolApiKeys(resolved: ResolvedKeys): {
  apiKeys: { anthropic?: string; openai?: string };
  claudeCliToken: string | null;
} {
  const apiKeys: { anthropic?: string; openai?: string } = {};

  // Anthropic key for tools (code_cli_run api_key fallback, etc.)
  if (resolved.keyModes.anthropic === "user") {
    if (resolved.userKeys.anthropic) apiKeys.anthropic = resolved.userKeys.anthropic;
  } else {
    if (process.env.ANTHROPIC_API_KEY) apiKeys.anthropic = process.env.ANTHROPIC_API_KEY;
  }

  // OpenAI key for tools
  if (resolved.keyModes.openai === "user") {
    if (resolved.userKeys.openai) apiKeys.openai = resolved.userKeys.openai;
  } else {
    if (process.env.OPENAI_API_KEY) apiKeys.openai = process.env.OPENAI_API_KEY;
  }

  return { apiKeys, claudeCliToken: resolved.claudeCliToken };
}
