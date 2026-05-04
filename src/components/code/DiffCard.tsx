"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, FileCode, Copy, Check, Maximize2, X } from "lucide-react";
import { DiffViewer } from "./DiffViewer";

export type ParsedDiff = {
  filename: string;
  content: string;
  additions: number;
  deletions: number;
};

/**
 * Parse a unified diff to extract filename and stats
 */
export function parseDiffBlock(content: string): ParsedDiff {
  const lines = content.split("\n");
  let filename = "file";
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    // Extract filename from +++ line (preferred) or --- line
    if (line.startsWith("+++ ")) {
      const match = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (match && match[1] !== "/dev/null") filename = match[1];
    } else if (line.startsWith("--- ") && filename === "file") {
      const match = line.match(/^--- (?:a\/)?(.+)$/);
      if (match && match[1] !== "/dev/null") filename = match[1];
    }
    // Count additions and deletions (skip header lines)
    else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  return { filename, content, additions, deletions };
}

/**
 * Extract all diff blocks from assistant message content
 * Looks for ```diff ... ``` fenced code blocks
 */
export function extractDiffs(content: string): { cleanContent: string; diffs: ParsedDiff[] } {
  const diffs: ParsedDiff[] = [];
  
  // Match ```diff ... ``` blocks
  const diffBlockRegex = /```diff\n([\s\S]*?)```/g;
  let cleanContent = content;
  let match;

  while ((match = diffBlockRegex.exec(content)) !== null) {
    const diffContent = match[1].trim();
    if (diffContent) {
      diffs.push(parseDiffBlock(diffContent));
    }
  }

  // Remove diff blocks from content for clean display
  cleanContent = content.replace(diffBlockRegex, "").trim();

  return { cleanContent, diffs };
}

type DiffCardProps = {
  diff: ParsedDiff;
  defaultExpanded?: boolean;
};

function DiffStat({ value, kind }: { value: number; kind: "add" | "delete" }) {
  if (value <= 0) return null;
  const isAdd = kind === "add";
  return (
    <span
      className={`rounded-md border px-2 py-1 text-xs font-medium ${
        isAdd
          ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-300"
          : "border-red-400/20 bg-red-500/10 text-red-300"
      }`}
    >
      {isAdd ? "+" : "-"}
      {value}
    </span>
  );
}

function ExpandedDiffModal({
  diff,
  shortFilename,
  onClose,
}: {
  diff: ParsedDiff;
  shortFilename: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(diff.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Expanded diff for ${shortFilename}`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 bg-zinc-900/80 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FileCode className="h-4 w-4 shrink-0 text-cyan-300" />
              <h2 className="truncate text-sm font-semibold text-zinc-100">{shortFilename}</h2>
            </div>
            {diff.filename !== shortFilename && (
              <div className="mt-1 truncate font-mono text-xs text-zinc-500">{diff.filename}</div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DiffStat value={diff.additions} kind="add" />
            <DiffStat value={diff.deletions} kind="delete" />
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-lg p-2 text-zinc-500 transition hover:bg-white/10 hover:text-white"
              title="Copy diff"
              aria-label="Copy diff"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-zinc-500 transition hover:bg-white/10 hover:text-white"
              title="Close"
              aria-label="Close expanded diff"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
          <DiffViewer content={diff.content} maxHeight="calc(88vh - 120px)" />
        </div>
      </div>
    </div>,
    document.body
  );
}

export function DiffCard({ diff, defaultExpanded = false }: DiffCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(diff.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore
    }
  };

  // Get just the filename without path for compact display
  const shortFilename = useMemo(() => {
    const parts = diff.filename.split("/");
    return parts[parts.length - 1] || diff.filename;
  }, [diff.filename]);

  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900/50 overflow-hidden">
      {/* Collapsed header - always visible */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-white/5 transition-colors text-left cursor-pointer"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
        )}
        
        <FileCode className="w-4 h-4 text-zinc-400 shrink-0" />
        
        <div className="flex-1 min-w-0">
          <span className="text-sm text-zinc-200 font-medium truncate block">
            {shortFilename}
          </span>
          {diff.filename !== shortFilename && (
            <span className="text-xs text-zinc-500 truncate block">
              {diff.filename}
            </span>
          )}
        </div>

        {/* Stats */}
        <div className="flex items-center gap-2 shrink-0">
          {diff.additions > 0 && (
            <span className="text-xs font-medium text-emerald-400">
              +{diff.additions}
            </span>
          )}
          {diff.deletions > 0 && (
            <span className="text-xs font-medium text-red-400">
              -{diff.deletions}
            </span>
          )}
        </div>

        {/* Expand button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setModalOpen(true);
          }}
          className="p-1.5 rounded-md text-zinc-500 hover:text-cyan-300 hover:bg-white/10 transition-colors shrink-0"
          title="Open large diff"
          aria-label={`Open ${shortFilename} diff in large view`}
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>

        {/* Copy button */}
        <button
          onClick={handleCopy}
          className="p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          title="Copy diff"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-white/10">
          <DiffViewer
            content={diff.content}
            maxHeight="300px"
            collapseInnerScrollOnTouch
          />
        </div>
      )}

      {modalOpen && (
        <ExpandedDiffModal
          diff={diff}
          shortFilename={shortFilename}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

type DiffCardListProps = {
  diffs: ParsedDiff[];
  defaultExpanded?: boolean;
};

/**
 * Render a list of diff cards
 */
export function DiffCardList({ diffs, defaultExpanded = false }: DiffCardListProps) {
  if (diffs.length === 0) return null;

  return (
    <div className="space-y-2 mt-3">
      {diffs.map((diff, idx) => (
        <DiffCard key={idx} diff={diff} defaultExpanded={defaultExpanded} />
      ))}
    </div>
  );
}
