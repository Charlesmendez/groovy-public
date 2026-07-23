"use client";

/**
 * Settings state for the harness dashboard: provider API key status + key
 * modes, persisted via /api/user-api-keys. Extracted from the dashboard-v2
 * wiring so SettingsModal can be reused as-is.
 */

import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export type SettingsProvider = "anthropic" | "openai" | "google" | "xai" | "claude_cli";
export type LlmKeyMode = "groovy" | "user";
export type KeyModes = Partial<Record<SettingsProvider, LlmKeyMode>>;

export type ApiKeyStatusMap = Partial<
  Record<SettingsProvider, { configured: boolean; lastUpdated?: string }>
>;

export function useSettingsState(userId: string | null) {
  const supabase = getSupabaseBrowserClient();
  const [apiKeys, setApiKeys] = useState<ApiKeyStatusMap>({});
  const [llmKeyMode, setLlmKeyMode] = useState<LlmKeyMode>("user");
  const [llmKeyModes, setLlmKeyModes] = useState<KeyModes>({});
  const [serverProviderKeysAllowed, setServerProviderKeysAllowed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data: keys } = await supabase
        .from("user_api_keys")
        .select("provider, created_at")
        .eq("user_id", userId);
      if (!cancelled && keys) {
        const keyStatus: ApiKeyStatusMap = {};
        for (const key of keys) {
          keyStatus[key.provider as SettingsProvider] = {
            configured: true,
            lastUpdated: key.created_at,
          };
        }
        setApiKeys(keyStatus);
      }

      try {
        const res = await fetch("/api/user-api-keys");
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        const mode = json?.mode;
        if (mode === "groovy" || mode === "user") setLlmKeyMode(mode);
        if (json?.keyModes && typeof json.keyModes === "object") {
          setLlmKeyModes(json.keyModes);
        }
        setServerProviderKeysAllowed(json?.serverProviderKeysAllowed === true);
      } catch {
        // ignore
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, userId]);

  const saveKeys = useCallback(
    async (
      keys: Partial<Record<SettingsProvider, string>>,
      mode: LlmKeyMode,
      keyModes?: KeyModes
    ) => {
      const response = await fetch("/api/user-api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keys: Object.keys(keys).length ? keys : undefined,
          mode,
          keyModes,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save keys");
      }

      setApiKeys((prev) => {
        const next = { ...prev };
        for (const provider of Object.keys(keys) as SettingsProvider[]) {
          next[provider] = { configured: true, lastUpdated: new Date().toISOString() };
        }
        return next;
      });
      setLlmKeyMode(mode);
      if (keyModes) setLlmKeyModes(keyModes);
    },
    []
  );

  return {
    apiKeys,
    llmKeyMode,
    llmKeyModes,
    serverProviderKeysAllowed,
    loaded,
    saveKeys,
  };
}
