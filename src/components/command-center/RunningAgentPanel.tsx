"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Globe,
  FolderOpen,
  BookMarked,
  BarChart3,
  Loader2,
  FileText,
  Flame,
  Server,
  Database,
  ChevronDown,
  ChevronUp,
  Minimize2,
  MessageCircle,
  Clock,
  Terminal,
} from "lucide-react";
import type { AgentType } from "@/lib/orchestrator/router";
import type { RunningContext } from "./AgentTile";
import type { AgentStatus } from "./AgentTile";

type RunningAgentPanelProps = {
  runningAgents: Array<{
    agent: AgentType;
    status: AgentStatus;
    runningContext?: RunningContext;
  }>;
  layout?: "side" | "top"; // side = left column, top = above chat
  onMinimize?: () => void;
};

const AGENT_CONFIG: Record<AgentType, {
  name: string;
  icon: typeof Globe;
  color: string;
  bgColor: string;
  borderColor: string;
  glowColor: string;
}> = {
  browser: {
    name: "Browser",
    icon: Globe,
    color: "text-cyan-400",
    bgColor: "bg-cyan-500/10",
    borderColor: "border-cyan-500/30",
    glowColor: "rgba(34,211,238,0.5)",
  },
  files: {
    name: "Files",
    icon: FolderOpen,
    color: "text-amber-400",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/30",
    glowColor: "rgba(251,191,36,0.5)",
  },
  pages: {
    name: "Pages",
    icon: FileText,
    color: "text-indigo-400",
    bgColor: "bg-indigo-500/10",
    borderColor: "border-indigo-500/30",
    glowColor: "rgba(129,140,248,0.5)",
  },
  obsidian: {
    name: "Obsidian",
    icon: BookMarked,
    color: "text-violet-400",
    bgColor: "bg-violet-500/10",
    borderColor: "border-violet-500/30",
    glowColor: "rgba(167,139,250,0.5)",
  },
  data: {
    name: "Data",
    icon: BarChart3,
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
    borderColor: "border-emerald-500/30",
    glowColor: "rgba(16,185,129,0.5)",
  },
  chat: {
    name: "AI Chat",
    icon: MessageCircle,
    color: "text-rose-400",
    bgColor: "bg-rose-500/10",
    borderColor: "border-rose-500/30",
    glowColor: "rgba(251,113,133,0.5)",
  },
  schedule: {
    name: "Schedule",
    icon: Clock,
    color: "text-blue-400",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/30",
    glowColor: "rgba(59,130,246,0.5)",
  },
  code: {
    name: "Code",
    icon: Terminal,
    color: "text-lime-400",
    bgColor: "bg-lime-500/10",
    borderColor: "border-lime-500/30",
    glowColor: "rgba(163,230,53,0.5)",
  },
};

const PROVIDER_ICONS: Record<string, { icon: typeof Flame; color: string; bgColor: string; label: string }> = {
  firecrawl: { icon: Flame, color: "text-orange-400", bgColor: "bg-orange-500/20", label: "Firecrawl" },
  postgres: { icon: Server, color: "text-blue-400", bgColor: "bg-blue-500/20", label: "Postgres" },
  web_pixel: { icon: BarChart3, color: "text-pink-400", bgColor: "bg-pink-500/20", label: "Web Pixel" },
  default: { icon: Database, color: "text-emerald-400", bgColor: "bg-emerald-500/20", label: "Data" },
};

