"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Save,
  ShieldCheck,
} from "lucide-react";
import type {
  KeyModes,
  LlmKeyMode,
  Provider,
} from "@/lib/keys/resolveKeyMode";
import { isServerKeyEligibleProvider } from "@/lib/keys/providerKeyPolicy";
import {
  AGENT_RUNTIME_PROVIDER_ORDER,
  buildInitialProviderModes,
  deriveGlobalProviderMode,
  hasPrimaryProviderKey,
  MODEL_PROVIDER_ORDER,
  PROVIDER_INFO,
  providerKeyModesChanged,
  providerManagedModeLabel,
  providerUserModeLabel,
} from "@/lib/keys/providerSettings";

type ProviderKeyStatus = Partial<
  Record<Provider, { configured: boolean; lastUpdated?: string }>
>;

type ProviderSettingsResponse = {
  keys?: ProviderKeyStatus;
  mode?: LlmKeyMode;
  keyModes?: KeyModes;
  serverProviderKeysAllowed?: boolean;
  error?: string;
};

function updatedLabel(value?: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ProviderKeysSettings() {
  const [configuredKeys, setConfiguredKeys] = useState<ProviderKeyStatus>({});
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [modes, setModes] = useState<KeyModes>({});
  const [initialModes, setInitialModes] = useState<KeyModes>({});
  const [showKeys, setShowKeys] = useState<
    Partial<Record<Provider, boolean>>
  >({});
  const [allowServerProviderKeys, setAllowServerProviderKeys] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/user-api-keys", {
        cache: "no-store",
        signal,
      });
      const payload = (await response.json().catch(() => ({}))) as
        ProviderSettingsResponse;
      if (!response.ok) {
        throw new Error(payload.error || "Provider settings could not be loaded.");
      }
      const allowServer = payload.serverProviderKeysAllowed === true;
      const globalMode =
        payload.mode === "groovy" || payload.mode === "user"
          ? payload.mode
          : "user";
      const nextModes = buildInitialProviderModes(
        globalMode,
        payload.keyModes,
        allowServer,
      );
      setConfiguredKeys(payload.keys || {});
      setAllowServerProviderKeys(allowServer);
      setModes(nextModes);
      setInitialModes(nextModes);
    } catch (reason) {
      if (reason instanceof Error && reason.name === "AbortError") return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Provider settings could not be loaded.",
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings]);

  const trimmedKeys = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(keys)
          .map(([provider, value]) => [provider, value.trim()])
          .filter(([, value]) => Boolean(value)),
      ) as Partial<Record<Provider, string>>,
    [keys],
  );
  const hasKeyInput = Object.keys(trimmedKeys).length > 0;
  const modesChanged = providerKeyModesChanged(modes, initialModes);

  const save = async () => {
    if (
      !allowServerProviderKeys &&
      !hasPrimaryProviderKey({
        configured: configuredKeys,
        entered: trimmedKeys,
      })
    ) {
      setError(
        "Add an Anthropic or OpenAI API key so Groovy's orchestrator can run.",
      );
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/user-api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(hasKeyInput ? { keys: trimmedKeys } : {}),
          mode: deriveGlobalProviderMode(modes, allowServerProviderKeys),
          keyModes: modes,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as
        ProviderSettingsResponse;
      if (!response.ok) {
        throw new Error(payload.error || "Provider settings could not be saved.");
      }
      const savedAt = new Date().toISOString();
      setConfiguredKeys((current) => {
        const next = { ...current };
        for (const provider of Object.keys(trimmedKeys) as Provider[]) {
          next[provider] = { configured: true, lastUpdated: savedAt };
        }
        return next;
      });
      setKeys({});
      setInitialModes({ ...modes });
      setSuccess(
        hasKeyInput
          ? "Provider keys saved securely."
          : "Provider preferences saved.",
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Provider settings could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  const renderProvider = (provider: Provider) => {
    const info = PROVIDER_INFO[provider];
    const mode = modes[provider] || "user";
    const usesOwnKey = mode === "user";
    const configured = configuredKeys[provider]?.configured === true;
    const updated = updatedLabel(configuredKeys[provider]?.lastUpdated);
    const canChooseManagedMode =
      allowServerProviderKeys || !isServerKeyEligibleProvider(provider);

    return (
      <div
        key={provider}
        className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium text-zinc-200">
                {info.name}
              </h3>
              {configured && usesOwnKey ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/15 bg-emerald-400/[0.07] px-2 py-0.5 text-[10px] text-emerald-300">
                  <Check className="h-3 w-3" />
                  Configured
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              {info.shortDescription}
            </p>
            {configured && updated && usesOwnKey ? (
              <p className="mt-1 text-[10px] text-zinc-600">
                Last replaced {updated}
              </p>
            ) : null}
          </div>

          {canChooseManagedMode ? (
            <div
              className="flex shrink-0 items-center gap-1 rounded-xl border border-white/[0.07] bg-black/20 p-1"
              aria-label={`${info.name} key source`}
            >
              <button
                type="button"
                onClick={() =>
                  setModes((current) => ({
                    ...current,
                    [provider]: "groovy",
                  }))
                }
                className={`rounded-lg px-2.5 py-1.5 text-[11px] transition ${
                  !usesOwnKey
                    ? "bg-cyan-400/[0.13] text-cyan-200"
                    : "text-zinc-600 hover:text-zinc-300"
                }`}
                aria-pressed={!usesOwnKey}
              >
                {providerManagedModeLabel(provider)}
              </button>
              <button
                type="button"
                onClick={() =>
                  setModes((current) => ({
                    ...current,
                    [provider]: "user",
                  }))
                }
                className={`rounded-lg px-2.5 py-1.5 text-[11px] transition ${
                  usesOwnKey
                    ? "bg-cyan-400/[0.13] text-cyan-200"
                    : "text-zinc-600 hover:text-zinc-300"
                }`}
                aria-pressed={usesOwnKey}
              >
                {providerUserModeLabel(provider)}
              </button>
            </div>
          ) : (
            <span className="shrink-0 rounded-full border border-cyan-400/15 bg-cyan-400/[0.06] px-2.5 py-1 text-[10px] text-cyan-300">
              Own key
            </span>
          )}
        </div>

        {usesOwnKey ? (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <input
                type={showKeys[provider] ? "text" : "password"}
                value={keys[provider] || ""}
                onChange={(event) =>
                  setKeys((current) => ({
                    ...current,
                    [provider]: event.target.value,
                  }))
                }
                placeholder={
                  configured ? "Enter a new key to replace it…" : info.placeholder
                }
                aria-label={`${info.name} API key`}
                autoComplete="new-password"
                spellCheck={false}
                className="h-11 w-full rounded-xl border border-white/[0.09] bg-black/30 px-3 pr-10 font-mono text-sm text-zinc-200 outline-none transition placeholder:text-zinc-700 focus:border-cyan-400/35 focus:ring-2 focus:ring-cyan-400/10"
              />
              <button
                type="button"
                onClick={() =>
                  setShowKeys((current) => ({
                    ...current,
                    [provider]: !current[provider],
                  }))
                }
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-600 transition hover:bg-white/5 hover:text-zinc-300"
                aria-label={`${
                  showKeys[provider] ? "Hide" : "Show"
                } ${info.name} API key`}
              >
                {showKeys[provider] ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            <a
              href={info.helpUrl}
              target={info.helpUrl.startsWith("http") ? "_blank" : undefined}
              rel={
                info.helpUrl.startsWith("http")
                  ? "noopener noreferrer"
                  : undefined
              }
              className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-white/[0.08] px-3 text-xs text-zinc-500 transition hover:border-white/[0.14] hover:text-zinc-200"
            >
              Get key
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : null}

        {info.description ? (
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
            {info.description}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-cyan-300" />
            <h2 className="text-2xl font-semibold">Model providers</h2>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Add or replace the provider credentials used by Groovy&apos;s
            orchestrator, Minds, and local coding agents.
          </p>
        </div>
        <div className="inline-flex max-w-sm items-start gap-2 rounded-xl border border-emerald-400/10 bg-emerald-400/[0.04] px-3 py-2 text-[11px] leading-relaxed text-emerald-200/80">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Keys are encrypted with AES-256-GCM. Existing values are never sent
          back to your browser.
        </div>
      </div>

      {loading ? (
        <div
          className="mt-8 flex min-h-48 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.02] text-sm text-zinc-500"
          aria-label="Loading provider settings"
        >
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading provider settings…
        </div>
      ) : (
        <>
          <section className="mt-8">
            <div className="mb-3">
              <h3 className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">
                Model APIs
              </h3>
              <p className="mt-1 text-xs text-zinc-600">
                Anthropic or OpenAI is required for the main orchestrator.
                Configure other providers when a Mind uses them.
              </p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {MODEL_PROVIDER_ORDER.map(renderProvider)}
            </div>
          </section>

          <section className="mt-8">
            <div className="mb-3">
              <h3 className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">
                Local coding agents
              </h3>
              <p className="mt-1 text-xs text-zinc-600">
                Use the connector machine&apos;s local login, or provide a
                dedicated headless credential.
              </p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {AGENT_RUNTIME_PROVIDER_ORDER.map(renderProvider)}
            </div>
          </section>

          {error ? (
            <div
              className="mt-5 flex items-start gap-2 rounded-xl border border-red-400/15 bg-red-400/[0.06] px-3 py-2.5 text-sm text-red-300"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          ) : null}
          {success ? (
            <div
              className="mt-5 flex items-center gap-2 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.06] px-3 py-2.5 text-sm text-emerald-300"
              role="status"
            >
              <Check className="h-4 w-4 shrink-0" />
              {success}
            </div>
          ) : null}

          <div className="sticky bottom-4 z-10 mt-6 flex items-center justify-end rounded-2xl border border-white/[0.08] bg-[#0c0d10]/90 p-3 shadow-2xl backdrop-blur-xl">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || (!hasKeyInput && !modesChanged)}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-cyan-400 px-5 text-sm font-medium text-black transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving ? "Saving…" : "Save provider settings"}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
