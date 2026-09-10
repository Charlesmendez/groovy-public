"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Download, FileText } from "lucide-react";
import type { ChatTextSnippet } from "@/lib/chat/snippets";

function safeSnippetFilename(title: string): string {
  const safe = title
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `${safe || "text-snippet"}.txt`;
}

export function ChatTextSnippetCard({
  snippet,
  compact = false,
}: {
  snippet: ChatTextSnippet;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = snippet.content.split("\n").length;

  const download = () => {
    const url = URL.createObjectURL(
      new Blob([snippet.content], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeSnippetFilename(snippet.title);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <section
      className={`mt-2 overflow-hidden rounded-xl border border-white/10 bg-black/20 ${
        compact ? "max-w-full" : "max-w-2xl"
      }`}
      aria-label={`${snippet.kind === "canvas" ? "Canvas" : "Text snippet"}: ${snippet.title}`}
    >
      <header className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
        <FileText className="h-4 w-4 shrink-0 text-cyan-300/80" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-zinc-200">
            {snippet.title}
          </p>
          <p className="mt-0.5 text-[9px] text-zinc-600">
            {snippet.kind === "canvas" ? "Canvas" : "Text snippet"} ·{" "}
            {lineCount} {lineCount === 1 ? "line" : "lines"}
            {snippet.language ? ` · ${snippet.language}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={download}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-white"
          aria-label={`Download ${snippet.title}`}
          title="Download snippet"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="flex h-8 items-center gap-1 rounded-lg px-2 text-[10px] text-zinc-400 transition hover:bg-white/[0.06] hover:text-white"
          aria-expanded={expanded}
        >
          {expanded ? "Collapse" : "View"}
          {expanded ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>
      </header>
      <pre
        className={`overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-zinc-300 [overflow-wrap:anywhere] ${
          expanded ? "max-h-[32rem]" : compact ? "max-h-24" : "max-h-36"
        }`}
      >
        {snippet.content}
      </pre>
    </section>
  );
}
