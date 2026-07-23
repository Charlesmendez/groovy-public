/**
 * User API Keys Management
 * Store and retrieve encrypted API keys for LLM providers.
 * Supports per-provider key modes. Customer-owned provider keys are the default.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { encryptLlmApiKey, hashLlmApiKey } from "@/lib/crypto/llmKey";
import {
  isServerKeyEligibleProvider,
  serverProviderKeysAllowed,
} from "@/lib/keys/providerKeyPolicy";

type Provider =
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
type LlmKeyMode = "groovy" | "user";

const VALID_PROVIDERS: Provider[] = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "claude_cli",
  "codex_cli",
  "azure_openai",
  "aws_bedrock",
  "groq",
  "mistral",
  "other",
];
const GLOBAL_MODE_PROVIDERS: Provider[] = ["anthropic", "openai", "google", "xai"];
const LLM_KEY_MODE_COOKIE = "groovy_llm_mode";

/** Per-provider key modes: which source to use for each provider */
type KeyModes = Partial<Record<Provider, LlmKeyMode>>;

function deriveLegacyGlobalModeFromKeyModes(keyModes: KeyModes): LlmKeyMode {
  const explicitLlmModes = GLOBAL_MODE_PROVIDERS.filter(
    (provider) => keyModes[provider] === "groovy" || keyModes[provider] === "user"
  );
  if (explicitLlmModes.length === 0) return "user";
  return explicitLlmModes.some((provider) => keyModes[provider] === "user") ? "user" : "groovy";
}

