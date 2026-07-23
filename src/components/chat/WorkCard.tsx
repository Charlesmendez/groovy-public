"use client";

import { AGENTS, type Mind, type Work } from "./chatMockData";
import { AgentAvatar } from "./ChatAvatars";

// A unit of delegated work rendered inline in the conversation. It updates in
// place as the agent progresses and collapses into a compact receipt when done
// — execution is a first-class object in the room, not a stream of bot posts.
// The "approval" state is the orchestrator asking the room for permission.
export function WorkCard({
  work,
  mind,
  time,
  onOpen,
  onApprove,
  onDecline,
}: {
  work: Work;
  mind: Mind;
  time: string;
  onOpen: (work: Work) => void;
  onApprove?: (workId: string) => void;
  onDecline?: (workId: string) => void;
}) {
  const agent = AGENTS[work.agentId] ?? Object.values(AGENTS)[0];
  const accent = mind.color;

  if (work.status === "done" || work.status === "declined") {
    const declined = work.status === "declined";
    return (
      <div className="my-1 ml-11 max-w-xl">
        <button
          onClick={() => onOpen(work)}
          className="flex w-full items-start gap-3 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-secondary)] px-4 py-3 text-left transition-colors hover:border-[var(--text-secondary)]/30"
        >
          <div
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]"
            style={
              declined
                ? { background: "#ef444422", color: "var(--accent-red)", border: "1px solid #ef444455" }
                : { background: "#10b98122", color: "var(--accent-green)", border: "1px solid #10b98155" }
            }
          >
            {declined ? "✕" : "✓"}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">{work.title}</span>
              <span className="text-xs text-[var(--text-secondary)]">
                {agent.name} · {declined ? "declined" : (work.duration ?? "done")} · {time}
              </span>
            </div>
            {work.result && !declined ? (
              <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{work.result}</p>
            ) : null}
            <span className="mt-1.5 inline-block text-xs text-[var(--text-secondary)] underline decoration-dotted underline-offset-2">
              view full log
            </span>
          </div>
        </button>
      </div>
    );
  }

  if (work.status === "approval") {
    return (
      <div className="my-1 ml-11 max-w-xl">
        <div
          className="rounded-xl border bg-[var(--bg-secondary)] px-4 py-3"
          style={{ borderColor: "rgba(245,158,11,0.45)" }}
        >
          <div className="flex items-center gap-3">
            <AgentAvatar agent={agent} size={28} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">{work.title}</span>
                <span className="text-xs text-[var(--accent-amber)]">needs your approval</span>
              </div>
              <div className="text-xs text-[var(--text-secondary)]">
                {agent.name} · {agent.kind}
              </div>
            </div>
          </div>
          {work.approvalText ? (
            <p className="mt-2.5 rounded-lg bg-[var(--bg-primary)] px-3 py-2 text-sm leading-relaxed text-[var(--text-primary)]/85">
              {work.approvalText}
            </p>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => onApprove?.(work.id)}
              className="rounded-lg px-3.5 py-1.5 text-sm"
              style={{
                background: "rgba(16,185,129,0.14)",
                color: "var(--accent-green)",
                border: "1px solid rgba(16,185,129,0.4)",
              }}
            >
              Approve & run
            </button>
            <button
              onClick={() => onDecline?.(work.id)}
              className="rounded-lg border border-[var(--glass-border)] px-3.5 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Not now
            </button>
            <button
              onClick={() => onOpen(work)}
              className="ml-auto text-xs text-[var(--text-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--text-primary)]"
            >
              details
            </button>
          </div>
        </div>
      </div>
    );
  }

  const running = work.status === "running";
  return (
    <div className="my-1 ml-11 max-w-xl">
      <div
        className="relative cursor-pointer overflow-hidden rounded-xl border bg-[var(--bg-secondary)] px-4 py-3"
        style={{ borderColor: `${accent}44` }}
        onClick={() => onOpen(work)}
      >
        <div className="absolute inset-x-0 top-0 h-px overflow-hidden" style={{ background: `${accent}22` }}>
          {running ? (
            <div
              className="h-full w-1/4"
              style={{ background: accent, animation: "harness-beam 1.6s linear infinite" }}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <AgentAvatar agent={agent} size={28} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">{work.title}</span>
              <span className="text-xs" style={{ color: accent }}>
                {running ? "in motion" : "queued"}
              </span>
            </div>
            <div className="text-xs text-[var(--text-secondary)]">
              {agent.name} · {agent.kind}
            </div>
          </div>
        </div>
        <ol className="mt-3 space-y-1.5">
          {work.steps.map((step, i) => {
            const done = i < work.stepIndex;
            const current = running && i === work.stepIndex;
            return (
              <li key={step} className="flex items-center gap-2 text-xs">
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px]"
                  style={
                    done
                      ? { background: "#10b98122", color: "var(--accent-green)" }
                      : current
                        ? { border: `1px solid ${accent}`, color: accent }
                        : { border: "1px solid var(--glass-border)", color: "var(--text-secondary)" }
                  }
                >
                  {done ? "✓" : current ? "·" : ""}
                </span>
                <span
                  className={current ? "font-mono" : ""}
                  style={{
                    color: current ? "var(--text-primary)" : "var(--text-secondary)",
                    opacity: done || current ? 1 : 0.6,
                  }}
                >
                  {step}
                  {current ? <span className="animate-pulse-glow">…</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
