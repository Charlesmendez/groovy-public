"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Globe,
  FolderOpen,
  FileText,
  BookMarked,
  BarChart3,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Brain,
  Zap,
  MessageCircle,
  Clock,
  Terminal,
  GitBranch,
} from "lucide-react";
import type { AgentType } from "@/lib/orchestrator/router";

type CompactActivityAgent = AgentType | "memory" | "system" | "handshake";

type ActivityItem = {
  id: string;
  agent: CompactActivityAgent;
  agentName?: string;
  action: string;
  detail?: string;
  status: "running" | "complete" | "error" | "pending";
  timestamp: Date;
};

type CompactActivityStripProps = {
  activities: ActivityItem[];
  onExpand?: () => void;
  isExpanded?: boolean;
};

// Match ActivityFeed icons exactly
const AGENT_ICONS: Record<CompactActivityAgent, typeof Globe> = {
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
  handshake: GitBranch,
};

// Match ActivityFeed colors exactly
const AGENT_COLORS: Record<CompactActivityAgent, string> = {
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
  handshake: "text-teal-300",
};

export function CompactActivityStrip({
  activities,
  onExpand,
  isExpanded = false,
}: CompactActivityStripProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Get last 8 activities
  const recentActivities = activities.slice(-8).reverse();
  const skillActivities = activities.filter((a) =>
    /^Using skill\s+/i.test(String(a.action || ""))
  );
  const runningSkillNames = Array.from(
    new Set(
      skillActivities
        .filter((a) => a.status === "running")
        .map((a) => String(a.action || "").replace(/^Using skill\s+/i, "").trim())
        .filter((name) => name.length > 0)
    )
  );
  const branchForkActivities = activities.filter((a) => a.action === "Branch forked");
  const latestBranchFork =
    branchForkActivities.length > 0 ? branchForkActivities[branchForkActivities.length - 1] : null;
  
  // Count by status
  const runningCount = activities.filter((a) => a.status === "running").length;
  const completeCount = activities.filter((a) => a.status === "complete").length;
  const errorCount = activities.filter((a) => a.status === "error").length;

  return (
    <motion.div
      className="h-full flex flex-col bg-zinc-950/80 backdrop-blur-sm border-l border-white/5"
      initial={false}
      animate={{ width: isExpanded ? 280 : 56 }}
      transition={{ type: "spring", stiffness: 400, damping: 35 }}
    >
      {/* Header */}
      <div className="p-2 border-b border-white/5 flex items-center justify-center">
        <button
          onClick={onExpand}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/5 transition-all"
        >
          {isExpanded ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <ChevronLeft className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Status summary (always visible) */}
      <div className={`p-2 border-b border-white/5 ${isExpanded ? "flex items-center gap-3 px-4" : "flex flex-col items-center gap-2"}`}>
        {runningCount > 0 && (
          <div className="flex items-center gap-1">
            <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
            {isExpanded && <span className="text-xs text-cyan-400">{runningCount}</span>}
          </div>
        )}
        <div className="flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          {isExpanded && <span className="text-xs text-zinc-400">{completeCount}</span>}
        </div>
        {errorCount > 0 && (
          <div className="flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5 text-red-400" />
            {isExpanded && <span className="text-xs text-red-400">{errorCount}</span>}
          </div>
        )}
      </div>

      {/* Skill/branch telemetry (expanded) */}
      {isExpanded && (skillActivities.length > 0 || branchForkActivities.length > 0) && (
        <div className="px-3 py-2 border-b border-white/5 bg-zinc-950/40">
          <p className="text-[10px] text-zinc-300 truncate">
            {runningSkillNames.length > 0
              ? `Skill running: ${runningSkillNames.join(", ")}`
              : skillActivities.length > 0
                ? `Skills used: ${skillActivities.length}`
                : "Skills used: none yet"}
          </p>
          <p className="text-[10px] text-zinc-500 truncate mt-0.5">
            {branchForkActivities.length > 0
              ? `Branch forks: ${branchForkActivities.length}${
                  latestBranchFork?.detail ? ` | ${latestBranchFork.detail}` : ""
                }`
              : "Branch forks: none yet"}
          </p>
        </div>
      )}

      {/* Activity icons */}
      <div className="flex-1 overflow-y-auto scrollbar-hide py-2">
        <div className={`flex ${isExpanded ? "flex-col gap-1 px-2" : "flex-col items-center gap-2"}`}>
          {recentActivities.map((activity) => {
            // Determine icon based on action (matching ActivityFeed logic)
            const iconType = activity.action.toLowerCase().includes("memory") ? "memory"
              : activity.action.toLowerCase().includes("message") ? "system"
              : activity.agent;
            
            const AgentIcon = AGENT_ICONS[iconType] || BarChart3;
            const iconColor = AGENT_COLORS[iconType] || AGENT_COLORS.data;
            const isHovered = hoveredId === activity.id;
            const isRunning = activity.status === "running";

            return (
              <motion.div
                key={activity.id}
                className="relative"
                onMouseEnter={() => setHoveredId(activity.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                {isExpanded ? (
                  // Expanded view - mini activity card
                  <div
                    className={`
                      flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all
                      ${isRunning ? "bg-white/5" : "hover:bg-white/5"}
                    `}
                  >
                    <div className="relative">
                      <AgentIcon className={`w-4 h-4 ${iconColor}`} />
                      {isRunning && (
                        <motion.div
                          className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-cyan-400"
                          animate={{ scale: [1, 1.3, 1] }}
                          transition={{ repeat: Infinity, duration: 1 }}
                        />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs truncate ${iconColor}`}>{activity.action}</p>
                      {activity.detail && (
                        <p className="text-[10px] text-zinc-500 truncate">{activity.detail}</p>
                      )}
                    </div>
                    <div className={`w-1.5 h-1.5 rounded-full ${
                      activity.status === "running" ? "bg-cyan-400" :
                      activity.status === "complete" ? "bg-emerald-400" :
                      activity.status === "error" ? "bg-red-400" : "bg-zinc-600"
                    }`} />
                  </div>
                ) : (
                  // Compact view - just icon (always colored like ActivityFeed)
                  <div className="relative p-1.5 rounded-lg hover:bg-white/5 transition-all cursor-pointer">
                    <AgentIcon className={`w-5 h-5 ${iconColor}`} />
                    {isRunning && (
                      <motion.div
                        className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-cyan-400"
                        animate={{ scale: [1, 1.3, 1] }}
                        transition={{ repeat: Infinity, duration: 1 }}
                      />
                    )}
                    {activity.status === "complete" && (
                      <div className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-emerald-400" />
                    )}
                    {activity.status === "error" && (
                      <div className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-red-400" />
                    )}

                    {/* Tooltip on hover */}
                    <AnimatePresence>
                      {isHovered && (
                        <motion.div
                          initial={{ opacity: 0, x: 10 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 10 }}
                          className="absolute right-full top-1/2 -translate-y-1/2 mr-2 z-50"
                        >
                          <div className="bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 shadow-xl min-w-[160px]">
                            <div className="flex items-center gap-1.5">
                              <AgentIcon className={`w-3 h-3 ${iconColor}`} />
                              <p className={`text-xs font-medium ${iconColor}`}>{activity.action}</p>
                            </div>
                            {activity.detail && (
                              <p className="text-[10px] text-zinc-400 mt-0.5 truncate max-w-[200px]">
                                {activity.detail}
                              </p>
                            )}
                            <p className="text-[10px] text-zinc-600 mt-1">
                              {activity.timestamp.toLocaleTimeString()}
                            </p>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Timestamp footer */}
      {isExpanded && recentActivities.length > 0 && (
        <div className="p-2 border-t border-white/5">
          <p className="text-[10px] text-zinc-600 text-center">
            Last: {recentActivities[0]?.timestamp.toLocaleTimeString()}
          </p>
        </div>
      )}
    </motion.div>
  );
}
