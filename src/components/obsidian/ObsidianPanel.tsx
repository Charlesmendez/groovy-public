"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Network, RefreshCw } from "lucide-react";
import type { AgentType } from "@/lib/orchestrator/router";

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

type GraphData = {
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string }>;
};

export function ObsidianPanel({
  agentId,
  vaultPath,
  vaults,
  onSelectVault,
  onConnectorExecute = async () => ({ ok: false, error: "connector_not_available" }),
  focusNotePath,
  contextNotePaths,
  initialView,
  onUpdate,
}: {
  agentId: string;
  // Optional display name (some legacy UIs pass this through)
  agentName?: string;
  vaultPath?: string;
  vaults?: Array<{ name: string; path: string }>;
  onSelectVault?: (path: string) => void;
  onConnectorExecute?: (params: {
    type: string;
    params: Record<string, unknown>;
    toolCallId: string;
    toolName: string;
    agent: AgentType;
  }) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;
  focusNotePath?: string;
  contextNotePaths?: string[];
  initialView?: "context" | "full";
  onUpdate?: (data: {
    lastSessionId: string;
    lastMessage?: { role: "user" | "assistant"; content: string };
    status?: "running" | "ready" | "error" | "awaiting-auth";
  }) => void;
}) {
  // Layout state - graph focused (no Claude Code)
  const [layout] = useState<"split" | "graph">("graph");
  const [autoRefreshGraph, setAutoRefreshGraph] = useState(false);
  const [graphView, setGraphView] = useState<"context" | "full">(
    initialView || (contextNotePaths && contextNotePaths.length > 0 ? "context" : "full")
  );

  // Graph state
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const autoRefreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  const buildGraph = useCallback(async () => {
    if (!vaultPath) {
      setGraphError("No vault selected");
      return;
    }

    setGraphError(null);
    setGraphLoading(true);

    try {
      const listRes = await onConnectorExecute({
        type: "obsidian_list",
        params: { vault_path: vaultPath },
        toolCallId: `obsidian-list-${Date.now()}`,
        toolName: "obsidian_list",
        agent: "obsidian",
      });

      if (!listRes.ok) {
        throw new Error(String(listRes.error || "Failed to list vault"));
      }

      const notes = (listRes.notes as Array<{
        path: string;
        name: string;
        modified?: string;
      }>) || [];

      // Limit graph size for responsiveness
      const recent = [...notes]
        .sort((a, b) => String(b.modified || "").localeCompare(String(a.modified || "")))
        .slice(0, 140);

      const nodes = new Map<string, { id: string; label: string }>();
      const byBasename = new Map<string, string>();

      for (const n of recent) {
        nodes.set(n.path, { id: n.path, label: n.name });
        byBasename.set(n.name.toLowerCase(), n.path);
      }

      const edges: Array<{ from: string; to: string }> = [];

      // Read notes to extract links
      for (const n of recent) {
        const readRes = await onConnectorExecute({
          type: "obsidian_read",
          params: { vault_path: vaultPath, note_path: n.path },
          toolCallId: `obsidian-read-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          toolName: "obsidian_read",
          agent: "obsidian",
        });

        if (!readRes.ok) continue;

        const links = (readRes.links as Array<{ type: string; target?: string; url?: string }>) || [];
        for (const link of links) {
          if (link.type !== "wiki") continue;
          const raw = String(link.target || "").trim();
          if (!raw) continue;

          const targetBase = raw.split("|")[0].trim().replace(/\.md$/i, "");
          const resolved = byBasename.get(targetBase.toLowerCase()) || targetBase;

          // Include "virtual" nodes for links to notes that don't exist yet.
          if (!nodes.has(resolved)) {
            nodes.set(resolved, { id: resolved, label: resolved.split("/").pop() || resolved });
          }
          edges.push({ from: n.path, to: resolved });
        }
      }

      setGraph({ nodes: Array.from(nodes.values()), edges: edges.slice(0, 600) });
      onUpdateRef.current?.({ lastSessionId: agentId, status: "ready" });
    } catch (e) {
      setGraphError(getErrorMessage(e) || "Failed to build graph");
    } finally {
      setGraphLoading(false);
    }
  }, [agentId, onConnectorExecute, vaultPath]);

  // If a note was just created/updated, rebuild the graph so the new node/edge appears.
  useEffect(() => {
    if (!focusNotePath) return;
    buildGraph().catch(() => {});
  }, [focusNotePath, buildGraph]);

  // Auto-refresh graph every 10s when enabled
  useEffect(() => {
    if (autoRefreshGraph && vaultPath) {
      buildGraph().catch(() => {});
      autoRefreshIntervalRef.current = setInterval(() => {
        if (!graphLoading) {
          buildGraph().catch(() => {});
        }
      }, 10000);

      return () => {
        if (autoRefreshIntervalRef.current) {
          clearInterval(autoRefreshIntervalRef.current);
          autoRefreshIntervalRef.current = null;
        }
      };
    }
  }, [autoRefreshGraph, buildGraph, vaultPath, graphLoading]);

  const vaultTitle = useMemo(() => {
    if (!vaultPath) return "Vault";
    const found = vaults?.find((v) => v.path === vaultPath);
    return found?.name || vaultPath.split("/").pop() || "Vault";
  }, [vaultPath, vaults]);

  useEffect(() => {
    if (contextNotePaths && contextNotePaths.length > 0) {
      setGraphView(initialView || "context");
    }
  }, [contextNotePaths, initialView]);

  // Force-directed graph layout
  const graphSvg = useMemo(() => {
    if (!graph) return null;

    const hasContext = !!(contextNotePaths && contextNotePaths.length > 0);

    let visibleSet: Set<string> | null = null;
    if (graphView === "context" && hasContext) {
      visibleSet = new Set(contextNotePaths);
      // Expand to 1-hop neighbors so links show up.
      for (const e of graph.edges) {
        if (visibleSet.has(e.from)) visibleSet.add(e.to);
        if (visibleSet.has(e.to)) visibleSet.add(e.from);
      }
    }

    const filteredNodes = (visibleSet
      ? graph.nodes.filter((n) => visibleSet!.has(n.id))
      : graph.nodes
    ).slice(0, 150);

    const nodeSet = new Set(filteredNodes.map((n) => n.id));
    const edges = graph.edges
      .filter((e) => nodeSet.has(e.from) && nodeSet.has(e.to))
      .slice(0, 300);

    const nodes = filteredNodes;

    const W = 400, H = 400;
    const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>();

    nodes.forEach((n) => {
      pos.set(n.id, {
        x: W * 0.2 + Math.random() * W * 0.6,
        y: H * 0.2 + Math.random() * H * 0.6,
        vx: 0, vy: 0,
      });
    });

    const degree = new Map<string, number>();
    edges.forEach((e) => {
      degree.set(e.from, (degree.get(e.from) || 0) + 1);
      degree.set(e.to, (degree.get(e.to) || 0) + 1);
    });

    // Force simulation
    for (let iter = 0; iter < 60; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = pos.get(nodes[i].id)!;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = pos.get(nodes[j].id)!;
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 600 / (dist * dist);
          const fx = (dx / dist) * force, fy = (dy / dist) * force;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }
      for (const e of edges) {
        const a = pos.get(e.from), b = pos.get(e.to);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = dist * 0.025;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      for (const n of nodes) {
        const p = pos.get(n.id)!;
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.85; p.vy *= 0.85;
        p.x = Math.max(15, Math.min(W - 15, p.x));
        p.y = Math.max(15, Math.min(H - 15, p.y));
      }
    }

    const getRadius = (id: string) => Math.min(7, 2 + (degree.get(id) || 0) * 0.3);

    return (
      <svg width={W} height={H} className="block">
        {edges.map((e, idx) => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          return <line key={idx} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(34,211,238,0.2)" strokeWidth={0.5} />;
        })}
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          const r = getRadius(n.id);
          const deg = degree.get(n.id) || 0;
          const alpha = Math.min(1, 0.5 + deg * 0.1);
          const isFocus =
            focusNotePath &&
            (n.id === focusNotePath ||
              n.label.toLowerCase() === focusNotePath.toLowerCase() ||
              n.id.toLowerCase() === focusNotePath.toLowerCase());
          return (
            <g key={n.id}>
              <circle
                cx={p.x}
                cy={p.y}
                r={isFocus ? Math.max(8, r + 2) : r}
                fill={isFocus ? "rgba(167,139,250,0.95)" : `rgba(34,211,238,${alpha})`}
              />
              {deg >= 4 && (
                <text x={p.x} y={p.y - r - 2} textAnchor="middle" className="fill-zinc-400 text-[7px]">
                  {n.label.slice(0, 10)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    );
  }, [graph, focusNotePath, graphView, contextNotePaths]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Network className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-medium text-white truncate">{vaultTitle}</span>
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">{vaultPath || "No vault selected"}</div>
        </div>

        <div className="flex items-center gap-2">
          {vaults && vaults.length > 1 && (
            <select
              value={vaultPath || ""}
              onChange={(e) => onSelectVault?.(e.target.value)}
              className="text-xs bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-zinc-300 max-w-[220px]"
            >
              <option value="" disabled>
                Select vault…
              </option>
              {vaults.map((v) => (
                <option key={v.path} value={v.path}>
                  {v.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className={`flex-1 min-h-0 flex ${layout === "split" ? "gap-3" : ""}`}>
        {/* Graph pane */}
        {(layout === "split" || layout === "graph") && (
          <div className={`${layout === "split" ? "w-full" : "w-full"} min-h-0 rounded-xl border border-white/10 bg-black/50 p-3 flex flex-col`}>
            {/* Graph header */}
            <div className="flex items-center justify-between mb-2 flex-shrink-0">
              <div className="text-xs text-zinc-400">
                {graph ? (
                  <>Nodes: <span className="text-zinc-200">{graph.nodes.length}</span> • Edges: <span className="text-zinc-200">{graph.edges.length}</span></>
                ) : (
                  "Vault Graph"
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-lg border border-white/10 bg-white/5 overflow-hidden">
                  <button
                    type="button"
                    disabled={!contextNotePaths || contextNotePaths.length === 0}
                    onClick={() => setGraphView("context")}
                    className={`px-2 py-1 text-[10px] transition-colors ${
                      graphView === "context"
                        ? "bg-purple-500/20 text-purple-200"
                        : "text-zinc-400 hover:text-white"
                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                    title="Show only notes related to the last action/search"
                  >
                    Context
                  </button>
                  <button
                    type="button"
                    onClick={() => setGraphView("full")}
                    className={`px-2 py-1 text-[10px] transition-colors ${
                      graphView === "full"
                        ? "bg-white/10 text-white"
                        : "text-zinc-400 hover:text-white"
                    }`}
                    title="Show full graph"
                  >
                    All
                  </button>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoRefreshGraph}
                    onChange={(e) => setAutoRefreshGraph(e.target.checked)}
                    className="w-3 h-3 rounded bg-white/10 border-white/20"
                  />
                  Auto
                </label>
                <button
                  onClick={() => buildGraph().catch(() => {})}
                  disabled={graphLoading}
                  className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
                  title="Refresh graph"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${graphLoading ? "animate-spin" : ""}`} />
                </button>
              </div>
            </div>

            {/* Graph content */}
            <div className="flex-1 min-h-0 flex items-center justify-center overflow-auto">
              {graphLoading && !graph ? (
                <div className="flex items-center gap-2 text-zinc-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Building…
                </div>
              ) : graphError ? (
                <div className="text-xs text-red-400 text-center p-4">{graphError}</div>
              ) : graph ? (
                <div className="relative">
                  {graphLoading && (
                    <div className="absolute top-2 right-2">
                      <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
                    </div>
                  )}
                  {graphSvg}
                </div>
              ) : (
                <div className="text-center p-4">
                  <div className="text-xs text-zinc-500 mb-2">
                    Visualize your vault&apos;s link structure
                  </div>
                  <button
                    onClick={() => buildGraph().catch(() => {})}
                    className="px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 transition-colors text-xs"
                  >
                    Build Graph
                  </button>
                </div>
              )}
            </div>

            {/* Node list */}
            {graph && graph.nodes.length > 0 && (
              <div className="mt-2 pt-2 border-t border-white/5 flex-shrink-0">
                <div className="grid grid-cols-2 gap-1 text-[10px] text-zinc-500 max-h-20 overflow-auto">
                  {(graphView === "context" && contextNotePaths && contextNotePaths.length > 0
                    ? graph.nodes.filter((n) => contextNotePaths.includes(n.id)).slice(0, 16)
                    : graph.nodes.slice(0, 16)
                  ).map((n) => (
                    <div key={n.id} className="truncate">{n.label}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
