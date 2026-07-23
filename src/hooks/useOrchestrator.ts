"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { getActiveProfileId } from "@/lib/harnessProfileClient";
import { extractWhatsAppSendConfirmation } from "@/lib/whatsapp/pendingSend";
import { extractTelegramSendConfirmation } from "@/lib/telegram/pendingSend";

export type AgentType =
  | "browser"
  | "files"
  | "pages"
  | "obsidian"
  | "data"
  | "chat"
  | "schedule"
  | "code";

export type ActivityAgentType = AgentType | "memory" | "system" | "handshake";

function parseMentionedAgents(message: string): AgentType[] {
  const set = new Set<AgentType>();
  const text = String(message || "").toLowerCase();
  if (/(^|\s)@browser(\s|$)/.test(text)) set.add("browser");
  if (/(^|\s)@files(\s|$)/.test(text)) set.add("files");
  if (/(^|\s)@pages(\s|$)/.test(text)) set.add("pages");
  if (/(^|\s)@obsidian(\s|$)/.test(text)) set.add("obsidian");
  if (/(^|\s)@data(\s|$)/.test(text)) set.add("data");
  if (/(^|\s)@chat(\s|$)/.test(text)) set.add("chat");
  if (/(^|\s)@ai(\s|$)/.test(text)) set.add("chat");
  return Array.from(set);
}

function isFilesSessionsQuestion(message: string): boolean {
  const text = String(message || "").toLowerCase();
  if (!/(^|\s)@files(\s|$)/.test(text)) return false;
  // Common phrasings: "what sessions do you have", "list sessions", "show sessions"
  return /\bsessions?\b/.test(text) && (/\bdo you have\b/.test(text) || /\blist\b/.test(text) || /\bshow\b/.test(text) || /\bwhat\b/.test(text));
}

