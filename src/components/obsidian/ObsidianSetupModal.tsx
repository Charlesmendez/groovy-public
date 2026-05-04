"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, RefreshCw } from "lucide-react";

export type ObsidianVault = { name: string; path: string };

export function ObsidianSetupModal({
  isOpen,
  onClose,
  isLocalConnected,
  vaults,
  selectedVault,
  onSelectVault,
  onRefreshVaults,
}: {
  isOpen: boolean;
  onClose: () => void;
  isLocalConnected: boolean;
  vaults: ObsidianVault[];
  selectedVault?: string;
  onSelectVault: (path: string) => void;
  onRefreshVaults?: () => Promise<ObsidianVault[]>;
}) {
  const [manualPath, setManualPath] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setManualPath("");
    setRefreshing(false);
  }, [isOpen]);

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
            <div>
              <h2 className="text-lg font-semibold text-white">Obsidian vault</h2>
              <p className="text-xs text-zinc-500">
                {isLocalConnected ? "Choose your vault path." : "Start the connector to discover vaults automatically."}
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-5 space-y-4 max-h-[65vh] overflow-y-auto">
            {selectedVault ? (
              <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/10">
                <p className="text-xs text-emerald-400 mb-1">Active vault</p>
                <p className="text-[10px] text-zinc-200 font-mono break-all">{selectedVault}</p>
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-white/[0.02] border border-white/10">
                <p className="text-xs text-zinc-400">No vault selected yet.</p>
              </div>
            )}

            <div className="flex items-center justify-between">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Discovered vaults</p>
              <button
                type="button"
                onClick={async () => {
                  if (!onRefreshVaults) return;
                  setRefreshing(true);
                  try {
                    await onRefreshVaults();
                  } finally {
                    setRefreshing(false);
                  }
                }}
                disabled={!onRefreshVaults || refreshing || !isLocalConnected}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 text-xs disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>

            {vaults.length > 0 ? (
              <div className="space-y-2">
                {vaults.map((v) => (
                  <button
                    key={v.path}
                    type="button"
                    onClick={() => onSelectVault(v.path)}
                    className={`w-full text-left p-3 rounded-xl border transition-colors ${
                      selectedVault === v.path
                        ? "bg-violet-500/10 border-violet-500/30"
                        : "bg-white/[0.02] border-white/10 hover:bg-white/[0.04] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm text-white font-medium truncate">{v.name}</div>
                        <div className="text-[10px] text-zinc-500 font-mono break-all">{v.path}</div>
                      </div>
                      {selectedVault === v.path && (
                        <span className="text-[10px] px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/20">
                          Selected
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-black/30 border border-white/10 text-xs text-zinc-400">
                {isLocalConnected
                  ? "No vaults discovered yet. Click Refresh, or paste a vault path manually below."
                  : "Start the connector, then come back here and click Refresh."}
              </div>
            )}

            <div className="pt-2">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">Manual path</p>
              <div className="flex gap-2">
                <input
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  placeholder="/Users/you/Obsidian/MyVault"
                  className="flex-1 px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-violet-500/40 transition-colors text-sm font-mono"
                />
                <button
                  type="button"
                  onClick={() => {
                    const p = manualPath.trim();
                    if (!p) return;
                    onSelectVault(p);
                    setManualPath("");
                  }}
                  disabled={!manualPath.trim()}
                  className="px-4 py-2.5 rounded-xl bg-violet-500/15 border border-violet-500/20 text-violet-200 hover:bg-violet-500/20 transition-colors text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Save
                </button>
              </div>
            </div>
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

