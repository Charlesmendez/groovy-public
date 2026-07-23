import Link from "next/link";

export type RailWorkspace = { id: string; label: string; emoji: string; active?: boolean; fresh?: boolean };

// Thin far-left rail present on both surfaces: workspaces up top, then the
// surface switcher — Chat and Command center are two views of one workspace.
export function AppRail({ workspaces }: { workspaces: RailWorkspace[] }) {
  return (
    <nav className="flex h-full w-14 shrink-0 flex-col items-center border-r border-[var(--glass-border)] bg-[var(--bg-primary)] py-3">
      <div className="mb-3 flex flex-col items-center gap-2">
        {workspaces.map((ws) => (
          <div
            key={ws.id}
            className="relative flex h-9 w-9 items-center justify-center rounded-xl text-lg"
            title={ws.label}
            style={{
              background: ws.active ? "var(--accent-cyan-dim)" : "var(--bg-tertiary)",
              border: ws.active ? "1px solid rgba(0,240,255,0.3)" : "1px solid var(--glass-border)",
            }}
          >
            {ws.emoji}
            {ws.fresh ? (
              <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-[var(--accent-green)] ring-2 ring-[var(--bg-primary)]" />
            ) : null}
          </div>
        ))}
      </div>
      <div className="mb-1 h-px w-7 bg-[var(--glass-border)]" />
      <div className="flex flex-col items-center gap-1">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-base"
          title="Chat — you are here"
          style={{ border: "1px solid rgba(0,240,255,0.35)" }}
        >
          💬
        </div>
        <span className="text-[9px] uppercase tracking-wider text-[var(--accent-cyan)]">Chat</span>
      </div>
      <div className="mt-3 flex flex-col items-center gap-1">
        <Link
          href="/dashboard"
          className="flex h-10 w-10 items-center justify-center rounded-xl text-base text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          title="Command center — operate agents, tasks, schedules"
        >
          🎛️
        </Link>
        <span className="text-[9px] uppercase tracking-wider text-[var(--text-secondary)]">Ops</span>
      </div>
      <div className="mt-auto">
        <button
          className="flex h-10 w-10 items-center justify-center rounded-xl text-base text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          title="Workspace settings"
        >
          ⚙️
        </button>
      </div>
    </nav>
  );
}
