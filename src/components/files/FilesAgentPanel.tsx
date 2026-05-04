"use client";

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { Loader2, Paperclip, X, Download, FileSpreadsheet, FileText, Presentation, File, Square, Copy, Check } from "lucide-react";
import { SessionPicker, type ChatSession } from "@/components/chat/SessionPicker";

type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at?: string;
  metadata?: {
    files?: Array<{ id: string; name: string }>;
    generated_files?: Array<{ name: string; mediaType: string; url?: string }>;
    [k: string]: unknown;
  };
};

type UploadedFile = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  anthropicFileId?: string;
};

type PendingFile = {
  id: string;
  file: File;
  uploading: boolean;
  error?: string;
  uploaded?: UploadedFile;
};

const SUPPORTED_EXTENSIONS = ".xlsx,.pptx,.docx,.pdf";
const SUPPORTED_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
].join(",");

function getFileIcon(name: string) {
  const ext = name.toLowerCase().split(".").pop();
  switch (ext) {
    case "xlsx":
    case "xls":
      return FileSpreadsheet;
    case "docx":
    case "doc":
      return FileText;
    case "pptx":
    case "ppt":
      return Presentation;
    default:
      return File;
  }
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesAgentPanel({
  agentId,
  agentName,
  onUpdate,
  initialSessionId,
}: {
  agentId: string;
  agentName: string;
  onUpdate?: (data: {
    lastSessionId: string;
    lastMessage?: { role: "user" | "assistant"; content: string };
    status?: "running" | "ready" | "error";
  }) => void;
  initialSessionId?: string | null;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [localInput, setLocalInput] = useState("");
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const copyToClipboard = useCallback(async (text: string, messageId: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(messageId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopiedId(messageId);
      setTimeout(() => setCopiedId(null), 2000);
    }
  }, []);

  const lastSessionStorageKey = useMemo(
    () => `groovy:files-agent:lastSession:${agentId}`,
    [agentId]
  );

  const loadSessions = async (autoSelect = false) => {
    const res = await fetch(`/api/chat/sessions?agentId=${encodeURIComponent(agentId)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || "Failed to load sessions");
    const list = (json.sessions || []) as ChatSession[];
    setSessions(list);

    if (list.length > 0 && autoSelect) {
      try {
        const stored = window.localStorage.getItem(lastSessionStorageKey);
        const found = list.find((s) => s.id === stored);
        setActiveSessionId(found ? found.id : list[0].id);
      } catch {
        setActiveSessionId(list[0].id);
      }
    }
  };

  const createSession = useCallback(async () => {
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
    setMessages([]);
    onUpdate?.({ lastSessionId: created.id });
    return created.id;
  }, [agentId, onUpdate]);

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

  // Store onUpdate in a ref to avoid re-creating loadHistory when onUpdate changes
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  const loadHistory = useCallback(async (sessionId: string) => {
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
  }, []);

  // Track the previous agentId to detect actual changes vs remounts
  const prevAgentIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Only reset if the agentId actually changed (not just a remount)
    const agentChanged = prevAgentIdRef.current !== null && prevAgentIdRef.current !== agentId;
    prevAgentIdRef.current = agentId;

    if (agentChanged) {
      setActiveSessionId(null);
      setMessages([]);
      setPendingFiles([]);
      setError(null);
    }

    // Load sessions, but only auto-select if no initialSessionId is provided
    loadSessions(!initialSessionId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Allow parent to drive the active session (e.g. "paired" orchestrator session)
  // This effect should run AFTER the agentId effect loads sessions
  useEffect(() => {
    if (initialSessionId) {
      setActiveSessionId(initialSessionId);
    }
  }, [initialSessionId]);

  useEffect(() => {
    if (activeSessionId) {
      loadHistory(activeSessionId).catch(() => {});
      setError(null);
      try {
        window.localStorage.setItem(lastSessionStorageKey, activeSessionId);
      } catch {
        // ignore
      }
    }
  }, [activeSessionId, lastSessionStorageKey, loadHistory]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    
    // Capture files before clearing input
    const fileList = Array.from(files);
    e.target.value = "";

    // Add all files to pending state IMMEDIATELY
    const fileEntries: Array<{ pendingId: string; file: File }> = [];
    for (const file of fileList) {
      const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fileEntries.push({ pendingId, file });
    }
    
    // Update state with all files at once
    setPendingFiles((prev) => [
      ...prev,
      ...fileEntries.map(({ pendingId, file }) => ({
        id: pendingId,
        file,
        uploading: true,
      })),
    ]);

    // Now create session if needed
    let sessionId = activeSessionId;
    if (!sessionId) {
      try {
        sessionId = await createSession();
      } catch {
        // Mark all pending files as errored
        setPendingFiles((prev) =>
          prev.map((p) =>
            fileEntries.some((fe) => fe.pendingId === p.id)
              ? { ...p, uploading: false, error: "Failed to create session" }
              : p
          )
        );
        setError("Failed to create session for upload");
        return;
      }
    }

    // Upload each file
    for (const { pendingId, file } of fileEntries) {
      try {
        const form = new FormData();
        form.set("sessionId", sessionId!);
        form.set("agentId", agentId);
        form.set("file", file);

        const res = await fetch("/api/files-agent/upload", {
          method: "POST",
          body: form,
        });

        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || "Upload failed");

        setPendingFiles((prev) =>
          prev.map((p) =>
            p.id === pendingId
              ? {
                  ...p,
                  uploading: false,
                  uploaded: {
                    id: String(json.attachmentId || ""),
                    // Prefer server-returned fileName, fallback to original File object name
                    name: String(json.fileName || file.name || "upload"),
                    size: json.size,
                    mimeType: json.mimeType,
                    anthropicFileId: json.anthropicFileId,
                  },
                }
              : p
          )
        );
      } catch (err) {
        setPendingFiles((prev) =>
          prev.map((p) =>
            p.id === pendingId
              ? {
                  ...p,
                  uploading: false,
                  error: err instanceof Error ? err.message : "Upload failed",
                }
              : p
          )
        );
      }
    }
  };

  const removePendingFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setSending(false);
      if (activeSessionId) {
        onUpdate?.({ lastSessionId: activeSessionId, status: "ready" });
      }
    }
  }, [activeSessionId, onUpdate]);

  const handleSend = async () => {
    if (!localInput.trim() || sending) return;

    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = await createSession();
    }
    if (!sessionId) return;

    const text = localInput.trim();
    const filesToSend = pendingFiles.filter((p) => p.uploaded && !p.error);
    setLocalInput("");
    setPendingFiles([]);
    setSending(true);
    setError(null);

    onUpdate?.({
      lastSessionId: sessionId,
      lastMessage: { role: "user", content: text },
      status: "running",
    });

    const userMsg: StoredMessage = {
      id: `temp-user-${Date.now()}`,
      role: "user",
      content: text,
      metadata: filesToSend.length > 0
        ? { files: filesToSend.map((f) => ({ id: f.uploaded!.id, name: f.uploaded!.name })) }
        : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);

    const apiMessages = [...messages].map((m) => ({
      role: m.role,
      content: m.content,
    }));
    apiMessages.push({ role: "user" as const, content: text });

    try {
      abortRef.current = new AbortController();

      const res = await fetch("/api/files-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          sessionId,
          messages: apiMessages,
          files: filesToSend.map((f) => ({
            id: f.uploaded!.id,
            name: f.uploaded!.name,
            anthropicFileId: f.uploaded!.anthropicFileId,
          })),
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(errText || `HTTP ${res.status}`);
      }

      // Create a placeholder assistant message for streaming
      const assistantMsgId = `temp-assistant-${Date.now()}`;
      let streamedText = "";
      const streamedFiles: Array<{ name: string; mediaType: string; url?: string }> = [];
      let liveStatus = "";
      let lastStatus = "";

      const updateAssistantPreview = () => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, content: `${streamedText}${liveStatus}` } : m
          )
        );
      };

      setMessages((prev) => [
        ...prev,
        { id: assistantMsgId, role: "assistant", content: "" },
      ]);

      // Read the SSE stream
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6);
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              // Ignore malformed SSE payloads.
              continue;
            }
            if (data.type === "text") {
              streamedText += String(data.text || "");
              liveStatus = "";
              updateAssistantPreview();
            } else if (data.type === "status") {
              const statusText = String(data.text || "").trim();
              if (statusText && statusText !== lastStatus) {
                lastStatus = statusText;
                liveStatus = `${streamedText ? "\n\n" : ""}[${statusText}]`;
                updateAssistantPreview();
              }
            } else if (data.type === "file" && data.file) {
              streamedFiles.push(data.file as { name: string; mediaType: string; url?: string });
            } else if (data.type === "error") {
              throw new Error(String(data.error || "Files agent error"));
            } else if (data.type === "done") {
              // Update final message with files
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        content: streamedText || "[File operation completed]",
                        metadata: streamedFiles.length > 0 ? { generated_files: streamedFiles } : undefined,
                      }
                    : m
                )
              );
            }
          }
        }
      }

      // Safari-friendly: process any remaining buffer content after stream ends
      if (buffer.trim() && buffer.startsWith("data: ")) {
        const payload = buffer.slice(6);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          data = {};
        }
        if (data.type === "text") {
          streamedText += String(data.text || "");
          liveStatus = "";
          updateAssistantPreview();
        } else if (data.type === "status") {
          const statusText = String(data.text || "").trim();
          if (statusText && statusText !== lastStatus) {
            lastStatus = statusText;
            liveStatus = `${streamedText ? "\n\n" : ""}[${statusText}]`;
            updateAssistantPreview();
          }
        } else if (data.type === "file" && data.file) {
          streamedFiles.push(data.file as { name: string; mediaType: string; url?: string });
        } else if (data.type === "done") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: streamedText || "[File operation completed]",
                    metadata: streamedFiles.length > 0 ? { generated_files: streamedFiles } : undefined,
                  }
                : m
            )
          );
        } else if (data.type === "error") {
          throw new Error(String(data.error || "Files agent error"));
        }
      }

      onUpdate?.({
        lastSessionId: sessionId,
        lastMessage: { role: "assistant", content: streamedText || "[File operation completed]" },
        status: "ready",
      });

      loadSessions().catch(() => {});
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to send message");
      // Remove both user and any streaming assistant messages
      setMessages((prev) => prev.filter((m) => !m.id.startsWith("temp-")));
      if (sessionId) {
        onUpdate?.({
          lastSessionId: sessionId,
          status: "error",
        });
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  const title = `${agentName} • ANTHROPIC:claude-opus-4.6`;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            Files Agent
          </h4>
          <div className="text-sm text-white truncate">{title}</div>
        </div>

        <SessionPicker
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={(id) => {
            setActiveSessionId(id);
            onUpdate?.({ lastSessionId: id });
          }}
          onNew={async () => {
            try {
              await createSession();
            } catch (error) {
              console.error("Failed to create new session:", error);
              setError("Failed to create new session");
            }
          }}
          onDelete={(id) => deleteSession(id).catch(() => {})}
          deletingId={deletingSessionId}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-auto rounded-2xl bg-black/30 border border-white/10 p-4">
        {loadingHistory ? (
          <div className="flex items-center gap-2 text-zinc-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
            <div className="text-sm text-zinc-500">
              <div className="mb-4">
                <h4 className="text-base font-medium text-white mb-2">Files Agent Ready</h4>
                <p>Upload Excel, Word, PowerPoint, or PDF files for analysis.</p>
                <p className="mt-2 text-xs text-zinc-600">
                  Supports: .xlsx, .docx, .pptx, .pdf
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <div key={m.id} className="flex group">
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap relative ${
                    m.role === "user"
                      ? "ml-auto bg-cyan-500/15 border border-cyan-500/20 text-white"
                      : "bg-white/5 border border-white/10 text-zinc-200"
                  }`}
                >
                  {/* Copy button for assistant messages */}
                  {m.role === "assistant" && m.content && (
                    <button
                      type="button"
                      onClick={() => copyToClipboard(m.content, m.id)}
                      className="absolute top-2 right-2 p-1.5 rounded-lg bg-white/5 border border-white/10 text-zinc-400 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all"
                      title="Copy to clipboard"
                    >
                      {copiedId === m.id ? (
                        <Check className="w-3.5 h-3.5 text-green-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                  {/* Show attached files for user messages */}
                  {m.role === "user" && Array.isArray(m.metadata?.files) && m.metadata.files.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {m.metadata.files.map((f, idx) => {
                        const Icon = getFileIcon(f.name);
                        return (
                          <div
                            key={`${m.id}-file-${idx}`}
                            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-cyan-500/20 border border-cyan-500/30 text-xs"
                          >
                            <Icon className="w-3.5 h-3.5" />
                            <span className="truncate max-w-[150px]">{f.name}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {m.content}

                  {/* Show generated files for assistant messages */}
                  {m.role === "assistant" &&
                    Array.isArray(m.metadata?.generated_files) &&
                    m.metadata.generated_files.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {m.metadata.generated_files.map((f, idx) => {
                          const Icon = getFileIcon(f.name);
                          return (
                            <div
                              key={`${m.id}-gen-${idx}`}
                              className="flex items-center gap-2 p-2 rounded-lg bg-white/5 border border-white/10"
                            >
                              <Icon className="w-5 h-5 text-emerald-400" />
                              <span className="flex-1 truncate text-sm">{f.name}</span>
                              {f.url && (
                                <a
                                  href={f.url}
                                  download={f.name}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
                                >
                                  <Download className="w-4 h-4" />
                                </a>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-zinc-400 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Processing…
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pending file uploads */}
      {pendingFiles.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {pendingFiles.map((pf) => {
            const Icon = getFileIcon(pf.file.name);
            return (
              <div
                key={pf.id}
                className={`relative group flex items-center gap-2 px-3 py-2 rounded-lg border ${
                  pf.error
                    ? "bg-red-500/10 border-red-500/30"
                    : pf.uploading
                    ? "bg-white/5 border-white/10"
                    : "bg-emerald-500/10 border-emerald-500/30"
                }`}
              >
                {pf.uploading ? (
                  <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
                ) : (
                  <Icon className={`w-4 h-4 ${pf.error ? "text-red-400" : "text-emerald-400"}`} />
                )}
                <div className="min-w-0">
                  <div className="text-xs text-white truncate max-w-[150px]">{pf.file.name}</div>
                  <div className="text-[10px] text-zinc-500">
                    {pf.error || formatFileSize(pf.file.size)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removePendingFile(pf.id)}
                  className="p-1 rounded-full bg-white/10 text-zinc-400 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* File input - outside form to avoid interference */}
      <input
        ref={fileInputRef}
        type="file"
        accept={`${SUPPORTED_EXTENSIONS},${SUPPORTED_MIME_TYPES}`}
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="mt-4 flex items-end gap-2"
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
          className="p-3 rounded-2xl bg-black/30 border border-white/10 text-zinc-400 hover:text-white hover:border-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Attach files (xlsx, pptx, docx, pdf)"
        >
          <Paperclip className="w-5 h-5" />
        </button>

        <textarea
          data-flow-chat-input="true"
          value={localInput}
          onChange={(e) => setLocalInput(e.target.value)}
          placeholder="Describe what you want to do with your files…"
          rows={2}
          className="flex-1 bg-black/30 rounded-2xl px-4 py-3 text-sm text-white placeholder-zinc-500 outline-none border border-white/10 focus:border-cyan-500/50 transition-colors resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        {sending ? (
          <button
            type="button"
            onClick={handleStop}
            className="px-4 py-3 rounded-2xl bg-red-500/80 hover:bg-red-500 text-white font-medium transition-colors flex items-center gap-2"
          >
            <Square className="w-4 h-4 fill-current" />
            Stop
          </button>
        ) : (
          <button
            data-flow-chat-send="true"
            type="submit"
            disabled={!localInput.trim() && pendingFiles.filter((p) => p.uploaded).length === 0}
            className="px-4 py-3 rounded-2xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
        )}
      </form>

      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
    </div>
  );
}
