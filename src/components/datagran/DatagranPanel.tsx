"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ExternalLink, CheckCircle2, AlertTriangle, Image as ImageIcon, Download, Maximize2, X, FileSpreadsheet, FileText, Presentation, File } from "lucide-react";
import { createPortal } from "react-dom";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { SessionPicker, type ChatSession } from "@/components/chat/SessionPicker";
import { DATAGRAN_PROVIDER_LABELS, NO_AUTH_PROVIDERS, type DatagranProvider } from "@/lib/datagran/prompts";

declare global {
  interface Window {
    DatagranLink?: {
      open: (options: {
        linkToken: string;
        onSuccess?: (payload: { connection_id: string }) => void;
        onExit?: (payload: unknown) => void;
      }) => void;
    };
  }
}

type DatagranConfigRow = {
  provider: DatagranProvider;
  connection_id: string | null;
};

type FileInfo = {
  file_id: string;
  filename: string;
  mime_type?: string;
  storage_path?: string;
  url?: string;
};

type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at?: string;
  metadata?: {
    files?: FileInfo[];
    generated_files?: FileInfo[];
    container_id?: string;
  };
};

// Get appropriate icon for file type
function getFileIcon(filename: string) {
  const ext = filename.toLowerCase().split(".").pop();
  switch (ext) {
    case "xlsx":
    case "xls":
    case "csv":
      return FileSpreadsheet;
    case "docx":
    case "doc":
    case "txt":
      return FileText;
    case "pptx":
    case "ppt":
      return Presentation;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
      return ImageIcon;
    default:
      return File;
  }
}

// Check if file is an image
function isImageFile(filename: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(filename);
}

// Parse message content to extract file references
function parseMessageContent(content: string): { text: string; files: FileInfo[] } {
  const files: FileInfo[] = [];
  let text = content;

  // Extract file references from markdown-style links
  // Pattern: - filename (file_id)
  const filePattern = /- ([^\n(]+) \(([a-zA-Z0-9_-]+)\)/g;
  let match;
  while ((match = filePattern.exec(content)) !== null) {
    files.push({
      filename: match[1].trim(),
      file_id: match[2],
    });
  }

  // Remove the "Generated Files" section from display text
  text = text.replace(/\n\n---\n\*\*Generated Files:\*\*\n[\s\S]*$/, "");

  // Remove container_id comment
  text = text.replace(/\n\n<!-- container_id:[^>]+ -->/, "");

  // Remove file saving placeholder patterns that Claude generates
  // e.g., "[Saving output.png...]", "[Saving chart.png...]", etc.
  text = text.replace(/\[Saving [^\]]+\.\.\.\]\n?/g, "");

  return { text: text.trim(), files };
}

