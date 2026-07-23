"use client";

import { useState } from "react";
import type { Attention, Invite, Mind } from "./chatMockData";
import { MindAvatar } from "./ChatAvatars";

export function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className={`animate-slide-up max-h-[92dvh] w-full ${wide ? "sm:max-w-2xl" : "sm:max-w-md"} overflow-y-auto rounded-t-2xl border border-[var(--glass-border)] bg-[var(--bg-secondary)] pb-[env(safe-area-inset-bottom)] shadow-2xl sm:animate-none sm:max-h-[85vh] sm:rounded-2xl sm:pb-0`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[var(--glass-border)] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{subtitle}</p> : null}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-0.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function SegmentPicker<T extends string>({
  options,
  value,
  onChange,
  hint,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  hint?: string;
}) {
  return (
    <div>
      <div className="flex gap-1 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] p-1">
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
              value === o.id
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
            style={value === o.id ? { border: "1px solid rgba(0,240,255,0.25)" } : undefined}
          >
            {o.label}
          </button>
        ))}
      </div>
      {hint ? <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]/80">{hint}</p> : null}
    </div>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 mt-4 text-[11px] font-medium uppercase tracking-widest text-[var(--text-secondary)] first:mt-0">
      {children}
    </div>
  );
}

export function InviteModal({
  invites,
  onInvite,
  onClose,
}: {
  invites: Invite[];
  onInvite: (email: string, role: "admin" | "member") => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  return (
    <ModalShell
      title="Invite teammates"
      subtitle="If they already use Groovy, the invite pops up in their app instantly — accept in one click. Email is only the fallback for people who aren't here yet."
      onClose={onClose}
    >
      <FieldLabel>Email</FieldLabel>
      <div className="flex gap-2">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@company.com"
          className="min-w-0 flex-1 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]/50 focus:border-[var(--accent-cyan)]/40"
        />
        <button
          disabled={!email.includes("@")}
          onClick={() => {
            onInvite(email, role);
            setEmail("");
          }}
          className="rounded-lg border border-[rgba(0,240,255,0.4)] bg-[var(--accent-cyan-dim)] px-3 py-2 text-sm text-[var(--accent-cyan)] disabled:opacity-30"
        >
          Invite
        </button>
      </div>
      <FieldLabel>Role</FieldLabel>
      <SegmentPicker
        options={[
          { id: "member" as const, label: "Member" },
          { id: "admin" as const, label: "Admin" },
        ]}
        value={role}
        onChange={setRole}
        hint={
          role === "admin"
            ? "Admins can edit minds, tool policies, and workspace settings."
            : "Members chat, summon minds, and delegate to agents — but can't rewire them."
        }
      />
      <FieldLabel>Or share a link</FieldLabel>
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text-secondary)]">
          https://hq.groovy.chat/invite/8f3k2…
        </code>
        <button className="text-xs text-[var(--accent-cyan)] hover:underline">Copy</button>
      </div>
      {invites.length ? (
        <>
          <FieldLabel>Pending</FieldLabel>
          {invites.map((i) => (
            <div key={i.email} className="flex items-center justify-between py-1 text-sm">
              <span className="text-[var(--text-primary)]/90">{i.email}</span>
              <span className="text-xs text-[var(--text-secondary)]">
                {i.role} · {i.status === "pending" ? "delivered in-app" : i.status}
              </span>
            </div>
          ))}
        </>
      ) : null}
    </ModalShell>
  );
}

