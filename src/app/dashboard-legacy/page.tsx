"use client";

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { VoiceControl } from "@/components/VoiceControl";
import { VoiceCommand } from "@/hooks/useVoiceControl";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ClaudeCliChatPanel } from "@/components/claude/ClaudeCliChatPanel";
import { CursorAgentPanel } from "@/components/cursor/CursorAgentPanel";
import { DatagranPanel } from "@/components/datagran/DatagranPanel";
import { FilesAgentPanel } from "@/components/files/FilesAgentPanel";
import { ObsidianPanel } from "@/components/obsidian/ObsidianPanel";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { DATAGRAN_PROVIDER_LABELS, type DatagranProvider } from "@/lib/datagran/prompts";
import { identifyUser } from "@/lib/datagran/pixel";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  Terminal,
  Brain,
  Database,
  Plus,
  Search,
  Settings,
  Grid3X3,
  Activity,
  MessageSquare,
  Code,
  TrendingUp,
  FileText,
  Sparkles,
  ChevronRight,
  MoreHorizontal,
  Play,
  Pause,
  RotateCcw,
  ExternalLink,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Send,
  Radio,
  Trash2,
  X,
  Pencil,
  LogOut,
  HelpCircle,
} from "lucide-react";
import { useRelay } from "@/hooks/useRelay";

type AgentStatus = 
  | "running"           // Actively working
  | "complete"          // Finished successfully
  | "ready"             // Ready for input (AI chat)
  | "awaiting-input"    // Needs your response/decision
  | "awaiting-auth"     // Waiting for authorization/approval
  | "error"             // Something went wrong
  | "queued"            // In queue, will start soon
  | "paused";           // Manually paused

const statusConfig: Record<AgentStatus, { 
  label: string; 
  color: string; 
  bgColor: string;
  borderColor: string;
  icon: string;
  pulse: boolean;
  glow: string;
}> = {
  running: { 
    label: "Running", 
    color: "text-cyan-400", 
    bgColor: "bg-cyan-400",
    borderColor: "border-cyan-500/30 hover:border-cyan-500/50",
    icon: "●",
    pulse: true,
    glow: "shadow-cyan-500/20"
  },
  complete: { 
    label: "Complete", 
    color: "text-emerald-400", 
    bgColor: "bg-emerald-400",
    borderColor: "border-emerald-500/30 hover:border-emerald-500/50",
    icon: "✓",
    pulse: false,
    glow: "shadow-emerald-500/10"
  },
  ready: { 
    label: "Ready", 
    color: "text-emerald-400", 
    bgColor: "bg-emerald-400",
    borderColor: "border-emerald-500/30 hover:border-emerald-500/50",
    icon: "●",
    pulse: false,
    glow: "shadow-emerald-500/10"
  },
  "awaiting-input": { 
    label: "Needs Input", 
    color: "text-amber-400", 
    bgColor: "bg-amber-400",
    borderColor: "border-amber-500/30 hover:border-amber-500/50",
    icon: "?",
    pulse: true,
    glow: "shadow-amber-500/20"
  },
  "awaiting-auth": { 
    label: "Needs Auth", 
    color: "text-violet-400", 
    bgColor: "bg-violet-400",
    borderColor: "border-violet-500/30 hover:border-violet-500/50",
    icon: "🔐",
    pulse: true,
    glow: "shadow-violet-500/20"
  },
  error: { 
    label: "Error", 
    color: "text-red-400", 
    bgColor: "bg-red-400",
    borderColor: "border-red-500/30 hover:border-red-500/50",
    icon: "✕",
    pulse: false,
    glow: "shadow-red-500/20"
  },
  queued: { 
    label: "Queued", 
    color: "text-zinc-400", 
    bgColor: "bg-zinc-400",
    borderColor: "border-zinc-600/30 hover:border-zinc-500/50",
    icon: "◷",
    pulse: false,
    glow: ""
  },
  paused: { 
    label: "Paused", 
    color: "text-zinc-500", 
    bgColor: "bg-zinc-500",
    borderColor: "border-zinc-700/50 hover:border-zinc-600/50",
    icon: "❚❚",
    pulse: false,
    glow: ""
  },
};
type ModelProvider = "openai" | "anthropic" | "xai" | "google";
type FlagColor = string;

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

function formatRelativeTime(dateString: string | undefined): string {
  if (!dateString) return "—";
  
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffSecs < 60) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  
  // Format as date for older items
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v
  );
}

// Available colors for flags
const availableFlagColors = [
  { id: "cyan", bg: "bg-cyan-500", border: "border-l-cyan-500", hex: "#06b6d4" },
  { id: "violet", bg: "bg-violet-500", border: "border-l-violet-500", hex: "#8b5cf6" },
  { id: "amber", bg: "bg-amber-500", border: "border-l-amber-500", hex: "#f59e0b" },
  { id: "emerald", bg: "bg-emerald-500", border: "border-l-emerald-500", hex: "#10b981" },
  { id: "rose", bg: "bg-rose-500", border: "border-l-rose-500", hex: "#f43f5e" },
  { id: "blue", bg: "bg-blue-500", border: "border-l-blue-500", hex: "#3b82f6" },
  { id: "orange", bg: "bg-orange-500", border: "border-l-orange-500", hex: "#f97316" },
  { id: "pink", bg: "bg-pink-500", border: "border-l-pink-500", hex: "#ec4899" },
  { id: "lime", bg: "bg-lime-500", border: "border-l-lime-500", hex: "#84cc16" },
  { id: "indigo", bg: "bg-indigo-500", border: "border-l-indigo-500", hex: "#6366f1" },
];

// Default flags
const defaultFlags: Record<string, { bg: string; border: string; label: string }> = {
  cyan: { bg: "bg-cyan-500", border: "border-l-cyan-500", label: "Groovy App" },
  violet: { bg: "bg-violet-500", border: "border-l-violet-500", label: "SaaS" },
  amber: { bg: "bg-amber-500", border: "border-l-amber-500", label: "Marketing" },
  emerald: { bg: "bg-emerald-500", border: "border-l-emerald-500", label: "Mobile" },
  rose: { bg: "bg-rose-500", border: "border-l-rose-500", label: "Docs" },
  blue: { bg: "bg-blue-500", border: "border-l-blue-500", label: "Research" },
};

interface Agent {
  id: string;
  name: string;
  type: "claude-code" | "cursor" | "ai-chat" | "custom" | "datagran" | "files-agent" | "obsidian";
  status: AgentStatus;
  task: string;
  progress?: number;
  output?: string[];
  // AI Chat LLM auth (never store plaintext keys in DB)
  llmKeySource?: "user" | "groovy";
  llmApiKeyHash?: string | null;
  updatedAt?: string;
  model?: {
    provider: ModelProvider;
    name: string;
  };
  flag?: FlagColor;
  // For ai-chat agents
  lastMessage?: { role: "user" | "assistant"; content: string };
  lastSessionId?: string;
  // For claude-code agents
  terminalId?: string;
  sendTerminalInput?: (input: string) => void;
  // For cursor agents
  cursorAgentId?: string;
  sendCursorFollowUp?: (message: string) => Promise<void>;
}

const modelProviders: Record<ModelProvider, { name: string; models: string[]; color: string }> = {
  openai: { 
    name: "OpenAI", 
    models: [
      "gpt-5.2",
      "gpt-5",
      "gpt-4.5-turbo",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "o3",
      "o3-mini",
      "o1",
      "o1-mini",
    ], 
    color: "emerald" 
  },
  anthropic: { 
    name: "Anthropic", 
    models: [
      "claude-opus-4.6",
      "claude-opus-4.5",
      "claude-opus-4",
      "claude-sonnet-4",
      "claude-3.5-sonnet",
      "claude-3.5-haiku",
      "claude-3-opus",
      "claude-3-sonnet",
    ], 
    color: "orange" 
  },
  xai: { 
    name: "xAI", 
    models: [
      "grok-3",
      "grok-3-mini",
      "grok-2",
      "grok-2-mini",
    ], 
    color: "blue" 
  },
  google: { 
    name: "Google", 
    models: [
      "gemini-3-pro-image-preview",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "gemini-2.0-pro",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ], 
    color: "red" 
  },
};

// Categories are now dynamic based on flags - see useMemo in Home component

const StatusIndicator = ({ status, showLabel = false }: { status: AgentStatus; showLabel?: boolean }) => {
  const config = statusConfig[status];

  return (
    <div 
      className={`flex items-center gap-1.5 shrink-0 ${showLabel ? `px-2 py-1 rounded-md ${config.bgColor}/10 max-w-[90px]` : ""}`}
      title={config.label}
    >
      <div className="relative flex items-center justify-center shrink-0">
        <div className={`w-2 h-2 rounded-full ${config.bgColor}`} />
        {config.pulse && (
          <div className={`absolute w-2 h-2 rounded-full ${config.bgColor} animate-ping opacity-75`} />
        )}
      </div>
      {showLabel && (
        <span className={`text-xs font-medium ${config.color} truncate`}>{config.label}</span>
      )}
    </div>
  );
};

const AgentIcon = ({ type }: { type: Agent["type"] }) => {
  const icons = {
    "claude-code": Terminal,
    "cursor": Code,
    "ai-chat": MessageSquare,
    custom: Sparkles,
    datagran: Database,
    "files-agent": FileText,
    obsidian: FileText,
  };
  const Icon = icons[type];
  return <Icon className="w-4 h-4" />;
};

const ModelBadge = ({ provider, name }: { provider: ModelProvider; name: string }) => {
  const colors: Record<ModelProvider, string> = {
    openai: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    anthropic: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    xai: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    google: "bg-red-500/10 text-red-400 border-red-500/20",
  };
  
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono border ${colors[provider]}`}>
      <span className="opacity-60">{modelProviders[provider].name}</span>
      <span className="font-medium">{name}</span>
    </span>
  );
};

const FlagBadge = ({ flag, flagColors }: { flag: FlagColor; flagColors: Record<string, { bg: string; border: string; label: string }> }) => {
  const flagConfig = flagColors[flag];
  if (!flagConfig) return null;
  
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] bg-white/5 text-zinc-300">
      <div className={`w-1.5 h-1.5 rounded-full ${flagConfig.bg}`} />
      <span>{flagConfig.label}</span>
    </span>
  );
};

const AgentCard = ({ 
  agent, 
  onClick, 
  onDelete,
  flagColors,
  onSendChatMessage,
  onUpdateAgent,
  onRename,
}: { 
  agent: Agent; 
  onClick: () => void; 
  onDelete: () => void;
  flagColors: Record<string, { bg: string; border: string; label: string }>;
  onSendChatMessage?: (agentId: string, sessionId: string, message: string, agentType: Agent["type"]) => Promise<void>;
  onUpdateAgent?: (updates: Partial<Agent>) => void;
  onRename?: (newName: string) => Promise<void>;
}) => {
  const status = statusConfig[agent.status];
  const [quickResponse, setQuickResponse] = useState("");
  const [sending, setSending] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(agent.name);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const nameInputRef = React.useRef<HTMLInputElement>(null);
  const isThinking = (agent.type === "ai-chat" || agent.type === "datagran" || agent.type === "cursor" || agent.type === "files-agent") && (sending || agent.status === "running");
  
  // Relay connection for claude-code quick input and output updates (cursor agents use cloud API, not relay)
  const relay = useRelay({ enabled: agent.type === "claude-code" && !!agent.terminalId });
  const onUpdateAgentRef = useRef(onUpdateAgent);
  const terminalIdRef = useRef(agent.terminalId);
  const relayRef = useRef(relay);
  const previewTailRef = useRef<string>("");
  onUpdateAgentRef.current = onUpdateAgent;
  terminalIdRef.current = agent.terminalId;
  relayRef.current = relay;

  const isClaudeCodeChromeLine = useCallback((value: string) => {
    const lowerRaw = String(value || "").toLowerCase();
    const lower = lowerRaw.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-");
    return (
      lower.startsWith("?") ||
      lower.includes("shortcuts") ||
      lower.includes("shortcut") ||
      lower.includes("@anthropic-ai/claude-code") ||
      lower.includes("@anthropic") ||
      lower.includes("anthropic") ||
      lower.includes("antrhopic") ||
      /auto[\s-]*update/.test(lower) ||
      lower.includes("esc to interrupt") ||
      lower.includes("claude doctor") ||
      lower.includes("~/.claude/local") ||
      lower.includes("npm update")
    );
  }, []);
  
  // On refresh we lose in-memory agent state (terminalId/output). Restore from localStorage.
  useEffect(() => {
    if (agent.type !== "claude-code") return;
    if (typeof window === "undefined") return;

    // 1) Restore terminalId so collapsed card can send/subscribe without opening the panel.
    if (!agent.terminalId && onUpdateAgentRef.current) {
      try {
        const storedTerminalId = window.localStorage.getItem(`groovy:claude-code:terminal:${agent.id}`);
        if (storedTerminalId) {
          onUpdateAgentRef.current({ terminalId: storedTerminalId });
        }
      } catch {
        // ignore
      }
    }

    // 2) Restore last preview output for immediate UI feedback.
    if ((!agent.output || agent.output.length === 0) && onUpdateAgentRef.current) {
      try {
        const storedPreview = window.localStorage.getItem(`groovy:claude-code:preview:${agent.id}`);
        if (storedPreview) {
          if (isClaudeCodeChromeLine(storedPreview)) {
            // Clear bad cached preview so it doesn't keep coming back.
            try {
              window.localStorage.removeItem(`groovy:claude-code:preview:${agent.id}`);
            } catch {
              // ignore
            }
            return;
          }
          onUpdateAgentRef.current({ output: [storedPreview] });
        }
      } catch {
        // ignore
      }
    }
  }, [agent.id, agent.type, agent.terminalId, agent.output, isClaudeCodeChromeLine]);

  // On refresh, restore cursor agent state (cursorAgentId, lastMessage) from localStorage.
  useEffect(() => {
    if (agent.type !== "cursor") return;
    if (typeof window === "undefined") return;

    // Restore cursorAgentId and lastMessage for collapsed card
    if (!agent.cursorAgentId || !agent.lastMessage) {
      try {
        const stored = window.localStorage.getItem(`groovy:cursor:state:${agent.id}`);
        if (stored && onUpdateAgentRef.current) {
          const parsed = JSON.parse(stored);
          const updates: Partial<Agent> = {};
          if (!agent.cursorAgentId && parsed.cursorAgentId) {
            updates.cursorAgentId = parsed.cursorAgentId;
          }
          if (!agent.lastMessage && parsed.lastMessage) {
            updates.lastMessage = parsed.lastMessage;
          }
          if (Object.keys(updates).length > 0) {
            onUpdateAgentRef.current(updates);
          }
        }
      } catch {
        // ignore
      }
    }
  }, [agent.id, agent.type, agent.cursorAgentId, agent.lastMessage]);

  // Subscribe to terminal data for updating collapsed card output
  useEffect(() => {
    if (agent.type !== "claude-code" || !agent.terminalId || relay.status !== "ready") return;
    
    // Subscribe to terminal data
    relayRef.current.send({ type: "terminal_subscribe", terminal_id: agent.terminalId });
    
    const stripAnsi = (input: string) => {
      return input
        // Standard CSI sequences: ESC [ ... letter
        .replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "")
        // OSC sequences: ESC ] ... BEL
        .replace(/\u001B\][^\u0007]*\u0007/g, "")
        // OSC sequences: ESC ] ... ESC \
        .replace(/\u001B\][^\u001B]*\u001B\\/g, "")
        // Charset sequences: ESC ( or ESC ) or ESC #
        .replace(/\u001B[()#][0-9A-Za-z]/g, "")
        // DEC private modes and other ESC sequences
        .replace(/\u001B[=>]/g, "")
        // Strip remaining escape + single char
        .replace(/\u001B./g, "")
        // Carriage returns
        .replace(/\r/g, "\n")
        // Multiple newlines to single
        .replace(/\n{3,}/g, "\n\n")
        // Leading/trailing whitespace per line
        .split("\n")
        .map((l) => l.trim())
        .join("\n");
    };

    const updatePreviewFromChunk = (rawChunk: string) => {
      const stripped = stripAnsi(rawChunk || "");
      if (!stripped) return;

      // Keep a rolling tail so we can reconstruct lines even when data arrives in small chunks
      previewTailRef.current = (previewTailRef.current + "\n" + stripped).slice(-1500);
      const lines = previewTailRef.current.split("\n").map((l) => l.trim());

      let bestClaude: string | null = null;
      let fallback: string | null = null;
      for (const line of lines) {
        if (!line || line.length < 15) continue;

        const alphaCount = (line.match(/[a-zA-Z]/g) || []).length;
        if (alphaCount < 10) continue;

        // Skip status bar and UI chrome (handle both full and split fragments)
        const lowerRaw = line.toLowerCase();
        // Normalize common unicode dash variants so "Auto–update" matches our filters.
        const lower = lowerRaw.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-");
        if (lower.startsWith("?") || lower.includes("shortcuts") || lower.includes("shortcut")) continue;
        if (lower.includes("anthropic") || lower.includes("antrhopic")) continue;
        if (/auto[\s-]*update/.test(lower)) continue;
        if (lower.includes("esc to interrupt")) continue;
        if (lower.includes("thinking")) continue;
        if (lower.includes("try claude doctor") || lower.includes("claude doctor")) continue;
        if (lower.includes("~/.claude/local")) continue;
        if (lower.includes("@anthropic-ai/claude-code")) continue;
        if (lower.includes("npm update")) continue;
        if (/^Claude Code v[\d.]+/i.test(line)) continue;
        if (/Sonnet.*Claude Pro/i.test(line)) continue;
        if (/^~\/[a-z]+$/i.test(line)) continue;
        if (line.includes("✗")) continue;

        // Prefer actual Claude output lines (they usually start with ●/•)
        const isClaudeLine = /^[●•]/.test(line);
        const content = line.replace(/^[●•❯>]\s*/, "").trim();
        if (content.length <= 15) continue;
        const contentLowerRaw = content.toLowerCase();
        const contentLower = contentLowerRaw.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-");
        // Extra guard: sometimes UI chrome appears with bullet markers
        if (
          contentLower.includes("shortcuts") ||
          contentLower.includes("shortcut") ||
          contentLower.includes("anthropic") ||
          contentLower.includes("antrhopic") ||
          /auto[\s-]*update/.test(contentLower) ||
          contentLower.includes("esc to interrupt")
        ) {
          continue;
        }

        // Only update preview from actual Claude lines; otherwise keep last known preview.
        if (isClaudeLine) {
          bestClaude = content;
        } else if (!fallback) {
          // Claude output sometimes doesn't include bullets; use a conservative fallback.
          // Skip prompt-like lines.
          if (!/^@(?:zsh|bash|sh|fish)\b/i.test(content) && !/^\$/.test(content)) {
            fallback = content;
          }
        }
      }

      const best = bestClaude || fallback;
      if (best && onUpdateAgentRef.current) {
        const next = best.slice(0, 150);
        onUpdateAgentRef.current({ output: [next], updatedAt: new Date().toISOString() });
        try {
          window.localStorage.setItem(`groovy:claude-code:preview:${agent.id}`, next);
        } catch {
          // ignore
        }
      }
    };
    
    const unsubscribe = relayRef.current.subscribe((msg) => {
      if (msg.terminal_id !== terminalIdRef.current) return;
      if (msg.type === "terminal_data") {
        updatePreviewFromChunk(String(msg.data || ""));
      }
      if (msg.type === "terminal_backlog") {
        updatePreviewFromChunk(String(msg.data || ""));
      }
    });
    
    return unsubscribe;
  }, [agent.id, agent.type, agent.terminalId, relay.status]);

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!quickResponse.trim()) return;
    
    // For ai-chat, datagran, and files-agent agents, use the chat API
    if ((agent.type === "ai-chat" || agent.type === "datagran" || agent.type === "files-agent") && agent.lastSessionId && onSendChatMessage) {
      setSending(true);
      try {
        await onSendChatMessage(agent.id, agent.lastSessionId, quickResponse.trim(), agent.type);
        setQuickResponse("");
      } catch (err) {
        console.error("Failed to send message:", err);
      } finally {
        setSending(false);
      }
    } else {
      console.log(`Response to ${agent.id}:`, quickResponse);
      setQuickResponse("");
    }
  };

  const flagConfig = agent.flag ? flagColors[agent.flag] : null;

  const handleNameDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditedName(agent.name);
    setIsEditingName(true);
    setTimeout(() => nameInputRef.current?.select(), 0);
  };

  const handleNameSave = async () => {
    const trimmed = editedName.trim();
    if (trimmed && trimmed !== agent.name && onRename) {
      await onRename(trimmed);
    }
    setIsEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleNameSave();
    } else if (e.key === "Escape") {
      setEditedName(agent.name);
      setIsEditingName(false);
    }
  };

  return (
    <motion.div
      layoutId={`agent-card-${agent.id}`}
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      transition={{ 
        layout: { type: "spring", damping: 30, stiffness: 300 },
        opacity: { duration: 0.2 },
        scale: { duration: 0.2 }
      }}
      onClick={(e) => {
        // Don't trigger card click if clicking on input area
        if ((e.target as HTMLElement).closest('.quick-response-area')) return;
        onClick();
      }}
      className={`
        glass rounded-xl p-3 sm:p-4 cursor-pointer relative overflow-hidden min-w-0 card-pressable
        border ${isThinking ? "border-cyan-500/50" : status.borderColor}
        shadow-lg ${isThinking ? "shadow-cyan-500/20" : status.glow}
        ${flagConfig ? `border-l-2 ${flagConfig.border}` : ""}
        ${isThinking ? "animate-pulse" : ""}
      `}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-white/5">
            <AgentIcon type={agent.type} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {isEditingName ? (
                <input
                  ref={nameInputRef}
                  type="text"
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  onBlur={handleNameSave}
                  onKeyDown={handleNameKeyDown}
                  onClick={(e) => e.stopPropagation()}
                  className="font-medium text-sm text-white bg-white/10 border border-white/20 rounded px-1.5 py-0.5 outline-none focus:border-cyan-500/50 w-full max-w-[150px]"
                  autoFocus
                />
              ) : (
                <h3 
                  className="font-medium text-sm text-white cursor-text hover:bg-white/5 rounded px-1 -mx-1 truncate"
                  onDoubleClick={handleNameDoubleClick}
                  title="Double-click to edit name"
                >
                  {agent.name}
                </h3>
              )}
              {agent.flag && <FlagBadge flag={agent.flag} flagColors={flagColors} />}
            </div>
            {agent.model ? (
              <ModelBadge provider={agent.model.provider} name={agent.model.name} />
            ) : (
              <span className="text-xs text-zinc-500 capitalize">{agent.type.replace("-", " ")}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-red-300 transition-colors"
            title="Delete agent"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <StatusIndicator status={agent.status} showLabel />
        </div>
      </div>

      {/* Task */}
      <p className="text-sm text-zinc-400 mb-3 line-clamp-2">{agent.task}</p>

      {/* Progress */}
      {agent.progress !== undefined && agent.status === "running" && (
        <div className="mb-3">
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-zinc-500">Progress</span>
            <span className="text-cyan-400 font-mono">{agent.progress}%</span>
          </div>
          <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-cyan-500 to-cyan-400 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${agent.progress}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
        </div>
      )}

      {/* Last Message Preview for AI Chat, Datagran, Cursor, and Files */}
      {(agent.type === "ai-chat" || agent.type === "datagran" || agent.type === "cursor" || agent.type === "files-agent") && (agent.lastMessage || isThinking) && (
        <div className="bg-black/30 rounded-lg p-2.5 mb-3">
          {isThinking ? (
            <div className="flex items-center gap-2">
              <div className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center ${
                agent.type === "cursor" ? "bg-emerald-500/20" : "bg-cyan-500/20"
              }`}>
                <Loader2 className={`w-3 h-3 animate-spin ${
                  agent.type === "cursor" ? "text-emerald-400" : "text-cyan-400"
                }`} />
              </div>
              <div className="flex items-center gap-1.5">
                <span className={`text-xs font-medium ${
                  agent.type === "cursor" ? "text-emerald-400" : "text-cyan-400"
                }`}>
                  {agent.type === "cursor" ? "Working" : "Thinking"}
                </span>
                <span className="flex gap-0.5">
                  <span className={`w-1 h-1 rounded-full animate-bounce ${
                    agent.type === "cursor" ? "bg-emerald-400" : "bg-cyan-400"
                  }`} style={{ animationDelay: "0ms" }} />
                  <span className={`w-1 h-1 rounded-full animate-bounce ${
                    agent.type === "cursor" ? "bg-emerald-400" : "bg-cyan-400"
                  }`} style={{ animationDelay: "150ms" }} />
                  <span className={`w-1 h-1 rounded-full animate-bounce ${
                    agent.type === "cursor" ? "bg-emerald-400" : "bg-cyan-400"
                  }`} style={{ animationDelay: "300ms" }} />
                </span>
              </div>
            </div>
          ) : agent.lastMessage ? (
            <div className="flex items-start gap-2">
              <div className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-medium ${
                agent.lastMessage.role === "user" 
                  ? agent.type === "cursor" ? "bg-emerald-500/20 text-emerald-400" : "bg-cyan-500/20 text-cyan-400"
                  : "bg-white/10 text-zinc-400"
              }`}>
                {agent.lastMessage.role === "user" ? "Y" : "AI"}
              </div>
              <p className="text-xs text-zinc-400 line-clamp-2 flex-1">
                {agent.lastMessage.content}
              </p>
            </div>
          ) : null}
        </div>
      )}

      {/* Output Preview (for non-chat agents, excluding cursor which uses lastMessage) */}
      {agent.type !== "ai-chat" && agent.type !== "datagran" && agent.type !== "cursor" && agent.type !== "files-agent" && agent.output && agent.output.length > 0 && (
        <div className="bg-black/30 rounded-lg p-2.5 mb-3 max-h-20 overflow-hidden">
          {(
            agent.type === "claude-code"
              ? agent.output.filter((l) => !isClaudeCodeChromeLine(l)).slice(-2)
              : agent.output.slice(-2)
          ).length > 0 ? (
            (
              agent.type === "claude-code"
                ? agent.output.filter((l) => !isClaudeCodeChromeLine(l)).slice(-2)
                : agent.output.slice(-2)
            ).map((line, i) => (
              <p key={i} className="text-xs font-mono text-zinc-500 truncate">
                {line}
              </p>
            ))
          ) : (
            <p className="text-xs text-zinc-600 italic">Open to view output…</p>
          )}
        </div>
      )}

      {/* Quick Chat Input for AI Chat, Datagran, and Files agents */}
      {(agent.type === "ai-chat" || agent.type === "datagran" || agent.type === "files-agent") && agent.lastSessionId && (
        <form 
          onSubmit={handleQuickSubmit}
          className="quick-response-area mt-3 pt-3 border-t border-cyan-500/20"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={quickResponse}
              onChange={(e) => setQuickResponse(e.target.value)}
              placeholder="Send a message..."
              disabled={isThinking}
              rows={1}
              className="flex-1 bg-black/30 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none border border-cyan-500/20 focus:border-cyan-500/50 transition-colors disabled:opacity-50 resize-none min-h-[38px] max-h-[120px]"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (quickResponse.trim() && !isThinking) {
                    handleQuickSubmit(e as unknown as React.FormEvent);
                  }
                }
              }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = "auto";
                target.style.height = Math.min(target.scrollHeight, 120) + "px";
              }}
            />
            <button
              type="submit"
              disabled={!quickResponse.trim() || isThinking}
              className="p-2 rounded-lg bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isThinking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </form>
      )}

      {/* Quick Input for Claude Code agents */}
      {agent.type === "claude-code" && agent.terminalId && relay.status === "ready" && (
        <form 
          onSubmit={(e) => {
            e.preventDefault();
            if (quickResponse.trim() && agent.terminalId) {
              onUpdateAgentRef.current?.({ updatedAt: new Date().toISOString() });
              // Send text, then a separate Enter to better mimic real typing.
              relay.send({
                type: "terminal_input",
                terminal_id: agent.terminalId,
                data: quickResponse,
              });
              window.setTimeout(() => {
                relay.send({
                  type: "terminal_input",
                  terminal_id: agent.terminalId,
                  data: "\r",
                });
              }, 10);
              setQuickResponse("");
            }
          }}
          className="quick-response-area mt-3 pt-3 border-t border-violet-500/20"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={quickResponse}
              onChange={(e) => setQuickResponse(e.target.value)}
              placeholder="Send to terminal..."
              disabled={agent.status === "running"}
              className="flex-1 bg-black/30 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none border border-violet-500/20 focus:border-violet-500/50 transition-colors disabled:opacity-50 font-mono"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="submit"
              disabled={!quickResponse.trim() || agent.status === "running"}
              className="p-2 rounded-lg bg-violet-500/20 text-violet-400 hover:bg-violet-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {agent.status === "running" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </form>
      )}

      {/* Quick Input for Cursor agents */}
      {agent.type === "cursor" && agent.cursorAgentId && agent.sendCursorFollowUp && (
        <form 
          onSubmit={async (e) => {
            e.preventDefault();
            if (quickResponse.trim() && agent.sendCursorFollowUp) {
              setSending(true);
              try {
                await agent.sendCursorFollowUp(quickResponse);
                setQuickResponse("");
              } finally {
                setSending(false);
              }
            }
          }}
          className="quick-response-area mt-3 pt-3 border-t border-emerald-500/20"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={quickResponse}
              onChange={(e) => setQuickResponse(e.target.value)}
              placeholder="Send follow-up instruction..."
              disabled={sending || agent.status === "running"}
              rows={1}
              className="flex-1 bg-black/30 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none border border-emerald-500/20 focus:border-emerald-500/50 transition-colors disabled:opacity-50 resize-none min-h-[38px] max-h-[120px]"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const form = e.currentTarget.closest("form");
                  if (form && quickResponse.trim() && !sending && agent.status !== "running") {
                    form.requestSubmit();
                  }
                }
              }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = "auto";
                target.style.height = Math.min(target.scrollHeight, 120) + "px";
              }}
            />
            <button
              type="submit"
              disabled={!quickResponse.trim() || sending || agent.status === "running"}
              className="p-2 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {sending || agent.status === "running" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </form>
      )}

      {/* Quick Response Input for awaiting-input (non-chat agents) */}
      {agent.type !== "ai-chat" && agent.status === "awaiting-input" && (
        <form 
          onSubmit={handleQuickSubmit}
          className="quick-response-area mt-3 pt-3 border-t border-amber-500/20"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={quickResponse}
              onChange={(e) => setQuickResponse(e.target.value)}
              placeholder="Type your response..."
              className="flex-1 bg-black/30 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none border border-amber-500/20 focus:border-amber-500/50 transition-colors"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="submit"
              disabled={!quickResponse.trim()}
              className="p-2 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </form>
      )}

      {/* Quick Auth Button (not for datagran - it handles its own auth) */}
      {agent.status === "awaiting-auth" && agent.type !== "datagran" && (
        <div className="quick-response-area mt-3 pt-3 border-t border-violet-500/20">
          <button
            onClick={(e) => {
              e.stopPropagation();
              console.log(`Authorize ${agent.id}`);
              // TODO: Open OAuth flow
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-violet-500/20 text-violet-400 hover:bg-violet-500/30 text-sm font-medium transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Authorize Access
          </button>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 border-t border-white/5 mt-3">
        <div className="flex items-center gap-1.5 text-xs text-zinc-500" title={agent.updatedAt ? new Date(agent.updatedAt).toLocaleString() : undefined}>
          <Clock className="w-3 h-3" />
          <span>{formatRelativeTime(agent.updatedAt)}</span>
        </div>
        <div className="flex items-center gap-1">
          {agent.status === "running" && (
            <button 
              onClick={(e) => e.stopPropagation()}
              className="p-1.5 rounded-md hover:bg-white/5 text-zinc-400 hover:text-white transition-colors"
            >
              <Pause className="w-3.5 h-3.5" />
            </button>
          )}
          {agent.status === "error" && (
            <button 
              onClick={(e) => e.stopPropagation()}
              className="p-1.5 rounded-md hover:bg-white/5 text-zinc-400 hover:text-white transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <button 
            onClick={(e) => e.stopPropagation()}
            className="p-1.5 rounded-md hover:bg-white/5 text-zinc-400 hover:text-white transition-colors"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </motion.div>
  );
};

const StatusBadge = ({
  status,
  count,
}: {
  status: AgentStatus;
  count: number;
}) => {
  const iconMap: Record<AgentStatus, typeof Loader2> = {
    running: Loader2,
    complete: CheckCircle2,
    ready: Radio,
    "awaiting-input": MessageSquare,
    "awaiting-auth": AlertTriangle,
    error: AlertTriangle,
    queued: Clock,
    paused: Pause,
  };

  const config = statusConfig[status];
  const Icon = iconMap[status];

  if (count === 0) return null;

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${config.bgColor}/10`}>
      <Icon className={`w-3.5 h-3.5 ${config.color} ${status === "running" ? "animate-spin" : ""}`} />
      <span className={`text-xs font-medium ${config.color}`}>{count}</span>
      <span className={`text-xs opacity-70 ${config.color}`}>{config.label}</span>
    </div>
  );
};

