"use client";

import { useEffect, useState } from "react";
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
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Database,
  FileText,
  KeyRound,
  LayoutGrid,
  Laptop,
  Loader2,
  Lock,
  Mail,
  Menu,
  MessageCircle,
  Search,
  Send,
  Server,
  Shield,
  Sparkles,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const NAV_LINKS = [
  { label: "Product", href: "#product" },
  { label: "Pricing", href: "#pricing" },
  { label: "Source", href: "https://github.com/Charlesmendez/groovy-public" },
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

const CHAT_FEATURES: Array<{
  icon: LucideIcon;
  title: string;
  description: string;
}> = [
  {
    icon: MessageCircle,
    title: "A shared room, not a bot inbox",
    description:
      "Keep decisions, files, threads, and AI work together where the whole team can see the context.",
  },
  {
    icon: Brain,
    title: "Bring the right intelligence in",
    description:
      "Mention a Mind for company knowledge or an agent for real work. Groovy routes the request without making you switch tools.",
  },
  {
    icon: CalendarClock,
    title: "Conversations that keep working",
    description:
      "Turn a message into a scheduled task, get live progress, and receive the result back in the same channel.",
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

const PRODUCT_SLIDES = [
  { label: "Command Center", icon: LayoutGrid },
  { label: "Chat", icon: MessageCircle },
  { label: "Email", icon: Mail },
] as const;

function ProductShell({ active, children }: { active: number; children: React.ReactNode }) {
  return (
    <div className="h-full overflow-hidden rounded-2xl border border-white/15 bg-[#09090d] shadow-2xl shadow-black/50">
      <div className="flex h-12 items-center gap-3 border-b border-white/10 px-3 sm:h-14 sm:px-5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-white sm:mr-2">
          <Image src="/sloth_no_bg.png" alt="" width={26} height={26} className="h-5 w-5 sm:h-6 sm:w-6" />
          <span className="hidden sm:inline">Groovy</span>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/30 p-1">
          {PRODUCT_SLIDES.map((slide, index) => {
            const Icon = slide.icon;
            return (
              <span
                key={slide.label}
                className={`flex h-7 w-7 items-center justify-center rounded-lg sm:h-8 sm:w-8 ${
                  active === index
                    ? "border border-cyan-400/25 bg-cyan-400/10 text-cyan-300"
                    : "text-zinc-600"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2 text-[9px] text-zinc-500 sm:text-[10px]">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Connected
        </div>
      </div>
      {children}
    </div>
  );
}

function CommandCenterPreview() {
  return (
    <div className="h-[300px] p-3 sm:h-[420px] sm:p-5">
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-2 sm:mb-4 sm:p-3">
        <div className="flex items-center gap-2 text-[10px] font-medium text-zinc-300 sm:text-xs">
          <LayoutGrid className="h-3.5 w-3.5 text-cyan-300" /> Workspace layout
        </div>
        <div className="hidden rounded-lg border border-white/10 bg-black/25 px-3 py-1.5 text-[10px] text-zinc-400 sm:block">
          Agents <span className="ml-1 text-white">3 / 8</span>
        </div>
        <div className="ml-auto rounded-lg bg-cyan-500 px-3 py-1.5 text-[10px] font-semibold text-black sm:text-xs">
          + New agent
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {[
          {
            initial: "C",
            name: "Code",
            model: "Codex · GPT-5.6 Sol",
            text: "Implemented the draft sync fix. All checks are passing.",
            prompt: "Ask Code…",
          },
          {
            initial: "R",
            name: "Reviewer",
            model: "Claude Code · Opus",
            text: "Reviewed the diff. No blocking issues found.",
            prompt: "Ask Reviewer…",
          },
        ].map((agent, index) => (
          <div
            key={agent.name}
            className={`${index === 1 ? "hidden sm:block" : "block"} rounded-xl border border-white/10 bg-white/[0.025] p-3 sm:p-4`}
          >
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.06] text-[10px] font-semibold text-white">
                {agent.initial}
              </span>
              <div>
                <div className="text-xs font-semibold text-white sm:text-sm">{agent.name}</div>
                <div className="text-[9px] text-cyan-300 sm:text-[10px]">{agent.model}</div>
              </div>
              <div className="ml-auto flex items-center gap-1.5 text-[9px] text-emerald-400 sm:text-[10px]">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Ready
              </div>
            </div>
            <div className="mt-3 rounded-lg bg-black/35 p-3 text-[10px] leading-relaxed text-zinc-400 sm:mt-5 sm:text-xs">
              {agent.text}
            </div>
            <div className="mt-3 flex items-center rounded-lg border border-white/10 px-3 py-2 text-[10px] text-zinc-600 sm:mt-4 sm:text-xs">
              {agent.prompt}
              <Send className="ml-auto h-3.5 w-3.5 text-cyan-400" />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-black/25 p-2.5 text-[10px] text-zinc-500 sm:mt-4 sm:p-3 sm:text-xs">
        <span className="rounded-lg bg-white/[0.05] px-2 py-1 text-zinc-300">Groovy</span>
        <span className="rounded-lg border border-cyan-400/20 px-2 py-1 text-cyan-300">Auto</span>
        <span className="truncate">Ask anything, or @mention an agent…</span>
      </div>
    </div>
  );
}

function ChatPreview() {
  return (
    <div className="flex h-[300px] flex-col sm:h-[420px]">
      <div className="flex items-center border-b border-white/10 px-4 py-3 sm:px-6">
        <div>
          <div className="text-xs font-semibold text-white sm:text-sm"># launch-room</div>
          <div className="text-[9px] text-zinc-600 sm:text-[10px]">People and agents, one conversation</div>
        </div>
        <div className="ml-auto rounded-lg border border-white/10 px-2.5 py-1.5 text-[9px] text-zinc-400 sm:text-[10px]">
          Huddle
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-hidden px-4 py-3 sm:space-y-5 sm:px-6 sm:py-5">
        <div className="flex gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-500/20 text-[9px] font-semibold text-violet-200">CM</span>
          <div>
            <div className="text-[10px] font-semibold text-white sm:text-xs">Carlos <span className="ml-1 font-normal text-zinc-600">9:41 AM</span></div>
            <p className="mt-1 text-[10px] leading-relaxed text-zinc-300 sm:text-xs">@Groovy summarize today&apos;s customer blockers and give Code the fix we can ship now.</p>
          </div>
        </div>
        <div className="flex gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">✦</span>
          <div>
            <div className="text-[10px] font-semibold text-cyan-300 sm:text-xs">Groovy <span className="ml-1 font-normal text-zinc-600">9:42 AM</span></div>
            <p className="mt-1 text-[10px] leading-relaxed text-zinc-300 sm:text-xs">Three blockers found. The draft sync issue is reproducible, so I sent it to Code.</p>
            <div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-2.5 py-1.5 text-[9px] text-zinc-400 sm:text-[10px]">
              <Loader2 className="h-3 w-3 animate-spin text-cyan-300" /> Code is working
            </div>
          </div>
        </div>
      </div>

      <div className="m-3 rounded-xl border border-white/10 bg-black/25 p-3 sm:m-4">
        <div className="text-[10px] text-zinc-600 sm:text-xs">Message #launch-room or mention an AI teammate…</div>
        <div className="mt-3 flex items-center text-zinc-600">
          <span className="text-xs">B &nbsp; / &nbsp; @</span>
          <Send className="ml-auto h-4 w-4 text-cyan-400" />
        </div>
      </div>
    </div>
  );
}

function EmailPreview() {
  const messages = [
    { initials: "JP", sender: "Jack", subject: "Re: Proposal follow-up", tag: "Draft ready", tone: "violet" },
    { initials: "AC", sender: "Acme Cloud", subject: "Your weekly usage report", tag: "Worth reading", tone: "orange" },
    { initials: "ML", sender: "Maya", subject: "Launch checklist", tag: "Needs reply", tone: "cyan" },
  ];

  return (
    <div className="h-[300px] sm:h-[420px]">
      <div className="border-b border-white/10 p-3 sm:p-4">
        <div className="flex items-center rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-[10px] text-zinc-600 sm:text-xs">
          <Search className="mr-2 h-3.5 w-3.5" /> Search every mailbox
          <span className="ml-auto text-zinc-700">/</span>
        </div>
        <div className="mt-2 flex items-center gap-2 text-[9px] text-zinc-500 sm:text-[10px]">
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" /> Checking for new mail across 3 mailboxes
          <span className="ml-auto">Done → Noise</span>
        </div>
      </div>

      <div className="border-b border-white/10 px-4 py-2 text-[9px] font-medium uppercase tracking-[0.16em] text-zinc-500 sm:px-5 sm:text-[10px]">
        Ready to send <span className="ml-2 normal-case tracking-normal text-zinc-700">AI drafts waiting for your eyes</span>
      </div>

      <div className="divide-y divide-white/[0.07]">
        {messages.map((message, index) => (
          <div key={message.subject} className={`${index === 2 ? "hidden sm:flex" : "flex"} items-start gap-3 px-4 py-3 sm:px-5 sm:py-4`}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[9px] font-semibold text-zinc-300 sm:h-9 sm:w-9 sm:text-[10px]">
              {message.initials}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-zinc-200 sm:text-xs">{message.sender}</span>
                <span className="ml-auto text-[8px] text-zinc-700 sm:text-[9px]">9:24 AM</span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-white sm:text-xs">{message.subject}</div>
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2 py-1 text-[8px] text-zinc-400 sm:text-[9px]">
                <span className={`h-1.5 w-1.5 rounded-full ${
                  message.tone === "violet" ? "bg-violet-400" : message.tone === "orange" ? "bg-orange-400" : "bg-cyan-400"
                }`} />
                {message.tag}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductCarousel() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const interval = window.setInterval(() => {
      setActive((current) => (current + 1) % PRODUCT_SLIDES.length);
    }, 6000);
    return () => window.clearInterval(interval);
  }, []);

  const setPrevious = () => setActive((current) => (current - 1 + PRODUCT_SLIDES.length) % PRODUCT_SLIDES.length);
  const setNext = () => setActive((current) => (current + 1) % PRODUCT_SLIDES.length);

  return (
    <div aria-label="Groovy product tour" className="relative">
      <div className="mb-4 flex items-center justify-center gap-2" role="tablist" aria-label="Product areas">
        {PRODUCT_SLIDES.map((slide, index) => {
          const Icon = slide.icon;
          return (
            <button
              key={slide.label}
              type="button"
              role="tab"
              aria-selected={active === index}
              onClick={() => setActive(index)}
              className={`flex items-center gap-2 rounded-full border px-3 py-2 text-[11px] font-medium transition-colors sm:px-4 sm:text-xs ${
                active === index
                  ? "border-cyan-400/30 bg-cyan-400/10 text-white"
                  : "border-white/10 bg-white/[0.025] text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {slide.label}
            </button>
          );
        })}
      </div>

      <div className="pointer-events-none absolute inset-x-8 top-16 bottom-0 rounded-[3rem] bg-gradient-to-r from-cyan-500/15 via-violet-500/10 to-emerald-500/10 blur-3xl" />
      <div className="relative">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={active}
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -18 }}
            transition={{ duration: 0.25 }}
          >
            <ProductShell active={active}>
              {active === 0 ? <CommandCenterPreview /> : active === 1 ? <ChatPreview /> : <EmailPreview />}
            </ProductShell>
          </motion.div>
        </AnimatePresence>

        <button
          type="button"
          onClick={setPrevious}
          aria-label="Show previous product screen"
          className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/70 text-zinc-300 backdrop-blur transition-colors hover:bg-zinc-900 sm:-left-4 sm:h-9 sm:w-9"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={setNext}
          aria-label="Show next product screen"
          className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/70 text-zinc-300 backdrop-blur transition-colors hover:bg-zinc-900 sm:-right-4 sm:h-9 sm:w-9"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ChatShowcase() {
  return (
    <section
      id="chat"
      className="relative z-10 scroll-mt-24 border-t border-white/5 px-6 py-24"
    >
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[0.88fr_1.12fr]">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <div className="mb-3 text-xs font-mono text-cyan-400">
            {"// groovy chat"}
          </div>
          <h2 className="max-w-xl text-3xl font-bold leading-tight text-white sm:text-4xl">
            Where people and AI work in the same room.
          </h2>
          <p className="mt-5 max-w-xl text-base leading-7 text-zinc-400">
            Groovy Chat is the shared surface for your team, your company
            knowledge, and your live agents. Ask once, keep the context in the
            channel, and let the result come back to everyone.
          </p>

          <div className="mt-8 space-y-5">
            {CHAT_FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <div key={feature.title} className="flex gap-3">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-400/15 bg-cyan-400/[0.05]">
                    <Icon className="h-3.5 w-3.5 text-cyan-300" />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      {feature.title}
                    </h3>
                    <p className="mt-1 text-sm leading-6 text-zinc-500">
                      {feature.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <Link
            href="/chat"
            className="group mt-8 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-white transition hover:border-cyan-400/25 hover:bg-cyan-400/[0.06]"
          >
            Open Groovy Chat
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.1 }}
          className="overflow-hidden rounded-3xl border border-white/10 bg-[#0a0b0e] shadow-2xl shadow-cyan-950/20"
        >
          <div className="flex h-11 items-center border-b border-white/[0.07] px-4">
            <div className="flex gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-400/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-400/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/60" />
            </div>
            <div className="mx-auto flex items-center gap-1.5 text-[11px] text-zinc-500">
              <MessageCircle className="h-3 w-3 text-cyan-400" />
              Groovy Chat
            </div>
            <span className="text-[9px] font-mono text-emerald-400">
              3 online
            </span>
          </div>

          <div className="grid min-h-[430px] sm:grid-cols-[150px_1fr]">
            <aside className="hidden border-r border-white/[0.06] bg-white/[0.015] p-3 sm:block">
              <div className="mb-3 text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-600">
                Channels
              </div>
              {([
                ["# launch-room", true],
                ["# customer-ops", false],
                ["# engineering", false],
              ] as const).map(([name, active]) => (
                <div
                  key={name}
                  className={`mb-1 rounded-lg px-2.5 py-2 text-[11px] ${
                    active
                      ? "bg-cyan-400/[0.08] text-cyan-100"
                      : "text-zinc-500"
                  }`}
                >
                  {name}
                </div>
              ))}
              <div className="mb-2 mt-6 text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-600">
                AI teammates
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 text-[10px] text-zinc-400">
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-violet-400/10 text-violet-300">
                  <Brain className="h-3 w-3" />
                </span>
                Scout Mind
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 text-[10px] text-zinc-400">
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-cyan-400/10 text-cyan-300">
                  <Bot className="h-3 w-3" />
                </span>
                Fixter Agent
              </div>
            </aside>

            <div className="flex min-w-0 flex-col">
              <div className="flex h-12 items-center border-b border-white/[0.06] px-4">
                <div>
                  <div className="text-xs font-semibold text-white">
                    # launch-room
                  </div>
                  <div className="text-[9px] text-zinc-600">
                    The work and the decisions, together
                  </div>
                </div>
              </div>

              <div className="flex-1 space-y-5 p-4 sm:p-5">
                <div className="flex gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-400/10 text-[10px] font-semibold text-orange-200">
                    CM
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium text-zinc-200">
                        Carlos
                      </span>
                      <span className="text-[9px] text-zinc-700">9:41 AM</span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-zinc-400">
                      <span className="text-cyan-300">@Scout</span> summarize
                      today&apos;s customer blockers and ask Fixter to handle
                      anything we can ship now.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-400/10 text-violet-300">
                    <Brain className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium text-violet-200">
                        Scout
                      </span>
                      <span className="rounded-full bg-violet-400/[0.08] px-1.5 py-0.5 text-[8px] text-violet-300">
                        Mind
                      </span>
                    </div>
                    <div className="mt-2 rounded-xl border border-violet-400/10 bg-violet-400/[0.035] p-3 text-[11px] leading-5 text-zinc-400">
                      I found three blockers across support and email. Two need
                      decisions; the attachment issue is reproducible and ready
                      for Fixter.
                    </div>
                    <div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-cyan-400/10 bg-cyan-400/[0.04] px-2.5 py-1.5 text-[9px] text-cyan-200">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Fixter is working · attachment preview
                    </div>
                  </div>
                </div>

                <div className="ml-11 flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
                  <CalendarClock className="h-3.5 w-3.5 text-emerald-300" />
                  <div>
                    <div className="text-[10px] text-zinc-300">
                      Customer pulse scheduled
                    </div>
                    <div className="text-[9px] text-zinc-600">
                      Every weekday at 5:00 PM · posts here
                    </div>
                  </div>
                </div>
              </div>

              <div className="m-3 flex items-center gap-2 rounded-xl border border-white/[0.09] bg-white/[0.025] px-3 py-2.5 text-[10px] text-zinc-600">
                Message #launch-room or mention an AI teammate…
                <MessageCircle className="ml-auto h-3.5 w-3.5 text-zinc-700" />
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
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
              className="-my-2 h-16 w-auto sm:h-20"
              unoptimized
              priority
            />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={mounted ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.6 }}
            className="hidden xl:flex items-center gap-2 lg:gap-4"
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

          <div className="xl:hidden flex items-center gap-2">
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
              className="xl:hidden border-t border-white/5 bg-zinc-950/95 backdrop-blur-xl"
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
      <section id="product" className="relative z-10 scroll-mt-24 px-4 pb-20 pt-28 sm:px-6 sm:pt-32">
        <div className="mx-auto max-w-6xl">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={mounted ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.7 }}
            className="text-center"
          >
            <h1 className="text-5xl font-bold leading-[0.98] tracking-[-0.045em] text-white sm:text-6xl lg:text-7xl">
              All in one AI harness:
            </h1>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-2xl font-medium text-zinc-300 sm:text-3xl">
              <span className="inline-flex items-center gap-2">
                <Terminal className="h-5 w-5 text-cyan-400" /> Coding
              </span>
              <span aria-hidden="true" className="text-zinc-700">·</span>
              <span className="inline-flex items-center gap-2">
                <MessageCircle className="h-5 w-5 text-violet-400" /> Chat
              </span>
              <span aria-hidden="true" className="text-zinc-700">·</span>
              <span className="inline-flex items-center gap-2">
                <Mail className="h-5 w-5 text-emerald-400" /> Email
              </span>
            </div>

            <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-4 py-2 text-sm font-medium text-zinc-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Fully source-available
            </div>

            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/dashboard"
                className="group flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-cyan-600 px-6 py-3.5 font-semibold text-black shadow-xl shadow-cyan-500/25 transition-all hover:shadow-cyan-500/40"
              >
                Start free trial
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <a
                href="https://github.com/Charlesmendez/groovy-public"
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-white/15 bg-white/[0.03] px-6 py-3.5 font-medium text-white transition-all hover:bg-white/[0.06]"
              >
                View source
              </a>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 32 }}
            animate={mounted ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.8, delay: 0.12 }}
            className="relative mx-auto mt-12 max-w-5xl"
          >
            <ProductCarousel />
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

      <ChatShowcase />

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
