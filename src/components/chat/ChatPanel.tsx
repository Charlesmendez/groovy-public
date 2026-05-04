"use client";

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { Loader2, ImagePlus, X, Copy, Check } from "lucide-react";
import { SessionPicker, type ChatSession } from "@/components/chat/SessionPicker";
import { FileUpload } from "@/components/chat/FileUpload";
import { ActiveCapabilitiesPanel } from "@/components/skills/ActiveCapabilitiesPanel";

type PendingImage = {
  id: string;
  file: File;
  preview: string;
  base64: string;
};

type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at?: string;
  metadata?: {
    files?: Array<{ mediaType: string; base64: string }>;
    images?: Array<{ mediaType: string; base64: string }>;
    [k: string]: unknown;
  };
};

type Attachment = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at?: string;
};

export function ChatPanel({
  agentId,
  agentName,
  provider,
  model,
  onUpdate,
}: {
  agentId: string;
  agentName: string;
  provider: string | null;
  model: string | null;
  onUpdate?: (data: { 
    lastSessionId: string; 
    lastMessage?: { role: "user" | "assistant"; content: string };
    status?: "running" | "ready" | "error";
  }) => void;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [localInput, setLocalInput] = useState("");
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

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
    () => `groovy:ai-chat:lastSession:${agentId}`,
    [agentId]
  );

  const loadSessions = async (autoSelect = false) => {
    const res = await fetch(`/api/chat/sessions?agentId=${encodeURIComponent(agentId)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || "Failed to load sessions");
    const list = (json.sessions || []) as ChatSession[];
    setSessions(list);
    
    if (list.length > 0 && autoSelect) {
      // Try to restore last used session from localStorage, otherwise select first
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
    // Clear messages and attachments for the new session
    setMessages([]);
    setAttachments([]);
    // Notify parent of session change
    onUpdate?.({ lastSessionId: created.id });
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
        // Pick the next most recent session if any
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
        setAttachments([]);
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
      setAttachments((json.attachments || []) as Attachment[]);
      
      // Notify parent with last message
      if (loadedMessages.length > 0) {
        const last = loadedMessages[loadedMessages.length - 1];
        if (last.role === "user" || last.role === "assistant") {
          onUpdate?.({
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
    // Reset state when agent changes
    setActiveSessionId(null);
    setMessages([]);
    setAttachments([]);
    setStreamingText("");
    setError(null);
    loadSessions(true).catch(() => {}); // autoSelect=true to pick a session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

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

  // Do not auto-create sessions on mount; we'll create on first send or when the user clicks "New Chat".

  const handleSend = async () => {
    if (!localInput.trim() || sending) return;
    
    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = await createSession();
    }
    if (!sessionId) return;

    const text = localInput.trim();
    const imagesToSend = [...pendingImages];
    setLocalInput("");
    setPendingImages([]);
    setSending(true);
    setError(null);
    setStreamingText("");

    // Cleanup image preview URLs
    imagesToSend.forEach((img) => URL.revokeObjectURL(img.preview));

    // Notify parent that we're running
    onUpdate?.({
      lastSessionId: sessionId,
      lastMessage: { role: "user", content: text },
      status: "running",
    });

    // Optimistically add user message with images
    const userImages = imagesToSend.map((img) => ({
      mediaType: img.file.type,
      base64: img.base64,
    }));
    const userMsg: StoredMessage = {
      id: `temp-user-${Date.now()}`,
      role: "user",
      content: text,
      metadata: userImages.length > 0 ? { images: userImages } : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);

    // Build messages array for API (only text content for history messages)
    const apiMessages = [...messages].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Add current user message with images if any
    const currentUserMessage = imagesToSend.length > 0
      ? {
          role: "user" as const,
          content: text,
          images: imagesToSend.map((img) => ({
            mediaType: img.file.type,
            base64: img.base64,
          })),
        }
      : { role: "user" as const, content: text };
    apiMessages.push(currentUserMessage);

    try {
      abortRef.current = new AbortController();
      
      const res = await fetch("/api/chat", {
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

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const json = await res.json().catch(() => ({}));
        const assistantText = typeof json?.text === "string" ? json.text : "";
        const files = Array.isArray(json?.files) ? json.files : [];

        const assistantMsg: StoredMessage = {
          id: `temp-assistant-${Date.now()}`,
          role: "assistant",
          content: assistantText || "[generated image]",
          metadata: { files },
        };
        setMessages((prev) => [...prev, assistantMsg]);

        onUpdate?.({
          lastSessionId: sessionId,
          lastMessage: { role: "assistant", content: assistantMsg.content },
          status: "ready",
        });
        setStreamingText("");
        loadSessions().catch(() => {});
        return;
      }

      // Stream the response (plain text stream)
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;
        setStreamingText(accumulated);
      }

      // Add assistant message when done
      if (accumulated) {
        const assistantMsg: StoredMessage = {
          id: `temp-assistant-${Date.now()}`,
          role: "assistant",
          content: accumulated,
        };
        setMessages((prev) => [...prev, assistantMsg]);
        
        // Notify parent of the update with status back to awaiting-input
        onUpdate?.({
          lastSessionId: sessionId,
          lastMessage: { role: "assistant", content: accumulated },
          status: "ready",
        });
      } else {
        // No response but still done
        onUpdate?.({
          lastSessionId: sessionId,
          status: "ready",
        });
      }
      setStreamingText("");
      
      // Refresh sessions to pick up updated title (set from first message)
      loadSessions().catch(() => {});
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to send message");
      // Remove optimistic user message on error
      setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      // Notify parent of error status
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

  const title = useMemo(() => {
    const p = provider ? provider.toUpperCase() : "MODEL";
    return `${agentName} • ${p}${model ? `:${model}` : ""}`;
  }, [agentName, model, provider]);

  // Check if provider supports images
  const supportsImages = provider === "openai" || provider === "anthropic";

  const handleImageSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;

    const newImages: PendingImage[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > 20 * 1024 * 1024) continue; // 20MB limit

      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Remove the data:image/xxx;base64, prefix
          resolve(result.split(",")[1]);
        };
        reader.readAsDataURL(file);
      });

      newImages.push({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        preview: URL.createObjectURL(file),
        base64,
      });
    }

    setPendingImages((prev) => [...prev, ...newImages].slice(0, 4)); // Max 4 images
    if (imageInputRef.current) imageInputRef.current.value = "";
  }, []);

  const removeImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            AI Chat
          </h4>
          <div className="text-sm text-white truncate">{title}</div>
        </div>

        <div className="flex items-center gap-2">
          {activeSessionId && provider === "openai" && (
            <FileUpload
              sessionId={activeSessionId}
              onUploaded={() => loadHistory(activeSessionId).catch(() => {})}
            />
          )}
          <SessionPicker
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={(id) => {
              setActiveSessionId(id);
              // Notify parent - will get last message from history load
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
      </div>

      <ActiveCapabilitiesPanel agentId={agentId} target="flow" />

      {attachments.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {attachments.slice(0, 6).map((a) => (
            <div
              key={a.id}
              className="px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-300"
              title={a.mime_type}
            >
              {a.file_name}
            </div>
          ))}
          {attachments.length > 6 && (
            <div className="px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-xs text-zinc-400">
              +{attachments.length - 6} more
            </div>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto rounded-2xl bg-black/30 border border-white/10 p-4">
        {loadingHistory ? (
          <div className="flex items-center gap-2 text-zinc-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        ) : messages.length === 0 && !streamingText ? (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
            <div className="text-sm text-zinc-500">
              {!activeSessionId && sessions.length > 0 ? (
                <>
                  <div className="mb-4">
                    <h4 className="text-base font-medium text-white mb-2">Ready to chat!</h4>
                    <p>Start a new conversation below, or select a previous session from the dropdown above.</p>
                  </div>
                </>
              ) : (
                "Start a conversation. Upload a document to ground the responses."
              )}
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
                  {/* User-uploaded images */}
                  {m.role === "user" &&
                    Array.isArray(m.metadata?.images) &&
                    m.metadata!.images!.length > 0 && (
                      <div className="mb-2 grid grid-cols-2 gap-2">
                        {m.metadata!.images!
                          .filter((f) => typeof f?.base64 === "string")
                          .slice(0, 4)
                          .map((f, idx) => (
                            <img
                              key={`${m.id}-uimg-${idx}`}
                              src={`data:${f.mediaType};base64,${f.base64}`}
                              alt="uploaded"
                              className="w-full rounded-lg border border-cyan-500/30"
                            />
                          ))}
                      </div>
                    )}
                  {m.content}
                  {/* Assistant-generated images */}
                  {m.role === "assistant" &&
                    Array.isArray(m.metadata?.files) &&
                    m.metadata!.files!.some((f) => String(f?.mediaType || "").startsWith("image/")) && (
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {m.metadata!.files!
                          .filter((f) => String(f?.mediaType || "").startsWith("image/") && typeof f?.base64 === "string")
                          .slice(0, 4)
                          .map((f, idx) => (
                            <img
                              key={`${m.id}-img-${idx}`}
                              src={`data:${f.mediaType};base64,${f.base64}`}
                              alt="generated"
                              className="w-full rounded-xl border border-white/10"
                            />
                          ))}
                      </div>
                    )}
                </div>
              </div>
            ))}
            {streamingText && (
              <div className="flex">
                <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap bg-white/5 border border-white/10 text-zinc-200">
                  {streamingText}
                </div>
              </div>
            )}
            {sending && !streamingText && (
              <div className="flex items-center gap-2 text-zinc-400 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Thinking…
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pending image previews */}
      {pendingImages.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {pendingImages.map((img) => (
            <div key={img.id} className="relative group">
              <img
                src={img.preview}
                alt="pending upload"
                className="w-16 h-16 object-cover rounded-lg border border-white/20"
              />
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="mt-4 flex items-end gap-2"
      >
        {/* Hidden file input */}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={handleImageSelect}
        />

        {/* Image upload button - only for supported providers */}
        {supportsImages && (
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            disabled={sending || pendingImages.length >= 4}
            className="p-3 rounded-2xl bg-black/30 border border-white/10 text-zinc-400 hover:text-white hover:border-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Attach images (max 4)"
          >
            <ImagePlus className="w-5 h-5" />
          </button>
        )}

        <textarea
          data-flow-chat-input="true"
          value={localInput}
          onChange={(e) => setLocalInput(e.target.value)}
          placeholder="Message…"
          rows={2}
          className="flex-1 bg-black/30 rounded-2xl px-4 py-3 text-sm text-white placeholder-zinc-500 outline-none border border-white/10 focus:border-cyan-500/50 transition-colors resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              const isMobile = window.matchMedia("(pointer: coarse)").matches;
              if (!isMobile) {
                e.preventDefault();
                handleSend();
              }
            }
          }}
        />
        <button
          data-flow-chat-send="true"
          type="submit"
          disabled={sending || (!localInput.trim() && pendingImages.length === 0)}
          className="px-4 py-3 rounded-2xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </form>

      {error && (
        <div className="mt-2 text-xs text-red-400">{error}</div>
      )}
    </div>
  );
}