// Browser visualization - LIVE screenshot
function BrowserViz({ context, layout }: { context?: RunningContext; layout: "side" | "top" }) {
  const height = layout === "side" ? "h-[280px]" : "h-[200px]";
  // Generate a unique key using length + middle chars (base64 endings are often the same)
  const screenshotKey = context?.screenshot 
    ? `${context.screenshot.length}-${context.screenshot.slice(Math.floor(context.screenshot.length / 2), Math.floor(context.screenshot.length / 2) + 30)}`
    : "no-screenshot";
  
  // Debug log to verify key changes
  if (context?.screenshot) {
    console.log("[BrowserViz] screenshotKey:", screenshotKey.slice(0, 50));
  }
  
  return (
    <div className={`relative rounded-xl overflow-hidden border border-cyan-500/30 bg-zinc-950 ${height}`}>
      {/* Browser Chrome */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <div className="flex gap-1.5">
          <div className="w-2 h-2 rounded-full bg-red-500/80" />
          <div className="w-2 h-2 rounded-full bg-yellow-500/80" />
          <div className="w-2 h-2 rounded-full bg-green-500/80" />
        </div>
        <div className="flex-1 flex items-center gap-2 px-2 py-1 bg-zinc-800 rounded-md text-[10px]">
          <Globe className="w-3 h-3 text-cyan-400 shrink-0" />
          <span className="text-zinc-400 truncate font-mono">
            {context?.pageUrl || context?.target || "https://..."}
          </span>
          <Loader2 className="w-3 h-3 text-cyan-400 animate-spin shrink-0 ml-auto" />
        </div>
      </div>
      
      {/* Screenshot content */}
      <div className="relative flex-1 h-[calc(100%-36px)] bg-zinc-950 overflow-hidden">
        {context?.screenshot ? (
          <>
            <motion.img
              key={screenshotKey} // Force re-render when screenshot changes
              src={`data:${context.screenshotMediaType || "image/png"};base64,${context.screenshot}`}
              alt={context.pageTitle || "Browser"}
              className="w-full h-full object-cover object-top"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
            />
            <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 bg-black/70 backdrop-blur-sm rounded-full">
              <motion.div
                className="w-1.5 h-1.5 rounded-full bg-red-500"
                animate={{ opacity: [1, 0.4, 1] }}
                transition={{ repeat: Infinity, duration: 1 }}
              />
              <span className="text-[9px] text-white font-semibold tracking-wide">LIVE</span>
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <Loader2 className="w-6 h-6 text-cyan-400 animate-spin mx-auto mb-2" />
              <p className="text-[10px] text-zinc-500">Loading screenshot...</p>
            </div>
          </div>
        )}
      </div>
      
      {/* Action bar */}
      <div className="absolute bottom-0 left-0 right-0 px-3 py-1.5 bg-gradient-to-t from-black/80 to-transparent">
        <p className="text-[10px] text-cyan-400 truncate">
          {context?.action || "Browsing..."}
        </p>
      </div>
    </div>
  );
}

// Obsidian constellation visualization
function ObsidianViz({ context, isRunning, layout }: { context?: RunningContext; isRunning: boolean; layout: "side" | "top" }) {
  const results = context?.obsidianResults || [];
  const hasResults = results.length > 0;
  const height = layout === "side" ? "h-[280px]" : "h-[180px]";
  
  // Use percentage-based positioning so SVG and labels align
  const centerX = 50; // percentage
  const centerY = 45; // percentage
  const nodes = results.slice(0, 8).map((note, i) => {
    const angle = (i / Math.min(results.length, 8)) * 2 * Math.PI - Math.PI / 2;
    const radius = i === 0 ? 0 : 18 + (i % 3) * 5; // percentage radius
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      name: note.name,
      size: i === 0 ? 10 : Math.max(5, 8 - i),
    };
  });

  return (
    <div className={`relative rounded-xl overflow-hidden border border-violet-500/30 bg-zinc-950 ${height}`}>
      <div className="absolute inset-0 bg-gradient-to-br from-zinc-950 via-violet-950/20 to-zinc-950" />
      
      {/* Stars */}
      {[...Array(10)].map((_, i) => (
        <motion.div
          key={i}
          className="absolute w-0.5 h-0.5 bg-white/20 rounded-full"
          style={{ left: `${10 + (i * 9) % 80}%`, top: `${5 + (i * 11) % 90}%` }}
          animate={{ opacity: [0.1, 0.4, 0.1] }}
          transition={{ repeat: Infinity, duration: 2 + (i % 3), delay: i * 0.2 }}
        />
      ))}
      
      {/* Constellation - SVG with percentage viewBox for proper scaling */}
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
        {/* Lines connecting to center node */}
        {hasResults && nodes.length > 1 && nodes.slice(1).map((node, i) => (
          <motion.line
            key={`line-${i}`}
            x1={nodes[0].x}
            y1={nodes[0].y}
            x2={node.x}
            y2={node.y}
            stroke="rgba(167,139,250,0.6)"
            strokeWidth={0.3}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1, opacity: isRunning ? [0.3, 0.8, 0.3] : 0.6 }}
            transition={{ pathLength: { duration: 0.4, delay: i * 0.05 }, opacity: isRunning ? { repeat: Infinity, duration: 1.5 } : {} }}
          />
        ))}
        
        {/* Nodes as SVG circles */}
        {hasResults ? nodes.map((node, i) => (
          <motion.g key={`node-${i}`}>
            <motion.circle
              cx={node.x}
              cy={node.y}
              r={i === 0 ? 3 : 2}
              fill={i === 0 ? "#a78bfa" : "rgba(167,139,250,0.7)"}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: i * 0.05, type: "spring" }}
            />
            {/* Glow for center node */}
            {i === 0 && (
              <motion.circle
                cx={node.x}
                cy={node.y}
                r={5}
                fill="none"
                stroke="rgba(167,139,250,0.3)"
                strokeWidth={0.5}
                animate={{ r: [5, 7, 5], opacity: [0.3, 0.1, 0.3] }}
                transition={{ repeat: Infinity, duration: 2 }}
              />
            )}
          </motion.g>
        )) : (
          <motion.circle
            cx={50}
            cy={50}
            r={3}
            fill="#a78bfa"
            animate={{ scale: [1, 1.3, 1] }}
            transition={{ repeat: Infinity, duration: 1.5 }}
          />
        )}
      </svg>
      
      {/* Node labels (positioned with CSS percentages to match SVG) */}
      {hasResults && nodes.map((node, i) => (
        <motion.div
          key={`label-${i}`}
          className="absolute text-center pointer-events-none"
          style={{ 
            left: `${node.x}%`, 
            top: `${node.y + (i === 0 ? 5 : 4)}%`,
            transform: "translateX(-50%)"
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: i * 0.05 + 0.2 }}
        >
          <span className="text-[8px] text-violet-300/80 max-w-[60px] truncate block">
            {node.name}
          </span>
        </motion.div>
      ))}
      
      {/* Status */}
      <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 bg-black/60 rounded-full">
        {isRunning ? (
          <>
            <motion.div className="w-1.5 h-1.5 rounded-full bg-violet-400" animate={{ opacity: [1, 0.4, 1] }} transition={{ repeat: Infinity, duration: 1 }} />
            <span className="text-[9px] text-violet-300">Searching</span>
          </>
        ) : (
          <>
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-[9px] text-zinc-400">{results.length} notes</span>
          </>
        )}
      </div>
    </div>
  );
}

