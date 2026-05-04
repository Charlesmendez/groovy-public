"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, Check } from "lucide-react";

type DiffLine = {
  type: "add" | "remove" | "context" | "header";
  content: string;
  lineNumber?: { old?: number; new?: number };
};

type DiffViewerProps = {
  content: string;
  maxHeight?: string;
  // When true and we're on a touch device, drop the inner overflow scroller
  // and render the diff at natural height. Avoids the iOS PWA scroll-trap
  // where a nested scroll area prevents the outer page from scrolling.
  collapseInnerScrollOnTouch?: boolean;
};

/**
 * Parse unified diff format into structured lines
 */
function parseDiff(content: string): DiffLine[] {
  const lines = content.split("\n");
  const result: DiffLine[] = [];
  
  let oldLine = 0;
  let newLine = 0;
  
  for (const line of lines) {
    // File headers
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ")) {
      result.push({ type: "header", content: line });
      continue;
    }
    
    // Hunk header @@ -1,5 +1,6 @@
    if (line.startsWith("@@")) {
      result.push({ type: "header", content: line });
      // Parse line numbers from hunk header
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      continue;
    }
    
    // Added line
    if (line.startsWith("+")) {
      result.push({
        type: "add",
        content: line.slice(1),
        lineNumber: { new: newLine++ },
      });
      continue;
    }
    
    // Removed line
    if (line.startsWith("-")) {
      result.push({
        type: "remove",
        content: line.slice(1),
        lineNumber: { old: oldLine++ },
      });
      continue;
    }
    
    // Context line (starts with space or is empty)
    if (line.startsWith(" ") || line === "") {
      result.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : line,
        lineNumber: { old: oldLine++, new: newLine++ },
      });
    }
  }
  
  return result;
}

/**
 * Check if content looks like a unified diff
 */
export function looksLikeDiff(content: string): boolean {
  // Check for common diff markers
  return (
    content.includes("@@") && 
    (content.includes("---") || content.includes("+++") || 
     content.match(/^[+-]/m) !== null)
  );
}

export function DiffViewer({
  content,
  maxHeight = "400px",
  collapseInnerScrollOnTouch = false,
}: DiffViewerProps) {
  const [copied, setCopied] = useState(false);
  // On touch devices an inner overflow-y-auto traps vertical pan gestures and
  // prevents the outer page from scrolling (notably in iOS PWAs). Opt-in via
  // collapseInnerScrollOnTouch so callers whose parent is a fixed-height
  // surface (e.g. the expanded modal) keep their inner scroller.
  const [touchCollapse, setTouchCollapse] = useState(false);
  useEffect(() => {
    if (!collapseInnerScrollOnTouch) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(pointer: coarse)");
    const apply = () => setTouchCollapse(query.matches);
    apply();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", apply);
      return () => query.removeEventListener("change", apply);
    }
    query.addListener(apply);
    return () => query.removeListener(apply);
  }, [collapseInnerScrollOnTouch]);

  const useInnerScroll = !touchCollapse;
  const lines = useMemo(() => parseDiff(content), [content]);
  
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore
    }
  };
  
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-950 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-zinc-900/50">
        <span className="text-xs text-zinc-400 font-medium">Diff</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      
      {/* Diff content */}
      <div
        className={`font-mono text-xs ${useInnerScroll ? "overflow-y-auto overflow-x-hidden sm:overflow-auto" : "overflow-x-auto"}`}
        style={useInnerScroll ? { maxHeight } : undefined}
      >
        <table className="w-full border-collapse table-fixed">
          <tbody>
            {lines.map((line, idx) => (
              <tr
                key={idx}
                className={`
                  ${line.type === "add" ? "bg-emerald-500/10" : ""}
                  ${line.type === "remove" ? "bg-red-500/10" : ""}
                  ${line.type === "header" ? "bg-zinc-800/50" : ""}
                `}
              >
                {/* Line numbers */}
                <td className="px-2 py-0.5 text-zinc-600 text-right select-none w-10 border-r border-white/5">
                  {line.type !== "header" && line.lineNumber?.old}
                </td>
                <td className="px-2 py-0.5 text-zinc-600 text-right select-none w-10 border-r border-white/5">
                  {line.type !== "header" && line.lineNumber?.new}
                </td>
                
                {/* Diff indicator */}
                <td className="w-5 text-center select-none">
                  {line.type === "add" && <span className="text-emerald-400">+</span>}
                  {line.type === "remove" && <span className="text-red-400">-</span>}
                </td>
                
                {/* Content */}
                <td className={`px-2 py-0.5 whitespace-pre-wrap break-words sm:whitespace-pre sm:break-normal ${
                  line.type === "add" ? "text-emerald-300" :
                  line.type === "remove" ? "text-red-300" :
                  line.type === "header" ? "text-cyan-400" :
                  "text-zinc-400"
                }`}>
                  {line.content}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
