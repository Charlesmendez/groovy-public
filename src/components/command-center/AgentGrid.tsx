"use client";

import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import {
  Plus,
  Grid3x3,
  Maximize2,
  Minus,
  Columns3,
  Bot,
  Sparkles,
  Terminal,
  FileText,
  FolderOpen,
  Loader2,
  X,
} from "lucide-react";
import type { OrchestratorSession } from "@/hooks/useOrchestrator";
import type { PaneState, ViewMode, AddPaneOptions, PaneKind, HandshakeState } from "@/hooks/useMultiAgent";
import { AgentTilePane } from "./AgentTilePane";
import { HandshakeConnector } from "@/components/handshake/HandshakeConnector";

type SubAgentOption = {
  id: string;
  name: string;
};

type CodeCliProvider = "claude" | "codex";

type CodeSubAgentOption = SubAgentOption & {
  codeCliProvider?: CodeCliProvider;
};

type CodeWorkspaceSelection = {
  id: string;
  rootPath?: string;
};

type AgentGridProps = {
  viewMode: ViewMode;
  onSetViewMode: (mode: ViewMode) => void;
  gridCols: number;
  onSetGridCols: (cols: number) => void;
  panes: PaneState[];
  sessions: OrchestratorSession[];
  chatSubAgents: SubAgentOption[];
  codeSubAgents: CodeSubAgentOption[];
  onAddPane: (options?: AddPaneOptions) => void;
  onRemovePane: (paneId: string) => void;
  onSetPaneSession: (paneId: string, sessionId: string | null) => void;
  onSetPaneKind: (paneId: string, kind: PaneKind) => void;
  onSetPaneChatAgent: (paneId: string, chatAgentId: string | null, chatAgentName?: string | null) => void;
  onSetPaneCodeAgent: (paneId: string, codeAgentId: string | null, codeAgentName?: string | null) => void;
  onCreateCodeAgent?: (input: {
    name: string;
    codeCliProvider: CodeCliProvider;
    workspaceId?: string | null;
    workspaceRoot?: string | null;
  }) => Promise<CodeSubAgentOption | null>;
  onPickCodeWorkspace?: () => Promise<CodeWorkspaceSelection | null>;
  canCreateCodeAgent?: boolean;
  createCodeAgentDisabledReason?: string;
  onSendPaneMessage: (paneId: string, message: string) => void;
  onCreateSession: () => Promise<string | null>;
  queuedPrompt?: { id: string; content: string; targetPaneId?: string | null } | null;
  onQueuedPromptHandled?: (id: string) => void;
  /** The full single-view content (rendered by the existing dashboard code) */
  singleViewContent: React.ReactNode;
  // Plans
  onOpenPlans?: () => void;
  // Handshake
  handshakes?: Map<string, HandshakeState>;
  onHandshakeConnect?: (paneAId: string, paneBId: string) => void;
  onHandshakeDisconnect?: (paneId: string) => void;
};

const GRID_COL_CLASSES: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
  7: "grid-cols-7",
};

