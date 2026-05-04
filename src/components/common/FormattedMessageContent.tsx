"use client";

import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";

type TextSegment = {
  type: "text";
  key: string;
  text: string;
};

type CodeSegment = {
  type: "code";
  key: string;
  info: string;
  code: string;
};

type MessageSegment = TextSegment | CodeSegment;

function parseFencedCodeBlocks(input: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(input)) !== null) {
    const [fullMatch, rawInfo = "", rawCode = ""] = match;
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        key: `text-${lastIndex}`,
        text: input.slice(lastIndex, match.index),
      });
    }

    segments.push({
      type: "code",
      key: `code-${match.index}-${fullMatch.length}`,
      info: rawInfo.trim(),
      code: rawCode.replace(/\n$/, ""),
    });

    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < input.length) {
    segments.push({
      type: "text",
      key: `text-${lastIndex}`,
      text: input.slice(lastIndex),
    });
  }

  return segments.length > 0
    ? segments
    : [{ type: "text", key: "text-0", text: input }];
}

function displayCodeInfo(info: string) {
  const trimmed = info.trim();
  if (!trimmed) return "code";
  if (/^\d+:\d+:.+/.test(trimmed)) {
    const path = trimmed.replace(/^\d+:\d+:/, "");
    return path.split("/").pop() || path || "code";
  }
  return trimmed;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
}

function CodeBlock({ info, code }: { info: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const label = displayCodeInfo(info);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-white/10 bg-zinc-950/80">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400">
          {label}
        </span>
        <button
          type="button"
          onClick={async () => {
            const ok = await copyText(code);
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
          title="Copy code"
          aria-label="Copy code"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <pre className="max-h-[420px] overflow-auto p-3 text-[12px] leading-relaxed">
        <code className="block whitespace-pre font-mono text-zinc-100">{code}</code>
      </pre>
    </div>
  );
}

export function FormattedMessageContent({
  content,
  className = "",
  textClassName = "",
}: {
  content: string;
  className?: string;
  textClassName?: string;
}) {
  const segments = useMemo(() => parseFencedCodeBlocks(content), [content]);

  return (
    <div className={className}>
      {segments.map((segment) => {
        if (segment.type === "code") {
          return <CodeBlock key={segment.key} info={segment.info} code={segment.code} />;
        }

        const text = segment.text.trimEnd();
        if (!text) return null;

        return (
          <div key={segment.key} className={textClassName}>
            {text}
          </div>
        );
      })}
    </div>
  );
}
