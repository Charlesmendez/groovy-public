"use client";

import { useState, useCallback } from "react";
import { motion, AnimatePresence, Reorder, useDragControls } from "framer-motion";
import {
  Globe,
  FolderOpen,
  BookMarked,
  BarChart3,
  Terminal,
  Loader2,
  GripVertical,
  ChevronRight,
  MessageCircle,
  Clock,
  FileText,
} from "lucide-react";
import type { AgentType } from "@/lib/orchestrator/router";
import type { DataConnection } from "./DataIntegrationsPanel";
import type { AgentStatus, RunningContext } from "./AgentTile";

type ParticleAgentType = AgentType | "code"; // chat is now included in AgentType

type ParticleConfig = {
  id: ParticleAgentType;
  name: string;
  icon: typeof Globe;
  color: string;
  colorHex: string;
  bgColor: string;
  borderColor: string;
  glowColor: string;
  floatDelay: number;
};

const PARTICLE_CONFIG: Record<ParticleAgentType, ParticleConfig> = {
  browser: {
    id: "browser",
    name: "Browser",
    icon: Globe,
    color: "text-cyan-400",
    colorHex: "#22d3ee",
    bgColor: "bg-cyan-500/15",
    borderColor: "border-cyan-500/30",
    glowColor: "rgba(34,211,238,0.4)",
    floatDelay: 0,
  },
  files: {
    id: "files",
    name: "Files",
    icon: FolderOpen,
    color: "text-amber-400",
    colorHex: "#fbbf24",
    bgColor: "bg-amber-500/15",
    borderColor: "border-amber-500/30",
    glowColor: "rgba(251,191,36,0.4)",
    floatDelay: 0.4,
  },
  pages: {
    id: "pages",
    name: "Pages",
    icon: FileText,
    color: "text-indigo-400",
    colorHex: "#818cf8",
    bgColor: "bg-indigo-500/15",
    borderColor: "border-indigo-500/30",
    glowColor: "rgba(129,140,248,0.4)",
    floatDelay: 0.6,
  },
  obsidian: {
    id: "obsidian",
    name: "Obsidian",
    icon: BookMarked,
    color: "text-violet-400",
    colorHex: "#a78bfa",
    bgColor: "bg-violet-500/15",
    borderColor: "border-violet-500/30",
    glowColor: "rgba(167,139,250,0.4)",
    floatDelay: 0.8,
  },
  data: {
    id: "data",
    name: "Data",
    icon: BarChart3,
    color: "text-emerald-400",
    colorHex: "#34d399",
    bgColor: "bg-emerald-500/15",
    borderColor: "border-emerald-500/30",
    glowColor: "rgba(16,185,129,0.4)",
    floatDelay: 1.2,
  },
  code: {
    id: "code",
    name: "Code",
    icon: Terminal,
    color: "text-sky-400",
    colorHex: "#38bdf8",
    bgColor: "bg-sky-500/15",
    borderColor: "border-sky-500/30",
    glowColor: "rgba(14,165,233,0.4)",
    floatDelay: 1.6,
  },
  chat: {
    id: "chat",
    name: "AI Chat",
    icon: MessageCircle,
    color: "text-rose-400",
    colorHex: "#fb7185",
    bgColor: "bg-rose-500/15",
    borderColor: "border-rose-500/30",
    glowColor: "rgba(251,113,133,0.4)",
    floatDelay: 2.0,
  },
  schedule: {
    id: "schedule",
    name: "Schedule",
    icon: Clock,
    color: "text-blue-400",
    colorHex: "#3b82f6",
    bgColor: "bg-blue-500/15",
    borderColor: "border-blue-500/30",
    glowColor: "rgba(59,130,246,0.4)",
    floatDelay: 1.0,
  },
};

type AgentParticleData = {
  id: ParticleAgentType;
  status: AgentStatus;
  runningContext?: RunningContext;
  dataConnections?: DataConnection[];
  filesAgentConfigured?: boolean;
  obsidianConfigured?: boolean;
  isLocalConnected?: boolean;
  codeSessionCount?: number;
  activeCodeSessionId?: string | null;
  chatConfigured?: boolean;
  chatAgentId?: string | null;
};

type AgentParticlesProps = {
  agents: AgentParticleData[];
  onAgentAction: (agent: ParticleAgentType, action: "open" | "settings" | "configure") => void;
  onReorder?: (newOrder: ParticleAgentType[]) => void;
  className?: string;
};

function hasParticleConfig(id: unknown): id is ParticleAgentType {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(PARTICLE_CONFIG, id);
}