export function AgentGrid({
  viewMode,
  onSetViewMode,
  gridCols,
  onSetGridCols,
  panes,
  sessions,
  chatSubAgents,
  codeSubAgents,
  onAddPane,
  onRemovePane,
  onSetPaneSession,
  onSetPaneKind,
  onSetPaneChatAgent,
  onSetPaneCodeAgent,
  onCreateCodeAgent,
  onPickCodeWorkspace,
  canCreateCodeAgent = false,
  createCodeAgentDisabledReason,
  onSendPaneMessage,
  onCreateSession,
  queuedPrompt,
  onQueuedPromptHandled,
  singleViewContent,
  onOpenPlans,
  handshakes,
  onHandshakeConnect,
  onHandshakeDisconnect,
}: AgentGridProps) {
  const [filterTab, setFilterTab] = useState<"all" | "active" | "completed">("all");
  const [showExistingAgentMenu, setShowExistingAgentMenu] = useState(false);
  const [showNewAgentMenu, setShowNewAgentMenu] = useState(false);
  const [showCodeCreateModal, setShowCodeCreateModal] = useState(false);
  const [newCodeAgentName, setNewCodeAgentName] = useState("Code Session");
  const [newCodeAgentProvider, setNewCodeAgentProvider] = useState<CodeCliProvider>("claude");
  const [newCodeAgentWorkspace, setNewCodeAgentWorkspace] = useState<CodeWorkspaceSelection | null>(null);
  const [codeCreateTargetPaneId, setCodeCreateTargetPaneId] = useState<string | null>(null);
  const [creatingCodeAgent, setCreatingCodeAgent] = useState(false);
  const [pickingCodeWorkspace, setPickingCodeWorkspace] = useState(false);
  const [codeCreateError, setCodeCreateError] = useState<string | null>(null);
  const tileHeightClass = "h-[78vh] max-h-[90vh] min-h-[480px]";
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const existingAgentMenuRef = useRef<HTMLDivElement>(null);
  const newAgentMenuRef = useRef<HTMLDivElement>(null);
  const [, setDragSourcePaneId] = useState<string | null>(null);
  const safeHandshakes = handshakes || new Map<string, HandshakeState>();
  const handleHandshakeConnect =
    onHandshakeConnect || (() => {});
  const handleHandshakeDisconnect =
    onHandshakeDisconnect || (() => {});

  const filteredPanes = useMemo(() => {
    if (filterTab === "all") return panes;
    if (filterTab === "active") return panes.filter((p) => p.isStreaming || p.agentActivities.some((a) => a.status === "running"));
    if (filterTab === "completed") return panes.filter((p) => !p.isStreaming && !p.agentActivities.some((a) => a.status === "running"));
    return panes;
  }, [panes, filterTab]);

  const existingAgentSessions = useMemo(() => {
    const openSessionIds = new Set(
      panes
        .filter((p) => p.kind !== "code" && !!p.sessionId)
        .map((p) => p.sessionId as string)
    );
    return sessions.map((s) => ({
      ...s,
      isOpenInPane: openSessionIds.has(s.id),
    }));
  }, [sessions, panes]);

  const handleAddPane = useCallback(async () => {
    setShowNewAgentMenu(false);
    const sessionId = await onCreateSession();
    onAddPane({ kind: "agent", sessionId });
  }, [onAddPane, onCreateSession]);

  const handleAddExistingAgentPane = useCallback(
    (sessionId: string) => {
      onAddPane({ kind: "agent", sessionId });
      setShowExistingAgentMenu(false);
    },
    [onAddPane]
  );

  const handleAddAiChatPane = useCallback(() => {
    const first = chatSubAgents[0];
    onAddPane({
      kind: "ai_chat",
      chatAgentId: first?.id || null,
      chatAgentName: first?.name || null,
    });
  }, [chatSubAgents, onAddPane]);

  const handleAddCodePane = useCallback(() => {
    const first = codeSubAgents[0];
    onAddPane({
      kind: "code",
      codeAgentId: first?.id || null,
      codeAgentName: first?.name || null,
    });
  }, [codeSubAgents, onAddPane]);

  const openCodeCreateModal = useCallback((targetPaneId?: string | null) => {
    setShowNewAgentMenu(false);
    setNewCodeAgentName("Code Session");
    setNewCodeAgentProvider("claude");
    setNewCodeAgentWorkspace(null);
    setCodeCreateTargetPaneId(targetPaneId || null);
    setCodeCreateError(null);
    setShowCodeCreateModal(true);
  }, []);

  const handlePickCodeWorkspace = useCallback(async () => {
    if (!onPickCodeWorkspace) {
      setCodeCreateError("Folder selection is not available here.");
      return;
    }
    setPickingCodeWorkspace(true);
    setCodeCreateError(null);
    try {
      const workspace = await onPickCodeWorkspace();
      if (workspace?.id) {
        setNewCodeAgentWorkspace(workspace);
      }
    } catch (err) {
      setCodeCreateError(err instanceof Error ? err.message : "Failed to pick folder");
    } finally {
      setPickingCodeWorkspace(false);
    }
  }, [onPickCodeWorkspace]);

  const handleCreateCodeAgent = useCallback(async () => {
    const name = newCodeAgentName.trim();
    if (!name) {
      setCodeCreateError("Code agent name is required.");
      return;
    }
    if (!onCreateCodeAgent) {
      setCodeCreateError("Code agent creation is not available here.");
      return;
    }
    if (!canCreateCodeAgent) {
      setCodeCreateError(createCodeAgentDisabledReason || "Code agent creation is unavailable.");
      return;
    }

    setCreatingCodeAgent(true);
    setCodeCreateError(null);
    try {
      const created = await onCreateCodeAgent({
        name,
        codeCliProvider: newCodeAgentProvider,
        workspaceId: newCodeAgentWorkspace?.id || null,
        workspaceRoot: newCodeAgentWorkspace?.rootPath || null,
      });
      if (!created?.id) {
        throw new Error("Failed to create Code agent");
      }
      if (codeCreateTargetPaneId) {
        onSetPaneCodeAgent(codeCreateTargetPaneId, created.id, created.name);
      } else {
        onAddPane({
          kind: "code",
          codeAgentId: created.id,
          codeAgentName: created.name,
        });
      }
      setShowCodeCreateModal(false);
      setNewCodeAgentName("Code Session");
      setNewCodeAgentProvider("claude");
      setNewCodeAgentWorkspace(null);
      setCodeCreateTargetPaneId(null);
    } catch (err) {
      setCodeCreateError(err instanceof Error ? err.message : "Failed to create Code agent");
    } finally {
      setCreatingCodeAgent(false);
    }
  }, [
    canCreateCodeAgent,
    createCodeAgentDisabledReason,
    codeCreateTargetPaneId,
    newCodeAgentName,
    newCodeAgentProvider,
    newCodeAgentWorkspace,
    onAddPane,
    onCreateCodeAgent,
    onSetPaneCodeAgent,
  ]);

  useEffect(() => {
    if (!showExistingAgentMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (existingAgentMenuRef.current?.contains(target)) return;
      setShowExistingAgentMenu(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [showExistingAgentMenu]);

  useEffect(() => {
    if (!showNewAgentMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (newAgentMenuRef.current?.contains(target)) return;
      setShowNewAgentMenu(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [showNewAgentMenu]);

  // Single view -- render existing dashboard content as-is
  if (viewMode === "single") {
    return (
      <div className="flex flex-col h-full">
        {/* Minimal toolbar */}
        <div className="flex items-center justify-end px-3 py-1.5 shrink-0">
          <button
            onClick={() => onSetViewMode("multi")}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-[11px] text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
            title="Switch to multi-agent view"
          >
            <Grid3x3 className="w-3.5 h-3.5" />
            Multi
          </button>
        </div>
        {singleViewContent}
      </div>
    );
  }

  // Multi view
  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 shrink-0">
        {/* View toggle */}
        <button
          onClick={() => onSetViewMode("single")}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-[11px] text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
          title="Switch to single agent view"
        >
          <Maximize2 className="w-3.5 h-3.5" />
          Single
        </button>

        {/* Divider */}
        <div className="w-px h-4 bg-white/10" />

        {/* Filter tabs */}
        <div className="flex items-center gap-0.5 bg-white/5 rounded-lg p-0.5">
          {(["all", "active", "completed"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilterTab(tab)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                filterTab === tab
                  ? "bg-white/10 text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Agent count */}
        <span className="text-[10px] text-zinc-500">
          {panes.length} agent{panes.length !== 1 ? "s" : ""}
        </span>

        <div className="flex-1" />

        {/* Grid columns control */}
        <div className="flex items-center gap-1">
          <Columns3 className="w-3.5 h-3.5 text-zinc-500" />
          <button
            onClick={() => onSetGridCols(gridCols - 1)}
            disabled={gridCols <= 1}
            className="w-5 h-5 rounded flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Minus className="w-3 h-3" />
          </button>
          <span className="text-[10px] text-zinc-400 w-3 text-center">{gridCols}</span>
          <button
            onClick={() => onSetGridCols(gridCols + 1)}
            disabled={gridCols >= 7}
            className="w-5 h-5 rounded flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>

        {/* Add agent */}
        <div className="relative" ref={newAgentMenuRef}>
          <button
            onClick={() => setShowNewAgentMenu((v) => !v)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-[11px] text-cyan-400 hover:bg-cyan-500/20 transition-colors"
          >
            <Bot className="w-3.5 h-3.5" />
            New Agent
          </button>
          {showNewAgentMenu && (
            <div className="absolute top-full right-0 mt-1 w-64 overflow-hidden bg-zinc-900 border border-white/10 rounded-xl shadow-2xl z-50">
              <button
                onClick={handleAddPane}
                className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors border-b border-white/5"
              >
                <Bot className="w-3.5 h-3.5 text-cyan-300 mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-xs text-zinc-100">Groovy agent</span>
                  <span className="block text-[10px] text-zinc-500">New orchestrator runtime pane</span>
                </span>
              </button>
              <button
                onClick={() => openCodeCreateModal()}
                disabled={!onCreateCodeAgent || !canCreateCodeAgent}
                className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
                title={!canCreateCodeAgent ? createCodeAgentDisabledReason : "Create a Code agent"}
              >
                <Terminal className="w-3.5 h-3.5 text-lime-300 mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-xs text-zinc-100">Code agent</span>
                  <span className="block text-[10px] text-zinc-500">Choose Claude Code or Codex</span>
                </span>
              </button>
            </div>
          )}
        </div>

        <div className="relative" ref={existingAgentMenuRef}>
          <button
            onClick={() => setShowExistingAgentMenu((v) => !v)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-[11px] text-zinc-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <Bot className="w-3.5 h-3.5" />
            Existing Agent
          </button>
          {showExistingAgentMenu && (
            <div className="absolute top-full right-0 mt-1 w-72 max-h-72 overflow-y-auto bg-zinc-900 border border-white/10 rounded-xl shadow-2xl z-50">
              {existingAgentSessions.length === 0 ? (
                <div className="px-3 py-4 text-xs text-zinc-500 text-center">
                  No existing agents
                </div>
              ) : (
                existingAgentSessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => handleAddExistingAgentPane(session.id)}
                    className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors border-b border-white/5 last:border-b-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-zinc-200 truncate">
                        {session.title || "Untitled"}
                      </span>
                      {session.isOpenInPane && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 shrink-0">
                          Open
                        </span>
                      )}
                    </div>
                    <div className="text-[9px] text-zinc-500 mt-0.5">
                      {session.messageCount ? `${session.messageCount} msgs` : "No messages"}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <button
          onClick={handleAddAiChatPane}
          disabled={chatSubAgents.length === 0}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-violet-500/10 border border-violet-500/20 text-[11px] text-violet-300 hover:bg-violet-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title={chatSubAgents.length === 0 ? "Create an AI Chat agent first" : "Add AI Chat sub-agent panel"}
        >
          <Sparkles className="w-3.5 h-3.5" />
          AI Sub-Agent
        </button>

        <button
          onClick={handleAddCodePane}
          disabled={codeSubAgents.length === 0}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-lime-500/10 border border-lime-500/20 text-[11px] text-lime-300 hover:bg-lime-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title={codeSubAgents.length === 0 ? "Create a Code session first" : "Add Code sub-agent panel"}
        >
          <Terminal className="w-3.5 h-3.5" />
          Code Sub-Agent
        </button>

        {onOpenPlans && (
          <button
            onClick={onOpenPlans}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-[11px] text-zinc-300 hover:bg-white/10 hover:text-white transition-colors"
            title="Browse Claude Code plans"
          >
            <FileText className="w-3.5 h-3.5" />
            Plans
          </button>
        )}
      </div>

      {/* Grid */}
      <div ref={gridContainerRef} className="flex-1 min-h-0 overflow-auto overscroll-contain p-2 relative">
        {/* Handshake SVG connection lines */}
        <HandshakeConnector
          handshakes={safeHandshakes}
          containerRef={gridContainerRef}
        />

        <div
          className={`grid ${GRID_COL_CLASSES[gridCols] || "grid-cols-3"} gap-2 auto-rows-fr`}
          style={{ minHeight: "100%" }}
        >
          {filteredPanes.map((pane) => (
            <div key={pane.id} className={tileHeightClass}>
              <AgentTilePane
                pane={pane}
                sessions={sessions}
                chatSubAgents={chatSubAgents}
                codeSubAgents={codeSubAgents}
                queuedPrompt={queuedPrompt?.targetPaneId === pane.id ? queuedPrompt : null}
                onQueuedPromptHandled={onQueuedPromptHandled}
                onClose={() => onRemovePane(pane.id)}
                onSetPaneKind={(kind) => onSetPaneKind(pane.id, kind)}
                onSetPaneChatAgent={(agentId, agentName) =>
                  onSetPaneChatAgent(pane.id, agentId, agentName)
                }
                onSetPaneCodeAgent={(agentId, agentName) =>
                  onSetPaneCodeAgent(pane.id, agentId, agentName)
                }
                onCreateCodeAgent={() => openCodeCreateModal(pane.id)}
                onSelectSession={(sid) => onSetPaneSession(pane.id, sid)}
                onSendMessage={(msg) => onSendPaneMessage(pane.id, msg)}
                onCreateSession={async () => {
                  const sid = await onCreateSession();
                  if (sid) onSetPaneSession(pane.id, sid);
                }}
                handshake={safeHandshakes.get(pane.id) || null}
                onHandshakeConnect={(sourcePaneId) =>
                  handleHandshakeConnect(sourcePaneId, pane.id)
                }
                onHandshakeDisconnect={() => handleHandshakeDisconnect(pane.id)}
                onHandshakeDragStart={(id) => setDragSourcePaneId(id)}
                onHandshakeDragEnd={() => setDragSourcePaneId(null)}
              />
            </div>
          ))}
        </div>
      </div>

      {showCodeCreateModal && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <div>
                <h2 className="text-base font-semibold text-white">Create Code agent</h2>
                <p className="text-xs text-zinc-500">Pick a name, folder, and local coding CLI.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowCodeCreateModal(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="space-y-2">
                <label className="text-xs text-zinc-400">Name</label>
                <input
                  value={newCodeAgentName}
                  onChange={(e) => setNewCodeAgentName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleCreateCodeAgent();
                    }
                  }}
                  className="w-full px-4 py-2.5 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-lime-500/40 transition-colors text-sm"
                  placeholder="Code Session"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs text-zinc-400">Folder</label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handlePickCodeWorkspace()}
                    disabled={pickingCodeWorkspace || !onPickCodeWorkspace || !canCreateCodeAgent}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm border border-white/10"
                    title="Choose folder"
                  >
                    {pickingCodeWorkspace ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <FolderOpen className="w-4 h-4" />
                    )}
                    Folder
                  </button>
                  <div className="min-w-0 flex-1 text-xs text-zinc-500 truncate">
                    {newCodeAgentWorkspace?.rootPath ? (
                      <span className="text-zinc-300">{newCodeAgentWorkspace.rootPath}</span>
                    ) : (
                      "No folder selected. Starts in your home directory."
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs text-zinc-400">Provider</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    {
                      value: "claude" as const,
                      label: "Claude Code",
                      detail: "Local Claude CLI",
                      active: "bg-orange-500/15 border-orange-500/35 text-orange-200",
                    },
                    {
                      value: "codex" as const,
                      label: "Codex",
                      detail: "Local Codex CLI",
                      active: "bg-green-500/15 border-green-500/35 text-green-200",
                    },
                  ]).map((provider) => (
                    <button
                      key={provider.value}
                      type="button"
                      onClick={() => setNewCodeAgentProvider(provider.value)}
                      className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                        newCodeAgentProvider === provider.value
                          ? provider.active
                          : "bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10"
                      }`}
                    >
                      <span className="block text-xs font-medium">{provider.label}</span>
                      <span className="block text-[10px] text-zinc-500">{provider.detail}</span>
                    </button>
                  ))}
                </div>
              </div>

              {!canCreateCodeAgent && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  {createCodeAgentDisabledReason || "Code agent creation is unavailable."}
                </div>
              )}

              {codeCreateError && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {codeCreateError}
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-white/10 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCodeCreateModal(false)}
                className="px-4 py-2 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleCreateCodeAgent()}
                disabled={creatingCodeAgent || !canCreateCodeAgent || !newCodeAgentName.trim()}
                className="px-4 py-2 rounded-xl bg-lime-500/20 text-lime-200 border border-lime-500/30 hover:bg-lime-500/25 transition-colors text-sm disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {creatingCodeAgent && <Loader2 className="w-4 h-4 animate-spin" />}
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
