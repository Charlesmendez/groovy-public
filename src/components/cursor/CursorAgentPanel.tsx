"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Play,
  Square,
  Trash2,
  ExternalLink,
  GitBranch,
  RefreshCcw,
  Send,
  ChevronDown,
  ChevronRight,
  Clock,
  CheckCircle2,
  AlertCircle,
  Pause,
  Copy,
  Maximize2,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { CustomSelect } from "@/components/ui/CustomSelect";

type CursorConfigRow = {
  cursor_api_key_hash: string;
  default_repository: string | null;
  default_branch: string | null;
  auto_create_pr: boolean;
};

type CursorTaskRow = {
  id: string;
  cursor_agent_id: string;
  name: string | null;
  status: string;
  repository: string | null;
  branch_name: string | null;
  pr_url: string | null;
  agent_url: string | null;
  summary: string | null;
  prompt: string | null;
  created_at: string;
};

type CursorApiAgent = {
  id: string;
  name: string | null;
  status: string;
  source: {
    repository: string;
    ref?: string;
  };
  target: {
    branchName?: string;
    url?: string;
    prUrl?: string;
    autoCreatePr?: boolean;
  };
  summary?: string;
  createdAt: string;
};

// Combined view of local + API agents
type DisplayAgent = {
  id: string;
  cursorAgentId: string;
  name: string | null;
  status: string;
  repository: string | null;
  branchName: string | null;
  prUrl: string | null;
  agentUrl: string | null;
  summary: string | null;
  prompt: string | null;
  createdAt: string;
  isFromApi: boolean;
};

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

type TextOrCodeSegment =
  | { type: "text"; text: string; key: string }
  | {
      type: "code";
      info: string;
      code: string;
      key: string;
    };

function parseFencedCodeBlocks(input: string): TextOrCodeSegment[] {
  // Supports markdown-style triple backticks:
  // ```<info>
  // <code>
  // ```
  const segments: TextOrCodeSegment[] = [];
  const re = /```([^\n]*)\n([\s\S]*?)```/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const full = match[0];
    const info = (match[1] || "").trim();
    const code = (match[2] || "").replace(/\n$/, ""); // avoid trailing empty line

    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        text: input.slice(lastIndex, match.index),
        key: `t-${lastIndex}`,
      });
    }

    segments.push({
      type: "code",
      info,
      code,
      key: `c-${match.index}-${full.length}`,
    });

    lastIndex = match.index + full.length;
  }

  if (lastIndex < input.length) {
    segments.push({ type: "text", text: input.slice(lastIndex), key: `t-${lastIndex}` });
  }

  return segments;
}

function parseCursorCodeFenceInfo(info: string): { filePath?: string; start?: string; end?: string } {
  // Cursor sometimes returns code fences like:
  // ```510:556:/workspace/src/foo.ts
  // ...
  // ```
  const m = info.match(/^(\d+):(\d+):(.+)$/);
  if (!m) return {};
  return { start: m[1], end: m[2], filePath: m[3] };
}

function inferLanguageLabel(info: string, filePath?: string) {
  if (info && !/^\d+:\d+:/.test(info)) return info;
  if (!filePath) return "";
  const file = filePath.split("/").pop() || "";
  const ext = file.includes(".") ? file.split(".").pop()!.toLowerCase() : "";
  if (!ext) return "";
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "js" || ext === "jsx") return "javascript";
  if (ext === "json") return "json";
  if (ext === "md") return "markdown";
  if (ext === "sql") return "sql";
  if (ext === "py") return "python";
  if (ext === "sh") return "shell";
  if (ext === "yml" || ext === "yaml") return "yaml";
  return ext;
}

