"use client";

import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  ChevronDown,
  Loader2,
  Globe,
  FolderOpen,
  FileText,
  BookMarked,
  BarChart3,
  MessageCircle,
  Clock,
  Terminal,
  Send,
  Plus,
  Bot,
  Sparkles,
} from "lucide-react";
import type { AgentType, AgentActivity } from "@/hooks/useOrchestrator";
import type { OrchestratorSession } from "@/hooks/useOrchestrator";
import type { PaneState, PaneKind, HandshakeState } from "@/hooks/useMultiAgent";
import { MessageList } from "./MessageList";
import { ClaudeCliChatPanel, type CodeHandshakeContext } from "@/components/claude/ClaudeCliChatPanel";
import { HandshakeBanner } from "@/components/handshake/HandshakeBanner";
import { HandshakeDragHandle, HANDSHAKE_DRAG_TYPE } from "@/components/handshake/HandshakeDragHandle";

const PANEL_AGENT_SET = new Set<AgentType>([
  "browser",
  "files",
  "pages",
  "obsidian",
  "data",
  "chat",
  "schedule",
  "code",
]);

function isPanelAgent(agent: AgentActivity["agent"]): agent is AgentType {
  return PANEL_AGENT_SET.has(agent as AgentType);
}

function isRunningPanelActivity(
  activity: AgentActivity
): activity is AgentActivity & { agent: AgentType; status: "running" } {
  return activity.status === "running" && isPanelAgent(activity.agent);
}

// Inline mini-viz for running tools (compact versions of RunningAgentPanel vizs)
function MiniToolViz({
  activities,
}: {
  activities: AgentActivity[];
}) {
  const running = activities.filter(isRunningPanelActivity);
  if (running.length === 0) return null;

  const latest = running[running.length - 1];
  const agentConfig = AGENT_COLORS[latest.agent];

  const result = latest.result as {
    screenshot?: string;
    url?: string;
    title?: string;
    screenshotMediaType?: string;
  } | undefined;

  return (
    <div className={`mx-2 mb-2 rounded-xl border ${agentConfig.border} bg-zinc-950 overflow-hidden`}>
      {/* Browser screenshot */}
      {latest.agent === "browser" && result?.screenshot && (
        <div className="relative">
          <img
            src={`data:${result.screenshotMediaType || "image/png"};base64,${result.screenshot}`}
            alt="Browser"
            className="w-full h-[140px] object-cover object-top"
          />
          <div className="absolute top-1.5 right-1.5 flex items-center gap-1 px-1.5 py-0.5 bg-black/70 rounded-full">
            <motion.div
              className="w-1 h-1 rounded-full bg-red-500"
              animate={{ opacity: [1, 0.4, 1] }}
              transition={{ repeat: Infinity, duration: 1 }}
            />
            <span className="text-[8px] text-white font-semibold">LIVE</span>
          </div>
        </div>
      )}

      {/* Status bar */}
      <div className={`flex items-center gap-2 px-2.5 py-1.5 ${agentConfig.bg}`}>
        <agentConfig.icon className={`w-3 h-3 ${agentConfig.text}`} />
        <span className={`text-[10px] ${agentConfig.text} truncate flex-1`}>
          {latest.metadata?.title || latest.action}
        </span>
        <Loader2 className={`w-3 h-3 ${agentConfig.text} animate-spin shrink-0`} />
      </div>
    </div>
  );
}

