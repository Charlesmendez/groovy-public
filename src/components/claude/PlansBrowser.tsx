"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  X,
  FileText,
  Play,
  Plus,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Clock,
  Loader2,
  WifiOff,
  Inbox,
  Network,
} from "lucide-react";
import type { ClaudePlan } from "@/hooks/useClaudePlans";
import { canonicalWorkspacePath } from "@/lib/workspaces/path";

type CodeAgentOption = {
  id: string;
  name: string;
  codeCliProvider?: "claude" | "codex";
  deviceId?: string | null;
  workspaceRootPath?: string | null;
};

type PlansBrowserProps = {
  plans: ClaudePlan[];
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  codeAgents: CodeAgentOption[];
  onExecute: (
    plan: ClaudePlan,
    target: { type: "orchestrator" } | { type: "agent"; agentId: string } | { type: "new_agent" }
  ) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
};

type ProviderFilter = "all" | "claude" | "codex";

const PLAN_PAGE_SIZE = 50;

function timeAgo(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function workspaceLabel(root: string): string {
  const parts = root.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || root;
}

function planPreview(content: string): string {
  const lines = content.split("\n");
  const start = lines[0]?.startsWith("#") ? 1 : 0;
  const text = lines
    .slice(start)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
  return text.length > 200 ? text.slice(0, 200) + "..." : text;
}

function planProvider(plan: ClaudePlan): "claude" | "codex" {
  return plan.provider === "codex" ? "codex" : "claude";
}

function planProviderLabel(plan: ClaudePlan): string {
  return planProvider(plan) === "codex" ? "Codex" : "Claude";
}

export function PlansBrowser({
  plans,
  isLoading,
  error,
  onRefresh,
  codeAgents,
  onExecute,
  onClose,
}: PlansBrowserProps) {
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [visibleCount, setVisibleCount] = useState(PLAN_PAGE_SIZE);
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());
  const [executeMenuPlanId, setExecuteMenuPlanId] = useState<string | null>(null);
  const [executingPlanId, setExecutingPlanId] = useState<string | null>(null);
  const [executionErrors, setExecutionErrors] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  // Close execute menu on outside click
  useEffect(() => {
    if (!executeMenuPlanId) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setExecuteMenuPlanId(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [executeMenuPlanId]);

  // Keyboard: Escape to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (executeMenuPlanId) {
          setExecuteMenuPlanId(null);
        } else if (expandedPlanId) {
          setExpandedPlanId(null);
        } else {
          onClose();
        }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [executeMenuPlanId, expandedPlanId, onClose]);

  const planId = useCallback(
    (p: ClaudePlan) =>
      `${planProvider(p)}::${p.workspaceRoot}::${p.sessionId || p.sourcePath || p.filename}`,
    []
  );

  const providerCounts = useMemo(() => {
    let claude = 0;
    let codex = 0;
    for (const plan of plans) {
      if (planProvider(plan) === "codex") codex += 1;
      else claude += 1;
    }
    return { all: plans.length, claude, codex };
  }, [plans]);

  const filtered = useMemo(() => {
    const providerPlans =
      providerFilter === "all" ? plans : plans.filter((plan) => planProvider(plan) === providerFilter);
    const sortedPlans = [...providerPlans].sort(
      (a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
    );
    if (!query.trim()) return sortedPlans;
    const q = query.toLowerCase();
    return sortedPlans.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.filename.toLowerCase().includes(q) ||
        p.content.toLowerCase().includes(q) ||
        planProviderLabel(p).toLowerCase().includes(q) ||
        workspaceLabel(p.workspaceRoot).toLowerCase().includes(q)
    );
  }, [plans, providerFilter, query]);

  const visiblePlans = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount]
  );

  const hiddenCount = Math.max(0, filtered.length - visiblePlans.length);

  const grouped = useMemo(() => {
    const map = new Map<string, ClaudePlan[]>();
    for (const p of visiblePlans) {
      const arr = map.get(p.workspaceRoot) || [];
      arr.push(p);
      map.set(p.workspaceRoot, arr);
    }
    // Sort groups by most recently modified plan
    return [...map.entries()].sort((a, b) => {
      const latestA = Math.max(...a[1].map((p) => new Date(p.modifiedAt).getTime() || 0));
      const latestB = Math.max(...b[1].map((p) => new Date(p.modifiedAt).getTime() || 0));
      return latestB - latestA;
    });
  }, [visiblePlans]);

  const toggleWorkspace = useCallback((root: string) => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  }, []);

  const resetPlanListView = useCallback(() => {
    setVisibleCount(PLAN_PAGE_SIZE);
    setExpandedPlanId(null);
    setExecuteMenuPlanId(null);
  }, []);

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      resetPlanListView();
    },
    [resetPlanListView]
  );

  const handleProviderFilterChange = useCallback(
    (nextFilter: ProviderFilter) => {
      setProviderFilter(nextFilter);
      resetPlanListView();
    },
    [resetPlanListView]
  );

  const handleExecute = useCallback(
    async (
      plan: ClaudePlan,
      target: { type: "orchestrator" } | { type: "agent"; agentId: string } | { type: "new_agent" }
    ) => {
      const id = planId(plan);
      setExecuteMenuPlanId(null);
      setExecutingPlanId(id);
      setExecutionErrors((prev) => ({ ...prev, [id]: "" }));
      try {
        const result = await onExecute(plan, target);
        if (!result.ok) {
          setExecutionErrors((prev) => ({
            ...prev,
            [id]: result.error || "Could not queue this plan",
          }));
        }
      } finally {
        setExecutingPlanId(null);
      }
    },
    [onExecute, planId]
  );

  return (
    <div
      ref={panelRef}
      className="flex flex-col h-full bg-zinc-900 text-white"
    >
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-white/5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-zinc-100">Plans</h2>
            {!isLoading && plans.length > 0 && (
              <span className="text-[10px] font-medium text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded-full">
                {plans.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors disabled:opacity-50"
              title="Refresh plans"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Search plans..."
            className="w-full pl-8 pr-3 py-2 text-sm bg-zinc-800/60 border border-white/5 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/30 focus:ring-1 focus:ring-cyan-500/20 transition-colors"
          />
          {query && (
            <button
              type="button"
              onClick={() => handleQueryChange("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-500 hover:text-zinc-300"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Provider filter */}
        <div className="mt-3 grid grid-cols-3 rounded-lg bg-zinc-950/40 border border-white/5 p-0.5">
          {([
            ["all", "All", providerCounts.all],
            ["claude", "Claude", providerCounts.claude],
            ["codex", "Codex", providerCounts.codex],
          ] as const).map(([value, label, count]) => {
            const active = providerFilter === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => handleProviderFilterChange(value)}
                className={`min-w-0 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${
                  active
                    ? "bg-zinc-800 text-zinc-100 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03]"
                }`}
              >
                <span className="truncate">{label}</span>
                <span className="ml-1 text-[10px] text-zinc-600">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading && plans.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-500">
            <Loader2 className="w-6 h-6 animate-spin text-cyan-400/50" />
            <p className="text-xs">Scanning workspaces for plans...</p>
          </div>
        ) : error && plans.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-500 px-6">
            <WifiOff className="w-6 h-6 text-zinc-600" />
            <p className="text-xs text-center">{error}</p>
            <button
              type="button"
              onClick={onRefresh}
              className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              Try again
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-500 px-6">
            <Inbox className="w-6 h-6 text-zinc-600" />
            <p className="text-xs text-center">
              {query
                ? "No plans match your search"
                : providerFilter === "codex"
                  ? "No Codex plans found"
                  : providerFilter === "claude"
                    ? "No Claude plans found"
                    : "No plans found in any workspace"}
            </p>
            {!query && (
              <p className="text-[10px] text-zinc-600 text-center">
                Plans are loaded from Claude Code plan files and Codex session history
              </p>
            )}
          </div>
        ) : (
          <div className="py-2">
            {grouped.map(([root, groupPlans]) => {
              const isCollapsed = collapsedWorkspaces.has(root);
              return (
                <div key={root} className="mb-1">
                  {/* Workspace header */}
                  <button
                    type="button"
                    onClick={() => toggleWorkspace(root)}
                    className="w-full flex items-center gap-2 px-4 py-1.5 text-left hover:bg-white/[0.02] transition-colors"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="w-3 h-3 text-zinc-600 shrink-0" />
                    ) : (
                      <ChevronDown className="w-3 h-3 text-zinc-600 shrink-0" />
                    )}
                    <FolderOpen className="w-3 h-3 text-zinc-500 shrink-0" />
                    <span className="text-[11px] font-medium text-zinc-400 truncate">
                      {workspaceLabel(root)}
                    </span>
                    <span className="text-[10px] text-zinc-600 shrink-0">{groupPlans.length}</span>
                  </button>

                  {/* Plan cards */}
                  {!isCollapsed && (
                    <div className="px-2">
                      {groupPlans
                        .sort(
                          (a, b) =>
                            new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
                        )
                        .map((plan) => {
                          const id = planId(plan);
                          const isExpanded = expandedPlanId === id;
                          const isMenuOpen = executeMenuPlanId === id;
                          const provider = planProvider(plan);
                          const providerLabel = planProviderLabel(plan);
                          const planWorkspace = canonicalWorkspacePath(plan.workspaceRoot);
                          const agentsWithCompatibility = codeAgents.map((agent) => ({
                            ...agent,
                            compatible:
                              !!planWorkspace &&
                              canonicalWorkspacePath(agent.workspaceRootPath) === planWorkspace,
                          }));
                          const matchingAgents = agentsWithCompatibility.filter(
                            (agent) => agent.compatible
                          );
                          const isExecuting = executingPlanId === id;
                          const newAgentLabel = `New agent for ${workspaceLabel(plan.workspaceRoot)}`;
                          return (
                            <div
                              key={id}
                              className={`mx-2 mb-1.5 rounded-xl border transition-all ${
                                isExpanded
                                  ? "border-cyan-500/20 bg-cyan-500/[0.03]"
                                  : "border-white/5 bg-zinc-800/30 hover:bg-zinc-800/50 hover:border-white/10"
                              }`}
                            >
                              {/* Card header */}
                              <button
                                type="button"
                                onClick={() => setExpandedPlanId(isExpanded ? null : id)}
                                className="w-full px-3.5 py-2.5 text-left"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <p className="text-[13px] font-medium text-zinc-200 truncate">
                                      {plan.title}
                                    </p>
                                    <div className="mt-1 flex items-center gap-1.5">
                                      <span
                                        className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                                          provider === "codex"
                                            ? "bg-emerald-500/10 text-emerald-300"
                                            : "bg-amber-500/10 text-amber-300"
                                        }`}
                                      >
                                        {providerLabel}
                                      </span>
                                      <span className="text-[10px] text-zinc-600 truncate">
                                        {plan.filename}
                                      </span>
                                    </div>
                                    {!isExpanded && (
                                      <p className="text-[11px] text-zinc-500 mt-0.5 line-clamp-2 leading-relaxed">
                                        {planPreview(plan.content)}
                                      </p>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                                    <Clock className="w-2.5 h-2.5 text-zinc-600" />
                                    <span className="text-[10px] text-zinc-600 whitespace-nowrap">
                                      {timeAgo(plan.modifiedAt)}
                                    </span>
                                  </div>
                                </div>
                              </button>

                              {/* Expanded content */}
                              {isExpanded && (
                                <div className="border-t border-white/5">
                                  {/* Markdown preview */}
                                  <div className="px-3.5 py-3 max-h-[40vh] overflow-y-auto">
                                    <pre className="text-[12px] text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed break-words">
                                      {plan.content}
                                    </pre>
                                  </div>

                                  {/* Action bar */}
                                  <div className="px-3.5 py-2.5 border-t border-white/5 flex items-center justify-between gap-2">
                                    <span className="text-[10px] text-zinc-600 truncate">
                                      {plan.filename}
                                    </span>

                                    <div className="relative flex items-center gap-1.5 shrink-0">
                                      <>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setExecuteMenuPlanId(isMenuOpen ? null : id)
                                            }
                                            disabled={isExecuting}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 transition-colors"
                                          >
                                            {isExecuting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                                            Run with
                                            <ChevronDown className="w-3 h-3" />
                                          </button>

                                          {isMenuOpen && (
                                            <div
                                              ref={menuRef}
                                              className="absolute bottom-full right-0 mb-1 w-56 rounded-xl border border-white/10 bg-zinc-900 shadow-xl shadow-black/40 overflow-hidden z-50"
                                            >
                                              <div className="px-3 py-2 border-b border-white/5">
                                                <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-medium">
                                                  Choose executor
                                                </p>
                                              </div>
                                              <div className="py-1 max-h-48 overflow-y-auto">
                                                <button
                                                  type="button"
                                                  onClick={() => void handleExecute(plan, { type: "orchestrator" })}
                                                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors"
                                                >
                                                  <Network className="w-3 h-3 text-violet-300 shrink-0" />
                                                  <span className="min-w-0">
                                                    <span className="block text-[12px] text-zinc-200">Orchestrator</span>
                                                    <span className="block text-[10px] text-zinc-500">Plans and routes execution</span>
                                                  </span>
                                                </button>
                                                {agentsWithCompatibility.map((agent) => (
                                                  <button
                                                    key={agent.id}
                                                    type="button"
                                                    onClick={() =>
                                                      agent.compatible &&
                                                      void handleExecute(plan, { type: "agent", agentId: agent.id })
                                                    }
                                                    disabled={!agent.compatible}
                                                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                                                  >
                                                    <Play className="w-3 h-3 text-cyan-400 shrink-0" />
                                                    <span className="min-w-0">
                                                      <span className="block text-[12px] text-zinc-300 truncate">{agent.name}</span>
                                                      <span className="block text-[10px] text-zinc-500 truncate">
                                                        {agent.compatible
                                                          ? "Attached to this workspace"
                                                          : agent.workspaceRootPath
                                                            ? `Different workspace: ${workspaceLabel(agent.workspaceRootPath)}`
                                                            : "No workspace attached"}
                                                      </span>
                                                    </span>
                                                  </button>
                                                ))}
                                              </div>
                                              <div className="border-t border-white/5 py-1">
                                                <button
                                                  type="button"
                                                  onClick={() => void handleExecute(plan, { type: "new_agent" })}
                                                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors"
                                                >
                                                  <Plus className="w-3 h-3 text-zinc-400 shrink-0" />
                                                  <span className="text-[12px] text-zinc-400">
                                                    {newAgentLabel}
                                                  </span>
                                                </button>
                                              </div>
                                            </div>
                                          )}
                                      </>
                                    </div>
                                  </div>
                                  <div className="border-t border-white/5 px-3.5 py-2 text-[10px] text-zinc-500">
                                    {matchingAgents.length > 0
                                      ? `${matchingAgents.length} existing agent${matchingAgents.length === 1 ? " is" : "s are"} attached to this workspace.`
                                      : "No existing agent is attached to this workspace. The orchestrator can route it or you can create an agent."}
                                  </div>
                                  {executionErrors[id] && (
                                    <div className="mx-3.5 mb-3 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                                      {executionErrors[id]}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              );
            })}
            {hiddenCount > 0 && (
              <div className="px-4 pt-2 pb-4 flex flex-col items-center gap-2">
                <p className="text-[10px] text-zinc-600">
                  Showing {visiblePlans.length} of {filtered.length}
                </p>
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + PLAN_PAGE_SIZE)}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-800/70 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
                >
                  Show more
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