function CodeBlock({ info, code }: { info: string; code: string }) {
  const { filePath, start, end } = parseCursorCodeFenceInfo(info);
  const fileName = filePath ? filePath.split("/").pop() || filePath : "";
  const prettyPath = filePath ? filePath.replace(/^\/workspace\//, "") : "";
  const lang = inferLanguageLabel(info, filePath);

  return (
    <div className="rounded-lg border border-white/10 bg-black/40 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/10 bg-black/30">
        <div className="min-w-0">
          <div className="text-[10px] text-zinc-400 truncate" title={filePath || info}>
            {filePath ? (
              <>
                <span className="text-zinc-200">{fileName}</span>
                {start && end ? <span className="text-zinc-500">{` • ${start}-${end}`}</span> : null}
                {prettyPath && prettyPath !== fileName ? (
                  <span className="text-zinc-600">{` • ${prettyPath}`}</span>
                ) : null}
              </>
            ) : info ? (
              <span className="text-zinc-400">{info}</span>
            ) : (
              <span className="text-zinc-500">code</span>
            )}
          </div>
          {lang ? <div className="text-[10px] text-zinc-600">{lang}</div> : null}
        </div>

        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(code).catch(() => {})}
          className="shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/5 text-zinc-300 hover:bg-white/10 text-[10px]"
          title="Copy code"
        >
          <Copy className="w-3 h-3" />
          Copy
        </button>
      </div>

      <pre className="p-3 overflow-x-auto text-xs leading-relaxed">
        <code className="font-mono text-zinc-200 whitespace-pre">{code}</code>
      </pre>
    </div>
  );
}

function MessageContent({ text }: { text: string }) {
  const parts = useMemo(() => parseFencedCodeBlocks(text), [text]);

  return (
    <div className="text-zinc-300 text-xs space-y-2">
      {parts.map((p) => {
        if (p.type === "code") return <CodeBlock key={p.key} info={p.info} code={p.code} />;
        // Keep as plain text (but preserve newlines) for safety and simplicity.
        const t = p.text.trimEnd();
        if (!t) return null;
        return (
          <div key={p.key} className="whitespace-pre-wrap">
            {t}
          </div>
        );
      })}
    </div>
  );
}

const STATUS_CONFIG: Record<string, { color: string; icon: typeof Clock; label: string }> = {
  // Uppercase (as per API docs)
  CREATING: { color: "text-amber-400", icon: Clock, label: "Creating" },
  RUNNING: { color: "text-cyan-400", icon: Loader2, label: "Running" },
  FINISHED: { color: "text-emerald-400", icon: CheckCircle2, label: "Finished" },
  STOPPED: { color: "text-zinc-400", icon: Pause, label: "Stopped" },
  FAILED: { color: "text-red-400", icon: AlertCircle, label: "Failed" },
  // Lowercase variants (in case API returns these)
  creating: { color: "text-amber-400", icon: Clock, label: "Creating" },
  running: { color: "text-cyan-400", icon: Loader2, label: "Running" },
  finished: { color: "text-emerald-400", icon: CheckCircle2, label: "Finished" },
  stopped: { color: "text-zinc-400", icon: Pause, label: "Stopped" },
  failed: { color: "text-red-400", icon: AlertCircle, label: "Failed" },
  // Other possible variations
  completed: { color: "text-emerald-400", icon: CheckCircle2, label: "Completed" },
  COMPLETED: { color: "text-emerald-400", icon: CheckCircle2, label: "Completed" },
  error: { color: "text-red-400", icon: AlertCircle, label: "Error" },
  ERROR: { color: "text-red-400", icon: AlertCircle, label: "Error" },
};

const DEFAULT_STATUS = { color: "text-zinc-400", icon: Clock, label: "Unknown" };

