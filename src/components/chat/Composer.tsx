"use client";

import { useMemo, useRef, useState } from "react";
import { AGENTS, PEOPLE, type Mind, type Room } from "./chatMockData";

type MentionOption = {
  id: string;
  label: string;
  group: "Minds" | "Agents" | "People";
  detail: string;
  color?: string;
};

export function Composer({
  room,
  mind,
  onSend,
}: {
  room: Room;
  mind: Mind;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const mentionQuery = useMemo(() => {
    const match = /(?:^|\s)@([\w-]*)$/.exec(text);
    return match ? match[1].toLowerCase() : null;
  }, [text]);

  const options = useMemo<MentionOption[]>(() => {
    if (mentionQuery === null) return [];
    const all: MentionOption[] = [
      { id: mind.name.split(" ")[0], label: mind.name, group: "Minds", detail: mind.model, color: mind.color },
      // Only agents that are in this room AND on the mind's roster are
      // summonable — the per-channel boundary set in room settings.
      ...room.agents
        .filter((id) => mind.roster.includes(id))
        .map((id) => ({
          id: AGENTS[id].name,
          label: AGENTS[id].name,
          group: "Agents" as const,
          detail: `${AGENTS[id].kind}${AGENTS[id].online ? "" : " · host offline"}`,
        })),
      ...room.people
        .map((id) => PEOPLE[id])
        .filter((p) => !p.you)
        .map((p) => ({ id: p.name, label: p.name, group: "People" as const, detail: "teammate" })),
    ];
    return all.filter((o) => o.label.toLowerCase().includes(mentionQuery)).slice(0, 6);
  }, [mentionQuery, room, mind]);

  const insertMention = (option: MentionOption) => {
    setText((t) => t.replace(/@([\w-]*)$/, `@${option.id} `));
    inputRef.current?.focus();
  };

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  };

  const placeholder =
    room.kind === "agent"
      ? `Message ${room.name} directly — it replies as itself`
      : room.attention === "off"
        ? `Message #${room.name} — humans only in here`
        : `Message #${room.name} — @ summons a mind or agent`;

  return (
    <div className="relative border-t border-[var(--glass-border)] bg-[var(--bg-secondary)]/60 px-5 py-4">
      {options.length > 0 ? (
        <div className="absolute bottom-full left-5 mb-1 w-72 overflow-hidden rounded-xl border border-[var(--glass-border)] bg-[var(--bg-tertiary)] shadow-2xl">
          {(["Minds", "Agents", "People"] as const).map((group) => {
            const groupOptions = options.filter((o) => o.group === group);
            if (!groupOptions.length) return null;
            return (
              <div key={group}>
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest text-[var(--text-secondary)]">
                  {group}
                </div>
                {groupOptions.map((o) => (
                  <button
                    key={o.id}
                    className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-secondary)]"
                    onClick={() => insertMention(o)}
                  >
                    <span style={{ color: o.color ?? "var(--text-primary)" }}>@{o.id}</span>
                    <span className="text-xs text-[var(--text-secondary)]">{o.detail}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="flex items-end gap-3 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-primary)] px-4 py-3 focus-within:border-[var(--accent-cyan)]/40">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          className="max-h-40 flex-1 resize-none bg-transparent text-[15px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]/60"
        />
        <button
          onClick={send}
          disabled={!text.trim()}
          className="rounded-lg px-3 py-1 text-sm transition-colors disabled:opacity-30"
          style={{ background: `${mind.color}1a`, color: mind.color, border: `1px solid ${mind.color}40` }}
        >
          Send
        </button>
      </div>
      <div className="mt-1.5 px-1 text-[11px] text-[var(--text-secondary)]/70">
        <span className="text-[var(--accent-cyan)]/70">@</span> summon · Enter to send · Shift+Enter for a
        new line
      </div>
    </div>
  );
}