type PostBody = {
  keys?: Partial<Record<Provider, string>>;
  mode?: LlmKeyMode;
  /** Per-provider key modes (new). Takes precedence over legacy `mode`. */
  keyModes?: KeyModes;
};

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const keys = body.keys || null;
  const modeRaw = body.mode;
  const mode: LlmKeyMode | null =
    modeRaw === "groovy" || modeRaw === "user" ? modeRaw : null;
  const keyModes = body.keyModes && typeof body.keyModes === "object" ? body.keyModes : null;
  const allowServerProviderKeys = serverProviderKeysAllowed();

  if (!allowServerProviderKeys && mode === "groovy") {
    return NextResponse.json(
      {
        error:
          "Hosted Groovy requires your own provider keys. Server provider keys are only available when a self-hosted deployment explicitly enables them.",
        code: "server_provider_keys_disabled",
      },
      { status: 403 }
    );
  }

  if (
    !allowServerProviderKeys &&
    keyModes &&
    Object.entries(keyModes).some(
      ([provider, selectedMode]) =>
        selectedMode === "groovy" && isServerKeyEligibleProvider(provider)
    )
  ) {
    return NextResponse.json(
      {
        error:
          "Hosted Groovy requires your own provider keys. Choose Own key for model providers.",
        code: "server_provider_keys_disabled",
      },
      { status: 403 }
    );
  }

  if (!keys && !mode && !keyModes) {
    return NextResponse.json(
      { error: "Invalid request (expected keys, mode, and/or keyModes)" },
      { status: 400 }
    );
  }

  const results: { provider: Provider; success: boolean; error?: string }[] = [];

  if (keys) {
    for (const [provider, apiKey] of Object.entries(keys)) {
      if (!VALID_PROVIDERS.includes(provider as Provider)) {
        results.push({
          provider: provider as Provider,
          success: false,
          error: "Invalid provider",
        });
        continue;
      }

      if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
        results.push({
          provider: provider as Provider,
          success: false,
          error: "Empty key",
        });
        continue;
      }

      try {
        const encrypted = encryptLlmApiKey(apiKey.trim());
        const hash = hashLlmApiKey(apiKey.trim());

        // Upsert the key
        const { error } = await supabase
          .from("user_api_keys")
          .upsert(
            {
              user_id: user.id,
              provider,
              api_key_enc: encrypted,
              api_key_hash: hash,
              created_at: new Date().toISOString(),
            },
            {
              onConflict: "user_id,provider",
            }
          );

        if (error) {
          results.push({
            provider: provider as Provider,
            success: false,
            error: error.message,
          });
        } else {
          results.push({ provider: provider as Provider, success: true });
        }
      } catch (err) {
        results.push({
          provider: provider as Provider,
          success: false,
          error: err instanceof Error ? err.message : "Encryption failed",
        });
      }
    }

    const failures = results.filter((r) => !r.success);
    if (failures.length === results.length) {
      return NextResponse.json(
        { error: "Failed to save any keys", results },
        { status: 500 }
      );
    }
  }

  // Persist per-provider keyModes into user_preferences.onboarding_data.apiKeyModes
  let persistedKeyModes: KeyModes | null = null;
  if (keyModes) {
    // Validate each entry
    const cleanModes: KeyModes = {};
    for (const [p, m] of Object.entries(keyModes)) {
      if (VALID_PROVIDERS.includes(p as Provider) && (m === "groovy" || m === "user")) {
        cleanModes[p as Provider] =
          !allowServerProviderKeys && isServerKeyEligibleProvider(p) ? "user" : m;
      }
    }
    persistedKeyModes = cleanModes;
  }

  // Legacy cookie/global mode (backward compat):
  // derive from non-headless providers only, so claude_cli does not force user mode.
  let effectiveMode: LlmKeyMode | null = persistedKeyModes
    ? deriveLegacyGlobalModeFromKeyModes(persistedKeyModes)
    : mode;
  let responseKeyModes: KeyModes | null = persistedKeyModes;

  // IMPORTANT: Persist mode selections to DB, not just cookies.
  // Scheduled jobs (heartbeat) and other server-side contexts don't have browser cookies,
  // so they rely on user_preferences.onboarding_data.apiKeyMode/apiKeyModes.
  if (effectiveMode || persistedKeyModes) {
    try {
      const { data: existingPrefs } = await supabase
        .from("user_preferences")
        .select("onboarding_data")
        .eq("user_id", user.id)
        .maybeSingle();

      const existingData = (existingPrefs?.onboarding_data as Record<string, unknown>) || {};
      const existingModes = (existingData.apiKeyModes as KeyModes) || {};
      const mergedModes = persistedKeyModes ? { ...existingModes, ...persistedKeyModes } : existingModes;
      if (persistedKeyModes) {
        effectiveMode = deriveLegacyGlobalModeFromKeyModes(mergedModes);
        responseKeyModes = mergedModes;
      }

      await supabase.from("user_preferences").upsert(
        {
          user_id: user.id,
          onboarding_data: {
            ...existingData,
            ...(effectiveMode ? { apiKeyMode: effectiveMode } : {}),
            ...(persistedKeyModes ? { apiKeyModes: mergedModes } : {}),
          },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
    } catch {
      // Best-effort: cookie still set below
    }
  }

  const res = NextResponse.json({
    success: true,
    results,
    mode: effectiveMode || undefined,
    keyModes: responseKeyModes || undefined,
  });

  if (effectiveMode) {
    res.cookies.set(LLM_KEY_MODE_COOKIE, effectiveMode, {
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 365, // 1 year
    });
  }

  return res;
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: keys, error } = await supabase
    .from("user_api_keys")
    .select("provider, created_at")
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Return provider status (not the actual keys)
  const status: Partial<Record<Provider, { configured: boolean; lastUpdated: string }>> = {};
  for (const key of keys || []) {
    status[key.provider as Provider] = {
      configured: true,
      lastUpdated: key.created_at,
    };
  }

  // Read per-provider keyModes from user_preferences
  const { data: prefs } = await supabase
    .from("user_preferences")
    .select("onboarding_data")
    .eq("user_id", user.id)
    .maybeSingle();

  const onboardingData = (prefs?.onboarding_data as Record<string, unknown>) || {};
  const allowServerProviderKeys = serverProviderKeysAllowed();
  const rawSavedKeyModes = (onboardingData.apiKeyModes as KeyModes) || {};
  const savedKeyModes: KeyModes = { ...rawSavedKeyModes };
  if (!allowServerProviderKeys) {
    for (const provider of VALID_PROVIDERS) {
      if (isServerKeyEligibleProvider(provider)) savedKeyModes[provider] = "user";
    }
  }

  const hasAnyProviderModes = Object.keys(rawSavedKeyModes).length > 0;
  const savedModeRaw = onboardingData.apiKeyMode as string | undefined;
  const hasSavedMode = savedModeRaw === "groovy" || savedModeRaw === "user";

  // Legacy global mode: derive from cookie → per-provider modes → DB apiKeyMode → default.
  // modeExplicitlySet is intentionally DB-backed only (not cookie-only),
  // so a browser cookie from another account does not suppress onboarding.
  let mode: LlmKeyMode = "user";
  const modeExplicitlySet = hasAnyProviderModes || hasSavedMode;
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(
    new RegExp(`(?:^|;\\s*)${LLM_KEY_MODE_COOKIE}=(groovy|user)(?:;|$)`)
  );
  if (allowServerProviderKeys && (m?.[1] === "groovy" || m?.[1] === "user")) {
    mode = m[1] as LlmKeyMode;
  } else {
    // If we have per-provider modes saved, derive a global mode for backwards-compat:
    // user if any NON-HEADLESS provider is user, else groovy.
    if (hasAnyProviderModes) {
      mode = deriveLegacyGlobalModeFromKeyModes(savedKeyModes);
    } else if (hasSavedMode) {
      mode = savedModeRaw as LlmKeyMode;
    }
  }

  if (!allowServerProviderKeys) mode = "user";

  return NextResponse.json({
    keys: status,
    mode,
    modeExplicitlySet,
    keyModes: savedKeyModes,
    serverProviderKeysAllowed: allowServerProviderKeys,
  });
}

export async function DELETE(req: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const provider = searchParams.get("provider");

  if (!provider || !VALID_PROVIDERS.includes(provider as Provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  const { error } = await supabase
    .from("user_api_keys")
    .delete()
    .eq("user_id", user.id)
    .eq("provider", provider);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, deleted: provider });
}