function Particle({
  data,
  config,
  onAction,
  isReordering,
}: {
  data: AgentParticleData;
  config?: ParticleConfig;
  onAction: (action: "open" | "settings" | "configure") => void;
  isReordering: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const dragControls = useDragControls();

  const isRunning = data.status === "running";
  const safeConfig = config ?? PARTICLE_CONFIG.files;
  const Icon = safeConfig.icon;

  const getStatusLabel = () => {
    if (isRunning) return data.runningContext?.action || "Working...";
    if (data.status === "complete") return "Done";
    if (data.status === "error") return "Error";
    if (data.id === "files") return data.filesAgentConfigured ? "Ready" : "Setup";
    if (data.id === "obsidian") {
      if (!data.obsidianConfigured) return "Setup";
      if (!data.isLocalConnected) return "Offline";
      return "Ready";
    }
    if (data.id === "data") {
      const count = data.dataConnections?.length || 0;
      return count > 0 ? `${count}` : "Add";
    }
    if (data.id === "code") {
      const count = data.codeSessionCount || 0;
      return count > 0 ? `${count}` : "New";
    }
    if (data.id === "chat") {
      return data.chatConfigured ? "Ready" : "Setup";
    }
    return "Ready";
  };

  const getPrimaryAction = (): { label: string; action: "open" | "settings" | "configure" } | null => {
    if (data.id === "browser") return null; // Browser has no settings - just works with connector
    if (data.id === "files") {
      return data.filesAgentConfigured 
        ? { label: "Open", action: "open" }
        : { label: "Setup", action: "configure" };
    }
    if (data.id === "pages") return { label: "Settings", action: "settings" };
    if (data.id === "obsidian") return { label: "Settings", action: "configure" };
    if (data.id === "data") return { label: "Manage", action: "open" };
    if (data.id === "code") return { label: "Sessions", action: "open" };
    if (data.id === "chat") {
      return data.chatConfigured
        ? { label: "Open", action: "open" }
        : { label: "Setup", action: "configure" };
    }
    return { label: "Open", action: "open" };
  };

  const action = getPrimaryAction();
  const showIndicator = !isHovered && (
    isRunning || 
    data.status === "complete" || 
    data.status === "error" ||
    (data.id === "files" && !data.filesAgentConfigured) ||
    (data.id === "obsidian" && (!data.obsidianConfigured || !data.isLocalConnected))
  );

  return (
    <Reorder.Item
      value={data.id}
      dragListener={false}
      dragControls={dragControls}
    >
      {/* Floating wrapper */}
      <motion.div
        animate={!isReordering ? {
          y: [0, -4, 0, 3, 0],
        } : { y: 0 }}
        transition={{
          y: {
            duration: 5,
            repeat: Infinity,
            ease: "easeInOut",
            delay: safeConfig.floatDelay,
          },
        }}
      >
        {/* Particle pill */}
        <div
          className={`
            group relative flex items-center h-10 rounded-full cursor-pointer select-none
            border backdrop-blur-sm
            transition-all duration-300 ease-out
            ${isRunning || isHovered
              ? `${safeConfig.borderColor} ${safeConfig.bgColor}`
              : "border-white/[0.08] bg-zinc-900/50 hover:bg-zinc-900/70"
            }
          `}
          style={{
            boxShadow: isRunning
              ? `0 0 20px -4px ${safeConfig.glowColor}`
              : isHovered
              ? `0 4px 20px -4px ${safeConfig.glowColor}`
              : "0 2px 8px -4px rgba(0,0,0,0.5)",
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onPointerDown={(e) => {
            if (isReordering) {
              e.preventDefault();
              dragControls.start(e);
            }
          }}
          onClick={() => {
            if (isReordering || !action) return;
            // Pages keeps primary bubble click as "open" while the hover CTA is "settings".
            if (data.id === "pages") {
              onAction("open");
              return;
            }
            onAction(action.action);
          }}
        >
          {/* Inner content with padding */}
          <div className="flex items-center gap-2 px-3">
            {/* Drag handle */}
            {isReordering && (
              <GripVertical className="w-3.5 h-3.5 text-zinc-500 cursor-grab active:cursor-grabbing" />
            )}

            {/* Icon container */}
            <div className="relative">
              <motion.div
                className={`w-6 h-6 rounded-lg ${safeConfig.bgColor} flex items-center justify-center`}
                animate={isRunning ? { rotate: [0, 5, -5, 0] } : { rotate: 0 }}
                transition={isRunning ? { duration: 2, repeat: Infinity, ease: "easeInOut" } : {}}
              >
                {isRunning ? (
                  <Loader2 className={`w-3.5 h-3.5 ${safeConfig.color} animate-spin`} />
                ) : (
                  <Icon className={`w-3.5 h-3.5 ${safeConfig.color}`} />
                )}
              </motion.div>
              
              {/* Status dot */}
              {showIndicator && (
                <span 
                  className={`
                    absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border-[1.5px] border-zinc-950
                    ${isRunning ? "animate-pulse" : ""}
                  `}
                  style={{ 
                    backgroundColor: isRunning 
                      ? safeConfig.colorHex
                      : data.status === "complete" 
                      ? "#34d399"
                      : data.status === "error"
                      ? "#f87171"
                      : "#71717a"
                  }}
                />
              )}
            </div>

            {/* Name */}
            <span className={`text-sm font-medium transition-colors duration-200 ${
              isHovered || isRunning ? "text-white" : "text-zinc-300"
            }`}>
              {safeConfig.name}
            </span>
          </div>

          {/* Expanded section - uses max-width transition for smoothness */}
          <div 
            className={`
              flex items-center overflow-hidden
              transition-all duration-300 ease-out
              ${isHovered && !isReordering ? "max-w-[180px] opacity-100" : "max-w-0 opacity-0"}
            `}
          >
            <div className="flex items-center gap-3 pr-3">
              {/* Vertical separator */}
              <div className="w-[1px] h-5 bg-white/20" />
              
              {/* Status */}
              <span className={`text-xs whitespace-nowrap ${isRunning ? safeConfig.color : "text-zinc-400"}`}>
                {getStatusLabel()}
              </span>
              
              {/* Action button */}
              {action && (
                <button
                  className={`
                    flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium
                    whitespace-nowrap
                    ${safeConfig.bgColor} ${safeConfig.color} border ${safeConfig.borderColor}
                    hover:brightness-125 transition-all duration-150
                    active:scale-95
                  `}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAction(action.action);
                  }}
                >
                  {action.label}
                  <ChevronRight className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </Reorder.Item>
  );
}

export function AgentParticles({
  agents,
  onAgentAction,
  onReorder,
  className = "",
}: AgentParticlesProps) {
  const configuredAgents = agents.filter((a): a is AgentParticleData & { id: ParticleAgentType } =>
    hasParticleConfig(a.id)
  );
  const [order, setOrder] = useState<ParticleAgentType[]>(() =>
    configuredAgents.map((a) => a.id)
  );
  const [isReordering, setIsReordering] = useState(false);
  const configuredIds = configuredAgents.map((a) => a.id);
  const orderedIds: ParticleAgentType[] = [
    ...order.filter((id) => configuredIds.includes(id)),
    ...configuredIds.filter((id) => !order.includes(id)),
  ];

  const handleReorder = useCallback((newOrder: ParticleAgentType[]) => {
    const safeOrder = newOrder.filter((id) => hasParticleConfig(id));
    setOrder(safeOrder);
    onReorder?.(safeOrder);
  }, [onReorder]);

  const sortedAgents = [...configuredAgents].sort(
    (a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id)
  );
  const runningAgent = configuredAgents.find(a => a.status === "running");

  return (
    <div className={`relative ${className}`}>
      {/* Ambient glow */}
      {runningAgent && (
        <motion.div
          className="absolute -inset-4 -z-10 rounded-3xl pointer-events-none"
          style={{
            background: `radial-gradient(ellipse 60% 50% at 50% 50%, ${
              PARTICLE_CONFIG[runningAgent.id]?.glowColor || "rgba(255,255,255,0.2)"
            } 0%, transparent 70%)`,
          }}
          animate={{ opacity: [0.08, 0.15, 0.08] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        />
      )}

      {/* Particles row */}
      <div className="flex items-start sm:items-center gap-3 py-2">
        {/* Reorder button */}
        <button
          onClick={() => setIsReordering(!isReordering)}
          className={`
            w-8 h-8 rounded-full flex items-center justify-center shrink-0
            transition-all duration-200
            ${isReordering
              ? "bg-white/10 text-white border border-white/20"
              : "text-zinc-600 hover:text-zinc-400 hover:bg-white/5 border border-transparent"
            }
          `}
          title={isReordering ? "Done" : "Reorder"}
        >
          <GripVertical className="w-4 h-4" />
        </button>

        {/* Particles - on mobile, wrap to show all pills (no hidden horizontal scroll). */}
        <div
          className={`flex-1 overflow-y-visible scrollbar-hide py-2 -my-2 ${
            isReordering ? "overflow-x-auto" : "overflow-x-hidden sm:overflow-x-auto"
          }`}
        >
          <Reorder.Group
            axis="x"
            values={orderedIds}
            onReorder={handleReorder}
            className={`flex items-center gap-2 py-1 ${
              isReordering ? "flex-nowrap" : "flex-wrap sm:flex-nowrap"
            }`}
            as="div"
          >
            {sortedAgents.map((agent) => {
              const config = PARTICLE_CONFIG[agent.id];
              if (!config) return null;
              return (
                <Particle
                  key={agent.id}
                  data={agent}
                  config={config}
                  onAction={(action) => onAgentAction(agent.id, action)}
                  isReordering={isReordering}
                />
              );
            })}
          </Reorder.Group>
        </div>
      </div>

      {/* Reorder hint */}
      <AnimatePresence>
        {isReordering && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className="text-[11px] text-zinc-500 mt-2 text-center"
          >
            Drag to reorder
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

export type { ParticleAgentType, AgentParticleData };
