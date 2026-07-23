"use client";

import Link from "next/link";
import { AGENTS, PEOPLE, type Mind, type Room } from "./chatMockData";
import { AgentAvatar, PersonAvatar } from "./ChatAvatars";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-5 pb-1.5 text-[11px] font-medium uppercase tracking-widest text-[var(--text-secondary)]">
      {children}
    </div>
  );
}

export function ChatSidebar({
  rooms,
  minds,
  activeId,
  onSelect,
  onInvite,
  onNewRoom,
  onDevices,
}: {
  rooms: Room[];
  minds: Record<string, Mind>;
  activeId: string;
  onSelect: (id: string) => void;
  onInvite: () => void;
  onNewRoom: () => void;
  onDevices: () => void;
}) {
  const channels = rooms.filter((r) => r.kind === "room");
  const dms = rooms.filter((r) => r.kind === "dm");
  const agentRooms = rooms.filter((r) => r.kind === "agent");

  const rowClass = (id: string) =>
    `flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
      id === activeId
        ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
        : "text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
    }`;

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-[var(--glass-border)] bg-[var(--bg-secondary)]/60">
      <div className="border-b border-[var(--glass-border)] px-4 py-3.5">
        <div className="font-display text-sm tracking-wider text-[var(--text-primary)]">GROOVY HQ</div>
        <div className="mt-1 flex items-center gap-3">
          <Link href="/dashboard" className="text-xs text-[var(--text-secondary)] hover:text-[var(--accent-cyan)]">
            ↗ Command center
          </Link>
          <button onClick={onInvite} className="text-xs text-[var(--text-secondary)] hover:text-[var(--accent-cyan)]">
            + Invite
          </button>
          <button onClick={onDevices} className="text-xs text-[var(--text-secondary)] hover:text-[var(--accent-cyan)]">
            ⌂ Devices
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <SectionLabel>Rooms</SectionLabel>
        {channels.map((room) => {
          const mind = minds[room.mindId];
          return (
            <button key={room.id} className={rowClass(room.id)} onClick={() => onSelect(room.id)}>
              <span className="w-3 text-center text-[var(--text-secondary)]">
                {room.visibility === "private" ? "🔒" : "#"}
              </span>
              <span className="min-w-0 flex-1 truncate">{room.name}</span>
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                title={`${mind.name} · ${room.attention}`}
                style={{
                  background: room.attention === "off" ? "transparent" : mind.color,
                  border: `1px solid ${mind.color}`,
                  opacity: room.attention === "mention" ? 0.45 : 1,
                }}
              />
              {room.unread ? (
                <span className="rounded-full bg-[var(--accent-cyan-dim)] px-1.5 text-[11px] text-[var(--accent-cyan)]">
                  {room.unread}
                </span>
              ) : null}
            </button>
          );
        })}

        <SectionLabel>Direct</SectionLabel>
        {dms.map((room) => {
          const other = room.people.map((p) => PEOPLE[p]).find((p) => !p.you);
          if (!other) return null;
          return (
            <button key={room.id} className={rowClass(room.id)} onClick={() => onSelect(room.id)}>
              <PersonAvatar person={other} size={20} />
              <span className="min-w-0 flex-1 truncate">{other.name}</span>
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: other.online ? "var(--accent-green)" : "#3f3f50" }}
              />
            </button>
          );
        })}

        <SectionLabel>Agents</SectionLabel>
        {agentRooms.map((room) => {
          const agent = AGENTS[room.agents[0]];
          return (
            <button key={room.id} className={rowClass(room.id)} onClick={() => onSelect(room.id)}>
              <AgentAvatar agent={agent} size={22} />
              <span className="min-w-0 flex-1 truncate">
                <span className="block truncate">{agent.name}</span>
                {agent.status === "working" && agent.statusLine ? (
                  <span className="block truncate font-mono text-[10px] text-[var(--accent-cyan)]/80">
                    {agent.statusLine}
                  </span>
                ) : (
                  <span
                    className="block truncate font-mono text-[10px]"
                    style={{ color: agent.online ? "var(--text-secondary)" : "#ef4444aa" }}
                  >
                    {agent.host}
                    {agent.online ? "" : " · offline"}
                  </span>
                )}
              </span>
            </button>
          );
        })}

        <div className="mt-6 px-3">
          <button
            onClick={onNewRoom}
            className="w-full rounded-lg border border-dashed border-[var(--glass-border)] px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent-cyan)]/40 hover:text-[var(--text-primary)]"
          >
            + New room · agent · mind
          </button>
        </div>
      </div>
    </aside>
  );
}