// Component to render a generated file (visualization or document)
function VisualizationPreview({ 
  file, 
  agentId 
}: { 
  file: FileInfo; 
  agentId: string;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  
  const isImage = isImageFile(file.filename);
  const Icon = getFileIcon(file.filename);

  // Build the download URL - prefer stored URL, then storage_path, then file_id
  const getDownloadUrl = useCallback(() => {
    if (file.url) {
      return file.url;
    }
    if (file.storage_path) {
      return `/api/datagran/files?storagePath=${encodeURIComponent(file.storage_path)}&agentId=${encodeURIComponent(agentId)}`;
    }
    return `/api/datagran/files?fileId=${encodeURIComponent(file.file_id)}&agentId=${encodeURIComponent(agentId)}`;
  }, [file.url, file.storage_path, file.file_id, agentId]);
  
  useEffect(() => {
    if (!isImage) {
      setLoading(false);
      return;
    }

    let blobUrl: string | null = null;

    const loadImage = async () => {
      try {
        // Check if we're on mobile - mobile browsers often have issues with direct signed URLs
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

        // On mobile, always fetch via API to avoid CORS/caching issues with signed URLs
        // On desktop, use signed URL directly if available for better performance
        if (file.url && !isMobile) {
          setImageUrl(file.url);
          setLoading(false);
          return;
        }

        // Fetch via API (required for mobile, fallback for desktop)
        const downloadUrl = getDownloadUrl();
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error("Failed to load image");
        const blob = await res.blob();
        blobUrl = URL.createObjectURL(blob);
        setImageUrl(blobUrl);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    };

    loadImage();

    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [file.file_id, file.url, agentId, isImage, getDownloadUrl]);
  
  const handleDownload = async () => {
    try {
      // If we have a direct URL, use it
      if (file.url) {
        const a = document.createElement("a");
        a.href = file.url;
        a.download = file.filename;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }
      
      // Otherwise fetch via API
      const downloadUrl = getDownloadUrl();
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error("Failed to download");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Download failed:", e);
    }
  };
  
  if (isImage) {
    return (
      <div className="mt-3 rounded-xl overflow-hidden border border-white/10 bg-black/20">
        {loading ? (
          <div className="flex items-center justify-center h-48 text-zinc-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-48 text-red-400 text-sm">
            {error}
          </div>
        ) : imageUrl ? (
          <div className="relative group">
            <img
              src={imageUrl}
              alt={file.filename}
              className="w-full h-auto"
              onError={(e) => {
                // If direct URL fails (e.g., CORS on mobile), try fetching via API
                console.log("[VisualizationPreview] Image load error, trying fallback");
                const fallbackUrl = file.storage_path
                  ? `/api/datagran/files?storagePath=${encodeURIComponent(file.storage_path)}&agentId=${encodeURIComponent(agentId)}`
                  : `/api/datagran/files?fileId=${encodeURIComponent(file.file_id)}&agentId=${encodeURIComponent(agentId)}`;
                if (imageUrl !== fallbackUrl) {
                  (e.target as HTMLImageElement).src = fallbackUrl;
                } else {
                  setError("Failed to load image");
                }
              }}
            />
            <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={handleDownload}
                className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
                title="Download"
              >
                <Download className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : null}
        <div className="px-3 py-2 text-xs text-zinc-400 flex items-center gap-2 border-t border-white/5">
          <Icon className="w-3.5 h-3.5" />
          {file.filename}
        </div>
      </div>
    );
  }
  
  // Non-image file (documents like xlsx, pptx, docx, pdf)
  return (
    <div className="mt-2 flex items-center gap-2 p-3 rounded-xl bg-white/5 border border-white/10">
      <Icon className="w-5 h-5 text-emerald-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white truncate">{file.filename}</div>
        <div className="text-xs text-zinc-500">
          {file.mime_type || "Document"}
        </div>
      </div>
      <button
        onClick={handleDownload}
        className="p-2 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors flex-shrink-0"
        title="Download"
      >
        <Download className="w-4 h-4" />
      </button>
    </div>
  );
}

// Component to render a message with visualizations
function MessageContent({
  message,
  agentId
}: {
  message: StoredMessage;
  agentId: string;
}) {
  const { text, files: parsedFiles } = parseMessageContent(message.content);
  // Support both old 'files' and new 'generated_files' metadata keys
  const metadataFiles = message.metadata?.generated_files || message.metadata?.files || [];

  // Merge files, preferring metadata (has storage_path/url) over parsed (just file_id)
  const allFiles = [...metadataFiles];
  for (const pf of parsedFiles) {
    if (!allFiles.some(f => f.file_id === pf.file_id)) {
      allFiles.push(pf);
    }
  }

  return (
    <div>
      <div className="whitespace-pre-wrap">{text}</div>
      {/* Debug info - TEMPORARY */}
      <div className="text-[9px] text-zinc-600 mt-1">
        [meta:{metadataFiles.length} parsed:{parsedFiles.length} total:{allFiles.length}]
      </div>
      {allFiles.length > 0 && (
        <div className="mt-2 space-y-2">
          {allFiles.map((file) => (
            <VisualizationPreview
              key={file.file_id}
              file={file}
              agentId={agentId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function DatagranPanel({
  agentId,
  agentName,
  onUpdate,
}: {
  agentId: string;
  agentName: string;
  onUpdate?: (data: {
    lastSessionId: string;
    lastMessage?: { role: "user" | "assistant"; content: string };
    status?: "running" | "ready" | "error" | "awaiting-auth";
  }) => void;
}) {
  const [config, setConfig] = useState<DatagranConfigRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [authenticating, setAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);

  // Chat state
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [localInput, setLocalInput] = useState("");
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Debug state for mobile troubleshooting (temporary)
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const addDebugLog = (msg: string) => {
    setDebugLogs(prev => [...prev.slice(-20), `${new Date().toLocaleTimeString()}: ${msg}`]);
  };
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const onUpdateRef = useRef(onUpdate);

  // Keep onUpdate ref current
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  const lastSessionStorageKey = useMemo(
    () => `groovy:datagran:lastSession:${agentId}`,
    [agentId]
  );

  // Auto-scroll to bottom when messages change (block: "nearest" prevents scrolling ancestors)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, streamingText]);

  // Load Datagran widget script
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.DatagranLink) {
      setScriptLoaded(true);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://www.datagran.io/embed/link.js";
    script.async = true;
    script.onload = () => setScriptLoaded(true);
    script.onerror = () => setAuthError("Failed to load Datagran widget");
    document.head.appendChild(script);
  }, []);

  // Load config
  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("datagran_agent_configs")
        .select("provider, connection_id")
        .eq("agent_id", agentId)
        .single();

      if (error || !data) {
        setConfig(null);
        return;
      }
      setConfig(data as DatagranConfigRow);

      // No-auth providers (like web_pixel) don't need connection_id
      const isNoAuthProvider = NO_AUTH_PROVIDERS.includes(data.provider);
      if (!data.connection_id && !isNoAuthProvider) {
        onUpdateRef.current?.({ lastSessionId: "", status: "awaiting-auth" });
      }
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    loadConfig().catch(() => {});
  }, [loadConfig]);

  // Handle authentication
  const handleAuthenticate = useCallback(async () => {
    if (!scriptLoaded || !window.DatagranLink) {
      setAuthError("Datagran widget not loaded. Please refresh the page.");
      return;
    }

    setAuthenticating(true);
    setAuthError(null);

    try {
      const res = await fetch("/api/datagran/link-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to get link token");
      }

      const linkToken = json.linkToken || json.link_token;
      if (!linkToken) {
        throw new Error("No link token in response");
      }

      window.DatagranLink.open({
        linkToken,
        onSuccess: async (payload) => {
          try {
            const saveRes = await fetch("/api/datagran/connection", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                agentId,
                connectionId: payload.connection_id,
              }),
            });

            if (!saveRes.ok) {
              const saveJson = await saveRes.json();
              throw new Error(saveJson.error || "Failed to save connection");
            }

            await loadConfig();
            onUpdateRef.current?.({ lastSessionId: activeSessionId || "", status: "ready" });
          } catch (e) {
            setAuthError(e instanceof Error ? e.message : "Failed to save connection");
          }
          setAuthenticating(false);
        },
        onExit: () => {
          setAuthenticating(false);
        },
      });
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "Authentication failed");
      setAuthenticating(false);
    }
  }, [agentId, scriptLoaded, loadConfig, activeSessionId]);

  // Session management
  const loadSessions = async () => {
    const res = await fetch(`/api/chat/sessions?agentId=${encodeURIComponent(agentId)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || "Failed to load sessions");
    const list = (json.sessions || []) as ChatSession[];
    setSessions(list);
    if (!activeSessionId && list.length > 0) {
      try {
        const stored = window.localStorage.getItem(lastSessionStorageKey);
        const found = list.find((s) => s.id === stored);
        setActiveSessionId(found ? found.id : list[0].id);
      } catch {
        setActiveSessionId(list[0].id);
      }
    }
  };

  const createSession = async () => {
    const res = await fetch("/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, title: "New chat" }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || "Failed to create session");
    const created = json.session as ChatSession;
    setSessions((prev) => [created, ...prev]);
    setActiveSessionId(created.id);
    onUpdateRef.current?.({ lastSessionId: created.id });
    return created.id;
  };

  const deleteSession = async (sessionId: string) => {
    setDeletingSessionId(sessionId);
    try {
      const res = await fetch(`/api/chat/sessions?id=${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to delete session");
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        const next = sessions.find((s) => s.id !== sessionId);
        const nextId = next ? next.id : null;
        setActiveSessionId(nextId);
        try {
          if (nextId) {
            window.localStorage.setItem(lastSessionStorageKey, nextId);
          } else {
            window.localStorage.removeItem(lastSessionStorageKey);
          }
        } catch {
          // ignore
        }
        setMessages([]);
      }
    } finally {
      setDeletingSessionId(null);
    }
  };

  const loadHistory = async (sessionId: string) => {
    setLoadingHistory(true);
    try {
      const res = await fetch(
        `/api/chat/messages?sessionId=${encodeURIComponent(sessionId)}`
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Failed to load messages");
      const loadedMessages = (json.messages || []) as StoredMessage[];
      setMessages(loadedMessages);

      if (loadedMessages.length > 0) {
        const last = loadedMessages[loadedMessages.length - 1];
        if (last.role === "user" || last.role === "assistant") {
          onUpdateRef.current?.({
            lastSessionId: sessionId,
            lastMessage: { role: last.role, content: last.content },
          });
        }
      }
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    // Load sessions if we have a connection OR if it's a no-auth provider
    const shouldLoadSessions = config?.connection_id || (config?.provider && NO_AUTH_PROVIDERS.includes(config.provider));
    if (shouldLoadSessions) {
      loadSessions().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, config?.connection_id, config?.provider]);

  useEffect(() => {
    if (activeSessionId) {
      loadHistory(activeSessionId).catch(() => {});
      setStreamingText("");
      setError(null);
      try {
        window.localStorage.setItem(lastSessionStorageKey, activeSessionId);
      } catch {
        // ignore
      }
    }
  }, [activeSessionId, lastSessionStorageKey]);

  const handleSend = async () => {
    if (!localInput.trim() || sending) return;

    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = await createSession();
    }
    if (!sessionId) return;

    const text = localInput.trim();
    setLocalInput("");
    setSending(true);
    setError(null);
    setStreamingText("");

    onUpdateRef.current?.({
      lastSessionId: sessionId,
      lastMessage: { role: "user", content: text },
      status: "running",
    });

    const userMsg: StoredMessage = {
      id: `temp-user-${Date.now()}`,
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);

    const apiMessages = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      abortRef.current = new AbortController();

      const res = await fetch("/api/datagran/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          sessionId,
          messages: apiMessages,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson?.error || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedText = "";
      const streamedFiles: FileInfo[] = [];

      // Helper to process a single SSE line
      const processLine = (line: string) => {
        if (!line.startsWith("data: ")) return;
        try {
          const jsonStr = line.slice(6);
          const data = JSON.parse(jsonStr);

          if (data.type === "clear_text") {
            // Server signals a new iteration is starting — discard intermediate
            // scaffolding text so it doesn't get concatenated with the final response.
            accumulatedText = "";
            setStreamingText("");
          } else if (data.type === "text") {
            accumulatedText += data.text;
            setStreamingText(accumulatedText);
          } else if (data.type === "status") {
            addDebugLog(`status: ${data.text}`);
          } else if (data.type === "file") {
            addDebugLog(`FILE: ${data.file?.filename} url:${!!data.file?.url} path:${!!data.file?.storage_path}`);
            streamedFiles.push(data.file);
          } else if (data.type === "error") {
            throw new Error(data.error);
          } else if (data.type === "done") {
            addDebugLog(`DONE: ${data.files?.length || 0} files in event, ${streamedFiles.length} streamed`);
            if (data.files?.length > 0) {
              for (const f of data.files) {
                if (!streamedFiles.some(sf => sf.file_id === f.file_id)) {
                  addDebugLog(`Adding from done: ${f.filename}`);
                  streamedFiles.push(f);
                }
              }
            }
            addDebugLog(`Final streamedFiles: ${streamedFiles.length}`);
          }
        } catch (parseErr) {
          addDebugLog(`PARSE ERR: ${parseErr}`);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          processLine(line);
        }
      }

      // Safari-friendly: process any remaining buffer content after stream ends
      // (handles case where final SSE event doesn't end with newline)
      addDebugLog(`Stream ended. Buffer remaining: ${buffer.length} chars`);
      if (buffer.trim()) {
        addDebugLog(`Processing remaining buffer...`);
        processLine(buffer);
      }

      // Create the assistant message with accumulated text and files
      addDebugLog(`FINISHED: ${streamedFiles.length} files, ${accumulatedText.length} chars text`);
      const responseContent = accumulatedText || (streamedFiles.length > 0 ? "[File operation completed]" : "");

      if (responseContent || streamedFiles.length > 0) {
        const assistantMsg: StoredMessage = {
          id: `temp-assistant-${Date.now()}`,
          role: "assistant",
          content: responseContent,
          metadata: streamedFiles.length > 0 ? { generated_files: streamedFiles } : undefined,
        };
        addDebugLog(`Msg metadata files: ${assistantMsg.metadata?.generated_files?.length || 0}`);
        setMessages((prev) => [...prev, assistantMsg]);

        onUpdateRef.current?.({
          lastSessionId: sessionId,
          lastMessage: { role: "assistant", content: responseContent },
          status: "ready",
        });
      } else {
        onUpdateRef.current?.({
          lastSessionId: sessionId,
          status: "ready",
        });
      }
      setStreamingText("");

      loadSessions().catch(() => {});
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to send message");
      setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      if (sessionId) {
        onUpdateRef.current?.({
          lastSessionId: sessionId,
          status: "error",
        });
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  const title = useMemo(() => {
    const provider = config?.provider
      ? DATAGRAN_PROVIDER_LABELS[config.provider]
      : "Not configured";
    return `${agentName} • ${provider}`;
  }, [agentName, config?.provider]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading Datagran config…
      </div>
    );
  }

  if (!config) {
    return (
      <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
        <div className="flex items-center gap-2 text-sm text-zinc-300">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          This Datagran agent isn&apos;t configured yet.
        </div>
      </div>
    );
  }

  // Check if this provider requires OAuth authentication
  const isNoAuthProvider = NO_AUTH_PROVIDERS.includes(config.provider);

  // Show authentication UI if no connection (only for OAuth providers)
  if (!config.connection_id && !isNoAuthProvider) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Datagran
            </h4>
            <div className="text-sm text-white truncate">{title}</div>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-violet-500/10 border border-violet-500/20 mb-4">
              <ExternalLink className="w-8 h-8 text-violet-400" />
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">
              Connect {DATAGRAN_PROVIDER_LABELS[config.provider]}
            </h3>
            <p className="text-sm text-zinc-400 mb-6">
              Authenticate with {DATAGRAN_PROVIDER_LABELS[config.provider]} to start
              querying and visualizing your data with AI.
            </p>

            <button
              onClick={handleAuthenticate}
              disabled={authenticating || !scriptLoaded}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-violet-500 to-violet-600 text-white font-medium hover:from-violet-400 hover:to-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {authenticating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Authenticating…
                </>
              ) : (
                <>
                  <ExternalLink className="w-4 h-4" />
                  Connect {DATAGRAN_PROVIDER_LABELS[config.provider]}
                </>
              )}
            </button>

            {authError && (
              <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                {authError}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Chat content component (reused in both inline and expanded views)
  const chatContent = (isExpanded: boolean) => (
    <>
      <div className={`flex-1 min-h-0 overflow-auto rounded-2xl bg-black/30 border border-white/10 p-4 ${isExpanded ? "text-base" : ""}`}>
        {loadingHistory ? (
          <div className="flex items-center gap-2 text-zinc-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        ) : messages.length === 0 && !streamingText ? (
          <div className={`text-zinc-500 ${isExpanded ? "text-base" : "text-sm"}`}>
            Ask questions about your {DATAGRAN_PROVIDER_LABELS[config.provider]} data.
            I&apos;ll fetch, analyze, and visualize it for you.
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((m) => (
              <div key={m.id} className="flex">
                <div
                  className={`rounded-2xl px-4 py-3 leading-relaxed ${
                    isExpanded ? "max-w-[70%] text-base" : "max-w-[85%] text-sm"
                  } ${
                    m.role === "user"
                      ? "ml-auto bg-violet-500/15 border border-violet-500/20 text-white"
                      : "bg-white/5 border border-white/10 text-zinc-200"
                  }`}
                >
                  {m.role === "assistant" ? (
                    <MessageContent message={m} agentId={agentId} />
                  ) : (
                    <div className="whitespace-pre-wrap">{m.content}</div>
                  )}
                </div>
              </div>
            ))}
            {streamingText && (
              <div className="flex">
                <div className={`rounded-2xl px-4 py-3 leading-relaxed bg-white/5 border border-white/10 text-zinc-200 ${
                  isExpanded ? "max-w-[70%] text-base" : "max-w-[85%] text-sm"
                }`}>
                  <MessageContent 
                    message={{ id: "streaming", role: "assistant", content: streamingText }} 
                    agentId={agentId} 
                  />
                </div>
              </div>
            )}
            {sending && !streamingText && (
              <div className="flex items-center gap-2 text-zinc-400 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Analyzing data…
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="mt-4 flex items-end gap-2"
      >
        <textarea
          value={localInput}
          onChange={(e) => setLocalInput(e.target.value)}
          placeholder="Ask about your data… (e.g., 'Show me campaign performance for the last 30 days')"
          rows={isExpanded ? 3 : 2}
          className={`flex-1 bg-black/30 rounded-2xl px-4 py-3 text-white placeholder-zinc-500 outline-none border border-white/10 focus:border-violet-500/50 transition-colors resize-none ${
            isExpanded ? "text-base" : "text-sm"
          }`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          type="submit"
          disabled={sending || !localInput.trim()}
          className={`rounded-2xl bg-gradient-to-r from-violet-500 to-violet-600 text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
            isExpanded ? "px-6 py-3 text-base" : "px-4 py-3"
          }`}
        >
          Send
        </button>
      </form>

      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}

      {/* Debug panel for mobile troubleshooting - TEMPORARY */}
      {debugLogs.length > 0 && (
        <div className="mt-2 p-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-[10px] text-yellow-300 font-mono max-h-32 overflow-auto">
          <div className="font-bold mb-1">DEBUG:</div>
          {debugLogs.map((log, i) => (
            <div key={i}>{log}</div>
          ))}
        </div>
      )}
    </>
  );

  // Expanded modal
  const expandedModal = expanded && typeof document !== "undefined" ? createPortal(
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={() => setExpanded(false)}
    >
      <div 
        className="w-full max-w-5xl h-[90vh] bg-zinc-900 rounded-3xl border border-white/10 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">{title}</h2>
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-xs">
                  <CheckCircle2 className="w-3 h-3" />
                  {isNoAuthProvider ? "Ready" : "Connected"}
                </span>
                <span>•</span>
                <span>Powered by Claude Opus 4.5</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SessionPicker
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={(id) => {
                setActiveSessionId(id);
                onUpdateRef.current?.({ lastSessionId: id });
              }}
              onNew={() => createSession().catch(() => {})}
              onDelete={(id) => deleteSession(id).catch(() => {})}
              deletingId={deletingSessionId}
            />
            <button
              onClick={() => setExpanded(false)}
              className="p-2 rounded-xl hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        
        {/* Chat content */}
        <div className="flex-1 flex flex-col min-h-0 p-6">
          {chatContent(true)}
        </div>
      </div>
    </div>,
    document.body
  ) : null;

  // Show chat UI when connected
  return (
    <>
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Datagran
            </h4>
            <div className="text-sm text-white truncate flex items-center gap-2">
              {title}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-xs">
                <CheckCircle2 className="w-3 h-3" />
                {isNoAuthProvider ? "Ready" : "Connected"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setExpanded(true)}
              className="p-2 rounded-xl hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
              title="Expand chat"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <SessionPicker
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={(id) => {
                setActiveSessionId(id);
                onUpdateRef.current?.({ lastSessionId: id });
              }}
              onNew={() => createSession().catch(() => {})}
              onDelete={(id) => deleteSession(id).catch(() => {})}
              deletingId={deletingSessionId}
            />
          </div>
        </div>

        {chatContent(false)}
      </div>
      
      {expandedModal}
    </>
  );
}
