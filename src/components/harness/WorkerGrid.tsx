"use client";

/**
 * WorkerGrid — the heart of the harness: your agents, side by side, working.
 *
 * Pane = worker agent. Includes the "hire your first agent" empty state and
 * the add-agent tile.
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  Check,
  LayoutGrid,
  Plus,
  Search,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import { WorkerTile } from "@/components/harness/WorkerTile";
import type { useRelay } from "@/hooks/useRelay";
import type { WorkerAgentInfo } from "@/hooks/useWorkerAgents";
import type { WorkerPane } from "@/hooks/useWorkerGrid";
import type { AgentTask } from "@/hooks/useAgentTasks";

export function WorkerGrid({
  panes,
  agents,
  openByAgent,
  gridCols,
  sharedRelay,
  onAddAgent,
  onShowAgent,
  onHideAgent,
  onGridColsChange,
  onConfigure,
  onTransferContext,
  onMovePane,
  onRemovePane,
  onFocusedAgentChange,
}: {
  panes: WorkerPane[];
  agents: WorkerAgentInfo[];
  openByAgent: Map<string, AgentTask[]>;
  gridCols: number | null;
  sharedRelay?: ReturnType<typeof useRelay>;
  onAddAgent: () => void;
  onShowAgent: (agentId: string) => void;
  onHideAgent: (agentId: string) => void;
  onGridColsChange: (cols: number | null) => void;
  onConfigure: (agentId: string) => void;
  onTransferContext: (agentId: string) => void;
  onMovePane: (paneId: string, direction: -1 | 1) => void;
  onRemovePane: (paneId: string) => void;
  onFocusedAgentChange: (focused: boolean) => void;
}) {
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const visiblePanes = useMemo(
    () => panes.filter((p) => agentById.has(p.agentId)),
    [panes, agentById]
  );
  const visibleAgentIds = useMemo(
    () => new Set(visiblePanes.map((pane) => pane.agentId)),
    [visiblePanes]
  );
  const filteredAgents = useMemo(() => {
    const needle = agentSearch.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter((agent) =>
      [agent.name, agent.harness, agent.workspaceRootPath || ""]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [agents, agentSearch]);

  const cols =
    gridCols ||
    (visiblePanes.length <= 1 ? 1 : visiblePanes.length === 2 ? 2 : visiblePanes.length <= 6 ? 3 : 4);

  const activeFocusedPaneId = visiblePanes.some((pane) => pane.id === focusedPaneId)
    ? focusedPaneId
    : null;

  useEffect(() => {
    onFocusedAgentChange(activeFocusedPaneId !== null);
  }, [activeFocusedPaneId, onFocusedAgentChange]);

  useEffect(() => {
    if (!focusedPaneId) return;
    const exitFocusedView = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFocusedPaneId(null);
      }
    };
    window.addEventListener("keydown", exitFocusedView);
    return () => window.removeEventListener("keydown", exitFocusedView);
  }, [focusedPaneId]);

  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-x-clip">
      {/* Workspace controls — roster visibility and pane density live together. */}
      {!activeFocusedPaneId && (
      <div className="relative z-40 shrink-0 px-3 pt-3">
        <div className="flex min-h-11 items-center gap-2 rounded-xl border border-white/[0.07] bg-zinc-950/70 px-3 shadow-sm backdrop-blur-xl">
          <div className="flex min-w-0 items-center gap-2">
            <LayoutGrid className="h-4 w-4 shrink-0 text-cyan-300" />
            <div className="hidden min-w-0 sm:block">
              <div className="text-xs font-medium text-zinc-200">Workspace layout</div>
              <div className="text-[10px] text-zinc-600">
                {visiblePanes.length} visible · {agents.length} total
              </div>
            </div>
          </div>

          <div className="ml-auto hidden items-center gap-1 rounded-lg border border-white/[0.06] bg-black/30 p-1 md:flex">
            <span className="px-1.5 text-[10px] text-zinc-600">Columns</span>
            {([null, 2, 3, 4] as const).map((value) => (
              <button
                key={value ?? "auto"}
                type="button"
                onClick={() => onGridColsChange(value)}
                className={`h-6 min-w-7 rounded-md px-1.5 text-[10px] font-medium transition-colors ${
                  gridCols === value
                    ? "bg-cyan-500/15 text-cyan-200"
                    : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
                }`}
                title={value === null ? "Automatic columns" : `${value} columns`}
              >
                {value ?? "Auto"}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setAgentPanelOpen((open) => !open)}
            className={`inline-flex h-8 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors ${
              agentPanelOpen
                ? "border-cyan-500/30 bg-cyan-500/15 text-cyan-100"
                : "border-white/[0.08] bg-white/[0.03] text-zinc-300 hover:border-white/15 hover:bg-white/[0.06]"
            }`}
          >
            <Users className="h-3.5 w-3.5" />
            Agents
            <span className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {visiblePanes.length}/{agents.length}
            </span>
          </button>

          <button
            type="button"
            onClick={onAddAgent}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-cyan-500 px-3 text-xs font-semibold text-black transition-colors hover:bg-cyan-400"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New agent</span>
          </button>
        </div>

        <AnimatePresence>
          {agentPanelOpen && (
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.16 }}
              className="absolute right-3 top-[3.75rem] w-[min(430px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur-2xl"
            >
              <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10">
                  <SlidersHorizontal className="h-4 w-4 text-cyan-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-white">Configure panes</div>
                  <div className="text-[11px] text-zinc-500">
                    Choose which agents appear in this workspace
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setAgentPanelOpen(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-white"
                  aria-label="Close agent pane configuration"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                  <input
                    value={agentSearch}
                    onChange={(event) => setAgentSearch(event.target.value)}
                    placeholder="Search agents or workspaces…"
                    autoFocus
                    className="h-9 w-full rounded-lg border border-white/[0.08] bg-black/40 pl-9 pr-3 text-xs text-white outline-none placeholder:text-zinc-700 focus:border-cyan-500/30"
                  />
                </div>
              </div>

              <div className="touch-scroll-y max-h-[min(430px,55dvh)] px-2 pb-2">
                {filteredAgents.length === 0 ? (
                  <div className="px-3 py-10 text-center text-xs text-zinc-600">
                    No agents match “{agentSearch}”.
                  </div>
                ) : (
                  filteredAgents.map((agent) => {
                    const visible = visibleAgentIds.has(agent.id);
                    const workspaceName = agent.workspaceRootPath
                      ? agent.workspaceRootPath.split(/[\\/]/).filter(Boolean).pop()
                      : "No workspace";
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() =>
                          visible ? onHideAgent(agent.id) : onShowAgent(agent.id)
                        }
                        className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                          visible ? "bg-cyan-500/[0.08]" : "hover:bg-white/[0.04]"
                        }`}
                      >
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold ${
                            visible
                              ? "border-cyan-500/30 bg-cyan-500/15 text-cyan-200"
                              : "border-white/[0.08] bg-white/[0.03] text-zinc-500"
                          }`}
                        >
                          {agent.name.trim().charAt(0).toUpperCase() || "A"}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-xs font-medium text-zinc-200">
                              {agent.name}
                            </span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
                                agent.harness === "codex"
                                  ? "bg-emerald-500/10 text-emerald-300"
                                  : "bg-orange-500/10 text-orange-300"
                              }`}
                            >
                              {agent.harness}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-[10px] text-zinc-600">
                            {workspaceName}
                          </span>
                        </span>
                        <span
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                            visible
                              ? "border-cyan-500/40 bg-cyan-500/20 text-cyan-200"
                              : "border-white/10 text-transparent group-hover:border-white/20"
                          }`}
                        >
                          <Check className="h-3 w-3" />
                        </span>
                      </button>
                    );
                  })
                )}
              </div>

              <div className="flex items-center justify-between border-t border-white/[0.07] px-4 py-2.5 text-[10px] text-zinc-600">
                <span>{visiblePanes.length} panes visible</span>
                <span>{agents.length} agents saved</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      )}

      {visiblePanes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="w-full max-w-md text-center"
          >
            <div className="relative mx-auto mb-5 h-16 w-16">
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-violet-500/20 blur-xl" />
              <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-zinc-900/80">
                <Bot className="h-7 w-7 text-cyan-300" />
              </div>
            </div>
            <h2 className="mb-2 text-lg font-semibold text-white">
              {agents.length > 0 ? "Choose agents for this workspace" : "Build your agent workforce"}
            </h2>
            <p className="mb-5 text-sm leading-relaxed text-zinc-500">
              {agents.length > 0
                ? `All ${agents.length} agents are saved. Open Agents above and choose which panes you want visible.`
                : "Create a Claude Code or Codex worker, give it a workspace, and let the orchestrator assign it work."}
            </p>
            <button
              type="button"
              onClick={() => (agents.length > 0 ? setAgentPanelOpen(true) : onAddAgent())}
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-cyan-400 px-4 text-sm font-semibold text-black transition-colors hover:bg-cyan-300"
            >
              {agents.length > 0 ? <Users className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {agents.length > 0 ? "Choose existing agents" : "Create your first agent"}
            </button>
          </motion.div>
        </div>
      ) : (
        <div
          className="worker-grid-responsive touch-scroll-y grid w-full min-h-0 min-w-0 flex-1 gap-3 p-3 auto-rows-fr"
          style={{
            gridTemplateColumns: `repeat(${Math.min(cols, Math.max(visiblePanes.length, 1))}, minmax(0, 1fr))`,
            gridAutoRows: visiblePanes.length > cols ? "minmax(360px, 1fr)" : "minmax(0, 1fr)",
          }}
        >
          <AnimatePresence mode="popLayout">
            {visiblePanes.map((pane, index) => {
              const agent = agentById.get(pane.agentId)!;
              return (
                <WorkerTile
                  key={pane.id}
                  agent={agent}
                  openTasks={openByAgent.get(agent.id) || []}
                  sharedRelay={sharedRelay}
                  onConfigure={() => onConfigure(agent.id)}
                  onTransferContext={() => onTransferContext(agent.id)}
                  onMove={(direction) => onMovePane(pane.id, direction)}
                  onClose={() => {
                    if (activeFocusedPaneId === pane.id) {
                      setFocusedPaneId(null);
                    }
                    onRemovePane(pane.id);
                  }}
                  isFocused={activeFocusedPaneId === pane.id}
                  onToggleFocus={() => {
                    const next = activeFocusedPaneId === pane.id ? null : pane.id;
                    setFocusedPaneId(next);
                  }}
                  canMoveLeft={index > 0}
                  canMoveRight={index < visiblePanes.length - 1}
                />
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