// Files visualization
function FilesViz({ context, layout }: { context?: RunningContext; layout: "side" | "top" }) {
  const height = layout === "side" ? "h-[160px]" : "h-[120px]";
  
  return (
    <div className={`relative rounded-xl overflow-hidden border border-amber-500/30 bg-zinc-950 ${height}`}>
      <div className="absolute inset-0 bg-amber-500/5" />
      <motion.div
        className="absolute inset-0"
        style={{ background: "radial-gradient(circle at center, rgba(251,191,36,0.15) 0%, transparent 70%)" }}
        animate={{ opacity: [0.3, 0.6, 0.3] }}
        transition={{ repeat: Infinity, duration: 2 }}
      />
      
      <div className="relative h-full p-4 flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-amber-500/20 flex items-center justify-center relative">
          <FolderOpen className="w-6 h-6 text-amber-400" />
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              className="absolute"
              animate={{ x: [0, 12, 24], y: [0, -8 - i * 4, -16 - i * 6], opacity: [0, 1, 0], scale: [0.5, 0.7, 0.5] }}
              transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.25 }}
            >
              <FileText className="w-2.5 h-2.5 text-amber-400" />
            </motion.div>
          ))}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-400">Processing</p>
          <p className="text-xs text-zinc-400 truncate">{context?.action || "Working..."}</p>
          {context?.target && <p className="text-[10px] text-zinc-500 truncate font-mono mt-1">{context.target}</p>}
        </div>
        <Loader2 className="w-5 h-5 text-amber-400 animate-spin shrink-0" />
      </div>
    </div>
  );
}

