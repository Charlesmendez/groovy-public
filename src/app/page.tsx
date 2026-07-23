"use client";

/**
 * Groovy landing page — the agent harness.
 *
 * The hero is a self-playing simulation of the real product: an orchestrator
 * receiving a command, dispatching two named agents (Claude Code + Codex),
 * a plan approval, and the WhatsApp completion ping. Show, don't tell.
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MultiplayerSection } from "@/components/marketing/MultiplayerSection";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Bot,
  Brain,
  CalendarClock,
  Check,
  CheckCircle2,
  CreditCard,
  Database,
  FileText,
  KeyRound,
  Laptop,
  Loader2,
  Lock,
  Mail,
  Menu,
  MessageCircle,
  Server,
  Shield,
  Sparkles,
  Terminal,
  Wifi,
  X,
  type LucideIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const NAV_LINKS = [
  { label: "Integrations", href: "/integrations" },
  { label: "Download", href: "/account/downloads" },
  { label: "Pricing", href: "#pricing" },
  { label: "Setup", href: "/setup" },
  { label: "Sign in", href: "/login" },
];

const HOW_IT_WORKS = [
  {
    index: "01",
    title: "Hire",
    command: "new agent → Fixter · Claude Code · ~/repos/api",
    description:
      "An agent is a real coding harness — Claude Code or Codex — bound to a repo on your machine. Give it a name, a workspace, a model, and the skills it should know.",
  },
  {
    index: "02",
    title: "Dispatch",
    command: "@Fixter fix the flaky auth test",
    description:
      "Talk to one orchestrator. @mention an agent for precision, or describe the outcome and let it route, sequence, and hand context between agents for you.",
  },
  {
    index: "03",
    title: "Ship",
    command: "✓ Fixter finished · 2 files changed · +41 −12",
    description:
      "Watch every agent work live in the grid. Risky work waits for your approval. Done work pings your phone. Transcripts, diffs, and costs are all on the record.",
  },
];

const MODEL_MIX = [
  { role: "Orchestrator", model: "Fable 5", note: "plans & routes", tone: "violet" },
  { role: "Fixter · Claude Code", model: "Opus 4.7", note: "hard refactors", tone: "orange" },
  { role: "Reviewer · Codex", model: "GPT-5.6 Sol", note: "adversarial review", tone: "emerald" },
  { role: "Docsmith · Claude Code", model: "Haiku 4.5", note: "cheap & fast", tone: "cyan" },
  { role: "Heartbeat digest", model: "GPT-5.6 Luna", note: "daily summaries", tone: "zinc" },
];

const MODEL_TONES: Record<string, string> = {
  violet: "border-violet-400/25 bg-violet-500/[0.06] text-violet-200",
  orange: "border-orange-400/25 bg-orange-500/[0.06] text-orange-200",
  emerald: "border-emerald-400/25 bg-emerald-500/[0.06] text-emerald-200",
  cyan: "border-cyan-400/25 bg-cyan-500/[0.06] text-cyan-200",
  zinc: "border-white/10 bg-white/[0.04] text-zinc-300",
};

const FEATURES: Array<{
  icon: LucideIcon;
  title: string;
  description: string;
  mono?: string;
}> = [
  {
    icon: FileText,
    title: "Plans are files, not chat scrolls",
    description:
      "Flip on plan mode and an agent drafts read-only. Approve it and the plan lands in the repo — where Claude Code, Codex, and your teammates can all read it.",
    mono: ".claude/plans/2026-07-10-auth-fix.md",
  },
  {
    icon: Sparkles,
    title: "Skills from your own repo",
    description:
      "Markdown playbooks, synced from git, assigned per agent. Claude Code agents get CLAUDE.md context, Codex agents get AGENTS.md — automatically materialized on device.",
    mono: "skills/deploy-checklist.md → Fixter",
  },
  {
    icon: CalendarClock,
    title: "Agents on cron",
    description:
      "Tell the orchestrator when and who: nightly test triage, weekly dependency bumps, or a 7:30 report. Each run uses that agent's harness, workspace, model, and skills while its connector machine is awake and online.",
    mono: 'daily @ 07:30 → Scout: "triage new issues"',
  },
  {
    icon: MessageCircle,
    title: "WhatsApp is your remote",
    description:
      "Dispatch from your phone, get pinged when work lands, and approve or reject with a reply. The harness doesn't stop because you stood up.",
    mono: '"approve 3f2a91" → running',
  },
  {
    icon: Brain,
    title: "Context moves between agents",
    description:
      "One command summarizes what an agent learned and briefs another — findings from Scout become marching orders for Fixter. No copy-paste archaeology.",
    mono: "transfer_context Scout → Fixter",
  },
  {
    icon: BarChart3,
    title: "Spend, by agent, with receipts",
    description:
      "Every token is attributed to an agent, a model, and an outcome. Ask the orchestrator to analyze it and it recommends cheaper model mixes that won't cost you quality.",
    mono: "usage_report --days 30",
  },
];

const TRUST_POINTS: Array<{ icon: LucideIcon; title: string; description: string }> = [
  {
    icon: Laptop,
    title: "Runs on your machine",
    description:
      "Agents execute in your repos through a local connector. Your code never transits our servers.",
  },
  {
    icon: KeyRound,
    title: "Your keys, your bill",
    description:
      "Anthropic, OpenAI, Google, Azure, Bedrock — bring your own credentials. Groovy adds no token markup.",
  },
  {
    icon: Lock,
    title: "Approval where it matters",
    description:
      "Destructive work waits for a human. Plans wait for review. Everything else just ships.",
  },
  {
    icon: Shield,
    title: "Source-available",
    description:
      "Each tagged release is mirrored publicly. Trust is something you can read.",
  },
];

const pricingCards = [
  {
    icon: KeyRound,
    eyebrow: "Groovy Personal",
    title: "For personal projects",
    price: "$49.99",
    unit: "per year",
    tone: "cyan",
    details: [
      "One individual, personal non-commercial use.",
      "Two activated devices.",
      "Current downloads, updates, and source snapshots while active.",
    ],
  },
  {
    icon: Server,
    eyebrow: "Groovy Enterprise",
    title: "For companies",
    price: "Contact sales",
    unit: "annual license",
    tone: "emerald",
    details: [
      "Commercial use, self-hosting, and internal modification rights.",
      "Source access, support, security, and contract terms.",
      "Fallback rights to the last paid version if you do not renew.",
    ],
  },
  {
    icon: Shield,
    eyebrow: "Default billing",
    title: "No token tax",
    price: "$0",
    unit: "Groovy token markup",
    tone: "amber",
    details: [
      "Connect your own OpenAI, Anthropic, Google, Azure, Bedrock, Groq, or Mistral keys.",
      "You control provider usage and provider billing.",
      "Groovy usage analytics are separate from Groovy licensing.",
    ],
  },
  {
    icon: BarChart3,
    eyebrow: "Approved partners",
    title: "Reseller billing",
    price: "By agreement",
    unit: "authorized only",
    tone: "rose",
    details: [
      "Usage-based billing stays off unless the license explicitly enables it.",
      "Approved resellers can meter customer usage and export billing data.",
      "Normal personal and enterprise customers never see reseller controls.",
    ],
  },
];

const pricingToneClasses: Record<string, { badge: string; icon: string; accent: string }> = {
  cyan: {
    badge: "text-cyan-300 bg-cyan-500/10 border-cyan-500/20",
    icon: "text-cyan-300 bg-cyan-500/10 border-cyan-500/20",
    accent: "border-cyan-500/30",
  },
  emerald: {
    badge: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20",
    icon: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20",
    accent: "border-emerald-500/30",
  },
  amber: {
    badge: "text-amber-300 bg-amber-500/10 border-amber-500/20",
    icon: "text-amber-300 bg-amber-500/10 border-amber-500/20",
    accent: "border-amber-500/30",
  },
  rose: {
    badge: "text-rose-300 bg-rose-500/10 border-rose-500/20",
    icon: "text-rose-300 bg-rose-500/10 border-rose-500/20",
    accent: "border-rose-500/30",
  },
};

// ---------------------------------------------------------------------------
// Hero simulation — a scripted loop of the real product
// ---------------------------------------------------------------------------

const DEMO_COMMAND = "@Fixter fix the flaky auth test, then have Reviewer check it";

type DemoAgentState = "idle" | "working" | "done";

type DemoFrame = {
  typedChars: number;
  orchestratorLine: string | null;
  fixter: DemoAgentState;
  fixterLog: string[];
  reviewer: DemoAgentState;
  reviewerLog: string[];
  tasks: Array<{ label: string; status: "queued" | "running" | "done" }>;
  toast: string | null;
};

const IDLE_FRAME: DemoFrame = {
  typedChars: 0,
  orchestratorLine: null,
  fixter: "idle",
  fixterLog: [],
  reviewer: "idle",
  reviewerLog: [],
  tasks: [],
  toast: null,
};

function useHeroDemo() {
  const [frame, setFrame] = useState<DemoFrame>(IDLE_FRAME);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    const run = async () => {
      // Respect reduced motion: show the finished state, no loop.
      if (
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ) {
        setFrame({
          typedChars: DEMO_COMMAND.length,
          orchestratorLine: "Both tasks complete. Diff is clean — Reviewer approved.",
          fixter: "done",
          fixterLog: ["ran tests · 1 flaky", "fixed race in auth.test.ts", "✓ 14/14 passing"],
          reviewer: "done",
          reviewerLog: ["read diff · +41 −12", "✓ approved: race fixed correctly"],
          tasks: [
            { label: "Fix flaky auth test", status: "done" },
            { label: "Review Fixter's diff", status: "done" },
          ],
          toast: "✅ Fixter finished: flaky auth test fixed",
        });
        return;
      }

      while (true) {
        if (cancelledRef.current) return;
        setFrame(IDLE_FRAME);
        await sleep(900);

        // 1. Type the command
        for (let i = 1; i <= DEMO_COMMAND.length; i++) {
          if (cancelledRef.current) return;
          setFrame((f) => ({ ...f, typedChars: i }));
          await sleep(26);
        }
        await sleep(500);

        // 2. Orchestrator queues on Fixter
        if (cancelledRef.current) return;
        setFrame((f) => ({
          ...f,
          orchestratorLine: "Queued on Fixter (Claude Code · Opus 4.7). Reviewer is on deck.",
          tasks: [{ label: "Fix flaky auth test", status: "queued" }],
        }));
        await sleep(1100);

        // 3. Fixter works
        if (cancelledRef.current) return;
        setFrame((f) => ({
          ...f,
          fixter: "working",
          tasks: [{ label: "Fix flaky auth test", status: "running" }],
        }));
        const fixterLines = [
          "ran tests · 1 flaky",
          "found race in auth.test.ts:88",
          "await session.ready() before assert",
          "✓ 14/14 passing",
        ];
        for (const line of fixterLines) {
          if (cancelledRef.current) return;
          setFrame((f) => ({ ...f, fixterLog: [...f.fixterLog, line] }));
          await sleep(950);
        }

        // 4. Fixter done → Reviewer starts
        if (cancelledRef.current) return;
        setFrame((f) => ({
          ...f,
          fixter: "done",
          reviewer: "working",
          tasks: [
            { label: "Fix flaky auth test", status: "done" },
            { label: "Review Fixter's diff", status: "running" },
          ],
        }));
        await sleep(700);
        const reviewerLines = ["read diff · +41 −12", "✓ approved: race fixed correctly"];
        for (const line of reviewerLines) {
          if (cancelledRef.current) return;
          setFrame((f) => ({ ...f, reviewerLog: [...f.reviewerLog, line] }));
          await sleep(1000);
        }

        // 5. Wrap: reviewer done, toast, final orchestrator line
        if (cancelledRef.current) return;
        setFrame((f) => ({
          ...f,
          reviewer: "done",
          tasks: [
            { label: "Fix flaky auth test", status: "done" },
            { label: "Review Fixter's diff", status: "done" },
          ],
          toast: "✅ Fixter finished: flaky auth test fixed",
          orchestratorLine: "Both tasks complete. Diff is clean — Reviewer approved.",
        }));
        await sleep(4200);
      }
    };

    void run();
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  return frame;
}

function DemoAgentTile({
  name,
  harness,
  model,
  state,
  log,
  accent,
}: {
  name: string;
  harness: string;
  model: string;
  state: DemoAgentState;
  log: string[];
  accent: "orange" | "emerald";
}) {
  const accentClasses =
    accent === "orange"
      ? { chip: "bg-orange-500/10 text-orange-300", beam: "via-orange-400" }
      : { chip: "bg-emerald-500/10 text-emerald-300", beam: "via-emerald-400" };
  return (
    <div
      className={`relative rounded-xl border bg-black/30 overflow-hidden transition-colors duration-500 ${
        state === "working" ? "border-white/20" : "border-white/10"
      }`}
    >
      {state === "working" && (
        <div className="absolute top-0 left-0 right-0 h-[2px] overflow-hidden">
          <div
            className={`h-full w-1/3 bg-gradient-to-r from-transparent ${accentClasses.beam} to-transparent animate-[harness-beam_1.6s_linear_infinite]`}
          />
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
        <span
          className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${
            state === "working"
              ? "bg-cyan-400 animate-pulse"
              : state === "done"
                ? "bg-emerald-400"
                : "bg-zinc-700"
          }`}
        />
        <span className="text-xs font-semibold text-white">{name}</span>
        <span className={`text-[9px] px-1.5 py-px rounded ${accentClasses.chip}`}>{harness}</span>
        <span className="ml-auto text-[9px] font-mono text-zinc-600">{model}</span>
      </div>
      <div className="px-3 py-2 h-[92px] font-mono text-[10px] leading-relaxed text-zinc-500 overflow-hidden">
        <AnimatePresence initial={false}>
          {log.length === 0 ? (
            <span className="text-zinc-700">idle — awaiting dispatch</span>
          ) : (
            log.slice(-4).map((line) => (
              <motion.div
                key={line}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className={line.startsWith("✓") ? "text-emerald-400/90" : undefined}
              >
                {line}
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function HeroDemo() {
  const frame = useHeroDemo();

  // Decorative product simulation: no interactive elements, hidden from
  // assistive tech so the tiny mono text is never announced or focusable.
  return (
    <div className="relative" aria-hidden="true">
      {/* Glow */}
      <div className="absolute -inset-6 bg-gradient-to-br from-cyan-500/10 via-transparent to-violet-500/10 rounded-3xl blur-2xl pointer-events-none" />

      <div className="relative rounded-2xl border border-white/10 bg-zinc-950/90 backdrop-blur-xl shadow-2xl overflow-hidden">
        {/* Window chrome */}
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/5 bg-white/[0.02]">
          <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
          <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
          <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
          <span className="ml-3 text-[10px] font-mono text-zinc-600">groovy — harness</span>
          <span className="ml-auto flex items-center gap-1 text-[9px] text-emerald-400">
            <Wifi className="w-2.5 h-2.5" /> connector online
          </span>
        </div>

        <div className="p-3 sm:p-4 space-y-3">
          {/* Command bar */}
          <div className="rounded-xl border border-cyan-400/20 bg-black/40 px-3 py-2.5 font-mono text-[11px] sm:text-xs">
            <span className="text-cyan-400 select-none">❯ </span>
            <span className="text-zinc-100">{DEMO_COMMAND.slice(0, frame.typedChars)}</span>
            <span className="inline-block w-[7px] h-3.5 bg-cyan-400 ml-px align-middle animate-pulse" />
          </div>

          {/* Orchestrator response */}
          <div className="h-5 px-1">
            <AnimatePresence mode="wait">
              {frame.orchestratorLine && (
                <motion.div
                  key={frame.orchestratorLine}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-1.5 text-[10px] sm:text-[11px] text-zinc-400"
                >
                  <Brain className="w-3 h-3 text-violet-400 shrink-0" />
                  {frame.orchestratorLine}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Agent grid */}
          <div className="grid grid-cols-2 gap-3">
            <DemoAgentTile
              name="Fixter"
              harness="Claude Code"
              model="opus-4.7"
              state={frame.fixter}
              log={frame.fixterLog}
              accent="orange"
            />
            <DemoAgentTile
              name="Reviewer"
              harness="Codex"
              model="gpt-5.6-sol"
              state={frame.reviewer}
              log={frame.reviewerLog}
              accent="emerald"
            />
          </div>

          {/* Task rail */}
          <div className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2 min-h-[58px]">
            <div className="text-[9px] uppercase tracking-widest text-zinc-600 mb-1.5">Tasks</div>
            <div className="space-y-1">
              <AnimatePresence initial={false}>
                {frame.tasks.length === 0 ? (
                  <span className="text-[10px] font-mono text-zinc-700">—</span>
                ) : (
                  frame.tasks.map((task) => (
                    <motion.div
                      key={task.label}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-center gap-2 text-[10px] sm:text-[11px]"
                    >
                      {task.status === "running" ? (
                        <Loader2 className="w-3 h-3 text-cyan-300 animate-spin shrink-0" />
                      ) : task.status === "done" ? (
                        <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                      ) : (
                        <span className="w-3 h-3 rounded-full border border-zinc-700 shrink-0" />
                      )}
                      <span
                        className={task.status === "done" ? "text-zinc-500" : "text-zinc-300"}
                      >
                        {task.label}
                      </span>
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* WhatsApp toast */}
        <AnimatePresence>
          {frame.toast && (
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8 }}
              className="absolute bottom-3 right-3 flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-zinc-900/95 backdrop-blur px-3 py-2 shadow-xl"
            >
              <MessageCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <div>
                <div className="text-[9px] text-zinc-500">WhatsApp</div>
                <div className="text-[10px] text-zinc-200">{frame.toast}</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function LandingPage() {
  const [mounted, setMounted] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    document.body.style.overflow = "auto";
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = "";
    };
  }, []);

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] relative overflow-x-hidden">
      {/* Noise overlay */}
      <div className="noise-overlay" />

      {/* Background effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-cyan-500/10 rounded-full blur-[120px] animate-float" />
        <div
          className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-violet-500/10 rounded-full blur-[120px] animate-float"
          style={{ animationDelay: "-5s" }}
        />
      </div>

      {/* Grid background */}
      <div className="fixed inset-0 bg-grid opacity-30" />

      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[var(--bg-primary)]/80 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex items-center justify-between gap-3">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={mounted ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.6 }}
          >
            <Image
              src="/Groovy_no_bg.png"
              alt="Groovy"
              width={400}
              height={112}
              className="h-20 sm:h-28 w-auto -my-3 sm:-my-4"
              unoptimized
              priority
            />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={mounted ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.6 }}
            className="hidden md:flex items-center gap-2 lg:gap-4"
          >
            {NAV_LINKS.map((item) =>
              item.href.startsWith("#") ? (
                <a
                  key={item.label}
                  href={item.href}
                  className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
                >
                  {item.label}
                </a>
              ) : (
                <Link
                  key={item.label}
                  href={item.href}
                  className="px-3 lg:px-5 py-2.5 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
                >
                  {item.label}
                </Link>
              )
            )}
            <Link
              href="/dashboard"
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium text-sm shadow-lg shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-all"
            >
              Start free trial
            </Link>
          </motion.div>

          <div className="md:hidden flex items-center gap-2">
            <Link
              href="/dashboard"
              className="px-3 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-medium text-xs shadow-lg shadow-cyan-500/20"
            >
              Start
            </Link>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((open) => !open)}
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileMenuOpen}
              className="w-10 h-10 rounded-lg border border-white/10 bg-white/[0.03] text-zinc-200 flex items-center justify-center"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.nav
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="md:hidden border-t border-white/5 bg-zinc-950/95 backdrop-blur-xl"
            >
              <div className="px-4 py-3 grid grid-cols-2 gap-2">
                {NAV_LINKS.map((item) => (
                  <a
                    key={item.label}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className="px-3 py-3 rounded-lg border border-white/10 bg-white/[0.03] text-sm font-medium text-zinc-200 hover:bg-white/[0.06] transition-colors"
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            </motion.nav>
          )}
        </AnimatePresence>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative z-10 pt-40 sm:pt-48 pb-20 px-6">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-12 lg:gap-10 items-center">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={mounted ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.7 }}
          >
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.03] mb-6">
              <Terminal className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-xs font-mono text-zinc-400">the agent harness</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white leading-[1.05] tracking-tight mb-6">
              Run agents like a team,{" "}
              <br className="hidden sm:block" />
              <span className="text-gradient">not like tabs.</span>
            </h1>

            <p className="text-lg sm:text-xl text-zinc-400 leading-relaxed mb-8 max-w-xl">
              Groovy turns Claude&nbsp;Code and Codex into a workforce. One
              orchestrator you talk to — from team chat, WhatsApp, or an API
              your customers use — and named agents that do the work in your
              repos, on your machines, with your keys.
            </p>

            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-6">
              <Link
                href="/dashboard"
                className="group flex items-center gap-2 px-6 py-3.5 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold shadow-xl shadow-cyan-500/25 hover:shadow-cyan-500/40 transition-all"
              >
                Start free trial
                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </Link>
              <a
                href="#how"
                className="flex items-center gap-2 px-6 py-3.5 rounded-xl border border-white/15 bg-white/[0.03] text-white font-medium hover:bg-white/[0.06] transition-all"
              >
                See it work
              </a>
            </div>

            <p className="text-xs text-zinc-600 font-mono">
              5-day free trial · your API keys · macOS &amp; Windows
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 32 }}
            animate={mounted ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.7, delay: 0.15 }}
          >
            <HeroDemo />
          </motion.div>
        </div>
      </section>

      {/* ── The shift ────────────────────────────────────────────────────── */}
      <section className="relative z-10 py-16 px-6 border-t border-white/5">
        <div className="max-w-4xl mx-auto text-center">
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-xl sm:text-2xl text-zinc-400 leading-relaxed"
          >
            Coding agents got good. Managing them didn&apos;t.
            <br className="hidden sm:block" />
            You&apos;re alt-tabbing between terminals, re-pasting context,
            babysitting runs.{" "}
            <span className="text-white font-medium">
              That&apos;s not orchestration — that&apos;s a second job.
            </span>
          </motion.p>
        </div>
      </section>

      {/* ── Multiplayer AI: the new architecture ─────────────────────────── */}
      <MultiplayerSection />

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section id="how" className="relative z-10 py-24 px-6 border-t border-white/5 scroll-mt-24">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-14"
          >
            <div className="text-xs font-mono text-cyan-400 mb-3">{"// how it works"}</div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white">
              Hire. Dispatch. Ship.
            </h2>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-4">
            {HOW_IT_WORKS.map((step, index) => (
              <motion.div
                key={step.index}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:border-white/20 transition-colors"
              >
                <div className="flex items-baseline gap-3 mb-4">
                  <span className="text-xs font-mono text-zinc-600">{step.index}</span>
                  <h3 className="text-xl font-semibold text-white">{step.title}</h3>
                </div>
                <div className="rounded-lg bg-black/40 border border-white/5 px-3 py-2 mb-4 font-mono text-[11px] text-zinc-400 overflow-x-auto whitespace-nowrap">
                  {step.command}
                </div>
                <p className="text-sm text-zinc-500 leading-relaxed">{step.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Model mixing ─────────────────────────────────────────────────── */}
      <section className="relative z-10 py-24 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <div className="text-xs font-mono text-violet-400 mb-3">{"// model economics"}</div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-5 leading-tight">
              Fable&nbsp;5 plans.
              <br />
              Haiku executes.
              <br />
              <span className="text-gradient">You keep the difference.</span>
            </h2>
            <p className="text-lg text-zinc-400 leading-relaxed mb-6">
              Every role gets its own model — the orchestrator brain, each
              agent, even your daily heartbeat digest. Pick from the frontier
              catalog or paste any model id. When the bill comes, ask the
              orchestrator to read it and it will tell you which agents can
              drop to a cheaper model without dropping quality.
            </p>
            <p className="text-sm text-zinc-600 font-mono">
              claude-fable-5 · opus-4.7 · sonnet-4.6 · haiku-4.5
              <br />
              gpt-5.6-sol · gpt-5.6-terra · gpt-5.6-luna · gpt-5.5 · any-model-id
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
            className="space-y-2"
          >
            {MODEL_MIX.map((row, index) => (
              <motion.div
                key={row.role}
                initial={{ opacity: 0, x: 16 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.15 + index * 0.07 }}
                className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3"
              >
                <span className="text-sm text-zinc-300 min-w-0 flex-1 truncate">{row.role}</span>
                <span
                  className={`shrink-0 px-2.5 py-1 rounded-lg border font-mono text-xs ${MODEL_TONES[row.tone]}`}
                >
                  {row.model}
                </span>
                <span className="hidden sm:block shrink-0 text-[11px] text-zinc-600 w-28 text-right">
                  {row.note}
                </span>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <section className="relative z-10 py-24 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-14"
          >
            <div className="text-xs font-mono text-cyan-400 mb-3">{"// the harness"}</div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white max-w-2xl">
              Everything between &ldquo;I have agents&rdquo; and&nbsp;
              <span className="text-gradient">&ldquo;they run my backlog&rdquo;</span>
            </h2>
          </motion.div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((feature, index) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: (index % 3) * 0.08 }}
                className="group rounded-2xl border border-white/10 bg-white/[0.02] p-6 hover:border-cyan-400/25 hover:bg-cyan-400/[0.02] transition-all"
              >
                <feature.icon className="w-5 h-5 text-cyan-400 mb-4" />
                <h3 className="text-base font-semibold text-white mb-2">{feature.title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed mb-4">
                  {feature.description}
                </p>
                {feature.mono && (
                  <div className="font-mono text-[10px] text-zinc-600 group-hover:text-cyan-400/70 transition-colors truncate">
                    {feature.mono}
                  </div>
                )}
              </motion.div>
            ))}
          </div>

          <motion.p
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="mt-8 text-sm text-zinc-600 text-center"
          >
            Plus data integrations (Gmail, Calendar, ads platforms, Postgres, Firecrawl…)
            your agents can pull from —{" "}
            <Link
              href="/integrations"
              className="inline-block px-1 py-2 text-cyan-400/80 underline decoration-cyan-400/30 underline-offset-4 hover:text-cyan-300"
            >
              see the catalog
            </Link>
            .
          </motion.p>
        </div>
      </section>

      {/* ── Trust / local-first ──────────────────────────────────────────── */}
      <section className="relative z-10 py-24 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-14 text-center"
          >
            <div className="text-xs font-mono text-emerald-400 mb-3">{"// trust model"}</div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white">
              Powerful agents need a short leash.
            </h2>
            <p className="text-lg text-zinc-500 mt-4 max-w-2xl mx-auto">
              Groovy holds it: local execution, your credentials, human
              approval on anything that can hurt.
            </p>
          </motion.div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {TRUST_POINTS.map((point, index) => (
              <motion.div
                key={point.title}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.08 }}
                className="rounded-2xl border border-white/10 bg-white/[0.02] p-6"
              >
                <point.icon className="w-5 h-5 text-emerald-400 mb-4" />
                <h3 className="text-sm font-semibold text-white mb-2">{point.title}</h3>
                <p className="text-[13px] text-zinc-500 leading-relaxed">{point.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Desktop app ──────────────────────────────────────────────────── */}
      <section className="relative z-10 py-24 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <div className="text-xs font-mono text-cyan-400 mb-3">{"// groovy desktop"}</div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-5 leading-tight">
              One download.
              <br />
              <span className="text-gradient">Zero pairing codes.</span>
            </h2>
            <p className="text-lg text-zinc-400 leading-relaxed mb-6">
              Groovy Desktop bundles the harness and the local connector in a
              single signed app. Install, sign in, and your machine links
              itself. Agents keep running when the window closes; updates are
              one click, ChatGPT-style.
            </p>
            <ul className="space-y-2.5">
              {[
                "Connector managed for you — starts, restarts, updates",
                "Keeps schedules and heartbeats alive in the background",
                "Signed & notarized DMG for Apple Silicon",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-sm text-zinc-400">
                  <Check className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                  {line}
                </li>
              ))}
            </ul>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
            className="relative"
          >
            <div className="absolute -inset-6 bg-gradient-to-tr from-violet-500/10 to-cyan-500/10 rounded-3xl blur-2xl pointer-events-none" />
            <div className="relative rounded-2xl border border-white/10 bg-zinc-950/80 p-8 text-center">
              <div className="w-16 h-16 mx-auto rounded-2xl border border-white/10 bg-gradient-to-br from-cyan-500/15 to-violet-500/15 flex items-center justify-center mb-5">
                <Laptop className="w-8 h-8 text-cyan-300" />
              </div>
              <div className="font-mono text-sm text-zinc-300 mb-1">Groovy.dmg</div>
              <div className="text-xs text-zinc-600 mb-6">macOS 12+ · Apple Silicon</div>
              <Link
                href="/account/downloads"
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white/[0.05] border border-white/15 text-white text-sm font-medium hover:bg-white/[0.08] transition-all"
              >
                Download Groovy Desktop
                <ArrowRight className="w-4 h-4" />
              </Link>
              <p className="mt-4 text-[11px] text-zinc-600">
                Prefer headless? The standalone connector still works everywhere.
              </p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <section id="pricing" className="relative z-10 py-24 px-6 border-t border-white/5 scroll-mt-24">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-14 text-center"
          >
            <div className="text-xs font-mono text-cyan-400 mb-3">{"// pricing"}</div>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
              A license, not a meter.
            </h2>
            <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
              Every account starts with a 5-day free trial. After that it&apos;s
              a flat yearly license — your model spend goes straight to your
              providers, with no Groovy markup in the middle.
            </p>
          </motion.div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {pricingCards.map((card, index) => {
              const tone = pricingToneClasses[card.tone] || pricingToneClasses.cyan;
              return (
                <motion.div
                  key={card.eyebrow}
                  initial={{ opacity: 0, y: 24 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: index * 0.08 }}
                  className={`rounded-2xl border bg-white/[0.02] p-6 flex flex-col ${tone.accent}`}
                >
                  <div
                    className={`w-9 h-9 rounded-xl border flex items-center justify-center mb-4 ${tone.icon}`}
                  >
                    <card.icon className="w-4 h-4" />
                  </div>
                  <div
                    className={`self-start text-[10px] font-mono px-2 py-0.5 rounded-full border mb-3 ${tone.badge}`}
                  >
                    {card.eyebrow}
                  </div>
                  <h3 className="text-base font-semibold text-white mb-1">{card.title}</h3>
                  <div className="mb-4">
                    <span className="text-2xl font-bold text-white">{card.price}</span>
                    <span className="text-xs text-zinc-500 ml-1.5">{card.unit}</span>
                  </div>
                  <ul className="space-y-2 mt-auto">
                    {card.details.map((detail) => (
                      <li key={detail} className="flex items-start gap-2 text-[12px] text-zinc-500">
                        <Check className="w-3.5 h-3.5 text-zinc-600 mt-px shrink-0" />
                        {detail}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────────── */}
      <section className="relative z-10 py-32 px-6 border-t border-white/5">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-4xl mx-auto text-center"
        >
          <h2 className="text-4xl sm:text-5xl font-bold text-white mb-6">
            Your agents are ready.
            <br />
            <span className="text-gradient">Give them a manager.</span>
          </h2>
          <p className="text-xl text-zinc-500 mb-10 max-w-2xl mx-auto">
            Five days free. Your keys, your machine, your call.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/dashboard"
              className="group flex items-center gap-3 px-10 py-5 rounded-2xl bg-gradient-to-r from-cyan-500 to-cyan-600 text-black font-semibold text-xl shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/50 transition-all"
            >
              <Bot className="w-6 h-6" />
              Start free trial
            </Link>
            <Link
              href="/enterprise"
              className="group flex items-center gap-3 px-10 py-5 rounded-2xl border border-white/20 bg-white/[0.03] text-white font-semibold text-xl hover:bg-white/[0.06] hover:border-white/30 transition-all"
            >
              <Server className="w-6 h-6" />
              Contact Sales
            </Link>
          </div>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-6 text-xs text-zinc-600">
            <span className="flex items-center gap-1.5">
              <CreditCard className="w-3.5 h-3.5" /> Personal license $49.99/yr
            </span>
            <span className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5" /> No token markup
            </span>
            <span>macOS 12+ (Apple Silicon) · Windows 10+ (x64)</span>
          </div>
        </motion.div>
      </section>

      {/* Contact Us */}
      <section className="relative z-10 pb-16 px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-md mx-auto text-center"
        >
          <button
            type="button"
            onClick={(e) => {
              const el = e.currentTarget.querySelector("[data-email]");
              if (el) el.classList.toggle("hidden");
            }}
            className="w-full p-6 rounded-2xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] transition-all cursor-pointer group"
          >
            <Mail className="w-6 h-6 text-cyan-400 mx-auto mb-3" />
            <h3 className="text-lg font-semibold text-white mb-1">Contact Us</h3>
            <p className="text-sm text-zinc-500 mb-3">
              Questions or feedback? We&apos;d love to hear from you.
            </p>
            <span data-email className="hidden text-cyan-400 text-sm font-medium select-all">
              theshop@gmail.com
            </span>
          </button>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 py-12 px-6 border-t border-white/5">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <Image
            src="/Groovy_no_bg.png"
            alt="Groovy"
            width={240}
            height={70}
            className="h-16 w-auto opacity-60"
            unoptimized
          />
          <p className="text-sm text-zinc-600">
            © {new Date().getFullYear()} Groovy. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
