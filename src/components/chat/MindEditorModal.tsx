"use client";

import { useState } from "react";
import {
  AGENTS,
  MODEL_OPTIONS,
  TOOL_POLICY_META,
  type Mind,
  type MindEffort,
  type Room,
  type ToolPolicy,
} from "./chatMockData";
import { AgentAvatar, MindAvatar } from "./ChatAvatars";
import { FieldLabel, ModalShell, SegmentPicker } from "./ChatModals";

// The Mind editor: who the orchestrator is in this workspace. Edits the soul +
// brain + boundaries of a harness profile. The kernel (how delegation, memory
// and tools mechanically work) is deliberately not editable — that's the
// shared engine.
export function MindEditorModal({
  room,
  minds,
  onSwitchMind,
  onSaveMind,
  onCloneMind,
  onClose,
}: {
  room: Room;
  minds: Record<string, Mind>;
  onSwitchMind: (mindId: string) => void;
  onSaveMind: (mind: Mind) => void;
  onCloneMind: (mindId: string) => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(room.mindId);
  const [draft, setDraft] = useState<Mind>({ ...minds[room.mindId] });

  const select = (id: string) => {
    setSelectedId(id);
    setDraft({ ...minds[id] });
  };

  const patch = (p: Partial<Mind>) => setDraft((d) => ({ ...d, ...p }));

  return (
    <ModalShell
      wide
      title={`Mind for #${room.name}`}
      subtitle="Pick which mind thinks in this room, or rewire the mind itself. Admins only."
      onClose={onClose}
    >
      <div className="flex flex-wrap gap-1.5">
        {Object.values(minds).map((m) => (
          <button
            key={m.id}
            onClick={() => select(m.id)}
            className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm"
            style={{
              borderColor: selectedId === m.id ? `${m.color}66` : "var(--glass-border)",
              background: selectedId === m.id ? `${m.color}0d` : "transparent",
              color: selectedId === m.id ? m.color : "var(--text-secondary)",
            }}
          >
            <MindAvatar mind={m} size={16} />
            {m.name}
            {room.mindId === m.id ? <span className="text-[10px] opacity-70">· current</span> : null}
          </button>
        ))}
        <button
          onClick={() => onCloneMind(selectedId)}
          className="rounded-full border border-dashed border-[var(--glass-border)] px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Duplicate this mind as a starting point"
        >
          + Clone
        </button>
      </div>

      {selectedId !== room.mindId ? (
        <button
          onClick={() => onSwitchMind(selectedId)}
          className="mt-3 w-full rounded-lg border py-2 text-sm"
          style={{
            borderColor: `${draft.color}55`,
            background: `${draft.color}12`,
            color: draft.color,
          }}
        >
          Use {draft.name} in #{room.name}
        </button>
      ) : null}

      <FieldLabel>Soul — who this mind is</FieldLabel>
      <textarea
        value={draft.soul}
        onChange={(e) => patch({ soul: e.target.value })}
        rows={5}
        className="w-full resize-y rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)]/40"
      />
      <p className="mt-1 text-[11px] text-[var(--text-secondary)]/70">
        This is the only prompt you edit. The kernel — how tools, memory, and delegation work — is the shared
        engine and stays identical for every mind.
      </p>

      <div className="mt-1 grid grid-cols-2 gap-4">
        <div>
          <FieldLabel>Brain</FieldLabel>
          <select
            value={draft.model}
            onChange={(e) => patch({ model: e.target.value })}
            className="w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <FieldLabel>Reasoning effort</FieldLabel>
          <SegmentPicker
            options={[
              { id: "low" as MindEffort, label: "Low" },
              { id: "medium" as MindEffort, label: "Medium" },
              { id: "high" as MindEffort, label: "High" },
            ]}
            value={draft.effort}
            onChange={(effort) => patch({ effort })}
          />
        </div>
      </div>

      <FieldLabel>Tool policy — what it may touch</FieldLabel>
      <SegmentPicker
        options={(Object.keys(TOOL_POLICY_META) as ToolPolicy[]).map((id) => ({
          id,
          label: TOOL_POLICY_META[id].label,
        }))}
        value={draft.toolPolicy}
        onChange={(toolPolicy) => patch({ toolPolicy })}
        hint={TOOL_POLICY_META[draft.toolPolicy].hint}
      />

      <FieldLabel>Agent roster — who it may delegate to</FieldLabel>
      <div className="flex flex-wrap gap-1.5">
        {Object.values(AGENTS).map((a) => {
          const on = draft.roster.includes(a.id);
          return (
            <button
              key={a.id}
              onClick={() =>
                patch({ roster: on ? draft.roster.filter((r) => r !== a.id) : [...draft.roster, a.id] })
              }
              className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm"
              style={{
                borderColor: on ? "rgba(0,240,255,0.4)" : "var(--glass-border)",
                background: on ? "var(--accent-cyan-dim)" : "transparent",
                color: on ? "var(--accent-cyan)" : "var(--text-secondary)",
              }}
            >
              <AgentAvatar agent={a} size={18} />
              {a.name}
            </button>
          );
        })}
      </div>

      <FieldLabel>Memory</FieldLabel>
      <SegmentPicker
        options={[
          { id: "workspace" as const, label: "Shared workspace memory" },
          { id: "mind" as const, label: "Own memory only" },
        ]}
        value={draft.memory}
        onChange={(memory) => patch({ memory })}
        hint={
          draft.memory === "workspace"
            ? "Learns into and recalls from the whole workspace's memory."
            : "Keeps a private memory — useful for external-facing minds."
        }
      />

      <div className="mt-5 flex items-center justify-between border-t border-[var(--glass-border)] pt-4">
        <span className="text-[11px] text-[var(--text-secondary)]/70">
          Changes apply to every room using {draft.name}.
        </span>
        <button
          onClick={() => onSaveMind(draft)}
          className="rounded-lg border border-[rgba(0,240,255,0.4)] bg-[var(--accent-cyan-dim)] px-4 py-2 text-sm text-[var(--accent-cyan)]"
        >
          Save mind
        </button>
      </div>
    </ModalShell>
  );
}
