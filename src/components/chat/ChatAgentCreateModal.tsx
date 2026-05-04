"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2 } from "lucide-react";

type Provider = "openai" | "anthropic" | "google";

const PROVIDERS: Array<{ id: Provider; label: string; hint: string; defaultModel: string; models: string[]; color: string }> = [
  {
    id: "openai",
    label: "OpenAI",
    hint: "Best general-purpose + tool use",
    defaultModel: "gpt-4o",
    models: [
      "gpt-5.2",
      "gpt-5",
      "gpt-4.5-turbo",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "o3",
      "o3-mini",
      "o1",
      "o1-mini",
    ],
    color: "emerald",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    hint: "Strong writing + deep reasoning",
    defaultModel: "claude-sonnet-4",
    models: [
      "claude-opus-4.6",
      "claude-opus-4.5",
      "claude-opus-4",
      "claude-sonnet-4",
      "claude-3.5-sonnet",
      "claude-3.5-haiku",
      "claude-3-opus",
      "claude-3-sonnet",
    ],
    color: "orange",
  },
  {
    id: "google",
    label: "Google (Gemini)",
    hint: "Fast + cost-effective",
    defaultModel: "gemini-2.0-flash",
    models: [
      "gemini-3-pro-image-preview",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "gemini-2.0-pro",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ],
    color: "red",
  },
];

export type CreatedChatAgent = {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  sessionId?: string | null;
};

export function ChatAgentCreateModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (agent: CreatedChatAgent) => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<Provider>("openai");
  const [model, setModel] = useState("gpt-4o");
  const [customModel, setCustomModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">("medium");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerInfo = useMemo(() => PROVIDERS.find((p) => p.id === provider)!, [provider]);
  const effectiveModel = (customModel.trim() || model).trim();

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setProvider("openai");
    setModel("gpt-4o");
    setCustomModel("");
    setSystemPrompt("");
    setReasoningEffort("medium");
    setCreating(false);
    setError(null);
  }, [isOpen]);

  const createAgent = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Agent name is required.");
      return;
    }
    if (!effectiveModel) {
      setError("Model is required.");
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "ai-chat",
          name: trimmedName,
          provider,
          model: effectiveModel,
          reasoningEffort,
          systemPrompt: systemPrompt.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to create agent");

      const created = json.agent as {
        id: string;
        name: string;
        provider?: string | null;
        model?: string | null;
      };
      const sessionId = (json.sessionId as string | null) ?? null;

      onCreated({
        id: created.id,
        name: created.name,
        provider: created.provider || undefined,
        model: created.model || undefined,
        sessionId,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create agent");
    } finally {
      setCreating(false);
    }
  };

  if (!isOpen) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-lg bg-zinc-900 border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
        >
          <div className="flex items-center justify-between p-5 border-b border-white/10">
            <div>
              <h2 className="text-lg font-semibold text-white">Create AI Chat agent</h2>
              <p className="text-xs text-zinc-500">Pick a model once. Switch agents anytime.</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-5 space-y-4">
            {/* Guidance */}
            <div className="p-3 rounded-xl bg-rose-500/5 border border-rose-500/10 space-y-2">
              <p className="text-xs text-rose-200/80 leading-relaxed">
                Create agents with different providers according to your needs. <span className="text-white/90">Be descriptive with names</span> so Groovy knows when to use each agent.
              </p>
              <div className="text-[11px] text-zinc-400 space-y-1">
                <p>• For images → <span className="text-zinc-300">Google / gemini-3-pro-image-preview</span> named <span className="italic">&quot;NanoBanana Pro Images&quot;</span></p>
                <p>• For writing → name it <span className="italic">&quot;Writing agent focused on Grammar&quot;</span></p>
                <p>• For code → <span className="text-zinc-300">Anthropic / claude-sonnet-4</span> named <span className="italic">&quot;Code Review Expert&quot;</span></p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-zinc-400">Name <span className="text-zinc-600">(be descriptive!)</span></label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. NanoBanana Pro Images, Code Review Expert..."
                className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-rose-500/40 transition-colors text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="text-xs text-zinc-400">Provider</label>
                <select
                  value={provider}
                  onChange={(e) => {
                    const next = e.target.value as Provider;
                    setProvider(next);
                    const info = PROVIDERS.find((p) => p.id === next)!;
                    setModel(info.defaultModel);
                    setCustomModel("");
                  }}
                  className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-white outline-none focus:border-rose-500/40 transition-colors text-sm"
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-zinc-500">{providerInfo.hint}</p>
              </div>

              <div className="space-y-2">
                <label className="text-xs text-zinc-400">Model</label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-white outline-none focus:border-rose-500/40 transition-colors text-sm"
                >
                  {providerInfo.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-2">
                  <input
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="or custom model id"
                    className="flex-1 px-3 py-2 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-rose-500/40 transition-colors text-xs font-mono"
                  />
                </div>
              </div>
            </div>

            {(provider === "openai" || provider === "anthropic") && (
              <div className="space-y-2">
                <label className="text-xs text-zinc-400">Reasoning effort</label>
                <div className="grid grid-cols-3 gap-2">
                  {(["low", "medium", "high"] as const).map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => setReasoningEffort(lvl)}
                      className={`px-3 py-2 rounded-xl text-xs border transition-colors ${
                        reasoningEffort === lvl
                          ? "bg-white/10 border-white/20 text-white"
                          : "bg-white/5 border-white/10 text-zinc-400 hover:text-zinc-200 hover:border-white/20"
                      }`}
                    >
                      {lvl}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-xs text-zinc-400">System prompt (optional)</label>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                placeholder="e.g. You are my marketing analyst. Be terse, cite numbers."
                rows={4}
                className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-rose-500/40 transition-colors text-sm resize-none"
              />
            </div>

            {error && (
              <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl p-3">
                {error}
              </div>
            )}
          </div>

          <div className="p-5 border-t border-white/10 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={createAgent}
              disabled={creating}
              className="px-4 py-2 rounded-xl bg-rose-500/20 text-rose-200 border border-rose-500/30 hover:bg-rose-500/25 transition-colors text-sm disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {creating && <Loader2 className="w-4 h-4 animate-spin" />}
              Create
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  , document.body);
}