function summarizeNames(names: string[], limit = 6): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  const shown = clean.slice(0, limit);
  const extra = clean.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} (+${extra} more)` : shown.join(", ");
}

type InlineOrchestratorFile = {
  mediaType: string;
  base64: string;
  filename?: string | null;
};

type PreparedInlineOrchestratorFile = InlineOrchestratorFile & {
  byteSize: number;
};

const VISION_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VISION_IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};
const MAX_INLINE_IMAGE_FILES = 3;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_DIMENSION = 1600;
const INLINE_IMAGE_JPEG_QUALITIES = [0.86, 0.78, 0.68, 0.58, 0.48];

function getVisionImageMediaType(file: File): string | null {
  if (VISION_IMAGE_TYPES.has(file.type)) return file.type;
  const ext = file.name.toLowerCase().split(".").pop() || "";
  return VISION_IMAGE_EXTENSIONS[ext] || null;
}

function isVisionImageFile(file: File): boolean {
  return !!getVisionImageMediaType(file);
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not prepare image"))),
      type,
      quality
    );
  });
}

async function loadDrawableImage(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Fall back to an HTMLImageElement below.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not load image"));
      img.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function prepareVisionImageFile(file: File): Promise<PreparedInlineOrchestratorFile> {
  const originalMediaType = getVisionImageMediaType(file) || "image/png";
  if (file.size <= MAX_INLINE_IMAGE_BYTES) {
    return {
      mediaType: originalMediaType,
      base64: await readBlobAsBase64(file),
      filename: file.name || null,
      byteSize: file.size,
    };
  }

  const drawable = await loadDrawableImage(file);
  try {
    const longestSide = Math.max(drawable.width, drawable.height);
    let scale = Math.min(1, MAX_INLINE_IMAGE_DIMENSION / Math.max(1, longestSide));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const width = Math.max(1, Math.round(drawable.width * scale));
      const height = Math.max(1, Math.round(drawable.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not prepare image");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(drawable.source, 0, 0, width, height);

      for (const quality of INLINE_IMAGE_JPEG_QUALITIES) {
        const blob = await canvasToBlob(canvas, "image/jpeg", quality);
        if (blob.size <= MAX_INLINE_IMAGE_BYTES) {
          return {
            mediaType: "image/jpeg",
            base64: await readBlobAsBase64(blob),
            filename: file.name || null,
            byteSize: blob.size,
          };
        }
      }

      scale *= 0.72;
    }
  } finally {
    drawable.close();
  }

  throw new Error(`${file.name || "Image"} is too large to attach. Try a smaller image or screenshot.`);
}

function buildLlmHistoryContent(
  content: string,
  metadata?: OrchestratorMessage["metadata"]
): string {
  const base = String(content || "").trim();
  const parts: string[] = [base];

  const attachedFiles = Array.isArray(metadata?.files)
    ? metadata.files
        .map((f) => (f && typeof f.name === "string" ? f.name : ""))
        .filter(Boolean)
    : [];
  if (attachedFiles.length > 0) {
    parts.push(
      `[Conversation context: files attached in this turn: ${summarizeNames(attachedFiles)}]`
    );
  }

  const generatedFiles = Array.isArray(metadata?.generated_files)
    ? metadata.generated_files
        .map((f) => (f && typeof f.name === "string" ? f.name : ""))
        .filter(Boolean)
    : [];
  if (generatedFiles.length > 0) {
    parts.push(
      `[Conversation context: files generated earlier: ${summarizeNames(generatedFiles)}]`
    );
  }

  const generatedImagesCount = Array.isArray(metadata?.generated_images)
    ? metadata.generated_images.length
    : 0;
  if (generatedImagesCount > 0) {
    parts.push(
      `[Conversation context: ${generatedImagesCount} generated image(s) were produced earlier in this session.]`
    );
  }

  return parts.filter(Boolean).join("\n\n").trim();
}

export type ToolCall = {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  status: "pending" | "running" | "complete" | "error";
};

export type ActivityMetadata = {
  title: string;
  subtitle?: string;
  provider?: string;
  target?: string;
  query?: string;
  tags?: string[];
  toolName?: string;
};

export type ActivitySummary = {
  headline?: string;
  stats?: Record<string, string | number>;
  items?: string[];
  error?: string;
};

export type AgentActivity = {
  id: string;
  agent: ActivityAgentType;
  agentName?: string;
  action: string;
  detail?: string;
  status: "pending" | "running" | "complete" | "error";
  result?: unknown;
  error?: string;
  timestamp: Date;
  metadata?: ActivityMetadata;
  summary?: ActivitySummary;
  /** The orchestrator session this activity belongs to (for multi-agent scoping). */
  sessionId?: string;
};

type PersistedActivityRow = {
  id: string;
  agent: string;
  action: string;
  detail?: string | null;
  status: string;
  timestamp?: string;
  created_at?: string;
  metadata?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const CODE_CLI_TIMEOUT_CONTINUE_PROMPT =
  "Continue from where you left off. Do not repeat completed tool calls or duplicate file edits. Finish the current task and return the final answer directly.";
const ORCHESTRATOR_INFLIGHT_STORAGE_KEY = "groovy_orchestrator_inflight";
const ORCHESTRATOR_INFLIGHT_MAX_AGE_MS = 22 * 60 * 1000;

function pickConnectorSessionId(...values: unknown[]): string | null {
  for (const value of values) {
    const record = asRecord(value);
    if (!record) continue;
    const directSnake = record.session_id;
    if (typeof directSnake === "string" && directSnake.trim()) return directSnake.trim();
    const directCamel = record.sessionId;
    if (typeof directCamel === "string" && directCamel.trim()) return directCamel.trim();
    const nestedResult = asRecord(record.result);
    if (nestedResult) {
      const nestedSnake = nestedResult.session_id;
      if (typeof nestedSnake === "string" && nestedSnake.trim()) return nestedSnake.trim();
      const nestedCamel = nestedResult.sessionId;
      if (typeof nestedCamel === "string" && nestedCamel.trim()) return nestedCamel.trim();
    }
  }
  return null;
}

function isConnectorTimeoutResult(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (record.ok === true) return false;
  if (record.timed_out === true) return true;
  if (record.partial === true && typeof record.error === "string" && /timed out/i.test(record.error)) {
    return true;
  }
  return typeof record.error === "string" && /timed out/i.test(record.error);
}

function withConnectorSessionId(
  value: { ok: boolean; error?: string; [key: string]: unknown },
  sessionId: string | null
): { ok: boolean; error?: string; [key: string]: unknown } {
  if (!sessionId) return value;
  const next = { ...value };
  if (typeof next.session_id !== "string" || !next.session_id.trim()) {
    next.session_id = sessionId;
  }
  if (typeof next.sessionId !== "string" || !next.sessionId.trim()) {
    next.sessionId = sessionId;
  }
  return next;
}

function looksLikeActivityMetadata(value: unknown): value is ActivityMetadata {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.title === "string" ||
    typeof record.toolName === "string" ||
    typeof record.subtitle === "string" ||
    typeof record.target === "string" ||
    typeof record.query === "string" ||
    Array.isArray(record.tags)
  );
}

export function restorePersistedActivities(
  rows: PersistedActivityRow[],
  opts?: { sessionId?: string; protectedRunningIds?: Set<string> }
): AgentActivity[] {
  const deduped = new Map<string, AgentActivity>();
  for (const row of rows || []) {
    const outer = asRecord(row.metadata);
    const nestedMetadata = looksLikeActivityMetadata(outer?.metadata)
      ? (outer?.metadata as ActivityMetadata)
      : looksLikeActivityMetadata(outer)
        ? (outer as ActivityMetadata)
        : undefined;
    const summary = asRecord(outer?.summary) ? (outer?.summary as ActivitySummary) : undefined;
    const logicalActivityId =
      typeof outer?.logical_activity_id === "string" && outer.logical_activity_id.trim()
        ? outer.logical_activity_id.trim()
        : typeof outer?.activity_id === "string" && outer.activity_id.trim()
          ? outer.activity_id.trim()
          : row.id;
    const timestampValue =
      (typeof row.timestamp === "string" && row.timestamp) ||
      (typeof row.created_at === "string" && row.created_at) ||
      new Date().toISOString();
    const activity: AgentActivity = {
      id: logicalActivityId,
      agent: row.agent as ActivityAgentType,
      action: row.action,
      detail: typeof row.detail === "string" ? row.detail : undefined,
      status:
        row.status === "running" &&
        !(opts?.protectedRunningIds && opts.protectedRunningIds.has(logicalActivityId))
          ? "complete"
          : (row.status as AgentActivity["status"]),
      timestamp: new Date(timestampValue),
      metadata: nestedMetadata,
      summary,
      result: outer && "result" in outer ? outer.result : undefined,
      sessionId: opts?.sessionId,
    };
    deduped.set(logicalActivityId, activity);
  }
  return Array.from(deduped.values()).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

export type OrchestratorMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  toolCalls?: ToolCall[];
  agentActivities?: AgentActivity[];
  metadata?: {
    files?: Array<{ id: string; name: string }>;
    generated_files?: Array<{
      name: string;
      mediaType: string;
      url?: string;
      storage_path?: string;
      file_id?: string;
      filename?: string;
      mime_type?: string;
    }>;
    generated_images?: Array<{ mediaType: string; base64: string }>;
    [k: string]: unknown;
  };
};

export type OrchestratorSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  shared?: boolean;
  runtimeSessionId?: string | null;
  agentId?: string;
};

function dedupeSessionsById(input: OrchestratorSession[]): OrchestratorSession[] {
  const seen = new Set<string>();
  const deduped: OrchestratorSession[] = [];
  for (const session of input) {
    const id = typeof session?.id === "string" ? session.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({
      ...session,
      id,
    });
  }
  return deduped;
}

// Connector execute callback type
export type ConnectorExecuteCallback = (params: {
  type: string;
  params: Record<string, unknown>;
  toolCallId: string;
  toolName: string;
  agent: AgentType;
  sessionId?: string;
}) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;

// SSE Event types from orchestrator
type SSEEvent = 
  | { type: "text"; text: string }
  | { 
      type: "tool-call"; 
      toolCallId: string; 
      toolName: string; 
      agent: AgentType; 
      args: Record<string, unknown>; 
      status: "running";
      metadata?: ActivityMetadata;
    }
  | { 
      type: "tool-result"; 
      toolCallId: string; 
      toolName: string; 
      agent: AgentType; 
      result: string; 
      status: "complete";
      summary?: ActivitySummary;
      generatedFiles?: Array<{
        name: string;
        mediaType: string;
        url?: string;
        storage_path?: string;
        file_id?: string;
        filename?: string;
        mime_type?: string;
      }>;
    }
  | {
      type: "tool-stream";
      toolName: string;
      text: string;
    }
  | {
      type: "clear_tool_stream";
    }
  | {
      type: "connector-execute";
      toolCallId: string;
      toolName: string;
      agent: AgentType;
      connectorType: string;
      connectorParams: Record<string, unknown>;
      message: string;
    }
  | {
      type: "browser-task";
      toolCallId: string;
      toolName: string;
      agent: AgentType;
      task: string;
      startUrl?: string;
      message: string;
    }
  | { 
      type: "activity"; 
      agent: ActivityAgentType; 
      action: string; 
      detail?: string; 
      status: "running" | "complete" | "error";
    }
  | {
      type: "ui-open-code";
      toolCallId: string;
      toolName: string;
      agentId?: string;
      name?: string;
      requestedName?: string;
    }
  | {
      type: "needs-reauth";
      toolCallId: string;
      toolName: string;
      provider: string;
      agentId: string;
      linkToken?: string;
    }
  | {
      type: "done";
      traceId: string;
      hitStepBudget?: boolean;
      needsClientContinuation?: boolean;
    }
  | { type: "error"; error: string };

// Browser task callback type (for Computer Use)
export type BrowserTaskCallback = (params: {
  task: string;
  startUrl?: string;
  onScreenshot?: (screenshot: string, url: string, title: string) => void;
  onAction?: (action: string, detail?: string) => void;
  onComplete?: (result: string) => void;
  onError?: (error: string) => void;
}) => Promise<{ ok: boolean; result?: string; error?: string }>;

export type UseOrchestratorOptions = {
  initialSessionId?: string;
  onConnectorExecute?: ConnectorExecuteCallback;
  onBrowserTask?: BrowserTaskCallback;
  onOpenCodeSession?: (agentId: string, name?: string) => void;
};

export function useOrchestrator(options?: UseOrchestratorOptions | string) {
  // Support both old (string) and new (object) API
  const opts = typeof options === "string" 
    ? { initialSessionId: options } 
    : options || {};
  const { initialSessionId, onConnectorExecute, onOpenCodeSession } = opts;
  const [sessions, setSessions] = useState<OrchestratorSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(initialSessionId || null);
  const [messages, setMessages] = useState<OrchestratorMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [preparingMemoryContext, setPreparingMemoryContext] = useState(false);
  const [activeAgents, setActiveAgents] = useState<AgentType[]>([]);
  const [agentActivities, setAgentActivities] = useState<AgentActivity[]>([]);
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsReauth, setNeedsReauth] = useState<{
    provider: string;
    agentId: string;
    linkToken?: string;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef(0);
  const isStreamingRef = useRef(false);
  const pendingActivitiesRef = useRef<AgentActivity[]>([]);
  const justCreatedSessionRef = useRef<string | null>(null);
  const skipNextSessionLoadRef = useRef<string | null>(null);
  const activeBrowserTaskActivityIdsRef = useRef<Set<string>>(new Set());
  const reloadSessionsTimerRef = useRef<number | null>(null);
  const loadSessionsRef = useRef<null | (() => Promise<void>)>(null);
  const sessionsRef = useRef<OrchestratorSession[]>([]);
  const currentSessionIdRef = useRef<string | null>(null);
  const agentIdBySessionIdRef = useRef<Map<string, string>>(new Map());
  const sessionIdByAgentIdRef = useRef<Map<string, string>>(new Map());
  const reloadCurrentSessionTimerRef = useRef<number | null>(null);
  const loadSessionRef = useRef<null | ((sessionId: string) => Promise<void>)>(null);
  const loadSessionRequestIdRef = useRef(0);
  const activeTurnRef = useRef<{
    sessionId: string;
    turnId: string;
    startedAt: number;
  } | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      // Avoid any caching layers (browser / Next) so realtime-triggered refreshes always show new sessions.
      const res = await fetch(`/api/orchestrator/agents?ts=${Date.now()}`, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.warn(
          "[useOrchestrator] Failed to load sessions:",
          res.status,
          txt.slice(0, 200)
        );
        return;
      }
      const data = await res.json().catch(() => ({}));
      const nextSessions = Array.isArray(data.sessions)
        ? dedupeSessionsById(data.sessions as OrchestratorSession[])
        : [];
      console.log("[useOrchestrator] Loaded agents:", nextSessions.length);
      setSessions(nextSessions);
      const nextAgentBySession = new Map(agentIdBySessionIdRef.current);
      const nextSessionByAgent = new Map(sessionIdByAgentIdRef.current);
      for (const row of nextSessions) {
        if (!row || typeof row.id !== "string" || !row.id.trim()) continue;
        const sid = row.id.trim();
        const agentId =
          typeof row.agentId === "string" && row.agentId.trim()
            ? row.agentId.trim()
            : "";
        const runtimeSessionId =
          typeof row.runtimeSessionId === "string" && row.runtimeSessionId.trim()
            ? row.runtimeSessionId.trim()
            : sid;
        if (agentId) {
          nextAgentBySession.set(sid, agentId);
          nextSessionByAgent.set(agentId, runtimeSessionId);
        }
      }
      agentIdBySessionIdRef.current = nextAgentBySession;
      sessionIdByAgentIdRef.current = nextSessionByAgent;

      // Auto-select first session if none selected
      if (!currentSessionId && data.sessions?.length > 0) {
        setCurrentSessionId(data.sessions[0].id);
      }
    } catch (e) {
      console.warn("[useOrchestrator] Failed to load sessions:", e);
    } finally {
      setIsLoading(false);
    }
  }, [currentSessionId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // Keep a stable ref to the latest loadSessions (avoids stale closures from realtime handlers).
  useEffect(() => {
    loadSessionsRef.current = loadSessions;
  }, [loadSessions]);

  const scheduleReloadSessions = useCallback((opts?: { ensureSessionId?: string }) => {
    const ensureSessionId = opts?.ensureSessionId;
    if (reloadSessionsTimerRef.current) window.clearTimeout(reloadSessionsTimerRef.current);

    const attempt = async (triesLeft: number) => {
      console.log("[useOrchestrator] Realtime -> reloading sessions…", {
        ensureSessionId,
        triesLeft,
      });
      await loadSessionsRef.current?.();

      // Supabase Realtime can arrive slightly ahead of read-after-write consistency on the query
      // the dashboard uses (especially with ordering/joins). If we expect a specific session id,
      // retry a few times until it shows up.
      if (ensureSessionId) {
        const has = sessionsRef.current.some((s) => s.id === ensureSessionId);
        if (!has && triesLeft > 0) {
          window.setTimeout(() => attempt(triesLeft - 1), 400);
        }
      }
    };

    reloadSessionsTimerRef.current = window.setTimeout(() => {
      attempt(6).catch(() => {});
    }, 250);
  }, []);

  const scheduleReloadCurrentSession = useCallback((sessionId: string) => {
    if (reloadCurrentSessionTimerRef.current) {
      window.clearTimeout(reloadCurrentSessionTimerRef.current);
    }

    const reloadWhenIdle = () => {
      // Realtime callbacks outlive the render that created them. Read the ref so an
      // event received during a stream cannot apply a stale pre-stream snapshot.
      if (isStreamingRef.current) {
        reloadCurrentSessionTimerRef.current = window.setTimeout(reloadWhenIdle, 500);
        return;
      }
      loadSessionRef.current?.(sessionId).catch(() => {});
    };

    reloadCurrentSessionTimerRef.current = window.setTimeout(reloadWhenIdle, 250);
  }, []);

  // Load sessions on mount
  useEffect(() => {
    // Call directly; the ref is populated later and is mainly for realtime callbacks.
    loadSessions().catch(() => {});
  }, [loadSessions]);

  // Subscribe to realtime session updates (e.g., when WhatsApp creates a new session)
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    
    let channel:
      | ReturnType<typeof supabase.channel>
      | null = null;

    const start = async () => {
      // Ensure the browser client is authenticated (cookie-based session).
      const { data } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
      const userId = data?.user?.id;
      if (!userId) {
        console.warn("[useOrchestrator] Realtime: no user session in browser client; skipping subscription");
        return;
      }

      channel = supabase
        .channel("orchestrator_realtime")
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "orchestrator_sessions",
            // Explicit filter helps both perf and RLS edge cases
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            console.log("[useOrchestrator] Realtime INSERT received:", payload);
            // Re-fetch so ordering/messageCount match the server response.
            const insertedId = (payload as { new?: { id?: string } }).new?.id;
            scheduleReloadSessions({ ensureSessionId: typeof insertedId === "string" ? insertedId : undefined });
          }
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "orchestrator_sessions",
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            console.log("[useOrchestrator] Realtime UPDATE received:", payload);
            scheduleReloadSessions();
          }
        )
        .on(
          "postgres_changes",
          {
            event: "DELETE",
            schema: "public",
            table: "orchestrator_sessions",
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            console.log("[useOrchestrator] Realtime DELETE received:", payload);
            scheduleReloadSessions();
          }
        )
        // Also listen for new messages so the currently open chat updates automatically
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "orchestrator_messages",
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            console.log("[useOrchestrator] Realtime message INSERT received:", payload);
            const sid = (payload as { new?: { session_id?: string } }).new?.session_id;
            if (typeof sid !== "string") return;

            // If this message is for the currently open session, reload its messages.
            if (currentSessionIdRef.current && sid === currentSessionIdRef.current) {
              scheduleReloadCurrentSession(sid);
            }
            // Always refresh sessions list so updated_at / ordering / message count stay correct.
            scheduleReloadSessions();
          }
        )
        .subscribe((status) => {
          console.log("[useOrchestrator] Realtime subscription status:", status);
        });
    };

    start();

    return () => {
      if (channel) supabase.removeChannel(channel);
      if (reloadSessionsTimerRef.current) {
        window.clearTimeout(reloadSessionsTimerRef.current);
        reloadSessionsTimerRef.current = null;
      }
    };
  }, [scheduleReloadSessions, scheduleReloadCurrentSession]);

  // Subscribe to realtime message inserts for the CURRENT session (needed for workspace-shared sessions,
  // because message authors differ and the user_id-filtered subscription above won't fire).
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!currentSessionId) return;

    let channel: ReturnType<typeof supabase.channel> | null = null;
    const sid = currentSessionId;

    const start = async () => {
      const { data } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
      const userId = data?.user?.id;
      if (!userId) return;

      channel = supabase
        .channel(`orchestrator_session_messages:${sid}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "orchestrator_messages",
            filter: `session_id=eq.${sid}`,
          },
          () => {
            scheduleReloadCurrentSession(sid);
            scheduleReloadSessions();
          }
        )
        .subscribe();
    };

    start();
    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [currentSessionId, scheduleReloadCurrentSession, scheduleReloadSessions]);

  // Subscribe to workspace share/unshare events so newly shared sessions show up live.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    let channel: ReturnType<typeof supabase.channel> | null = null;

    const start = async () => {
      const { data } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
      const userId = data?.user?.id;
      if (!userId) return;

      const { data: membership } = await supabase
        .from("workspace_members")
        .select("workspace_id")
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();

      const workspaceId = membership?.workspace_id ? String(membership.workspace_id) : null;
      if (!workspaceId) return;

      channel = supabase
        .channel(`workspace_orchestrator_sessions:${workspaceId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "workspace_orchestrator_sessions",
            filter: `workspace_id=eq.${workspaceId}`,
          },
          (payload) => {
            const insertedId = (payload as { new?: { session_id?: string } }).new?.session_id;
            scheduleReloadSessions({
              ensureSessionId: typeof insertedId === "string" ? insertedId : undefined,
            });
          }
        )
        .subscribe();
    };

    start();
    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [scheduleReloadSessions]);

  // Load session data when currentSessionId changes
  useEffect(() => {
    if (currentSessionId) {
      // Skip loading if we just created this session (it's empty)
      if (justCreatedSessionRef.current === currentSessionId) {
        justCreatedSessionRef.current = null;
        setIsLoading(false);
        return;
      }
      // Programmatic session switches (multi-pane send flow) can race with
      // optimistic user message rendering. Skip one immediate reload to avoid
      // replacing local state with a stale snapshot.
      if (skipNextSessionLoadRef.current === currentSessionId) {
        skipNextSessionLoadRef.current = null;
        setIsLoading(false);
        return;
      }
      loadSession(currentSessionId);
    } else {
      // Clear state when no session
      setMessages([]);
      setAgentActivities([]);
      setIsLoading(false);
    }
  }, [currentSessionId]);

  const loadSession = async (sessionId: string) => {
    const requestId = ++loadSessionRequestIdRef.current;
    const runIdAtStart = activeRunIdRef.current;
    const startedWhileStreaming = isStreamingRef.current;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/orchestrator/agents/${sessionId}?ts=${Date.now()}`, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
      });
      if (res.ok) {
        const data = await res.json();

        // Ignore stale or superseded snapshots. In particular, a fetch that began
        // before/during a local run must never replace the completed local answer.
        if (
          requestId !== loadSessionRequestIdRef.current ||
          currentSessionIdRef.current !== sessionId ||
          startedWhileStreaming ||
          isStreamingRef.current ||
          activeRunIdRef.current !== runIdAtStart
        ) {
          return;
        }

        const agentId =
          typeof data?.session?.agentId === "string" && data.session.agentId.trim()
            ? data.session.agentId.trim()
            : null;
        const runtimeSessionId =
          typeof data?.session?.runtimeSessionId === "string" &&
          data.session.runtimeSessionId.trim()
            ? data.session.runtimeSessionId.trim()
            : null;
        if (agentId) {
          agentIdBySessionIdRef.current.set(sessionId, agentId);
          sessionIdByAgentIdRef.current.set(agentId, runtimeSessionId || sessionId);
        }
        
        // Load messages
        if (data.messages) {
          setMessages(data.messages.map((m: {
            id: string;
            role: string;
            content: string;
            timestamp: string;
            metadata?: unknown;
          }) => ({
            // Database row ids are unique. Trace ids are not: a single WhatsApp
            // or connector trace can legitimately persist multiple messages.
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: new Date(m.timestamp),
            metadata: (m.metadata && typeof m.metadata === "object")
              ? (m.metadata as OrchestratorMessage["metadata"])
              : undefined,
          })));
        }
        
        // Load activities - mark any stale "running" as "complete"
        if (data.activities) {
          setAgentActivities(
            restorePersistedActivities(
              data.activities as PersistedActivityRow[],
              {
                protectedRunningIds: activeBrowserTaskActivityIdsRef.current,
              }
            )
          );
        }
      }
    } catch (e) {
      console.warn("[useOrchestrator] Failed to load session:", e);
    } finally {
      setIsLoading(false);
    }
  };

  // Keep stable ref so realtime handlers can refresh the open session.
  useEffect(() => {
    loadSessionRef.current = loadSession;
  }, [currentSessionId]); // best-effort; loadSession reads current state via closures

  const createSession = useCallback(async (title?: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/orchestrator/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || "New Agent" }),
      });
      
      if (res.ok) {
        const data = await res.json();
        const newSession = data.session;
        if (
          newSession &&
          typeof newSession.id === "string" &&
          typeof newSession.agentId === "string" &&
          newSession.agentId.trim()
        ) {
          const sid = newSession.id.trim();
          const aid = newSession.agentId.trim();
          const runtimeSid =
            typeof newSession.runtimeSessionId === "string" && newSession.runtimeSessionId.trim()
              ? newSession.runtimeSessionId.trim()
              : sid;
          agentIdBySessionIdRef.current.set(sid, aid);
          sessionIdByAgentIdRef.current.set(aid, runtimeSid);
        }
        setSessions((prev) => dedupeSessionsById([newSession, ...prev]));
        // Mark as just created so useEffect doesn't load (and overwrite messages)
        justCreatedSessionRef.current = newSession.id;
        setCurrentSessionId(newSession.id);
        setMessages([]);
        setAgentActivities([]);
        return newSession.id;
      }
    } catch (e) {
      console.error("[useOrchestrator] Failed to create session:", e);
    }
    return null;
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/orchestrator/agents?id=${sessionId}`, {
        method: "DELETE",
      });
      
      if (res.ok) {
        const agentId = agentIdBySessionIdRef.current.get(sessionId);
        agentIdBySessionIdRef.current.delete(sessionId);
        if (agentId) {
          const mappedSession = sessionIdByAgentIdRef.current.get(agentId);
          if (mappedSession === sessionId) {
            sessionIdByAgentIdRef.current.delete(agentId);
          }
        }
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("groovy:session-deleted", {
              detail: { sessionId },
            })
          );
        }
        
        // If deleted current session, switch to another
        if (currentSessionId === sessionId) {
          const remaining = sessions.filter((s) => s.id !== sessionId);
          setCurrentSessionId(remaining.length > 0 ? remaining[0].id : null);
        }
      }
    } catch (e) {
      console.error("[useOrchestrator] Failed to delete session:", e);
    }
  }, [currentSessionId, sessions]);

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    try {
      await fetch("/api/orchestrator/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sessionId, title }),
      });
      
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title } : s))
      );
    } catch (e) {
      console.error("[useOrchestrator] Failed to rename session:", e);
    }
  }, []);

  const selectSession = useCallback(
    (sessionId: string, options?: { skipLoad?: boolean }) => {
      if (options?.skipLoad) {
        skipNextSessionLoadRef.current = sessionId;
      } else {
        skipNextSessionLoadRef.current = null;
      }
      setCurrentSessionId(sessionId);
    },
    []
  );

  const markSessionShared = useCallback((sessionId: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, shared: true } : s))
    );
  }, []);

  const getAgentIdForSession = useCallback((sessionId?: string | null) => {
    const sid = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!sid) return null;
    const aid = agentIdBySessionIdRef.current.get(sid) || "";
    return aid || null;
  }, []);

  // Persist message to database
  const persistMessage = useCallback(async (
    message: OrchestratorMessage,
    sessionId: string,
    traceId?: string
  ) => {
    try {
      const runtimeSessionId = sessionId;
      const agentId = agentIdBySessionIdRef.current.get(sessionId) || null;
      await fetch("/api/orchestrator/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: runtimeSessionId,
          agentId,
          role: message.role,
          content: message.content,
          traceId,
          metadata: message.metadata,
        }),
      });
    } catch (e) {
      console.warn("[useOrchestrator] Failed to persist message:", e);
    }
  }, []);

  // Persist activities to database (batched)
  const persistActivity = useCallback(async (activity: AgentActivity, sessionId?: string) => {
    pendingActivitiesRef.current.push(activity);
    const sid = sessionId || currentSessionId;
    const agentId = sid ? agentIdBySessionIdRef.current.get(sid) || null : null;
    
    // Debounce - wait 500ms then batch persist
    setTimeout(async () => {
      const batch = pendingActivitiesRef.current.splice(0, pendingActivitiesRef.current.length);
      if (batch.length === 0) return;
      
      try {
        await fetch("/api/activity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            activities: batch.map((a) => ({
              agent: a.agent,
              action: a.action,
              detail: a.detail,
              status: a.status,
              sessionId: sid,
              agentId: agentId || null,
              metadata: {
                summary: a.summary,
                metadata: a.metadata,
                result: a.result,
                logical_activity_id: a.id,
                ...(agentId ? { orchestrator_agent_id: agentId } : {}),
              },
            })),
          }),
        });
      } catch (e) {
        console.warn("[useOrchestrator] Failed to persist activity:", e);
      }
    }, 500);
  }, [currentSessionId]);

  const sendMessage = useCallback(
    async (
      message: string,
      options?: {
        memoryEnabled?: boolean;
        deviceId?: string;
        obsidianVaultPath?: string;
        files?: File[];
        // If true, do NOT persist or render the user message (used for background/team requests).
        suppressUserMessage?: boolean;
        // Extra metadata persisted on BOTH user+assistant orchestrator_messages (not sent to LLM).
        messageMetadata?: Record<string, unknown>;
        // If set and the message targets @chat/@ai, route through the AI Chat agent API.
        chatAgentId?: string;
        chatAgentName?: string;
        // Explicit AI Chat session control (per AI Chat agent)
        chatSessionId?: string;
        // Handshake context (agent-to-agent communication)
        handshakeId?: string;
        handshakePartnerSessionId?: string;
        handshakePartnerName?: string;
        handshakeSelfName?: string;
        // If true, load memory context but skip auto-writing new memory notes.
        suppressMemoryStore?: boolean;
        // If true, skip loading preference-memory block for this turn.
        suppressPreferenceMemory?: boolean;
        // Internal: force a specific orchestrator session for this send call.
        sessionIdOverride?: string;
        // Internal (multi-agent): explicit history source to avoid cross-session races.
        historyOverride?: Array<{
          role: "user" | "assistant";
          content: string;
          metadata?: OrchestratorMessage["metadata"];
        }>;
      }
    ) => {
      const selectedFiles = Array.isArray(options?.files) ? options!.files! : [];
      const inlineImageFiles = selectedFiles.filter(isVisionImageFile);
      const filesAgentUploads = selectedFiles.filter((file) => !isVisionImageFile(file));
      const trimmed = (message || "").trim();
      if ((!trimmed && selectedFiles.length === 0) || isStreaming) {
        return { ok: false, error: "No message to send (or busy streaming)" };
      }
      const effectiveMessage =
        trimmed || (selectedFiles.length > 0 ? "Please analyze the attached file(s)." : "");

      // Stable id for one user turn across server rounds and mobile sleep/wake.
      const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const extraMetadata =
        options?.messageMetadata && typeof options.messageMetadata === "object"
          ? {
              ...(options.messageMetadata as Record<string, unknown>),
              client_turn_id: turnId,
            }
          : { client_turn_id: turnId };
      const mergeMetadata = (base?: Record<string, unknown>) =>
        extraMetadata ? { ...(base || {}), ...extraMetadata } : base;

      // Create session if none exists
      const overrideSessionId =
        typeof options?.sessionIdOverride === "string" && options.sessionIdOverride.trim()
          ? options.sessionIdOverride.trim()
          : null;
      let sessionId = overrideSessionId || currentSessionId;
      if (!sessionId) {
        const firstWords = effectiveMessage.split(" ").slice(0, 5).join(" ");
        sessionId = await createSession(firstWords + (effectiveMessage.length > 30 ? "..." : ""));
        if (!sessionId) {
          setError("Failed to create chat session");
          return { ok: false, error: "Failed to create chat session" };
        }
      }

      setError(null);
      isStreamingRef.current = true;
      setIsStreaming(true);
      setStreamingContent("");
      setCurrentToolCalls([]);
      setPreparingMemoryContext(false);

      const memoryEnabledForTurn = options?.memoryEnabled ?? true;
      let contextPrepActivity: AgentActivity | null = null;
      const ensureContextPrepActivity = () => {
        if (!memoryEnabledForTurn) return;
        if (contextPrepActivity) return;
        contextPrepActivity = {
          id: `context-prep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          agent: "system",
          action: "Grabbing your memory and building your context",
          detail: "Loading memory and preferences",
          status: "running",
          timestamp: new Date(),
          sessionId: sessionId ?? undefined,
        };
        setPreparingMemoryContext(true);
        setAgentActivities((prev) => [...prev, contextPrepActivity!]);
        persistActivity(contextPrepActivity, sessionId);
      };
      const finalizeContextPrepActivity = (
        status: AgentActivity["status"],
        detail?: string
      ) => {
        setPreparingMemoryContext(false);
        if (!contextPrepActivity) return;
        if (contextPrepActivity.status !== "running") return;
        contextPrepActivity = {
          ...contextPrepActivity,
          status,
          detail: detail ?? contextPrepActivity.detail,
        };
        const snapshot = contextPrepActivity;
        setAgentActivities((prev) =>
          prev.map((a) => (a.id === snapshot.id ? snapshot : a))
        );
        persistActivity(snapshot, sessionId);
      };

      // Add "message sent" activity
      const msgActivity: AgentActivity = {
        id: `msg-${Date.now()}`,
        agent: "data" as AgentType,
        action: "Message sent",
        detail:
          effectiveMessage.length > 50
            ? effectiveMessage.slice(0, 50) + "..."
            : effectiveMessage,
        status: "complete",
        timestamp: new Date(),
        sessionId: sessionId ?? undefined,
      };
      setAgentActivities((prev) => [...prev, msgActivity]);
      persistActivity(msgActivity, sessionId);

      // If the user explicitly @mentions an agent, reflect that immediately in the UI
      // so the corresponding tile "glows" even before a tool call happens.
      const mentioned = parseMentionedAgents(effectiveMessage);
      if (mentioned.length > 0) {
        for (const agent of mentioned) {
          const routing: AgentActivity = {
            id: `route-${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            agent,
            action: "Routed",
            detail: `@${agent}`,
            status: "running",
            timestamp: new Date(),
            sessionId: sessionId ?? undefined,
          };
          setAgentActivities((prev) => [...prev, routing]);
          persistActivity(routing, sessionId);
        }
      }

      // Add user message
      const userMessage: OrchestratorMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: effectiveMessage,
        timestamp: new Date(),
        metadata: mergeMetadata(
          selectedFiles.length
            ? { files: selectedFiles.map((f) => ({ id: "", name: f.name })) }
            : undefined
        ),
      };
      if (!options?.suppressUserMessage) {
        setMessages((prev) => [...prev, userMessage]);
        // The user turn must reach durable storage before the long-running
        // request begins; otherwise closing a mobile PWA immediately can lose
        // the only recoverable marker for the run.
        await persistMessage(userMessage, sessionId);
      }

      // Build history for LLM context.
      const historySource =
        Array.isArray(options?.historyOverride) && options.historyOverride.length > 0
          ? options.historyOverride
          : messages;
      const historyBase = historySource
        .filter((m) => {
          const metadata =
            m.metadata && typeof m.metadata === "object"
              ? (m.metadata as Record<string, unknown>)
              : null;
          const handshake =
            metadata &&
            metadata.handshake &&
            typeof metadata.handshake === "object"
              ? (metadata.handshake as Record<string, unknown>)
              : null;
          return !(handshake && handshake.uiOnly === true);
        })
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: buildLlmHistoryContent(m.content, m.metadata),
        }));
      // IMPORTANT: include the new user message so continuation rounds (message="") can route correctly.
      let llmHistory = [
        ...historyBase,
        {
          role: "user" as const,
          content: buildLlmHistoryContent(effectiveMessage, userMessage.metadata),
        },
      ];
      let firstRoundMessage = effectiveMessage;
      let inboxCommandReplyPrefix = "";

      abortRef.current = new AbortController();
      const runId = activeRunIdRef.current + 1;
      activeRunIdRef.current = runId;
      const activeTurn = {
        sessionId,
        turnId,
        startedAt: Date.now(),
      };
      activeTurnRef.current = activeTurn;
      try {
        sessionStorage.setItem(
          ORCHESTRATOR_INFLIGHT_STORAGE_KEY,
          JSON.stringify(activeTurn)
        );
      } catch {
        // Private browsing/storage quota: in-memory recovery still works.
      }
      let turnCompleted = false;
      const isRunActive = () =>
        activeRunIdRef.current === runId && !(abortRef.current?.signal.aborted ?? false);
      const throwIfRunCancelled = () => {
        if (isRunActive()) return;
        const abortError = new Error("aborted");
        abortError.name = "AbortError";
        throw abortError;
      };

      try {
        throwIfRunCancelled();
        if (inlineImageFiles.length > MAX_INLINE_IMAGE_FILES) {
          throw new Error(`Attach up to ${MAX_INLINE_IMAGE_FILES} images at a time.`);
        }
        const preparedInlineFiles: PreparedInlineOrchestratorFile[] =
          inlineImageFiles.length > 0
            ? await Promise.all(inlineImageFiles.map(prepareVisionImageFile))
            : [];
        const inlineImageBytes = preparedInlineFiles.reduce((sum, file) => sum + file.byteSize, 0);
        if (inlineImageBytes > MAX_INLINE_IMAGE_TOTAL_BYTES) {
          throw new Error("Keep attached images under 2 MB total after compression.");
        }
        const inlineFilesForOrchestrator: InlineOrchestratorFile[] = preparedInlineFiles.map((file) => ({
          mediaType: file.mediaType,
          base64: file.base64,
          filename: file.filename,
        }));

        // Inbox-action fast-path: allow natural phrasing where the command is not
        // necessarily the first token (e.g. "hey, reject 2 and ..."), while still
        // requiring action-specific signals to avoid broad false positives.
        const textForInboxCommandDetection = effectiveMessage;
        const hasShowActionsPhrase = /\b(show|list|pending)\s+actions?\b/i.test(
          textForInboxCommandDetection
        );
        const hasCoreCommandVerb = /\b(approve|reject|edit|why)\b/i.test(textForInboxCommandDetection);
        const hasSendOrDraftWithInboxContext =
          /\b(send|draft)\b/i.test(textForInboxCommandDetection) &&
          /\b(action|actions|inbox|gmail|email)\b/i.test(textForInboxCommandDetection);
        const hasCommandVerb = hasCoreCommandVerb || hasSendOrDraftWithInboxContext;
        const hasAliasNumber = /#?\d+/.test(textForInboxCommandDetection);
        const hasActionScopeHint = /\b(all|unsubscribes?|archives?|spam|drafts?)\b/i.test(
          textForInboxCommandDetection
        );
        const looksLikeInboxActionCommand =
          hasShowActionsPhrase || (hasCommandVerb && (hasAliasNumber || hasActionScopeHint));
        if (looksLikeInboxActionCommand && selectedFiles.length === 0) {
          const agentId = agentIdBySessionIdRef.current.get(sessionId) || null;
          const cmdRes = await fetch("/api/inbox-actions/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId,
              agentId,
              command: effectiveMessage,
            }),
            signal: abortRef.current?.signal,
          });
          const cmdJson = await cmdRes.json().catch(() => ({}));
          if (cmdRes.ok && cmdJson?.handled === true && typeof cmdJson?.reply === "string") {
            let finalReply = String(cmdJson.reply || "");
            const connectorExecutes = Array.isArray(cmdJson?.connectorExecutes)
              ? (cmdJson.connectorExecutes as Array<Record<string, unknown>>)
              : [];
            if (cmdJson?.kind === "needs_connector" && connectorExecutes.length > 0) {
              const connectorOutcomeLines: string[] = [];
              if (!onConnectorExecute) {
                connectorOutcomeLines.push(
                  "Connector offline: skipped local unsubscribe execution."
                );
              } else {
                for (let i = 0; i < connectorExecutes.length; i++) {
                  throwIfRunCancelled();
                  const ex = connectorExecutes[i] || {};
                  const connectorType = String(ex.connectorType || "").trim();
                  const connectorParams =
                    ex.connectorParams && typeof ex.connectorParams === "object"
                      ? (ex.connectorParams as Record<string, unknown>)
                      : {};
                  const toolCallId = String(
                    ex.toolCallId || `inbox-unsub-${Date.now()}-${i}`
                  );
                  const toolName = String(ex.toolName || "inbox_unsubscribe_execute");
                  const agent = (String(ex.agent || "files") as AgentType) || "files";
                  const subject = typeof connectorParams.subject === "string"
                    ? connectorParams.subject
                    : "";
                  if (!connectorType) {
                    connectorOutcomeLines.push(
                      `- ${subject || `#${i + 1}`}: missing connector type`
                    );
                    continue;
                  }
                  try {
                    const result = await onConnectorExecute({
                      type: connectorType,
                      params: connectorParams,
                      toolCallId,
                      toolName,
                      agent,
                    });
                    throwIfRunCancelled();
                    if (result?.ok) {
                      const detail = typeof result.detail === "string" ? result.detail : "done";
                      connectorOutcomeLines.push(
                        `- ${subject || `#${i + 1}`}: ${detail}`
                      );
                    } else {
                      const errorText =
                        typeof result?.error === "string" && result.error.trim()
                          ? result.error.trim()
                          : "failed";
                      connectorOutcomeLines.push(
                        `- ${subject || `#${i + 1}`}: failed (${errorText})`
                      );
                    }
                  } catch (e) {
                    const errorText =
                      e instanceof Error && e.message ? e.message : String(e || "failed");
                    connectorOutcomeLines.push(
                      `- ${subject || `#${i + 1}`}: failed (${errorText})`
                    );
                  }
                }
              }
              if (connectorOutcomeLines.length > 0) {
                finalReply = `${finalReply}\n\nLocal unsubscribe results:\n${connectorOutcomeLines.join("\n")}`;
              }
            }
            const followupText =
              typeof cmdJson?.followupText === "string" ? cmdJson.followupText.trim() : "";
            if (followupText) {
              inboxCommandReplyPrefix = finalReply;
              firstRoundMessage = followupText;
              llmHistory = [
                ...historyBase,
                {
                  role: "user" as const,
                  content: buildLlmHistoryContent(followupText, userMessage.metadata),
                },
              ];
            } else {
              const assistantMessage: OrchestratorMessage = {
                id: `assistant-${Date.now()}`,
                role: "assistant",
                content: finalReply,
                timestamp: new Date(),
                metadata: mergeMetadata({
                  inbox_action_command: true,
                }),
              };
              setMessages((prev) => [...prev, assistantMessage]);
              persistMessage(assistantMessage, sessionId);

              const messageCountDelta = options?.suppressUserMessage ? 1 : 2;
              setSessions((prev) =>
                prev.map((s) =>
                  s.id === sessionId
                    ? {
                        ...s,
                        updatedAt: new Date().toISOString(),
                        messageCount: (s.messageCount || 0) + messageCountDelta,
                      }
                    : s
                )
              );
              return { ok: true as const };
            }
          }
        }

        // Deterministic fast-path: "@files sessions" should list real Files-agent sessions,
        // not rely on the LLM (which can confuse this with Code sessions).
        if (isFilesSessionsQuestion(effectiveMessage)) {
          // Ensure a linked files session exists (also gives us the files agentId)
          const ensureFilesLink = async () => {
            const res = await fetch(
              `/api/orchestrator/agent-sessions?orchestratorSessionId=${encodeURIComponent(
                sessionId!
              )}&agentType=files`
            );
            const json = await res.json().catch(() => ({}));
            if (res.ok && json.session) return json.session as { agentId: string; agentSessionId: string };

            const res2 = await fetch("/api/orchestrator/agent-sessions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ orchestratorSessionId: sessionId, agentType: "files" }),
            });
            const json2 = await res2.json().catch(() => ({}));
            if (!res2.ok) throw new Error(json2?.error || "Failed to create files session mapping");
            return json2.session as { agentId: string; agentSessionId: string };
          };

          await ensureFilesLink();
          const listRes = await fetch(
            `/api/orchestrator/agent-sessions/list?agentType=files`
          );
          const listJson = await listRes.json().catch(() => ({}));
          if (!listRes.ok) throw new Error(listJson?.error || "Failed to load Files sessions");
          const sessions = Array.isArray(listJson.sessions) ? listJson.sessions : [];

          const lines: string[] = [];
          lines.push(`Here are your **Files sessions** (${sessions.length}):`);
          if (sessions.length === 0) {
            lines.push(`- (none yet)`);
          } else {
            for (const s of sessions.slice(0, 20)) {
              const title = typeof s.title === "string" && s.title.trim() ? s.title.trim() : "Untitled";
              const isCurrent = String(s.orchestratorSessionId || "") === String(sessionId);
              lines.push(`- ${isCurrent ? "**" : ""}${title}${isCurrent ? "** (current)" : ""}`);
            }
            if (sessions.length > 20) lines.push(`- …and ${sessions.length - 20} more`);
          }
          lines.push(`\nTell me which one to open, or upload a file to start a new one.`);

          const assistantMessage: OrchestratorMessage = {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: lines.join("\n"),
            timestamp: new Date(),
            metadata: mergeMetadata({
              files_sessions: sessions.map(
                (s: {
                  agentSessionId?: string;
                  title?: string;
                  updatedAt?: string;
                  orchestratorSessionId?: string;
                }) => ({
                  id: String(s.agentSessionId || ""),
                  title: String(s.title || ""),
                  updatedAt: String((s.updatedAt || "") as string),
                  orchestratorSessionId: String(s.orchestratorSessionId || ""),
                })
              ),
            }),
          };
          setMessages((prev) => [...prev, assistantMessage]);
          persistMessage(assistantMessage, sessionId);

          // complete routing glow
          setAgentActivities((prev) =>
            prev.map((a) =>
              a.action === "Routed" && a.status === "running" ? { ...a, status: "complete" } : a
            )
          );
          isStreamingRef.current = false;
          setIsStreaming(false);
          setStreamingContent("");
          abortRef.current = null;
          return { ok: true };
        }

        // If the user attached files, upload them to the linked Files-agent session first,
        // then continue through the NORMAL orchestrator loop below.
        // This preserves file context for files_agent_request without forcing a files-only final answer.
        if (filesAgentUploads.length > 0) {
          const filesActivityId = `files-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const filesActivity: AgentActivity = {
            id: filesActivityId,
            agent: "files",
            action: "Preparing files",
            detail: `Uploading ${filesAgentUploads.length} file${filesAgentUploads.length > 1 ? "s" : ""}`,
            status: "running",
            timestamp: new Date(),
            sessionId: sessionId ?? undefined,
          };
          setAgentActivities((prev) => [...prev, filesActivity]);
          persistActivity(filesActivity, sessionId);

          try {
            const ensureFilesLink = async () => {
              const res = await fetch(
                `/api/orchestrator/agent-sessions?orchestratorSessionId=${encodeURIComponent(
                  sessionId!
                )}&agentType=files`
              );
              const json = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(json?.error || "Failed to load files session mapping");
              if (json.session) return json.session as { agentId: string; agentSessionId: string };

              const res2 = await fetch("/api/orchestrator/agent-sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orchestratorSessionId: sessionId, agentType: "files" }),
              });
              const json2 = await res2.json().catch(() => ({}));
              if (!res2.ok) throw new Error(json2?.error || "Failed to create files session mapping");
              return json2.session as { agentId: string; agentSessionId: string };
            };

            const { agentId: filesAgentId, agentSessionId: filesSessionId } =
              await ensureFilesLink();

            // Upload selected files (persisted in Supabase + best-effort Anthropic upload).
            // We then seed Files-session chat_messages metadata with these uploads so
            // files_agent_request can attach container_upload blocks in subsequent orchestrator tool calls.
            const uploaded: Array<{ id: string; name: string; anthropicFileId?: string | null }> = [];
            for (const f of filesAgentUploads) {
              const form = new FormData();
              form.set("sessionId", filesSessionId);
              form.set("agentId", filesAgentId);
              form.set("file", f);
              const ures = await fetch("/api/files-agent/upload", {
                method: "POST",
                body: form,
                signal: abortRef.current?.signal,
              });
              const ujson = await ures.json().catch(() => ({}));
              if (!ures.ok) throw new Error(ujson?.error || "File upload failed");
              uploaded.push({
                id: String(ujson.attachmentId || ""),
                // Prefer server-returned fileName, fallback to original File object name
                name: String(ujson.fileName || f.name || "upload"),
                anthropicFileId: ujson.anthropicFileId || null,
              });
            }

            const seedRes = await fetch("/api/chat/messages", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sessionId: filesSessionId,
                role: "user",
                content: effectiveMessage,
                metadata: {
                  files: uploaded.map((f) => ({
                    id: f.id,
                    name: f.name,
                    anthropicFileId: f.anthropicFileId || null,
                  })),
                },
              }),
              signal: abortRef.current?.signal,
            });
            if (!seedRes.ok) {
              const seedText = await seedRes.text().catch(() => "");
              throw new Error(seedText || `Failed to seed Files session context (${seedRes.status})`);
            }

            const completedFilesActivity: AgentActivity = {
              ...filesActivity,
              status: "complete",
              detail: `Prepared ${uploaded.length} file${uploaded.length > 1 ? "s" : ""} for orchestration`,
            };
            setAgentActivities((prev) =>
              prev.map((a) => (a.id === filesActivityId ? completedFilesActivity : a))
            );
            persistActivity(completedFilesActivity, sessionId);
          } catch (filesErr) {
            const errMsg = filesErr instanceof Error ? filesErr.message : String(filesErr);
            const failedFilesActivity: AgentActivity = {
              ...filesActivity,
              status: "error",
              error: errMsg,
            };
            setAgentActivities((prev) =>
              prev.map((a) => (a.id === filesActivityId ? failedFilesActivity : a))
            );
            persistActivity(failedFilesActivity, sessionId);
            setError(errMsg);
            isStreamingRef.current = false;
            setIsStreaming(false);
            setStreamingContent("");
            abortRef.current = null;
            return { ok: false as const, error: errMsg };
          }
        }

        // If the user targets AI Chat, route to /api/chat with the selected AI Chat agent.
        const wantsChat =
          (/(^|\s)@chat(?=$|\s|[:(])/i.test(effectiveMessage) ||
            /(^|\s)@ai(?=$|\s|[:(])/i.test(effectiveMessage)) &&
          typeof options?.chatAgentId === "string" &&
          options.chatAgentId.length > 0;

        if (wantsChat) {
          const chatAgentId = options!.chatAgentId!;
          const chatAgentName = options?.chatAgentName;
          const explicitChatSessionId =
            typeof options?.chatSessionId === "string" && options.chatSessionId.length
              ? options.chatSessionId
              : null;

          const chatActivityId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const chatActivity: AgentActivity = {
            id: chatActivityId,
            agent: "chat",
            action: "AI Chat",
            detail: chatAgentName ? `Using ${chatAgentName}` : `agent=${chatAgentId}`,
            status: "running",
            timestamp: new Date(),
            sessionId: sessionId ?? undefined,
            metadata: {
              title: "AI Chat",
              subtitle: chatAgentName || undefined,
              provider: "ai-chat",
              target: chatAgentName || chatAgentId,
            },
          };
          setAgentActivities((prev) => [...prev, chatActivity]);
          persistActivity(chatActivity, sessionId);

          // Strip routing tokens from message before sending to the LLM
          const cleanChatMessage = String(effectiveMessage)
            .replace(/(^|\s)@(chat|ai)(?:\([^)]*\)|:[^\s]+)?(?=\s|$)/gi, " ")
            .replace(/(^|\s)@session(?:\([^)]*\)|:[^\s]+)?(?=\s|$)/gi, " ")
            .trim();

          const lastSessionStorageKey = `groovy:ai-chat:lastSession:${chatAgentId}`;
          const ensureChatSession = async (): Promise<string> => {
            if (explicitChatSessionId) {
              try {
                if (typeof window !== "undefined") {
                  window.localStorage.setItem(lastSessionStorageKey, explicitChatSessionId);
                }
              } catch {
                // ignore
              }
              return explicitChatSessionId;
            }
            try {
              const stored =
                typeof window !== "undefined" ? window.localStorage.getItem(lastSessionStorageKey) : null;
              if (stored) return stored;
            } catch {
              // ignore
            }

            // If no stored session, try to load existing sessions; otherwise create.
            const listRes = await fetch(`/api/chat/sessions?agentId=${encodeURIComponent(chatAgentId)}`, {
              signal: abortRef.current?.signal,
            });
            const listJson = await listRes.json().catch(() => ({}));
            const sessions = Array.isArray(listJson.sessions) ? listJson.sessions : [];
            const first = sessions[0]?.id ? String(sessions[0].id) : null;
            if (first) {
              try {
                window.localStorage.setItem(lastSessionStorageKey, first);
              } catch {
                // ignore
              }
              return first;
            }

            const createRes = await fetch("/api/chat/sessions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                agentId: chatAgentId,
                title: cleanChatMessage.split(" ").slice(0, 5).join(" ") || "New chat",
              }),
              signal: abortRef.current?.signal,
            });
            const createJson = await createRes.json().catch(() => ({}));
            if (!createRes.ok) throw new Error(createJson?.error || "Failed to create chat session");
            const createdId = String(createJson?.session?.id || "");
            if (!createdId) throw new Error("Failed to create chat session");
            try {
              window.localStorage.setItem(lastSessionStorageKey, createdId);
            } catch {
              // ignore
            }
            return createdId;
          };

          try {
            const chatSessionId = await ensureChatSession();

            // Load history
            const histRes = await fetch(
              `/api/chat/messages?sessionId=${encodeURIComponent(chatSessionId)}`,
              { signal: abortRef.current?.signal }
            );
            const histJson = await histRes.json().catch(() => ({}));
            if (!histRes.ok) throw new Error(histJson?.error || "Failed to load chat history");
            const prior = Array.isArray(histJson.messages) ? histJson.messages : [];
            const history = prior
              .filter((m: { role?: string; content?: string }) => m.role === "user" || m.role === "assistant")
              .map((m: { role: "user" | "assistant"; content: string }) => ({
                role: m.role,
                content: m.content,
              }));

            const res = await fetch("/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                agentId: chatAgentId,
                sessionId: chatSessionId,
                messages: [...history, { role: "user", content: cleanChatMessage }],
              }),
              signal: abortRef.current?.signal,
            });

            if (!res.ok) {
              const errJson = await res.json().catch(() => ({}));
              throw new Error(errJson?.error || `HTTP ${res.status}`);
            }

            const contentType = res.headers.get("content-type") || "";
            let final = "";
            let generatedFiles: Array<{ mediaType: string; base64: string }> = [];

            if (contentType.includes("application/json")) {
              const json = await res.json().catch(() => ({}));
              final = typeof json?.text === "string" ? json.text : "";
              // Image models return { text, files } where files has base64 images
              if (Array.isArray(json?.files) && json.files.length > 0) {
                generatedFiles = json.files;
                // If no text but files exist, create a summary
                if (!final.trim()) {
                  final = `🎨 Generated ${json.files.length} image${json.files.length > 1 ? "s" : ""}. View in AI Chat panel.`;
                }
              }
              setStreamingContent(final);
            } else {
              const reader = res.body?.getReader();
              if (!reader) throw new Error("No response body");
              const decoder = new TextDecoder();
              let acc = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                acc += decoder.decode(value, { stream: true });
                setStreamingContent(acc);
              }
              final = acc;
            }

            // Some models/tools can complete with an empty stream, even though messages were persisted.
            // If that happens (and we didn't get generated files), fetch the last assistant message.
            if (!final.trim() && generatedFiles.length === 0) {
              try {
                const mres = await fetch(
                  `/api/chat/messages?sessionId=${encodeURIComponent(chatSessionId)}`,
                  { signal: abortRef.current?.signal }
                );
                const mjson = await mres.json().catch(() => ({}));
                const msgs = Array.isArray(mjson.messages) ? mjson.messages : [];
                const lastAssistant = [...msgs].reverse().find((m: { role?: string; content?: string }) => m?.role === "assistant");
                if (lastAssistant && typeof lastAssistant.content === "string") {
                  final = lastAssistant.content;
                }
              } catch {
                // ignore
              }
            }

            const assistantMessage: OrchestratorMessage = {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: final || "[AI Chat completed]",
              timestamp: new Date(),
              metadata: mergeMetadata(
                generatedFiles.length > 0 ? { generated_images: generatedFiles } : undefined
              ),
            };
            setMessages((prev) => [...prev, assistantMessage]);
            persistMessage(assistantMessage, sessionId);

            // Update activity with completion info
            setAgentActivities((prev) => {
              const updated = prev.map((a) => (a.id === chatActivityId ? { ...a, status: "complete" as const } : a));
              console.log("[AI Chat] Activity marked complete:", chatActivityId);
              return updated;
            });
          } catch (chatErr) {
            const errMsg = chatErr instanceof Error ? chatErr.message : String(chatErr);
            console.error("[AI Chat] Error:", errMsg);
            setAgentActivities((prev) =>
              prev.map((a) => (a.id === chatActivityId ? { ...a, status: "error" as const, error: errMsg } : a))
            );
            setError(errMsg);
            return { ok: false as const, error: errMsg };
          } finally {
            // Always ensure streaming is stopped and activity is marked done
            isStreamingRef.current = false;
            setIsStreaming(false);
            setStreamingContent("");
            abortRef.current = null;
            // Force a final status check - if activity is still running, mark it complete
            setAgentActivities((prev) => {
              const activity = prev.find((a) => a.id === chatActivityId);
              if (activity && activity.status === "running") {
                console.log("[AI Chat] Force-completing stuck activity:", chatActivityId);
                return prev.map((a) => (a.id === chatActivityId ? { ...a, status: "complete" as const } : a));
              }
              return prev;
            });
          }
          return { ok: true as const };
        }

        // IMPORTANT: For connector-backed tools, the model may emit "pre-tool" text
        // before requesting a tool call. We must NOT treat that as the final answer.
        // We keep only the text from the final round (the round after tool results are fed back).
        let finalText = "";
          let roundText = "";
          let toolStreamText = "";
          let pendingGeneratedFiles: Array<{
            name: string;
            mediaType: string;
            url?: string;
            storage_path?: string;
            file_id?: string;
            filename?: string;
            mime_type?: string;
          }> = [];
        let traceId: string | null = null;
        const sessionToolCalls: ToolCall[] = [];
        const sessionActivities: AgentActivity[] = [];
        let didOpenCodeSession = false;

        const TOOL_RESULT_MAX_CHARS = 8000;
        const TOOL_RESULT_SERVER_MAX_CHARS = 120_000;
        const OBSIDIAN_LIST_MAX_NOTES_FOR_SERVER = 400;
        const OBSIDIAN_LIST_MAX_FOLDERS_FOR_SERVER = 250;
        const OBSIDIAN_SEARCH_MAX_RESULTS_FOR_SERVER = 120;

        const compactToolResultForServer = (
          toolName: string,
          rawResult: string
        ): string => {
          if (typeof rawResult !== "string") return "";

          const tryParse = (value: string): unknown | null => {
            try {
              return JSON.parse(value) as unknown;
            } catch {
              return null;
            }
          };

          const parsed = tryParse(rawResult);

          if (toolName === "obsidian_list" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const source = parsed as Record<string, unknown>;
            const notesRaw = Array.isArray(source.notes) ? source.notes : [];
            const foldersRaw = Array.isArray(source.folders) ? source.folders : [];
            const notes = notesRaw
              .map((entry) => {
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
                const note = entry as Record<string, unknown>;
                const path = typeof note.path === "string" ? note.path : "";
                const name = typeof note.name === "string" ? note.name : "";
                if (!path && !name) return null;
                return {
                  name,
                  path,
                  modified: typeof note.modified === "string" ? note.modified : undefined,
                  size:
                    typeof note.size === "number" && Number.isFinite(note.size)
                      ? note.size
                      : undefined,
                };
              })
              .filter(Boolean)
              .slice(0, OBSIDIAN_LIST_MAX_NOTES_FOR_SERVER);
            const folders = foldersRaw
              .map((entry) => {
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
                const folder = entry as Record<string, unknown>;
                const path = typeof folder.path === "string" ? folder.path : "";
                const name = typeof folder.name === "string" ? folder.name : "";
                if (!path && !name) return null;
                return { name, path };
              })
              .filter(Boolean)
              .slice(0, OBSIDIAN_LIST_MAX_FOLDERS_FOR_SERVER);

            const compact = {
              ok: source.ok !== false,
              vaultPath:
                typeof source.vaultPath === "string"
                  ? source.vaultPath
                  : typeof source.vault_path === "string"
                    ? source.vault_path
                    : undefined,
              notes,
              folders,
              noteCount:
                typeof source.noteCount === "number"
                  ? source.noteCount
                  : typeof source.note_count === "number"
                    ? source.note_count
                    : notesRaw.length,
              folderCount:
                typeof source.folderCount === "number"
                  ? source.folderCount
                  : typeof source.folder_count === "number"
                    ? source.folder_count
                    : foldersRaw.length,
              truncated:
                notesRaw.length > OBSIDIAN_LIST_MAX_NOTES_FOR_SERVER ||
                foldersRaw.length > OBSIDIAN_LIST_MAX_FOLDERS_FOR_SERVER,
            };
            const serialized = JSON.stringify(compact);
            if (serialized.length <= TOOL_RESULT_SERVER_MAX_CHARS) return serialized;
          }

          if (toolName === "obsidian_search" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const source = parsed as Record<string, unknown>;
            const resultsRaw = Array.isArray(source.results) ? source.results : [];
            const compactResults = resultsRaw
              .map((entry) => {
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
                const row = entry as Record<string, unknown>;
                const path = typeof row.path === "string" ? row.path : "";
                const title = typeof row.title === "string" ? row.title : "";
                if (!path && !title) return null;
                const matches = Array.isArray(row.matches) ? row.matches.slice(0, 8) : [];
                return {
                  path,
                  title,
                  score:
                    typeof row.score === "number" && Number.isFinite(row.score)
                      ? row.score
                      : undefined,
                  tags: Array.isArray(row.tags) ? row.tags.slice(0, 12) : [],
                  matches,
                  excerpt:
                    typeof row.excerpt === "string"
                      ? row.excerpt.slice(0, 400)
                      : undefined,
                };
              })
              .filter(Boolean)
              .slice(0, OBSIDIAN_SEARCH_MAX_RESULTS_FOR_SERVER);

            const compact = {
              ok: source.ok !== false,
              query: typeof source.query === "string" ? source.query : undefined,
              vaultPath:
                typeof source.vaultPath === "string"
                  ? source.vaultPath
                  : typeof source.vault_path === "string"
                    ? source.vault_path
                    : undefined,
              results: compactResults,
              count:
                typeof source.count === "number"
                  ? source.count
                  : resultsRaw.length,
              truncated:
                resultsRaw.length > OBSIDIAN_SEARCH_MAX_RESULTS_FOR_SERVER ||
                source.truncated === true,
            };
            const serialized = JSON.stringify(compact);
            if (serialized.length <= TOOL_RESULT_SERVER_MAX_CHARS) return serialized;
          }

          if (rawResult.length <= TOOL_RESULT_SERVER_MAX_CHARS) {
            return rawResult;
          }

          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const source = parsed as Record<string, unknown>;
            const compact: Record<string, unknown> = { ...source, transport_truncated: true };
            const largeArrayKeys = ["results", "rows", "files", "items", "matches", "diffs", "notes"];
            for (const key of largeArrayKeys) {
              const value = compact[key];
              if (Array.isArray(value) && value.length > 200) {
                compact[`${key}_total`] = value.length;
                compact[key] = value.slice(0, 200);
              }
            }
            const largeStringKeys = ["stdout", "stderr", "content", "result", "raw_output", "body", "tail", "delta"];
            for (const key of largeStringKeys) {
              const value = compact[key];
              if (typeof value === "string" && value.length > 20_000) {
                compact[key] = `${value.slice(0, 20_000)}\n...[truncated]`;
              }
            }
            const serialized = JSON.stringify(compact);
            if (serialized.length <= TOOL_RESULT_SERVER_MAX_CHARS) {
              return serialized;
            }
          }

          return `${rawResult.slice(0, TOOL_RESULT_SERVER_MAX_CHARS)}\n...[truncated]`;
        };
        const toolResultsToHistoryMessage = (
          toolResults: Array<{ toolCallId: string; toolName: string; result: string }>
        ) => {
          const safe = (toolResults || []).filter(
            (tr) =>
              typeof tr?.toolCallId === "string" &&
              typeof tr?.toolName === "string" &&
              typeof tr?.result === "string"
          );
          if (safe.length === 0) return null;

          const resultsText = safe
            .map((tr) => {
              try {
                const parsed = JSON.parse(tr.result);
                let text = JSON.stringify(parsed, null, 2);
                if (text.length > TOOL_RESULT_MAX_CHARS) {
                  text = text.slice(0, TOOL_RESULT_MAX_CHARS) + "\n...[truncated]";
                }
                return `<tool_result name="${tr.toolName}" tool_call_id="${tr.toolCallId}">\n${text}\n</tool_result>`;
              } catch {
                let text = tr.result;
                if (text.length > TOOL_RESULT_MAX_CHARS) {
                  text = text.slice(0, TOOL_RESULT_MAX_CHARS) + "\n...[truncated]";
                }
                return `<tool_result name="${tr.toolName}" tool_call_id="${tr.toolCallId}">\n${text}\n</tool_result>`;
              }
            })
            .join("\n\n");

          return {
            role: "user" as const,
            content:
              `[SYSTEM: Tool execution results from your previous request]\n\n${resultsText}\n\n` +
              `IMPORTANT: These are the results from the tools you requested. ` +
              `Do NOT call the same tool again unless the result indicates an error that can be retried. ` +
              `Process these results and either:\n` +
              `1. Provide the final answer to the user if you have enough information, OR\n` +
              `2. Call a DIFFERENT tool if you need additional information to complete the task.`,
          };
        };

        const runOrchestratorRound = async (params: {
          message: string;
          history: Array<{ role: "user" | "assistant"; content: string }>;
          toolResults?: Array<{ toolCallId: string; toolName: string; result: string }>;
        }): Promise<{
          connectorToolResults: Array<{ toolCallId: string; toolName: string; result: string }>;
          serverSideToolResults: Array<{ toolCallId: string; toolName: string; result: string }>;
          roundText: string;
          hitStepBudget: boolean;
          needsClientContinuation: boolean;
        }> => {
          ensureContextPrepActivity();
          const agentId = agentIdBySessionIdRef.current.get(sessionId) || null;
          const response = await fetch("/api/orchestrator", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              turnId,
              message: params.message,
              history: params.history,
              sessionId,
              agentId,
              profileId: getActiveProfileId() || undefined,
              memoryEnabled: options?.memoryEnabled ?? true,
              suppressMemoryStore: options?.suppressMemoryStore === true ? true : undefined,
              suppressPreferenceMemory:
                options?.suppressPreferenceMemory === true ? true : undefined,
              messageMetadata:
                extraMetadata,
              deviceId: options?.deviceId,
              obsidianVaultPath: options?.obsidianVaultPath,
              toolResults: params.toolResults,
              files: inlineFilesForOrchestrator.length > 0 ? inlineFilesForOrchestrator : undefined,
              ...(options?.handshakeId ? {
                handshakeId: options.handshakeId,
                handshakePartnerSessionId: options.handshakePartnerSessionId,
                handshakePartnerName: options.handshakePartnerName,
                handshakeSelfName: options.handshakeSelfName,
              } : {}),
            }),
            signal: abortRef.current?.signal,
          });

          if (!response.ok) {
            finalizeContextPrepActivity(
              "error",
              "Could not load memory/context for this request"
            );
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
          }

          // First successful orchestrator response means memory/context prep is done.
          finalizeContextPrepActivity("complete", "Context ready");

          // Parse headers
          const responseTraceId = response.headers.get("X-Orchestrator-Trace-Id");
          if (responseTraceId) traceId = responseTraceId;
          const activeAgentsHeader = response.headers.get("X-Orchestrator-Active-Agents");

          if (activeAgentsHeader) {
            setActiveAgents(activeAgentsHeader.split(",").filter(Boolean) as AgentType[]);
          }

          // Stream SSE response
          const reader = response.body?.getReader();
          if (!reader) throw new Error("No response body");

          const decoder = new TextDecoder();
          let buffer = "";
          const connectorPromises: Promise<void>[] = [];
          let hasBlockingConnectorCallInRound = false;
          const connectorToolResults: Array<{ toolCallId: string; toolName: string; result: string }> = [];
          // Also track server-side tool results so they can be passed to continuation rounds
          const serverSideToolResults: Array<{ toolCallId: string; toolName: string; result: string }> = [];
          roundText = "";
          let streamError: string | null = null;
          let sawDoneEvent = false;
          let hitStepBudget = false;
          let needsClientContinuation = false;
          const finalizeDoneActivities = () => {
            // Mark all remaining "running" activities as "complete".
            // IMPORTANT: Don't auto-complete protected browser/code tasks that can
            // continue client-side after SSE end.
            const doneCompleted: AgentActivity[] = [];
            setAgentActivities((prev) => {
              const result = prev.map((a) => {
                const isProtected = activeBrowserTaskActivityIdsRef.current.has(a.id);
                if (a.status === "running" && !isProtected) {
                  const updated = { ...a, status: "complete" as AgentActivity["status"] };
                  doneCompleted.push(updated);
                  return updated;
                }
                return a;
              });
              return result;
            });
            // Persist terminal status transitions so DB doesn't keep stale "running" rows.
            for (const a of doneCompleted) {
              persistActivity(a, a.sessionId || sessionId);
            }
            setCurrentToolCalls([]);
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            // Safari/iOS can be flaky with SSE chunk boundaries and final delimiters.
            // Parse line-by-line (each event is a single `data: {json}` line in our server).
            buffer = buffer.replace(/\r\n/g, "\n");
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;

              try {
                const event = JSON.parse(line.slice(6)) as SSEEvent;

                switch (event.type) {
                case "text":
                  roundText += event.text;
                  // During tool rounds we show the most recent round's text, not accumulated.
                  setStreamingContent(roundText);
                  break;
                
                case "activity": {
                  const activity: AgentActivity = {
                    id: `activity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    agent: (event as { agent?: ActivityAgentType }).agent || "data",
                    action: (event as { action?: string }).action || "Activity",
                    detail: (event as { detail?: string }).detail,
                    status: ((event as { status?: string }).status as AgentActivity["status"]) || "complete",
                    timestamp: new Date(),
                    sessionId: sessionId ?? undefined,
                  };
                  sessionActivities.push(activity);
                  setAgentActivities((prev) => [...prev, activity]);
                  persistActivity(activity, sessionId);
                  break;
                }
                
                case "tool-call": {
                  const toolCall: ToolCall = {
                    id: event.toolCallId,
                    toolName: event.toolName,
                    args: event.args,
                    status: "running",
                  };
                  sessionToolCalls.push(toolCall);
                  setCurrentToolCalls([...sessionToolCalls]);

                  // IMPORTANT: browser_task and code_cli_run can keep running client-side after
                  // the orchestrator tool returns. Protect their activities from premature completion.
                  if (event.toolName === "browser_task" || event.toolName === "code_cli_run") {
                    const protectedId = `activity-${event.toolCallId}`;
                    activeBrowserTaskActivityIdsRef.current.add(protectedId);
                    console.log("[useOrchestrator] tool-call: protected", event.toolName, protectedId);
                  }
                  
                  const incoming = (event.metadata || {}) as Partial<ActivityMetadata>;
                  const metadata: ActivityMetadata = {
                    title:
                      typeof incoming.title === "string" && incoming.title.trim()
                        ? incoming.title
                        : formatToolName(event.toolName),
                    subtitle: typeof incoming.subtitle === "string" ? incoming.subtitle : undefined,
                    provider: typeof incoming.provider === "string" ? incoming.provider : undefined,
                    target: typeof incoming.target === "string" ? incoming.target : undefined,
                    query: typeof incoming.query === "string" ? incoming.query : undefined,
                    tags: Array.isArray(incoming.tags) ? incoming.tags : undefined,
                    toolName: event.toolName,
                  };
                  const activity: AgentActivity = {
                    id: `activity-${event.toolCallId}`,
                    agent: event.agent,
                    action: metadata.title,
                    detail: metadata.subtitle || metadata.query,
                    status: "running",
                    timestamp: new Date(),
                    sessionId: sessionId ?? undefined,
                    metadata,
                  };
                  sessionActivities.push(activity);
                  setAgentActivities((prev) => [...prev, activity]);
                  persistActivity(activity, sessionId);
                  
                  setActiveAgents((prev) =>
                    prev.includes(event.agent) ? prev : [...prev, event.agent]
                  );
                  break;
                }
                
                case "clear_tool_stream": {
                  // Data agent started a new iteration — discard intermediate
                  // scaffolding so it doesn't get concatenated with the final response.
                  toolStreamText = "";
                  setStreamingContent("");
                  break;
                }

                case "tool-stream": {
                  toolStreamText += event.text || "";
                  setStreamingContent(toolStreamText);
                  break;
                }

                case "tool-result": {
                  const tcIndex = sessionToolCalls.findIndex((t) => t.id === event.toolCallId);
                  const activityId = `activity-${event.toolCallId}`;
                  // Protected tools (browser_task, code_cli_run) continue running client-side
                  const isProtectedTool =
                    activeBrowserTaskActivityIdsRef.current.has(activityId) ||
                    event.toolName === "browser_task" ||
                    event.toolName === "code_cli_run" ||
                    (tcIndex >= 0 && (sessionToolCalls[tcIndex]?.toolName === "browser_task" || sessionToolCalls[tcIndex]?.toolName === "code_cli_run"));

                  if (tcIndex >= 0) {
                    sessionToolCalls[tcIndex] = {
                      ...sessionToolCalls[tcIndex],
                      result: event.result,
                      // Keep tool status complete, but do NOT complete the activity UI for browser_task.
                      status: "complete",
                    };
                    setCurrentToolCalls([...sessionToolCalls]);
                  }
                  
                  const summary = event.summary;
                  const actIndex = sessionActivities.findIndex(
                    (a) => a.id === activityId
                  );
                  if (actIndex >= 0) {
                    const updatedActivity = {
                      ...sessionActivities[actIndex],
                      status: (isProtectedTool ? "running" : "complete") as AgentActivity["status"],
                      result: event.result,
                      summary,
                    };
                    sessionActivities[actIndex] = updatedActivity;
                    setAgentActivities((prev) =>
                      prev.map((a) =>
                        a.id === activityId ? updatedActivity : a
                      )
                    );
                    persistActivity(updatedActivity, sessionId);
                  }

                  // Remember generated files from Files agent requests so we can attach them
                  // to the final assistant message (avoid duplicate assistant messages mid-stream).
                  if (event.toolName === "files_agent_request" || event.toolName === "data_query") {
                    pendingGeneratedFiles = Array.isArray(event.generatedFiles)
                      ? event.generatedFiles
                      : [];
                  }
                  
                  // Capture server-side tool results for continuation rounds.
                  // When the model calls both server-side tools (data_query) and connector tools
                  // (whatsapp_*) in the same round, we need to pass the server-side results
                  // to subsequent rounds so the model has context.
                  if (event.toolCallId && event.result) {
                    const rawResultForServer =
                      typeof event.result === "string"
                        ? event.result
                        : JSON.stringify(event.result);
                    serverSideToolResults.push({
                      toolCallId: event.toolCallId,
                      toolName: event.toolName,
                      result: compactToolResultForServer(event.toolName, rawResultForServer),
                    });
                    console.log("[useOrchestrator] Captured server-side tool result:", {
                      toolName: event.toolName,
                      toolCallId: event.toolCallId,
                      resultLen:
                        typeof event.result === "string"
                          ? event.result.length
                          : JSON.stringify(event.result).length,
                    });
                  }
                  break;
                }
                
                case "connector-execute": {
                  // Server wants us to execute this via local connector, then we must
                  // feed the result back into /api/orchestrator so the model can continue.
                  const activityId = `activity-${event.toolCallId}`;
                  
                  // Extract query/target from connector params for display
                  const params = event.connectorParams as Record<string, unknown> | undefined;
                  const query = typeof params?.query === "string" ? params.query : undefined;
                  const target = typeof params?.note_path === "string" ? params.note_path : query;
                  
                  // Check if activity already exists (from tool-call event)
                  const existingIdx = sessionActivities.findIndex(a => a.id === activityId);
                  
                  let activity: AgentActivity;
                  if (existingIdx >= 0) {
                    // Update existing activity
                    const prevMeta =
                      (sessionActivities[existingIdx].metadata as Record<string, unknown> | undefined) || {};
                    activity = {
                      ...sessionActivities[existingIdx],
                      action: event.message,
                      status: "running",
                      metadata: {
                        ...prevMeta,
                        title:
                          typeof prevMeta.title === "string" && prevMeta.title.trim()
                            ? prevMeta.title
                            : formatToolName(event.toolName),
                        subtitle: event.message,
                        toolName: event.toolName,
                        query,
                        target,
                      },
                    };
                    sessionActivities[existingIdx] = activity;
                    setAgentActivities((prev) =>
                      prev.map((a) => a.id === activityId ? activity : a)
                    );
                  } else {
                    // Create new activity
                    activity = {
                      id: activityId,
                      agent: event.agent,
                      action: event.message,
                      status: "running",
                      timestamp: new Date(),
                      sessionId: sessionId ?? undefined,
                      metadata: {
                        title: formatToolName(event.toolName),
                        subtitle: event.message,
                        toolName: event.toolName,
                        query,
                        target,
                      },
                    };
                    sessionActivities.push(activity);
                    setAgentActivities((prev) => [...prev, activity]);
                  }
                  
                  setActiveAgents((prev) =>
                    prev.includes(event.agent) ? prev : [...prev, event.agent]
                  );

                  const isBlockingConnectorTool =
                    event.toolName === "code_cli_run" ||
                    event.toolName === "terminal_exec" ||
                    event.toolName === "runtime_branch_parallel";
                  if (isBlockingConnectorTool && hasBlockingConnectorCallInRound) {
                    const err =
                      "Skipped duplicate connector call in the same round; waiting for the first call result.";
                    const skippedActivity: AgentActivity = {
                      ...activity,
                      status: "error",
                      error: err,
                    };
                    setAgentActivities((prev) =>
                      prev.map((a) => (a.id === activity.id ? skippedActivity : a))
                    );
                    persistActivity(skippedActivity, sessionId);
                    connectorToolResults.push({
                      toolCallId: event.toolCallId,
                      toolName: event.toolName,
                      result: compactToolResultForServer(
                        event.toolName,
                        JSON.stringify({
                          ok: false,
                          skipped: true,
                          error: "duplicate_connector_call_same_round",
                        })
                      ),
                    });
                    console.warn("[useOrchestrator] Skipped duplicate blocking connector call", {
                      toolName: event.toolName,
                      toolCallId: event.toolCallId,
                    });
                    break;
                  }
                  if (isBlockingConnectorTool) {
                    hasBlockingConnectorCallInRound = true;
                  }
                  
                  // browser_task_run is now handled by the connector via Playwright MCP.
                  // No client-side interception — it goes through the generic connector
                  // execute path below (relay → connector → claude -p + Playwright).

                  const p = (async () => {
                    if (!isRunActive()) return;
                    if (!onConnectorExecute) {
                      const err = "Connector not connected";
                      if (!isRunActive()) return;
                      setAgentActivities((prev) =>
                        prev.map((a) =>
                          a.id === activity.id ? { ...a, status: "error", error: err } : a
                        )
                      );
                      persistActivity({ ...activity, status: "error", error: err }, sessionId);
                      connectorToolResults.push({
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        result: compactToolResultForServer(
                          event.toolName,
                          JSON.stringify({ ok: false, error: err })
                        ),
                      });
                      return;
                    }

                    try {
                      let result = await onConnectorExecute({
                        type: event.connectorType,
                        params: event.connectorParams,
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        agent: event.agent,
                      });
                      if (!isRunActive()) return;

                      if (event.toolName === "code_cli_run") {
                        const retrySessionId = pickConnectorSessionId(result, event.connectorParams);
                        if (isConnectorTimeoutResult(result) && retrySessionId) {
                          const retryNote =
                            "Claude hit the time limit; continuing from the same session...";
                          console.warn("[useOrchestrator] code_cli_run timed out; retrying with --resume", {
                            toolCallId: event.toolCallId,
                            sessionIdPreview: retrySessionId.slice(0, 8),
                          });
                          activity = {
                            ...activity,
                            status: "running",
                            detail: retryNote,
                            error: undefined,
                            metadata: {
                              title:
                                typeof activity.metadata?.title === "string" && activity.metadata.title.trim()
                                  ? activity.metadata.title
                                  : formatToolName(event.toolName),
                              ...(activity.metadata || {}),
                              subtitle: retryNote,
                            },
                          };
                          setAgentActivities((prev) =>
                            prev.map((a) => (a.id === activity.id ? activity : a))
                          );

                          result = await onConnectorExecute({
                            type: event.connectorType,
                            params: {
                              ...(event.connectorParams || {}),
                              prompt: CODE_CLI_TIMEOUT_CONTINUE_PROMPT,
                              session_id: retrySessionId,
                            },
                            toolCallId: event.toolCallId,
                            toolName: event.toolName,
                            agent: event.agent,
                          });
                          if (!isRunActive()) return;
                          result = withConnectorSessionId(result, retrySessionId);
                        } else {
                          result = withConnectorSessionId(result, retrySessionId);
                        }
                      }

                      // For code_cli_run, keep the activity "running" until the orchestrator 
                      // finishes (done event will mark it complete). This keeps the panel open.
                      const keepRunning = event.toolName === "code_cli_run" && result.ok;
                      
                      const updatedActivity: AgentActivity = {
                        ...activity,
                        detail: undefined,
                        status: keepRunning ? "running" : (result.ok ? "complete" : "error"),
                        result: result.ok ? result : undefined,
                        error: result.error,
                        metadata: {
                          title:
                            typeof activity.metadata?.title === "string" && activity.metadata.title.trim()
                              ? activity.metadata.title
                              : formatToolName(event.toolName),
                          ...(activity.metadata || {}),
                          subtitle: event.message,
                        },
                      };
                      setAgentActivities((prev) =>
                        prev.map((a) => (a.id === activity.id ? updatedActivity : a))
                      );
                      // Don't persist the "running" state if we're keeping it open artificially
                      if (!keepRunning) {
                        persistActivity(updatedActivity, sessionId);
                      }

                      connectorToolResults.push({
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        result: compactToolResultForServer(event.toolName, JSON.stringify(result)),
                      });
                    } catch (err) {
                      if (!isRunActive()) return;
                      const errStr = err instanceof Error ? err.message : String(err);
                      setAgentActivities((prev) =>
                        prev.map((a) =>
                          a.id === activity.id ? { ...a, status: "error", error: errStr } : a
                        )
                      );
                      persistActivity({ ...activity, status: "error", error: errStr }, sessionId);
                      connectorToolResults.push({
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        result: compactToolResultForServer(
                          event.toolName,
                          JSON.stringify({ ok: false, error: errStr })
                        ),
                      });
                    }
                  })();
                  connectorPromises.push(p);
                  break;
                }
                
                case "browser-task": {
                  // Legacy __browser_task__ event — no longer used.
                  // Browser tasks now go through __connector_execute__ → connector → Playwright MCP.
                  console.log("[useOrchestrator] browser-task event (legacy, ignored):", event.task?.slice(0, 100));
                  break;
                }

                case "ui-open-code": {
                  didOpenCodeSession = true;
                  const agentId = (event as { agentId?: string }).agentId;
                  const name = (event as { name?: string }).name;
                  if (agentId && onOpenCodeSession) {
                    try {
                      onOpenCodeSession(agentId, name);
                    } catch {
                      // ignore
                    }
                  }
                  break;
                }

                case "needs-reauth": {
                  // Data integration requires re-authorization (OAuth token expired)
                  const reauthEvent = event as {
                    provider: string;
                    agentId: string;
                    linkToken?: string;
                  };
                  console.log("[useOrchestrator] needs-reauth:", reauthEvent);
                  setNeedsReauth({
                    provider: reauthEvent.provider,
                    agentId: reauthEvent.agentId,
                    linkToken: reauthEvent.linkToken,
                  });
                  break;
                }
                
                case "error":
                  streamError =
                    typeof event.error === "string" && event.error.trim()
                      ? event.error.trim()
                      : "Unknown orchestrator stream error";
                  console.error("[useOrchestrator] Stream error:", streamError);
                  setError(streamError);
                  break;
                
                case "done":
                  sawDoneEvent = true;
                  hitStepBudget = event.hitStepBudget === true;
                  needsClientContinuation = event.needsClientContinuation === true;
                  finalizeDoneActivities();
                  break;
              }
            } catch (e) {
              console.warn("[useOrchestrator] Failed to parse SSE event:", line, e);
            }
              if (streamError) break;
          }
            if (streamError) break;
        }

          // Process any remaining buffered `data:` line (Safari can omit trailing newline).
          const tail = buffer.trim();
          if (tail.startsWith("data: ")) {
            try {
              const event = JSON.parse(tail.slice(6)) as SSEEvent;
              // Re-run the minimal subset of handlers we care about at end-of-stream.
              // (This avoids duplicating the whole switch, but still captures files + done.)
              if (event.type === "text") {
                roundText += event.text;
                setStreamingContent(roundText);
              } else if (event.type === "clear_tool_stream") {
                toolStreamText = "";
              } else if (event.type === "tool-stream") {
                toolStreamText += event.text || "";
              } else if (event.type === "tool-result") {
                if (event.toolName === "files_agent_request" || event.toolName === "data_query") {
                  pendingGeneratedFiles = Array.isArray(event.generatedFiles)
                    ? event.generatedFiles
                    : [];
                }
              } else if (event.type === "done") {
                sawDoneEvent = true;
                hitStepBudget = event.hitStepBudget === true;
                needsClientContinuation = event.needsClientContinuation === true;
                finalizeDoneActivities();
              } else if (event.type === "error") {
                streamError =
                  typeof event.error === "string" && event.error.trim()
                    ? event.error.trim()
                    : "Unknown orchestrator stream error";
                setError(streamError);
              }
            } catch {
              // Ignore
            }
          }

          await Promise.all(connectorPromises);
          throwIfRunCancelled();
          if (streamError) {
            throw new Error(streamError);
          }
          if (!sawDoneEvent) {
            throw new Error(
              "Orchestrator stream ended unexpectedly before completion. Please retry."
            );
          }
          return {
            connectorToolResults,
            serverSideToolResults,
            roundText,
            hitStepBudget,
            needsClientContinuation,
          };
        };

        // Loop orchestrator <-> connector until there are no more connector tool results to return (bounded).
        // IMPORTANT: append tool results to llmHistory (tool-runner style) so we don't re-send
        // an ever-growing toolResults blob every round.
        // Prevent unbounded connector/server ping-pong loops while still allowing
        // genuinely long agentic work such as account reconciliation.
        const MAX_ROUNDS = 48;
        const extractSuccessfulSiteDevStart = (
          results: Array<{ toolCallId: string; toolName: string; result: string }>
        ): { slug?: string; port: number } | null => {
          for (let i = results.length - 1; i >= 0; i--) {
            const tr = results[i];
            if (tr.toolName !== "site_dev") continue;
            try {
              const parsed = JSON.parse(tr.result) as Record<string, unknown>;
              const candidates: Array<Record<string, unknown>> = [parsed];
              if (
                parsed &&
                typeof parsed.result === "object" &&
                parsed.result !== null &&
                !Array.isArray(parsed.result)
              ) {
                candidates.push(parsed.result as Record<string, unknown>);
              }
              for (const c of candidates) {
                if (c.ok !== true) continue;
                const rawPort = c.port;
                const parsedPort =
                  typeof rawPort === "number"
                    ? rawPort
                    : typeof rawPort === "string"
                      ? Number(rawPort)
                      : NaN;
                if (!Number.isFinite(parsedPort) || parsedPort <= 0) continue;
                const slug =
                  typeof c.slug === "string" && c.slug.trim().length > 0
                    ? c.slug.trim()
                    : undefined;
                return { slug, port: parsedPort };
              }
            } catch {
              // ignore malformed tool result payloads
            }
          }
          return null;
        };
        let hitRoundLimit = true;
        let sawSiteDevStart = false;
        let siteDevSlug: string | undefined = undefined;
        let siteDevPort: number | undefined = undefined;
        let postSiteDevReadOnlyRounds = 0;
        let pendingToolResultsForServer:
          | Array<{ toolCallId: string; toolName: string; result: string }>
          | undefined = undefined;
        for (let i = 0; i < MAX_ROUNDS; i++) {
          throwIfRunCancelled();
          const {
            connectorToolResults,
            serverSideToolResults,
            roundText: rt,
            hitStepBudget,
          } =
            await runOrchestratorRound({
              message: i === 0 ? firstRoundMessage : "",
              history: llmHistory,
              toolResults: pendingToolResultsForServer,
            });
          throwIfRunCancelled();
          pendingToolResultsForServer = undefined;

          // If a server round hit its tool-step budget after server-side tool work,
          // keep going automatically with those tool results instead of treating
          // pre-tool/progress text ("now let me check...") as a final answer.
          if (
            !connectorToolResults.length &&
            hitStepBudget &&
            serverSideToolResults.length > 0
          ) {
            const trMsg = toolResultsToHistoryMessage(serverSideToolResults);
            if (trMsg) {
              llmHistory = [...llmHistory, trMsg];
            }
            pendingToolResultsForServer = serverSideToolResults.map((tr) => ({
              ...tr,
              result: compactToolResultForServer(tr.toolName, tr.result),
            }));
            continue;
          }

          // If there are no connector tool calls and no forced continuation, this is the final answer.
          if (!connectorToolResults.length) {
            finalText = rt;
            hitRoundLimit = false;
            break;
          }

          const combined = [...serverSideToolResults, ...connectorToolResults].filter(
            (tr) => tr && typeof tr.toolCallId === "string" && typeof tr.toolName === "string"
          );
          const startedSiteDev = extractSuccessfulSiteDevStart(combined);
          if (startedSiteDev) {
            sawSiteDevStart = true;
            siteDevSlug = startedSiteDev.slug;
            siteDevPort = startedSiteDev.port;
            postSiteDevReadOnlyRounds = 0;
          } else if (sawSiteDevStart) {
            const isReadOnlyCodeLoop =
              connectorToolResults.length > 0 &&
              connectorToolResults.every(
                (tr) => tr.toolName === "code_cli_run" || tr.toolName === "terminal_exec"
              );
            postSiteDevReadOnlyRounds = isReadOnlyCodeLoop ? postSiteDevReadOnlyRounds + 1 : 0;
            if (postSiteDevReadOnlyRounds >= 1) {
              const scope = siteDevSlug ? ` for "${siteDevSlug}"` : "";
              const portText = siteDevPort ? ` (port ${siteDevPort})` : "";
              finalText = rt.trim()
                ? rt
                : `Local preview is running${scope}${portText}. Tell me what to change next, or ask me to publish.`;
              hitRoundLimit = false;
              break;
            }
          }

          const trMsg = toolResultsToHistoryMessage(combined);
          if (trMsg) {
            llmHistory = [...llmHistory, trMsg];
          }
          // Provide structured toolResults to the server on the next round (for compatibility + billing capture),
          // but only send the delta (this round's results), not an accumulated blob.
          pendingToolResultsForServer = combined.map((tr) => ({
            ...tr,
            result: compactToolResultForServer(tr.toolName, tr.result),
          }));
        }

        if (hitRoundLimit) {
          console.warn("[useOrchestrator] Reached connector round limit", {
            maxRounds: MAX_ROUNDS,
            pendingToolResultsCount: pendingToolResultsForServer?.length || 0,
          });
        }

        let fullContent = finalText.trim();

        // Strip tool-stream artifacts like "[Saving foo.png...]" before persisting.
        // These come from data agent / files agent streamed output and are noise.
        fullContent = fullContent.replace(/\[Saving [^\]]+\.\.\.\]\s*/gi, "").trim();

        // Orchestrator can legitimately stream no text if it delegated work to a
        // long-running client-side task. In that case, we still want a placeholder
        // assistant message in the chat.
        if (!fullContent.trim()) {
          const hasRunningToolActivity = (toolName: string) =>
            sessionActivities.some((a) => {
              if (a.status !== "running") return false;
              const metadata =
                (a.metadata as ActivityMetadata | undefined) || undefined;
              return metadata?.toolName === toolName;
            });
          const hasActiveBrowserTask = hasRunningToolActivity("browser_task");
          const hasActiveCodeTask =
            hasRunningToolActivity("code_cli_run") ||
            hasRunningToolActivity("terminal_exec");

          // Round-limit failures should surface explicitly, not be masked by placeholders.
          if (hitRoundLimit) {
            throw new Error(
              `Orchestrator reached the connector round limit (${MAX_ROUNDS}) before finishing.`
            );
          }
          if (hasActiveBrowserTask) {
            fullContent = "Running browser task…";
          } else if (hasActiveCodeTask) {
            fullContent = "Running code task…";
          } else if (didOpenCodeSession) {
            fullContent = "Opening code session…";
          } else {
            throw new Error("Empty response from orchestrator");
          }
        }

        throwIfRunCancelled();

        // Extract any WhatsApp/Telegram send confirmation payloads into structured metadata
        const extracted = extractWhatsAppSendConfirmation(fullContent);
        fullContent = extracted.cleanText;
        const tgExtracted = extractTelegramSendConfirmation(fullContent);
        fullContent = tgExtracted.cleanText;
        if (inboxCommandReplyPrefix.trim()) {
          fullContent = fullContent.trim()
            ? `${inboxCommandReplyPrefix}\n\n${fullContent}`
            : inboxCommandReplyPrefix;
        }

        // Add assistant message
        const assistantMessage: OrchestratorMessage = {
          id: traceId || `assistant-${Date.now()}`,
          role: "assistant",
          content: fullContent,
          timestamp: new Date(),
          toolCalls: sessionToolCalls.length > 0 ? sessionToolCalls : undefined,
          agentActivities: sessionActivities.length > 0 ? sessionActivities : undefined,
          metadata: mergeMetadata({
            ...(pendingGeneratedFiles.length > 0
              ? { generated_files: pendingGeneratedFiles }
              : {}),
            ...(extracted.pendingSend ? { whatsapp_pending_send: extracted.pendingSend } : {}),
            ...(tgExtracted.pendingSend ? { telegram_pending_send: tgExtracted.pendingSend } : {}),
          }),
        };
        setMessages((prev) => [...prev, assistantMessage]);
        // The stream is only a transient presentation layer. Wait until the
        // completed message is durably available before clearing that layer.
        await persistMessage(assistantMessage, sessionId, traceId || undefined);
        turnCompleted = true;
        activeTurnRef.current = null;
        try {
          sessionStorage.removeItem(ORCHESTRATOR_INFLIGHT_STORAGE_KEY);
        } catch {
          // ignore
        }

        // Update session in list
        const messageCountDelta = options?.suppressUserMessage ? 1 : 2;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  updatedAt: new Date().toISOString(),
                  messageCount: (s.messageCount || 0) + messageCountDelta,
                }
              : s
          )
        );
        return { ok: true as const };
      } catch (err) {
        finalizeContextPrepActivity("error");
        if (err instanceof Error && err.name === "AbortError") {
          activeTurnRef.current = null;
          try {
            sessionStorage.removeItem(ORCHESTRATOR_INFLIGHT_STORAGE_KEY);
          } catch {
            // ignore
          }
          return { ok: false as const, error: "aborted" };
        }
        const errorMessage = err instanceof Error ? err.message : "An error occurred";
        setError(errorMessage);
        console.error("[useOrchestrator] Error:", err);
        return { ok: false as const, error: errorMessage };
      } finally {
        if (activeRunIdRef.current === runId) {
          if (turnCompleted) {
            activeTurnRef.current = null;
          }
          // Avoid stale running context-prep activity on any exit path.
          finalizeContextPrepActivity("complete");
          // Clear the protected set since sendMessage is done
          activeBrowserTaskActivityIdsRef.current.clear();
          // Mark activities complete and stop streaming
          const finallyCompleted: AgentActivity[] = [];
          setAgentActivities((prev) =>
            prev.map((a) =>
              a.status === "running"
                ? (() => {
                    const updated = { ...a, status: "complete" as AgentActivity["status"] };
                    finallyCompleted.push(updated);
                    return updated;
                  })()
                : a
            )
          );
          for (const a of finallyCompleted) {
            persistActivity(a, a.sessionId || sessionId);
          }
          isStreamingRef.current = false;
          setIsStreaming(false);
          setStreamingContent("");
          setTimeout(() => setCurrentToolCalls([]), 2000);
          abortRef.current = null;

          // Reconcile the exact conversation after every run. Realtime is a useful
          // prompt to refresh, but it is not a completion acknowledgement and can
          // be coalesced or arrive before the final row is readable.
          if (currentSessionIdRef.current === sessionId) {
            window.setTimeout(() => {
              if (
                !isStreamingRef.current &&
                currentSessionIdRef.current === sessionId
              ) {
                loadSessionRef.current?.(sessionId).catch(() => {});
              }
            }, 150);
          }
        }
      }
    },
    [
      messages,
      isStreaming,
      currentSessionId,
      createSession,
      persistActivity,
      persistMessage,
      onConnectorExecute,
      onOpenCodeSession,
    ]
  );

  const cancelStream = useCallback(() => {
    activeRunIdRef.current += 1;
    activeTurnRef.current = null;
    try {
      sessionStorage.removeItem(ORCHESTRATOR_INFLIGHT_STORAGE_KEY);
    } catch {
      // ignore
    }
    if (abortRef.current) {
      if (!abortRef.current.signal.aborted) {
        abortRef.current.abort();
      }
      // Mark ALL running activities as complete (cancelled)
      const cancelled: AgentActivity[] = [];
      setAgentActivities((prev) =>
        prev.map((a) => {
          if (a.status !== "running") return a;
          const updated = { ...a, status: "complete" as AgentActivity["status"] };
          cancelled.push(updated);
          return updated;
        })
      );
      for (const a of cancelled) {
        persistActivity(a, a.sessionId || currentSessionId || undefined);
      }
      setPreparingMemoryContext(false);
      activeBrowserTaskActivityIdsRef.current.clear();
      isStreamingRef.current = false;
      setIsStreaming(false);
      setStreamingContent("");
      setCurrentToolCalls([]);
    }
  }, [persistActivity, currentSessionId]);

  const clearMessages = useCallback(async () => {
    if (currentSessionId) {
      try {
        const agentId = agentIdBySessionIdRef.current.get(currentSessionId) || null;
        await fetch("/api/orchestrator/clear-conversation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: currentSessionId,
            agentId,
          }),
        });
      } catch {
        // best-effort: local clear should still happen
      }
    }
    setMessages([]);
    setAgentActivities([]);
    setActiveAgents([]);
    setCurrentToolCalls([]);
    setError(null);
    setNeedsReauth(null);
  }, [currentSessionId]);

  const clearNeedsReauth = useCallback(() => {
    setNeedsReauth(null);
  }, []);

  // Add a message to local state without persisting (for immediate UI updates)
  const addLocalMessage = useCallback((msg: OrchestratorMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  // Manually inject session state (used by multi-agent view to switch context without reloading)
  const injectSessionState = useCallback(
    (sessionId: string, msgs: OrchestratorMessage[], activities: AgentActivity[]) => {
      skipNextSessionLoadRef.current = sessionId;
      setCurrentSessionId(sessionId);
      setMessages(msgs);
      setAgentActivities(activities);
      isStreamingRef.current = false;
      setIsStreaming(false);
      setStreamingContent("");
      setCurrentToolCalls([]);
      setError(null);
    },
    []
  );

  // Keep isStreamingRef in sync so the visibilitychange handler reads fresh state
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Recover from mobile sleep/wake. A completed server-side round is tagged
  // with client_turn_id, so a suspended PWA can reconcile the exact turn from
  // durable messages instead of leaving a stale spinner forever.
  useEffect(() => {
    let lastHiddenAt = 0;
    let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
    let reconcileInProgress = false;

    const readInflightTurn = () => {
      if (activeTurnRef.current) return activeTurnRef.current;
      try {
        const raw = sessionStorage.getItem(ORCHESTRATOR_INFLIGHT_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
          sessionId?: unknown;
          turnId?: unknown;
          startedAt?: unknown;
        };
        if (
          typeof parsed.sessionId !== "string" ||
          !parsed.sessionId.trim() ||
          typeof parsed.turnId !== "string" ||
          !parsed.turnId.trim() ||
          typeof parsed.startedAt !== "number" ||
          !Number.isFinite(parsed.startedAt)
        ) {
          return null;
        }
        const restored = {
          sessionId: parsed.sessionId.trim(),
          turnId: parsed.turnId.trim(),
          startedAt: parsed.startedAt,
        };
        activeTurnRef.current = restored;
        return restored;
      } catch {
        return null;
      }
    };

    const clearRecoveredTurn = () => {
      activeTurnRef.current = null;
      try {
        sessionStorage.removeItem(ORCHESTRATOR_INFLIGHT_STORAGE_KEY);
      } catch {
        // ignore
      }
    };

    const reconcileInflightTurn = async (source: string) => {
      if (reconcileInProgress || document.visibilityState !== "visible") return;
      const inflight = readInflightTurn();
      if (!inflight) {
        const sid = currentSessionIdRef.current;
        if (sid && !isStreamingRef.current) {
          await loadSessionRef.current?.(sid);
        }
        return;
      }

      reconcileInProgress = true;
      try {
        const response = await fetch(
          `/api/orchestrator/agents/${encodeURIComponent(
            inflight.sessionId
          )}?ts=${Date.now()}`,
          {
            cache: "no-store",
            headers: { "cache-control": "no-cache" },
          }
        );
        const data = response.ok ? await response.json().catch(() => ({})) : {};
        const persistedMessages = Array.isArray(data?.messages) ? data.messages : [];
        const completed = persistedMessages.some((message: unknown) => {
          if (!message || typeof message !== "object") return false;
          const row = message as {
            role?: unknown;
            metadata?: unknown;
          };
          if (row.role !== "assistant") return false;
          const metadata =
            row.metadata && typeof row.metadata === "object"
              ? (row.metadata as Record<string, unknown>)
              : null;
          return metadata?.client_turn_id === inflight.turnId;
        });

        if (completed) {
          console.log("[useOrchestrator] Recovered completed mobile turn", {
            source,
            sessionId: inflight.sessionId,
            turnId: inflight.turnId,
          });
          activeRunIdRef.current += 1;
          if (abortRef.current && !abortRef.current.signal.aborted) {
            abortRef.current.abort();
          }
          abortRef.current = null;
          clearRecoveredTurn();
          isStreamingRef.current = false;
          setIsStreaming(false);
          setStreamingContent("");
          setCurrentToolCalls([]);
          setPreparingMemoryContext(false);
          setError(null);
          if (currentSessionIdRef.current === inflight.sessionId) {
            await loadSessionRef.current?.(inflight.sessionId);
          }
          return;
        }

        const elapsedMs = Date.now() - inflight.startedAt;
        if (elapsedMs >= ORCHESTRATOR_INFLIGHT_MAX_AGE_MS) {
          console.warn("[useOrchestrator] Mobile turn recovery expired", {
            source,
            sessionId: inflight.sessionId,
            turnId: inflight.turnId,
            elapsedMs,
          });
          activeRunIdRef.current += 1;
          abortRef.current = null;
          clearRecoveredTurn();
          isStreamingRef.current = false;
          setIsStreaming(false);
          setStreamingContent("");
          setCurrentToolCalls([]);
          setPreparingMemoryContext(false);
          setError(
            "The live connection ended before this orchestrator turn completed. Any delegated agent task continues in the background."
          );
          await loadSessionRef.current?.(inflight.sessionId);
          return;
        }

        reconcileTimer = setTimeout(() => {
          void reconcileInflightTurn("mobile-retry");
        }, 3_500);
      } catch (error) {
        console.warn("[useOrchestrator] Mobile turn reconciliation failed:", error);
        reconcileTimer = setTimeout(() => {
          void reconcileInflightTurn("mobile-retry-after-error");
        }, 3_500);
      } finally {
        reconcileInProgress = false;
      }
    };

    const handleWake = (source: string) => {
      if (document.visibilityState !== "visible") return;
      const sleepDurationMs = lastHiddenAt ? Date.now() - lastHiddenAt : 0;
      if (sleepDurationMs < 5_000 && !readInflightTurn()) return;
      if (reconcileTimer) clearTimeout(reconcileTimer);
      reconcileTimer = setTimeout(() => {
        void reconcileInflightTurn(source);
      }, 1_000);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        lastHiddenAt = Date.now();
        return;
      }
      handleWake("visibilitychange");
    };

    const handlePageShow = (e: PageTransitionEvent) => {
      handleWake(e.persisted ? "pageshow-persisted" : "pageshow");
    };

    const handleFocus = () => handleWake("focus");

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handleFocus);
    if (readInflightTurn()) {
      reconcileTimer = setTimeout(() => {
        void reconcileInflightTurn("mount");
      }, 1_000);
    }
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleFocus);
      if (reconcileTimer) clearTimeout(reconcileTimer);
    };
  }, []); // stable — reads from refs

  return {
    // Session management
    sessions,
    currentSessionId,
    createSession,
    deleteSession,
    renameSession,
    selectSession,
    markSessionShared,
    getAgentIdForSession,
    injectSessionState,
    
    // State
    messages,
    isStreaming,
    preparingMemoryContext,
    isLoading,
    streamingContent,
    activeAgents,
    agentActivities,
    currentToolCalls,
    error,
    needsReauth,

    // Actions
    sendMessage,
    cancelStream,
    clearMessages,
    addLocalMessage,
    clearNeedsReauth,
  };
}

function formatToolName(toolName: string): string {
  const names: Record<string, string> = {
    data_query: "Querying data",
    data_check_connection: "Checking connection",
    remember: "Saving to memory",
    recall: "Searching memory",
    browser_navigate: "Navigating",
    browser_click: "Clicking",
    browser_type: "Typing",
    browser_extract: "Extracting content",
    browser_screenshot: "Taking screenshot",
  };
  return names[toolName] || toolName.replace(/_/g, " ");
}

/**
 * Run a browser task using Claude Computer Use
 * Implements the agent loop: screenshot → Claude → action → repeat
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function runBrowserTask(params: {
  task: string;
  startUrl?: string;
  onConnectorExecute: ConnectorExecuteCallback;
  onScreenshot?: (screenshot: string, url: string, title: string, mediaType?: string) => void;
  onAction?: (action: string, detail?: string) => void;
}): Promise<{ ok: boolean; result?: string; error?: string }> {
  const { task, startUrl, onConnectorExecute, onScreenshot, onAction } = params;
  
  console.log("[runBrowserTask] ===== STARTING =====");
  console.log("[runBrowserTask] task:", task?.slice(0, 100));
  console.log("[runBrowserTask] startUrl:", startUrl);
  
  // Initialize browser
  console.log("[runBrowserTask] Step 1: browser_init");
  onAction?.("Initializing browser", "Starting headless browser");
  const initResult = await onConnectorExecute({
    type: "browser_init",
    params: { headless: true },
    toolCallId: `init-${Date.now()}`,
    toolName: "browser_init",
    agent: "browser",
  });
  console.log("[runBrowserTask] browser_init result:", { ok: initResult.ok, error: initResult.error });
  
  if (!initResult.ok) {
    console.error("[runBrowserTask] FAILED at browser_init");
    return { ok: false, error: `Failed to initialize browser: ${initResult.error}` };
  }
  
  // Navigate to start URL if provided, otherwise go to Google
  const targetUrl = startUrl || "https://www.google.com";
  console.log("[runBrowserTask] Step 2: browser_navigate to", targetUrl);
  onAction?.("Navigating", targetUrl);
  const navResult = await onConnectorExecute({
    type: "browser_navigate",
    // Large sites (Target/Walmart/etc) often never reach networkidle; use domcontentloaded
    // so we can start Computer Use ASAP.
    params: { url: targetUrl, wait_until: "domcontentloaded", timeout_ms: 30000 },
    toolCallId: `nav-${Date.now()}`,
    toolName: "browser_navigate",
    agent: "browser",
  });
  console.log("[runBrowserTask] browser_navigate result:", { ok: navResult.ok, error: navResult.error, url: navResult.url });
  
  if (!navResult.ok) {
    console.error("[runBrowserTask] FAILED at browser_navigate:", navResult.error);
    return { ok: false, error: `Failed to navigate to ${targetUrl}: ${navResult.error}` };
  }
  
  // Small delay to ensure page renders
  console.log("[runBrowserTask] Step 3: waiting 500ms for page render");
  await new Promise(r => setTimeout(r, 500));
  
  // Take initial screenshot so Claude can see the page
  console.log("[runBrowserTask] Step 4: computer_use_action screenshot");
  onAction?.("Taking initial screenshot", "Claude needs to see the page");
  const initialScreenshot = await onConnectorExecute({
    type: "computer_use_action",
    params: { action: "screenshot" },
    toolCallId: `screenshot-${Date.now()}`,
    toolName: "computer_use_action",
    agent: "browser",
  });
  
  console.log("[runBrowserTask] Initial screenshot result:", {
    ok: initialScreenshot.ok,
    hasScreenshot: !!initialScreenshot.screenshot,
    screenshotLen: (initialScreenshot.screenshot as string)?.length || 0,
    url: initialScreenshot.url,
    title: initialScreenshot.title,
    error: initialScreenshot.error,
  });
  
  // Update UI with initial screenshot
  if (initialScreenshot.ok && initialScreenshot.screenshot) {
    onScreenshot?.(
      initialScreenshot.screenshot as string,
      (initialScreenshot.url as string) || targetUrl,
      (initialScreenshot.title as string) || "",
      typeof (initialScreenshot.screenshotMediaType as unknown) === "string"
        ? (initialScreenshot.screenshotMediaType as string)
        : "image/png"
    );
  } else {
    console.warn("[runBrowserTask] No initial screenshot:", initialScreenshot);
  }
  
  // Start the Computer Use agent loop
  console.log("[runBrowserTask] Step 5: Starting Computer Use agent loop");
  let previousMessages: unknown[] = [];
  let pendingToolResult: { toolUseId: string; result: Record<string, unknown> } | null = null;
  let iterationCount = 0;
  const maxIterations = 30; // Increased for heavy sites like Target/Walmart
  let finalResult = "";
  let accumulatedText = "";
  let lastViewScreenshot: string | null =
    initialScreenshot.ok && typeof initialScreenshot.screenshot === "string"
      ? (initialScreenshot.screenshot as string)
      : null;
  let lastViewUrl: string =
    initialScreenshot.ok && typeof initialScreenshot.url === "string"
      ? (initialScreenshot.url as string)
      : targetUrl;
  let lastViewTitle: string =
    initialScreenshot.ok && typeof initialScreenshot.title === "string"
      ? (initialScreenshot.title as string)
      : "";
  let sameViewStreak = 0;

  // --- Loop detection: track recent actions to detect stuck patterns ---
  const actionHistory: { action: string; coordinate?: [number, number]; text?: string }[] = [];
  const LOOP_WINDOW = 6;
  const LOOP_REPEAT_THRESHOLD = 3;

  function isStuckInLoop(): boolean {
    if (actionHistory.length < LOOP_REPEAT_THRESHOLD) return false;
    const recent = actionHistory.slice(-LOOP_WINDOW);
    const counts: Record<string, number> = {};
    for (const h of recent) {
      const key = `${h.action}|${JSON.stringify(h.coordinate || [])}`;
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] >= LOOP_REPEAT_THRESHOLD) return true;
    }
    // Detect alternating A-B-A-B pattern
    if (recent.length >= 4) {
      const keys = recent.map((h) => `${h.action}|${JSON.stringify(h.coordinate || [])}`);
      const last4 = keys.slice(-4);
      if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) return true;
    }
    return false;
  }

  // Prevent request bodies from exploding (413) by stripping old screenshot images.
  // We keep ALL messages (never drop assistant/user turns) to preserve the
  // tool_use → tool_result pairing that the Anthropic API requires.
  // Only the last N screenshots are kept as actual images; older ones become text placeholders.
  function trimBrowserAgentMessages(msgs: unknown[] | null | undefined, keepRecentImages = 2): unknown[] {
    if (!Array.isArray(msgs) || msgs.length === 0) return Array.isArray(msgs) ? msgs : [];

    // Scan for image blocks from the end
    let imageCount = 0;
    const imagePositions: { msgIdx: number; blockIdx: number; keep: boolean }[] = [];

    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      const content = (m as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (let j = (content as unknown[]).length - 1; j >= 0; j--) {
        const b = (content as unknown[])[j];
        if (!b || typeof b !== "object" || Array.isArray(b)) continue;
        if ((b as Record<string, unknown>).type === "image") {
          imagePositions.push({ msgIdx: i, blockIdx: j, keep: imageCount < keepRecentImages });
          imageCount++;
        }
      }
    }

    if (imageCount <= keepRecentImages) return msgs;

    // Deep-copy messages and replace old images with text placeholders
    return msgs.map((m, mi) => {
      if (!m || typeof m !== "object" || Array.isArray(m)) return m;
      const hasOldImage = imagePositions.some((p) => p.msgIdx === mi && !p.keep);
      if (!hasOldImage) return m;

      const content = (m as Record<string, unknown>).content;
      if (!Array.isArray(content)) return m;

      const newContent = (content as unknown[]).map((b, bi) => {
        const pos = imagePositions.find((p) => p.msgIdx === mi && p.blockIdx === bi);
        if (pos && !pos.keep) {
          return { type: "text", text: "[screenshot image omitted to save space]" };
        }
        return b;
      });

      return { ...(m as Record<string, unknown>), content: newContent };
    });
  }
  
  while (iterationCount < maxIterations) {
    iterationCount++;
    console.log(`[runBrowserTask] ===== ITERATION ${iterationCount} =====`);
    
    // Build request - first iteration sends task, subsequent send toolResult
    const requestBody: Record<string, unknown> = {};
    
    if (iterationCount === 1) {
      // First request: send task and initial screenshot
      requestBody.task = task;
      if (initialScreenshot.ok) {
        requestBody.initialScreenshot = {
          screenshot: initialScreenshot.screenshot,
          url: initialScreenshot.url || targetUrl,
          title: initialScreenshot.title || "",
          screenshotMediaType:
            typeof (initialScreenshot.screenshotMediaType as unknown) === "string"
              ? (initialScreenshot.screenshotMediaType as string)
              : "image/png",
        };
      }
    } else {
      // Subsequent requests: send tool result
      requestBody.previousMessages = trimBrowserAgentMessages(previousMessages);
      if (pendingToolResult) {
        requestBody.toolResult = pendingToolResult;
      }
    }
    
    console.log("[runBrowserTask] Request:", {
      hasTask: !!requestBody.task,
      hasPreviousMessages: !!requestBody.previousMessages,
      hasToolResult: !!requestBody.toolResult,
      hasInitialScreenshot: !!requestBody.initialScreenshot,
    });
    
    const response = await fetch("/api/browser-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    
    console.log("[runBrowserTask] Response status:", response.status);
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error("[runBrowserTask] FAILED:", errorText);
      return { ok: false, error: `Browser agent error: ${errorText}` };
    }
    
    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: false, error: "No response from browser agent" };
    }
    
    const decoder = new TextDecoder();
    let buffer = "";
    let toolCall: {
      toolUseId: string;
      action: string;
      coordinate?: [number, number];
      text?: string;
      key?: string;
      scrollDirection?: string;
      scrollAmount?: number;
    } | null = null;
    let awaitingMessages: unknown[] | null = null;
    let textResponse = "";
    let isComplete = false;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        
        try {
          const event = JSON.parse(line.slice(6));
          console.log("[runBrowserTask] SSE:", event.type, event.action || "");
          
          if (event.type === "text") {
            textResponse += event.text;
            accumulatedText += event.text;
          } else if (event.type === "tool_call") {
            toolCall = {
              toolUseId: event.toolUseId,
              action: event.action,
              coordinate: event.coordinate,
              text: event.text,
              key: event.key,
              scrollDirection: event.scrollDirection,
              scrollAmount: event.scrollAmount,
            };
            onAction?.(
              `Computer Use: ${event.action}`,
              event.coordinate ? `at (${event.coordinate[0]}, ${event.coordinate[1]})` : event.text
            );
          } else if (event.type === "awaiting_tool_result") {
            awaitingMessages = event.messages;
          } else if (event.type === "complete") {
            finalResult = event.text || textResponse;
            isComplete = true;
          } else if (event.type === "error") {
            return { ok: false, error: event.error };
          }
        } catch {
          // Ignore parse errors
        }
      }

      // Safari-friendly: process any remaining buffer content after stream ends
      if (buffer.trim() && buffer.startsWith("data: ")) {
        try {
          const event = JSON.parse(buffer.slice(6));
          if (event.type === "text") {
            textResponse += event.text;
            accumulatedText += event.text;
          } else if (event.type === "tool_call") {
            toolCall = {
              toolUseId: event.toolUseId,
              action: event.action,
              coordinate: event.coordinate,
              text: event.text,
              key: event.key,
              scrollDirection: event.scrollDirection,
              scrollAmount: event.scrollAmount,
            };
          } else if (event.type === "awaiting_tool_result") {
            awaitingMessages = event.messages;
          } else if (event.type === "complete") {
            finalResult = event.text || textResponse;
            isComplete = true;
          } else if (event.type === "error") {
            return { ok: false, error: event.error };
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Task complete?
    if (isComplete) {
      console.log("[runBrowserTask] Task complete!");
      break;
    }
    
    // No tool call = done
    if (!toolCall) {
      finalResult = textResponse;
      break;
    }

    // Last iteration safeguard: force Claude to produce a final answer from the current page state.
    // Heavy sites can get stuck in an infinite tool loop; instead of failing (and triggering Firecrawl),
    // we send one final screenshot with an instruction to answer without more tools.
    if (iterationCount >= maxIterations) {
      console.warn("[runBrowserTask] Reached max iterations, forcing final answer…");
      const lastShot = await onConnectorExecute({
        type: "computer_use_action",
        params: { action: "screenshot" },
        toolCallId: `final-screenshot-${Date.now()}`,
        toolName: "computer_use_action",
        agent: "browser",
      });

      const finalReq = {
        previousMessages: trimBrowserAgentMessages(awaitingMessages || previousMessages),
        toolResult: {
          toolUseId: toolCall.toolUseId,
          result: {
            ok: true,
            screenshot: lastShot.ok ? (lastShot.screenshot as string | undefined) : undefined,
            screenshotMediaType:
              lastShot.ok && typeof (lastShot.screenshotMediaType as unknown) === "string"
                ? (lastShot.screenshotMediaType as string)
                : "image/png",
            url: (lastShot.url as string) || "",
            title: (lastShot.title as string) || "",
            note:
              "We hit the browser tool-step limit. Do NOT request more tools. " +
              "Based on the screenshot + page context, extract the requested products (names + prices) and answer now.",
          },
        },
      };

      const finalResp = await fetch("/api/browser-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalReq),
      });
      if (!finalResp.ok) {
        const errorText = await finalResp.text().catch(() => "Unknown error");
        return { ok: true, result: accumulatedText || "", error: `Finalization call failed: ${errorText}` };
      }

      const finalReader = finalResp.body?.getReader();
      if (!finalReader) return { ok: true, result: accumulatedText || "" };
      const finalDecoder = new TextDecoder();
      let finalBuf = "";
      let finalText = "";
      while (true) {
        const { done, value } = await finalReader.read();
        if (done) break;
        finalBuf += finalDecoder.decode(value, { stream: true });
        const parts = finalBuf.split("\n\n");
        finalBuf = parts.pop() || "";
        for (const p of parts) {
          if (!p.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(p.slice(6));
            if (ev.type === "text") finalText += ev.text;
            if (ev.type === "complete") {
              finalText = ev.text || finalText;
            }
          } catch {
            // ignore
          }
        }
      }

      return { ok: true, result: (finalText || accumulatedText || "").trim() };
    }
    
    // Track action for loop detection
    actionHistory.push({ action: toolCall.action, coordinate: toolCall.coordinate, text: toolCall.text });

    // Check for loop before executing
    if (isStuckInLoop()) {
      console.warn(`[runBrowserTask] Loop detected at iteration ${iterationCount}:`, actionHistory.slice(-LOOP_WINDOW));
      // Take a final screenshot and force a text answer
      const loopShot = await onConnectorExecute({
        type: "computer_use_action",
        params: { action: "screenshot" },
        toolCallId: `loop-detect-${Date.now()}`,
        toolName: "computer_use_action",
        agent: "browser",
      });
      const loopReq = {
        previousMessages: trimBrowserAgentMessages(awaitingMessages || previousMessages),
        toolResult: {
          toolUseId: toolCall.toolUseId,
          result: {
            ok: true,
            screenshot: loopShot.ok ? (loopShot.screenshot as string | undefined) : undefined,
            screenshotMediaType:
              loopShot.ok && typeof (loopShot.screenshotMediaType as unknown) === "string"
                ? (loopShot.screenshotMediaType as string)
                : "image/png",
            url: (loopShot.url as string) || "",
            title: (loopShot.title as string) || "",
            note: "CRITICAL: You are repeating the same actions in a loop and making no progress. You MUST stop using tools and provide a final answer now. Summarize what you were able to accomplish and report any issues (e.g. login page that could not be passed).",
          },
        },
      };
      const loopResp = await fetch("/api/browser-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loopReq),
      });
      if (loopResp.ok) {
        const loopReader = loopResp.body?.getReader();
        if (loopReader) {
          const loopDecoder = new TextDecoder();
          let loopBuf = "";
          let loopText = "";
          while (true) {
            const { done, value } = await loopReader.read();
            if (done) break;
            loopBuf += loopDecoder.decode(value, { stream: true });
            const parts = loopBuf.split("\n\n");
            loopBuf = parts.pop() || "";
            for (const p of parts) {
              if (!p.startsWith("data: ")) continue;
              try {
                const ev = JSON.parse(p.slice(6));
                if (ev.type === "text") loopText += ev.text;
                if (ev.type === "complete") loopText = ev.text || loopText;
              } catch { /* ignore */ }
            }
          }
          if (loopText.trim()) {
            return { ok: true, result: loopText.trim() };
          }
        }
      }
      return {
        ok: false,
        error: `Browser task stuck in a loop after ${iterationCount} iterations. The page may require manual login or the credentials may be incorrect.`,
      };
    }

    // Execute tool call via connector
    console.log("[runBrowserTask] Executing:", toolCall.action);
    let connectorResult = await onConnectorExecute({
      type: "computer_use_action",
      params: {
        action: toolCall.action,
        coordinate: toolCall.coordinate,
        text: toolCall.text,
        key: toolCall.key,
        scroll_direction: toolCall.scrollDirection,
        scroll_amount: toolCall.scrollAmount,
      },
      toolCallId: toolCall.toolUseId,
      toolName: "computer_use_action",
      agent: "browser",
    });
    
    // Screenshot? Update UI
    console.log("[runBrowserTask] Checking screenshot:", {
      action: toolCall.action,
      connectorOk: connectorResult.ok,
      hasScreenshot: !!connectorResult.screenshot,
      screenshotLen: (connectorResult.screenshot as string)?.length,
    });
    if (toolCall.action === "screenshot" && connectorResult.ok && connectorResult.screenshot) {
      const screenshot = connectorResult.screenshot as string;
      const url = (connectorResult.url as string) || "";
      const title = (connectorResult.title as string) || "";
      const mediaType =
        typeof (connectorResult.screenshotMediaType as unknown) === "string"
          ? (connectorResult.screenshotMediaType as string)
          : "image/png";
      console.log("[runBrowserTask] Calling onScreenshot with:", { screenshotLen: screenshot?.length, url, title });
      onScreenshot?.(screenshot, url, title, mediaType);
    } else if (toolCall.action !== "screenshot" && connectorResult.ok) {
      // For non-screenshot actions, take a follow-up screenshot so:
      // 1) The UI shows live progress (onScreenshot)
      // 2) Claude gets visual feedback (merged into connectorResult for pendingToolResult)
      try {
        const followUp = await onConnectorExecute({
          type: "computer_use_action",
          params: { action: "screenshot" },
          toolCallId: `followup-${Date.now()}`,
          toolName: "computer_use_action",
          agent: "browser",
        });
        if (followUp.ok && followUp.screenshot) {
          const screenshot = followUp.screenshot as string;
          const url = (followUp.url as string) || "";
          const title = (followUp.title as string) || "";
          const mediaType =
            typeof (followUp.screenshotMediaType as unknown) === "string"
              ? (followUp.screenshotMediaType as string)
              : "image/png";
          console.log("[runBrowserTask] Follow-up screenshot after", toolCall.action, { screenshotLen: screenshot?.length, url });
          onScreenshot?.(screenshot, url, title, mediaType);
          // Merge screenshot into result so Claude sees it in the tool_result
          connectorResult = {
            ...connectorResult,
            screenshot,
            screenshotMediaType: mediaType,
            url: url || connectorResult.url,
            title: title || connectorResult.title,
          };
        }
      } catch {
        // If follow-up screenshot fails, continue without it
      }
    }

    // If scroll didn't move, add a lightweight hint (but don't spam notes every time).
    if (
      toolCall.action === "scroll" &&
      connectorResult.ok &&
      (connectorResult.scrolled as boolean | undefined) === false &&
      typeof (connectorResult.note as unknown) !== "string"
    ) {
      connectorResult = {
        ...connectorResult,
        note:
          "Scroll had no visible effect (already at boundary or wrong scroll container). " +
          "Try scrolling a different area, or use PageDown/Space, or click inside the scrollable panel first.",
      };
    }

    // No-progress detection: only count when Claude did a real action (click/type/scroll/key),
    // not when it just takes screenshots or waits.
    const isPassiveAction = toolCall.action === "screenshot" || toolCall.action === "wait";
    const curShot = typeof connectorResult.screenshot === "string" ? (connectorResult.screenshot as string) : null;
    const curUrl = typeof connectorResult.url === "string" ? (connectorResult.url as string) : lastViewUrl;
    const curTitle = typeof connectorResult.title === "string" ? (connectorResult.title as string) : lastViewTitle;

    if (curShot && !isPassiveAction && lastViewScreenshot && curShot === lastViewScreenshot && curUrl === lastViewUrl && curTitle === lastViewTitle) {
      sameViewStreak += 1;
    } else if (!isPassiveAction) {
      sameViewStreak = 0;
    }

    if (curShot) {
      lastViewScreenshot = curShot;
      lastViewUrl = curUrl;
      lastViewTitle = curTitle;
    }

    // sameViewStreak >= 4: after 4 real actions with no page change
    if (sameViewStreak >= 4) {
      console.warn(`[runBrowserTask] No-progress detected at iteration ${iterationCount}`);
      const finalReq = {
        previousMessages: trimBrowserAgentMessages(awaitingMessages || previousMessages),
        toolResult: {
          toolUseId: toolCall.toolUseId,
          result: {
            ok: true,
            screenshot: curShot || undefined,
            screenshotMediaType:
              typeof (connectorResult.screenshotMediaType as unknown) === "string"
                ? (connectorResult.screenshotMediaType as string)
                : "image/png",
            url: curUrl,
            title: curTitle,
            note:
              "CRITICAL: The screenshot/URL/title have not changed for multiple steps (no visible progress). " +
              "You MUST stop using tools and provide a final answer now. Summarize what you attempted, what you see on screen, " +
              "and what is blocking progress (e.g. login wall, MFA/CAPTCHA, broken page, blank/black screen).",
          },
        },
      };

      const finalResp = await fetch("/api/browser-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalReq),
      });
      if (!finalResp.ok) {
        const errorText = await finalResp.text().catch(() => "Unknown error");
        return {
          ok: false,
          error: `Finalization call failed after no-progress detection: ${errorText}`,
        };
      }

      const finalReader = finalResp.body?.getReader();
      if (!finalReader) return { ok: true, result: (accumulatedText || "").trim() };
      const finalDecoder = new TextDecoder();
      let finalBuf = "";
      let finalText = "";
      while (true) {
        const { done, value } = await finalReader.read();
        if (done) break;
        finalBuf += finalDecoder.decode(value, { stream: true });
        const parts = finalBuf.split("\n\n");
        finalBuf = parts.pop() || "";
        for (const p of parts) {
          if (!p.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(p.slice(6));
            if (ev.type === "text") finalText += ev.text;
            if (ev.type === "complete") finalText = ev.text || finalText;
          } catch {
            // ignore
          }
        }
      }

      return { ok: true, result: (finalText || accumulatedText || "").trim() };
    }
    
    // Prepare for next iteration
    if (awaitingMessages) {
      previousMessages = trimBrowserAgentMessages(awaitingMessages);
    }
    pendingToolResult = {
      toolUseId: toolCall.toolUseId,
      result: connectorResult,
    };
  }
  
  if (iterationCount >= maxIterations) {
    // Fallback: return whatever text we got so far so the orchestrator can continue without switching tools.
    if ((finalResult || accumulatedText).trim()) {
      return { ok: true, result: (finalResult || accumulatedText).trim() };
    }
    return {
      ok: false,
      error: `Browser task exceeded ${maxIterations} iterations. The page may be too complex or slow-loading. Consider using Firecrawl for heavy e-commerce sites.`,
    };
  }
  
  return { ok: true, result: finalResult };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function formatConnectorResult(toolName: string, result: Record<string, unknown>): string {
  if (toolName === "browser_navigate") {
    const r = result as { ok?: boolean; title?: string; url?: string };
    if (r.ok) {
      return `**Navigated to:** ${r.title || r.url}\n\nPage loaded successfully.`;
    }
    return `Failed to navigate: ${result.error}`;
  }
  
  if (toolName === "browser_extract") {
    const r = result as { ok?: boolean; content?: string | unknown[]; type?: string };
    if (r.ok) {
      if (typeof r.content === "string") {
        return `**Extracted content:**\n\n${r.content.slice(0, 2000)}${r.content.length > 2000 ? "..." : ""}`;
      }
      if (Array.isArray(r.content)) {
        return `**Extracted ${r.content.length} items:**\n\n${JSON.stringify(r.content.slice(0, 10), null, 2)}${r.content.length > 10 ? "\n..." : ""}`;
      }
    }
    return `Failed to extract: ${result.error}`;
  }
  
  if (toolName === "browser_screenshot") {
    const r = result as { ok?: boolean; screenshot?: string; title?: string };
    if (r.ok) {
      return `**Screenshot captured** of "${r.title}"`;
    }
    return `Failed to take screenshot: ${result.error}`;
  }
  
  if (toolName === "browser_click") {
    const r = result as { ok?: boolean; clicked?: boolean; title?: string };
    if (r.ok) {
      return `**Clicked successfully.** Now on: ${r.title}`;
    }
    return `Failed to click: ${result.error}`;
  }
  
  if (toolName === "browser_type") {
    const r = result as { ok?: boolean; typed?: boolean };
    if (r.ok) {
      return `**Text entered successfully.**`;
    }
    return `Failed to type: ${result.error}`;
  }
  
  // Generic format
  if (result.ok) {
    return `**Action completed:**\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
  }
  return `Action failed: ${result.error}`;
}
