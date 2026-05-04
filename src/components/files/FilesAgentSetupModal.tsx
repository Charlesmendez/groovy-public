"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, FileText, Trash2, Loader2 } from "lucide-react";

export type FilesAgentInfo = { id: string; name: string; createdAt?: string };

export function FilesAgentSetupModal({
  isOpen,
  onClose,
  filesAgents,
  onRefreshAgents,
  onCreated,
  onDeleted,
}: {
  isOpen: boolean;
  onClose: () => void;
  filesAgents: FilesAgentInfo[];
  onRefreshAgents: () => Promise<void>;
  onCreated: (createdAgentId: string) => void;
  onDeleted: (deletedAgentId: string) => void;
}) {
  const [name, setName] = useState("Files Agent");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName("Files Agent");
    setCreating(false);
    setDeletingId(null);
    setError(null);
  }, [isOpen]);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "files-agent", name: name.trim() || "Files Agent" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to create Files Agent");

      const created = json.agent as { id: string } | undefined;
      if (created?.id) onCreated(created.id);
      await onRefreshAgents();
      setName("Files Agent");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create Files Agent");
    } finally {
      setCreating(false);
    }
  };

  const del = async (id: string) => {
    if (!confirm("Delete this Files Agent? This cannot be undone.")) return;
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/agents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to delete agent");
      onDeleted(id);
      await onRefreshAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete agent");
    } finally {
      setDeletingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
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
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <FileText className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Files Agent</h2>
                <p className="text-xs text-zinc-500">Analyze PDFs, Excel, Word, PowerPoint.</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-5 space-y-4 max-h-[65vh] overflow-y-auto">
            {filesAgents.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider">
                  Your Files Agents ({filesAgents.length})
                </p>
                {filesAgents.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/10"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-white font-medium truncate">{a.name}</div>
                      <div className="text-[10px] text-zinc-600 font-mono truncate">{a.id}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => del(a.id)}
                      disabled={deletingId === a.id}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 hover:bg-red-500/15 transition-colors text-xs disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {deletingId === a.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="p-4 rounded-2xl bg-black/30 border border-white/10">
              <p className="text-xs text-zinc-300 mb-2">Create a Files Agent</p>
              <div className="flex gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Files Agent"
                  className="flex-1 px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-amber-500/40 transition-colors text-sm"
                />
                <button
                  type="button"
                  onClick={create}
                  disabled={creating}
                  className="px-4 py-2.5 rounded-xl bg-amber-500/15 border border-amber-500/20 text-amber-200 hover:bg-amber-500/20 transition-colors text-sm disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
                >
                  {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create
                </button>
              </div>
              <p className="text-[10px] text-zinc-500 mt-2">
                Tip: if you use “Use my API keys”, you’ll need an Anthropic key to run Files.
              </p>
            </div>

            {error && (
              <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl p-3">
                {error}
              </div>
            )}
          </div>

          <div className="p-5 border-t border-white/10 flex items-center justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors text-sm"
            >
              Done
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