type MemoryBrainResult = {
  answer?: string; // AI-synthesized answer
  commands?: Array<{
    type: string;
    agent_name?: string;
    text?: string;
  }>;
  raw_data?: {
    mode?: string;
    short_term?: { raw_text?: string };
    mid_term?: { answer?: string };
    evidence?: Array<{ snippet?: string }>;
    trace_id?: string;
  };
  error?: string;
};

export default function Home() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const router = useRouter();

    // Agents are still mocked for non-chat types; chat agents will be DB-backed.
    const [agents, setAgents] = useState<Agent[]>([]);
    const [agentsLoading, setAgentsLoading] = useState(true);
    const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
    const [commandInput, setCommandInput] = useState("");
    // Datagran memory (global)
    const [showMemoryModal, setShowMemoryModal] = useState(false);
    const [memoryConfigured, setMemoryConfigured] = useState<boolean | null>(null);
    const [memoryApiKey, setMemoryApiKey] = useState("");
    const [memoryQuestion, setMemoryQuestion] = useState("");
    const [memoryLoading, setMemoryLoading] = useState(false);
    const [memorySaving, setMemorySaving] = useState(false);
    const [memoryError, setMemoryError] = useState<string | null>(null);
    const [memoryResult, setMemoryResult] = useState<MemoryBrainResult | null>(null);
    const [selectedFlag, setSelectedFlag] = useState<FlagColor | null>(null);
    const [detailPanelInput, setDetailPanelInput] = useState("");
    const detailInputRef = useRef<HTMLTextAreaElement>(null);
    const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
    const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null);
    const [isEditingPanelName, setIsEditingPanelName] = useState(false);
    const [editedPanelName, setEditedPanelName] = useState("");
    const panelNameInputRef = useRef<HTMLInputElement>(null);
    
    // Flag management
    const [flagColors, setFlagColors] = useState<Record<string, { bg: string; border: string; label: string }>>(defaultFlags);
    const [showNewFlagModal, setShowNewFlagModal] = useState(false);
    const [newFlagName, setNewFlagName] = useState("");
    const [newFlagColor, setNewFlagColor] = useState(availableFlagColors[0].id);

    // New agent modal
    const [showNewAgentModal, setShowNewAgentModal] = useState(false);
    const [showHelpModal, setShowHelpModal] = useState(false);
    const [newAgentType, setNewAgentType] = useState<"ai-chat" | "coding" | "datagran" | "files">(
      "ai-chat"
    );
    // Files agent setup
    const [newAgentFilesApiKey, setNewAgentFilesApiKey] = useState("");
    // Sub-type for coding agents
    const [newAgentCodingType, setNewAgentCodingType] = useState<"claude-code" | "cursor">("claude-code");
    const [newAgentName, setNewAgentName] = useState("");
    const [newAgentProvider, setNewAgentProvider] = useState<ModelProvider>("openai");
    const [newAgentModel, setNewAgentModel] = useState<string>(modelProviders.openai.models[0]);
    const [newAgentReasoningEffort, setNewAgentReasoningEffort] = useState<string>("medium");
    const [newAgentSystemPrompt, setNewAgentSystemPrompt] = useState<string>("");
    const [newAgentKeySource, setNewAgentKeySource] = useState<"user" | "groovy">("user");
    const [newAgentApiKey, setNewAgentApiKey] = useState("");
    const [newAgentFlag, setNewAgentFlag] = useState<string>("cyan");
    const [newAgentError, setNewAgentError] = useState<string | null>(null);
    const [creatingAgent, setCreatingAgent] = useState(false);

    // Datagran agent setup
    const [newAgentDatagranProvider, setNewAgentDatagranProvider] = useState<DatagranProvider>("google_ads");
    const [newAgentDatagranApiKey, setNewAgentDatagranApiKey] = useState("");
    const [newAgentAnthropicApiKey, setNewAgentAnthropicApiKey] = useState("");
    const [newIntegrationsKind, setNewIntegrationsKind] = useState<"datagran" | "obsidian">("datagran");
    const [obsidianVaults, setObsidianVaults] = useState<string[]>([]);
    const [obsidianVaultsLoading, setObsidianVaultsLoading] = useState(false);
    const [selectedObsidianVault, setSelectedObsidianVault] = useState<string>("");
    const [obsidianScanDebugOpen, setObsidianScanDebugOpen] = useState(false);
    const [obsidianScanRaw, setObsidianScanRaw] = useState<string>("");
    // Web Pixel site selection
    const [pixelSites, setPixelSites] = useState<Array<{ id: string; name: string; write_key_prefix?: string; status?: string }>>([]);
    const [pixelSitesLoading, setPixelSitesLoading] = useState(false);
    const [selectedPixelSiteId, setSelectedPixelSiteId] = useState<string>("");

    // Cursor agent setup
    const [newAgentCursorApiKey, setNewAgentCursorApiKey] = useState("");
    const [newAgentCursorApiKeyValid, setNewAgentCursorApiKeyValid] = useState(false);
    const [newAgentCursorValidating, setNewAgentCursorValidating] = useState(false);
    const [newAgentCursorRepos, setNewAgentCursorRepos] = useState<Array<{ owner: string; name: string; repository: string }>>([]);
    const [newAgentCursorReposLoading, setNewAgentCursorReposLoading] = useState(false);
    const [newAgentCursorRepository, setNewAgentCursorRepository] = useState("");
    const [newAgentCursorBranch, setNewAgentCursorBranch] = useState("main");
    const [newAgentCursorAutoCreatePr, setNewAgentCursorAutoCreatePr] = useState(false);

    // Claude Code agent setup
    const [devices, setDevices] = useState<Array<{ id: string; name: string; last_seen?: string | null }>>(
      []
    );
    const [workspaces, setWorkspaces] = useState<Array<{ id: string; device_id: string; label: string; root_path: string }>>(
      []
    );
    const [newAgentDeviceId, setNewAgentDeviceId] = useState<string>("");
    const [newAgentWorkspaceId, setNewAgentWorkspaceId] = useState<string>("");
    const [pairingCode, setPairingCode] = useState<string | null>(null);
    const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null);
    const [pairingLoading, setPairingLoading] = useState(false);
    const [pairingCodeCopied, setPairingCodeCopied] = useState(false);
    const [pairingCmdCopied, setPairingCmdCopied] = useState(false);
    const [workspacePickLoading, setWorkspacePickLoading] = useState(false);
    const [refreshLoading, setRefreshLoading] = useState(false);
    const workspacePickReqRef = useRef<string | null>(null);

    const [supabaseConfigured, setSupabaseConfigured] = useState(true);
    const [authed, setAuthed] = useState<boolean | null>(null);
    const relay = useRelay({ enabled: supabaseConfigured && authed === true });

    useEffect(() => {
      try {
        const supabase = getSupabaseBrowserClient();
        supabase.auth.getUser().then(({ data }) => {
          setAuthed(Boolean(data.user));
          // Identify user to Datagran pixel for existing sessions
          if (data.user?.id && data.user?.email) {
            identifyUser(data.user.id, data.user.email);
          }
        });
        const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
          setAuthed(Boolean(session?.user));
          // Identify user to Datagran pixel on auth state changes
          if (session?.user?.id && session?.user?.email) {
            identifyUser(session.user.id, session.user.email);
          }
        });
        return () => {
          sub.subscription.unsubscribe();
        };
      } catch {
        // Allow UI to run even if Supabase isn't configured yet.
        setSupabaseConfigured(false);
        setAuthed(true);
      }
    }, []);

    useEffect(() => {
      if (authed === false) {
        router.replace("/login");
      }
    }, [authed, router]);

    const loadMemoryConfig = useCallback(async () => {
      if (!supabaseConfigured || authed !== true) return;
      try {
        const res = await fetch("/api/memory/config");
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        setMemoryConfigured(Boolean(json?.configured));
      } catch {
        // Don't block dashboard if this fails
        setMemoryConfigured(false);
      }
    }, [authed, supabaseConfigured]);

    useEffect(() => {
      loadMemoryConfig().catch(() => {});
    }, [loadMemoryConfig]);

    const openMemoryModalWithQuestion = useCallback((q?: string) => {
      const nextQ = (q || "").trim();
      setShowMemoryModal(true);
      setMemoryError(null);
      setMemoryResult(null);
      if (nextQ) setMemoryQuestion(nextQ);
    }, []);

    const saveMemoryConfig = useCallback(async () => {
      const apiKey = memoryApiKey.trim();
      if (!apiKey) {
        setMemoryError("Datagran API key is required.");
        return;
      }
      setMemorySaving(true);
      setMemoryError(null);
      try {
        const res = await fetch("/api/memory/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        setMemoryApiKey("");
        await loadMemoryConfig();
      } catch (e) {
        setMemoryError(e instanceof Error ? e.message : "Failed to save Datagran memory config");
      } finally {
        setMemorySaving(false);
      }
    }, [loadMemoryConfig, memoryApiKey]);

    const runMemoryQuery = useCallback(async (q?: string) => {
      const question = (q ?? memoryQuestion).trim();
      if (!question) return;
      setMemoryLoading(true);
      setMemoryError(null);
      setMemoryResult(null);
      try {
        const res = await fetch("/api/memory/brain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, mind_state: "auto" }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        const result = json as MemoryBrainResult;
        setMemoryResult(result);

        // Execute any commands returned by the AI
        if (result.commands && result.commands.length > 0) {
          for (const cmd of result.commands) {
            if (cmd.type === "open_agent" && cmd.agent_name) {
              // Find agent by name (partial match, case insensitive)
              const agentToOpen = agents.find(a =>
                a.name.toLowerCase().includes(cmd.agent_name!.toLowerCase())
              );
              if (agentToOpen) {
                setSelectedAgent(agentToOpen);
                setShowMemoryModal(false); // Close modal when opening agent
              }
            } else if (cmd.type === "close_agent") {
              setSelectedAgent(null);
            } else if (cmd.type === "type_text" && cmd.text) {
              // Will type after agent opens
              setDetailPanelInput(cmd.text);
            } else if (cmd.type === "clear_input") {
              setDetailPanelInput("");
            }
          }
        }
      } catch (e) {
        setMemoryError(e instanceof Error ? e.message : "Failed to query memory");
      } finally {
        setMemoryLoading(false);
      }
    }, [memoryQuestion, agents]);

    const reloadDevicesAndWorkspaces = useCallback(async (showLoading = false) => {
      if (!supabaseConfigured || authed !== true) return;
      if (showLoading) setRefreshLoading(true);
      try {
        const supabase = getSupabaseBrowserClient();
        const [{ data: devs }, { data: wss }] = await Promise.all([
          supabase
            .from("devices")
            .select("id,name,last_seen,created_at")
            .order("created_at", { ascending: false }),
          supabase
            .from("device_workspaces")
            .select("id,device_id,label,root_path,created_at")
            .order("created_at", { ascending: false }),
        ]);
        setDevices(
          (devs || []) as unknown as Array<{
            id: string;
            name: string;
            last_seen?: string | null;
          }>
        );
        setWorkspaces(
          (wss || []) as unknown as Array<{
            id: string;
            device_id: string;
            label: string;
            root_path: string;
          }>
        );
      } catch {
        // ignore
      } finally {
        if (showLoading) setRefreshLoading(false);
      }
    }, [authed, supabaseConfigured]);

    useEffect(() => {
      reloadDevicesAndWorkspaces().catch(() => {});
    }, [reloadDevicesAndWorkspaces]);

    useEffect(() => {
      if (newAgentType !== "coding" || newAgentCodingType !== "claude-code") return;
      if (!newAgentDeviceId && devices.length > 0) {
        setNewAgentDeviceId(devices[0].id);
      }
    }, [devices, newAgentDeviceId, newAgentType, newAgentCodingType]);

    useEffect(() => {
      if (newAgentType !== "coding" || newAgentCodingType !== "claude-code") return;
      const scoped = workspaces.filter((w) => w.device_id === newAgentDeviceId);
      if (!newAgentWorkspaceId && scoped.length > 0) {
        setNewAgentWorkspaceId(scoped[0].id);
      }
    }, [newAgentDeviceId, newAgentType, newAgentCodingType, newAgentWorkspaceId, workspaces]);

    useEffect(() => {
      if (relay.status !== "ready") return;
      return relay.subscribe((msg) => {
        if (msg.type === "device_online" || msg.type === "device_offline") {
          reloadDevicesAndWorkspaces().catch(() => {});
        }
        if (msg.type === "workspace_added") {
          const ws = msg.workspace as unknown;
          const req = String(msg.request_id || "");
          if (req && workspacePickReqRef.current && req !== workspacePickReqRef.current) {
            return;
          }
          if (ws && typeof ws === "object") {
            const rec = ws as Record<string, unknown>;
            const id = typeof rec.id === "string" ? rec.id : "";
            const deviceId = typeof rec.device_id === "string" ? rec.device_id : "";
            if (id && deviceId) {
              const row = {
                id,
                device_id: deviceId,
                label: typeof rec.label === "string" ? rec.label : id,
                root_path: typeof rec.root_path === "string" ? rec.root_path : "",
              };
              setWorkspaces((prev) => [row, ...prev.filter((p) => p.id !== row.id)]);
              setNewAgentDeviceId(deviceId);
              setNewAgentWorkspaceId(id);
            }
          }
          setWorkspacePickLoading(false);
          workspacePickReqRef.current = null;
        }
        if (msg.type === "workspace_pick_result" && msg.ok === false) {
          const req = String(msg.request_id || "");
          if (req && workspacePickReqRef.current && req === workspacePickReqRef.current) {
            setWorkspacePickLoading(false);
            workspacePickReqRef.current = null;
            setNewAgentError(String(msg.error || "Workspace pick cancelled"));
          }
        }
      });
    }, [relay, reloadDevicesAndWorkspaces]);
    
    // Clear input when agent changes
    useEffect(() => {
      setDetailPanelInput("");
    }, [selectedAgent?.id]);
    
    // Add new flag (persist to Supabase when available)
    const handleAddFlag = async () => {
      const label = newFlagName.trim();
      if (!label) return;

      const colorConfig =
        availableFlagColors.find((c) => c.id === newFlagColor) ||
        availableFlagColors[0];

      const base =
        label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "flag";

      let key = base;
      let i = 2;
      while (flagColors[key]) {
        key = `${base}-${i++}`;
      }

      const next = { bg: colorConfig.bg, border: colorConfig.border, label };

      // optimistic UI
      setFlagColors((prev) => ({ ...prev, [key]: next }));
      setNewFlagName("");
      setNewFlagColor(availableFlagColors[0].id);
      setShowNewFlagModal(false);

      if (!supabaseConfigured || authed !== true) return;
      try {
        const supabase = getSupabaseBrowserClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        await supabase.from("flags").insert({
          user_id: user.id,
          key,
          label,
          bg: next.bg,
          border: next.border,
        });
      } catch {
        // ignore; next reload will reflect DB state
      }
    };

    // Delete flag (persist to Supabase when available)
    const handleDeleteFlag = async (flagKey: string) => {
      // Don't allow deleting if agents are using this flag
      const agentsUsingFlag = agents.filter(a => a.flag === flagKey);
      if (agentsUsingFlag.length > 0) {
        alert(`Cannot delete flag: ${agentsUsingFlag.length} agent(s) are using it. Remove the flag from those agents first.`);
        return;
      }

      // Optimistic UI
      setFlagColors((prev) => {
        const next = { ...prev };
        delete next[flagKey];
        return next;
      });

      // Clear selected flag if it was the deleted one
      if (selectedFlag === flagKey) {
        setSelectedFlag(null);
      }

      if (!supabaseConfigured || authed !== true) return;
      try {
        const supabase = getSupabaseBrowserClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        await supabase.from("flags").delete().eq("user_id", user.id).eq("key", flagKey);
      } catch {
        // ignore; next reload will reflect DB state
      }
    };

    // Load flags + chat agents from Supabase (if configured)
    useEffect(() => {
      if (!supabaseConfigured || authed !== true) {
        setAgentsLoading(false);
        return;
      }

      const supabase = getSupabaseBrowserClient();
      let cancelled = false;
      setAgentsLoading(true);

      const run = async () => {
        try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        // ---- Flags
        let { data: flags } = await supabase
          .from("flags")
          .select("key,label,bg,border")
          .order("created_at", { ascending: true });

        if (!flags || flags.length === 0) {
          const seed = Object.entries(defaultFlags).map(([key, cfg]) => ({
            user_id: user.id,
            key,
            label: cfg.label,
            bg: cfg.bg,
            border: cfg.border,
          }));
          await supabase.from("flags").insert(seed);
          const { data: seeded } = await supabase
            .from("flags")
            .select("key,label,bg,border")
            .order("created_at", { ascending: true });
          flags = seeded || [];
        }

        const nextFlagColors: Record<string, { bg: string; border: string; label: string }> =
          {};
          (flags || []).forEach((f) => {
          nextFlagColors[f.key] = { bg: f.bg, border: f.border, label: f.label };
        });

        if (!cancelled && Object.keys(nextFlagColors).length) {
          setFlagColors(nextFlagColors);
        }

          // ---- Agents (ai-chat + claude-code)
        let { data: dbAgents } = await supabase
          .from("agents")
          .select("id,type,name,flag_key,provider,model,llm_key_source,llm_api_key_hash,updated_at")
          .order("created_at", { ascending: true });
          dbAgents = dbAgents || [];

        // Fetch last session + last message for each chat agent
        const chatAgents: Agent[] = await Promise.all(
          (dbAgents || [])
              .filter((a) => a.type === "ai-chat")
              .map(async (a) => {
              let lastSessionId: string | undefined;
              let lastMessage: { role: "user" | "assistant"; content: string } | undefined;

              // Get most recent session
              const { data: sessions } = await supabase
                .from("chat_sessions")
                .select("id")
                .eq("agent_id", a.id)
                .order("updated_at", { ascending: false })
                .limit(1);

              if (sessions && sessions.length > 0) {
                lastSessionId = sessions[0].id;

                // Get last message from that session
                const { data: messages } = await supabase
                  .from("chat_messages")
                  .select("role, content")
                  .eq("session_id", lastSessionId)
                  .order("created_at", { ascending: false })
                  .limit(1);

                if (messages && messages.length > 0) {
                  lastMessage = {
                    role: messages[0].role as "user" | "assistant",
                    content: messages[0].content,
                  };
                }
              }

              return {
                id: a.id,
                name: a.name,
                type: "ai-chat" as const,
                status: "ready" as const,
                task: lastMessage ? "Chat active" : "Ready to chat",
                output: [],
                llmKeySource:
                  a.llm_key_source === "groovy" ? "groovy" : ("user" as const),
                llmApiKeyHash: (a.llm_api_key_hash as string | null) ?? null,
                model: a.provider
                  ? { provider: a.provider as ModelProvider, name: (a.model as string) || "unknown" }
                  : undefined,
                flag: a.flag_key || undefined,
                updatedAt: a.updated_at as string | undefined,
                lastSessionId,
                lastMessage,
              };
            })
        );

          // Claude Code agents (terminal-backed)
          const claudeRows = (dbAgents || []).filter((a) => a.type === "claude-code");
          const configByAgent = new Map<string, { device_id: string; workspace_id: string }>();
          if (claudeRows.length > 0) {
            const { data: configs } = await supabase
              .from("claude_code_agent_configs")
              .select("agent_id, device_id, workspace_id")
              .in(
                "agent_id",
                claudeRows.map((a) => a.id)
              );
            (configs || []).forEach((c) => {
              if (c?.agent_id) {
                configByAgent.set(String(c.agent_id), {
                  device_id: String(c.device_id),
                  workspace_id: String(c.workspace_id),
                });
              }
            });
          }

          const claudeAgents: Agent[] = claudeRows.map((a) => {
            const hasConfig = configByAgent.has(String(a.id));
            return {
              id: a.id,
              name: a.name,
              type: "claude-code" as const,
              status: hasConfig ? "ready" : "awaiting-auth",
              task: hasConfig ? "Terminal ready" : "Authorize device + workspace",
              output: [],
              flag: a.flag_key || undefined,
              updatedAt: a.updated_at as string | undefined,
            };
          });

          // Cursor agents (cloud-based)
          const cursorRows = (dbAgents || []).filter((a) => a.type === "cursor");
          const cursorConfigByAgent = new Map<string, boolean>();
          if (cursorRows.length > 0) {
            const { data: cursorConfigs } = await supabase
              .from("cursor_agent_configs")
              .select("agent_id, cursor_api_key_hash")
              .in(
                "agent_id",
                cursorRows.map((a) => a.id)
              );
            (cursorConfigs || []).forEach((c) => {
              if (c?.agent_id && c?.cursor_api_key_hash) {
                cursorConfigByAgent.set(String(c.agent_id), true);
              }
            });
          }

          const cursorAgents: Agent[] = cursorRows.map((a) => {
            const hasConfig = cursorConfigByAgent.has(String(a.id));
            return {
              id: a.id,
              name: a.name,
              type: "cursor" as const,
              status: hasConfig ? "ready" : "awaiting-auth",
              task: hasConfig ? "Cloud agent ready" : "Configure API key",
              output: [],
              flag: a.flag_key || undefined,
              updatedAt: a.updated_at as string | undefined,
            };
          });

          // Datagran agents - fetch last session + message like ai-chat
          const datagranRows = (dbAgents || []).filter((a) => a.type === "datagran");
          const datagranConfigByAgent = new Map<string, boolean>();
          if (datagranRows.length > 0) {
            const { data: datagranConfigs } = await supabase
              .from("datagran_agent_configs")
              .select("agent_id, connection_id")
              .in(
                "agent_id",
                datagranRows.map((a) => a.id)
              );
            (datagranConfigs || []).forEach((c) => {
              if (c?.agent_id && c?.connection_id) {
                datagranConfigByAgent.set(String(c.agent_id), true);
              }
            });
          }

          const datagranAgents: Agent[] = await Promise.all(
            datagranRows.map(async (a) => {
              const hasConfig = datagranConfigByAgent.has(String(a.id));
              let lastSessionId: string | undefined;
              let lastMessage: { role: "user" | "assistant"; content: string } | undefined;

              // Get most recent session (same as ai-chat)
              if (hasConfig) {
                const { data: sessions } = await supabase
                  .from("chat_sessions")
                  .select("id")
                  .eq("agent_id", a.id)
                  .order("updated_at", { ascending: false })
                  .limit(1);

                if (sessions && sessions.length > 0) {
                  lastSessionId = sessions[0].id;

                  // Get last message from that session
                  const { data: messages } = await supabase
                    .from("chat_messages")
                    .select("role, content")
                    .eq("session_id", lastSessionId)
                    .order("created_at", { ascending: false })
                    .limit(1);

                  if (messages && messages.length > 0) {
                    lastMessage = {
                      role: messages[0].role as "user" | "assistant",
                      content: messages[0].content,
                    };
                  }
                }
              }

              return {
                id: a.id,
                name: a.name,
                type: "datagran" as const,
                status: hasConfig ? "ready" : "awaiting-auth",
                task: hasConfig ? (lastMessage ? "Chat active" : "Connected to data source") : "Connect data source",
                output: [],
                flag: a.flag_key || undefined,
                updatedAt: a.updated_at as string | undefined,
                lastSessionId,
                lastMessage,
              };
            })
          );

          // Obsidian agents - fetch last session + message like ai-chat
          const obsidianRows = (dbAgents || []).filter((a) => a.type === "obsidian");
          const obsidianConfigByAgent = new Map<
            string,
            { device_id: string; vault_workspace_id: string; claude_code_agent_id: string; vault_label?: string | null }
          >();
          if (obsidianRows.length > 0) {
            const { data: obsidianConfigs } = await supabase
              .from("obsidian_agent_configs")
              .select("agent_id, device_id, vault_workspace_id, claude_code_agent_id, vault_label")
              .in(
                "agent_id",
                obsidianRows.map((a) => a.id)
              );
            (obsidianConfigs || []).forEach((c) => {
              if (c?.agent_id && c?.device_id && c?.vault_workspace_id && c?.claude_code_agent_id) {
                obsidianConfigByAgent.set(String(c.agent_id), {
                  device_id: String(c.device_id),
                  vault_workspace_id: String(c.vault_workspace_id),
                  claude_code_agent_id: String(c.claude_code_agent_id),
                  vault_label: (c as unknown as { vault_label?: string | null }).vault_label ?? null,
                });
              }
            });
          }

          const obsidianAgents: Agent[] = await Promise.all(
            obsidianRows.map(async (a) => {
              const cfg = obsidianConfigByAgent.get(String(a.id));
              const hasConfig = Boolean(cfg);
              let lastSessionId: string | undefined;
              let lastMessage: { role: "user" | "assistant"; content: string } | undefined;

              if (hasConfig) {
                const { data: sessions } = await supabase
                  .from("chat_sessions")
                  .select("id")
                  .eq("agent_id", a.id)
                  .order("updated_at", { ascending: false })
                  .limit(1);

                if (sessions && sessions.length > 0) {
                  lastSessionId = sessions[0].id;

                  const { data: messages } = await supabase
                    .from("chat_messages")
                    .select("role, content")
                    .eq("session_id", lastSessionId)
                    .order("created_at", { ascending: false })
                    .limit(1);

                  if (messages && messages.length > 0) {
                    lastMessage = {
                      role: messages[0].role as "user" | "assistant",
                      content: messages[0].content,
                    };
                  }
                }
              }

              return {
                id: a.id,
                name: a.name,
                type: "obsidian" as const,
                status: hasConfig ? "ready" : "awaiting-auth",
                task: hasConfig ? (lastMessage ? "Chat active" : "Vault connected") : "Connect Obsidian vault",
                output: [],
                flag: a.flag_key || undefined,
                updatedAt: a.updated_at as string | undefined,
                lastSessionId,
                lastMessage,
              };
            })
          );

          // Files agents - fetch last session + message like ai-chat
          const filesAgents: Agent[] = await Promise.all(
            (dbAgents || [])
              .filter((a) => a.type === "files-agent")
              .map(async (a) => {
                let lastSessionId: string | undefined;
                let lastMessage: { role: "user" | "assistant"; content: string } | undefined;

                // Get most recent session
                const { data: sessions } = await supabase
                  .from("chat_sessions")
                  .select("id")
                  .eq("agent_id", a.id)
                  .order("updated_at", { ascending: false })
                  .limit(1);

                if (sessions && sessions.length > 0) {
                  lastSessionId = sessions[0].id;

                  // Get last message from that session
                  const { data: messages } = await supabase
                    .from("chat_messages")
                    .select("role, content")
                    .eq("session_id", lastSessionId)
                    .order("created_at", { ascending: false })
                    .limit(1);

                  if (messages && messages.length > 0) {
                    lastMessage = {
                      role: messages[0].role as "user" | "assistant",
                      content: messages[0].content,
                    };
                  }
                }

                return {
                  id: a.id,
                  name: a.name,
                  type: "files-agent" as const,
                  status: "ready" as const,
                  task: lastMessage ? "Files processed" : "Ready to process files",
                  output: [],
                  model: { provider: "anthropic" as ModelProvider, name: "claude-opus-4.6" },
                  flag: a.flag_key || undefined,
                  updatedAt: a.updated_at as string | undefined,
                  lastSessionId,
                  lastMessage,
                };
              })
          );

          const merged = [...chatAgents, ...claudeAgents, ...cursorAgents, ...datagranAgents, ...obsidianAgents, ...filesAgents];

        if (!cancelled) {
          setAgents(merged);
          if (selectedAgent) {
            const updated = merged.find((a) => a.id === selectedAgent.id);
            if (updated) setSelectedAgent(updated);
          }
          }
        } finally {
          if (!cancelled) setAgentsLoading(false);
        }
      };

      run().catch(() => {
        if (!cancelled) setAgentsLoading(false);
      });

      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authed, supabaseConfigured]);

    const handleCreateAiChatAgent = async () => {
      setNewAgentError(null);
      const name = newAgentName.trim();
      if (!name) {
        setNewAgentError("Agent name is required.");
        return;
      }

      setCreatingAgent(true);
      try {
        const provider = newAgentProvider;
        const keySource: "user" | "groovy" =
          provider === "openai" ? newAgentKeySource : "user";
        const needsUserKey = keySource === "user";
        const apiKey = newAgentApiKey.trim();

        if (needsUserKey && !apiKey) {
          throw new Error(
            `Missing API key for ${modelProviders[provider].name}. Add your key or use the Groovy OpenAI test key option.`
          );
        }

        // AI chat agent creation must be server-side so we can encrypt the key with a server master key.
        const res = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "ai-chat",
            name,
            flagKey: newAgentFlag || null,
            provider: newAgentProvider,
            model: newAgentModel,
            llmKeySource: newAgentProvider === "openai" ? newAgentKeySource : "user",
            apiKey: newAgentApiKey,
            reasoningEffort: (newAgentProvider === "openai" || newAgentProvider === "anthropic") ? newAgentReasoningEffort : undefined,
            systemPrompt: newAgentSystemPrompt.trim() || undefined,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);

        const data = json.agent as {
          id: string;
          name: string;
          flag_key: string | null;
          provider: string | null;
          model: string | null;
          llm_key_source: string | null;
          llm_api_key_hash: string | null;
        };
        const sessionId = (json.sessionId as string | null) || undefined;

        const created: Agent = {
          id: data.id,
          name: data.name,
          type: "ai-chat",
          status: "ready",
          task: "Ready to chat",
          output: [],
          llmKeySource: data.llm_key_source === "groovy" ? "groovy" : ("user" as const),
          llmApiKeyHash: data.llm_api_key_hash ?? null,
          model: data.provider
            ? { provider: data.provider as ModelProvider, name: (data.model as string) || "unknown" }
            : undefined,
          flag: data.flag_key || undefined,
          lastSessionId: sessionId,
        };

        setAgents((prev) => [...prev, created]);
        setSelectedAgent(created);
        setShowNewAgentModal(false);
        setNewAgentName("");
        setNewAgentApiKey("");
        setNewAgentSystemPrompt("");
      } catch (err) {
        setNewAgentError(getErrorMessage(err) || "Failed to create agent");
      } finally {
        setCreatingAgent(false);
      }
    };

    const handleCreateFilesAgent = async () => {
      setNewAgentError(null);
      const name = newAgentName.trim();
      if (!name) {
        setNewAgentError("Agent name is required.");
        return;
      }

      const apiKey = newAgentFilesApiKey.trim();
      if (!apiKey) {
        setNewAgentError("Anthropic API key is required for Files Agent.");
        return;
      }

      setCreatingAgent(true);
      try {
        const res = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "files-agent",
            name,
            flagKey: newAgentFlag || null,
            apiKey,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);

        const data = json.agent as {
          id: string;
          name: string;
          flag_key: string | null;
          provider: string | null;
          model: string | null;
        };
        const sessionId = (json.sessionId as string | null) || undefined;

        const created: Agent = {
          id: data.id,
          name: data.name,
          type: "files-agent",
          status: "ready",
          task: "Ready to process files",
          output: [],
          model: { provider: "anthropic" as ModelProvider, name: "claude-opus-4.6" },
          flag: data.flag_key || undefined,
          lastSessionId: sessionId,
        };

        setAgents((prev) => [...prev, created]);
        setSelectedAgent(created);
        setShowNewAgentModal(false);
        setNewAgentName("");
        setNewAgentFilesApiKey("");
      } catch (err) {
        setNewAgentError(getErrorMessage(err) || "Failed to create agent");
      } finally {
        setCreatingAgent(false);
      }
    };

    const handleGeneratePairingCode = async () => {
      setNewAgentError(null);
      setPairingLoading(true);
      try {
        setPairingCodeCopied(false);
        setPairingCmdCopied(false);
        const res = await fetch("/api/devices/pairing-code", { method: "POST" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(json?.error || `HTTP ${res.status}`);
        }
        setPairingCode(String(json.code || ""));
        setPairingExpiresAt(String(json.expires_at || ""));

        // Give the connector some time to claim the code, then refresh.
        const started = Date.now();
        const poll = setInterval(() => {
          reloadDevicesAndWorkspaces().catch(() => {});
          if (Date.now() - started > 30_000) clearInterval(poll);
        }, 2000);
        setTimeout(() => clearInterval(poll), 32_000);
      } catch (err) {
        setNewAgentError(getErrorMessage(err) || "Failed to generate pairing code");
      } finally {
        setPairingLoading(false);
      }
    };

    const handlePickWorkspace = async () => {
      setNewAgentError(null);
      if (!newAgentDeviceId) {
        setNewAgentError("Select a device first.");
        return;
      }
      if (relay.status !== "ready") {
        setNewAgentError(relay.error || "Relay not connected.");
        return;
      }
      if (workspacePickLoading) return;

      setWorkspacePickLoading(true);
      const req = crypto.randomUUID();
      workspacePickReqRef.current = req;
      relay.send({ type: "workspace_pick", request_id: req, device_id: newAgentDeviceId });
    };

    const handleCreateClaudeCodeAgent = async () => {
      setNewAgentError(null);
      const name = newAgentName.trim();
      if (!name) {
        setNewAgentError("Agent name is required.");
        return;
      }
      if (!newAgentDeviceId) {
        setNewAgentError("Select a device to run Claude Code on.");
        return;
      }
      if (!newAgentWorkspaceId) {
        setNewAgentError("Select a workspace folder.");
        return;
      }
      if (!supabaseConfigured || authed !== true) {
        setNewAgentError("Supabase must be configured to create Claude Code agents.");
        return;
      }

      setCreatingAgent(true);
      try {
        const supabase = getSupabaseBrowserClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) throw new Error("Not signed in");

        const { data: agentRow, error: agentError } = await supabase
          .from("agents")
          .insert({
            user_id: user.id,
            type: "claude-code",
            name,
            flag_key: newAgentFlag || null,
            provider: null,
            model: null,
          })
          .select("id,type,name,flag_key")
          .single();

        if (agentError || !agentRow) {
          throw agentError || new Error("Failed to create agent");
        }

        const { error: cfgError } = await supabase.from("claude_code_agent_configs").insert({
          agent_id: agentRow.id,
          user_id: user.id,
          device_id: newAgentDeviceId,
          workspace_id: newAgentWorkspaceId,
        });
        if (cfgError) throw cfgError;

        const created: Agent = {
          id: agentRow.id,
          name: agentRow.name,
          type: "claude-code",
          status: "ready",
          task: "Terminal ready",
          output: [],
          flag: agentRow.flag_key || undefined,
        };

        setAgents((prev) => [...prev, created]);
        setSelectedAgent(created);
        setShowNewAgentModal(false);
        setNewAgentName("");
        setNewAgentError(null);
      } catch (err) {
        setNewAgentError(getErrorMessage(err) || "Failed to create agent");
      } finally {
        setCreatingAgent(false);
      }
    };

    const handleValidateCursorApiKey = async () => {
      const apiKey = newAgentCursorApiKey.trim();
      if (!apiKey) {
        setNewAgentError("Enter your Cursor API key first.");
        return;
      }

      setNewAgentCursorValidating(true);
      setNewAgentError(null);

      try {
        const res = await fetch("/api/cursor/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey, fetchRepos: true }),
        });

        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.error || "Invalid API key");
        }

        setNewAgentCursorApiKeyValid(true);
        setNewAgentCursorRepos(json.repositories || []);

        // Auto-select first repo if available
        if (json.repositories?.length > 0 && !newAgentCursorRepository) {
          setNewAgentCursorRepository(json.repositories[0].repository);
        }
      } catch (e) {
        setNewAgentError(getErrorMessage(e) || "Failed to validate API key");
        setNewAgentCursorApiKeyValid(false);
      } finally {
        setNewAgentCursorValidating(false);
      }
    };

    const handleCreateCursorAgent = async () => {
      setNewAgentError(null);
      const name = newAgentName.trim();
      if (!name) {
        setNewAgentError("Agent name is required.");
        return;
      }
      const cursorApiKey = newAgentCursorApiKey.trim();
      if (!cursorApiKey) {
        setNewAgentError("Cursor API key is required.");
        return;
      }
      if (!supabaseConfigured || authed !== true) {
        setNewAgentError("Supabase must be configured to create Cursor agents.");
        return;
      }

      setCreatingAgent(true);
      try {
        const res = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "cursor",
            name,
            flagKey: newAgentFlag || null,
            cursorApiKey,
            defaultRepository: newAgentCursorRepository || null,
            defaultBranch: newAgentCursorBranch || "main",
            autoCreatePr: newAgentCursorAutoCreatePr,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || "Failed to create agent");

        const agentRow = json.agent;
        const created: Agent = {
          id: agentRow.id,
          name: agentRow.name,
          type: "cursor",
          status: "ready",
          task: "Cloud agent ready",
          output: [],
          flag: agentRow.flag_key || undefined,
        };

        setAgents((prev) => [...prev, created]);
        setSelectedAgent(created);
        setShowNewAgentModal(false);
        setNewAgentName("");
        setNewAgentCursorApiKey("");
        setNewAgentCursorApiKeyValid(false);
        setNewAgentCursorRepos([]);
        setNewAgentCursorRepository("");
        setNewAgentError(null);
      } catch (err) {
        setNewAgentError(getErrorMessage(err) || "Failed to create agent");
      } finally {
        setCreatingAgent(false);
      }
    };

    // Load pixel sites when web_pixel is selected and API key is provided
    const loadPixelSites = async (apiKey: string) => {
      if (!apiKey.trim()) {
        setPixelSites([]);
        return;
      }
      setPixelSitesLoading(true);
      try {
        const res = await fetch("/api/datagran/pixel-sites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: apiKey.trim() }),
        });
        if (!res.ok) throw new Error("Failed to load pixel sites");
        const data = await res.json();
        setPixelSites(data.sites || []);
      } catch {
        setPixelSites([]);
      } finally {
        setPixelSitesLoading(false);
      }
    };

    const scanForObsidianVaults = async () => {
      setNewAgentError(null);
      setObsidianVaults([]);
      setSelectedObsidianVault("");
      setObsidianScanRaw("");

      if (!newAgentDeviceId) {
        setNewAgentError("Select a device first.");
        return;
      }
      
      // Find any workspace for this device to use for the shell session
      // (The scan itself runs from $HOME regardless, but relay needs a valid workspace_id)
      const deviceWorkspaces = workspaces.filter((w) => w.device_id === newAgentDeviceId);
      const workspaceForScan = deviceWorkspaces[0]?.id || "";
      if (!workspaceForScan) {
        setNewAgentError("Pick a folder first using the button below. This gives us shell access to scan your machine.");
        return;
      }
      
      if (relay.status !== "ready") {
        setNewAgentError(relay.error || "Relay not connected.");
        return;
      }
      if (obsidianVaultsLoading) return;

      setObsidianVaultsLoading(true);

      const requestId = crypto.randomUUID();
      const terminalId = crypto.randomUUID();
      let opened = false;
      let buffer = "";
      let done = false;
      let scanTimeoutId: number | null = null;
      let settleTimerId: number | null = null;
      const found = new Set<string>();

      const cleanup = () => {
        try {
          relay.send({ type: "terminal_close", terminal_id: terminalId });
        } catch {
          // ignore
        }
      };

      const finish = () => {
        if (done) return;
        done = true;
        if (scanTimeoutId) {
          window.clearTimeout(scanTimeoutId);
          scanTimeoutId = null;
        }
        if (settleTimerId) {
          window.clearTimeout(settleTimerId);
          settleTimerId = null;
        }
        const unique = Array.from(found);
        setObsidianVaults(unique);
        if (unique.length === 1) setSelectedObsidianVault(unique[0]);
        if (unique.length === 0) setObsidianScanDebugOpen(true);
        cleanup();
        unsubscribe();
        setObsidianVaultsLoading(false);
      };

      const unsubscribe = relay.subscribe((msg) => {
        if (msg.type === "terminal_opened") {
          if (String(msg.request_id || "") !== requestId) return;
          if (String(msg.terminal_id || "") !== terminalId) return;
          opened = true;

          // Strategy: print actual ".obsidian" folder paths (easy to regex, robust with spaces/unicode),
          // then we strip the trailing "/.obsidian" in JS.
          // Use single quotes for bash -lc so $variables survive to the inner shell.
          const bashScript = `
ICLOUD="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents"
if [ -d "$ICLOUD" ]; then find "$ICLOUD" -maxdepth 8 -type d -name ".obsidian" 2>/dev/null | head -50; fi
for D in "$HOME/Documents" "$HOME/Desktop" "$HOME/Obsidian" "$HOME/obsidian"; do
  if [ -d "$D" ]; then find "$D" -maxdepth 8 -type d -name ".obsidian" 2>/dev/null | head -50; fi
done
`.trim();

          // Write script to a temp file and execute it (avoids all quoting hell)
          const cmd = `cat << 'GROOVY_SCAN_EOF' | bash\n${bashScript}\nGROOVY_SCAN_EOF\r`;
          relay.send({ type: "terminal_input", terminal_id: terminalId, data: cmd });

          // Hard timeout: if scan doesn't complete, stop it and show debug output.
          scanTimeoutId = window.setTimeout(() => {
            setObsidianScanDebugOpen(true);
            setNewAgentError(
              "Vault scan timed out (30s). Check debug output; if iCloud permission prompts are pending, approve them and retry."
            );
            try {
              // best-effort: stop any running command
              relay.send({ type: "terminal_input", terminal_id: terminalId, data: "\u0003" }); // Ctrl+C
            } catch {
              // ignore
            }
            finish();
          }, 30_000);
          return;
        }

        if (msg.type === "terminal_data") {
          if (String(msg.terminal_id || "") !== terminalId) return;
          const chunk = String(msg.data || "");
          if (!chunk) return;
          buffer += chunk;
          // Always update debug buffer (tail)
          setObsidianScanRaw(buffer.slice(-20000));

          // Extract vault roots from any output that contains ".../.obsidian" (spaces/unicode ok).
          const clean = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "");
          const re = /(\/(?:Users|home)\/[^\n]*?\/\.obsidian)/g;
          let m: RegExpExecArray | null;
          let added = 0;
          while ((m = re.exec(clean)) !== null) {
            const full = m[1];
            const root = full.replace(/\/\.obsidian$/, "");
            if (!found.has(root)) {
              found.add(root);
              added++;
            }
          }
          if (added > 0) {
            setObsidianVaults(Array.from(found));
            if (found.size === 1) setSelectedObsidianVault(Array.from(found)[0]);
          }

          // Finish once output settles (no new matches for a short period).
          if (settleTimerId) window.clearTimeout(settleTimerId);
          settleTimerId = window.setTimeout(() => {
            finish();
          }, 900);
          return;
        }

        if (msg.type === "terminal_open_failed") {
          if (String(msg.request_id || "") !== requestId) return;
          if (scanTimeoutId) {
            window.clearTimeout(scanTimeoutId);
            scanTimeoutId = null;
          }
          setNewAgentError(`Failed to start local terminal: ${String(msg.error || "unknown error")}`);
          finish();
          return;
        }

        if (msg.type === "terminal_closed") {
          if (String(msg.terminal_id || "") !== terminalId) return;
          if (scanTimeoutId) {
            window.clearTimeout(scanTimeoutId);
            scanTimeoutId = null;
          }
          // If it closes early, finish with what we have.
          if (opened && found.size === 0) setNewAgentError("Vault scan ended early. Try again.");
          finish();
        }
      });

      // Subscribe and open - use any available workspace just to get shell access (scan runs from $HOME anyway)
      relay.send({
        type: "terminal_open",
        request_id: requestId,
        terminal_id: terminalId,
        device_id: newAgentDeviceId,
        workspace_id: workspaceForScan,
        start_claude: false,
        persist: false,
      });

      window.setTimeout(() => {
        if (!opened) {
          setNewAgentError("Timed out starting scan terminal. Check connector/relay.");
          cleanup();
          unsubscribe();
          setObsidianVaultsLoading(false);
        }
      }, 15000);
    };

    const handleCreateObsidianAgent = async () => {
      setNewAgentError(null);
      const name = (newAgentName.trim() || "Obsidian").trim();
      if (!name) {
        setNewAgentError("Agent name is required.");
        return;
      }
      if (!newAgentDeviceId) {
        setNewAgentError("Select a device first.");
        return;
      }
      if (!selectedObsidianVault) {
        setNewAgentError("Select an Obsidian vault.");
        return;
      }
      if (!supabaseConfigured || authed !== true) {
        setNewAgentError("Supabase must be configured to create Obsidian agents.");
        return;
      }

      setCreatingAgent(true);
      try {
        const supabase = getSupabaseBrowserClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) throw new Error("Not signed in");

        // 1) Create or reuse workspace for vault root
        const vaultRoot = selectedObsidianVault;
        const vaultLabel = vaultRoot.split("/").filter(Boolean).slice(-1)[0] || "Vault";

        let vaultWorkspaceId: string | null = null;
        const existingWs = workspaces.find((w) => w.device_id === newAgentDeviceId && w.root_path === vaultRoot);
        if (existingWs?.id) {
          vaultWorkspaceId = existingWs.id;
        } else {
          const { data: wsRow, error: wsErr } = await supabase
            .from("device_workspaces")
            .insert({
              user_id: user.id,
              device_id: newAgentDeviceId,
              label: `Obsidian • ${vaultLabel}`,
              root_path: vaultRoot,
            })
            .select("id,device_id,label,root_path")
            .single();
          if (wsErr || !wsRow) throw wsErr || new Error("Failed to create vault workspace");
          vaultWorkspaceId = String(wsRow.id);
          // Update local workspaces list so follow-up UI has it.
          setWorkspaces((prev) => [
            { id: String(wsRow.id), device_id: String(wsRow.device_id), label: String(wsRow.label), root_path: String(wsRow.root_path) },
            ...prev,
          ]);
        }

        if (!vaultWorkspaceId) throw new Error("Missing vault workspace");

        // 2) Create delegate Claude Code agent bound to vault workspace
        const { data: ccAgentRow, error: ccAgentErr } = await supabase
          .from("agents")
          .insert({
            user_id: user.id,
            type: "claude-code",
            name: `Obsidian • Claude`,
            flag_key: newAgentFlag || null,
            provider: null,
            model: null,
          })
          .select("id,type,name,flag_key")
          .single();
        if (ccAgentErr || !ccAgentRow) throw ccAgentErr || new Error("Failed to create Claude Code agent");

        const { error: ccCfgErr } = await supabase.from("claude_code_agent_configs").insert({
          agent_id: ccAgentRow.id,
          user_id: user.id,
          device_id: newAgentDeviceId,
          workspace_id: vaultWorkspaceId,
        });
        if (ccCfgErr) throw ccCfgErr;

        // 3) Create Obsidian agent (chat UI)
        const { data: obsAgentRow, error: obsAgentErr } = await supabase
          .from("agents")
          .insert({
            user_id: user.id,
            type: "obsidian",
            name,
            flag_key: newAgentFlag || null,
            provider: null,
            model: null,
          })
          .select("id,type,name,flag_key,updated_at")
          .single();
        if (obsAgentErr || !obsAgentRow) throw obsAgentErr || new Error("Failed to create Obsidian agent");

        const { error: obsCfgErr } = await supabase.from("obsidian_agent_configs").insert({
          agent_id: obsAgentRow.id,
          user_id: user.id,
          device_id: newAgentDeviceId,
          vault_workspace_id: vaultWorkspaceId,
          claude_code_agent_id: ccAgentRow.id,
          vault_label: vaultLabel,
        });
        if (obsCfgErr) throw obsCfgErr;

        // 4) Create initial session for Obsidian chat
        const sesRes = await fetch("/api/chat/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: obsAgentRow.id, title: "Obsidian chat" }),
        });
        const sesJson = await sesRes.json().catch(() => ({}));
        const sessionId = sesRes.ok ? String(sesJson?.session?.id || "") : "";

        const created: Agent = {
          id: String(obsAgentRow.id),
          name: String(obsAgentRow.name),
          type: "obsidian",
          status: "ready",
          task: "Vault connected",
          output: [],
          flag: (obsAgentRow as unknown as { flag_key?: string | null }).flag_key || undefined,
          updatedAt: (obsAgentRow as unknown as { updated_at?: string }).updated_at,
          lastSessionId: sessionId || undefined,
        };

        // Also add the delegate Claude Code agent to the local list so you can open it if you want.
        const delegate: Agent = {
          id: String(ccAgentRow.id),
          name: String(ccAgentRow.name),
          type: "claude-code",
          status: "ready",
          task: "Terminal ready",
          output: [],
          flag: (ccAgentRow as unknown as { flag_key?: string | null }).flag_key || undefined,
        };

        setAgents((prev) => [...prev, delegate, created]);
        setSelectedAgent(created);
        setShowNewAgentModal(false);
        setNewAgentName("");
        setNewAgentError(null);
        setObsidianVaults([]);
        setSelectedObsidianVault("");
      } catch (err) {
        setNewAgentError(getErrorMessage(err) || "Failed to create Obsidian agent");
      } finally {
        setCreatingAgent(false);
      }
    };

    const handleCreateDatagranAgent = async () => {
      setNewAgentError(null);
      const name = newAgentName.trim();
      if (!name) {
        setNewAgentError("Agent name is required.");
        return;
      }
      const datagranApiKey = newAgentDatagranApiKey.trim();
      if (!datagranApiKey) {
        setNewAgentError("Datagran API key is required.");
        return;
      }
      const anthropicApiKey = newAgentAnthropicApiKey.trim();
      if (!anthropicApiKey) {
        setNewAgentError("Anthropic API key is required for AI analysis.");
        return;
      }
      // For web_pixel, require a selected site
      if (newAgentDatagranProvider === "web_pixel" && !selectedPixelSiteId) {
        setNewAgentError("Please select a pixel site.");
        return;
      }
      if (!supabaseConfigured || authed !== true) {
        setNewAgentError("Supabase must be configured to create Integrations agents.");
        return;
      }

      setCreatingAgent(true);
      try {
        const res = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "datagran",
            name,
            flagKey: newAgentFlag || null,
            datagranProvider: newAgentDatagranProvider,
            datagranApiKey,
            anthropicApiKey,
            // For web_pixel, pass the selected site as connection_id
            ...(newAgentDatagranProvider === "web_pixel" && selectedPixelSiteId ? { connectionId: selectedPixelSiteId } : {}),
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || "Failed to create agent");

        const agentRow = json.agent;
        const created: Agent = {
          id: agentRow.id,
          name: agentRow.name,
          type: "datagran",
          // web_pixel is ready immediately, others need OAuth
          status: newAgentDatagranProvider === "web_pixel" ? "ready" : "awaiting-auth",
          task: newAgentDatagranProvider === "web_pixel" 
            ? `Tracking ${pixelSites.find(s => s.id === selectedPixelSiteId)?.name || "site"}`
            : `Connect to ${DATAGRAN_PROVIDER_LABELS[newAgentDatagranProvider]}`,
          output: [],
          flag: agentRow.flag_key || undefined,
        };

        setAgents((prev) => [...prev, created]);
        setSelectedAgent(created);
        setShowNewAgentModal(false);
        setNewAgentName("");
        setNewAgentDatagranApiKey("");
        setNewAgentAnthropicApiKey("");
        setSelectedPixelSiteId("");
        setPixelSites([]);
        setNewAgentError(null);
      } catch (err) {
        setNewAgentError(getErrorMessage(err) || "Failed to create agent");
      } finally {
        setCreatingAgent(false);
      }
    };

    const handleDeleteAgent = (agent: Agent) => {
      setAgentToDelete(agent);
    };

    const confirmDeleteAgent = async () => {
      if (!agentToDelete) return;
      const toDelete = agentToDelete;
      setAgentToDelete(null);

      let delegateClaudeAgentId: string | null = null;
      try {
        if (supabaseConfigured && authed === true && toDelete.type === "obsidian" && isUuid(toDelete.id)) {
          const supabase = getSupabaseBrowserClient();
          const { data } = await supabase
            .from("obsidian_agent_configs")
            .select("claude_code_agent_id")
            .eq("agent_id", toDelete.id)
            .single();
          if (data?.claude_code_agent_id) {
            delegateClaudeAgentId = String(data.claude_code_agent_id);
          }
        }
      } catch {
        // ignore (best-effort)
      }

      let prevAgents: Agent[] = [];
      setAgents((prev) => {
        prevAgents = prev;
        return prev.filter((a) => a.id !== toDelete.id && (!delegateClaudeAgentId || a.id !== delegateClaudeAgentId));
      });

      setSelectedAgent((prev) => {
        if (!prev) return prev;
        if (prev.id === toDelete.id) return null;
        if (delegateClaudeAgentId && prev.id === delegateClaudeAgentId) return null;
        return prev;
      });

      try {
        if (
          supabaseConfigured &&
          authed === true &&
          (toDelete.type === "ai-chat" ||
            toDelete.type === "claude-code" ||
            toDelete.type === "cursor" ||
            toDelete.type === "datagran" ||
            toDelete.type === "obsidian" ||
            toDelete.type === "files-agent") &&
          isUuid(toDelete.id)
        ) {
          setDeletingAgentId(toDelete.id);
          const supabase = getSupabaseBrowserClient();
          const { error } = await supabase.from("agents").delete().eq("id", toDelete.id);
          if (error) throw error;
          // If this was an Obsidian agent, also delete its delegate Claude Code agent.
          if (toDelete.type === "obsidian" && delegateClaudeAgentId && isUuid(delegateClaudeAgentId)) {
            await supabase.from("agents").delete().eq("id", delegateClaudeAgentId);
          }
        }
      } catch {
        // Roll back optimistic UI
        setAgents(prevAgents);
        const restored = prevAgents.find((a) => a.id === toDelete.id) || null;
        setSelectedAgent(restored);
        setAgentToDelete(restored); // Re-show modal with error? Or just alert
      } finally {
        setDeletingAgentId(null);
      }
    };

    const handleSetSelectedAgentFlag = async (flagKey: string) => {
      if (!selectedAgent) return;

      setAgents((prev) =>
        prev.map((a) => (a.id === selectedAgent.id ? { ...a, flag: flagKey } : a))
      );
      setSelectedAgent((prev) => (prev ? { ...prev, flag: flagKey } : prev));

      if (!supabaseConfigured || authed !== true) return;
      if (
        selectedAgent.type !== "ai-chat" &&
        selectedAgent.type !== "claude-code" &&
        selectedAgent.type !== "cursor" &&
        selectedAgent.type !== "datagran" &&
        selectedAgent.type !== "obsidian" &&
        selectedAgent.type !== "files-agent"
      )
        return;

      try {
        const supabase = getSupabaseBrowserClient();
        await supabase
          .from("agents")
          .update({ flag_key: flagKey, updated_at: new Date().toISOString() })
          .eq("id", selectedAgent.id);
      } catch {
        // ignore
      }
    };

    const handleRenameAgent = useCallback(async (agentId: string, newName: string) => {
      setAgents((prev) =>
        prev.map((a) => (a.id === agentId ? { ...a, name: newName } : a))
      );
      setSelectedAgent((prev) => (prev && prev.id === agentId ? { ...prev, name: newName } : prev));

      if (!supabaseConfigured || authed !== true) return;

      const agent = agents.find((a) => a.id === agentId);
      if (!agent) return;
      if (
        agent.type !== "ai-chat" &&
        agent.type !== "claude-code" &&
        agent.type !== "cursor" &&
        agent.type !== "datagran" &&
        agent.type !== "obsidian" &&
        agent.type !== "files-agent"
      )
        return;

      try {
        const supabase = getSupabaseBrowserClient();
        await supabase
          .from("agents")
          .update({ name: newName, updated_at: new Date().toISOString() })
          .eq("id", agentId);
      } catch {
        // ignore
      }
    }, [supabaseConfigured, authed, agents]);

    // Send a chat message from the collapsed card
    const handleSendChatMessage = useCallback(async (agentId: string, sessionId: string, message: string, agentType: Agent["type"] = "ai-chat") => {
      // Set status to running and update lastMessage
      setAgents((prev) =>
        prev.map((a) =>
          a.id === agentId 
            ? { ...a, status: "running" as const, lastMessage: { role: "user" as const, content: message } } 
            : a
        )
      );
      setSelectedAgent((prev) =>
        prev && prev.id === agentId
          ? {
              ...prev,
              status: "running" as const,
              lastMessage: { role: "user" as const, content: message },
            }
          : prev
      );

      try {
        // Send to appropriate API based on agent type
        const apiEndpoint = agentType === "datagran" 
          ? "/api/datagran/chat" 
          : agentType === "files-agent"
          ? "/api/files-agent"
          : "/api/chat";
        const res = await fetch(apiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId,
            sessionId,
            messages: [{ role: "user", content: message }],
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error || "Failed to send message");
        }

        // Stream the response
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
        }

        // Update agent with assistant response and set status back to awaiting-input
        const now = new Date().toISOString();
        setAgents((prev) =>
          prev.map((a) =>
            a.id === agentId 
              ? { 
                  ...a, 
                  status: "ready" as const,
                  updatedAt: now,
                  lastMessage: accumulated 
                    ? { role: "assistant" as const, content: accumulated } 
                    : a.lastMessage 
                } 
              : a
          )
        );
        setSelectedAgent((prev) =>
          prev && prev.id === agentId
            ? {
                ...prev,
                status: "ready" as const,
                updatedAt: now,
                lastMessage: accumulated
                  ? { role: "assistant" as const, content: accumulated }
                  : prev.lastMessage,
              }
            : prev
        );
      } catch (err) {
        // Set status to error on failure
        setAgents((prev) =>
          prev.map((a) =>
            a.id === agentId ? { ...a, status: "error" as const } : a
          )
        );
        setSelectedAgent((prev) =>
          prev && prev.id === agentId ? { ...prev, status: "error" as const } : prev
        );
        throw err;
      }
    }, []);
    
    // Handle voice commands
    const handleVoiceCommand = useCallback((command: VoiceCommand) => {
      switch (command.type) {
        case "open_agent":
          // Find agent by name (primary), then flag, then ID
          let agentToOpen: Agent | undefined;
          
          // First try to match by agent name (partial match, case insensitive)
          if (command.agentName) {
            agentToOpen = agents.find(a => 
              a.name.toLowerCase().includes(command.agentName!.toLowerCase())
            );
          }
          
          // Fallback to flag if no name match
          if (!agentToOpen && command.flag) {
            const flagKey = (Object.entries(flagColors) as [FlagColor, typeof flagColors[FlagColor]][])
              .find(([, v]) => v.label.toLowerCase() === command.flag?.toLowerCase())?.[0];
            if (flagKey) {
              agentToOpen = agents.find(a => a.flag === flagKey);
            }
          }
          
          // Last resort: ID
          if (!agentToOpen && command.agentId) {
            agentToOpen = agents.find(a => a.id === command.agentId);
          }

          if (agentToOpen) {
            setSelectedAgent(agentToOpen);
          }
          break;

        case "close_agent":
          setSelectedAgent(null);
          break;

        case "type_text":
          if (selectedAgent) {
            if (selectedAgent.type === "ai-chat") {
              const textarea = document.querySelector<HTMLTextAreaElement>(
                'textarea[data-flow-chat-input="true"]'
              );
              if (textarea) {
                const nativeSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype,
                  "value"
                )?.set;
                const next = (textarea.value ? textarea.value + " " : "") + (command.text || "");
                if (nativeSetter) {
                  nativeSetter.call(textarea, next);
                  textarea.dispatchEvent(new Event("input", { bubbles: true }));
                }
                textarea.focus();
              }
            } else {
              // Type into the detail panel input
              setDetailPanelInput((prev) => prev + (prev ? " " : "") + (command.text || ""));
              // Focus the input
              setTimeout(() => detailInputRef.current?.focus(), 100);
            }
          }
          break;

        case "send_message":
          if (selectedAgent) {
            if (selectedAgent.type === "ai-chat") {
              const textarea = document.querySelector<HTMLTextAreaElement>(
                'textarea[data-flow-chat-input="true"]'
              );
              const form = textarea?.form;
              if (form) {
                form.requestSubmit();
              } else {
                const sendBtn = document.querySelector<HTMLButtonElement>(
                  'button[data-flow-chat-send="true"]'
                );
                sendBtn?.click();
              }
            } else if (detailPanelInput.trim()) {
              console.log(`Sending to ${selectedAgent.id}:`, detailPanelInput);
              // TODO: Actually send the message to the agent
              setDetailPanelInput("");
            }
          }
          break;

        case "clear_input":
          if (selectedAgent?.type === "ai-chat") {
            const textarea = document.querySelector<HTMLTextAreaElement>(
              'textarea[data-flow-chat-input="true"]'
            );
            if (textarea) {
              const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype,
                "value"
              )?.set;
              if (nativeSetter) {
                nativeSetter.call(textarea, "");
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
              }
              textarea.focus();
            }
          } else {
            setDetailPanelInput("");
          }
          break;
      }
    }, [agents, detailPanelInput, flagColors, selectedAgent]);

    // Get unique flags from agents (sorted for consistent hydration)
    const activeFlags = [...new Set(agents.map(a => a.flag).filter(Boolean))].sort() as FlagColor[];
    
    // Dynamic categories based on flags with agent counts
    const flagCategories = useMemo(() => {
      const categories: Array<{ id: string; label: string; bg: string; count: number }> = [
        { id: "all", label: "All Agents", bg: "bg-cyan-500", count: agents.length },
      ];
      
      // Add each flag as a category with its agent count
      Object.entries(flagColors).forEach(([key, cfg]) => {
        const count = agents.filter(a => a.flag === key).length;
        categories.push({
          id: key,
          label: cfg.label,
          bg: cfg.bg,
          count,
        });
      });
      
      return categories;
    }, [agents, flagColors]);
    
    // Priority order: active first, then needs attention, then idle
    const statusPriority: Record<AgentStatus, number> = {
      "running": 0,         // Actively working - top priority
      "awaiting-input": 1,  // You need to respond
      "awaiting-auth": 2,   // Needs authorization
      "error": 3,           // Something broke
      "queued": 4,          // Waiting to start
      "ready": 5,           // Ready for input
      "paused": 6,          // Manually paused
      "complete": 7,        // Done
    };
    
    const filteredAgents = (selectedFlag 
      ? agents.filter(a => a.flag === selectedFlag)
      : agents
    ).sort((a, b) => {
      // Pin Obsidian to the top.
      if (a.type === "obsidian" && b.type !== "obsidian") return -1;
      if (b.type === "obsidian" && a.type !== "obsidian") return 1;

      const ap = statusPriority[a.status];
      const bp = statusPriority[b.status];
      if (ap !== bp) return ap - bp;

      // Within "ready", sort by most recent activity (updatedAt) first.
      if (a.status === "ready" && b.status === "ready") {
        const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
      }

      // Preserve existing ordering for ties in other statuses.
      return 0;
    });

    const statusCounts: Record<AgentStatus, number> = {
      running: filteredAgents.filter((a) => a.status === "running").length,
      complete: filteredAgents.filter((a) => a.status === "complete").length,
      ready: filteredAgents.filter((a) => a.status === "ready").length,
      "awaiting-input": filteredAgents.filter((a) => a.status === "awaiting-input").length,
      "awaiting-auth": filteredAgents.filter((a) => a.status === "awaiting-auth").length,
      error: filteredAgents.filter((a) => a.status === "error").length,
      queued: filteredAgents.filter((a) => a.status === "queued").length,
      paused: filteredAgents.filter((a) => a.status === "paused").length,
    };
    
    const needsAttention = statusCounts["awaiting-input"] + statusCounts["awaiting-auth"] + statusCounts.error;

  if (authed === null) {
  return (
      <div className="h-screen bg-grid flex items-center justify-center">
        <div className="glass rounded-2xl border border-white/10 px-6 py-4 text-sm text-zinc-300">
          Loading…
        </div>
      </div>
    );
  }

  if (authed === false) {
    return null;
  }

  return (
    <div className="h-screen flex flex-col bg-grid pb-16 md:pb-0">
      {/* Ambient Background Orbs - reduced on mobile for performance */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-48 md:w-96 h-48 md:h-96 bg-cyan-500/5 rounded-full blur-3xl animate-float" />
        <div
          className="absolute bottom-1/4 right-1/4 w-40 md:w-80 h-40 md:h-80 bg-purple-500/5 rounded-full blur-3xl animate-float hidden sm:block"
          style={{ animationDelay: "-5s" }}
        />
        <div
          className="absolute top-1/2 right-1/3 w-32 md:w-64 h-32 md:h-64 bg-emerald-500/5 rounded-full blur-3xl animate-float hidden md:block"
          style={{ animationDelay: "-10s" }}
        />
      </div>

      {/* Top Command Bar */}
      <header className="relative z-10 glass-dark border-b border-white/5 mobile-header">
        <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4">
          {/* Logo - smaller on mobile */}
          <div className="flex items-center gap-2 sm:gap-3">
            <Image
              src="/Groovy_no_bg.png"
              alt="Groovy"
              width={560}
              height={160}
              className="h-20 sm:h-28 md:h-40 -my-4 sm:-my-6 md:-my-8"
              style={{ width: "auto" }}
              unoptimized
              priority
            />
          </div>

          {/* Command Input - hidden on mobile, visible on tablet+ */}
          <div className="hidden md:flex flex-1 max-w-2xl mx-8">
            <div className="relative group w-full">
              <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/20 to-purple-500/20 rounded-xl blur-xl opacity-0 group-focus-within:opacity-100 transition-opacity" />
              <div className="relative flex items-center gap-3 px-4 py-2.5 glass rounded-xl border border-white/10 focus-within:border-cyan-500/50 transition-colors">
                <Search className="w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Ask about your agent interactions..."
                  value={commandInput}
                  onChange={(e) => setCommandInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      openMemoryModalWithQuestion(commandInput);
                      if (memoryConfigured && commandInput.trim()) {
                        runMemoryQuery(commandInput).catch(() => {});
                      }
                    }
                  }}
                  className="flex-1 bg-transparent text-sm text-white placeholder-zinc-500 outline-none"
                />
                <kbd className="px-2 py-1 text-[10px] font-mono text-zinc-500 bg-white/5 rounded border border-white/10">
                  ⌘K
                </kbd>
              </div>
            </div>
          </div>

          {/* Quick Actions - condensed on mobile */}
          <div className="flex items-center gap-2 sm:gap-3">
            <VoiceControl
              onCommand={handleVoiceCommand}
            />
            {/* New Agent - icon only on mobile */}
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setShowNewAgentModal(true)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium text-sm shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-shadow"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">New Agent</span>
            </motion.button>
            {/* Hidden on mobile - available in bottom nav */}
            <button className="hidden sm:flex p-2.5 rounded-lg glass hover:bg-white/5 transition-colors">
              <Activity className="w-4 h-4 text-zinc-400" />
            </button>
            <button className="hidden sm:flex p-2.5 rounded-lg glass hover:bg-white/5 transition-colors">
              <Settings className="w-4 h-4 text-zinc-400" />
            </button>
            <button 
              onClick={async () => {
                if (supabaseConfigured) {
                  const supabase = getSupabaseBrowserClient();
                  await supabase.auth.signOut();
                }
                router.push("/login");
              }}
              className="hidden sm:flex p-2.5 rounded-lg glass text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Status Bar - horizontally scrollable on mobile */}
        <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-6 py-2 border-t border-white/5 bg-black/20 overflow-x-auto scrollbar-hide">
          <StatusBadge status="running" count={statusCounts.running} />
          <StatusBadge status="awaiting-input" count={statusCounts["awaiting-input"]} />
          <StatusBadge status="awaiting-auth" count={statusCounts["awaiting-auth"]} />
          <StatusBadge status="error" count={statusCounts.error} />
          <StatusBadge status="queued" count={statusCounts.queued} />
          <StatusBadge status="complete" count={statusCounts.complete} />
          <div className="ml-auto flex items-center gap-2 text-xs whitespace-nowrap shrink-0">
            {needsAttention > 0 ? (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                <span className="text-amber-400">{needsAttention} need attention</span>
              </>
            ) : (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="text-zinc-500">All clear</span>
              </>
            )}
          </div>
        </div>
      </header>

