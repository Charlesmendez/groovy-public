"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Plus, MessageSquare, Check, Loader2 } from "lucide-react";

export type ChatSession = {
  id: string;
  title: string | null;
  created_at?: string;
  updated_at?: string;
};

function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SessionPicker({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onDelete,
  deletingId,
}: {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onDelete?: (sessionId: string) => void;
  deletingId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const uniqueSessions = useMemo(() => {
    const seen = new Set<string>();
    return sessions.filter((session) => {
      const id = typeof session?.id === "string" ? session.id.trim() : "";
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [sessions]);

  const activeSession = uniqueSessions.find((s) => s.id === activeSessionId);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    if (open) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [open]);

  return (
    <div className="flex items-center gap-2" ref={containerRef}>
      <div className="relative">
        <button
          onClick={() => setOpen(!open)}
          className={`
            flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-all
            bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20
            ${open ? "bg-white/10 border-cyan-500/30" : ""}
          `}
        >
          <MessageSquare className="w-4 h-4 text-zinc-400" />
          <span className="text-white max-w-[120px] truncate">
            {activeSession?.title || (uniqueSessions.length > 0 ? "Select chat" : "New chat")}
          </span>
          <ChevronDown
            className={`w-4 h-4 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.96 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="absolute right-0 top-full mt-2 z-50 min-w-[240px] max-w-[320px]"
            >
              <div className="rounded-2xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-2xl shadow-black/50 overflow-hidden">
                {/* Header */}
                <div className="px-3 py-2.5 border-b border-white/5">
                  <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                    Chat Sessions
                  </span>
                </div>

                {/* Sessions list */}
                <div className="max-h-[280px] overflow-auto py-1">
                  {uniqueSessions.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-zinc-500 text-center">
                      No sessions yet
                    </div>
                  ) : (
                    uniqueSessions.map((session) => {
                      const isActive = session.id === activeSessionId;
                      return (
                        <div key={session.id} className="group flex items-stretch">
                          <button
                            onClick={() => {
                              onSelect(session.id);
                              setOpen(false);
                            }}
                            className={`
                              flex-1 flex items-start gap-3 px-3 py-2.5 text-left transition-colors
                              ${isActive
                                ? "bg-cyan-500/10"
                                : "hover:bg-white/5"
                              }
                            `}
                          >
                            <div
                              className={`
                                mt-0.5 w-5 h-5 rounded-lg flex items-center justify-center shrink-0
                                ${isActive
                                  ? "bg-cyan-500/20 text-cyan-400"
                                  : "bg-white/5 text-zinc-500"
                                }
                              `}
                            >
                              {isActive ? (
                                <Check className="w-3 h-3" />
                              ) : (
                                <MessageSquare className="w-3 h-3" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div
                                className={`text-sm truncate ${
                                  isActive ? "text-cyan-300" : "text-white"
                                }`}
                              >
                                {session.title || "Untitled"}
                              </div>
                              <div className="text-xs text-zinc-500 mt-0.5">
                                {formatRelativeTime(session.updated_at || session.created_at)}
                              </div>
                            </div>
                          </button>
                          {!!onDelete && (
                            deletingId === session.id ? (
                              <div className="px-2 flex items-center">
                                <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
                              </div>
                            ) : (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDelete(session.id);
                                }}
                                title="Delete"
                                className="px-2 text-xs text-zinc-500 hover:text-red-300 hidden group-hover:block"
                              >
                                Delete
                              </button>
                            )
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* New chat button */}
                <div className="p-2 border-t border-white/5">
                  <button
                    onClick={async () => {
                      setOpen(false);
                      // Small delay to allow dropdown to close before creating new session
                      setTimeout(() => {
                        onNew();
                      }, 100);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500/20 to-cyan-600/20 text-cyan-300 hover:from-cyan-500/30 hover:to-cyan-600/30 transition-all text-sm font-medium"
                  >
                    <Plus className="w-4 h-4" />
                    New Chat
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
