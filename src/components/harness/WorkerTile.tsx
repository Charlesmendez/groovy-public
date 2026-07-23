"use client";

/**
 * WorkerTile — one worker agent in the harness grid.
 *
 * Header: identity (emoji/monogram + name), harness + model chips, live
 * status (from agent_tasks), actions (configure, move, close).
 * Body: the embedded Code Agent chat panel (ClaudeCliChatPanel), which owns
 * its own relay/session state and streams the agent's work live.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Loader2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Settings2,
  ShieldAlert,
  X,
} from "lucide-react";
import { ClaudeCliChatPanel } from "@/components/claude/ClaudeCliChatPanel";
import type { useRelay } from "@/hooks/useRelay";
import type { WorkerAgentInfo } from "@/hooks/useWorkerAgents";
import type { AgentTask } from "@/hooks/useAgentTasks";

const HARNESS_STYLES: Record<
  "claude" | "codex",
  { label: string; chip: string; ring: string }
> = {
  claude: {
    label: "Claude Code",
    chip: "bg-orange-500/10 text-orange-300 border-orange-500/20",
    ring: "ring-orange-400/30",
  },
  codex: {
    label: "Codex",
    chip: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
    ring: "ring-emerald-400/30",
  },
};

function shortPath(path: string | null): string | null {
  if (!path) return null;
  const clean = path.replace(/\/+$/, "");
  const parts = clean.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : clean;
}

function DelegatedRunProgress({
  task,
  expanded,
}: {
  task: AgentTask;
  expanded: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const meta = (task.result_meta || {}) as {
    live_text?: unknown;
    live_text_truncated?: unknown;
    live_tools?: unknown;
  };
  const liveText =
    typeof meta.live_text === "string" ? meta.live_text.trimStart() : "";
  const rawLiveTools = meta.live_tools;
  const liveTools = useMemo(
    () =>
      Array.isArray(rawLiveTools)
        ? rawLiveTools
            .filter(
              (item): item is { name: string; input?: string } =>
                !!item &&
                typeof item === "object" &&
                typeof (item as { name?: unknown }).name === "string"
            )
            .slice(-6)
        : [],
    [rawLiveTools]
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [liveText, liveTools]);

  return (
    <div className="shrink-0 border-b border-cyan-400/10 bg-cyan-400/[0.035] px-3 py-2">
      <div className="mb-1.5 flex min-w-0 items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-cyan-300">
          Orchestrator task
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-500">
          {task.title || task.prompt}
        </span>
      </div>
      <div
        ref={scrollRef}
        className={`overflow-y-auto rounded-lg border border-white/5 bg-black/25 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-300 ${
          expanded ? "max-h-[38vh]" : "max-h-36"
        }`}
      >
        {meta.live_text_truncated === true && (
          <div className="mb-1 text-zinc-600">…earlier output hidden…</div>
        )}
        {liveText ? (
          <div className="whitespace-pre-wrap break-words">{liveText}</div>
        ) : (
          <div className="flex items-center gap-1.5 text-zinc-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            Starting delegated work…
          </div>
        )}
        {liveTools.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-white/5 pt-2">
            {liveTools.map((tool, index) => (
              <div
                key={`${tool.name}-${index}-${tool.input || ""}`}
                className="flex min-w-0 items-start gap-1.5 text-[10px]"
              >
                <span className="shrink-0 text-cyan-400">› {tool.name}</span>
                {tool.input && (
                  <span className="min-w-0 break-words text-zinc-500">
                    {tool.input}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const WorkerTile = memo(function WorkerTile({
  agent,
  openTasks,
  sharedRelay,
  onConfigure,
  onTransferContext,
  onMove,
  onClose,
  isFocused,
  onToggleFocus,
  canMoveLeft,
  canMoveRight,
}: {
  agent: WorkerAgentInfo;
  openTasks: AgentTask[];
  sharedRelay?: ReturnType<typeof useRelay>;
  onConfigure: () => void;
  onTransferContext: () => void;
  onMove: (direction: -1 | 1) => void;
  onClose: () => void;
  isFocused: boolean;
  onToggleFocus: () => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const harness = HARNESS_STYLES[agent.harness] || HARNESS_STYLES.claude;

  const running = useMemo(
    () => openTasks.find((t) => t.status === "running"),
    [openTasks]
  );
  const awaitingApproval = useMemo(
    () => openTasks.filter((t) => t.status === "awaiting_approval").length,
    [openTasks]
  );
  const queued = useMemo(
    () => openTasks.filter((t) => t.status === "queued").length,
    [openTasks]
  );

  return (
    <motion.div
      layout={!isFocused}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.18 }}
      className={`flex min-w-0 flex-col min-h-0 rounded-2xl border backdrop-blur overflow-hidden transition-shadow ${
        isFocused
          ? "fixed inset-x-2 bottom-[calc(0.5rem+var(--safe-area-inset-bottom))] top-[calc(0.5rem+var(--safe-area-inset-top))] z-[60] bg-zinc-950 shadow-2xl shadow-black/80 md:inset-4"
          : "relative w-full bg-zinc-900/50"
      } ${
        running
          ? "border-cyan-400/30 shadow-[0_0_24px_rgba(0,240,255,0.06)]"
          : "border-white/10"
      }`}
      style={agent.color ? { borderColor: `${agent.color}44` } : undefined}
    >
      {/* Running beam */}
      {running && (
        <div className="absolute top-0 left-0 right-0 h-[2px] overflow-hidden">
          <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-[harness-beam_1.6s_linear_infinite]" />
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-black/20">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center text-sm shrink-0"
          style={{ background: agent.color ? `${agent.color}22` : "rgba(255,255,255,0.06)" }}
        >
          {agent.emoji || agent.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-white truncate">{agent.name}</span>
            {running ? (
              <span className="flex items-center gap-1 text-[10px] text-cyan-300">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                working
              </span>
            ) : queued > 0 ? (
              <span className="text-[10px] text-zinc-400">{queued} queued</span>
            ) : null}
            {awaitingApproval > 0 && (
              <span
                className="flex items-center gap-0.5 text-[10px] text-amber-300"
                title="Tasks awaiting your approval"
              >
                <ShieldAlert className="w-2.5 h-2.5" />
                {awaitingApproval}
              </span>
            )}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden">
            <span
              className={`shrink-0 whitespace-nowrap text-[9px] px-1.5 py-px rounded border ${harness.chip}`}
            >
              {harness.label}
            </span>
            {agent.model && (
              <span
                className="max-w-36 shrink-0 truncate whitespace-nowrap rounded border border-white/10 bg-white/5 px-1.5 py-px text-[9px] text-zinc-400"
                title={agent.model}
              >
                {agent.model}
              </span>
            )}
            {agent.reasoningEffort && (
              <span className="hidden shrink-0 items-center gap-1 whitespace-nowrap rounded border border-cyan-500/15 bg-cyan-500/[0.07] px-1.5 py-px text-[9px] text-cyan-300 sm:flex">
                <Gauge className="h-2.5 w-2.5" />
                {agent.reasoningEffort === "xhigh"
                  ? "Extra high"
                  : agent.reasoningEffort.charAt(0).toUpperCase() +
                    agent.reasoningEffort.slice(1)}
              </span>
            )}
            {agent.workspaceRootPath && (
              <span
                className="hidden min-w-0 max-w-32 truncate whitespace-nowrap text-[9px] text-zinc-600 lg:inline"
                title={agent.workspaceRootPath}
              >
                {shortPath(agent.workspaceRootPath)}
              </span>
            )}
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onToggleFocus}
            className="flex h-7 w-7 !min-h-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/10 hover:text-white"
            title={isFocused ? "Exit focused view" : "Focus this agent"}
            aria-label={isFocused ? "Exit focused agent view" : `Focus ${agent.name}`}
          >
            {isFocused ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={onConfigure}
            className="flex h-7 w-7 !min-h-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/10 hover:text-white"
            title="Configure agent (skills, integrations, model)"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <div className="relative">
            <button
              onClick={() => setShowMenu((v) => !v)}
              className="flex h-7 w-7 !min-h-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/10 hover:text-white"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {showMenu && (
              <>
                <div
                  className="fixed inset-0 z-20"
                  onClick={() => setShowMenu(false)}
                />
                <div className="absolute right-0 top-full mt-1 w-48 rounded-xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-2xl overflow-hidden z-30">
                  <button
                    onClick={() => {
                      setShowMenu(false);
                      onTransferContext();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-zinc-200 hover:bg-white/5"
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5 text-zinc-400" />
                    Move context to…
                  </button>
                  <div className="flex border-t border-white/5">
                    <button
                      disabled={!canMoveLeft}
                      onClick={() => {
                        setShowMenu(false);
                        onMove(-1);
                      }}
                      className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-xs text-zinc-400 hover:bg-white/5 disabled:opacity-30"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" /> Move
                    </button>
                    <button
                      disabled={!canMoveRight}
                      onClick={() => {
                        setShowMenu(false);
                        onMove(1);
                      }}
                      className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-xs text-zinc-400 hover:bg-white/5 disabled:opacity-30 border-l border-white/5"
                    >
                      Move <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 !min-h-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/10 hover:text-white"
            title="Remove from grid (agent is kept)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {running && <DelegatedRunProgress task={running} expanded={isFocused} />}

      {/* Body: embedded code agent chat */}
      <div className="flex min-h-0 min-w-0 flex-1">
        <ClaudeCliChatPanel
          agentId={agent.id}
          agentName={agent.name}
          codeCliProvider={agent.harness}
          embedded
          sharedRelay={sharedRelay}
        />
      </div>
    </motion.div>
  );
});