{/* Main Content */}
        <div className="flex-1 flex overflow-hidden relative">
        {/* Sidebar - hidden on mobile */}
        <aside className="hidden lg:flex w-64 glass-dark border-r border-white/5 flex-col overflow-y-auto">
          <div className="p-4">
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
              Flags
            </h2>
            <nav className="space-y-1">
              {flagCategories.map((cat) => {
                const isActive = cat.id === "all" ? !selectedFlag : selectedFlag === cat.id;
                return (
                  <button
                    key={cat.id}
                    onClick={() => setSelectedFlag(cat.id === "all" ? null : cat.id)}
                    className={`
                      w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm
                      transition-all duration-200
                      ${
                        isActive
                          ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                          : "text-zinc-400 hover:text-white hover:bg-white/5"
                      }
                    `}
                  >
                    <div className={`w-3 h-3 rounded-full ${cat.bg}`} />
                    <span className="flex-1 text-left truncate">{cat.label}</span>
                    <span
                      className={`
                        text-xs font-mono px-1.5 py-0.5 rounded
                        ${isActive ? "bg-cyan-500/20 text-cyan-400" : "bg-white/5 text-zinc-500"}
                      `}
                    >
                      {cat.count}
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="mt-auto p-4 border-t border-white/5">
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
              Quick Spawn
            </h2>
            <div className="space-y-2">
              <button
                onClick={() => {
                  setNewAgentType("ai-chat");
                  setShowNewAgentModal(true);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-colors group"
              >
                <MessageSquare className="w-4 h-4" />
                <span className="flex-1 text-left">AI Chat</span>
                <ChevronRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              
              <button
                onClick={() => {
                  setNewAgentType("files");
                  setShowNewAgentModal(true);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-colors group"
              >
                <FileText className="w-4 h-4" />
                <span className="flex-1 text-left">Files Agent</span>
                <ChevronRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              
              <button
                onClick={() => {
                  setNewAgentType("coding");
                  setShowNewAgentModal(true);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-colors group"
              >
                <Terminal className="w-4 h-4" />
                <span className="flex-1 text-left">Claude Code</span>
                <ChevronRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              
              <button
                onClick={() => {
                  setNewAgentType("datagran");
                  setShowNewAgentModal(true);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-colors group"
              >
                <Database className="w-4 h-4" />
                <span className="flex-1 text-left">Integrations</span>
                <ChevronRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            </div>
          </div>

          {/* Context Panel */}
          <div className="p-4 border-t border-white/5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                Global Context
              </h2>
              <Brain className="w-3.5 h-3.5 text-purple-400" />
            </div>
            <div className="glass rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                <span className="text-zinc-400">Active session: 2h 34m</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <div className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                <span className="text-zinc-400">12 context items</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="text-zinc-400">Integrations synced</span>
              </div>
            </div>
          </div>

          {/* Need Help */}
          <div className="p-4 border-t border-white/5">
            <button
              onClick={() => setShowHelpModal(true)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:text-cyan-400 hover:bg-cyan-500/10 transition-colors group"
            >
              <HelpCircle className="w-4 h-4" />
              <span className="flex-1 text-left">Need help?</span>
            </button>
          </div>
        </aside>
        
        {/* Mobile Sidebar Overlay */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setMobileMenuOpen(false)}
                className="lg:hidden fixed inset-0 bg-black/60 z-40"
              />
              <motion.aside
                initial={{ x: "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: "-100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="lg:hidden fixed inset-y-0 left-0 w-72 max-w-[85vw] z-50 glass-dark border-r border-white/5 flex flex-col overflow-y-auto"
              >
                <div className="p-4 border-b border-white/5 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white">Menu</h2>
                  <button
                    onClick={() => setMobileMenuOpen(false)}
                    className="p-2 rounded-lg hover:bg-white/5 text-zinc-400"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                
                {/* Mobile Search */}
                <div className="p-4 border-b border-white/5">
                  <div className="flex items-center gap-3 px-4 py-3 glass rounded-xl border border-white/10">
                    <Search className="w-4 h-4 text-zinc-500" />
                    <input
                      type="text"
                      placeholder="Ask about your agent interactions..."
                      value={commandInput}
                      onChange={(e) => setCommandInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          setMobileMenuOpen(false);
                          openMemoryModalWithQuestion(commandInput);
                          if (memoryConfigured && commandInput.trim()) {
                            runMemoryQuery(commandInput).catch(() => {});
                          }
                        }
                      }}
                      className="flex-1 bg-transparent text-sm text-white placeholder-zinc-500 outline-none"
                    />
                  </div>
                </div>
                
                <div className="p-4 flex-1">
                  <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
                    Flags
                  </h2>
                  <nav className="space-y-1">
                    {flagCategories.map((cat) => {
                      const isActive = cat.id === "all" ? !selectedFlag : selectedFlag === cat.id;
                      return (
                        <button
                          key={cat.id}
                          onClick={() => {
                            setSelectedFlag(cat.id === "all" ? null : cat.id);
                            setMobileMenuOpen(false);
                          }}
                          className={`
                            w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm
                            transition-all duration-200
                            ${
                              isActive
                                ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                                : "text-zinc-400 hover:text-white hover:bg-white/5"
                            }
                          `}
                        >
                          <div className={`w-3 h-3 rounded-full ${cat.bg}`} />
                          <span className="flex-1 text-left truncate">{cat.label}</span>
                          <span
                            className={`
                              text-xs font-mono px-1.5 py-0.5 rounded
                              ${isActive ? "bg-cyan-500/20 text-cyan-400" : "bg-white/5 text-zinc-500"}
                            `}
                          >
                            {cat.count}
                          </span>
                        </button>
                      );
                    })}
                  </nav>
                </div>
                
                {/* Need Help */}
                <div className="p-4 border-t border-white/5">
                  <button
                    onClick={() => {
                      setMobileMenuOpen(false);
                      setShowHelpModal(true);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-zinc-400 hover:text-cyan-400 hover:bg-cyan-500/10 transition-colors"
                  >
                    <HelpCircle className="w-4 h-4" />
                    <span>Need help?</span>
                  </button>
                </div>
                
                {/* Sign Out */}
                <div className="p-4 border-t border-white/5">
                  <button
                    onClick={async () => {
                      setMobileMenuOpen(false);
                      if (supabaseConfigured) {
                        const supabase = getSupabaseBrowserClient();
                        await supabase.auth.signOut();
                      }
                      router.push("/login");
                    }}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Sign out</span>
                  </button>
                </div>
              </motion.aside>
            </>
          )}
        </AnimatePresence>

{/* Agent Grid */}
          <main
            className={`overflow-auto p-3 sm:p-4 md:p-6 smooth-scroll transition-all duration-300 ${
              selectedAgent 
                ? "hidden md:block md:w-2/5 lg:w-1/3 min-w-[280px]" 
                : "flex-1"
            }`}
          >
            {/* Header row - stacks on mobile */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
              <div className="flex items-center gap-3">
                {/* Mobile menu button */}
                <button
                  onClick={() => setMobileMenuOpen(true)}
                  className="lg:hidden p-2 -ml-2 rounded-lg hover:bg-white/5 text-zinc-400"
                >
                  <Grid3X3 className="w-5 h-5" />
                </button>
                <div>
                  <h2 className="text-lg sm:text-xl font-semibold text-white">
                    {selectedFlag ? flagColors[selectedFlag].label : "All Agents"}
                  </h2>
                  <p className="text-xs sm:text-sm text-zinc-500 mt-0.5">
                    {filteredAgents.length} agents • {statusCounts.running} running
                  </p>
                </div>
              </div>
              
              {/* Flag Filters - horizontally scrollable */}
              <div className="flex items-center gap-2 min-w-0 -mx-3 px-3 sm:mx-0 sm:px-0">
                <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/5 overflow-x-auto scrollbar-hide min-w-0">
                  <button
                    onClick={() => setSelectedFlag(null)}
                    className={`
                      px-2 py-1.5 sm:py-1 rounded-md flex items-center justify-center text-xs font-medium shrink-0
                      transition-all duration-200
                      ${!selectedFlag 
                        ? "bg-white/10 text-white" 
                        : "text-zinc-500 hover:text-white hover:bg-white/5"
                      }
                    `}
                  >
                    All
                  </button>
                  {activeFlags.map((flag) => (
                    <button
                      key={flag}
                      onClick={() => setSelectedFlag(selectedFlag === flag ? null : flag)}
                      title={flagColors[flag].label}
                      className={`
                        p-1.5 sm:p-1.5 rounded-md flex items-center gap-1 shrink-0
                        transition-all duration-200 text-xs whitespace-nowrap
                        ${selectedFlag === flag 
                          ? "bg-white/10 text-white ring-1 ring-white/20" 
                          : "text-zinc-400 hover:text-white hover:bg-white/5"
                        }
                      `}
                    >
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${flagColors[flag].bg}`} />
                    </button>
                  ))}
                </div>
                
                <div className="flex items-center shrink-0 gap-1">
                  <button 
                    onClick={() => setShowNewFlagModal(true)}
                    title="Add new flag"
                    className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-cyan-400 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  <button className="hidden sm:flex p-1.5 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-colors">
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

<LayoutGroup>
              {!selectedAgent && agentsLoading ? (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="glass rounded-xl border border-white/10 p-6 sm:p-10 flex items-center justify-center gap-3 text-zinc-400"
                >
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Loading your agents…</span>
                </motion.div>
              ) : !selectedAgent && agents.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="glass rounded-xl border border-white/10 p-6 sm:p-10 text-center"
                >
                  <div className="text-sm font-medium text-white">No agents yet</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    Create your first agent to get into your groove.
                  </div>
                  <button
                    onClick={() => setShowNewAgentModal(true)}
                    className="mt-6 inline-flex items-center gap-2 px-4 py-3 sm:py-2.5 rounded-xl bg-cyan-500 text-black font-medium hover:bg-cyan-400 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    New Agent
                  </button>
                </motion.div>
              ) : (
                <>
                  {/* Responsive grid: 1 col mobile, 2 col tablet, 3 col desktop */}
                  <div
                    className={`grid gap-3 sm:gap-4 transition-all duration-300 ease-out ${
                      selectedAgent 
                        ? "grid-cols-1" 
                        : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"
                    }`}
                  >
                <AnimatePresence mode="popLayout">
                  {(selectedAgent 
                        ? filteredAgents.filter((a) => a.id !== selectedAgent.id).slice(0, 2)
                    : filteredAgents
                  ).map((agent) => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      onClick={() => setSelectedAgent(agent)}
                          onDelete={() => {
                            if (deletingAgentId) return;
                            handleDeleteAgent(agent);
                          }}
                      flagColors={flagColors}
                      onSendChatMessage={handleSendChatMessage}
                      onUpdateAgent={(updates) => {
                        setAgents((prev) =>
                          prev.map((a) => (a.id === agent.id ? { ...a, ...updates } : a))
                        );
                      }}
                      onRename={(newName) => handleRenameAgent(agent.id, newName)}
                    />
                  ))}
                </AnimatePresence>
              </div>
                  {!selectedAgent && filteredAgents.length === 0 && agents.length > 0 && (
                    <div className="glass rounded-xl border border-white/10 p-6 sm:p-8 text-center mt-4">
                      <div className="text-sm font-medium text-white">No agents match this filter</div>
                      <div className="mt-1 text-xs text-zinc-500">
                        Clear the filter or create a new agent.
                      </div>
                      <div className="mt-4 flex flex-col sm:flex-row items-center justify-center gap-3">
                        <button
                          onClick={() => setSelectedFlag(null)}
                          className="w-full sm:w-auto px-4 py-3 sm:py-2 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors text-sm"
                        >
                          Clear filter
                        </button>
                        <button
                          onClick={() => setShowNewAgentModal(true)}
                          className="w-full sm:w-auto px-4 py-3 sm:py-2 rounded-xl bg-cyan-500 text-black font-medium hover:bg-cyan-400 transition-colors text-sm"
                        >
                          New Agent
                        </button>
                      </div>
                    </div>
                  )}
          {/* Add Agent Card */}
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            <button
              onClick={() => setShowNewAgentModal(true)}
              className="w-full p-6 sm:p-8 rounded-xl border-2 border-dashed border-zinc-800 hover:border-cyan-500/30 hover:bg-cyan-500/5 transition-all group"
            >
              <div className="flex flex-col items-center gap-3 text-zinc-500 group-hover:text-cyan-400 transition-colors">
                <Plus className="w-6 sm:w-8 h-6 sm:h-8" />
                <span className="text-sm font-medium">Add New Agent</span>
        </div>
            </button>
          </motion.div>
                </>
              )}
            </LayoutGroup>
        </main>

        {/* Right Panel - Agent Detail (when selected) - full screen on mobile */}
        <AnimatePresence mode="popLayout">
          {selectedAgent && (
            <motion.aside
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ 
                type: "spring", 
                damping: 25, 
                stiffness: 200,
                opacity: { duration: 0.2 }
              }}
              className="max-md:fixed max-md:inset-0 max-md:z-30 md:relative md:flex-1 min-w-0 glass-dark md:border-l border-white/5"
            >
              <div className="p-4 sm:p-6 h-full flex flex-col overflow-auto pb-20 md:pb-6">
                {/* Mobile sticky header */}
                <div className="flex items-center justify-between mb-4 sm:mb-6 sticky top-0 -mt-4 sm:-mt-6 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 sm:py-4 bg-[var(--bg-secondary)]/95 backdrop-blur-sm z-10 md:static md:bg-transparent md:backdrop-blur-none">
                  <div className="flex items-center gap-2 sm:gap-3">
                    <div className="p-2 sm:p-2.5 rounded-xl bg-white/5">
                      <AgentIcon type={selectedAgent.type} />
                    </div>
                    <div className="min-w-0 flex-1">
                      {isEditingPanelName ? (
                        <input
                          ref={panelNameInputRef}
                          type="text"
                          value={editedPanelName}
                          onChange={(e) => setEditedPanelName(e.target.value)}
                          onBlur={async () => {
                            const trimmed = editedPanelName.trim();
                            if (trimmed && trimmed !== selectedAgent.name) {
                              await handleRenameAgent(selectedAgent.id, trimmed);
                            }
                            setIsEditingPanelName(false);
                          }}
                          onKeyDown={async (e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              const trimmed = editedPanelName.trim();
                              if (trimmed && trimmed !== selectedAgent.name) {
                                await handleRenameAgent(selectedAgent.id, trimmed);
                              }
                              setIsEditingPanelName(false);
                            } else if (e.key === "Escape") {
                              setEditedPanelName(selectedAgent.name);
                              setIsEditingPanelName(false);
                            }
                          }}
                          className="font-semibold text-white text-sm sm:text-base bg-white/10 border border-white/20 rounded px-2 py-0.5 outline-none focus:border-cyan-500/50 w-full max-w-[200px]"
                          autoFocus
                        />
                      ) : (
                        <div className="flex items-center gap-1.5 group">
                          <h3 className="font-semibold text-white text-sm sm:text-base truncate">
                            {selectedAgent.name}
                          </h3>
                          {/* Inline flag indicator with dropdown */}
                          <div className="relative group/flag">
                            <button
                              className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
                              title="Change flag"
                            >
                              <div className={`w-2 h-2 rounded-full ${selectedAgent.flag && flagColors[selectedAgent.flag] ? flagColors[selectedAgent.flag].bg : "bg-zinc-600"}`} />
                              <span className="text-[10px] text-zinc-500">
                                {selectedAgent.flag && flagColors[selectedAgent.flag] ? flagColors[selectedAgent.flag].label : "—"}
                              </span>
                            </button>
                            <div className="absolute left-0 top-full mt-1 py-1 min-w-[120px] rounded-lg bg-zinc-900 border border-white/10 shadow-xl opacity-0 invisible group-hover/flag:opacity-100 group-hover/flag:visible transition-all z-20">
                              {(Object.keys(flagColors) as FlagColor[]).map((flag) => (
                                <button
                                  key={flag}
                                  onClick={() => handleSetSelectedAgentFlag(flag)}
                                  className={`w-full px-2.5 py-1 flex items-center gap-2 text-[11px] hover:bg-white/5 transition-colors ${
                                    selectedAgent.flag === flag ? "text-white" : "text-zinc-400"
                                  }`}
                                >
                                  <div className={`w-2 h-2 rounded-full ${flagColors[flag].bg}`} />
                                  <span>{flagColors[flag].label}</span>
                                </button>
                              ))}
                              <div className="border-t border-white/5 mt-1 pt-1">
                                <button
                                  onClick={() => setShowNewFlagModal(true)}
                                  className="w-full px-2.5 py-1 flex items-center gap-2 text-[11px] text-zinc-500 hover:text-cyan-400 hover:bg-white/5 transition-colors"
                                >
                                  <Plus className="w-2.5 h-2.5" />
                                  <span>New</span>
                                </button>
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setEditedPanelName(selectedAgent.name);
                              setIsEditingPanelName(true);
                              setTimeout(() => panelNameInputRef.current?.select(), 0);
                            }}
                            className="p-1 rounded hover:bg-white/10 text-zinc-500 hover:text-white transition-colors opacity-0 group-hover:opacity-100"
                            title="Edit name"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <StatusIndicator status={selectedAgent.status} />
                        <span className="text-xs text-zinc-500 capitalize">
                          {selectedAgent.status}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={deletingAgentId === selectedAgent.id}
                      onClick={() => {
                        if (deletingAgentId) return;
                        handleDeleteAgent(selectedAgent);
                      }}
                      className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title="Delete agent"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setSelectedAgent(null)}
                      className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-colors"
                      title="Close"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Compact metadata bar - only if there's something to show */}
                {(selectedAgent.model || (selectedAgent.type !== "ai-chat" &&
                    selectedAgent.type !== "claude-code" &&
                    selectedAgent.type !== "cursor" &&
                    selectedAgent.type !== "datagran" &&
                    selectedAgent.type !== "obsidian" &&
                    selectedAgent.type !== "files-agent" &&
                    selectedAgent.task)) && (
                  <div className="flex items-center gap-3 mb-3 text-xs text-zinc-500">
                    {selectedAgent.model && (
                      <ModelBadge provider={selectedAgent.model.provider} name={selectedAgent.model.name} />
                    )}
                    {selectedAgent.type !== "ai-chat" &&
                      selectedAgent.type !== "claude-code" &&
                      selectedAgent.type !== "cursor" &&
                      selectedAgent.type !== "datagran" &&
                      selectedAgent.type !== "obsidian" &&
                      selectedAgent.type !== "files-agent" &&
                      selectedAgent.task && (
                      <span className="truncate" title={selectedAgent.task}>{selectedAgent.task}</span>
                    )}
                  </div>
                )}

                <div
                  className={`${
                    selectedAgent.type === "ai-chat" ||
                    selectedAgent.type === "claude-code" ||
                    selectedAgent.type === "cursor" ||
                    selectedAgent.type === "datagran" ||
                    selectedAgent.type === "obsidian" ||
                    selectedAgent.type === "files-agent"
                      ? ""
                      : "flex-1 overflow-auto space-y-4"
                  }`}
                >
                  {selectedAgent.type !== "ai-chat" &&
                    selectedAgent.type !== "claude-code" &&
                    selectedAgent.type !== "cursor" &&
                    selectedAgent.type !== "datagran" &&
                    selectedAgent.type !== "obsidian" &&
                    selectedAgent.type !== "files-agent" && (
                    <>
                      {selectedAgent.progress !== undefined && (
                        <div>
                          <div className="flex items-center gap-3">
                            <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-gradient-to-r from-cyan-500 to-cyan-400 rounded-full"
                                style={{ width: `${selectedAgent.progress}%` }}
                              />
                            </div>
                            <span className="text-sm font-mono text-cyan-400">
                              {selectedAgent.progress}%
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Output terminal */}
                      <div className="bg-black/40 rounded-lg p-3 font-mono text-xs space-y-1 max-h-48 overflow-auto">
                        {selectedAgent.output?.length ? selectedAgent.output.map((line, i) => (
                          <div key={i} className="text-zinc-400 truncate">{line}</div>
                        )) : (
                          <div className="text-zinc-600 italic">Waiting for output…</div>
                        )}
                        {selectedAgent.status === "running" && (
                          <div className="text-cyan-400 animate-pulse">▋</div>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {selectedAgent.type === "ai-chat" ? (
                  <div className="pt-4 border-t border-white/5 flex-1 min-h-0">
                    <ChatPanel
                      agentId={selectedAgent.id}
                      agentName={selectedAgent.name}
                      provider={selectedAgent.model?.provider || null}
                      model={selectedAgent.model?.name || null}
                      onUpdate={(data) => {
                        const now = data.lastMessage ? new Date().toISOString() : undefined;
                        setAgents((prev) =>
                          prev.map((a) =>
                            a.id === selectedAgent.id
                              ? {
                                  ...a,
                                  lastSessionId: data.lastSessionId,
                                  lastMessage: data.lastMessage ?? a.lastMessage,
                                  status: data.status ?? a.status,
                                  updatedAt: now ?? a.updatedAt,
                                }
                              : a
                          )
                        );
                        setSelectedAgent((prev) =>
                          prev && prev.id === selectedAgent.id
                            ? {
                                ...prev,
                                lastSessionId: data.lastSessionId,
                                lastMessage: data.lastMessage ?? prev.lastMessage,
                                status: data.status ?? prev.status,
                                updatedAt: now ?? prev.updatedAt,
                              }
                            : prev
                        );
                      }}
                    />
                  </div>
                ) : selectedAgent.type === "datagran" ? (
                  <div className="pt-4 border-t border-white/5 flex-1 min-h-0">
                    <DatagranPanel
                      agentId={selectedAgent.id}
                      agentName={selectedAgent.name}
                      onUpdate={(data) => {
                        const now = data.lastMessage ? new Date().toISOString() : undefined;
                        setAgents((prev) =>
                          prev.map((a) =>
                            a.id === selectedAgent.id
                              ? {
                                  ...a,
                                  lastSessionId: data.lastSessionId,
                                  lastMessage: data.lastMessage ?? a.lastMessage,
                                  status: data.status ?? a.status,
                                  updatedAt: now ?? a.updatedAt,
                                }
                              : a
                          )
                        );
                        setSelectedAgent((prev) =>
                          prev && prev.id === selectedAgent.id
                            ? {
                                ...prev,
                                lastSessionId: data.lastSessionId,
                                lastMessage: data.lastMessage ?? prev.lastMessage,
                                status: data.status ?? prev.status,
                                updatedAt: now ?? prev.updatedAt,
                              }
                            : prev
                        );
                      }}
                    />
                  </div>
                ) : selectedAgent.type === "claude-code" ? (
                  <div className="pt-4 border-t border-white/5 flex-1 min-h-0">
                    <ClaudeCliChatPanel
                      agentId={selectedAgent.id}
                      agentName={selectedAgent.name}
                    />
                  </div>
                ) : selectedAgent.type === "obsidian" ? (
                  <div className="pt-4 border-t border-white/5 flex-1 min-h-0">
                    <ObsidianPanel
                      agentId={selectedAgent.id}
                      agentName={selectedAgent.name}
                      onUpdate={(data) => {
                        const now = data.lastMessage ? new Date().toISOString() : undefined;
                        setAgents((prev) =>
                          prev.map((a) =>
                            a.id === selectedAgent.id
                              ? {
                                  ...a,
                                  lastSessionId: data.lastSessionId,
                                  lastMessage: data.lastMessage ?? a.lastMessage,
                                  status: data.status ?? a.status,
                                  updatedAt: now ?? a.updatedAt,
                                }
                              : a
                          )
                        );
                        setSelectedAgent((prev) =>
                          prev && prev.id === selectedAgent.id
                            ? {
                                ...prev,
                                lastSessionId: data.lastSessionId,
                                lastMessage: data.lastMessage ?? prev.lastMessage,
                                status: data.status ?? prev.status,
                                updatedAt: now ?? prev.updatedAt,
                              }
                            : prev
                        );
                      }}
                    />
                  </div>
                ) : selectedAgent.type === "cursor" ? (
                  <div className="pt-4 border-t border-white/5 flex-1 min-h-0">
                    <CursorAgentPanel
                      agentId={selectedAgent.id}
                      onUpdate={(data) => {
                        setAgents((prev) =>
                          prev.map((a) =>
                            a.id === selectedAgent.id
                              ? {
                                  ...a,
                                  status: data.status ?? a.status,
                                  output: data.output ?? a.output,
                                  cursorAgentId: data.cursorAgentId ?? a.cursorAgentId,
                                  lastMessage: data.lastMessage ?? a.lastMessage,
                                  sendCursorFollowUp: data.sendFollowUp ?? a.sendCursorFollowUp,
                                }
                              : a
                          )
                        );
                        setSelectedAgent((prev) =>
                          prev && prev.id === selectedAgent.id
                            ? {
                                ...prev,
                                status: data.status ?? prev.status,
                                output: data.output ?? prev.output,
                                cursorAgentId: data.cursorAgentId ?? prev.cursorAgentId,
                                lastMessage: data.lastMessage ?? prev.lastMessage,
                                sendCursorFollowUp: data.sendFollowUp ?? prev.sendCursorFollowUp,
                              }
                            : prev
                        );
                        // Store cursor state in localStorage for restoration after refresh
                        try {
                          const toStore: { cursorAgentId?: string; lastMessage?: { role: string; content: string } } = {};
                          if (data.cursorAgentId) toStore.cursorAgentId = data.cursorAgentId;
                          if (data.lastMessage) toStore.lastMessage = data.lastMessage;
                          if (Object.keys(toStore).length > 0) {
                            window.localStorage.setItem(
                              `groovy:cursor:state:${selectedAgent.id}`,
                              JSON.stringify(toStore)
                            );
                          }
                        } catch {
                          // ignore
                        }
                      }}
                    />
                  </div>
                ) : selectedAgent.type === "files-agent" ? (
                  <div className="pt-4 border-t border-white/5 flex-1 min-h-0">
                    <FilesAgentPanel
                      agentId={selectedAgent.id}
                      agentName={selectedAgent.name}
                      onUpdate={(data) => {
                        const now = data.lastMessage ? new Date().toISOString() : undefined;
                        setAgents((prev) =>
                          prev.map((a) =>
                            a.id === selectedAgent.id
                              ? {
                                  ...a,
                                  lastSessionId: data.lastSessionId,
                                  lastMessage: data.lastMessage ?? a.lastMessage,
                                  status: data.status ?? a.status,
                                  updatedAt: now ?? a.updatedAt,
                                }
                              : a
                          )
                        );
                        setSelectedAgent((prev) =>
                          prev && prev.id === selectedAgent.id
                            ? {
                                ...prev,
                                lastSessionId: data.lastSessionId,
                                lastMessage: data.lastMessage ?? prev.lastMessage,
                                status: data.status ?? prev.status,
                                updatedAt: now ?? prev.updatedAt,
                              }
                            : prev
                        );
                      }}
                    />
                  </div>
                ) : (
                  <>
                    {/* Message Input - Always visible when agent is selected */}
                    <div className="pt-4 border-t border-white/5">
                      <form 
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (detailPanelInput.trim()) {
                            console.log(`Sending to ${selectedAgent.id}:`, detailPanelInput);
                            setDetailPanelInput("");
                          }
                        }}
                        className="flex flex-col gap-3"
                      >
                        <div className="relative">
                          <textarea
                            ref={detailInputRef}
                            value={detailPanelInput}
                            onChange={(e) => setDetailPanelInput(e.target.value)}
                            placeholder="Type a message to this agent..."
                            rows={3}
                            className="w-full bg-black/30 rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-500 outline-none border border-white/10 focus:border-cyan-500/50 transition-colors resize-none"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                if (detailPanelInput.trim()) {
                                  console.log(`Sending to ${selectedAgent.id}:`, detailPanelInput);
                                  setDetailPanelInput("");
                                }
                              }
                            }}
                          />
                          <div className="absolute bottom-2 right-2 text-xs text-zinc-600">
                            Enter to send
                          </div>
                        </div>
                        <button
                          type="submit"
                          disabled={!detailPanelInput.trim()}
                          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                        >
                          <Send className="w-4 h-4" />
                          Send Message
                        </button>
                      </form>
                    </div>
                  </>
                )}

                {selectedAgent.type !== "ai-chat" &&
                  selectedAgent.type !== "claude-code" &&
                  selectedAgent.type !== "cursor" &&
                  selectedAgent.type !== "files-agent" && (
                  <>
                    {/* Action Buttons */}
                    <div className="pt-4 border-t border-white/5 flex gap-2">
                  {selectedAgent.status === "running" && (
                    <>
                      <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors">
                        <Pause className="w-4 h-4" />
                        Pause
                      </button>
                      <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors">
                        Stop
                      </button>
                    </>
                  )}
                  {selectedAgent.status === "awaiting-auth" && selectedAgent.type !== "datagran" && (
                    <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 transition-colors">
                      <ExternalLink className="w-4 h-4" />
                      Authorize
                    </button>
                  )}
                  {selectedAgent.status === "error" && (
                    <>
                      <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-colors">
                        <RotateCcw className="w-4 h-4" />
                        Retry
                      </button>
                      <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors">
                        Dismiss
                      </button>
                    </>
                  )}
                  {selectedAgent.status === "queued" && (
                    <>
                      <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-colors">
                        <Play className="w-4 h-4" />
                        Start Now
                      </button>
                      <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors">
                        Cancel
                      </button>
                    </>
                  )}
                  {selectedAgent.status === "paused" && (
                    <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-colors">
                      <Play className="w-4 h-4" />
                      Resume
                    </button>
                  )}
                  {selectedAgent.status === "complete" && (
                    <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-colors">
                      <RotateCcw className="w-4 h-4" />
                      Run Again
                    </button>
                  )}
                    </div>
                  </>
                )}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
        </div>

      {/* Memory Modal */}
      <AnimatePresence>
        {showMemoryModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm sm:p-4"
            onClick={() => {
              setShowMemoryModal(false);
              setMemoryError(null);
            }}
          >
            <motion.div
              initial={{ y: "100%", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "100%", opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full sm:max-w-2xl p-4 sm:p-6 rounded-t-3xl sm:rounded-2xl glass border border-white/10 max-h-[90vh] sm:max-h-[85vh] overflow-y-auto"
            >
              <div className="flex items-start justify-between gap-3 mb-4">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-white">Memory</h2>
                  <div className="text-xs text-zinc-500">
                    Query your Datagran brain built from Groovy traces.
                  </div>
                </div>
                <button
                  onClick={() => setShowMemoryModal(false)}
                  className="p-2 rounded-lg hover:bg-white/5 text-zinc-400"
                  title="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {memoryConfigured !== true ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4">
                    <div className="text-sm text-zinc-300 leading-relaxed">
                      Groovy uses{" "}
                      <a
                        href="https://www.datagran.io"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
                      >
                        Datagran
                      </a>
                      {" "}to power your memory. Every question you ask to any agent creates a trace that gets stored in your personal Datagran brain — so you can search and recall anything later.
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-zinc-500 mb-1">Datagran API key</div>
                    <input
                      type="password"
                      value={memoryApiKey}
                      onChange={(e) => setMemoryApiKey(e.target.value)}
                      placeholder="dg_..."
                      className="w-full bg-black/30 rounded-xl px-4 py-3 text-white placeholder-zinc-500 outline-none border border-white/10 focus:border-cyan-500/50 transition-colors text-sm"
                    />
                    <div className="text-xs text-zinc-500 mt-2">
                      Get your API key from{" "}
                      <a
                        href="https://www.datagran.io/settings/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                      >
                        datagran.io/settings/api-keys
                      </a>
                      . Your key is stored encrypted.
                    </div>
                  </div>

                  <button
                    onClick={() => saveMemoryConfig().catch(() => {})}
                    disabled={memorySaving}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {memorySaving ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Saving…
                      </>
                    ) : (
                      "Save"
                    )}
                  </button>

                  {memoryError && (
                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
                      {memoryError}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <div className="text-xs text-zinc-500 mb-1">Question</div>
                      <input
                        type="text"
                        value={memoryQuestion}
                        onChange={(e) => setMemoryQuestion(e.target.value)}
                        placeholder="What did I ask about X last week?"
                        className="w-full bg-black/30 rounded-xl px-4 py-3 text-white placeholder-zinc-500 outline-none border border-white/10 focus:border-cyan-500/50 transition-colors text-sm"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            runMemoryQuery().catch(() => {});
                          }
                        }}
                      />
                    </div>
                    <button
                      onClick={() => runMemoryQuery().catch(() => {})}
                      disabled={memoryLoading || !memoryQuestion.trim()}
                      className="px-4 py-3 rounded-xl bg-white/10 text-white text-sm font-medium hover:bg-white/15 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {memoryLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        "Ask"
                      )}
                    </button>
                  </div>

                  {memoryError && (
                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
                      {memoryError}
                    </div>
                  )}

                  {memoryResult && (
                    <div className="space-y-3">
                      {/* AI-synthesized answer */}
                      <div className="rounded-2xl bg-black/30 border border-white/10 p-4">
                        <div className="text-sm text-zinc-200 whitespace-pre-wrap">
                          {String(memoryResult?.answer || "No answer available")}
                        </div>
                      </div>

                      {/* Show mode from raw_data if available */}
                      {memoryResult?.raw_data?.mode && (
                        <div className="text-xs text-zinc-500">
                          Memory mode:{" "}
                          <span className="text-zinc-400">
                            {String(memoryResult.raw_data.mode)}
                          </span>
                        </div>
                      )}

                      {Array.isArray(memoryResult?.raw_data?.evidence) &&
                        (memoryResult?.raw_data?.evidence?.length || 0) > 0 && (
                          <div className="rounded-2xl bg-black/30 border border-white/10 p-4">
                            <div className="text-xs text-zinc-500 mb-2">Evidence</div>
                            <div className="space-y-2">
                              {(memoryResult.raw_data.evidence || []).slice(0, 6).map((ev, idx) => (
                                <div
                                  key={idx}
                                  className="text-xs text-zinc-300 whitespace-pre-wrap border-l border-white/10 pl-3"
                                >
                                  {String(ev?.snippet || "")}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* New Agent Modal - full screen on mobile */}
      <AnimatePresence>
        {showNewAgentModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm sm:p-4"
            onClick={() => {
              setShowNewAgentModal(false);
              setNewAgentError(null);
              setPairingCode(null);
              setPairingExpiresAt(null);
              setWorkspacePickLoading(false);
            }}
          >
            <motion.div
              initial={{ y: "100%", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "100%", opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full sm:max-w-md p-4 sm:p-6 rounded-t-3xl sm:rounded-2xl glass border border-white/10 max-h-[90vh] sm:max-h-[85vh] overflow-y-auto"
            >
              <h2 className="text-lg font-semibold text-white mb-4">
                {newAgentType === "coding"
                  ? newAgentCodingType === "cursor"
                    ? "Create Cursor Agent"
                    : "Create Claude Code Agent"
                  : newAgentType === "datagran"
                  ? "Create Integrations Agent"
                  : newAgentType === "files"
                  ? "Create Files Agent"
                  : "Create AI Chat Agent"}
              </h2>

              <div className="space-y-4">
                <div className="flex gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => {
                      setNewAgentType("ai-chat");
                      setNewAgentError(null);
                    }}
                    className={`flex-1 min-w-[80px] px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                      newAgentType === "ai-chat"
                        ? "bg-white/10 text-white"
                        : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    AI Chat
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNewAgentType("files");
                      setNewAgentError(null);
                    }}
                    className={`flex-1 min-w-[80px] px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                      newAgentType === "files"
                        ? "bg-orange-500/20 text-orange-300 ring-1 ring-orange-500/30"
                        : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    Files
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNewAgentType("coding");
                      setNewAgentError(null);
                    }}
                    className={`flex-1 min-w-[80px] px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                      newAgentType === "coding"
                        ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30"
                        : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    Coding
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNewAgentType("datagran");
                      setNewAgentError(null);
                    }}
                    className={`flex-1 min-w-[80px] px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                      newAgentType === "datagran"
                        ? "bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/30"
                        : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    Integrations
                  </button>
                </div>

                {/* Coding Agents Sub-Selection */}
                {newAgentType === "coding" && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setNewAgentCodingType("claude-code");
                        setNewAgentError(null);
                      }}
                      className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                        newAgentCodingType === "claude-code"
                          ? "bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/30"
                          : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      <Terminal className="w-4 h-4" />
                      Claude Code
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNewAgentCodingType("cursor");
                        setNewAgentError(null);
                      }}
                      className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                        newAgentCodingType === "cursor"
                          ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30"
                          : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      <Code className="w-4 h-4" />
                      Cursor
                    </button>
                  </div>
                )}

                <div>
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                    Name
                  </label>
                  <input
                    type="text"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    placeholder="e.g., Growth Chat, Legal Bot, Research…"
                    className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-cyan-500/50 transition-colors"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newAgentName.trim()) {
                        if (newAgentType === "ai-chat") {
                        handleCreateAiChatAgent();
                        } else {
                          handleCreateClaudeCodeAgent();
                        }
                      }
                    }}
                  />
                </div>

                {newAgentType === "ai-chat" && (
                <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                      Provider
                    </label>
                    <CustomSelect
                      value={newAgentProvider}
                      onChange={(val) => {
                        const provider = val as ModelProvider;
                        setNewAgentProvider(provider);
                        setNewAgentModel(modelProviders[provider].models[0]);
                        if (provider !== "openai" && provider !== "anthropic") {
                          setNewAgentKeySource("user");
                          setNewAgentReasoningEffort("medium");
                        } else if (provider !== "openai") {
                          setNewAgentKeySource("user");
                        }
                      }}
                      options={(Object.keys(modelProviders) as ModelProvider[]).map((p) => ({
                        value: p,
                        label: modelProviders[p].name,
                      }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                      Model
                    </label>
                    <CustomSelect
                      value={newAgentModel}
                      onChange={(val) => setNewAgentModel(val)}
                      options={modelProviders[newAgentProvider].models.map((m) => ({
                        value: m,
                        label: m,
                      }))}
                    />
                  </div>
                </div>

                {(newAgentProvider === "openai" || newAgentProvider === "anthropic") && (
                  <div>
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                      Extended Thinking
                    </label>
                    <CustomSelect
                      value={newAgentReasoningEffort}
                      onChange={(val) => setNewAgentReasoningEffort(val)}
                      options={[
                        { value: "none", label: "None (fastest)" },
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Medium (default)" },
                        { value: "high", label: "High" },
                      ]}
                    />
                    <div className="mt-1.5 text-[11px] text-zinc-500">
                      Higher values = deeper reasoning but slower responses
                    </div>
                  </div>
                )}

                {newAgentProvider !== "openai" && (
                  <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3">
                    <div className="text-xs text-amber-300">
                      <span className="font-semibold">Note:</span> File uploads (RAG) are currently only supported for OpenAI models.
                    </div>
                  </div>
                )}

                <div>
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                    System Prompt <span className="text-zinc-600">(optional)</span>
                  </label>
                  <textarea
                    value={newAgentSystemPrompt}
                    onChange={(e) => setNewAgentSystemPrompt(e.target.value)}
                    placeholder="Custom instructions for this agent... (leave empty for default)"
                    rows={3}
                    className="w-full bg-black/30 rounded-xl px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none border border-white/10 focus:border-cyan-500/50 transition-colors resize-none"
                  />
                  <div className="mt-1.5 text-[11px] text-zinc-500">
                    Personalize how this agent behaves. RAG context will be appended automatically.
                  </div>
                </div>
                
                <div className="rounded-xl bg-black/20 border border-white/10 p-3">
                  <div className="text-xs font-semibold text-zinc-300">API Key</div>
                  <div className="mt-1 text-[11px] text-zinc-400">
                    - We store your key <span className="text-zinc-200">encrypted</span> (AES-256-GCM) and decrypt it{" "}
                    <span className="text-zinc-200">server-side</span> only when sending requests.
                    <br />
                    - We also store a <span className="text-zinc-200">SHA-256 fingerprint</span> (one-way) for “configured” checks.
                  </div>

                  {newAgentProvider === "openai" && (
                    <div className="mt-3 flex flex-col gap-2">
                      <label className="flex items-center gap-2 text-sm text-zinc-300">
                        <input
                          type="radio"
                          name="openai-key-source"
                          checked={newAgentKeySource === "groovy"}
                          onChange={() => setNewAgentKeySource("groovy")}
                        />
                        Use <span className="text-zinc-200">Groovy test key</span> (OpenAI only)
                      </label>
                      <label className="flex items-center gap-2 text-sm text-zinc-300">
                        <input
                          type="radio"
                          name="openai-key-source"
                          checked={newAgentKeySource === "user"}
                          onChange={() => setNewAgentKeySource("user")}
                        />
                        Use <span className="text-zinc-200">my own OpenAI key</span>
                      </label>
                    </div>
                  )}

                  {(newAgentProvider !== "openai" || newAgentKeySource === "user") && (
                    <div className="mt-3">
                      <input
                        type="password"
                        value={newAgentApiKey}
                        onChange={(e) => setNewAgentApiKey(e.target.value)}
                        placeholder={`Enter your ${modelProviders[newAgentProvider].name} API key…`}
                        className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-cyan-500/50 transition-colors font-mono"
                      />
                      <div className="mt-1 text-[11px] text-zinc-500">
                        Stored encrypted. Never shown again after save.
                      </div>
                    </div>
                  )}
                </div>
                </div>
                )}

                {newAgentType === "files" && (
                  <div className="space-y-3">
                    <div className="rounded-xl bg-orange-500/10 border border-orange-500/20 p-3">
                      <div className="text-sm text-orange-200 font-medium flex items-center gap-2">
                        <FileText className="w-4 h-4" />
                        Files Agent (Claude Opus 4.5)
                      </div>
                      <div className="mt-1 text-xs text-zinc-400">
                        Process and create Excel, Word, PowerPoint, and PDF files using Anthropic&apos;s Agent Skills.
                      </div>
                    </div>

                    <div className="rounded-xl bg-white/5 border border-white/10 p-3">
                      <div className="text-xs text-zinc-400 mb-2">
                        <span className="font-semibold text-zinc-300">Supported operations:</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="flex items-center gap-2 text-zinc-300">
                          <span className="text-emerald-400">✓</span> Read &amp; analyze Excel (.xlsx)
                        </div>
                        <div className="flex items-center gap-2 text-zinc-300">
                          <span className="text-emerald-400">✓</span> Create spreadsheets
                        </div>
                        <div className="flex items-center gap-2 text-zinc-300">
                          <span className="text-emerald-400">✓</span> Read &amp; edit Word (.docx)
                        </div>
                        <div className="flex items-center gap-2 text-zinc-300">
                          <span className="text-emerald-400">✓</span> Create documents
                        </div>
                        <div className="flex items-center gap-2 text-zinc-300">
                          <span className="text-emerald-400">✓</span> Create PowerPoint (.pptx)
                        </div>
                        <div className="flex items-center gap-2 text-zinc-300">
                          <span className="text-emerald-400">✓</span> Generate PDFs
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                        Anthropic API Key
                      </label>
                      <input
                        type="password"
                        value={newAgentFilesApiKey}
                        onChange={(e) => setNewAgentFilesApiKey(e.target.value)}
                        placeholder="sk-ant-..."
                        className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-orange-500/50 transition-colors font-mono"
                      />
                      <div className="mt-1 text-[11px] text-zinc-500">
                        Required for Opus 4.5 access. Stored encrypted, never shown again.
                      </div>
                    </div>
                  </div>
                )}

                {newAgentType === "coding" && newAgentCodingType === "claude-code" && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                        Computer
                      </label>
                      {devices.length === 0 ? (
                        <div className="p-3 rounded-xl bg-violet-500/10 border border-violet-500/20">
                          <div className="text-sm text-violet-200 font-medium">
                            Authorize this computer
                          </div>
                          <div className="mt-1 text-xs text-zinc-400">
                            Start the local connector and paste the pairing code.
                          </div>

                          <details className="mt-3 rounded-lg bg-black/20 border border-white/10 px-3 py-2">
                            <summary className="cursor-pointer select-none text-xs font-medium text-zinc-300">
                              How we manage security
                            </summary>
                            <div className="mt-2 text-[11px] text-zinc-400 space-y-1.5">
                              <div>
                                - Connector makes an <span className="text-zinc-200">outbound</span>{" "}
                                connection to the relay (no inbound access to your machine).
                              </div>
                              <div>
                                - Pairing codes are <span className="text-zinc-200">short-lived</span>{" "}
                                and <span className="text-zinc-200">single-use</span>.
                              </div>
                              <div>
                                - The long-lived device token is stored{" "}
                                <span className="text-zinc-200">only on your computer</span>{" "}
                                (Keychain when available).
                              </div>
                              <div>
                                - The terminal starts in your selected folder; we strip common{" "}
                                secret env vars from the spawned shell.
                              </div>
                            </div>
                          </details>

                          <div className="mt-3 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={handleGeneratePairingCode}
                              disabled={pairingLoading}
                              className="px-3 py-2 rounded-lg bg-violet-500/20 text-violet-200 hover:bg-violet-500/30 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors"
                            >
                              {pairingLoading ? "Generating…" : "Generate pairing code"}
                            </button>
                            <button
                              type="button"
                              onClick={() => reloadDevicesAndWorkspaces(true).catch(() => {})}
                              disabled={refreshLoading}
                              className="px-3 py-2 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 disabled:opacity-50 text-sm transition-colors"
                            >
                              {refreshLoading ? "Refreshing…" : "Refresh"}
                            </button>
                          </div>

                          {pairingCode && (
                            <div className="mt-3">
                              {/* Groovy Connector (production) */}
                              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                                    Groovy Connector
                                  </div>
                                  <a
                                    href={
                                      process.env.NEXT_PUBLIC_CONNECTOR_DOWNLOAD_URL ||
                                      "https://github.com/Charlesmendez/groovy-releases/releases/latest/download/Groovy-Connector-macOS.dmg"
                                    }
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[10px] px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 transition-colors"
                                  >
                                    Download
                                  </a>
                                </div>

                                <div className="mt-2 text-xs text-zinc-400 space-y-1.5">
                                  <div>
                                    <span className="text-zinc-500 mr-1.5">1.</span>
                                    <span className="text-zinc-200">Download</span> the connector above and open it
                                  </div>
                                  <div>
                                    <span className="text-zinc-500 mr-1.5">2.</span>
                                    Paste the <span className="text-zinc-200">pairing code</span> below when prompted
                                  </div>
                                  <div>
                                    <span className="text-zinc-500 mr-1.5">3.</span>
                                    Click <span className="text-zinc-200">Refresh</span> once connected, then select your computer
                                  </div>
                                  <div>
                                    <span className="text-zinc-500 mr-1.5">4.</span>
                                    Click <span className="text-zinc-200">Pick folder</span> → choose a folder → <span className="text-zinc-200">Create</span>
                                  </div>
                                </div>
                                <div className="mt-3 flex items-start gap-2 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                                  <span className="text-emerald-400 text-base">✓</span>
                                  <div className="text-[11px] text-emerald-300">
                                    <span className="font-medium">Auto-start enabled:</span>{" "}
                                    <span className="text-emerald-400/80">
                                      After pairing, the connector will automatically start when you log in and reconnect after sleep.
                                    </span>
                                  </div>
                                </div>

                                <div className="mt-3">
                                  <div className="text-xs text-zinc-400 mb-1">
                                    Pairing code (expires in ~10m)
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <div className="flex-1 font-mono text-sm text-white bg-black/30 border border-white/10 px-3 py-2 rounded-lg">
                                      {pairingCode}
                                    </div>
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        try {
                                          await navigator.clipboard.writeText(pairingCode);
                                          setPairingCodeCopied(true);
                                          setTimeout(() => setPairingCodeCopied(false), 1200);
                                        } catch {
                                          // ignore
                                        }
                                      }}
                                      className="shrink-0 px-3 py-2 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 text-sm transition-colors"
                                    >
                                      {pairingCodeCopied ? "Copied" : "Copy"}
                                    </button>
                                  </div>
                                </div>

                                {/* macOS troubleshooting - yellow alert */}
                                <div className="mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                                  <div className="text-[11px] font-semibold text-amber-300 mb-2">
                                    ⚠️ macOS Security Warnings
                                  </div>
                                  <div className="space-y-2 text-[11px]">
                                    <div className="p-2 rounded bg-black/20">
                                      <div className="text-amber-200 font-medium mb-1">
                                        If you see &quot;App is damaged&quot;:
                                      </div>
                                      <div className="text-zinc-400">
                                        Run in Terminal:
                                      </div>
                                      <div className="mt-1 font-mono text-[10px] text-zinc-300 bg-black/40 border border-white/10 rounded px-2 py-1 overflow-x-auto">
                                        xattr -cr ~/Downloads/&quot;Groovy Connector.app&quot;
                                      </div>
                                    </div>
                                    <div className="p-2 rounded bg-black/20">
                                      <div className="text-amber-200 font-medium mb-1">
                                        If you see &quot;Apple could not verify&quot;:
                                      </div>
                                      <div className="text-zinc-400">
                                        Go to <span className="text-zinc-300">System Settings → Privacy &amp; Security</span> → scroll down → click <span className="text-zinc-300">&quot;Open Anyway&quot;</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Developer-mode instructions */}
                              {process.env.NODE_ENV !== "production" && (
                                <details className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
                                  <summary className="cursor-pointer select-none text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                                    Developer mode
                                  </summary>
                                  <div className="mt-2 text-xs text-zinc-400">
                                    Run from your Groovy repo root (the folder that contains{" "}
                                    <span className="font-mono">package.json</span>):
                                  </div>
                                  <div className="mt-2 flex items-start gap-2">
                                    <div className="flex-1 font-mono text-[11px] text-zinc-300 bg-black/40 border border-white/10 rounded-lg px-3 py-2 overflow-x-auto">
                                      cd &lt;path-to-your-groovy-repo&gt; &amp;&amp; npm run connector -- --relay{" "}
                                      {process.env.NEXT_PUBLIC_RELAY_URL ||
                                        "ws://localhost:8787"}{" "}
                                      --pair {pairingCode}
                                    </div>
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        const cmd = `cd <path-to-your-groovy-repo> && npm run connector -- --relay ${
                                          process.env.NEXT_PUBLIC_RELAY_URL ||
                                          "ws://localhost:8787"
                                        } --pair ${pairingCode}`;
                                        try {
                                          await navigator.clipboard.writeText(cmd);
                                          setPairingCmdCopied(true);
                                          setTimeout(() => setPairingCmdCopied(false), 1200);
                                        } catch {
                                          // ignore
                                        }
                                      }}
                                      className="shrink-0 px-3 py-2 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 text-sm transition-colors"
                                    >
                                      {pairingCmdCopied ? "Copied" : "Copy"}
                                    </button>
                                  </div>
                                </details>
                              )}
                              {pairingExpiresAt && (
                                <div className="mt-1 text-[11px] text-zinc-500">
                                  Expires at: {pairingExpiresAt}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <CustomSelect
                          value={newAgentDeviceId}
                          onChange={(val) => {
                            setNewAgentDeviceId(val);
                            setNewAgentWorkspaceId("");
                          }}
                          options={devices.map((d) => ({
                            value: d.id,
                            label: d.name,
                          }))}
                        />
                      )}
                    </div>

                    {devices.length > 0 && (
                      <div>
                        <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                          Workspace folder
                        </label>
                        {workspaces.filter((w) => w.device_id === newAgentDeviceId).length === 0 ? (
                          <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                            <div className="text-xs text-zinc-400">
                              No folders shared yet. First, pick a folder on the selected computer.
                            </div>
                            <button
                              type="button"
                              onClick={handlePickWorkspace}
                              disabled={workspacePickLoading || relay.status !== "ready"}
                              className="mt-3 w-full px-3 py-2 rounded-lg bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors"
                              title={
                                relay.status !== "ready"
                                  ? relay.error || "Relay not connected"
                                  : "Pick a folder on the device"
                              }
                            >
                              {workspacePickLoading ? "Picking…" : "Pick folder…"}
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                              <CustomSelect
                                value={newAgentWorkspaceId}
                                onChange={(val) => setNewAgentWorkspaceId(val)}
                                options={workspaces
                                  .filter((w) => w.device_id === newAgentDeviceId)
                                  .map((w) => ({
                                    value: w.id,
                                    label: w.label,
                                  }))}
                              />
                            </div>
                            <button
                              type="button"
                              onClick={handlePickWorkspace}
                              disabled={workspacePickLoading || relay.status !== "ready"}
                              className="shrink-0 px-3 py-2 rounded-lg bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors"
                              title={
                                relay.status !== "ready"
                                  ? relay.error || "Relay not connected"
                                  : "Pick a folder on the device"
                              }
                            >
                              {workspacePickLoading ? "Picking…" : "Pick…"}
                            </button>
                          </div>
                        )}

                        {relay.status !== "ready" && (
                          <div className="mt-2 text-xs text-amber-300">
                            Relay not connected. {process.env.NEXT_PUBLIC_RELAY_URL 
                              ? "Check that the relay server is running and accessible."
                              : "Set NEXT_PUBLIC_RELAY_URL in your environment variables."}
                          </div>
                        )}

                        {newAgentWorkspaceId && (
                          <div className="mt-2 text-[11px] text-zinc-500">
                            {workspaces.find((w) => w.id === newAgentWorkspaceId)
                              ?.root_path || ""}
                          </div>
                        )}

                        <div className="mt-2 text-[11px] text-zinc-500">
                          Relay: {relay.status}
                          {relay.error ? ` (${relay.error})` : ""}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {newAgentType === "coding" && newAgentCodingType === "cursor" && (
                  <div className="space-y-4">
                    <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3">
                      <div className="text-xs font-semibold text-emerald-300">Cursor Cloud Agents</div>
                      <div className="mt-1 text-[11px] text-zinc-400">
                        Launch cloud-based coding agents that work on your GitHub repositories.
                        No local setup required—agents run on Cursor&apos;s infrastructure.
                      </div>
                    </div>

                    <div className={`rounded-xl border p-3 ${
                      newAgentCursorApiKeyValid 
                        ? "bg-emerald-500/10 border-emerald-500/30" 
                        : "bg-black/20 border-white/10"
                    }`}>
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold text-zinc-300">
                          Cursor API Key
                          {newAgentCursorApiKeyValid && (
                            <span className="ml-2 text-emerald-400">✓ Valid</span>
                          )}
                        </div>
                        {newAgentCursorApiKeyValid && (
                          <button
                            type="button"
                            onClick={() => {
                              setNewAgentCursorApiKeyValid(false);
                              setNewAgentCursorRepos([]);
                            }}
                            className="text-xs text-zinc-400 hover:text-white"
                          >
                            Change
                          </button>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-zinc-400">
                        Create an API key from{" "}
                        <a
                          href="https://cursor.com/settings"
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-400 hover:text-emerald-300"
                        >
                          Cursor Dashboard
                        </a>
                        {" → Integrations"}
                      </div>
                      {!newAgentCursorApiKeyValid && (
                        <>
                          <input
                            type="password"
                            value={newAgentCursorApiKey}
                            onChange={(e) => setNewAgentCursorApiKey(e.target.value)}
                            placeholder="Enter your Cursor API key…"
                            className="mt-2 w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors font-mono"
                          />
                          <button
                            type="button"
                            onClick={handleValidateCursorApiKey}
                            disabled={!newAgentCursorApiKey.trim() || newAgentCursorValidating}
                            className="mt-2 w-full px-4 py-2.5 rounded-lg bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
                          >
                            {newAgentCursorValidating ? "Validating..." : "Validate & Load Repositories"}
                          </button>
                        </>
                      )}
                    </div>

                    {newAgentCursorApiKeyValid && (
                      <>
                        <div>
                          <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                            Default Repository
                          </label>
                          {newAgentCursorRepos.length > 0 ? (
                            <>
                              <select
                                value={newAgentCursorRepository}
                                onChange={(e) => setNewAgentCursorRepository(e.target.value)}
                                className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white outline-none focus:border-emerald-500/50 transition-colors"
                              >
                                <option value="">Select a repository...</option>
                                {newAgentCursorRepos.map((r) => (
                                  <option key={r.repository} value={r.repository}>
                                    {r.owner}/{r.name}
                                  </option>
                                ))}
                              </select>
                              <div className="mt-1 text-[11px] text-zinc-500">
                                {newAgentCursorRepos.length} repositories available from your Cursor account
                              </div>
                            </>
                          ) : (
                            <>
                              <input
                                type="text"
                                value={newAgentCursorRepository}
                                onChange={(e) => setNewAgentCursorRepository(e.target.value)}
                                placeholder="https://github.com/owner/repo"
                                className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                              />
                              <div className="mt-1 text-[11px] text-amber-400">
                                ⚠️ Couldn&apos;t load repositories (rate limited). Enter URL manually.
                              </div>
                            </>
                          )}
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                              Default Branch
                            </label>
                            <input
                              type="text"
                              value={newAgentCursorBranch}
                              onChange={(e) => setNewAgentCursorBranch(e.target.value)}
                              placeholder="main"
                              className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                            />
                          </div>
                          <div className="flex items-end pb-1">
                            <label className="flex items-center gap-2 text-sm text-zinc-300">
                              <input
                                type="checkbox"
                                checked={newAgentCursorAutoCreatePr}
                                onChange={(e) => setNewAgentCursorAutoCreatePr(e.target.checked)}
                                className="rounded"
                              />
                              Auto-create PRs
                            </label>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {newAgentType === "datagran" && (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                        Integration type
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setNewIntegrationsKind("datagran");
                            setNewAgentError(null);
                          }}
                          className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                            newIntegrationsKind === "datagran"
                              ? "bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/30"
                              : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                          }`}
                        >
                          Datagran
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setNewIntegrationsKind("obsidian");
                            setNewAgentError(null);
                          }}
                          className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                            newIntegrationsKind === "obsidian"
                              ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30"
                              : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                          }`}
                        >
                          Obsidian
                        </button>
                      </div>
                    </div>

                    {newIntegrationsKind === "obsidian" ? (
                      <div className="space-y-4">
                        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3">
                          <div className="text-xs font-semibold text-emerald-300">Local Obsidian Vault</div>
                          <div className="mt-1 text-[11px] text-zinc-400">
                            Select your device, then click <span className="text-emerald-300">Find vaults</span> to auto-detect <span className="text-emerald-200 font-mono">.obsidian</span> folders (including iCloud). We&apos;ll create a dedicated Obsidian agent that delegates to Claude Code.
                          </div>
                        </div>

                        {/* Claude Code requirement */}
                        <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 p-3">
                          <div className="text-xs font-semibold text-amber-300">⚠️ Requires Claude Code CLI</div>
                          <div className="mt-1 text-[11px] text-zinc-400">
                            This integration uses Claude Code running locally on your machine. Make sure you have:
                          </div>
                          <ul className="mt-1.5 text-[11px] text-zinc-400 space-y-1">
                            <li>• <span className="text-amber-200">Claude Code CLI</span> installed (<a href="https://docs.anthropic.com/en/docs/claude-code" target="_blank" rel="noreferrer" className="text-amber-300 hover:text-amber-200">docs</a>)</li>
                            <li>• An <span className="text-amber-200">Anthropic API key</span> configured in Claude Code</li>
                          </ul>
                        </div>

                        {/* Security note */}
                        <div className="rounded-xl bg-zinc-800/50 border border-zinc-700/50 p-3">
                          <div className="flex items-start gap-2">
                            <span className="text-emerald-400 text-sm">🔒</span>
                            <div>
                              <div className="text-xs font-semibold text-zinc-300">Your data stays local</div>
                              <div className="mt-0.5 text-[11px] text-zinc-500">
                                Vault scanning only runs <span className="text-zinc-400 font-mono">find</span> to locate folders — no file contents are read or uploaded. All AI processing happens locally via your Claude Code CLI.
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Device pairing or device/workspace pickers */}
                        <div className="space-y-3">
                          <div>
                            <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                              Device
                            </label>
                            {devices.length === 0 ? (
                              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                                <div className="text-xs text-zinc-400 mb-3">
                                  No devices paired yet. Generate a pairing code to connect your local machine.
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={handleGeneratePairingCode}
                                    disabled={pairingLoading}
                                    className="px-3 py-2 rounded-lg bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors"
                                  >
                                    {pairingLoading ? "Generating…" : "Generate pairing code"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => reloadDevicesAndWorkspaces(true).catch(() => {})}
                                    disabled={refreshLoading}
                                    className="px-3 py-2 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 disabled:opacity-50 text-sm transition-colors"
                                  >
                                    {refreshLoading ? "Refreshing…" : "Refresh"}
                                  </button>
                                </div>

                                {pairingCode && (
                                  <div className="mt-3">
                                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                                          Groovy Connector
                                        </div>
                                        <a
                                          href={
                                            process.env.NEXT_PUBLIC_CONNECTOR_DOWNLOAD_URL ||
                                            "https://github.com/Charlesmendez/groovy-releases/releases/latest/download/Groovy-Connector-macOS.dmg"
                                          }
                                          target="_blank"
                                          rel="noreferrer"
                                          className="text-[10px] px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 transition-colors"
                                        >
                                          Download
                                        </a>
                                      </div>

                                      <div className="mt-2 text-xs text-zinc-400 space-y-1.5">
                                        <div>
                                          <span className="text-zinc-500 mr-1.5">1.</span>
                                          <span className="text-zinc-200">Download</span> the connector above and open it
                                        </div>
                                        <div>
                                          <span className="text-zinc-500 mr-1.5">2.</span>
                                          Paste the <span className="text-zinc-200">pairing code</span> below when prompted
                                        </div>
                                        <div>
                                          <span className="text-zinc-500 mr-1.5">3.</span>
                                          Click <span className="text-zinc-200">Refresh</span> once connected, then select your computer
                                        </div>
                                        <div>
                                          <span className="text-zinc-500 mr-1.5">4.</span>
                                          Click <span className="text-emerald-300">Find vaults</span> to locate your Obsidian vault
                                        </div>
                                      </div>

                                      <div className="mt-3">
                                        <div className="text-xs text-zinc-400 mb-1">
                                          Pairing code (expires in ~10m)
                                        </div>
                                        <div className="flex items-center gap-2">
                                          <div className="flex-1 font-mono text-sm text-white bg-black/30 border border-white/10 px-3 py-2 rounded-lg">
                                            {pairingCode}
                                          </div>
                                          <button
                                            type="button"
                                            onClick={async () => {
                                              try {
                                                await navigator.clipboard.writeText(pairingCode);
                                                setPairingCodeCopied(true);
                                                setTimeout(() => setPairingCodeCopied(false), 1200);
                                              } catch {
                                                // ignore
                                              }
                                            }}
                                            className="shrink-0 px-3 py-2 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 text-sm transition-colors"
                                          >
                                            {pairingCodeCopied ? "Copied" : "Copy"}
                                          </button>
                                        </div>
                                      </div>

                                      {/* macOS troubleshooting */}
                                      <div className="mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                                        <div className="text-[11px] font-semibold text-amber-300 mb-2">
                                          ⚠️ macOS Security Warnings
                                        </div>
                                        <div className="space-y-2 text-[11px]">
                                          <div className="p-2 rounded bg-black/20">
                                            <div className="text-amber-200 font-medium mb-1">
                                              If you see &quot;App is damaged&quot;:
                                            </div>
                                            <div className="text-zinc-400">
                                              Run in Terminal:
                                            </div>
                                            <div className="mt-1 font-mono text-[10px] text-zinc-300 bg-black/40 border border-white/10 rounded px-2 py-1 overflow-x-auto">
                                              xattr -cr ~/Downloads/&quot;Groovy Connector.app&quot;
                                            </div>
                                          </div>
                                          <div className="p-2 rounded bg-black/20">
                                            <div className="text-amber-200 font-medium mb-1">
                                              If you see &quot;Apple could not verify&quot;:
                                            </div>
                                            <div className="text-zinc-400">
                                              Go to <span className="text-zinc-300">System Settings → Privacy &amp; Security</span> → scroll down → click <span className="text-zinc-300">&quot;Open Anyway&quot;</span>
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                    {pairingExpiresAt && (
                                      <div className="mt-1 text-[11px] text-zinc-500">
                                        Expires at: {pairingExpiresAt}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <select
                                value={newAgentDeviceId}
                                onChange={(e) => {
                                  setNewAgentDeviceId(e.target.value);
                                  setNewAgentError(null);
                                }}
                                className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white outline-none focus:border-emerald-500/50 transition-colors"
                              >
                                <option value="">Select a device...</option>
                                {devices.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.name}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>

                        </div>

                        {devices.length > 0 && newAgentDeviceId && workspaces.filter((w) => w.device_id === newAgentDeviceId).length === 0 && (
                          <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 p-3">
                            <div className="text-xs font-semibold text-amber-300">Shell access required</div>
                            <div className="mt-1 text-[11px] text-zinc-400">
                              Pick any folder on your machine to give us shell access for scanning.
                            </div>
                            <button
                              type="button"
                              onClick={handlePickWorkspace}
                              disabled={workspacePickLoading || relay.status !== "ready"}
                              className="mt-2 w-full px-3 py-2 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 disabled:opacity-50 transition-colors text-sm"
                            >
                              {workspacePickLoading ? "Picking..." : "Pick a folder"}
                            </button>
                          </div>
                        )}

                        {devices.length > 0 && newAgentDeviceId && workspaces.filter((w) => w.device_id === newAgentDeviceId).length > 0 && (
                          <div className="rounded-xl bg-black/20 border border-white/10 p-3">
                            <div className="flex items-center justify-between">
                              <div className="text-xs font-semibold text-zinc-300">Vault detection</div>
                              <button
                                type="button"
                                onClick={scanForObsidianVaults}
                                disabled={obsidianVaultsLoading || !newAgentDeviceId || relay.status !== "ready"}
                                className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50 transition-colors"
                              >
                                {obsidianVaultsLoading ? "Scanning..." : "Find vaults"}
                              </button>
                            </div>

                            {obsidianVaults.length > 0 ? (
                              <div className="mt-2 space-y-2">
                                <div className="text-[11px] text-zinc-400">
                                  Found {obsidianVaults.length} vault{obsidianVaults.length === 1 ? "" : "s"}.
                                </div>
                                <select
                                  value={selectedObsidianVault}
                                  onChange={(e) => setSelectedObsidianVault(e.target.value)}
                                  className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white outline-none focus:border-emerald-500/50 transition-colors"
                                >
                                  <option value="">Select a vault...</option>
                                  {obsidianVaults.map((p) => (
                                    <option key={p} value={p}>
                                      {p}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ) : (
                              <div className="mt-2 text-[11px] text-zinc-500">
                                Click <span className="text-emerald-300">Find vaults</span> to locate your Obsidian vault folder.
                              </div>
                            )}

                            {/* Manual path entry */}
                            <div className="mt-3 pt-3 border-t border-white/5">
                              <div className="text-[11px] text-zinc-500 mb-1.5">
                                Vault not found? Enter the path manually:
                              </div>
                              <input
                                type="text"
                                value={selectedObsidianVault}
                                onChange={(e) => setSelectedObsidianVault(e.target.value)}
                                placeholder="/Users/you/path/to/vault"
                                className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white placeholder-zinc-600 outline-none focus:border-emerald-500/50 transition-colors text-sm font-mono"
                              />
                              <div className="mt-1 text-[10px] text-zinc-600">
                                The folder containing your <span className="font-mono">.obsidian</span> directory
                              </div>
                            </div>

                            {(obsidianScanRaw || obsidianScanDebugOpen) && (
                              <div className="mt-3">
                                <button
                                  type="button"
                                  onClick={() => setObsidianScanDebugOpen((v) => !v)}
                                  className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 transition-colors"
                                >
                                  {obsidianScanDebugOpen ? "Hide debug" : "Show debug"}
                                </button>
                                {obsidianScanDebugOpen && (
                                  <div className="mt-2 rounded-xl bg-black/40 border border-white/10 p-3">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="text-[11px] text-zinc-400">Last scan raw output (tail)</div>
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          try {
                                            await navigator.clipboard.writeText(obsidianScanRaw || "");
                                          } catch {
                                            // ignore
                                          }
                                        }}
                                        className="text-[11px] px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 transition-colors"
                                      >
                                        Copy
                                      </button>
                                    </div>
                                    <pre className="mt-2 text-[10px] text-zinc-300 whitespace-pre-wrap break-words max-h-48 overflow-auto">
                                      {obsidianScanRaw || "(empty)"}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                            Integration
                          </label>
                          <CustomSelect
                            value={newAgentDatagranProvider}
                            onChange={(val) => {
                              const provider = val as DatagranProvider;
                              setNewAgentDatagranProvider(provider);
                              // Reset pixel state when provider changes
                              setSelectedPixelSiteId("");
                              setPixelSites([]);
                              // Load pixel sites if switching to web_pixel and API key exists
                              if (provider === "web_pixel" && newAgentDatagranApiKey.trim()) {
                                loadPixelSites(newAgentDatagranApiKey);
                              }
                            }}
                            options={Object.entries(DATAGRAN_PROVIDER_LABELS).map(([key, label]) => ({
                              value: key,
                              label,
                            }))}
                          />
                        </div>

                        <div className="rounded-xl bg-black/20 border border-white/10 p-3">
                          <div className="text-xs font-semibold text-zinc-300">Datagran API Key</div>
                          <div className="mt-1 text-[11px] text-zinc-400">
                            Groovy utilizes Datagran as the intelligence layer. Get your API key from{" "}
                            <a
                              href="https://www.datagran.io"
                              target="_blank"
                              rel="noreferrer"
                              className="text-violet-400 hover:text-violet-300"
                            >
                              datagran.io
                            </a>
                          </div>
                          <input
                            type="password"
                            value={newAgentDatagranApiKey}
                            onChange={(e) => {
                              setNewAgentDatagranApiKey(e.target.value);
                              // Load pixel sites when API key changes and web_pixel is selected
                              if (newAgentDatagranProvider === "web_pixel") {
                                loadPixelSites(e.target.value);
                              }
                            }}
                            onBlur={() => {
                              // Also load on blur in case they paste
                              if (newAgentDatagranProvider === "web_pixel" && newAgentDatagranApiKey.trim()) {
                                loadPixelSites(newAgentDatagranApiKey);
                              }
                            }}
                            placeholder="Enter your Datagran API key…"
                            className="mt-2 w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-violet-500/50 transition-colors font-mono"
                          />
                        </div>

                        <div className="rounded-xl bg-black/20 border border-white/10 p-3">
                          <div className="text-xs font-semibold text-zinc-300">Anthropic API Key</div>
                          <div className="mt-1 text-[11px] text-zinc-400">
                            Required for AI-powered data analysis with Claude
                          </div>
                          <input
                            type="password"
                            value={newAgentAnthropicApiKey}
                            onChange={(e) => setNewAgentAnthropicApiKey(e.target.value)}
                            placeholder="Enter your Anthropic API key…"
                            className="mt-2 w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-violet-500/50 transition-colors font-mono"
                          />
                        </div>
                      </>
                    )}

                    {newIntegrationsKind !== "obsidian" && newAgentDatagranProvider === "web_pixel" && (
                      <div className="rounded-xl bg-black/20 border border-white/10 p-3">
                        <div className="text-xs font-semibold text-zinc-300">Pixel Site</div>
                        <div className="mt-1 text-[11px] text-zinc-400">
                          Select an existing pixel site or{" "}
                          <a
                            href="https://www.datagran.io/dashboard/pixel"
                            target="_blank"
                            rel="noreferrer"
                            className="text-cyan-400 hover:text-cyan-300"
                          >
                            create one in Datagran
                          </a>
                        </div>
                        {pixelSitesLoading ? (
                          <div className="mt-2 flex items-center gap-2 text-zinc-400 text-sm">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Loading sites…
                          </div>
                        ) : pixelSites.length > 0 ? (
                          <CustomSelect
                            value={selectedPixelSiteId}
                            onChange={(val) => setSelectedPixelSiteId(val)}
                            options={pixelSites.map((site) => ({
                              value: site.id,
                              label: `${site.name}${site.write_key_prefix ? ` (${site.write_key_prefix}...)` : ""}`,
                            }))}
                          />
                        ) : newAgentDatagranApiKey.trim() ? (
                          <div className="mt-2 text-[11px] text-amber-400">
                            No pixel sites found. Create one in Datagran first.
                          </div>
                        ) : (
                          <div className="mt-2 text-[11px] text-zinc-500">
                            Enter your Datagran API key to load pixel sites.
                          </div>
                        )}
                      </div>
                    )}

                    {newIntegrationsKind !== "obsidian" && (
                      newAgentDatagranProvider === "web_pixel" ? (
                        <div className="rounded-xl bg-cyan-500/10 border border-cyan-500/20 p-3">
                          <div className="text-xs font-semibold text-cyan-300">Web Pixel — First-Party Analytics</div>
                          <ol className="mt-2 text-[11px] text-zinc-400 space-y-1.5">
                            <li><span className="text-zinc-500 mr-1.5">1.</span> Enter your API keys above</li>
                            <li><span className="text-zinc-500 mr-1.5">2.</span> Select a pixel site — <span className="text-cyan-300">no OAuth required!</span></li>
                            <li><span className="text-zinc-500 mr-1.5">3.</span> Chat with Claude to view stats, users, and events</li>
                          </ol>
                          <div className="mt-2 text-[11px] text-zinc-500">
                            Track page views, identify users by email, and analyze site traffic.
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-xl bg-violet-500/10 border border-violet-500/20 p-3">
                          <div className="text-xs font-semibold text-violet-300">How it works</div>
                          <ol className="mt-2 text-[11px] text-zinc-400 space-y-1.5">
                            <li><span className="text-zinc-500 mr-1.5">1.</span> Create this agent with your API keys</li>
                            <li><span className="text-zinc-500 mr-1.5">2.</span> Click <span className="text-violet-300">Connect</span> to authenticate with {DATAGRAN_PROVIDER_LABELS[newAgentDatagranProvider]}</li>
                            <li><span className="text-zinc-500 mr-1.5">3.</span> Chat with Claude to query and analyze your data</li>
                          </ol>
                        </div>
                      )
                    )}
                  </div>
                )}

                <div>
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                    Flag
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(flagColors).map(([key, cfg]) => (
                      <button
                        key={key}
                        onClick={() => setNewAgentFlag(key)}
                        className={`px-3 py-2 rounded-xl flex items-center gap-2 text-sm transition-all ${
                          newAgentFlag === key
                            ? "bg-white/10 ring-1 ring-white/20 text-white"
                            : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                        }`}
                      >
                        <div className={`w-2.5 h-2.5 rounded-full ${cfg.bg}`} />
                        <span className="max-w-[120px] truncate">{cfg.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {!supabaseConfigured && (
                  <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm">
                    {newAgentType === "coding"
                      ? newAgentCodingType === "cursor"
                        ? "Supabase is not configured; Cursor agents require Supabase."
                        : "Supabase is not configured; Claude Code agents require Supabase."
                      : newAgentType === "datagran"
                      ? "Supabase is not configured; Integrations agents require Supabase."
                      : "Supabase is not configured; this agent will be local-only."}
                  </div>
                )}

                {newAgentError && (
                  <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                    {newAgentError}
                  </div>
                )}
              </div>

              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => {
                    setShowNewAgentModal(false);
                    setNewAgentError(null);
                    setPairingCode(null);
                    setPairingExpiresAt(null);
                    setWorkspacePickLoading(false);
                  }}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={
                    newAgentType === "ai-chat"
                      ? handleCreateAiChatAgent
                      : newAgentType === "files"
                      ? handleCreateFilesAgent
                      : newAgentType === "datagran"
                      ? newIntegrationsKind === "obsidian"
                        ? handleCreateObsidianAgent
                        : handleCreateDatagranAgent
                      : newAgentType === "coding" && newAgentCodingType === "cursor"
                      ? handleCreateCursorAgent
                      : handleCreateClaudeCodeAgent
                  }
                  disabled={
                    !newAgentName.trim() ||
                    creatingAgent ||
                    (newAgentType === "coding" &&
                      newAgentCodingType === "claude-code" &&
                      (!supabaseConfigured ||
                        !newAgentDeviceId ||
                        !newAgentWorkspaceId)) ||
                    (newAgentType === "coding" &&
                      newAgentCodingType === "cursor" &&
                      (!supabaseConfigured ||
                        !newAgentCursorApiKey.trim() ||
                        !newAgentCursorApiKeyValid)) ||
                    (newAgentType === "datagran" &&
                      (newIntegrationsKind === "obsidian"
                        ? (!supabaseConfigured ||
                            !newAgentDeviceId ||
                            !selectedObsidianVault.trim())
                        : (!supabaseConfigured ||
                            !newAgentDatagranApiKey.trim() ||
                            !newAgentAnthropicApiKey.trim())))
                  }
                  className={`flex-1 px-4 py-2.5 rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
                    newAgentType === "datagran"
                      ? "bg-violet-500 text-white hover:bg-violet-400"
                      : newAgentType === "coding"
                      ? "bg-emerald-500 text-white hover:bg-emerald-400"
                      : "bg-cyan-500 text-black hover:bg-cyan-400"
                  }`}
                >
                  {creatingAgent ? "Creating..." : "Create"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* New Flag Modal - responsive */}
      <AnimatePresence>
        {showNewFlagModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm sm:p-4"
            onClick={() => setShowNewFlagModal(false)}
          >
            <motion.div
              initial={{ y: "100%", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "100%", opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full sm:max-w-sm p-4 sm:p-6 rounded-t-3xl sm:rounded-2xl glass border border-white/10"
            >
              <h2 className="text-lg font-semibold text-white mb-4">Create New Flag</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                    Flag Name
                  </label>
                  <input
                    type="text"
                    value={newFlagName}
                    onChange={(e) => setNewFlagName(e.target.value)}
                    placeholder="e.g., Backend, Design, Urgent..."
                    className="w-full px-4 py-3 rounded-xl bg-black/30 border border-white/10 text-white placeholder-zinc-500 outline-none focus:border-cyan-500/50 transition-colors"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newFlagName.trim()) {
                        handleAddFlag();
                      }
                    }}
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                    Color
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {availableFlagColors.map((color) => (
                      <button
                        key={color.id}
                        onClick={() => setNewFlagColor(color.id)}
                        className={`
                          w-8 h-8 rounded-lg flex items-center justify-center transition-all
                          ${newFlagColor === color.id 
                            ? "ring-2 ring-white ring-offset-2 ring-offset-zinc-900 scale-110" 
                            : "hover:scale-105"
                          }
                        `}
                        style={{ backgroundColor: color.hex }}
                      />
                    ))}
                  </div>
                </div>

                {/* Preview */}
                {newFlagName.trim() && (
                  <div>
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 block">
                      Preview
                    </label>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 w-fit">
                      <div 
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: availableFlagColors.find(c => c.id === newFlagColor)?.hex }}
                      />
                      <span className="text-sm text-white">{newFlagName}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => {
                    setShowNewFlagModal(false);
                    setNewFlagName("");
                  }}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddFlag}
                  disabled={!newFlagName.trim()}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-cyan-500 text-black font-medium hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Create Flag
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {agentToDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setAgentToDelete(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm p-4 sm:p-6 rounded-2xl glass border border-white/10"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20">
                  <AlertTriangle className="w-5 h-5 text-red-400" />
                </div>
                <h2 className="text-lg font-semibold text-white">Delete Agent</h2>
              </div>

              <p className="text-sm text-zinc-300 mb-2">
                Are you sure you want to delete <span className="font-semibold text-white">{agentToDelete.name}</span>?
              </p>
              <p className="text-xs text-zinc-500 mb-6">
                This will permanently delete the agent and all its data including chat sessions, messages, and configurations. This action cannot be undone.
              </p>

              <div className="flex gap-3">
                <button
                  onClick={() => setAgentToDelete(null)}
                  className="flex-1 px-4 py-3 sm:py-2.5 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => confirmDeleteAgent()}
                  className="flex-1 px-4 py-3 sm:py-2.5 rounded-xl bg-red-500/20 text-red-400 font-medium hover:bg-red-500/30 border border-red-500/30 transition-colors"
                >
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Help Modal */}
      <AnimatePresence>
        {showHelpModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setShowHelpModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm p-6 rounded-2xl glass border border-white/10"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-xl bg-cyan-500/10">
                  <HelpCircle className="w-6 h-6 text-cyan-400" />
                </div>
                <h2 className="text-lg font-semibold text-white">Need Help?</h2>
              </div>
              
              <p className="text-sm text-zinc-300 mb-4">
                If you need help, we are happy to assist! Reach out to us and we&apos;ll get back to you as soon as possible.
              </p>
              
              <a
                href="mailto:theshopcbg@gmail.com"
                className="flex items-center gap-3 p-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-colors group"
              >
                <div className="p-2 rounded-lg bg-cyan-500/10 group-hover:bg-cyan-500/20 transition-colors">
                  <Send className="w-4 h-4 text-cyan-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-white">Email Us</p>
                  <p className="text-xs text-zinc-400">theshopcbg@gmail.com</p>
                </div>
              </a>
              
              <button
                onClick={() => setShowHelpModal(false)}
                className="w-full mt-4 px-4 py-2.5 rounded-xl bg-white/5 text-zinc-400 font-medium hover:bg-white/10 hover:text-white transition-colors"
              >
                Close
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden bottom-nav">
        <div className="flex items-center justify-around py-2">
          <button
            onClick={() => {
              setSelectedAgent(null);
              setMobileMenuOpen(false);
            }}
            className={`flex flex-col items-center gap-1 px-4 py-2 rounded-xl transition-colors ${
              !selectedAgent && !mobileMenuOpen
                ? "text-cyan-400"
                : "text-zinc-500"
            }`}
          >
            <Grid3X3 className="w-5 h-5" />
            <span className="text-[10px] font-medium">Agents</span>
          </button>
          
          <button
            onClick={() => setShowNewAgentModal(true)}
            className="flex flex-col items-center gap-1 px-4 py-2 rounded-xl text-zinc-500 hover:text-cyan-400 transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-gradient-to-r from-cyan-500 to-cyan-600 flex items-center justify-center -mt-4 shadow-lg shadow-cyan-500/30">
              <Plus className="w-5 h-5 text-black" />
            </div>
            <span className="text-[10px] font-medium mt-1">New</span>
          </button>
          
          <button
            onClick={() => setMobileMenuOpen(true)}
            className={`flex flex-col items-center gap-1 px-4 py-2 rounded-xl transition-colors ${
              mobileMenuOpen
                ? "text-cyan-400"
                : "text-zinc-500"
            }`}
          >
            <Settings className="w-5 h-5" />
            <span className="text-[10px] font-medium">Menu</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