function PagesViz({ context, isRunning, layout }: { context?: RunningContext; isRunning: boolean; layout: "side" | "top" }) {
  const height = layout === "side" ? "h-[160px]" : "h-[120px]";
  return (
    <div className={`relative rounded-xl overflow-hidden border border-indigo-500/30 bg-zinc-950 ${height}`}>
      <div className="absolute inset-0 bg-indigo-500/5" />
      <motion.div
        className="absolute inset-0"
        style={{ background: "radial-gradient(circle at center, rgba(99,102,241,0.18) 0%, transparent 70%)" }}
        animate={{ opacity: [0.25, 0.5, 0.25] }}
        transition={{ repeat: Infinity, duration: 2 }}
      />

      <div className="relative h-full p-4 flex items-center gap-4">
        <motion.div
          className="w-12 h-12 rounded-xl bg-indigo-500/20 flex items-center justify-center"
          animate={isRunning ? { scale: [1, 1.06, 1] } : {}}
          transition={{ repeat: Infinity, duration: 1.8 }}
        >
          <FileText className="w-6 h-6 text-indigo-400" />
        </motion.div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-indigo-300">
            {isRunning ? "Building site..." : "Pages"}
          </p>
          <p className="text-xs text-zinc-400 truncate">{context?.action || context?.target || "Site builder"}</p>
        </div>
        {isRunning && <Loader2 className="w-5 h-5 text-indigo-400 animate-spin shrink-0" />}
      </div>
    </div>
  );
}

// AI Chat visualization
function ChatViz({ context, isRunning, layout }: { context?: RunningContext; isRunning: boolean; layout: "side" | "top" }) {
  const height = layout === "side" ? "h-[160px]" : "h-[120px]";

  return (
    <div className={`relative rounded-xl overflow-hidden border border-rose-500/30 bg-zinc-950 ${height}`}>
      <div className="absolute inset-0 bg-rose-500/10 opacity-20" />
      <motion.div
        className="absolute inset-0"
        style={{ background: "radial-gradient(circle at center, rgba(251,113,133,0.2) 0%, transparent 70%)" }}
        animate={isRunning ? { opacity: [0.2, 0.4, 0.2], scale: [1, 1.05, 1] } : {}}
        transition={{ repeat: Infinity, duration: 2 }}
      />

      <div className="relative h-full p-4 flex items-center gap-4">
        <motion.div
          className="w-12 h-12 rounded-xl bg-rose-500/20 flex items-center justify-center"
          animate={isRunning ? { scale: [1, 1.05, 1] } : {}}
          transition={{ repeat: Infinity, duration: 2 }}
        >
          <MessageCircle className="w-6 h-6 text-rose-400" />
        </motion.div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-rose-400">
            {isRunning ? "Processing..." : "Complete"}
          </p>
          <p className="text-xs text-zinc-400 truncate">{context?.action || context?.target || "AI Chat"}</p>
          {context?.provider && (
            <p className="text-[10px] text-zinc-500 truncate font-mono mt-1">{context.provider}</p>
          )}
        </div>
        {isRunning && <Loader2 className="w-5 h-5 text-rose-400 animate-spin shrink-0" />}
      </div>
    </div>
  );
}

