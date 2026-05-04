"use client";

import { useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Globe,
  FolderOpen,
  FileText,
  BookMarked,
  BarChart3,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Brain,
  Send,
  Database,
  Zap,
  MessageCircle,
  Clock,
  Terminal,
  Link2,
} from "lucide-react";
import type { AgentType } from "@/lib/orchestrator/router";

export type ActivitySummary = {
  headline?: string;
  stats?: Record<string, string | number>;
  items?: string[];
  error?: string;
};

export type ActivityMetadata = {
  title: string;
  subtitle?: string;
  provider?: string;
  target?: string;
  query?: string;
  tags?: string[];
};

export type FeedItem = {
  id: string;
  agent: AgentType | "memory" | "system" | "handshake";
  action: string;
  status: "running" | "complete" | "error";
  detail?: string;
  timestamp: Date;
  // Rich data
  metadata?: ActivityMetadata;
  summary?: ActivitySummary;
};

type ActivityFeedProps = {
  items: FeedItem[];
  onItemClick?: (item: FeedItem) => void;
  maxItems?: number;
};

const AGENT_ICONS: Record<AgentType | "memory" | "system" | "handshake", typeof Globe> = {
  browser: Globe,
  files: FolderOpen,
  pages: FileText,
  obsidian: BookMarked,
  data: BarChart3,
  chat: MessageCircle,
  schedule: Clock,
  code: Terminal,
  memory: Brain,
  system: Zap,
  handshake: Link2,
};

const AGENT_COLORS: Record<AgentType | "memory" | "system" | "handshake", string> = {
  browser: "text-cyan-400",
  files: "text-amber-400",
  pages: "text-indigo-400",
  obsidian: "text-violet-400",
  data: "text-emerald-400",
  chat: "text-rose-400",
  schedule: "text-orange-400",
  code: "text-lime-400",
  memory: "text-pink-400",
  system: "text-zinc-400",
  handshake: "text-orange-300",
};

export function ActivityFeed({
  items,
  onItemClick,
  maxItems = 100,
}: ActivityFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [items]);

  const displayItems = items.slice(-maxItems);

  if (displayItems.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-600 text-sm">
        <div className="text-center">
          <BarChart3 className="w-5 h-5 mx-auto mb-2 text-zinc-700" />
          <p>No activity yet</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={feedRef}
      className="h-full overflow-y-auto px-2 py-1 space-y-0.5 font-mono text-xs"
    >
      <AnimatePresence initial={false}>
        {displayItems.map((item) => {
          // Determine icon based on action
          const iconType = item.action.toLowerCase().includes("memory") ? "memory"
            : item.action.toLowerCase().includes("message") ? "system"
            : item.agent;
          
          const Icon = AGENT_ICONS[iconType] || BarChart3;
          const color = AGENT_COLORS[iconType] || AGENT_COLORS.data;

          return (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              onClick={() => onItemClick?.(item)}
              className={`flex items-start gap-2 py-1.5 px-2 rounded hover:bg-white/5 transition-colors ${
                onItemClick ? "cursor-pointer" : ""
              }`}
            >
              {/* Timestamp */}
              <span className="text-zinc-600 shrink-0 w-14">
                {formatTime(item.timestamp)}
              </span>
              
              {/* Status icon */}
              <div className="shrink-0 w-4 flex justify-center pt-0.5">
                {item.status === "running" ? (
                  <Loader2 className="w-3 h-3 text-cyan-400 animate-spin" />
                ) : item.status === "error" ? (
                  <AlertCircle className="w-3 h-3 text-red-400" />
                ) : (
                  <CheckCircle2 className="w-3 h-3 text-emerald-500/70" />
                )}
              </div>
              
              {/* Agent icon */}
              <Icon className={`w-3.5 h-3.5 ${color} shrink-0 mt-0.5`} />
              
              {/* Content */}
              <div className="flex-1 min-w-0">
                <span className={`${color}`}>
                  {item.action}
                </span>
                {item.detail && (
                  <span className="text-zinc-500 ml-1.5">
                    {item.detail}
                  </span>
                )}
                
                {/* Summary stats inline */}
                {item.summary?.stats && Object.keys(item.summary.stats).length > 0 && (
                  <span className="text-zinc-600 ml-2">
                    [{Object.entries(item.summary.stats)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(", ")}]
                  </span>
                )}
                
                {/* Summary headline if no detail */}
                {!item.detail && item.summary?.headline && (
                  <span className="text-zinc-500 ml-1.5">
                    {item.summary.headline.slice(0, 60)}
                    {item.summary.headline.length > 60 ? "..." : ""}
                  </span>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
