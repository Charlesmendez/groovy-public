import type { Agent, Mind, Person } from "./chatMockData";

export function PersonAvatar({ person, size = 32 }: { person: Person; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-medium"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.34,
        background: `hsl(${person.hue} 45% 22%)`,
        color: `hsl(${person.hue} 80% 78%)`,
        border: `1px solid hsl(${person.hue} 60% 40% / 0.5)`,
      }}
    >
      {person.initials}
    </div>
  );
}

export function MindAvatar({ mind, size = 32 }: { mind: Mind; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        background: `${mind.color}14`,
        border: `1.5px solid ${mind.color}80`,
        boxShadow: `0 0 ${size / 3}px ${mind.color}30`,
      }}
    >
      <div
        className="rounded-full"
        style={{ width: size * 0.28, height: size * 0.28, background: mind.color }}
      />
    </div>
  );
}

export function AgentAvatar({ agent, size = 32 }: { agent: Agent; size?: number }) {
  return (
    <div
      className="relative flex shrink-0 items-center justify-center rounded-lg bg-[var(--bg-tertiary)]"
      style={{ width: size, height: size, fontSize: size * 0.5, border: "1px solid var(--glass-border)" }}
    >
      <span aria-hidden>{agent.emoji}</span>
      <span
        className="absolute -right-0.5 -bottom-0.5 rounded-full"
        style={{
          width: size * 0.28,
          height: size * 0.28,
          background: !agent.online
            ? "#ef444488"
            : agent.status === "working"
              ? "var(--accent-cyan)"
              : "#3f3f50",
          border: "2px solid var(--bg-secondary)",
        }}
      />
    </div>
  );
}