// Devices & hosting: agents are workspace citizens hosted by devices. Nobody
// is required to host anything — the app works connector-free, hosting is
// opt-in per device, and contributing a device to the workspace is an
// explicit, revocable consent.
export function DevicesModal({ onClose }: { onClose: () => void }) {
  const [requireApproval, setRequireApproval] = useState(true);
  const devices = [
    {
      name: "Carlos's MacBook",
      yours: true,
      online: true,
      hosting: "⚡ Kiko — contributed to Groovy HQ",
    },
    {
      name: "hq-server-1",
      yours: true,
      online: true,
      hosting: "📊 Atlas — always-on headless host",
    },
    {
      name: "Ana's MacBook",
      yours: false,
      online: false,
      hosting: "🔎 Scout — contributed by Ana",
    },
  ];
  return (
    <ModalShell
      title="Devices & hosting"
      subtitle="Agents run on devices. People just sign in — hosting is optional and per-device."
      onClose={onClose}
    >
      <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--bg-primary)] p-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">
        <span className="text-[var(--text-primary)]">Three ways to be here:</span>
        <span className="mt-1 block">
          <span className="text-[var(--accent-cyan)]">Use the app</span> — nothing to install. Chat, summon
          minds, delegate to workspace agents.
        </span>
        <span className="mt-1 block">
          <span className="text-[var(--accent-cyan)]">Host for yourself</span> — turn on the connector; your
          agents stay in your personal workspace.
        </span>
        <span className="mt-1 block">
          <span className="text-[var(--accent-cyan)]">Contribute to the workspace</span> — explicitly share a
          device so the team&apos;s minds can delegate to its agents.
        </span>
      </div>

      <FieldLabel>Devices in this workspace</FieldLabel>
      <div className="space-y-2">
        {devices.map((d) => (
          <div
            key={d.name}
            className="rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: d.online ? "var(--accent-green)" : "#ef444488" }}
              />
              <span className="text-sm text-[var(--text-primary)]">{d.name}</span>
              {d.yours ? (
                <span className="rounded-full border border-[var(--glass-border)] px-1.5 text-[10px] text-[var(--text-secondary)]">
                  yours
                </span>
              ) : null}
              <span className="ml-auto text-[10px] text-[var(--text-secondary)]">
                {d.online ? "online" : "offline"}
              </span>
            </div>
            <div className="mt-1 pl-4 text-[11px] text-[var(--text-secondary)]">{d.hosting}</div>
            {d.yours ? (
              <button className="mt-1.5 ml-4 text-[11px] text-[var(--text-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--accent-red)]">
                stop contributing
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <FieldLabel>Safety</FieldLabel>
      <button
        onClick={() => setRequireApproval((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2.5 text-left"
      >
        <span className="text-sm text-[var(--text-primary)]/90">
          Require my approval for tasks on my devices
        </span>
        <span
          className="rounded-full px-2 py-px text-[10px] uppercase tracking-wider"
          style={
            requireApproval
              ? { background: "rgba(16,185,129,0.14)", color: "var(--accent-green)", border: "1px solid rgba(16,185,129,0.4)" }
              : { border: "1px solid var(--glass-border)", color: "var(--text-secondary)" }
          }
        >
          {requireApproval ? "on" : "off"}
        </span>
      </button>

      <button className="mt-4 w-full rounded-lg border border-dashed border-[var(--glass-border)] py-2 text-xs text-[var(--text-secondary)] hover:border-[var(--accent-cyan)]/40 hover:text-[var(--text-primary)]">
        + Pair a new device (or add an always-on host)
      </button>
    </ModalShell>
  );
}

export function NewRoomModal({
  minds,
  onCreate,
  onClose,
}: {
  minds: Record<string, Mind>;
  onCreate: (opts: { name: string; mindId: string; visibility: "public" | "private"; attention: Attention }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [mindId, setMindId] = useState(Object.keys(minds)[0]);
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [attention, setAttention] = useState<Attention>("mention");
  return (
    <ModalShell
      title="New room"
      subtitle="Pick which mind thinks in here — you can change it anytime."
      onClose={onClose}
    >
      <FieldLabel>Name</FieldLabel>
      <div className="flex items-center gap-2 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2 focus-within:border-[var(--accent-cyan)]/40">
        <span className="text-[var(--text-secondary)]">#</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
          placeholder="launch-week"
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]/50"
        />
      </div>
      <FieldLabel>Mind</FieldLabel>
      <div className="space-y-1.5">
        {Object.values(minds).map((m) => (
          <button
            key={m.id}
            onClick={() => setMindId(m.id)}
            className="flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left"
            style={{
              borderColor: mindId === m.id ? `${m.color}55` : "var(--glass-border)",
              background: mindId === m.id ? `${m.color}0d` : "transparent",
            }}
          >
            <MindAvatar mind={m} size={22} />
            <span className="text-sm" style={{ color: mindId === m.id ? m.color : "var(--text-primary)" }}>
              {m.name}
            </span>
            <span className="ml-auto text-[11px] text-[var(--text-secondary)]">{m.model}</span>
          </button>
        ))}
      </div>
      <FieldLabel>Visibility</FieldLabel>
      <SegmentPicker
        options={[
          { id: "public" as const, label: "Public" },
          { id: "private" as const, label: "🔒 Private" },
        ]}
        value={visibility}
        onChange={setVisibility}
        hint={visibility === "private" ? "Only invited members can see or join this room." : "Anyone in the workspace can find and join."}
      />
      <FieldLabel>Mind attention</FieldLabel>
      <SegmentPicker
        options={[
          { id: "listening" as const, label: "Listening" },
          { id: "mention" as const, label: "On mention" },
          { id: "off" as const, label: "Off" },
        ]}
        value={attention}
        onChange={setAttention}
      />
      <button
        disabled={!name.trim()}
        onClick={() => onCreate({ name: name.trim(), mindId, visibility, attention })}
        className="mt-5 w-full rounded-lg border border-[rgba(0,240,255,0.4)] bg-[var(--accent-cyan-dim)] py-2 text-sm text-[var(--accent-cyan)] disabled:opacity-30"
      >
        Create room
      </button>
    </ModalShell>
  );
}