// Small component for follow-up form with loading state
function FollowUpForm({
  cursorAgentId,
  agentId,
  onSuccess,
}: {
  cursorAgentId: string;
  agentId: string;
  onSuccess: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    try {
      const res = await fetch(`/api/cursor/agents/${cursorAgentId}/followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, prompt: text }),
      });
      if (res.ok) {
        setInput("");
        onSuccess();
      }
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mt-3 flex gap-2">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Send follow-up instruction..."
        disabled={sending}
        className="flex-1 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-xs placeholder-zinc-500 outline-none focus:border-emerald-500/50 disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={!input.trim() || sending}
        className="px-3 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50 text-xs transition-colors flex items-center gap-1"
      >
        {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
        Send
      </button>
    </form>
  );
}

export function CursorAgentPanel({
  agentId,
  onUpdate,
}: {
  agentId: string;
  onUpdate?: (data: {
    status?: "running" | "ready" | "error";
    output?: string[];
    lastMessage?: { role: "user" | "assistant"; content: string };
    cursorAgentId?: string;
    sendFollowUp?: (message: string) => Promise<void>;
  }) => void;
}) {
  const [config, setConfig] = useState<CursorConfigRow | null>(null);
  const [displayAgents, setDisplayAgents] = useState<DisplayAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [modalAgentId, setModalAgentId] = useState<string | null>(null);

  // Conversation view
  const [loadingConversation, setLoadingConversation] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, Array<{ id: string; type: string; text: string }>>>({});

  // New task form
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTaskPrompt, setNewTaskPrompt] = useState("");
  const [newTaskRepo, setNewTaskRepo] = useState("");
  const [newTaskBranch, setNewTaskBranch] = useState("");
  const [newTaskAutoCreatePr, setNewTaskAutoCreatePr] = useState(false);
  const [creating, setCreating] = useState(false);

  // Repositories from Cursor API
  const [repositories, setRepositories] = useState<Array<{ owner: string; name: string; repository: string }>>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);

  // Models from Cursor API
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [newTaskModel, setNewTaskModel] = useState("");

  const onUpdateRef = useRef(onUpdate);
  const displayAgentsRef = useRef(displayAgents);
  const conversationsRef = useRef(conversations);
  
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);
  
  useEffect(() => {
    displayAgentsRef.current = displayAgents;
  }, [displayAgents]);
  
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);


  // Ref for loadAgents to avoid circular deps
  const loadAgentsRef = useRef<(() => Promise<void>) | null>(null);

  // Create a stable sendFollowUp function
  const sendFollowUp = useCallback(async (message: string) => {
    const targetAgentId = displayAgentsRef.current.find((a) =>
      ["CREATING", "RUNNING"].includes(a.status?.toUpperCase() || "")
    )?.cursorAgentId || displayAgentsRef.current[0]?.cursorAgentId;
    
    if (!targetAgentId || !message.trim()) return;
    
    const res = await fetch(`/api/cursor/agents/${targetAgentId}/followup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, prompt: message }),
    });
    
    if (res.ok) {
      // Clear cached conversation to force refresh
      setConversations((prev) => {
        const next = { ...prev };
        delete next[targetAgentId];
        return next;
      });
      // Reload agents and conversation
      setTimeout(() => {
        loadAgentsRef.current?.();
      }, 1000);
    }
  }, [agentId]);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setPanelError(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("cursor_agent_configs")
        .select("cursor_api_key_hash,default_repository,default_branch,auto_create_pr")
        .eq("agent_id", agentId)
        .single();

      if (error || !data) {
        setConfig(null);
        return;
      }
      setConfig(data as CursorConfigRow);
      // Set form defaults from config
      setNewTaskRepo(data.default_repository || "");
      setNewTaskBranch(data.default_branch || "main");
      setNewTaskAutoCreatePr(Boolean(data.auto_create_pr));
    } catch (e) {
      setPanelError(getErrorMessage(e) || "Failed to load agent config");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  const loadAgents = useCallback(async () => {
    try {
      // Fetch from Cursor API directly
      const apiRes = await fetch(`/api/cursor/agents?agentId=${agentId}`);
      let apiAgents: CursorApiAgent[] = [];
      if (apiRes.ok) {
        const json = await apiRes.json();
        apiAgents = json.agents || [];
      }

      // Also fetch local tasks for any additional metadata (like prompt)
      const supabase = getSupabaseBrowserClient();
      const { data: localTasks } = await supabase
        .from("cursor_agent_tasks")
        .select("*")
        .eq("agent_id", agentId);

      const localByAgentId = new Map<string, CursorTaskRow>();
      (localTasks || []).forEach((t) => {
        localByAgentId.set(t.cursor_agent_id, t as CursorTaskRow);
      });

      // Merge API agents with local data
      const merged: DisplayAgent[] = apiAgents.map((a) => {
        const local = localByAgentId.get(a.id);
        return {
          id: local?.id || a.id,
          cursorAgentId: a.id,
          name: a.name,
          status: a.status,
          repository: a.source?.repository || null,
          branchName: a.target?.branchName || null,
          prUrl: a.target?.prUrl || null,
          agentUrl: a.target?.url || null,
          summary: a.summary || null,
          prompt: local?.prompt || null,
          createdAt: a.createdAt,
          isFromApi: true,
        };
      });

      // Sort by creation date (newest first)
      merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      setDisplayAgents(merged);

      // Update parent status based on agents
      const hasRunning = merged.some((t) =>
        ["CREATING", "RUNNING"].includes(t.status?.toUpperCase() || "")
      );
      
      // Find active agent for follow-up
      const activeAgent = merged.find((t) =>
        ["CREATING", "RUNNING"].includes(t.status?.toUpperCase() || "")
      ) || merged[0];
      
      // Get last message from conversation if available
      const activeConversation = activeAgent
        ? conversationsRef.current[activeAgent.cursorAgentId]
        : null;
      const lastConvMessage = activeConversation?.length
        ? activeConversation[activeConversation.length - 1]
        : null;
      const lastMessage = lastConvMessage
        ? {
            role: (lastConvMessage.type === "user" ? "user" : "assistant") as "user" | "assistant",
            content: lastConvMessage.text,
          }
        : activeAgent?.summary
        ? { role: "assistant" as const, content: activeAgent.summary }
        : activeAgent?.prompt
        ? { role: "user" as const, content: activeAgent.prompt }
        : undefined;
      
      onUpdateRef.current?.({
        status: hasRunning ? "running" : "ready",
        output: merged.length
          ? [merged[0].name || merged[0].prompt?.slice(0, 100) || "Cursor Agent"]
          : [],
        cursorAgentId: activeAgent?.cursorAgentId,
        lastMessage,
        sendFollowUp,
      });
    } catch {
      // ignore
    }
  }, [agentId, sendFollowUp]);

  // Store ref for use in sendFollowUp
  useEffect(() => {
    loadAgentsRef.current = loadAgents;
  }, [loadAgents]);

  const loadRepositories = useCallback(async () => {
    setLoadingRepos(true);
    try {
      const res = await fetch(`/api/cursor/repositories?agentId=${agentId}`);
      if (res.ok) {
        const json = await res.json();
        setRepositories(json.repositories || []);
      }
    } catch {
      // ignore - repos are optional
    } finally {
      setLoadingRepos(false);
    }
  }, [agentId]);

  const loadModels = useCallback(async () => {
    if (models.length > 0) return; // Already loaded
    setLoadingModels(true);
    try {
      const res = await fetch(`/api/cursor/models?agentId=${agentId}`);
      if (res.ok) {
        const json = await res.json();
        setModels(json.models || []);
      }
    } catch {
      // ignore - models are optional
    } finally {
      setLoadingModels(false);
    }
  }, [agentId, models.length]);

  useEffect(() => {
    loadConfig().catch(() => {});
    loadAgents().catch(() => {});
  }, [loadConfig, loadAgents]);

  // Poll for agent updates
  useEffect(() => {
    if (!config) return;
    const interval = setInterval(() => {
      loadAgents().catch(() => {});
    }, 10000); // Every 10 seconds
    return () => clearInterval(interval);
  }, [config, loadAgents]);

  // Update parent when conversations change
  useEffect(() => {
    const activeAgent = displayAgents.find((t) =>
      ["CREATING", "RUNNING"].includes(t.status?.toUpperCase() || "")
    ) || displayAgents[0];
    
    if (!activeAgent) return;
    
    const activeConversation = conversations[activeAgent.cursorAgentId];
    const lastConvMessage = activeConversation?.length
      ? activeConversation[activeConversation.length - 1]
      : null;
    const lastMessage = lastConvMessage
      ? {
          role: (lastConvMessage.type === "user" ? "user" : "assistant") as "user" | "assistant",
          content: lastConvMessage.text,
        }
      : activeAgent?.summary
      ? { role: "assistant" as const, content: activeAgent.summary }
      : activeAgent?.prompt
      ? { role: "user" as const, content: activeAgent.prompt }
      : undefined;
    
    const hasRunning = displayAgents.some((t) =>
      ["CREATING", "RUNNING"].includes(t.status?.toUpperCase() || "")
    );
    
    onUpdateRef.current?.({
      status: hasRunning ? "running" : "ready",
      cursorAgentId: activeAgent?.cursorAgentId,
      lastMessage,
      sendFollowUp,
    });
  }, [conversations, displayAgents, sendFollowUp]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadAgents();
    } catch (e) {
      setPanelError(getErrorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }, [loadAgents]);

  const handleCreateTask = useCallback(async () => {
    if (!newTaskPrompt.trim() || !newTaskRepo.trim()) return;
    setCreating(true);
    setPanelError(null);
    
    try {
      const res = await fetch("/api/cursor/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          prompt: newTaskPrompt.trim(),
          repository: newTaskRepo.trim(),
          ref: newTaskBranch.trim() || "main",
          autoCreatePr: newTaskAutoCreatePr,
          ...(newTaskModel ? { model: newTaskModel } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to launch agent");

      setNewTaskPrompt("");
      setNewTaskModel("");
      setShowNewTask(false);
      await loadAgents();
    } catch (e) {
      setPanelError(getErrorMessage(e));
    } finally {
      setCreating(false);
    }
  }, [agentId, newTaskPrompt, newTaskRepo, newTaskBranch, newTaskAutoCreatePr, newTaskModel, loadAgents]);

  const handleStopTask = useCallback(async (cursorAgentId: string) => {
    try {
      const res = await fetch(`/api/cursor/agents/${cursorAgentId}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to stop");
      }
      await loadAgents();
    } catch (e) {
      setPanelError(getErrorMessage(e));
    }
  }, [agentId, loadAgents]);

  const loadConversation = useCallback(async (cursorAgentId: string, forceRefresh = false) => {
    if (!forceRefresh && conversations[cursorAgentId]) return; // Already loaded
    
    if (!forceRefresh) setLoadingConversation(cursorAgentId);
    try {
      const res = await fetch(`/api/cursor/agents/${cursorAgentId}/conversation?agentId=${agentId}`);
      if (res.ok) {
        const json = await res.json();
        setConversations((prev) => ({
          ...prev,
          [cursorAgentId]: json.messages || [],
        }));
      }
    } catch {
      // ignore
    } finally {
      if (!forceRefresh) setLoadingConversation(null);
    }
  }, [agentId, conversations]);

  // Poll for conversation updates when an active agent is expanded
  useEffect(() => {
    if (!expandedTask) return;
    
    const agent = displayAgents.find((a) => a.cursorAgentId === expandedTask);
    const isActive = ["CREATING", "RUNNING"].includes(agent?.status?.toUpperCase() || "");
    
    if (!isActive) return;
    
    const interval = setInterval(() => {
      loadConversation(expandedTask, true);
    }, 3000); // Poll every 3 seconds for active agents
    
    return () => clearInterval(interval);
  }, [expandedTask, displayAgents, loadConversation]);

  // Poll for conversation updates when modal is open and agent is active
  useEffect(() => {
    if (!modalAgentId) return;
    
    const agent = displayAgents.find((a) => a.cursorAgentId === modalAgentId);
    const isActive = ["CREATING", "RUNNING"].includes(agent?.status?.toUpperCase() || "");
    
    if (!isActive) return;
    
    const interval = setInterval(() => {
      loadConversation(modalAgentId, true);
    }, 3000);
    
    return () => clearInterval(interval);
  }, [modalAgentId, displayAgents, loadConversation]);

  const handleDeleteTask = useCallback(async (cursorAgentId: string) => {
    try {
      const res = await fetch(`/api/cursor/agents/${cursorAgentId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to delete");
      }
      // Remove from local state
      setDisplayAgents((prev) => prev.filter((t) => t.cursorAgentId !== cursorAgentId));
    } catch (e) {
      setPanelError(getErrorMessage(e));
    }
  }, [agentId]);

  const headerSubtitle = useMemo(() => {
    if (!config) return "Not configured";
    const runningCount = displayAgents.filter((t) =>
      ["CREATING", "RUNNING"].includes(t.status?.toUpperCase() || "")
    ).length;
    if (runningCount > 0) return `${runningCount} agent${runningCount > 1 ? "s" : ""} running`;
    return `${displayAgents.length} agent${displayAgents.length !== 1 ? "s" : ""}`;
  }, [config, displayAgents]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading Cursor Agent…
      </div>
    );
  }

  if (!config) {
    return (
      <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
        <div className="flex items-center gap-2 text-sm text-zinc-300">
          <AlertCircle className="w-4 h-4 text-amber-400" />
          This Cursor agent isn&apos;t configured yet.
        </div>
        <div className="mt-1 text-xs text-zinc-500">
          Provide your Cursor API key when creating the agent.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            Cursor Cloud Agent
          </h4>
          <div className="text-sm text-white truncate flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-emerald-400" />
            <span className="truncate">{headerSubtitle}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 text-zinc-300 hover:bg-white/10 transition-colors text-xs disabled:opacity-50"
          >
            <RefreshCcw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Sync
          </button>
          <button
            onClick={() => {
              setShowNewTask(true);
              if (repositories.length === 0) loadRepositories();
              loadModels();
            }}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 transition-colors text-xs"
          >
            <Play className="w-3.5 h-3.5" />
            New Task
          </button>
        </div>
      </div>

      {/* New Task Form */}
      {showNewTask && (
        <div className="mb-4 p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5">
          <div className="flex items-center justify-between mb-3">
            <h5 className="text-sm font-medium text-white">Launch Cloud Agent</h5>
            <button
              onClick={() => setShowNewTask(false)}
              className="text-zinc-400 hover:text-white text-xs"
            >
              Cancel
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Task Prompt</label>
              <textarea
                value={newTaskPrompt}
                onChange={(e) => setNewTaskPrompt(e.target.value)}
                placeholder="Describe what you want the agent to do..."
                rows={3}
                className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-sm placeholder-zinc-500 outline-none focus:border-emerald-500/50 resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Repository</label>
                {loadingRepos ? (
                  <div className="flex items-center gap-2 text-zinc-500 text-xs py-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading repos...
                  </div>
                ) : repositories.length > 0 ? (
                  <select
                    value={newTaskRepo}
                    onChange={(e) => setNewTaskRepo(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-sm outline-none focus:border-emerald-500/50"
                  >
                    <option value="">Select repository...</option>
                    {repositories.map((r) => (
                      <option key={r.repository} value={r.repository}>
                        {r.owner}/{r.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={newTaskRepo}
                    onChange={(e) => setNewTaskRepo(e.target.value)}
                    placeholder="https://github.com/owner/repo"
                    className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-sm placeholder-zinc-500 outline-none focus:border-emerald-500/50"
                  />
                )}
              </div>
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Base Branch</label>
                <input
                  type="text"
                  value={newTaskBranch}
                  onChange={(e) => setNewTaskBranch(e.target.value)}
                  placeholder="main"
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-sm placeholder-zinc-500 outline-none focus:border-emerald-500/50"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Model</label>
              {loadingModels ? (
                <div className="flex items-center gap-2 text-zinc-500 text-xs py-2">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Loading models...
                </div>
              ) : (
                <CustomSelect
                  options={[
                    { value: "", label: "Auto (recommended)" },
                    ...models.map((m) => ({ value: m, label: m })),
                  ]}
                  value={newTaskModel}
                  onChange={setNewTaskModel}
                  placeholder="Select model..."
                />
              )}
            </div>

            <div>
              <label className={`flex items-center gap-2 text-sm cursor-pointer ${
                newTaskAutoCreatePr ? "text-emerald-300" : "text-zinc-300"
              }`}>
                <input
                  type="checkbox"
                  checked={newTaskAutoCreatePr}
                  onChange={(e) => setNewTaskAutoCreatePr(e.target.checked)}
                  className="rounded accent-emerald-500"
                />
                Auto-create PR when finished
                {newTaskAutoCreatePr && <span className="text-emerald-400">✓</span>}
              </label>
              {newTaskAutoCreatePr && (
                <div className="text-[10px] text-zinc-500 mt-1 ml-5">
                  PR will be created automatically when the agent completes
                </div>
              )}
            </div>

            <button
              onClick={handleCreateTask}
              disabled={creating || !newTaskPrompt.trim() || !newTaskRepo.trim()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium text-sm"
            >
              {creating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Launching...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Launch Agent
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Agent List */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
        {displayAgents.length === 0 ? (
          <div className="h-full rounded-2xl border border-white/10 bg-black/50 flex items-center justify-center text-sm text-zinc-400">
            <div className="text-center">
              <GitBranch className="w-8 h-8 mx-auto mb-2 text-zinc-600" />
              <p>No cloud agents yet</p>
              <p className="text-xs text-zinc-500 mt-1">
                Click &quot;New Task&quot; to launch a cloud agent
              </p>
            </div>
          </div>
        ) : (
          displayAgents.map((agent) => {
            const statusCfg = STATUS_CONFIG[agent.status] || DEFAULT_STATUS;
            const StatusIcon = statusCfg.icon;
            const isExpanded = expandedTask === agent.cursorAgentId;
            const statusUpper = agent.status?.toUpperCase() || "";
            const isActive = ["CREATING", "RUNNING"].includes(statusUpper);

            return (
              <div
                key={agent.cursorAgentId}
                className={`rounded-xl border ${
                  isActive
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-white/10 bg-black/30"
                } overflow-hidden`}
              >
                <button
                  onClick={() => {
                    const newExpanded = isExpanded ? null : agent.cursorAgentId;
                    setExpandedTask(newExpanded);
                    if (newExpanded) {
                      loadConversation(agent.cursorAgentId);
                    }
                  }}
                  className="w-full flex items-center gap-3 p-3 text-left hover:bg-white/5 transition-colors"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
                  )}
                  <StatusIcon
                    className={`w-4 h-4 shrink-0 ${statusCfg.color} ${
                      isActive ? "animate-spin" : ""
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate">
                      {agent.name || agent.prompt?.slice(0, 50) || "Unnamed agent"}
                    </div>
                    <div className="text-xs text-zinc-500 truncate">
                      {agent.repository?.replace("https://github.com/", "") || "No repo"} •{" "}
                      {new Date(agent.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${statusCfg.color} bg-white/5`}
                  >
                    {statusCfg.label}
                  </span>
                </button>

                {isExpanded && (
                  <div className="px-4 pb-4 space-y-3 border-t border-white/5 pt-3">
                    {agent.prompt && (
                      <div>
                        <div className="text-xs text-zinc-500 mb-1">Prompt</div>
                        <div className="text-sm text-zinc-300 bg-black/20 rounded-lg p-2">
                          {agent.prompt}
                        </div>
                      </div>
                    )}

                    {agent.summary && (
                      <div>
                        <div className="text-xs text-zinc-500 mb-1">Summary</div>
                        <div className="text-sm text-zinc-300 bg-black/20 rounded-lg p-2">
                          {agent.summary}
                        </div>
                      </div>
                    )}

                    {/* Conversation */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-xs text-zinc-500">Conversation</div>
                        <div className="flex items-center gap-2">
                          {conversations[agent.cursorAgentId]?.length ? (
                            <button
                              onClick={() => setModalAgentId(agent.cursorAgentId)}
                              className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                              title="Expand conversation"
                            >
                              <Maximize2 className="w-3.5 h-3.5" />
                            </button>
                          ) : null}
                          {conversations[agent.cursorAgentId] && (
                            <button
                              onClick={() => {
                                setConversations((prev) => {
                                  const next = { ...prev };
                                  delete next[agent.cursorAgentId];
                                  return next;
                                });
                                loadConversation(agent.cursorAgentId);
                              }}
                              className="text-[10px] text-zinc-400 hover:text-white"
                            >
                              Refresh
                            </button>
                          )}
                        </div>
                      </div>
                      {loadingConversation === agent.cursorAgentId ? (
                        <div className="flex items-center gap-2 text-zinc-400 text-xs py-2">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Loading conversation...
                        </div>
                      ) : conversations[agent.cursorAgentId]?.length ? (
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {conversations[agent.cursorAgentId].map((msg) => (
                            <div
                              key={msg.id}
                              className={`rounded-lg p-2 text-sm ${
                                msg.type === "user_message"
                                  ? "bg-cyan-500/10 border border-cyan-500/20"
                                  : "bg-black/30 border border-white/5"
                              }`}
                            >
                              <div className="text-[10px] text-zinc-500 mb-1">
                                {msg.type === "user_message" ? "You" : "Cursor Agent"}
                              </div>
                              <MessageContent text={msg.text} />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-zinc-500 py-2">
                          No conversation available
                        </div>
                      )}

                      {/* Follow-up input - always show to allow continuing conversation */}
                      <FollowUpForm 
                        cursorAgentId={agent.cursorAgentId}
                        agentId={agentId}
                        onSuccess={() => {
                          // Clear cached conversation to force refresh
                          setConversations((prev) => {
                            const next = { ...prev };
                            delete next[agent.cursorAgentId];
                            return next;
                          });
                          setTimeout(() => loadConversation(agent.cursorAgentId), 1000);
                        }}
                      />
                    </div>

                    {agent.branchName && (
                      <div className="flex items-center gap-2 text-xs">
                        <GitBranch className="w-3 h-3 text-zinc-500" />
                        <span className="text-zinc-400">Branch:</span>
                        <span className="text-white font-mono">{agent.branchName}</span>
                      </div>
                    )}

                    <div className="flex items-center gap-2 flex-wrap">
                      {agent.agentUrl && (
                        <a
                          href={agent.agentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 text-xs transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                          View in Cursor
                        </a>
                      )}
                      {agent.prUrl && (
                        <a
                          href={agent.prUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 text-xs transition-colors"
                        >
                          <GitBranch className="w-3 h-3" />
                          View PR
                        </a>
                      )}
                      {isActive && (
                        <button
                          onClick={() => handleStopTask(agent.cursorAgentId)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 text-xs transition-colors"
                        >
                          <Square className="w-3 h-3" />
                          Stop
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteTask(agent.cursorAgentId)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 text-red-300 hover:bg-red-500/20 text-xs transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {panelError && <div className="mt-2 text-xs text-red-400">{panelError}</div>}

      {/* Expanded conversation modal */}
      {modalAgentId && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setModalAgentId(null)}
        >
          <div
            className="w-full max-w-5xl h-[90vh] bg-zinc-900 rounded-3xl border border-white/10 shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            {(() => {
              const modalAgent = displayAgents.find((a) => a.cursorAgentId === modalAgentId);
              const modalConv = conversations[modalAgentId] || [];
              const modalStatusCfg = STATUS_CONFIG[modalAgent?.status || ""] || DEFAULT_STATUS;
              const ModalStatusIcon = modalStatusCfg.icon;
              const modalIsActive = ["CREATING", "RUNNING"].includes(modalAgent?.status?.toUpperCase() || "");

              return (
                <>
                  <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
                    <div className="flex items-center gap-3">
                      <ModalStatusIcon
                        className={`w-5 h-5 ${modalStatusCfg.color} ${modalIsActive ? "animate-spin" : ""}`}
                      />
                      <div>
                        <h2 className="text-lg font-semibold text-white">
                          {modalAgent?.name || modalAgent?.prompt?.slice(0, 60) || "Cursor Agent"}
                        </h2>
                        <div className="flex items-center gap-2 text-sm text-zinc-400">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${modalStatusCfg.color} bg-white/5`}>
                            {modalStatusCfg.label}
                          </span>
                          {modalAgent?.repository && (
                            <>
                              <span>•</span>
                              <span className="font-mono text-xs">
                                {modalAgent.repository.replace("https://github.com/", "")}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setConversations((prev) => {
                            const next = { ...prev };
                            delete next[modalAgentId];
                            return next;
                          });
                          loadConversation(modalAgentId);
                        }}
                        className="px-3 py-1.5 rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 text-xs transition-colors"
                      >
                        <RefreshCcw className="w-3.5 h-3.5 inline mr-1.5" />
                        Refresh
                      </button>
                      <button
                        onClick={() => setModalAgentId(null)}
                        className="p-2 rounded-xl hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                  </div>

                  {/* Conversation content */}
                  <div className="flex-1 overflow-y-auto p-6 space-y-4">
                    {loadingConversation === modalAgentId ? (
                      <div className="flex items-center justify-center h-full text-zinc-400">
                        <Loader2 className="w-6 h-6 animate-spin" />
                      </div>
                    ) : modalConv.length ? (
                      modalConv.map((msg) => (
                        <div
                          key={msg.id}
                          className={`rounded-xl p-4 ${
                            msg.type === "user_message"
                              ? "bg-cyan-500/10 border border-cyan-500/20 ml-auto max-w-[80%]"
                              : "bg-black/30 border border-white/5 max-w-[90%]"
                          }`}
                        >
                          <div className="text-xs text-zinc-500 mb-2">
                            {msg.type === "user_message" ? "You" : "Cursor Agent"}
                          </div>
                          <div className="text-zinc-200">
                            <MessageContent text={msg.text} />
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="flex items-center justify-center h-full text-zinc-500">
                        No conversation available
                      </div>
                    )}
                  </div>

                  {/* Follow-up input */}
                  <div className="px-6 py-4 border-t border-white/10">
                    <FollowUpForm
                      cursorAgentId={modalAgentId}
                      agentId={agentId}
                      onSuccess={() => {
                        setConversations((prev) => {
                          const next = { ...prev };
                          delete next[modalAgentId];
                          return next;
                        });
                        setTimeout(() => loadConversation(modalAgentId), 1000);
                      }}
                    />
                  </div>
                </>
              );
            })()}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