// Data visualization  
function DataViz({ context, layout }: { context?: RunningContext; layout: "side" | "top" }) {
  const height = layout === "side" ? "h-[160px]" : "h-[120px]";
  const providerInfo = context?.provider 
    ? PROVIDER_ICONS[context.provider.toLowerCase()] || PROVIDER_ICONS.default
    : PROVIDER_ICONS.default;
  const ProviderIcon = providerInfo.icon;

  return (
    <div className={`relative rounded-xl overflow-hidden border border-emerald-500/30 bg-zinc-950 ${height}`}>
      <div className={`absolute inset-0 ${providerInfo.bgColor} opacity-20`} />
      <motion.div
        className="absolute inset-0"
        style={{ background: "radial-gradient(circle at center, rgba(16,185,129,0.2) 0%, transparent 70%)" }}
        animate={{ opacity: [0.2, 0.4, 0.2], scale: [1, 1.05, 1] }}
        transition={{ repeat: Infinity, duration: 2 }}
      />
      
      <div className="relative h-full p-4 flex items-center gap-4">
        <motion.div
          className={`w-12 h-12 rounded-xl ${providerInfo.bgColor} flex items-center justify-center`}
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ repeat: Infinity, duration: 2 }}
        >
          <ProviderIcon className={`w-6 h-6 ${providerInfo.color}`} />
        </motion.div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium ${providerInfo.color}`}>{providerInfo.label}</p>
          <p className="text-xs text-zinc-400 truncate">{context?.action || "Querying..."}</p>
          {context?.target && <p className="text-[10px] text-zinc-500 truncate font-mono mt-1">{context.target}</p>}
        </div>
        <div className="flex flex-col gap-1">
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              className={`w-1.5 h-3 rounded-full ${providerInfo.bgColor}`}
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ repeat: Infinity, duration: 0.8, delay: i * 0.2 }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function CodeViz({ context, isRunning, layout }: { context?: RunningContext; isRunning: boolean; layout: "side" | "top" }) {
  const height = layout === "side" ? "h-[180px]" : "h-[140px]";
  return (
    <div className={`relative rounded-xl overflow-hidden border border-lime-500/30 bg-zinc-950 ${height}`}>
      <div className="absolute inset-0 bg-gradient-to-br from-zinc-950 via-lime-950/10 to-zinc-950" />

      {/* Header */}
      <div className="relative z-10 flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-black/30">
        <Terminal className="w-4 h-4 text-lime-400" />
        <span className="text-xs font-medium text-lime-300">Claude Code</span>
        {isRunning && <Loader2 className="w-3.5 h-3.5 text-lime-400 animate-spin ml-auto" />}
      </div>

      {/* Body */}
      <div className="relative z-10 p-3">
        <p className="text-xs text-zinc-200 truncate">
          {context?.action || (isRunning ? "Running code task…" : "Code task")}
        </p>
        {context?.target && (
          <p className="mt-2 text-[10px] text-zinc-400 font-mono whitespace-pre-wrap break-words line-clamp-4">
            {context.target}
          </p>
        )}
        {!context?.target && (
          <p className="mt-2 text-[10px] text-zinc-500">
            {isRunning ? "Working locally via the Groovy Connector…" : "No details available."}
          </p>
        )}
      </div>
    </div>
  );
}

function ScheduleViz({ context, isRunning, layout }: { context?: RunningContext; isRunning: boolean; layout: "side" | "top" }) {
  const height = layout === "side" ? "h-[140px]" : "h-[110px]";
  return (
    <div className={`relative rounded-xl overflow-hidden border border-blue-500/30 bg-zinc-950 ${height}`}>
      <div className="absolute inset-0 bg-gradient-to-br from-zinc-950 via-blue-950/10 to-zinc-950" />

      <div className="relative z-10 flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-black/30">
        <Clock className="w-4 h-4 text-blue-400" />
        <span className="text-xs font-medium text-blue-200">Schedule</span>
        {isRunning && <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin ml-auto" />}
      </div>

      <div className="relative z-10 p-3">
        <p className="text-xs text-zinc-200 truncate">
          {context?.action || (isRunning ? "Updating schedule…" : "Schedule")}
        </p>
        {context?.target && (
          <p className="mt-2 text-[10px] text-zinc-400 font-mono truncate">{context.target}</p>
        )}
      </div>
    </div>
  );
}

export function RunningAgentPanel({ runningAgents, layout = "side", onMinimize }: RunningAgentPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  // Show agents that are running OR have running context (recently completed with results)
  // Show agents that are running OR have context (from current session)
  // runningContexts is already filtered to current session only, so this is safe
  const activeAgents = runningAgents.filter(a => 
    a.status === "running" || (a.runningContext && Object.keys(a.runningContext).length > 0)
  );
  
  if (activeAgents.length === 0) return null;

  // For mobile/top layout, show collapsible
  if (layout === "top") {
    return (
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: isCollapsed ? 48 : "auto" }}
        exit={{ opacity: 0, height: 0 }}
        className="shrink-0 overflow-hidden"
      >
        {/* Collapse header */}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="w-full flex items-center justify-between px-4 py-3 bg-zinc-900/60 border border-white/5 rounded-t-xl"
        >
          <div className="flex items-center gap-2">
            {activeAgents.map(({ agent }) => {
              const config = AGENT_CONFIG[agent];
              const Icon = config.icon;
              return (
                <div key={agent} className={`w-6 h-6 rounded-lg ${config.bgColor} flex items-center justify-center`}>
                  <Icon className={`w-3.5 h-3.5 ${config.color}`} />
                </div>
              );
            })}
            <span className="text-xs text-zinc-400">{activeAgents.length} agent{activeAgents.length > 1 ? "s" : ""} running</span>
          </div>
          {isCollapsed ? <ChevronDown className="w-4 h-4 text-zinc-500" /> : <ChevronUp className="w-4 h-4 text-zinc-500" />}
        </button>

        {/* Content */}
        {!isCollapsed && (
          <div className="p-3 bg-zinc-900/40 border-x border-b border-white/5 rounded-b-xl">
            <div className="grid grid-cols-1 gap-3">
              {activeAgents.map(({ agent, status, runningContext }) => (
                <div key={agent}>
                  {agent === "browser" && <BrowserViz context={runningContext} layout="top" />}
                  {agent === "obsidian" && <ObsidianViz context={runningContext} isRunning={status === "running"} layout="top" />}
                  {agent === "files" && <FilesViz context={runningContext} layout="top" />}
                  {agent === "pages" && <PagesViz context={runningContext} isRunning={status === "running"} layout="top" />}
                  {agent === "data" && <DataViz context={runningContext} layout="top" />}
                  {agent === "chat" && <ChatViz context={runningContext} isRunning={status === "running"} layout="top" />}
                  {agent === "code" && <CodeViz context={runningContext} isRunning={status === "running"} layout="top" />}
                  {agent === "schedule" && <ScheduleViz context={runningContext} isRunning={status === "running"} layout="top" />}
                </div>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    );
  }

  // Side layout (desktop)
  return (
    <motion.div
      initial={{ opacity: 0, width: 0 }}
      animate={{ opacity: 1, width: "auto" }}
      exit={{ opacity: 0, width: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="h-full flex flex-col bg-zinc-900/40 border border-white/5 rounded-2xl overflow-hidden min-w-[280px] max-w-[320px]"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {activeAgents.map(({ agent }) => {
            const config = AGENT_CONFIG[agent];
            const Icon = config.icon;
            return (
              <motion.div
                key={agent}
                className={`w-7 h-7 rounded-lg ${config.bgColor} flex items-center justify-center`}
                animate={{ scale: [1, 1.1, 1] }}
                transition={{ repeat: Infinity, duration: 2 }}
              >
                <Icon className={`w-4 h-4 ${config.color}`} />
              </motion.div>
            );
          })}
        </div>
        {onMinimize && (
          <button
            onClick={onMinimize}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/5 transition-all"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Visualizations */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {activeAgents.map(({ agent, status, runningContext }) => (
          <div key={agent}>
            {agent === "browser" && <BrowserViz context={runningContext} layout="side" />}
            {agent === "obsidian" && <ObsidianViz context={runningContext} isRunning={status === "running"} layout="side" />}
            {agent === "files" && <FilesViz context={runningContext} layout="side" />}
            {agent === "pages" && <PagesViz context={runningContext} isRunning={status === "running"} layout="side" />}
            {agent === "data" && <DataViz context={runningContext} layout="side" />}
            {agent === "chat" && <ChatViz context={runningContext} isRunning={status === "running"} layout="side" />}
            {agent === "code" && <CodeViz context={runningContext} isRunning={status === "running"} layout="side" />}
            {agent === "schedule" && <ScheduleViz context={runningContext} isRunning={status === "running"} layout="side" />}
          </div>
        ))}
      </div>
    </motion.div>
  );
}
