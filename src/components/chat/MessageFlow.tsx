"use client";

import { useState } from "react";
import { AGENTS, PEOPLE, type ChatItem, type Mind, type Work } from "./chatMockData";
import { AgentAvatar, MindAvatar, PersonAvatar } from "./ChatAvatars";
import { WorkCard } from "./WorkCard";

function renderText(text: string) {
  // Highlight @mentions so the summoning grammar reads at a glance.
  return text.split(/(@[A-Za-z][\w-]*)/g).map((part, i) =>
    part.startsWith("@") ? (
      <span key={i} className="rounded bg-[var(--accent-cyan-dim)] px-1 py-0.5 text-[var(--accent-cyan)]">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

// "Show working" — the mind's condensed reasoning trace, one click away.
function WorkingTrace({ trace, color }: { trace: string[]; color: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-[var(--text-secondary)]/70 underline decoration-dotted underline-offset-2 hover:text-[var(--text-secondary)]"
      >
        {open ? "hide working" : `show working (${trace.length} steps)`}
      </button>
      {open ? (
        <ol className="mt-1.5 space-y-1 border-l pl-3" style={{ borderColor: `${color}33` }}>
          {trace.map((line, i) => (
            <li key={i} className="font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">
              {line}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function authorMeta(item: Extract<ChatItem, { kind: "message" }>, minds: Record<string, Mind>) {
  const { type, id } = item.author;
  if (type === "person") {
    const p = PEOPLE[id];
    return {
      avatar: <PersonAvatar person={p} />,
      name: p.you ? `${p.name} (you)` : p.name,
      badge: null as React.ReactNode,
      nameColor: "var(--text-primary)",
      traceColor: "#8888a0",
    };
  }
  if (type === "mind") {
    const m = minds[id];
    return {
      avatar: <MindAvatar mind={m} />,
      name: m.name,
      badge: (
        <span
          className="rounded-full px-1.5 py-px text-[10px] uppercase tracking-wider"
          style={{ background: `${m.color}14`, color: m.color, border: `1px solid ${m.color}40` }}
        >
          mind
        </span>
      ),
      nameColor: m.color,
      traceColor: m.color,
    };
  }
  const a = AGENTS[id];
  return {
    avatar: <AgentAvatar agent={a} />,
    name: a.name,
    badge: (
      <span className="rounded-full border border-[var(--glass-border)] px-1.5 py-px text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
        agent
      </span>
    ),
    nameColor: "var(--text-primary)",
    traceColor: "#8888a0",
  };
}

export function MessageFlow({
  items,
  mind,
  minds,
  thinking,
  onOpenWork,
  onApproveWork,
  onDeclineWork,
}: {
  items: ChatItem[];
  mind: Mind;
  minds: Record<string, Mind>;
  thinking: boolean;
  onOpenWork: (work: Work) => void;
  onApproveWork: (workId: string) => void;
  onDeclineWork: (workId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-5 py-4">
      {items.map((item, index) => {
        if (item.kind === "divider") {
          return (
            <div key={item.id} className="my-3 flex items-center gap-3">
              <div className="h-px flex-1 bg-[var(--glass-border)]" />
              <span className="text-[11px] uppercase tracking-widest text-[var(--text-secondary)]">
                {item.label}
              </span>
              <div className="h-px flex-1 bg-[var(--glass-border)]" />
            </div>
          );
        }
        if (item.kind === "work") {
          return (
            <WorkCard
              key={item.id}
              work={item.work}
              mind={mind}
              time={item.time}
              onOpen={onOpenWork}
              onApprove={onApproveWork}
              onDecline={onDeclineWork}
            />
          );
        }
        const meta = authorMeta(item, minds);
        const authorKey = `${item.author.type}:${item.author.id}`;
        const previous = index > 0 ? items[index - 1] : null;
        const compact =
          previous?.kind === "message" &&
          `${previous.author.type}:${previous.author.id}` === authorKey;
        return (
          <div key={item.id} className={`group flex gap-3 ${compact ? "mt-0.5" : "mt-3"}`}>
            <div className="w-8 shrink-0">{compact ? null : meta.avatar}</div>
            <div className="min-w-0 flex-1">
              {compact ? null : (
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium" style={{ color: meta.nameColor }}>
                    {meta.name}
                  </span>
                  {meta.badge}
                  <span className="text-[11px] text-[var(--text-secondary)] opacity-0 transition-opacity group-hover:opacity-100">
                    {item.time}
                  </span>
                </div>
              )}
              <p className="text-[15px] leading-relaxed text-[var(--text-primary)]/90">
                {renderText(item.text)}
              </p>
              {item.workingTrace?.length ? (
                <WorkingTrace trace={item.workingTrace} color={meta.traceColor} />
              ) : null}
            </div>
          </div>
        );
      })}
      {thinking ? (
        <div className="mt-3 flex items-center gap-3">
          <div className="w-8 shrink-0">
            <MindAvatar mind={mind} />
          </div>
          <span className="animate-pulse-glow text-sm" style={{ color: mind.color }}>
            {mind.name} is thinking…
          </span>
        </div>
      ) : null}
    </div>
  );
}