const AGENT_COLORS: Record<AgentType, {
  icon: typeof Globe;
  text: string;
  bg: string;
  border: string;
}> = {
  browser: { icon: Globe, text: "text-cyan-400", bg: "bg-cyan-500/10", border: "border-cyan-500/30" },
  files: { icon: FolderOpen, text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" },
  pages: { icon: FileText, text: "text-indigo-400", bg: "bg-indigo-500/10", border: "border-indigo-500/30" },
  obsidian: { icon: BookMarked, text: "text-violet-400", bg: "bg-violet-500/10", border: "border-violet-500/30" },
  data: { icon: BarChart3, text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
  chat: { icon: MessageCircle, text: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/30" },
  schedule: { icon: Clock, text: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/30" },
  code: { icon: Terminal, text: "text-lime-400", bg: "bg-lime-500/10", border: "border-lime-500/30" },
};

type AgentTilePaneProps = {
  pane: PaneState;
  sessions: OrchestratorSession[];
  chatSubAgents: Array<{ id: string; name: string }>;
  codeSubAgents: Array<{ id: string; name: string; codeCliProvider?: "claude" | "codex" }>;
  queuedPrompt?: { id: string; content: string } | null;
  onQueuedPromptHandled?: (id: string) => void;
  onClose: () => void;
  onSetPaneKind: (kind: PaneKind) => void;
  onSetPaneChatAgent: (agentId: string | null, agentName?: string | null) => void;
  onSetPaneCodeAgent: (agentId: string | null, agentName?: string | null) => void;
  onCreateCodeAgent?: () => void;
  onSelectSession: (sessionId: string | null) => void;
  onSendMessage: (message: string) => void;
  onCreateSession: () => void;
  // Handshake
  handshake?: HandshakeState | null;
  onHandshakeConnect?: (targetPaneId: string) => void;
  onHandshakeDisconnect?: () => void;
  onHandshakeDragStart?: (paneId: string) => void;
  onHandshakeDragEnd?: () => void;
};

const PANE_KIND_META: Record<
  PaneKind,
  {
    label: string;
    icon: typeof Bot;
    border: string;
    badge: string;
    badgeText: string;
    header: string;
  }
> = {
  agent: {
    label: "Agent",
    icon: Bot,
    border: "border-white/10",
    badge: "bg-cyan-500/15",
    badgeText: "text-cyan-300",
    header: "bg-zinc-900/80",
  },
  ai_chat: {
    label: "AI Chat",
    icon: Sparkles,
    border: "border-violet-500/30",
    badge: "bg-violet-500/15",
    badgeText: "text-violet-300",
    header: "bg-violet-950/20",
  },
  code: {
    label: "Code",
    icon: Terminal,
    border: "border-lime-500/30",
    badge: "bg-lime-500/15",
    badgeText: "text-lime-300",
    header: "bg-lime-950/20",
  },
};

export function AgentTilePane({
  pane,
  sessions,
  chatSubAgents,
  codeSubAgents,
  queuedPrompt,
  onQueuedPromptHandled,
  onClose,
  onSetPaneKind,
  onSetPaneChatAgent,
  onSetPaneCodeAgent,
  onCreateCodeAgent,
  onSelectSession,
  onSendMessage,
  onCreateSession,
  handshake,
  onHandshakeConnect,
  onHandshakeDisconnect,
  onHandshakeDragStart,
  onHandshakeDragEnd,
}: AgentTilePaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Drag & drop for handshake
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(HANDSHAKE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "link";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      setIsDragOver(false);
      const sourcePaneId = e.dataTransfer.getData(HANDSHAKE_DRAG_TYPE);
      if (!sourcePaneId || sourcePaneId === pane.id) return;
      e.preventDefault();
      onHandshakeConnect?.(sourcePaneId);
    },
    [pane.id, onHandshakeConnect]
  );

  const sessionTitle = useMemo(() => {
    if (!pane.sessionId) return "Select Agent";
    return sessions.find((s) => s.id === pane.sessionId)?.title || "Untitled";
  }, [pane.sessionId, sessions]);

  // Auto-scroll on new messages / streaming
  useEffect(() => {
    if (pane.kind === "code") return;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [pane.kind, pane.messages.length, pane.streamingContent]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (
      !trimmed ||
      pane.isStreaming ||
      pane.kind === "code" ||
      (pane.kind === "ai_chat" && !pane.chatAgentId)
    ) {
      return;
    }
    onSendMessage(trimmed);
    setInput("");
  }, [input, pane.isStreaming, pane.kind, pane.chatAgentId, onSendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // Reset textarea height when input changes programmatically (e.g. after send clears it)
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "28px";
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + "px";
    }
  }, [input]);

  // Dominant running agent for border glow
  const dominantAgent = useMemo(() => {
    const running = pane.agentActivities.filter(isRunningPanelActivity);
    if (running.length === 0) return null;
    return running[running.length - 1].agent;
  }, [pane.agentActivities]);

  const paneKindMeta = PANE_KIND_META[pane.kind];
  const selectedCodeAgent = useMemo(
    () => codeSubAgents.find((agent) => agent.id === pane.codeAgentId) || null,
    [codeSubAgents, pane.codeAgentId]
  );
  const codeHandshakeContext = useMemo<CodeHandshakeContext | null>(() => {
    if (pane.kind !== "code" || !handshake || !pane.sessionId) return null;
    return {
      handshakeId: handshake.handshakeId,
      selfSessionId: pane.sessionId,
      partnerSessionId: handshake.partnerSessionId,
      partnerName: handshake.partnerName,
      selfName: pane.codeAgentName || selectedCodeAgent?.name || "Code agent",
    };
  }, [
    handshake,
    pane.kind,
    pane.sessionId,
    pane.codeAgentName,
    selectedCodeAgent?.name,
  ]);

  const borderColor = handshake
    ? "border-orange-500/30"
    : dominantAgent
    ? AGENT_COLORS[dominantAgent].border
    : pane.isStreaming
    ? "border-cyan-500/30"
    : isDragOver
    ? "border-orange-500/40"
    : paneKindMeta.border;

  // Count active scheduled jobs for this session (badge) -- placeholder, filled by parent
  const runningActivities = pane.agentActivities.filter(isRunningPanelActivity);
  const PaneKindIcon = paneKindMeta.icon;

  const handlePaneKindChange = useCallback(
    (value: PaneKind) => {
      onSetPaneKind(value);
      if (value === "ai_chat" && !pane.chatAgentId && chatSubAgents.length > 0) {
        onSetPaneChatAgent(chatSubAgents[0].id, chatSubAgents[0].name);
      }
      if (value === "code" && !pane.codeAgentId && codeSubAgents.length > 0) {
        onSetPaneCodeAgent(codeSubAgents[0].id, codeSubAgents[0].name);
      }
    },
    [
      onSetPaneKind,
      pane.chatAgentId,
      pane.codeAgentId,
      chatSubAgents,
      codeSubAgents,
      onSetPaneChatAgent,
      onSetPaneCodeAgent,
    ]
  );

  return (
    <div
      data-pane-id={pane.id}
      className={`flex flex-col h-full min-h-0 bg-zinc-900/60 border ${borderColor} rounded-2xl overflow-hidden ${
        isDragOver ? "ring-2 ring-orange-500/30" : ""
      } ${handshake ? "shadow-[0_0_20px_-5px_rgba(249,115,22,0.2)]" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className={`px-3 py-2 border-b border-white/5 shrink-0 ${paneKindMeta.header}`}>
        <div className="flex items-center gap-2">
          {/* Handshake drag handle */}
          <HandshakeDragHandle
            paneId={pane.id}
            disabled={(!pane.sessionId && pane.kind !== "code") || !!handshake}
            onDragStart={onHandshakeDragStart}
            onDragEnd={onHandshakeDragEnd}
          />

          {/* Status dot */}
          {pane.isStreaming && (
            <div className="w-2 h-2 rounded-full bg-cyan-400/80 shrink-0" />
          )}
          {dominantAgent && !pane.isStreaming && (
            <div className={`w-2 h-2 rounded-full ${AGENT_COLORS[dominantAgent].text.replace("text-", "bg-")} shrink-0`} />
          )}

          <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded ${paneKindMeta.badge}`}>
            <PaneKindIcon className={`w-3 h-3 ${paneKindMeta.badgeText}`} />
            <span className={`text-[10px] font-medium ${paneKindMeta.badgeText}`}>{paneKindMeta.label}</span>
          </div>

          <select
            value={pane.kind}
            onChange={(e) => handlePaneKindChange(e.target.value as PaneKind)}
            className="text-[10px] rounded-md bg-white/5 border border-white/10 text-zinc-300 px-1.5 py-1 outline-none"
          >
            <option value="agent">Agent</option>
            <option value="ai_chat">AI Chat</option>
            <option value="code">Code</option>
          </select>

          <div className="flex-1" />

          {/* Running agent badges */}
          {pane.kind !== "code" && runningActivities.length > 0 && (
            <div className="flex items-center gap-0.5 shrink-0">
              {Array.from(new Set(runningActivities.map((a) => a.agent))).map((agent) => {
                const cfg = AGENT_COLORS[agent];
                const Icon = cfg.icon;
                return (
                  <div
                    key={agent}
                    className={`w-5 h-5 rounded ${cfg.bg} flex items-center justify-center`}
                  >
                    <Icon className={`w-3 h-3 ${cfg.text}`} />
                  </div>
                );
              })}
            </div>
          )}

          {/* Close */}
          <button
            onClick={onClose}
            className="w-5 h-5 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        <div className="mt-2 flex items-center gap-2">
          {pane.kind !== "code" && (
            <div className="relative flex-1 min-w-0">
              <button
                onClick={() => setShowSessionPicker(!showSessionPicker)}
                className="flex items-center gap-1.5 w-full text-left hover:bg-white/5 rounded-lg px-1.5 py-1 transition-colors border border-white/5"
              >
                <span className="text-xs font-medium text-white truncate">
                  {sessionTitle}
                </span>
                <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
              </button>

              {showSessionPicker && (
                <div className="absolute top-full left-0 mt-1 w-full max-h-[240px] overflow-y-auto bg-zinc-900 border border-white/10 rounded-xl shadow-2xl z-50">
                  <button
                    onClick={() => {
                      onCreateSession();
                      setShowSessionPicker(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-cyan-400 hover:bg-white/5 border-b border-white/5"
                  >
                    <Plus className="w-3 h-3" />
                    New Agent
                  </button>
                  {sessions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        onSelectSession(s.id);
                        setShowSessionPicker(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors ${
                        s.id === pane.sessionId ? "bg-cyan-500/10 text-cyan-300" : "text-zinc-300"
                      }`}
                    >
                      <div className="truncate font-medium">{s.title || "Untitled"}</div>
                      <div className="text-[9px] text-zinc-500">
                        {new Date(s.updatedAt).toLocaleDateString()}
                        {s.messageCount ? ` · ${s.messageCount} msgs` : ""}
                      </div>
                    </button>
                  ))}
                  {sessions.length === 0 && (
                    <div className="px-3 py-4 text-xs text-zinc-500 text-center">
                      No agents yet
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {pane.kind === "ai_chat" && (
            <select
              value={pane.chatAgentId || ""}
              onChange={(e) => {
                const nextId = e.target.value || null;
                const next = chatSubAgents.find((a) => a.id === nextId);
                onSetPaneChatAgent(nextId, next?.name || null);
              }}
              className="min-w-[150px] max-w-[55%] text-[11px] rounded-md bg-violet-500/10 border border-violet-500/25 text-violet-200 px-2 py-1 outline-none"
            >
              <option value="">Select AI sub-agent</option>
              {chatSubAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          )}

          {pane.kind === "code" && (
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <select
                value={pane.codeAgentId || ""}
                onChange={(e) => {
                  const nextId = e.target.value || null;
                  const next = codeSubAgents.find((a) => a.id === nextId);
                  onSetPaneCodeAgent(nextId, next?.name || null);
                }}
                className="min-w-0 flex-1 text-[11px] rounded-md bg-lime-500/10 border border-lime-500/25 text-lime-200 px-2 py-1 outline-none"
              >
                <option value="">Select Code sub-agent</option>
                {codeSubAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.codeCliProvider === "codex" ? "Codex" : "Claude"})
                  </option>
                ))}
              </select>
              {onCreateCodeAgent && (
                <button
                  type="button"
                  onClick={onCreateCodeAgent}
                  className="h-7 px-2 rounded-md bg-lime-500/10 border border-lime-500/25 text-[10px] font-medium text-lime-200 hover:bg-lime-500/20 transition-colors inline-flex items-center gap-1"
                  title="Create Code agent"
                >
                  <Plus className="w-3 h-3" />
                  New
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Handshake banner */}
      <AnimatePresence>
        {handshake && onHandshakeDisconnect && (
          <HandshakeBanner
            handshake={handshake}
            onDisconnect={onHandshakeDisconnect}
          />
        )}
      </AnimatePresence>

      {pane.kind === "code" ? (
        <div className="flex-1 min-h-0">
          {pane.codeAgentId ? (
            <ClaudeCliChatPanel
              key={pane.codeAgentId}
              agentId={pane.codeAgentId}
              agentName={pane.codeAgentName || undefined}
              codeCliProvider={selectedCodeAgent?.codeCliProvider}
              queuedPrompt={queuedPrompt}
              onQueuedPromptHandled={onQueuedPromptHandled}
              handshake={codeHandshakeContext}
              embedded
            />
          ) : (
            <div className="h-full flex items-center justify-center p-4 text-center">
              <div>
                <div className="text-sm text-lime-300 mb-1">Select a Code sub-agent</div>
                <div className="text-xs text-zinc-500">
                  Pick one from the dropdown to start coding inside this tile.
                </div>
                {onCreateCodeAgent && (
                  <button
                    type="button"
                    onClick={onCreateCodeAgent}
                    className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-lime-500/10 border border-lime-500/25 text-xs text-lime-200 hover:bg-lime-500/20 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    New Code agent
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Messages area */}
          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2 relative"
          >
            {pane.isLoadingMessages && pane.messages.length > 0 && (
              <div className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-zinc-900/80 border border-white/10 text-[10px] text-zinc-400 backdrop-blur-sm">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Syncing</span>
              </div>
            )}

            {pane.isLoadingMessages && pane.messages.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <Loader2 className="w-5 h-5 text-zinc-500 animate-spin" />
              </div>
            ) : (
              <MessageList
                messages={pane.messages}
                isStreaming={pane.isStreaming}
                streamingContent={pane.streamingContent}
                compact
                emptyMessage={
                  pane.kind === "ai_chat"
                    ? pane.sessionId
                      ? "Send a message to this AI sub-agent"
                      : "Select or create an agent session, then message this AI sub-agent"
                    : pane.sessionId
                    ? "Send a message to this agent"
                    : "Select or create an agent to begin"
                }
              />
            )}
          </div>

          {/* Inline tool viz */}
          <MiniToolViz activities={pane.agentActivities} />

          {/* Error */}
          {pane.error && (
            <div className="mx-2 mb-1 px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-[10px] text-red-400 truncate">
              {pane.error}
            </div>
          )}

          {/* Input */}
          <div className="px-2 pb-2 shrink-0">
            <div className="flex items-end gap-1.5 bg-white/5 border border-white/10 rounded-xl px-2.5 py-1.5">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={pane.kind === "ai_chat" ? "Message AI sub-agent..." : "Message Agent..."}
                rows={1}
                className="flex-1 bg-transparent text-xs text-white placeholder-zinc-500 resize-none outline-none min-h-[28px] max-h-[120px] py-0.5"
                disabled={pane.isStreaming || (pane.kind === "ai_chat" && !pane.chatAgentId)}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || pane.isStreaming || (pane.kind === "ai_chat" && !pane.chatAgentId)}
                className="w-6 h-6 rounded-lg bg-cyan-500/20 flex items-center justify-center text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                {pane.isStreaming ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Send className="w-3 h-3" />
                )}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
