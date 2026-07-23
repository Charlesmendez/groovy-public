"use client";

import { useState } from "react";
import { AGENTS, ATTENTION_META, MEMORY_SCOPE_META, PEOPLE, type ChatItem, type Mind, type Room } from "./chatMockData";
import { AgentAvatar, MindAvatar, PersonAvatar } from "./ChatAvatars";

function RailLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-5 pb-2 text-[11px] font-medium uppercase tracking-widest text-[var(--text-secondary)]">
      {children}
    </div>
  );
}

// The room's working memory: which mind powers it, what's in motion, who's
// here — plus a Memory tab where you can literally read what the room
// remembers (it's markdown, not a black box).
export function NowRail({
  room,
  mind,
  onConfigureMind,
}: {
  room: Room;
  mind: Mind;
  onConfigureMind: () => void;
}) {
  const [tab, setTab] = useState<"now" | "memory">("now");
  const works = room.items.filter((i): i is Extract<ChatItem, { kind: "work" }> => i.kind === "work");
  const inMotion = works.filter((w) => w.work.status === "running" || w.work.status === "queued");
  const waiting = works.filter((w) => w.work.status === "approval");
  const receipts = works.filter((w) => w.work.status === "done");

  return (
    <aside className="hidden h-full w-72 shrink-0 flex-col overflow-y-auto border-l border-[var(--glass-border)] bg-[var(--bg-secondary)]/40 px-4 pb-6 xl:flex">
      <div className="sticky top-0 z-10 -mx-4 flex gap-1 border-b border-[var(--glass-border)] bg-[var(--bg-primary)]/90 px-4 py-2 backdrop-blur">
        {(["now", "memory"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1 text-xs uppercase tracking-wider transition-colors ${
              tab === t
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t === "now" ? "Now" : `Memory${room.memoryPages.length ? ` · ${room.memoryPages.length}` : ""}`}
          </button>
        ))}
      </div>

      {tab === "now" ? (
        <>
          <RailLabel>This room thinks with</RailLabel>
          <div
            className="rounded-xl border p-3"
            style={{ borderColor: `${mind.color}33`, background: `${mind.color}0a` }}
          >
            <div className="flex items-center gap-2.5">
              <MindAvatar mind={mind} size={30} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium" style={{ color: mind.color }}>
                  {mind.name}
                </div>
                <div className="text-[11px] text-[var(--text-secondary)]">
                  {mind.model} · {mind.effort} effort
                </div>
              </div>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{mind.tagline}</p>
            <p className="mt-2 text-[11px] text-[var(--text-secondary)]/70">
              {ATTENTION_META[room.attention].hint}
            </p>
            <button
              onClick={onConfigureMind}
              className="mt-2.5 w-full rounded-lg border py-1.5 text-xs transition-colors"
              style={{ borderColor: `${mind.color}40`, color: mind.color }}
            >
              Configure mind
            </button>
          </div>

          {waiting.length ? (
            <>
              <RailLabel>Waiting on you</RailLabel>
              {waiting.map((item) => (
                <div
                  key={item.id}
                  className="mb-2 rounded-lg border border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.06)] px-3 py-2"
                >
                  <div className="text-xs font-medium text-[var(--accent-amber)]">{item.work.title}</div>
                  <div className="mt-0.5 text-[10px] text-[var(--text-secondary)]">needs approval in the room</div>
                </div>
              ))}
            </>
          ) : null}

          <RailLabel>In motion</RailLabel>
          {inMotion.length === 0 ? (
            <div className="text-xs text-[var(--text-secondary)]/60">Nothing running in this room.</div>
          ) : (
            inMotion.map((item) => {
              const agent = AGENTS[item.work.agentId];
              return (
                <div
                  key={item.id}
                  className="mb-2 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-secondary)] px-3 py-2"
                >
                  <div className="text-xs font-medium text-[var(--text-primary)]">{item.work.title}</div>
                  <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-[var(--accent-cyan)]/80">
                    <span className="h-1.5 w-1.5 animate-pulse-glow rounded-full bg-[var(--accent-cyan)]" />
                    {agent.name}: {item.work.steps[Math.min(item.work.stepIndex, item.work.steps.length - 1)]}
                  </div>
                </div>
              );
            })
          )}

          <RailLabel>Receipts</RailLabel>
          {receipts.length === 0 ? (
            <div className="text-xs text-[var(--text-secondary)]/60">No finished work yet today.</div>
          ) : (
            receipts.map((item) => (
              <div key={item.id} className="mb-1.5 flex items-baseline gap-2 text-xs">
                <span className="text-[var(--accent-green)]">✓</span>
                <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{item.work.title}</span>
                <span className="shrink-0 text-[10px] text-[var(--text-secondary)]/60">{item.work.duration}</span>
              </div>
            ))
          )}

          <RailLabel>In this room</RailLabel>
          <div className="space-y-1.5">
            {room.people.map((id) => {
              const p = PEOPLE[id];
              return (
                <div key={id} className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                  <PersonAvatar person={p} size={22} />
                  <span>{p.you ? `${p.name} (you)` : p.name}</span>
                  <span
                    className="ml-auto h-1.5 w-1.5 rounded-full"
                    style={{ background: p.online ? "var(--accent-green)" : "#3f3f50" }}
                  />
                </div>
              );
            })}
            {room.agents.map((id) => {
              const a = AGENTS[id];
              return (
                <div
                  key={id}
                  title={`${a.host} · contributed by ${a.contributedBy === "you" ? "you" : PEOPLE[a.contributedBy]?.name}`}
                  className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"
                >
                  <AgentAvatar agent={a} size={22} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="block truncate">{a.name}</span>
                    <span className="block truncate font-mono text-[9px] text-[var(--text-secondary)]/60">
                      {a.host}
                    </span>
                  </span>
                  <span
                    className="ml-auto shrink-0 text-[10px]"
                    style={{ color: a.online ? "var(--text-secondary)" : "#ef4444aa" }}
                  >
                    {!a.online ? "offline" : a.status === "working" ? "working" : "idle"}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <RailLabel>What this room remembers</RailLabel>
          <p className="mb-3 text-[11px] leading-relaxed text-[var(--text-secondary)]/80">
            {MEMORY_SCOPE_META[room.memoryScope].hint} Pages are plain markdown — open, edit, or delete any of
            them.
          </p>
          {room.memoryScope === "off" ? (
            <div className="rounded-lg border border-dashed border-[var(--glass-border)] px-3 py-4 text-center text-xs text-[var(--text-secondary)]/70">
              Memory is off for this room.
            </div>
          ) : room.memoryPages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--glass-border)] px-3 py-4 text-center text-xs text-[var(--text-secondary)]/70">
              Nothing filed yet. The mind writes pages here as it learns.
            </div>
          ) : (
            room.memoryPages.map((page) => (
              <button
                key={page.title}
                className="mb-2 w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-secondary)] px-3 py-2.5 text-left transition-colors hover:border-[var(--text-secondary)]/30"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-xs text-[var(--accent-cyan)]/90">
                    {page.title}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--text-secondary)]/60">{page.updated}</span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">{page.excerpt}</p>
              </button>
            ))
          )}
          <button className="mt-2 w-full rounded-lg border border-dashed border-[var(--glass-border)] py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            Open full wiki ↗
          </button>
        </>
      )}
    </aside>
  );
}
