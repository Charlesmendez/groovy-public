"use client";

import { AGENTS, type Work } from "./chatMockData";
import { AgentAvatar } from "./ChatAvatars";

// Zoom level 3: the agent's actual transcript for a piece of work. Same object
// the Command center worker tiles render — one task, two surfaces.
export function WorkLogDrawer({ work, onClose }: { work: Work; onClose: () => void }) {
  const agent = AGENTS[work.agentId];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-lg flex-col border-l border-[var(--glass-border)] bg-[var(--bg-primary)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--glass-border)] px-5 py-4">
          <AgentAvatar agent={agent} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-[var(--text-primary)]">{work.title}</div>
            <div className="text-xs text-[var(--text-secondary)]">
              {agent.name} · {agent.kind} · on {agent.host} ·{" "}
              {work.status === "done" ? `done in ${work.duration}` : work.status}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-0.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--bg-secondary)] p-4">
            {(work.log ?? ["No log recorded for this task."]).map((line, i) => (
              <div key={i} className="flex gap-3 py-0.5 font-mono text-[11px] leading-relaxed">
                <span className="shrink-0 text-[var(--text-secondary)]/50">{String(i + 1).padStart(2, "0")}</span>
                <span
                  className={
                    line.includes("root cause") || line.includes("receipt")
                      ? "text-[var(--accent-green)]"
                      : line.startsWith("$") || line.includes(" $ ")
                        ? "text-[var(--accent-cyan)]/90"
                        : "text-[var(--text-secondary)]"
                  }
                >
                  {line}
                </span>
              </div>
            ))}
            {work.status === "running" ? (
              <div className="mt-1 flex gap-3 py-0.5 font-mono text-[11px]">
                <span className="shrink-0 text-[var(--text-secondary)]/50">··</span>
                <span className="animate-pulse-glow text-[var(--accent-cyan)]">live…</span>
              </div>
            ) : null}
          </div>
          {work.result ? (
            <div className="mt-4 rounded-xl border border-[#10b98133] bg-[#10b9810d] p-4">
              <div className="text-[11px] font-medium uppercase tracking-widest text-[var(--accent-green)]">
                Receipt
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-primary)]/90">{work.result}</p>
            </div>
          ) : null}
          <div className="mt-4 text-[11px] text-[var(--text-secondary)]/60">
            Also visible in Command center → {agent.name}&apos;s tile. Same task, two surfaces.
          </div>
        </div>
      </div>
    </div>
  );
}
