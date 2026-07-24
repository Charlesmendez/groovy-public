"use client";

import { Bot, MailPlus, Sparkles, UserPlus, Users } from "lucide-react";

export type ChatMentionOption = {
  id: string;
  kind: "mind" | "agent" | "person" | "invite";
  handle: string;
  label: string;
  detail: string;
  included: boolean;
  email?: string;
};

function MentionIcon({ kind }: { kind: ChatMentionOption["kind"] }) {
  if (kind === "mind") return <Sparkles className="h-4 w-4" />;
  if (kind === "agent") return <Bot className="h-4 w-4" />;
  if (kind === "invite") return <MailPlus className="h-4 w-4" />;
  return <Users className="h-4 w-4" />;
}

export function ChatMentionMenu({
  options,
  activeIndex,
  busyId,
  onSelect,
}: {
  options: ChatMentionOption[];
  activeIndex: number;
  busyId: string | null;
  onSelect: (option: ChatMentionOption) => void;
}) {
  return (
    <div
      id="chat-mention-menu"
      className="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-full max-w-md overflow-hidden rounded-xl border border-white/10 bg-[#101116] shadow-2xl"
      role="listbox"
      aria-label="Add people or agents to this conversation"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">
          Add to conversation
        </span>
        <span className="text-[10px] text-zinc-600">
          ↑↓ navigate · Enter select
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto p-1.5">
        {options.map((option, index) => {
          const active = index === activeIndex;
          const busy = busyId === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={active}
              disabled={busyId !== null}
              onClick={() => onSelect(option)}
              className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                active
                  ? "bg-cyan-400/10 text-white"
                  : "text-zinc-300 hover:bg-white/[0.05]"
              } disabled:opacity-50`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  option.kind === "mind"
                    ? "bg-cyan-400/10 text-cyan-300"
                    : option.kind === "agent"
                      ? "bg-violet-400/10 text-violet-300"
                      : option.kind === "invite"
                        ? "bg-amber-400/10 text-amber-300"
                        : "bg-emerald-400/10 text-emerald-300"
                }`}
              >
                <MentionIcon kind={option.kind} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm">{option.label}</span>
                  <span className="shrink-0 text-[10px] text-zinc-600">
                    @{option.handle}
                  </span>
                </span>
                <span className="block truncate text-[10px] text-zinc-500">
                  {busy ? "Adding…" : option.detail}
                </span>
              </span>
              {!option.included && option.kind !== "invite" ? (
                <UserPlus className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
              ) : null}
            </button>
          );
        })}
        {options.length === 0 ? (
          <div className="px-3 py-5 text-center text-xs text-zinc-600">
            No matching people or agents
          </div>
        ) : null}
      </div>
    </div>
  );
}
