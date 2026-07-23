"use client";

/**
 * ApiKeysSection — groovy/user key-mode chooser + per-provider key inputs.
 *
 * Extracted (behavior-preserving) from WelcomeOnboarding.tsx: render block was
 * lines 1806-1967 plus PROVIDER_INFO (44-63), handleApiModeSelect (586-601)
 * and handleApiKeysSubmit (603-617).
 */

import { useState } from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  ExternalLink,
  Key,
  Loader2,
} from "lucide-react";

export type Provider = "anthropic" | "openai" | "google";
export type LlmKeyMode = "groovy" | "user";

export const PROVIDER_INFO: Record<
  Provider,
  { name: string; placeholder: string; helpUrl: string; description: string }
> = {
  anthropic: {
    name: "Anthropic",
    placeholder: "sk-ant-...",
    helpUrl: "https://console.anthropic.com/settings/keys",
    description: "Claude models",
  },
  openai: {
    name: "OpenAI",
    placeholder: "sk-...",
    helpUrl: "https://platform.openai.com/api-keys",
    description: "GPT models",
  },
  google: {
    name: "Google",
    placeholder: "AIza...",
    helpUrl: "https://aistudio.google.com/app/apikey",
    description: "Gemini models",
  },
};

type ApiKeysSectionProps = {
  onSaveApiKeys: (keys: Partial<Record<Provider, string>>, mode: LlmKeyMode) => Promise<void>;
  /** Called after a successful save with the chosen mode. */
  onSaved: (mode: LlmKeyMode) => void;
  /** Back action when no mode is selected yet (mode reset is handled internally). */
  onBack?: () => void;
  initialMode?: LlmKeyMode | null;
  hideHeader?: boolean;
  title?: string;
  subtitle?: string;
  /** Self-hosted-only escape hatch. Hosted Groovy always requires BYOK. */
  allowServerProviderKeys?: boolean;
};

export function ApiKeysSection({
  onSaveApiKeys,
  onSaved,
  onBack,
  initialMode = null,
  hideHeader = false,
  title = "Step 5: Choose your API keys",
  subtitle = "You can change this anytime in settings.",
  allowServerProviderKeys = false,
}: ApiKeysSectionProps) {
  const [selectedMode, setSelectedMode] = useState<LlmKeyMode | null>(
    initialMode || (allowServerProviderKeys ? null : "user")
  );
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [showKeys, setShowKeys] = useState<Partial<Record<Provider, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApiModeSelect = async (mode: LlmKeyMode) => {
    setSelectedMode(mode);
    if (mode === "groovy") {
      // Save immediately and move on
      setSaving(true);
      try {
        await onSaveApiKeys({}, mode);
        onSaved(mode);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save");
      } finally {
        setSaving(false);
      }
    }
    // If "user" mode, they'll fill in keys and click continue
  };

  const handleApiKeysSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      const keysToSave = Object.fromEntries(
        Object.entries(keys).filter(([, v]) => v && v.trim())
      );
      await onSaveApiKeys(keysToSave, "user");
      onSaved("user");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const hasOrchestratorKey = !!keys.anthropic?.trim() || !!keys.openai?.trim();

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="relative z-10"
    >
      {!hideHeader && (
        <div className="text-center mb-8">
          <h2 className="text-2xl font-semibold text-white mb-2">{title}</h2>
          <p className="text-zinc-500 text-sm">{subtitle}</p>
        </div>
      )}

      {allowServerProviderKeys && !selectedMode ? (
        <div className="grid gap-4">
          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
            onClick={() => handleApiModeSelect("groovy")}
            disabled={saving}
            className="group relative p-6 rounded-2xl bg-zinc-900/80 border border-white/10 text-left transition-all hover:border-cyan-500/30 hover:bg-zinc-900 disabled:opacity-50"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center shrink-0">
                <Key className="w-6 h-6 text-cyan-400" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-medium text-white mb-1">Use server provider keys</h3>
                <p className="text-sm text-zinc-500">
                  For self-hosted deployments where you control the configured server environment
                  keys.
                </p>
              </div>
              <ArrowRight className="w-5 h-5 text-zinc-600 group-hover:text-cyan-400 transition-colors mt-1" />
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
            onClick={() => setSelectedMode("user")}
            disabled={saving}
            className="group relative p-6 rounded-2xl bg-zinc-900/80 border border-white/10 text-left transition-all hover:border-cyan-500/30 hover:bg-zinc-900 disabled:opacity-50"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                <Key className="w-6 h-6 text-zinc-400" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-medium text-white mb-1">Use my own API keys</h3>
                <p className="text-sm text-zinc-500">
                  Recommended. You control your provider account, usage, and billing.
                </p>
              </div>
              <ArrowRight className="w-5 h-5 text-zinc-600 group-hover:text-cyan-400 transition-colors mt-1" />
            </div>
          </motion.button>
        </div>
      ) : (
        <div className="bg-zinc-900/80 border border-white/10 rounded-2xl p-6 space-y-5">
          <div className="p-3 rounded-xl bg-cyan-500/5 border border-cyan-500/10">
            <p className="text-xs text-cyan-400/90">
              Add at least one key for the models you want to use. Your keys are encrypted with
              AES-256-GCM and Groovy never adds a token markup.
            </p>
          </div>

          {(Object.keys(PROVIDER_INFO) as Provider[]).map((provider) => {
            const info = PROVIDER_INFO[provider];
            const hasValue = keys[provider] && keys[provider]!.trim();
            return (
              <div key={provider} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-zinc-300">{info.name}</label>
                    <span className="text-xs text-zinc-600 ml-2">{info.description}</span>
                  </div>
                  <a
                    href={info.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition-colors"
                  >
                    Get key
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="relative">
                  <input
                    type={showKeys[provider] ? "text" : "password"}
                    value={keys[provider] || ""}
                    onChange={(e) => setKeys((prev) => ({ ...prev, [provider]: e.target.value }))}
                    placeholder={info.placeholder}
                    className="w-full px-4 py-3 pr-10 rounded-xl bg-black/40 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-cyan-500/50 transition-colors font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setShowKeys((prev) => ({ ...prev, [provider]: !prev[provider] }))
                    }
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {showKeys[provider] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {hasValue && (
                  <div className="flex items-center gap-1.5 text-emerald-400 text-xs">
                    <Check className="w-3 h-3" />
                    Ready
                  </div>
                )}
              </div>
            );
          })}

          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 mt-6">
        {(allowServerProviderKeys ? selectedMode || onBack : !!onBack) && (
          <button
            type="button"
            onClick={() => {
              if (selectedMode && allowServerProviderKeys) {
                setSelectedMode(null);
                setKeys({});
              } else {
                onBack?.();
              }
            }}
            className="px-5 py-3 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-all"
          >
            Back
          </button>
        )}
        {selectedMode && (
          <button
            type="button"
            onClick={handleApiKeysSubmit}
            disabled={saving || !hasOrchestratorKey}
            className="flex-1 px-5 py-3 rounded-xl bg-cyan-500 text-black font-medium text-sm hover:bg-cyan-400 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save keys and continue"
            )}
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </motion.div>
  );
}
