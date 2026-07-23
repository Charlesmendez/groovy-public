"use client";

/**
 * TransferContextModal — move what one agent learned into another.
 */

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Check, Loader2, X } from "lucide-react";
import type { WorkerAgentInfo } from "@/hooks/useWorkerAgents";

export function TransferContextModal({
  isOpen,
  fromAgent,
  agents,
  onClose,
}: {
  isOpen: boolean;
  fromAgent: WorkerAgentInfo | null;
  agents: WorkerAgentInfo[];
  onClose: () => void;
}) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTargetId(null);
      setInstructions("");
      setBusy(false);
      setDone(false);
      setError(null);
    }
  }, [isOpen]);

  const candidates = agents.filter((a) => a.id !== fromAgent?.id);

  const transfer = useCallback(async () => {
    if (!fromAgent || !targetId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/context-transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAgent: fromAgent.id,
          toAgent: targetId,
          instructions: instructions.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error || "Transfer failed");
        return;
      }
      setDone(true);
      setTimeout(onClose, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transfer failed");
    } finally {
      setBusy(false);
    }
  }, [fromAgent, targetId, instructions, busy, onClose]);

  return (
    <AnimatePresence>
      {isOpen && fromAgent && (
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
            className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/5">
              <div>
                <h2 className="text-base font-semibold text-white">Move context</h2>
                <p className="text-[11px] text-zinc-500 mt-0.5">
                  Summarizes {fromAgent.name}&apos;s work and briefs the target agent.
                </p>
              </div>
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="px-2.5 py-1.5 rounded-lg bg-white/5 text-white flex items-center gap-1.5">
                  {fromAgent.emoji || fromAgent.name.slice(0, 1)} {fromAgent.name}
                </span>
                <ArrowRight className="w-4 h-4 text-zinc-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  {candidates.length === 0 ? (
                    <span className="text-xs text-zinc-500">No other agents yet</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {candidates.map((agent) => (
                        <button
                          key={agent.id}
                          onClick={() => setTargetId(agent.id)}
                          className={`px-2.5 py-1.5 rounded-lg text-xs transition-all ${
                            targetId === agent.id
                              ? "bg-cyan-400/15 text-cyan-200 border border-cyan-400/30"
                              : "bg-white/5 text-zinc-300 border border-transparent hover:bg-white/10"
                          }`}
                        >
                          {agent.emoji || agent.name.slice(0, 1)} {agent.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={2}
                placeholder="Optional handoff instructions…"
                className="w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-xs text-white placeholder-zinc-600 outline-none focus:border-cyan-400/40 resize-none"
              />

              {error && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-300">
                  {error}
                </div>
              )}
            </div>

            <div className="px-5 py-3.5 border-t border-white/5 flex justify-end">
              <button
                onClick={transfer}
                disabled={!targetId || busy || done}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-400 text-black text-sm font-semibold hover:bg-cyan-300 disabled:opacity-40 transition-all"
              >
                {busy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : done ? (
                  <Check className="w-3.5 h-3.5" />
                ) : null}
                {done ? "Transferred" : "Transfer"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
