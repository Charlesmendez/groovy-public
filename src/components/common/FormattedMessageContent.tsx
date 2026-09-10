"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import {
  renderChatMathToHtml,
  tokenizeChatMessageInline,
} from "@/lib/chat/mathFormatting";

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

function MathMessage({
  expression,
  raw,
  display,
}: {
  expression: string;
  raw: string;
  display: boolean;
}) {
  const html = useMemo(
    () => renderChatMathToHtml(expression, display),
    [display, expression],
  );
  if (!html) return raw;

  return (
    <span
      className={
        display
          ? "block max-w-full overflow-x-auto overflow-y-hidden"
          : "inline max-w-full"
      }
      // KaTeX escapes TeX input and HTML-capable commands remain disabled
      // through trust:false in renderChatMathToHtml.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function InlineMessageText({ text }: { text: string }) {
  const tokens = useMemo(() => tokenizeChatMessageInline(text), [text]);

  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "math") {
      return (
        <MathMessage
          key={key}
          expression={token.value}
          raw={token.raw}
          display={token.display}
        />
      );
    }
    if (token.type === "strong") {
      return (
        <strong key={key} className="font-semibold text-zinc-100">
          {token.value}
        </strong>
      );
    }
    if (token.type === "code") {
      return (
        <code
          key={key}
          className="rounded bg-white/[0.07] px-1 py-0.5 font-mono text-[0.88em] text-cyan-100"
        >
          {token.value}
        </code>
      );
    }
    if (token.type === "italic") {
      return <em key={key}>{token.value}</em>;
    }
    if (token.type === "underline") {
      return (
        <span key={key} className="underline decoration-white/40 underline-offset-2">
          {token.value}
        </span>
      );
    }
    if (token.type === "strike") {
      return (
        <s key={key} className="decoration-white/45">
          {token.value}
        </s>
      );
    }
    if (token.type === "link") {
      return (
        <a
          key={key}
          href={token.href}
          target="_blank"
          rel="noreferrer"
          className="text-cyan-300 underline decoration-cyan-300/35 underline-offset-2 transition hover:text-cyan-200"
        >
          {token.label}
        </a>
      );
    }
    return token.value;
  });
}

function TextMessageBlocks({
  text,
  textClassName,
}: {
  text: string;
  textClassName: string;
}) {
  const lines = text.trimEnd().split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  const specialLine =
    /^\s*(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+|>\s?)/;

  while (index < lines.length) {
    const line = lines[index] || "";
    if (!line.trim()) {
      blocks.push(<div key={`space-${index}`} className="h-2" aria-hidden />);
      index += 1;
      continue;
    }

    const checklist = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (checklist) {
      const items: Array<{ checked: boolean; content: string }> = [];
      while (index < lines.length) {
        const item = (lines[index] || "").match(
          /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/,
        );
        if (!item) break;
        items.push({
          checked: item[1].toLowerCase() === "x",
          content: item[2],
        });
        index += 1;
      }
      blocks.push(
        <ul key={`checklist-${index}`} className="space-y-1">
          {items.map((item, itemIndex) => (
            <li key={itemIndex} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={item.checked}
                readOnly
                tabIndex={-1}
                className="mt-1 h-3.5 w-3.5 accent-cyan-300"
                aria-label={item.checked ? "Completed item" : "Open item"}
              />
              <span className={item.checked ? "text-zinc-500 line-through" : ""}>
                <InlineMessageText text={item.content} />
              </span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.*)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] || "").match(/^\s*[-*]\s+(.*)$/);
        if (!item || /^\[[ xX]\]\s+/.test(item[1])) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ul
          key={`unordered-${index}`}
          className="list-disc space-y-1 pl-5 marker:text-zinc-500"
        >
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>
              <InlineMessageText text={item} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] || "").match(/^\s*\d+\.\s+(.*)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ol
          key={`ordered-${index}`}
          className="list-decimal space-y-1 pl-5 marker:text-zinc-500"
        >
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>
              <InlineMessageText text={item} />
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] || "").match(/^\s*>\s?(.*)$/);
        if (!item) break;
        quoted.push(item[1]);
        index += 1;
      }
      blocks.push(
        <blockquote
          key={`quote-${index}`}
          className="border-l-2 border-white/15 pl-3 text-zinc-400"
        >
          {quoted.map((item, itemIndex) => (
            <div key={itemIndex}>
              <InlineMessageText text={item} />
            </div>
          ))}
        </blockquote>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] || "").trim() &&
      !specialLine.test(lines[index] || "")
    ) {
      paragraph.push(lines[index] || "");
      index += 1;
    }
    blocks.push(
      <div key={`text-${index}`} className={textClassName}>
        <InlineMessageText text={paragraph.join("\n")} />
      </div>,
    );
  }

  return blocks;
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
          <TextMessageBlocks
            key={segment.key}
            text={text}
            textClassName={textClassName}
          />
        );
      })}
    </div>
  );
}
