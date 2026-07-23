"use client";

import { AGENTS, MEMORY_SCOPE_META, type MemoryScope, type Mind, type Room } from "./chatMockData";
import { AgentAvatar } from "./ChatAvatars";
import { FieldLabel, ModalShell, SegmentPicker } from "./ChatModals";

export function ChannelSettingsModal({
  room,
  mind,
  onPatch,
  onClose,
}: {
  room: Room;
  mind: Mind;
  onPatch: (patch: Partial<Room>) => void;
  onClose: () => void;
}) {
  const toggleAgent = (agentId: string) => {
    onPatch({
      agents: room.agents.includes(agentId)
        ? room.agents.filter((a) => a !== agentId)
        : [...room.agents, agentId],
    });
  };

  return (
    <ModalShell
      title={`#${room.name} settings`}
      subtitle={room.topic}
      onClose={onClose}
    >
      <FieldLabel>Visibility</FieldLabel>
      <SegmentPicker
        options={[
          { id: "public" as const, label: "Public" },
          { id: "private" as const, label: "🔒 Private" },
        ]}
        value={room.visibility}
        onChange={(visibility) => onPatch({ visibility })}
        hint={
          room.visibility === "private"
            ? "Only invited members can see or join. Minds and agents in here inherit that boundary."
            : "Anyone in the workspace can find and join this room."
        }
      />

      <FieldLabel>Agents in this room</FieldLabel>
      <div className="flex flex-wrap gap-1.5">
        {Object.values(AGENTS).map((a) => {
          const inRoom = room.agents.includes(a.id);
          const inRoster = mind.roster.includes(a.id);
          return (
            <button
              key={a.id}
              onClick={() => toggleAgent(a.id)}
              title={
                inRoster
                  ? inRoom
                    ? `Remove ${a.name} from this room`
                    : `Add ${a.name} to this room`
                  : `Not in ${mind.name}'s roster — the mind won't delegate to it even if present. Enable it in the Mind editor.`
              }
              className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm"
              style={{
                borderColor: inRoom ? "rgba(0,240,255,0.4)" : "var(--glass-border)",
                background: inRoom ? "var(--accent-cyan-dim)" : "transparent",
                color: inRoom ? "var(--accent-cyan)" : "var(--text-secondary)",
                opacity: inRoster ? 1 : 0.45,
              }}
            >
              <AgentAvatar agent={a} size={18} />
              {a.name}
              {!inRoster ? <span className="text-[10px]">⚠</span> : null}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]/80">
        {mind.name} only sees and delegates to agents that are in this room. Dimmed agents are outside its
        roster — add them in the Mind editor first.
      </p>

      <FieldLabel>Memory</FieldLabel>
      <SegmentPicker
        options={(Object.keys(MEMORY_SCOPE_META) as MemoryScope[]).map((id) => ({
          id,
          label: MEMORY_SCOPE_META[id].label,
        }))}
        value={room.memoryScope}
        onChange={(memoryScope) => onPatch({ memoryScope })}
        hint={MEMORY_SCOPE_META[room.memoryScope].hint}
      />
      {room.memoryScope !== "off" ? (
        <p className="mt-1.5 text-[11px] text-[var(--text-secondary)]/70">
          Everything the mind remembers is readable in the Memory tab — it&apos;s markdown, not a black box.
        </p>
      ) : null}

      <FieldLabel>Schedules in this room</FieldLabel>
      {room.schedules.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)]/70">None yet.</p>
      ) : (
        <div className="space-y-2">
          {room.schedules.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2"
            >
              <div>
                <div className="text-sm text-[var(--text-primary)]">{s.label}</div>
                <div className="text-[11px] text-[var(--text-secondary)]">{s.cadence}</div>
              </div>
              <span className="text-[11px] text-[var(--accent-cyan)]/80">next: {s.nextRun}</span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 rounded-lg border border-dashed border-[var(--glass-border)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]/80">
        To add one, just ask the mind in the room — “every weekday at 9, post yesterday&apos;s ticket digest
        here.” Results arrive as normal messages or receipts.
      </p>

      <div className="mt-5 flex justify-between border-t border-[var(--glass-border)] pt-4">
        <button className="text-xs text-[var(--accent-red)]/80 hover:text-[var(--accent-red)]">
          Archive room
        </button>
        <button
          onClick={onClose}
          className="rounded-lg border border-[var(--glass-border)] px-4 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          Done
        </button>
      </div>
    </ModalShell>
  );
}
