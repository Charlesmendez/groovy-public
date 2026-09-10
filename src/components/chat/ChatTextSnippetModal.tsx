"use client";

import { useEffect, useState } from "react";
import { FileText, X } from "lucide-react";
import {
  MAX_CHAT_SNIPPET_BYTES,
  validateChatTextSnippet,
  type ChatTextSnippet,
} from "@/lib/chat/snippets";

export function ChatTextSnippetModal({
  open,
  mode = "snippet",
  onClose,
  onAdd,
}: {
  open: boolean;
  mode?: "snippet" | "canvas";
  onClose: () => void;
  onAdd: (snippet: ChatTextSnippet) => void;
}) {
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;
  const sizeBytes = new TextEncoder().encode(content).byteLength;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chat-snippet-title"
    >
      <div className="flex max-h-[min(48rem,calc(100dvh-1.5rem))] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#111318] shadow-2xl">
        <header className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-3.5 sm:px-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/[0.07] text-cyan-200">
            <FileText className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="chat-snippet-title" className="text-sm font-semibold">
              {mode === "canvas" ? "Create a canvas" : "Add a text snippet"}
            </h2>
            <p className="mt-0.5 text-[10px] text-zinc-500">
              {mode === "canvas"
                ? "Share a long-form note that teammates can expand and download."
                : "Share long notes or code without crowding the conversation."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-white"
            aria-label="Close text snippet"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
            <label className="text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">
              Title
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={mode === "canvas" ? "Untitled canvas" : "Text snippet"}
                maxLength={120}
                className="mt-1.5 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm normal-case tracking-normal text-zinc-200 outline-none transition focus:border-cyan-300/30"
              />
            </label>
            <label className="text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">
              Language
              <input
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                placeholder="plain text"
                maxLength={40}
                className="mt-1.5 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm normal-case tracking-normal text-zinc-200 outline-none transition focus:border-cyan-300/30"
              />
            </label>
          </div>
          <label className="mt-4 block text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">
            Content
            <textarea
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setError(null);
              }}
              placeholder="Paste or write long-form text here…"
              className="mt-1.5 min-h-72 w-full resize-y rounded-xl border border-white/10 bg-black/25 p-3 font-mono text-[12px] leading-relaxed normal-case tracking-normal text-zinc-200 outline-none transition focus:border-cyan-300/30"
            />
          </label>
          <div className="mt-2 flex items-center justify-between gap-3 text-[10px]">
            <span className={error ? "text-rose-300" : "text-zinc-600"}>
              {error || "The snippet can be previewed and downloaded in Chat."}
            </span>
            <span
              className={
                sizeBytes > MAX_CHAT_SNIPPET_BYTES
                  ? "text-rose-300"
                  : "text-zinc-600"
              }
            >
              {(sizeBytes / 1_000).toFixed(sizeBytes >= 10_000 ? 0 : 1)} KB / 200 KB
            </span>
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-white/[0.08] px-4 py-3.5 sm:px-5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/10 px-4 py-2 text-xs text-zinc-400 transition hover:bg-white/[0.04] hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                const snippet = validateChatTextSnippet({
                  title,
                  language,
                  content,
                  kind: mode,
                });
                if (!snippet) return;
                onAdd(snippet);
                setTitle("");
                setLanguage("");
                setContent("");
                setError(null);
                onClose();
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not add the text snippet.",
                );
              }
            }}
            disabled={!content.trim() || sizeBytes > MAX_CHAT_SNIPPET_BYTES}
            className="rounded-xl bg-cyan-300 px-4 py-2 text-xs font-semibold text-[#071014] transition hover:bg-cyan-200 disabled:opacity-35"
          >
            Add to message
          </button>
        </footer>
      </div>
    </div>
  );
}
