"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Globe,
  FolderOpen,
  BookMarked,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Settings,
  Plus,
  Flame,
  Server,
  Database,
  FileText,
  Copy,
  Search,
  Zap,
  MessageCircle,
  Terminal,
  PlayCircle,
} from "lucide-react";
import type { AgentType } from "@/lib/orchestrator/router";
import { DataConnectionBadges, type DataConnection } from "./DataIntegrationsPanel";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export type AgentStatus = "idle" | "running" | "complete" | "error" | "awaiting";

export type AgentActivity = {
  id: string;
  action: string;
  status: "pending" | "running" | "complete" | "error";
  result?: string;
  timestamp: Date;
};

// Obsidian note result for graph visualization
export type ObsidianNoteResult = {
  path: string;       // Full path like "Main/citibank"
  name: string;       // Just the note name like "citibank"
  matches?: number;   // Number of matches in this note
  links?: string[];   // Wikilinks found in this note
};

// Running context - what the agent is currently doing
export type RunningContext = {
  provider?: string; // For data agent: firecrawl, postgres, web_pixel, etc.
  action?: string;   // What it's doing: "Scraping", "Querying", "Searching"
  target?: string;   // Target: URL, filename, query text
  // Browser agent: screenshot from Claude Computer Use
  screenshot?: string; // base64 image data (no prefix)
  screenshotMediaType?: string; // image/png | image/jpeg (defaults to image/png)
  pageTitle?: string;  // Current page title
  pageUrl?: string;    // Current page URL
  // Obsidian agent: search results for graph
  obsidianResults?: ObsidianNoteResult[];
};

type AgentTileProps = {
  agent: AgentType;
  status: AgentStatus;
  lastOutput?: string;
  activities: AgentActivity[];
  isExpanded: boolean;
  onToggleExpand: () => void;
  onOpenSettings?: () => void;
  // Running state context
  runningContext?: RunningContext;
  // Data agent specific
  dataConnections?: DataConnection[];
  onOpenDataPanel?: () => void;
  // Files agent specific
  filesAgentConfigured?: boolean;
  onSetupFilesAgent?: () => void;
  onOpenFilesPanel?: () => void;
  // Obsidian agent specific
  obsidianConfigured?: boolean;
  isLocalConnected?: boolean;
  onSetupObsidian?: () => void;
  onOpenObsidianPanel?: () => void;
  // Schedule agent specific
  onTriggerScheduledJob?: (jobId: string) => void;
  runningScheduledJobIds?: Set<string>;
};

const AGENT_CONFIG: Record<
  AgentType,
  {
    name: string;
    icon: typeof Globe;
    color: string;
    bgColor: string;
    borderColor: string;
    glowColor: string;
    description: string;
  }
> = {
  browser: {
    name: "Browser",
    icon: Globe,
    color: "text-cyan-400",
    bgColor: "bg-cyan-500/10",
    borderColor: "border-cyan-500/30",
    glowColor: "rgba(34,211,238,0.5)",
    description: "Web browsing & automation",
  },
  files: {
    name: "Files",
    icon: FolderOpen,
    color: "text-amber-400",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/30",
    glowColor: "rgba(251,191,36,0.5)",
    description: "Local file management",
  },
  pages: {
    name: "Pages",
    icon: FileText,
    color: "text-indigo-400",
    bgColor: "bg-indigo-500/10",
    borderColor: "border-indigo-500/30",
    glowColor: "rgba(129,140,248,0.5)",
    description: "Site builder & publishing",
  },
  obsidian: {
    name: "Obsidian",
    icon: BookMarked,
    color: "text-violet-400",
    bgColor: "bg-violet-500/10",
    borderColor: "border-violet-500/30",
    glowColor: "rgba(167,139,250,0.5)",
    description: "Notes & knowledge",
  },
  data: {
    name: "Data",
    icon: BarChart3,
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
    borderColor: "border-emerald-500/30",
    glowColor: "rgba(16,185,129,0.5)",
    description: "Analytics & insights",
  },
  chat: {
    name: "AI Chat",
    icon: MessageCircle,
    color: "text-rose-400",
    bgColor: "bg-rose-500/10",
    borderColor: "border-rose-500/30",
    glowColor: "rgba(251,113,133,0.5)",
    description: "Conversational AI assistant",
  },
  schedule: {
    name: "Schedule",
    icon: Clock,
    color: "text-blue-400",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/30",
    glowColor: "rgba(59,130,246,0.5)",
    description: "Scheduled tasks & automation",
  },
  code: {
    name: "Code",
    icon: Terminal,
    color: "text-lime-400",
    bgColor: "bg-lime-500/10",
    borderColor: "border-lime-500/30",
    glowColor: "rgba(163,230,53,0.5)",
    description: "Claude Code terminal",
  },
};

const STATUS_CONFIG: Record<
  AgentStatus,
  {
    label: string;
    icon: typeof Loader2;
    color: string;
    pulse: boolean;
  }
> = {
  idle: {
    label: "Ready",
    icon: CheckCircle2,
    color: "text-zinc-500",
    pulse: false,
  },
  running: {
    label: "Running",
    icon: Loader2,
    color: "text-cyan-400",
    pulse: true,
  },
  complete: {
    label: "Complete",
    icon: CheckCircle2,
    color: "text-emerald-400",
    pulse: false,
  },
  error: {
    label: "Error",
    icon: AlertCircle,
    color: "text-red-400",
    pulse: false,
  },
  awaiting: {
    label: "Waiting",
    icon: Clock,
    color: "text-amber-400",
    pulse: true,
  },
};

// Provider icons for Data agent
const PROVIDER_ICONS: Record<string, { icon: typeof Flame; color: string; bgColor: string; label: string }> = {
  firecrawl: { icon: Flame, color: "text-orange-400", bgColor: "bg-orange-500/20", label: "Firecrawl" },
  postgres: { icon: Server, color: "text-blue-400", bgColor: "bg-blue-500/20", label: "Postgres" },
  web_pixel: { icon: BarChart3, color: "text-pink-400", bgColor: "bg-pink-500/20", label: "Web Pixel" },
  pixel: { icon: BarChart3, color: "text-pink-400", bgColor: "bg-pink-500/20", label: "Web Pixel" },
  google_ads: { icon: BarChart3, color: "text-red-400", bgColor: "bg-red-500/20", label: "Google Ads" },
  facebook: { icon: Database, color: "text-blue-400", bgColor: "bg-blue-500/20", label: "Facebook" },
  instagram: { icon: Database, color: "text-pink-400", bgColor: "bg-pink-500/20", label: "Instagram" },
  linkedin: { icon: Database, color: "text-blue-400", bgColor: "bg-blue-500/20", label: "LinkedIn" },
  default: { icon: Database, color: "text-emerald-400", bgColor: "bg-emerald-500/20", label: "Data" },
};

