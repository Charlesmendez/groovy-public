"use client";

/**
 * NewAgentModal — hire a new worker agent.
 * Three decisions, one screen: name, harness, workspace.
 */

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Folder, Loader2, X } from "lucide-react";
import { WORKER_MODEL_PRESETS } from "@/lib/agents/modelPresets";
import { reasoningEffortsForModel } from "@/lib/ai/modelCatalog";

const SUGGESTED_NAMES = ["Builder", "Fixter", "Reviewer", "Scout", "Shipper", "Docsmith"];
const SUGGESTED_EMOJI = ["🛠️", "🦾", "🔍", "🚀", "🧭", "✍️", "🧪", "🎯"];

export function NewAgentModal({
  isOpen,
  onClose,
  onCreate,
  onPickWorkspace,
  claudeCliInstalled,
  codexCliInstalled,
  connectorOnline,
  requiredWorkspaceRoot,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: {
    name: string;
    harness: "claude" | "codex";
    model: string | null;
    reasoningEffort: string | null;
    workspace: { id: string; rootPath: string } | null;
  }) => Promise<boolean>;
  onPickWorkspace: () => Promise<{ id: string; rootPath: string } | null>;
  claudeCliInstalled: boolean | null;
  codexCliInstalled: boolean | null;
  connectorOnline: boolean;
  /** When creating an executor from Plans, keep it on the plan's project. */
  requiredWorkspaceRoot?: string | null;
}) {
  const [name, setName] = useState("");
  const [harness, setHarness] = useState<"claude" | "codex">("claude");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [workspace, setWorkspace] = useState<{ id: string; rootPath: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedCliInstalled =
    harness === "claude" ? claudeCliInstalled === true : codexCliInstalled === true;
  const workspaceMatchesRequirement =
    !requiredWorkspaceRoot ||
    (workspace?.rootPath || "").replace(/\/+$/, "") === requiredWorkspaceRoot.replace(/\/+$/, "");
  const canCreate =
    connectorOnline &&
    !!name.trim() &&
    !!workspace &&
    workspaceMatchesRequirement &&
    selectedCliInstalled &&
    !busy;

  useEffect(() => {
    if (isOpen) {
      setName("");
      setHarness(claudeCliInstalled === false && codexCliInstalled ? "codex" : "claude");
      setModel("");
      setReasoningEffort("");
      setWorkspace(null);
      setError(null);
      setBusy(false);
    }
  }, [isOpen, claudeCliInstalled, codexCliInstalled]);

  const pickWorkspace = useCallback(async () => {
    setPickingWorkspace(true);
    setError(null);
    try {
      const picked = await onPickWorkspace();
      if (picked) setWorkspace(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Workspace pick failed");
    } finally {
      setPickingWorkspace(false);
    }
  }, [onPickWorkspace]);

  const create = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || !canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const supportedEfforts = reasoningEffortsForModel(model, "cli");
      const selectedEffort = supportedEfforts.includes(
        reasoningEffort as (typeof supportedEfforts)[number]
      )
        ? reasoningEffort
        : null;
      const ok = await onCreate({
        name: trimmed,
        harness,
        model: model.trim() || null,
        reasoningEffort: selectedEffort,
        workspace,
      });
      if (ok) {
        onClose();
      } else {
        setError("Could not create the agent. Is your connector online?");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the agent");
    } finally {
      setBusy(false);
    }
  }, [name, harness, model, reasoningEffort, workspace, canCreate, onCreate, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.18 }}
            className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-2xl"
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/5">
              <div>
                <h2 className="text-base font-semibold text-white">New agent</h2>
                <p className="text-[11px] text-zinc-500 mt-0.5">
                  {requiredWorkspaceRoot
                    ? "Create an executor for this plan's project."
                    : "A real coding harness on your machine — yours to direct."}
                </p>
              </div>
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Name</label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && create()}
                  placeholder="e.g. Fixter"
                  className="w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-cyan-400/40 transition-colors"
                />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {SUGGESTED_NAMES.map((suggestion, i) => (
                    <button
                      key={suggestion}
                      onClick={() => setName(suggestion)}
                      className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] text-zinc-400 hover:text-white transition-colors"
                    >
                      {SUGGESTED_EMOJI[i % SUGGESTED_EMOJI.length]} {suggestion}
                    </button>
                  ))}
                </div>
              </div>

              {/* Harness */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Harness</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setHarness("claude")}
                    disabled={claudeCliInstalled !== true}
                    className={`rounded-xl border px-3 py-2.5 text-left transition-all ${
                      harness === "claude"
                        ? "border-orange-400/40 bg-orange-500/10"
                        : "border-white/10 bg-white/[0.02] hover:bg-white/5"
                    } disabled:cursor-not-allowed disabled:opacity-45`}
                  >
                    <div className="text-sm font-medium text-white">Claude Code</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">
                      {claudeCliInstalled === false
                        ? "CLI not detected on this device"
                        : "Anthropic's coding agent"}
                    </div>
                  </button>
                  <button
                    onClick={() => setHarness("codex")}
                    disabled={codexCliInstalled !== true}
                    className={`rounded-xl border px-3 py-2.5 text-left transition-all ${
                      harness === "codex"
                        ? "border-emerald-400/40 bg-emerald-500/10"
                        : "border-white/10 bg-white/[0.02] hover:bg-white/5"
                    } disabled:cursor-not-allowed disabled:opacity-45`}
                  >
                    <div className="text-sm font-medium text-white">Codex</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">
                      {codexCliInstalled === false
                        ? "CLI not detected on this device"
                        : "OpenAI's coding agent"}
                    </div>
                  </button>
                </div>
                {((harness === "claude" && claudeCliInstalled === false) ||
                  (harness === "codex" && codexCliInstalled === false)) && (
                  <p className="text-[11px] text-amber-300/90 mt-1.5">
                    That CLI wasn&apos;t detected on your connector device — the agent will be
                    created but can&apos;t run until it&apos;s installed.
                  </p>
                )}
              </div>

              {/* Default model */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Default model
                </label>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={`${harness === "codex" ? "Codex" : "Claude Code"} default`}
                  className="w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-cyan-400/40 transition-colors"
                />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <button
                    type="button"
                    onClick={() => setModel("")}
                    className={`px-2 py-1 rounded-lg text-[11px] transition-colors ${
                      !model
                        ? "bg-cyan-400/15 text-cyan-200"
                        : "bg-white/5 text-zinc-400 hover:bg-white/10"
                    }`}
                  >
                    Harness default
                  </button>
                  {WORKER_MODEL_PRESETS[harness].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setModel(preset)}
                      className={`px-2 py-1 rounded-lg text-[11px] transition-colors ${
                        model === preset
                          ? "bg-cyan-400/15 text-cyan-200"
                          : "bg-white/5 text-zinc-400 hover:bg-white/10"
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              {reasoningEffortsForModel(model, "cli").length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                    Reasoning effort
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setReasoningEffort("")}
                      className={`px-2 py-1 rounded-lg text-[11px] transition-colors ${
                        !reasoningEffort
                          ? "bg-cyan-400/15 text-cyan-200"
                          : "bg-white/5 text-zinc-400 hover:bg-white/10"
                      }`}
                    >
                      Model default
                    </button>
                    {reasoningEffortsForModel(model, "cli").map((effort) => (
                      <button
                        type="button"
                        key={effort}
                        onClick={() => setReasoningEffort(effort)}
                        className={`px-2 py-1 rounded-lg text-[11px] transition-colors ${
                          reasoningEffort === effort
                            ? "bg-cyan-400/15 text-cyan-200"
                            : "bg-white/5 text-zinc-400 hover:bg-white/10"
                        }`}
                      >
                        {effort === "xhigh"
                          ? "Extra high"
                          : effort.charAt(0).toUpperCase() + effort.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Workspace */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Workspace
                </label>
                <button
                  onClick={pickWorkspace}
                  disabled={!connectorOnline || pickingWorkspace}
                  className="w-full flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-left hover:border-white/20 transition-colors disabled:opacity-50"
                >
                  {pickingWorkspace ? (
                    <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
                  ) : (
                    <Folder className="w-4 h-4 text-zinc-500" />
                  )}
                  <span className="text-sm text-zinc-300 truncate">
                    {workspace
                      ? workspace.rootPath
                      : connectorOnline
                        ? "Choose a folder on your machine…"
                        : "Connector offline — connect to pick a folder"}
                  </span>
                </button>
                <p className="text-[10px] text-zinc-600 mt-1">
                  {requiredWorkspaceRoot
                    ? `This plan belongs to ${requiredWorkspaceRoot}. Choose that exact folder.`
                    : "Required — this keeps the agent scoped to the project you intend it to work on."}
                </p>
                {workspace && !workspaceMatchesRequirement && (
                  <div className="mt-2 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                    This is a different project. Choose {requiredWorkspaceRoot} so the plan runs
                    against the code it was created for.
                  </div>
                )}
              </div>

              {error && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-300">
                  {error}
                </div>
              )}
            </div>

            <div className="shrink-0 px-5 py-3.5 border-t border-white/5 flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-3.5 py-2 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={create}
                disabled={!canCreate}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-400 text-black text-sm font-semibold hover:bg-cyan-300 disabled:opacity-40 disabled:hover:bg-cyan-400 transition-all"
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Create agent
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
