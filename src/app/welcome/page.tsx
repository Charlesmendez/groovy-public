"use client";

// Onboarding UI/UX prototype (mock, no backend) for the harness platform.
// Three paths with very different weights:
//   Join a team  → zero setup: account → you're in. Desktop app optional.
//   Start a workspace → name it, shape your first mind, keys, hosting, invites.
//   Just me → the personal flow, condensed.
// Hosting (connector) is ALWAYS an optional branch, never the trunk.

import Link from "next/link";
import { useState } from "react";
import { INITIAL_MINDS, MODEL_OPTIONS } from "@/components/chat/chatMockData";
import { MindAvatar } from "@/components/chat/ChatAvatars";

type Path = "join" | "start" | "solo";

function Shell({
  children,
  step,
  totalSteps,
  onBack,
}: {
  children: React.ReactNode;
  step?: number;
  totalSteps?: number;
  onBack?: () => void;
}) {
  return (
    <div className="app-viewport-shell flex items-center justify-center overflow-y-auto bg-[var(--bg-primary)] px-4 text-[var(--text-primary)]">
      <div className="w-full max-w-lg py-10">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl">🦥</span>
            <span className="font-display tracking-widest">GROOVY</span>
          </div>
          {typeof step === "number" && totalSteps ? (
            <div className="flex items-center gap-1.5">
              {Array.from({ length: totalSteps }, (_, i) => (
                <span
                  key={i}
                  className="h-1.5 rounded-full transition-all"
                  style={{
                    width: i === step ? 20 : 6,
                    background: i <= step ? "var(--accent-cyan)" : "var(--bg-tertiary)",
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
        <div className="rounded-2xl border border-[var(--glass-border)] bg-[var(--bg-secondary)]/70 p-6">
          {children}
        </div>
        {onBack ? (
          <button
            onClick={onBack}
            className="mt-3 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            ← Back
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Title({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold">{children}</h1>
      {sub ? <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{sub}</p> : null}
    </div>
  );
}

function BigChoice({
  emoji,
  title,
  sub,
  badge,
  onClick,
}: {
  emoji: string;
  title: string;
  sub: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-4 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-primary)] px-4 py-4 text-left transition-colors hover:border-[var(--accent-cyan)]/40"
    >
      <span className="text-2xl">{emoji}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[15px] font-medium">
          {title}
          {badge ? (
            <span className="rounded-full bg-[var(--accent-cyan-dim)] px-2 py-px text-[10px] uppercase tracking-wider text-[var(--accent-cyan)]">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-secondary)]">{sub}</span>
      </span>
      <span className="text-[var(--text-secondary)]">→</span>
    </button>
  );
}

function CTA({ children, onClick, href }: { children: React.ReactNode; onClick?: () => void; href?: string }) {
  const cls =
    "mt-5 block w-full rounded-xl border border-[rgba(0,240,255,0.4)] bg-[var(--accent-cyan-dim)] py-2.5 text-center text-sm text-[var(--accent-cyan)] transition-colors hover:bg-[rgba(0,240,255,0.25)]";
  return href ? (
    <Link href={href} className={cls}>
      {children}
    </Link>
  ) : (
    <button onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

function Input({ label, placeholder, value, onChange, type }: { label: string; placeholder: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-widest text-[var(--text-secondary)]">
        {label}
      </span>
      <input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm outline-none placeholder:text-[var(--text-secondary)]/50 focus:border-[var(--accent-cyan)]/40"
      />
    </label>
  );
}

export default function WelcomePage() {
  const [path, setPath] = useState<Path | null>(null);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [wsName, setWsName] = useState("");
  const [mindTemplate, setMindTemplate] = useState("groovy");
  const [hosting, setHosting] = useState<"skip" | "this" | "server" | null>(null);

  const reset = () => {
    setPath(null);
    setStep(0);
  };
  const back = () => (step === 0 ? reset() : setStep((s) => s - 1));

  // ——— Path picker ———
  if (!path) {
    return (
      <Shell>
        <Title sub="Three ways in. Only one of them installs anything — and even that is optional.">
          How do you want to start?
        </Title>
        <div className="space-y-2.5">
          <BigChoice
            emoji="🎟️"
            title="Join my team"
            badge="zero setup"
            sub="You got an invite. Create an account and you're in — the workspace's minds, agents, and rooms are already there."
            onClick={() => {
              setPath("join");
              setStep(0);
            }}
          />
          <BigChoice
            emoji="🏗️"
            title="Set up my company's harness"
            sub="Name the workspace, shape your first mind, connect a model key, decide where agents run, invite the team."
            onClick={() => {
              setPath("start");
              setStep(0);
            }}
          />
          <BigChoice
            emoji="🧍"
            title="Just me"
            sub="A personal Groovy. Your own mind and memory — add agents and devices whenever you feel like it."
            onClick={() => {
              setPath("solo");
              setStep(0);
            }}
          />
        </div>
      </Shell>
    );
  }

  // ——— Join a team: invite → account → membership ———
  if (path === "join") {
    if (step === 0)
      return (
        <Shell step={0} totalSteps={3} onBack={back}>
          <Title sub="This is everything the invite tells us — nothing to configure.">You&apos;re invited</Title>
          <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--bg-primary)] p-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🦥</span>
              <div>
                <div className="text-[15px] font-medium">Groovy HQ</div>
                <div className="text-xs text-[var(--text-secondary)]">
                  Invited by Carlos · as a member · 3 teammates, 3 agents, 3 minds
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {Object.values(INITIAL_MINDS).map((m) => (
                <span
                  key={m.id}
                  className="flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px]"
                  style={{ borderColor: `${m.color}40`, color: m.color }}
                >
                  <MindAvatar mind={m} size={14} />
                  {m.name}
                </span>
              ))}
            </div>
          </div>
          <CTA onClick={() => setStep(1)}>Accept invite</CTA>
        </Shell>
      );
    if (step === 1)
      return (
        <Shell step={1} totalSteps={3} onBack={back}>
          <Title sub="One account, and you're done. No keys, no installs, no configuration.">
            Create your account
          </Title>
          <Input label="Name" placeholder="Ana Vargas" value={name} onChange={setName} />
          <Input label="Email" placeholder="ana@datagran.io" value={""} onChange={() => {}} />
          <Input label="Password" placeholder="••••••••" type="password" value={""} onChange={() => {}} />
          <CTA onClick={() => setStep(2)}>Create account →</CTA>
        </Shell>
      );
    return (
      <Shell step={2} totalSteps={3} onBack={back}>
        <Title sub="Seriously — that was the whole setup.">You&apos;re in{name ? `, ${name.split(" ")[0]}` : ""} 🎉</Title>
        <div className="space-y-2.5">
          <div className="rounded-xl border border-[#10b98133] bg-[#10b9810d] px-4 py-3 text-sm leading-relaxed text-[var(--text-primary)]/85">
            The workspace is ready for you: minds to talk to, agents already hosted on your team&apos;s devices,
            rooms with the full history. Nothing runs on your machine.
          </div>
          <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--bg-primary)] px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              🖥️ Desktop app
              <span className="rounded-full border border-[var(--glass-border)] px-2 py-px text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
                optional
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
              Same thing as the browser, in its own window with notifications. It will NOT install a connector
              or run agents unless you explicitly turn that on later.
            </p>
            <button className="mt-2 text-xs text-[var(--accent-cyan)] hover:underline">
              Download for macOS ↓
            </button>
          </div>
          <div className="rounded-xl border border-dashed border-[var(--glass-border)] px-4 py-3 text-xs leading-relaxed text-[var(--text-secondary)]">
            Want to host agents on your machine someday? That lives under ⌂ Devices in the sidebar — explicit,
            revocable, and never required.
          </div>
        </div>
        <CTA href="/chat">Jump into #support →</CTA>
      </Shell>
    );
  }

  // ——— Start a workspace: name → mind → keys → hosting → invite ———
  if (path === "start") {
    const total = 5;
    if (step === 0)
      return (
        <Shell step={0} totalSteps={total} onBack={back}>
          <Title sub="The workspace is your company's harness: its minds, agents, rooms, and memory.">
            Name your workspace
          </Title>
          <Input label="Workspace name" placeholder="Datagran HQ" value={wsName} onChange={setWsName} />
          <CTA onClick={() => setStep(1)}>Continue →</CTA>
        </Shell>
      );
    if (step === 1)
      return (
        <Shell step={1} totalSteps={total} onBack={back}>
          <Title sub="Start from a template — you'll edit its soul, tools, and roster anytime in the Mind editor.">
            Shape your first mind
          </Title>
          <div className="space-y-2">
            {Object.values(INITIAL_MINDS).map((m) => (
              <button
                key={m.id}
                onClick={() => setMindTemplate(m.id)}
                className="flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left"
                style={{
                  borderColor: mindTemplate === m.id ? `${m.color}55` : "var(--glass-border)",
                  background: mindTemplate === m.id ? `${m.color}0a` : "transparent",
                }}
              >
                <MindAvatar mind={m} size={26} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-sm font-medium" style={{ color: m.color }}>
                      {m.name}
                    </span>
                    <span className="text-[11px] text-[var(--text-secondary)]">{m.model}</span>
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-secondary)]">
                    {m.tagline}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <CTA onClick={() => setStep(2)}>Use this template →</CTA>
        </Shell>
      );
    if (step === 2)
      return (
        <Shell step={2} totalSteps={total} onBack={back}>
          <Title sub="Bring your own key — Groovy doesn't mark up tokens. Teammates never need their own keys.">
            Connect a brain
          </Title>
          <label className="mb-3 block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-widest text-[var(--text-secondary)]">
              Model
            </span>
            <select className="w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm outline-none">
              {MODEL_OPTIONS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <Input label="API key" placeholder="sk-ant-…" type="password" value={""} onChange={() => {}} />
          <CTA onClick={() => setStep(3)}>Continue →</CTA>
        </Shell>
      );
    if (step === 3)
      return (
        <Shell step={3} totalSteps={total} onBack={back}>
          <Title sub="Where should agents physically run? You can change or mix these anytime under ⌂ Devices.">
            Hosting
          </Title>
          <div className="space-y-2.5">
            <BigChoice
              emoji="💬"
              title="Skip for now"
              badge="recommended"
              sub="Chat-only to start. Minds answer, remember, and plan — add agents when you need hands."
              onClick={() => {
                setHosting("skip");
                setStep(4);
              }}
            />
            <BigChoice
              emoji="💻"
              title="This machine"
              sub="Download the desktop app and turn on host mode — agents run here while it's awake."
              onClick={() => {
                setHosting("this");
                setStep(4);
              }}
            />
            <BigChoice
              emoji="🌐"
              title="Always-on host"
              sub="A hosted Mac from us, or a headless connector on your own server. Agents never sleep."
              onClick={() => {
                setHosting("server");
                setStep(4);
              }}
            />
          </div>
        </Shell>
      );
    return (
      <Shell step={4} totalSteps={total} onBack={back}>
        <Title sub="They get the zero-setup path: account → in. No keys, no installs on their side.">
          Invite your team
        </Title>
        <Input label="Emails" placeholder="ana@datagran.io, leo@datagran.io" value={""} onChange={() => {}} />
        <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--bg-primary)] px-4 py-3 text-xs leading-relaxed text-[var(--text-secondary)]">
          {wsName || "Your workspace"} is ready: <span className="text-[var(--text-primary)]">#general</span>{" "}
          with {INITIAL_MINDS[mindTemplate].name} listening
          {hosting === "skip"
            ? ", chat-only until you add a device."
            : hosting === "this"
              ? ", agents hosted on this machine."
              : ", agents on an always-on host."}
        </div>
        <CTA href="/chat">Open your workspace →</CTA>
      </Shell>
    );
  }

  // ——— Just me: condensed ———
  return (
    <Shell step={0} totalSteps={1} onBack={back}>
      <Title sub="Your personal mind and memory are ready. Hosting is optional here too.">Just you and Groovy</Title>
      <div className="space-y-2.5">
        <div className="rounded-xl border border-[#10b98133] bg-[#10b9810d] px-4 py-3 text-sm leading-relaxed text-[var(--text-primary)]/85">
          Groovy (the default mind) is set up with your private workspace and memory. Talk to it in the
          browser, the desktop app, or WhatsApp/Telegram.
        </div>
        <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--bg-primary)] px-4 py-3">
          <div className="text-sm font-medium">Want it to have hands?</div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
            Turn on host mode in the desktop app to run agents on this machine — or skip it and Groovy stays
            a brilliant chat-only companion.
          </p>
        </div>
      </div>
      <CTA href="/chat">Start talking →</CTA>
    </Shell>
  );
}