export function AgentTile({
  agent,
  status,
  lastOutput,
  activities,
  isExpanded,
  onToggleExpand,
  onOpenSettings,
  runningContext,
  dataConnections,
  onOpenDataPanel,
  filesAgentConfigured,
  onSetupFilesAgent,
  onOpenFilesPanel,
  obsidianConfigured,
  isLocalConnected,
  onSetupObsidian,
  onOpenObsidianPanel,
  onTriggerScheduledJob,
  runningScheduledJobIds,
}: AgentTileProps) {
  const config = AGENT_CONFIG[agent];
  const statusConfig = STATUS_CONFIG[status];
  const Icon = config.icon;
  const StatusIcon = statusConfig.icon;

  // Get preview text (last output truncated)
  const previewText = lastOutput
    ? lastOutput.length > 100
      ? lastOutput.slice(0, 100) + "..."
      : lastOutput
    : config.description;

  // Check if this is the data agent with connections
  const isDataAgent = agent === "data";
  const hasDataConnections = isDataAgent && dataConnections && dataConnections.length > 0;

  // Check if this is the files agent
  const isFilesAgent = agent === "files";
  const needsFilesAgentSetup = isFilesAgent && filesAgentConfigured === false;

  // Check if this is the obsidian agent
  const isObsidianAgent = agent === "obsidian";
  const isScheduleAgent = agent === "schedule";
  const isRunning = status === "running";

  // Schedule jobs (loaded client-side via Supabase RLS)
  type ScheduledJob = {
    id: string;
    name: string;
    kind?: "shell" | "orchestrator" | string;
    command: string | null;
    task?: unknown;
    schedule: unknown;
    enabled: boolean;
    skip_next_run: boolean;
    last_run_at: string | null;
    last_status: string | null;
    last_exit_code: number | null;
    updated_at: string | null;
  };
  const [scheduleJobs, setScheduleJobs] = useState<ScheduledJob[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  type ScheduledJobRun = {
    id: string;
    job_id: string;
    status: string;
    exit_code: number | null;
    started_at: string;
    finished_at: string | null;
    duration_ms: number | null;
    stdout: string | null;
    stderr: string | null;
    error: string | null;
    created_at: string;
  };
  const [scheduleRuns, setScheduleRuns] = useState<ScheduledJobRun[]>([]);
  const [scheduleRunsLoading, setScheduleRunsLoading] = useState(false);
  const [scheduleRunsError, setScheduleRunsError] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const formatSchedule = (s: unknown): string => {
    if (!s || typeof s !== "object") return "unknown";
    const t = (s as { type?: unknown }).type;
    if (t === "once") {
      const runAt = (s as { run_at?: unknown }).run_at;
      return typeof runAt === "string" ? `once @ ${runAt}` : "once";
    }
    if (t === "daily") {
      const hour = (s as { hour?: unknown }).hour;
      const minute = (s as { minute?: unknown }).minute;
      if (typeof hour === "number" && typeof minute === "number") {
        return `daily @ ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      }
      return "daily";
    }
    if (t === "weekly") {
      const weekday = (s as { weekday?: unknown }).weekday;
      const hour = (s as { hour?: unknown }).hour;
      const minute = (s as { minute?: unknown }).minute;
      const wd =
        typeof weekday === "number"
          ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday] || "?"
          : "?";
      if (typeof hour === "number" && typeof minute === "number") {
        return `weekly ${wd} @ ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      }
      return `weekly ${wd}`;
    }
    if (t === "interval_minutes") {
      const minutes = (s as { minutes?: unknown }).minutes;
      return typeof minutes === "number" ? `every ${minutes}m` : "interval";
    }
    return typeof t === "string" ? t : "unknown";
  };

  const getJobSummary = (j: ScheduledJob): { label: string; detail: string } => {
    const kind = (j.kind || "shell") as string;
    if (kind === "orchestrator") {
      const taskObj =
        j.task && typeof j.task === "object" ? (j.task as { message?: unknown }) : null;
      const msg =
        taskObj && typeof taskObj.message === "string" ? taskObj.message.trim() : "";
      return { label: "orchestrator", detail: msg || "(no task)" };
    }
    return { label: "shell", detail: (j.command || "").trim() || "(no command)" };
  };

  const refreshSchedules = async () => {
    setScheduleLoading(true);
    setScheduleError(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("scheduled_jobs")
        .select("id,name,kind,command,task,schedule,enabled,skip_next_run,last_run_at,last_status,last_exit_code,updated_at")
        .order("updated_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      // Filter out heartbeat jobs (managed via Settings, not the Schedule tile)
      const visible = ((data as ScheduledJob[]) || []).filter((j) => {
        const t = j.task as Record<string, unknown> | null;
        return !(t && (t.type === "heartbeat_v1" || t.ui_hidden === true));
      });
      setScheduleJobs(visible);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setScheduleError(msg || "Failed to load schedules");
    } finally {
      setScheduleLoading(false);
    }
  };

  const refreshScheduleRuns = async () => {
    setScheduleRunsLoading(true);
    setScheduleRunsError(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("scheduled_job_runs")
        .select(
          "id,job_id,status,exit_code,started_at,finished_at,duration_ms,stdout,stderr,error,created_at"
        )
        .order("created_at", { ascending: false })
        .limit(40);
      if (error) throw error;
      setScheduleRuns((data as ScheduledJobRun[]) || []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setScheduleRunsError(msg || "Failed to load run history");
    } finally {
      setScheduleRunsLoading(false);
    }
  };

  const updateScheduleJob = async (jobId: string, patch: Record<string, unknown>) => {
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase
      .from("scheduled_jobs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", jobId);
    if (error) throw error;
    await refreshSchedules();
  };

  const deleteScheduleJob = async (jobId: string) => {
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.from("scheduled_jobs").delete().eq("id", jobId);
    if (error) throw error;
    await refreshSchedules();
  };

  useEffect(() => {
    if (!isScheduleAgent) return;
    if (!isExpanded) return;
    refreshSchedules().catch(() => {});
    refreshScheduleRuns().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScheduleAgent, isExpanded]);

  // Obsidian constellation: show while running, then linger briefly after completion and auto-hide.
  const [showObsidianConstellation, setShowObsidianConstellation] = useState(false);
  const [showObsidianConstellationModal, setShowObsidianConstellationModal] = useState(false);
  const obsidianHideTimerRef = useRef<number | null>(null);
  const obsidianResultsCount = runningContext?.obsidianResults?.length ?? 0;

  useEffect(() => {
    if (!isObsidianAgent) return;

    if (obsidianHideTimerRef.current != null) {
      window.clearTimeout(obsidianHideTimerRef.current);
      obsidianHideTimerRef.current = null;
    }

    if (isRunning) {
      setShowObsidianConstellation(true);
      return;
    }

    if (obsidianResultsCount > 0) {
      setShowObsidianConstellation(true);
      obsidianHideTimerRef.current = window.setTimeout(() => {
        setShowObsidianConstellation(false);
        obsidianHideTimerRef.current = null;
      }, 3500);
      return;
    }

    setShowObsidianConstellation(false);
  }, [isObsidianAgent, isRunning, obsidianResultsCount]);

  // Modal UX
  useEffect(() => {
    if (!showObsidianConstellationModal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowObsidianConstellationModal(false);
    };
    window.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [showObsidianConstellationModal]);

  // Get provider info for running context
  const providerInfo = runningContext?.provider 
    ? PROVIDER_ICONS[runningContext.provider.toLowerCase()] || PROVIDER_ICONS.default
    : null;

  return (
    <motion.div
      layout
      className={`rounded-2xl border transition-all duration-300 overflow-hidden ${
        isExpanded || isRunning
          ? `${config.borderColor} bg-zinc-900/80`
          : "border-white/10 bg-zinc-900/40 hover:border-white/20"
      }`}
      animate={isRunning ? { 
        boxShadow: [
          `0 0 20px -5px ${config.glowColor}`,
          `0 0 40px -5px ${config.glowColor}`,
          `0 0 20px -5px ${config.glowColor}`,
        ]
      } : { boxShadow: "0 0 0px 0px transparent" }}
      transition={isRunning ? { 
        repeat: Infinity, 
        duration: 2, 
        ease: "easeInOut" 
      } : { duration: 0.3 }}
    >
      {/* Header - always visible */}
      <div
        className="p-4 cursor-pointer"
        onClick={onToggleExpand}
      >
        <div className="flex items-start justify-between gap-3">
          {/* Agent icon and info */}
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <motion.div
              className={`w-10 h-10 rounded-xl ${config.bgColor} flex items-center justify-center shrink-0`}
              animate={isRunning ? { scale: [1, 1.05, 1] } : { scale: 1 }}
              transition={isRunning ? { repeat: Infinity, duration: 1.5 } : {}}
            >
              <Icon className={`w-5 h-5 ${config.color}`} />
            </motion.div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-white">{config.name}</h3>
                {/* Status indicator */}
                <div className={`flex items-center gap-1 ${statusConfig.color}`}>
                  <StatusIcon
                    className={`w-3.5 h-3.5 ${
                      statusConfig.pulse ? "animate-spin" : ""
                    }`}
                  />
                  <span className="text-[10px] uppercase tracking-wider">
                    {statusConfig.label}
                  </span>
                </div>
              </div>
              {/* Preview text when collapsed and not running */}
              {!isExpanded && !isRunning && !hasDataConnections && !needsFilesAgentSetup && (
                <p className="text-xs text-zinc-500 mt-1 truncate">
                  {previewText}
                </p>
              )}
              {/* Data connections badges (compact when collapsed) */}
              {!isExpanded && !isRunning && hasDataConnections && (
                <DataConnectionBadges connections={dataConnections!} maxVisible={4} expanded={false} />
              )}
              {/* Show "Add integration" hint for data agent with no connections */}
              {!isExpanded && !isRunning && isDataAgent && !hasDataConnections && (
                <p className="text-xs text-zinc-500 mt-1 truncate">
                  Click to add integrations
                </p>
              )}
              {/* Show setup hint for files agent not configured */}
              {!isExpanded && !isRunning && needsFilesAgentSetup && (
                <p className="text-xs text-amber-400/80 mt-1 truncate">
                  Setup required
                </p>
              )}
              {/* Obsidian connection status when collapsed */}
              {!isExpanded && !isRunning && isObsidianAgent && (
                <div className="flex items-center gap-1.5 mt-1">
                  <div className={`w-2 h-2 rounded-full ${isLocalConnected ? "bg-emerald-400" : "bg-zinc-600"}`} />
                  <span className={`text-xs ${isLocalConnected ? "text-emerald-400" : "text-zinc-500"}`}>
                    {isLocalConnected 
                      ? (obsidianConfigured ? "Local connected" : "Setup vault")
                      : "Start connector"
                    }
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1 shrink-0">
            {/* Data panel button for data agent */}
            {isDataAgent && onOpenDataPanel && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDataPanel();
                }}
                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
                  hasDataConnections
                    ? "text-emerald-400 hover:bg-emerald-500/10"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                }`}
                title="Manage integrations"
              >
                <Plus className="w-4 h-4" />
              </button>
            )}
            {onOpenSettings && !isDataAgent && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSettings();
                }}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-all"
              >
                <Settings className="w-4 h-4" />
              </button>
            )}
            <button className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-all">
              {isExpanded ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* RUNNING STATE REVEAL - Beautiful animated active state */}
      <AnimatePresence>
        {isRunning && !isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4">
              {/* Data Agent Running State */}
              {isDataAgent && (
                <div className="relative rounded-xl overflow-hidden">
                  {/* Animated background */}
                  <div className={`absolute inset-0 ${providerInfo?.bgColor || config.bgColor} opacity-30`} />
                  <motion.div
                    className="absolute inset-0"
                    style={{
                      background: `radial-gradient(circle at center, ${config.glowColor} 0%, transparent 70%)`,
                    }}
                    animate={{ opacity: [0.2, 0.4, 0.2], scale: [1, 1.1, 1] }}
                    transition={{ repeat: Infinity, duration: 2 }}
                  />
                  
                  <div className="relative p-4 flex items-center gap-4">
                    {/* Large provider icon */}
                    <motion.div
                      className={`w-16 h-16 rounded-2xl ${providerInfo?.bgColor || config.bgColor} flex items-center justify-center`}
                      animate={{ scale: [1, 1.08, 1], rotate: [0, 2, -2, 0] }}
                      transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
                    >
                      {providerInfo ? (
                        <providerInfo.icon className={`w-8 h-8 ${providerInfo.color}`} />
                      ) : (
                        <BarChart3 className={`w-8 h-8 ${config.color}`} />
                      )}
                    </motion.div>
                    
                    {/* Action text */}
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium ${providerInfo?.color || config.color}`}>
                        {providerInfo?.label || "Querying Data"}
                      </p>
                      <p className="text-xs text-zinc-400 mt-0.5 truncate">
                        {runningContext?.action || "Processing request..."}
                      </p>
                      {runningContext?.target && (
                        <p className="text-[10px] text-zinc-500 mt-1 truncate font-mono">
                          {runningContext.target}
                        </p>
                      )}
                    </div>

                    {/* Pulsing activity indicator */}
                    <div className="flex flex-col gap-1">
                      {[0, 1, 2].map((i) => (
                        <motion.div
                          key={i}
                          className={`w-1.5 h-3 rounded-full ${providerInfo?.bgColor || config.bgColor}`}
                          animate={{ opacity: [0.3, 1, 0.3] }}
                          transition={{ repeat: Infinity, duration: 0.8, delay: i * 0.2 }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Browser Agent Running State - Mini Browser Window with LIVE Screenshot */}
              {agent === "browser" && (
                <div className="relative rounded-xl overflow-hidden border border-cyan-500/30 bg-zinc-950">
                  {/* Browser Chrome - Title Bar */}
                  <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-b border-zinc-800">
                    {/* Traffic lights */}
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
                      <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
                      <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
                    </div>
                    
                    {/* URL Bar */}
                    <div className="flex-1 flex items-center gap-2 px-3 py-1.5 bg-zinc-800 rounded-lg">
                      <Globe className="w-3 h-3 text-cyan-400 shrink-0" />
                      <span className="text-xs text-zinc-300 truncate font-mono">
                        {runningContext?.pageUrl || runningContext?.target || "https://..."}
                      </span>
                      <Loader2 className="w-3 h-3 text-cyan-400 animate-spin shrink-0 ml-auto" />
                    </div>
                  </div>
                  
                  {/* Browser Content Area - LIVE SCREENSHOT or Loading */}
                  <div className="relative h-48 bg-zinc-950 overflow-hidden">
                    {runningContext?.screenshot ? (
                      /* Actual Screenshot from Claude Computer Use */
                      <>
                        <motion.img
                          src={`data:${runningContext.screenshotMediaType || "image/png"};base64,${runningContext.screenshot}`}
                          alt={runningContext.pageTitle || "Browser screenshot"}
                          className="w-full h-full object-cover object-top"
                          initial={{ opacity: 0, scale: 1.02 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.3 }}
                        />
                        {/* Live indicator overlay */}
                        <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 bg-black/70 backdrop-blur-sm rounded-full">
                          <motion.div
                            className="w-2 h-2 rounded-full bg-red-500"
                            animate={{ opacity: [1, 0.5, 1] }}
                            transition={{ repeat: Infinity, duration: 1 }}
                          />
                          <span className="text-[10px] text-white font-medium">LIVE</span>
                        </div>
                        {/* Click indicator overlay - shows where Claude might click */}
                        <motion.div
                          className="absolute inset-0 pointer-events-none"
                          style={{
                            background: "radial-gradient(circle at 50% 50%, rgba(34,211,238,0.05) 0%, transparent 50%)",
                          }}
                        />
                      </>
                    ) : (
                      /* Loading skeleton when no screenshot yet */
                      <>
                        <div className="absolute inset-0 p-3 space-y-3">
                          {/* Header skeleton */}
                          <div className="flex items-center gap-3">
                            <motion.div 
                              className="w-10 h-10 rounded-lg bg-zinc-800"
                              animate={{ opacity: [0.3, 0.6, 0.3] }}
                              transition={{ repeat: Infinity, duration: 1.5 }}
                            />
                            <div className="flex-1 space-y-2">
                              <motion.div 
                                className="h-3 w-32 rounded bg-zinc-800"
                                animate={{ opacity: [0.3, 0.6, 0.3] }}
                                transition={{ repeat: Infinity, duration: 1.5, delay: 0.1 }}
                              />
                              <motion.div 
                                className="h-2 w-20 rounded bg-zinc-800"
                                animate={{ opacity: [0.3, 0.6, 0.3] }}
                                transition={{ repeat: Infinity, duration: 1.5, delay: 0.2 }}
                              />
                            </div>
                          </div>
                          
                          {/* Content skeleton rows */}
                          {[0, 1, 2, 3].map((i) => (
                            <motion.div 
                              key={i}
                              className="h-2.5 rounded bg-zinc-800"
                              style={{ width: `${85 - i * 12}%` }}
                              animate={{ opacity: [0.3, 0.6, 0.3] }}
                              transition={{ repeat: Infinity, duration: 1.5, delay: 0.3 + i * 0.1 }}
                            />
                          ))}
                        </div>
                        
                        {/* Scanning line effect */}
                        <motion.div
                          className="absolute left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent"
                          animate={{ top: ["0%", "100%", "0%"] }}
                          transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                        />
                        
                        {/* Glow overlay */}
                        <motion.div
                          className="absolute inset-0 pointer-events-none"
                          style={{
                            background: "radial-gradient(circle at 50% 50%, rgba(34,211,238,0.1) 0%, transparent 70%)",
                          }}
                          animate={{ opacity: [0.3, 0.6, 0.3] }}
                          transition={{ repeat: Infinity, duration: 2 }}
                        />
                        
                        {/* Waiting for screenshot text */}
                        <div className="absolute bottom-3 left-0 right-0 flex justify-center">
                          <div className="px-3 py-1.5 bg-zinc-900/90 backdrop-blur-sm rounded-full flex items-center gap-2">
                            <Loader2 className="w-3 h-3 text-cyan-400 animate-spin" />
                            <span className="text-[10px] text-zinc-400">Waiting for screenshot...</span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  
                  {/* Status bar */}
                  <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/50 border-t border-zinc-800">
                    <span className="text-[10px] text-cyan-400 truncate flex-1">
                      {runningContext?.action || (runningContext?.screenshot ? "Claude is analyzing..." : "Starting browser...")}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <motion.div
                        className="w-1.5 h-1.5 rounded-full bg-cyan-400"
                        animate={{ opacity: [1, 0.3, 1] }}
                        transition={{ repeat: Infinity, duration: 0.8 }}
                      />
                      <span className="text-[10px] text-zinc-500">
                        {runningContext?.screenshot ? "Computer Use" : "Connecting"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Files Agent Running State */}
              {isFilesAgent && (
                <div className="relative rounded-xl overflow-hidden">
                  <div className="absolute inset-0 bg-amber-500/10" />
                  <motion.div
                    className="absolute inset-0"
                    style={{
                      background: "radial-gradient(circle at center, rgba(251,191,36,0.3) 0%, transparent 70%)",
                    }}
                    animate={{ opacity: [0.2, 0.5, 0.2] }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                  />
                  
                  <div className="relative p-4 flex items-center gap-4">
                    {/* Animated folder with files */}
                    <div className="w-16 h-16 rounded-2xl bg-amber-500/20 flex items-center justify-center relative">
                      <FolderOpen className="w-8 h-8 text-amber-400" />
                      {/* Flying files animation */}
                      {[0, 1, 2].map((i) => (
                        <motion.div
                          key={i}
                          className="absolute"
                          initial={{ x: 0, y: 0, opacity: 0, scale: 0.5 }}
                          animate={{ 
                            x: [0, 15, 30],
                            y: [0, -10 - i * 5, -20 - i * 8],
                            opacity: [0, 1, 0],
                            scale: [0.5, 0.8, 0.5],
                          }}
                          transition={{ repeat: Infinity, duration: 1.5, delay: i * 0.3 }}
                        >
                          <FileText className="w-3 h-3 text-amber-400" />
                        </motion.div>
                      ))}
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-amber-400">Processing Files</p>
                      <p className="text-xs text-zinc-400 mt-0.5 truncate">
                        {runningContext?.action || "Analyzing..."}
                      </p>
                      {runningContext?.target && (
                        <p className="text-[10px] text-zinc-500 mt-1 truncate font-mono">
                          {runningContext.target}
                        </p>
                      )}
                    </div>

                    <Loader2 className="w-5 h-5 text-amber-400 animate-spin" />
                  </div>
                </div>
              )}

              {/* Obsidian running visualization is handled by the constellation preview below */}

              {/* Progress bar */}
              <motion.div
                className={`mt-3 h-1 ${config.bgColor} rounded-full overflow-hidden`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                <motion.div
                  className={`h-full rounded-full ${config.color.replace("text-", "bg-")}`}
                  animate={{ x: ["-100%", "100%"] }}
                  transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }}
                  style={{ width: "40%" }}
                />
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Browser: Show last screenshot when not running but have screenshot data */}
      <AnimatePresence>
        {agent === "browser" && !isRunning && !isExpanded && runningContext?.screenshot && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4">
              <div className="relative rounded-xl overflow-hidden border border-cyan-500/20 bg-zinc-950">
                {/* Browser Chrome - Title Bar */}
                <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-b border-zinc-800">
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-zinc-600" />
                    <div className="w-2.5 h-2.5 rounded-full bg-zinc-600" />
                    <div className="w-2.5 h-2.5 rounded-full bg-zinc-600" />
                  </div>
                  <div className="flex-1 flex items-center gap-2 px-3 py-1.5 bg-zinc-800 rounded-lg">
                    <Globe className="w-3 h-3 text-zinc-400 shrink-0" />
                    <span className="text-xs text-zinc-400 truncate font-mono">
                      {runningContext.pageUrl || "Last browsed"}
                    </span>
                  </div>
                </div>
                
                {/* Screenshot */}
                <div className="relative h-40 bg-zinc-950 overflow-hidden">
                  <img
                    src={`data:${runningContext.screenshotMediaType || "image/png"};base64,${runningContext.screenshot}`}
                    alt={runningContext.pageTitle || "Browser screenshot"}
                    className="w-full h-full object-cover object-top opacity-80"
                  />
                  <div className="absolute top-2 right-2 px-2 py-1 bg-black/70 backdrop-blur-sm rounded-full">
                    <span className="text-[10px] text-zinc-400">Completed</span>
                  </div>
                </div>
                
                {/* Status bar */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/50 border-t border-zinc-800">
                  <span className="text-[10px] text-zinc-500 truncate">
                    {runningContext.pageTitle || "Browser task completed"}
                  </span>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Obsidian: Beautiful constellation graph with REAL DATA */}
      <AnimatePresence>
        {isObsidianAgent &&
          ((isExpanded && (isRunning || obsidianResultsCount > 0)) ||
            (!isExpanded && showObsidianConstellation)) && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden cursor-zoom-in"
            onClick={(e) => {
              e.stopPropagation();
              setShowObsidianConstellationModal(true);
            }}
          >
            <div className="px-4 pb-4">
              <div className="relative rounded-xl overflow-hidden border border-violet-500/30 bg-zinc-950">
                {/* Constellation Graph Canvas */}
                <div className={`relative ${isExpanded ? "h-64" : "h-48"} overflow-hidden`}>
                  {/* Deep space background */}
                  <div className="absolute inset-0 bg-gradient-to-br from-zinc-950 via-violet-950/20 to-zinc-950" />
                  
                  {/* Animated stars/particles in background */}
                  {[...Array(15)].map((_, i) => (
                    <motion.div
                      key={`star-${i}`}
                      className="absolute w-0.5 h-0.5 bg-white/20 rounded-full"
                      style={{
                        left: `${10 + (i * 7) % 80}%`,
                        top: `${5 + (i * 13) % 90}%`,
                      }}
                      animate={{ opacity: [0.1, 0.4, 0.1] }}
                      transition={{
                        repeat: Infinity,
                        duration: 2 + (i % 3),
                        delay: i * 0.2,
                      }}
                    />
                  ))}
                  
                  {(() => {
                    const results = runningContext?.obsidianResults || [];
                    const hasResults = results.length > 0;
                    
                    // Generate node positions in a circular pattern around center
                    const centerX = 150;
                    const centerY = 96;
                    const nodes = results.slice(0, 12).map((note, i) => {
                      const angle = (i / Math.min(results.length, 12)) * 2 * Math.PI - Math.PI / 2;
                      const radius = i === 0 ? 0 : 50 + (i % 3) * 15;
                      return {
                        x: centerX + Math.cos(angle) * radius,
                        y: centerY + Math.sin(angle) * radius,
                        name: note.name,
                        path: note.path,
                        links: note.links || [],
                        size: i === 0 ? 14 : Math.max(6, 10 - i),
                      };
                    });
                    
                    // Build edges: connect first node to all others, plus any wikilink matches
                    const edges: Array<{ from: number; to: number }> = [];
                    if (nodes.length > 1) {
                      for (let i = 1; i < nodes.length; i++) {
                        edges.push({ from: 0, to: i });
                      }
                      // Add edges for wikilinks between notes
                      nodes.forEach((node, i) => {
                        node.links.forEach(link => {
                          const targetIdx = nodes.findIndex(n => 
                            n.name.toLowerCase() === link.toLowerCase() ||
                            n.path.toLowerCase().includes(link.toLowerCase())
                          );
                          if (targetIdx > 0 && targetIdx !== i && !edges.find(e => 
                            (e.from === i && e.to === targetIdx) || (e.from === targetIdx && e.to === i)
                          )) {
                            edges.push({ from: i, to: targetIdx });
                          }
                        });
                      });
                    }
                    
                    return (
                      <>
                        {/* Constellation lines from real data */}
                        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 300 192">
                          <defs>
                            <linearGradient id="constellationGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                              <stop offset="0%" stopColor="rgba(167,139,250,0.9)" />
                              <stop offset="100%" stopColor="rgba(139,92,246,0.4)" />
                            </linearGradient>
                          </defs>
                          
                          {hasResults ? edges.map((edge, i) => (
                            <motion.line
                              key={`edge-${i}`}
                              x1={nodes[edge.from].x}
                              y1={nodes[edge.from].y}
                              x2={nodes[edge.to].x}
                              y2={nodes[edge.to].y}
                              stroke="url(#constellationGradient)"
                              strokeWidth={edge.from === 0 ? 1.5 : 1}
                              strokeLinecap="round"
                              initial={{ pathLength: 0, opacity: 0 }}
                              animate={{ 
                                pathLength: 1, 
                                opacity: isRunning ? [0.3, 0.7, 0.3] : 0.6 
                              }}
                              transition={{
                                pathLength: { duration: 0.5, delay: i * 0.05 },
                                opacity: isRunning 
                                  ? { repeat: Infinity, duration: 1.5, delay: i * 0.1 }
                                  : { duration: 0.3 },
                              }}
                            />
                          )) : (
                            // Placeholder lines when searching
                            [...Array(6)].map((_, i) => {
                              const angle = (i / 6) * 2 * Math.PI;
                              return (
                                <motion.line
                                  key={`placeholder-${i}`}
                                  x1={centerX}
                                  y1={centerY}
                                  x2={centerX + Math.cos(angle) * 60}
                                  y2={centerY + Math.sin(angle) * 50}
                                  stroke="rgba(167,139,250,0.3)"
                                  strokeWidth="1"
                                  strokeDasharray="4 4"
                                  animate={{ opacity: [0.2, 0.5, 0.2] }}
                                  transition={{ repeat: Infinity, duration: 1.5, delay: i * 0.15 }}
                                />
                              );
                            })
                          )}
                        </svg>
                        
                        {/* Real note nodes */}
                        {hasResults ? nodes.map((node, i) => (
                          <motion.div
                            key={node.path}
                            className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
                            style={{ left: node.x, top: node.y }}
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{ 
                              scale: 1, 
                              opacity: 1,
                            }}
                            transition={{
                              scale: { duration: 0.3, delay: i * 0.08, type: "spring" },
                            }}
                          >
                            {/* Node glow */}
                            {i === 0 && (
                              <motion.div
                                className="absolute bg-violet-500/30 rounded-full blur-lg"
                                style={{ width: node.size * 3, height: node.size * 3 }}
                                animate={isRunning ? { opacity: [0.3, 0.6, 0.3], scale: [1, 1.2, 1] } : { opacity: 0.4 }}
                                transition={{ repeat: Infinity, duration: 1.5 }}
                              />
                            )}
                            
                            {/* Node circle */}
                            <motion.div
                              className={`rounded-full border-2 ${
                                i === 0 
                                  ? "bg-violet-400 border-violet-300 shadow-lg shadow-violet-500/50" 
                                  : "bg-violet-500/80 border-violet-400/50"
                              }`}
                              style={{ width: node.size, height: node.size }}
                              animate={isRunning && i === 0 ? { scale: [1, 1.15, 1] } : {}}
                              transition={{ repeat: Infinity, duration: 1.5 }}
                            />
                            
                            {/* Note name label */}
                            <motion.span
                              className={`absolute whitespace-nowrap text-[8px] font-medium ${
                                i === 0 ? "text-violet-200" : "text-violet-300/70"
                              }`}
                              style={{ 
                                top: node.size / 2 + 4,
                                maxWidth: i === 0 ? 80 : 60,
                              }}
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              transition={{ delay: i * 0.1 + 0.3 }}
                            >
                              {node.name.length > 12 ? node.name.slice(0, 12) + "…" : node.name}
                            </motion.span>
                          </motion.div>
                        )) : (
                          // Placeholder center node when searching
                          <motion.div
                            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                            animate={{ scale: [1, 1.2, 1] }}
                            transition={{ repeat: Infinity, duration: 1 }}
                          >
                            <motion.div
                              className="absolute -inset-4 bg-violet-500/20 rounded-full blur-md"
                              animate={{ opacity: [0.3, 0.6, 0.3] }}
                              transition={{ repeat: Infinity, duration: 1 }}
                            />
                            <div className="w-4 h-4 bg-violet-400 rounded-full border-2 border-violet-300" />
                          </motion.div>
                        )}
                        
                        {/* Traveling pulses when running */}
                        {isRunning && edges.slice(0, 3).map((edge, i) => (
                          <motion.div
                            key={`pulse-${i}`}
                            className="absolute w-2 h-2 bg-violet-300 rounded-full blur-sm"
                            style={{ left: nodes[0].x, top: nodes[0].y }}
                            animate={{
                              x: [0, nodes[edge.to].x - nodes[0].x],
                              y: [0, nodes[edge.to].y - nodes[0].y],
                              opacity: [0, 1, 0],
                              scale: [0.5, 1, 0.5],
                            }}
                            transition={{
                              duration: 1.5,
                              repeat: Infinity,
                              delay: i * 0.5,
                              ease: "easeInOut",
                            }}
                          />
                        ))}
                      </>
                    );
                  })()}
                  
                  {/* Status indicator */}
                  <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 bg-black/60 backdrop-blur-sm rounded-full">
                    {isRunning ? (
                      <>
                        <motion.div
                          className="w-2 h-2 rounded-full bg-violet-400"
                          animate={{ opacity: [1, 0.4, 1] }}
                          transition={{ repeat: Infinity, duration: 1 }}
                        />
                        <span className="text-[10px] text-violet-300 font-medium">Searching</span>
                      </>
                    ) : (
                      <>
                        <div className="w-2 h-2 rounded-full bg-emerald-400" />
                        <span className="text-[10px] text-zinc-400">
                          {runningContext?.obsidianResults?.length || 0} notes
                        </span>
                      </>
                    )}
                  </div>
                  
                  {/* Query overlay */}
                  {runningContext?.target && (
                    <div className="absolute bottom-2 left-2 right-2">
                      <div className="px-2 py-1 bg-black/60 backdrop-blur-sm rounded-md">
                        <p className="text-[10px] text-zinc-400 truncate font-mono">
                          {runningContext.target}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
                
                {/* Status bar with note count */}
                <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/80 border-t border-violet-500/20">
                  <span className="text-[10px] text-violet-400 truncate">
                    {isRunning 
                      ? "Exploring knowledge graph..." 
                      : runningContext?.obsidianResults?.length 
                        ? `Found ${runningContext.obsidianResults.length} connected notes`
                        : "Notes connected"
                    }
                  </span>
                  {!isRunning && (
                    <span className="text-[10px] text-zinc-500">
                      Click to zoom
                    </span>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Obsidian constellation zoom modal */}
      {isObsidianAgent &&
        showObsidianConstellationModal &&
        typeof window !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={() => setShowObsidianConstellationModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.98, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 10 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-4xl bg-zinc-950 border border-violet-500/30 rounded-2xl overflow-hidden shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-zinc-950/80">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white">Obsidian Constellation</div>
                  <div className="text-[11px] text-zinc-500 truncate">
                    {runningContext?.target || "Last search"}
                  </div>
                </div>
                <button
                  onClick={() => setShowObsidianConstellationModal(false)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-all"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              <div className="p-4">
                <div className="relative rounded-xl overflow-hidden border border-violet-500/30 bg-zinc-950">
                  <div className="relative h-[70vh] min-h-[420px] max-h-[760px] overflow-hidden">
                    {/* Deep space background */}
                    <div className="absolute inset-0 bg-gradient-to-br from-zinc-950 via-violet-950/20 to-zinc-950" />

                    {/* Reuse the same rendering logic by rendering the same block */}
                    {/* Animated stars/particles in background */}
                    {[...Array(15)].map((_, i) => (
                      <motion.div
                        key={`star-modal-${i}`}
                        className="absolute w-0.5 h-0.5 bg-white/20 rounded-full"
                        style={{
                          left: `${10 + (i * 7) % 80}%`,
                          top: `${5 + (i * 13) % 90}%`,
                        }}
                        animate={{ opacity: [0.1, 0.4, 0.1] }}
                        transition={{
                          repeat: Infinity,
                          duration: 2 + (i % 3),
                          delay: i * 0.2,
                        }}
                      />
                    ))}

                    {(() => {
                      const results = runningContext?.obsidianResults || [];
                      const hasResults = results.length > 0;

                      const centerX = 150;
                      const centerY = 96;
                      const nodes = results.slice(0, 12).map((note, i) => {
                        const angle =
                          (i / Math.min(results.length, 12)) * 2 * Math.PI - Math.PI / 2;
                        const radius = i === 0 ? 0 : 50 + (i % 3) * 15;
                        return {
                          x: centerX + Math.cos(angle) * radius,
                          y: centerY + Math.sin(angle) * radius,
                          name: note.name,
                          path: note.path,
                          links: note.links || [],
                          size: i === 0 ? 14 : Math.max(6, 10 - i),
                        };
                      });

                      const edges: Array<{ from: number; to: number }> = [];
                      if (nodes.length > 1) {
                        for (let i = 1; i < nodes.length; i++) {
                          edges.push({ from: 0, to: i });
                        }
                        nodes.forEach((node, i) => {
                          node.links.forEach((link) => {
                            const targetIdx = nodes.findIndex(
                              (n) =>
                                n.name.toLowerCase() === link.toLowerCase() ||
                                n.path.toLowerCase().includes(link.toLowerCase())
                            );
                            if (
                              targetIdx > 0 &&
                              targetIdx !== i &&
                              !edges.find(
                                (e) =>
                                  (e.from === i && e.to === targetIdx) ||
                                  (e.from === targetIdx && e.to === i)
                              )
                            ) {
                              edges.push({ from: i, to: targetIdx });
                            }
                          });
                        });
                      }

                      return (
                        <>
                          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 300 192">
                            <defs>
                              <linearGradient
                                id="constellationGradientModal"
                                x1="0%"
                                y1="0%"
                                x2="100%"
                                y2="100%"
                              >
                                <stop offset="0%" stopColor="rgba(167,139,250,0.9)" />
                                <stop offset="100%" stopColor="rgba(139,92,246,0.4)" />
                              </linearGradient>
                            </defs>

                            {hasResults
                              ? edges.map((edge, i) => (
                                  <motion.line
                                    key={`edge-modal-${i}`}
                                    x1={nodes[edge.from].x}
                                    y1={nodes[edge.from].y}
                                    x2={nodes[edge.to].x}
                                    y2={nodes[edge.to].y}
                                    stroke="url(#constellationGradientModal)"
                                    strokeWidth={edge.from === 0 ? 1.5 : 1}
                                    strokeLinecap="round"
                                    initial={{ pathLength: 0, opacity: 0 }}
                                    animate={{
                                      pathLength: 1,
                                      opacity: isRunning ? [0.3, 0.7, 0.3] : 0.6,
                                    }}
                                    transition={{
                                      pathLength: { duration: 0.5, delay: i * 0.05 },
                                      opacity: isRunning
                                        ? { repeat: Infinity, duration: 1.5, delay: i * 0.1 }
                                        : { duration: 0.3 },
                                    }}
                                  />
                                ))
                              : null}
                          </svg>

                          {hasResults
                            ? nodes.map((node, i) => (
                                <motion.div
                                  key={`node-modal-${node.path}`}
                                  className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
                                  style={{ left: `${(node.x / 300) * 100}%`, top: `${(node.y / 192) * 100}%` }}
                                  initial={{ scale: 0, opacity: 0 }}
                                  animate={{ scale: 1, opacity: 1 }}
                                  transition={{
                                    scale: { duration: 0.3, delay: i * 0.08, type: "spring" },
                                  }}
                                >
                                  {i === 0 && (
                                    <motion.div
                                      className="absolute bg-violet-500/30 rounded-full blur-lg"
                                      style={{ width: node.size * 3, height: node.size * 3 }}
                                      animate={
                                        isRunning
                                          ? { opacity: [0.3, 0.6, 0.3], scale: [1, 1.2, 1] }
                                          : { opacity: 0.4 }
                                      }
                                      transition={{ repeat: Infinity, duration: 1.5 }}
                                    />
                                  )}

                                  <motion.div
                                    className={`rounded-full border-2 ${
                                      i === 0
                                        ? "bg-violet-400 border-violet-300 shadow-lg shadow-violet-500/50"
                                        : "bg-violet-500/80 border-violet-400/50"
                                    }`}
                                    style={{ width: node.size, height: node.size }}
                                    animate={isRunning && i === 0 ? { scale: [1, 1.15, 1] } : {}}
                                    transition={{ repeat: Infinity, duration: 1.5 }}
                                  />

                                  <motion.span
                                    className={`absolute whitespace-nowrap text-[10px] font-medium ${
                                      i === 0 ? "text-violet-200" : "text-violet-300/70"
                                    }`}
                                    style={{
                                      top: node.size / 2 + 6,
                                      maxWidth: i === 0 ? 180 : 140,
                                    }}
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ delay: i * 0.1 + 0.3 }}
                                  >
                                    {node.name.length > 22 ? node.name.slice(0, 22) + "…" : node.name}
                                  </motion.span>
                                </motion.div>
                              ))
                            : null}
                        </>
                      );
                    })()}
                  </div>

                  <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/80 border-t border-violet-500/20">
                    <span className="text-xs text-zinc-400">
                      {obsidianResultsCount > 0 ? `${obsidianResultsCount} notes` : "No results"}
                    </span>
                    <span className="text-xs text-zinc-500">Esc to close</span>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>,
          document.body
        )}

      {/* Expanded content (when manually expanded) */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className="border-t border-white/5">
              {/* Files agent: show upload button */}
              {isFilesAgent && (
                <div className="p-4">
                  {filesAgentConfigured ? (
                    <button
                      onClick={onOpenFilesPanel}
                      className="w-full py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm hover:bg-amber-500/20 transition-colors flex items-center justify-center gap-2"
                    >
                      <FolderOpen className="w-4 h-4" />
                      Open Files Chat
                    </button>
                  ) : (
                    <button
                      onClick={onSetupFilesAgent}
                      className="w-full py-3 rounded-xl border border-dashed border-white/20 text-zinc-500 text-sm hover:border-amber-500/50 hover:text-amber-400 transition-colors flex items-center justify-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      Setup Files Agent
                    </button>
                  )}
                </div>
              )}

              {/* Obsidian agent: show local connection status */}
              {isObsidianAgent && (
                <div className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-zinc-500">Local Machine</span>
                    <div className={`flex items-center gap-1.5 text-xs ${isLocalConnected ? "text-emerald-400" : "text-zinc-500"}`}>
                      <div className={`w-2 h-2 rounded-full ${isLocalConnected ? "bg-emerald-400" : "bg-zinc-600"}`} />
                      {isLocalConnected ? "Connected" : "Disconnected"}
                    </div>
                  </div>
                  {obsidianConfigured && isLocalConnected ? (
                    <div className="space-y-3">
                      {(runningContext?.obsidianResults?.length ?? 0) > 0 ? (
                        <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-violet-300">Last graph</span>
                            <span className="text-[10px] text-zinc-500">
                              {runningContext?.obsidianResults?.length} notes
                            </span>
                          </div>
                          <div className="space-y-1">
                            {runningContext!.obsidianResults!.slice(0, 5).map((n) => (
                              <div key={n.path} className="flex items-center justify-between gap-2">
                                <span className="text-xs text-zinc-300 truncate">{n.name}</span>
                                {typeof n.matches === "number" && (
                                  <span className="text-[10px] text-zinc-500 shrink-0">
                                    {n.matches} hits
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-3 text-xs text-zinc-500">
                          Run <span className="text-zinc-300">@obsidian</span> in chat to generate your constellation graph.
                        </div>
                      )}
                      <div className="text-[11px] text-zinc-500">
                        Tip: click the Obsidian card header to collapse/expand the constellation.
                      </div>
                    </div>
                  ) : obsidianConfigured && !isLocalConnected ? (
                    <div className="text-center py-3 text-xs text-zinc-500">
                      Start the Groovy connector on your machine to access Obsidian
                    </div>
                  ) : (
                    <button
                      onClick={onSetupObsidian}
                      className="w-full py-3 rounded-xl border border-dashed border-white/20 text-zinc-500 text-sm hover:border-purple-500/50 hover:text-purple-400 transition-colors flex items-center justify-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      Setup Obsidian
                    </button>
                  )}
                </div>
              )}

              {/* Data agent: show connections summary */}
              {isDataAgent && (
                <div className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-zinc-500">Connected Platforms</span>
                    {onOpenDataPanel && (
                      <button
                        onClick={onOpenDataPanel}
                        className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                      >
                        Manage
                      </button>
                    )}
                  </div>
                  {hasDataConnections ? (
                    <DataConnectionBadges connections={dataConnections!} maxVisible={6} expanded={true} />
                  ) : (
                    <button
                      onClick={onOpenDataPanel}
                      className="w-full py-3 rounded-xl border border-dashed border-white/20 text-zinc-500 text-sm hover:border-emerald-500/50 hover:text-emerald-400 transition-colors flex items-center justify-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      Add your first integration
                    </button>
                  )}
                </div>
              )}

              {/* Browser agent expanded state */}
              {agent === "browser" && (
                <div className="p-4">
                  <p className="text-xs text-zinc-500 text-center py-3">
                    Use @browser in chat to browse the web
                  </p>
                </div>
              )}

              {/* Schedule agent: list + manage jobs */}
              {isScheduleAgent && (
                <div className="p-4">
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-zinc-500">Recent runs</span>
                      <button
                        onClick={() => {
                          refreshSchedules().catch(() => {});
                          refreshScheduleRuns().catch(() => {});
                        }}
                        disabled={scheduleLoading || scheduleRunsLoading}
                        className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
                      >
                        {scheduleLoading || scheduleRunsLoading ? "Loading..." : "Refresh"}
                      </button>
                    </div>

                    {scheduleRunsError ? (
                      <div className="text-xs text-red-400">{scheduleRunsError}</div>
                    ) : null}

                    {scheduleRuns.length === 0 && !scheduleRunsLoading ? (
                      <div className="text-center py-2 text-xs text-zinc-600">
                        No runs yet — the connector will log them here once schedules fire.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {scheduleRuns.slice(0, 10).map((r) => {
                          const job = scheduleJobs.find((j) => j.id === r.job_id);
                          const jobName = job?.name || "Scheduled task";
                          const status = String(r.status || "unknown");
                          const isOpen = openRunId === r.id;
                          const statusClasses =
                            status === "success"
                              ? "border-emerald-500/30 text-emerald-300 bg-emerald-500/10"
                              : status === "skipped"
                                ? "border-amber-500/30 text-amber-300 bg-amber-500/10"
                                : "border-red-500/30 text-red-300 bg-red-500/10";

                          const dur =
                            typeof r.duration_ms === "number" && Number.isFinite(r.duration_ms)
                              ? `${Math.round(r.duration_ms)}ms`
                              : null;

                          const output = (r.stdout || r.stderr || r.error || "").trim();
                          const preview =
                            output.length > 160 ? output.slice(0, 160).trimEnd() + "…" : output;

                          return (
                            <div
                              key={r.id}
                              className="rounded-xl border border-white/10 bg-black/20 p-3"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`text-[10px] px-2 py-0.5 rounded-full border ${statusClasses}`}
                                    >
                                      {status}
                                    </span>
                                    {dur ? (
                                      <span className="text-[10px] text-zinc-500">{dur}</span>
                                    ) : null}
                                  </div>
                                  <div className="text-sm text-white font-medium truncate mt-1">
                                    {jobName}
                                  </div>
                                  {preview ? (
                                    <div className="text-[11px] text-zinc-500 mt-1 font-mono whitespace-pre-wrap break-words">
                                      {preview}
                                    </div>
                                  ) : (
                                    <div className="text-[11px] text-zinc-600 mt-1">
                                      (no output)
                                    </div>
                                  )}
                                </div>

                                <div className="flex flex-col gap-1 shrink-0">
                                  <button
                                    onClick={() => setOpenRunId((prev) => (prev === r.id ? null : r.id))}
                                    className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 transition-colors"
                                  >
                                    {isOpen ? "Hide" : "Details"}
                                  </button>
                                  {output ? (
                                    <button
                                      onClick={async () => {
                                        try {
                                          await navigator.clipboard.writeText(output);
                                        } catch {
                                          // ignore
                                        }
                                      }}
                                      className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 transition-colors inline-flex items-center justify-center gap-1"
                                      title="Copy output"
                                    >
                                      <Copy className="w-3 h-3" />
                                      Copy
                                    </button>
                                  ) : null}
                                </div>
                              </div>

                              {isOpen ? (
                                <div className="mt-3 grid gap-2">
                                  {r.stdout ? (
                                    <div className="rounded-lg border border-white/10 bg-black/30 p-2">
                                      <div className="text-[10px] text-zinc-500 mb-1">stdout</div>
                                      <div className="text-[11px] text-zinc-200 font-mono whitespace-pre-wrap break-words">
                                        {r.stdout}
                                      </div>
                                    </div>
                                  ) : null}
                                  {r.stderr ? (
                                    <div className="rounded-lg border border-white/10 bg-black/30 p-2">
                                      <div className="text-[10px] text-zinc-500 mb-1">stderr</div>
                                      <div className="text-[11px] text-zinc-200 font-mono whitespace-pre-wrap break-words">
                                        {r.stderr}
                                      </div>
                                    </div>
                                  ) : null}
                                  {r.error ? (
                                    <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-2">
                                      <div className="text-[10px] text-red-300 mb-1">error</div>
                                      <div className="text-[11px] text-red-200 font-mono whitespace-pre-wrap break-words">
                                        {r.error}
                                      </div>
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-zinc-500">Scheduled jobs</span>
                    <button
                      onClick={() => {
                        refreshSchedules().catch(() => {});
                        refreshScheduleRuns().catch(() => {});
                      }}
                      disabled={scheduleLoading || scheduleRunsLoading}
                      className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
                    >
                      {scheduleLoading || scheduleRunsLoading ? "Loading..." : "Refresh"}
                    </button>
                  </div>

                  {scheduleError ? (
                    <div className="text-xs text-red-400">{scheduleError}</div>
                  ) : null}

                  {scheduleJobs.length === 0 && !scheduleLoading ? (
                    <div className="text-center py-3 text-xs text-zinc-500">
                      Create one in chat: <span className="text-zinc-300">@schedule</span> every day at 7:30 run &quot;...&quot;
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {scheduleJobs.slice(0, 20).map((j) => (
                        <div
                          key={j.id}
                          className="rounded-xl border border-white/10 bg-black/20 p-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              {(() => {
                                const s = getJobSummary(j);
                                return (
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/10 text-zinc-400 bg-white/5">
                                      {s.label}
                                    </span>
                                  </div>
                                );
                              })()}
                              <div className="flex items-center gap-2">
                                <span className="text-sm text-white font-medium truncate">
                                  {j.name || "Scheduled task"}
                                </span>
                                <span
                                  className={`text-[10px] px-2 py-0.5 rounded-full border ${
                                    j.enabled
                                      ? "border-emerald-500/30 text-emerald-300 bg-emerald-500/10"
                                      : "border-zinc-600/40 text-zinc-400 bg-white/5"
                                  }`}
                                >
                                  {j.enabled ? "enabled" : "paused"}
                                </span>
                                {j.skip_next_run ? (
                                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-amber-500/30 text-amber-300 bg-amber-500/10">
                                    skip next
                                  </span>
                                ) : null}
                              </div>
                              <div className="text-[11px] text-zinc-500 mt-1">
                                <span className="text-zinc-400">{formatSchedule(j.schedule)}</span>
                                {j.last_run_at ? (
                                  <>
                                    {" · "}
                                    last:{" "}
                                    <span className="text-zinc-400">
                                      {j.last_status || "unknown"}
                                    </span>
                                  </>
                                ) : null}
                              </div>
                              {(() => {
                                const s = getJobSummary(j);
                                return (
                                  <div className="text-[11px] text-zinc-600 mt-1 truncate">
                                    {s.detail}
                                  </div>
                                );
                              })()}
                            </div>

<div className="flex flex-col gap-1 shrink-0">
                                              {onTriggerScheduledJob && (
                                                <button
                                                  onClick={() => onTriggerScheduledJob(j.id)}
                                                  disabled={scheduleLoading || runningScheduledJobIds?.has(j.id)}
                                                  className={`text-[11px] px-2 py-1 rounded-lg border transition-colors flex items-center gap-1 ${
                                                    runningScheduledJobIds?.has(j.id)
                                                      ? "bg-blue-500/20 border-blue-500/30 text-blue-300"
                                                      : "bg-emerald-500/10 border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/20"
                                                  } disabled:opacity-70`}
                                                  title={runningScheduledJobIds?.has(j.id) ? "Job is running..." : "Run this job now (manually trigger)"}
                                                >
                                                  {runningScheduledJobIds?.has(j.id) ? (
                                                    <>
                                                      <Loader2 className="w-3 h-3 animate-spin" />
                                                      Running...
                                                    </>
                                                  ) : (
                                                    <>
                                                      <PlayCircle className="w-3 h-3" />
                                                      Run Now
                                                    </>
                                                  )}
                                                </button>
                                              )}
                                              <button
                                                onClick={() =>
                                                  updateScheduleJob(j.id, { skip_next_run: true })
                                                }
                                                disabled={scheduleLoading || !j.enabled}
                                                className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 disabled:opacity-50 transition-colors"
                                                title="Cancel the next run (skip once)"
                                              >
                                                Cancel next
                                              </button>
                                              <button
                                                onClick={() =>
                                                  updateScheduleJob(j.id, { enabled: !j.enabled })
                                                }
                                                disabled={scheduleLoading}
                                                className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 disabled:opacity-50 transition-colors"
                                              >
                                                {j.enabled ? "Pause" : "Resume"}
                                              </button>
                                              <button
                                                onClick={async () => {
                                                  const ok = window.confirm(
                                                    "Delete this scheduled job? This cannot be undone."
                                                  );
                                                  if (!ok) return;
                                                  await deleteScheduleJob(j.id);
                                                }}
                                                disabled={scheduleLoading}
                                                className="text-[11px] px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 hover:bg-red-500/20 disabled:opacity-50 transition-colors"
                                              >
                                                Delete
                                              </button>
                                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
