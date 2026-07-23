"use client";

/**
 * Landing-page section for the new Groovy architecture: one harness, many
 * channels (Coding, Team Chat, API, Messaging), personalizable Minds, and
 * "multiplayer AI". The chat visual is a pixel-crafted still of the team-chat
 * surface — same show-don't-tell approach as the hero simulation.
 */

import { motion } from "framer-motion";
import {
  Braces,
  Check,
  MessageSquare,
  MessagesSquare,
  Sparkles,
  Terminal,
} from "lucide-react";

const CHANNELS = [
  {
    icon: Terminal,
    name: "Coding",
    desc: "Claude Code & Codex workers in your repos, on your machines.",
  },
  {
    icon: MessagesSquare,
    name: "Team chat",
    desc: "Slack-like rooms where humans, minds, and agents are teammates.",
  },
  {
    icon: Braces,
    name: "API + widget",
    desc: "An endpoint and embeddable chat your own customers talk to.",
  },
  {
    icon: MessageSquare,
    name: "Messaging",
    desc: "WhatsApp and Telegram, same brain, same memory.",
  },
];

function ChatShowcase() {
  // Decorative still of the team-chat surface; the caption below carries the
  // meaning for assistive tech.
  return (
    <div
      aria-hidden="true"
      className="rounded-2xl border border-white/10 bg-[#0a0a0f] shadow-2xl shadow-cyan-500/5 overflow-hidden"
    >
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-white/5 bg-white/[0.02] px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
        <span className="ml-3 flex items-center gap-2 text-xs text-zinc-400">
          <span className="font-medium text-white">#support</span>
          <span className="hidden sm:inline">Customer escalations & triage</span>
        </span>
        <span className="ml-auto flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-400/5 px-2 py-0.5">
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
          <span className="text-[10px] text-cyan-300">Support Mind</span>
          <span className="rounded-full border border-white/10 px-1.5 text-[9px] uppercase tracking-wider text-zinc-500">
            listening
          </span>
        </span>
      </div>

      <div className="flex">
        {/* sidebar */}
        <div className="hidden w-40 shrink-0 border-r border-white/5 bg-white/[0.015] px-2 py-3 text-[11px] sm:block">
          <div className="px-2 pb-1 text-[9px] uppercase tracking-widest text-zinc-600">Rooms</div>
          <div className="flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-zinc-200">
            <span className="text-zinc-500">#</span> support
            <span className="ml-auto h-1.5 w-1.5 rounded-full bg-cyan-400" />
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 text-zinc-500">
            <span>#</span> engineering
            <span className="ml-auto h-1.5 w-1.5 rounded-full border border-emerald-400/60" />
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 text-zinc-500">
            <span>🔒</span> data
            <span className="ml-auto h-1.5 w-1.5 rounded-full bg-purple-400" />
          </div>
          <div className="px-2 pt-3 pb-1 text-[9px] uppercase tracking-widest text-zinc-600">Agents</div>
          <div className="px-2 py-1 text-zinc-400">
            ⚡ Kiko
            <div className="truncate font-mono text-[8px] text-cyan-400/70">replaying payloads…</div>
          </div>
          <div className="px-2 py-1 text-zinc-500">
            📊 Atlas
            <div className="truncate font-mono text-[8px] text-zinc-600">hq-server-1 · idle</div>
          </div>
        </div>

        {/* messages */}
        <div className="min-w-0 flex-1 space-y-3 px-4 py-4 text-[12px] leading-relaxed [&_p]:max-w-lg">
          <div className="flex gap-2.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-pink-500/20 text-[9px] font-semibold text-pink-300">
              AV
            </span>
            <div className="min-w-0">
              <span className="text-[11px] font-medium text-zinc-300">Ana</span>
              <p className="text-zinc-400">
                Meridian&apos;s checkout webhooks are failing — three tickets already.{" "}
                <span className="rounded bg-cyan-400/10 px-1 text-cyan-300">@Support</span> can you
                triage?
              </p>
            </div>
          </div>

          <div className="flex gap-2.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cyan-400/60 bg-cyan-400/10">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
            </span>
            <div className="min-w-0">
              <span className="text-[11px] font-medium text-cyan-300">
                Support Mind{" "}
                <span className="rounded-full border border-cyan-400/30 px-1 text-[8px] uppercase tracking-wider">
                  mind
                </span>
              </span>
              <p className="text-zinc-300">
                On it — Kiko is replaying the failed payloads against staging.
              </p>
            </div>
          </div>

          {/* work receipt card */}
          <div className="ml-9 max-w-md rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="flex h-4 w-4 items-center justify-center rounded-full border border-emerald-400/50 bg-emerald-400/10 text-[9px] text-emerald-400">
                <Check className="h-2.5 w-2.5" />
              </span>
              <span className="font-medium text-white">Trace Meridian webhook failures</span>
              <span className="text-[10px] text-zinc-500">Kiko · 3m 12s</span>
            </div>
            <p className="mt-1 text-[11px] text-zinc-400">
              Root cause: signature header renamed in yesterday&apos;s deploy. One-line fix drafted.
            </p>
            <span className="mt-1 inline-block text-[10px] text-zinc-500 underline decoration-dotted">
              view full log
            </span>
          </div>

          <div className="flex gap-2.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cyan-400/60 bg-cyan-400/10">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
            </span>
            <div className="min-w-0">
              <p className="text-zinc-300">
                It&apos;s ours. Fix drafted and three ticket replies are held for sign-off — want me
                to open the PR and send them?
              </p>
            </div>
          </div>

          <div className="flex gap-2.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-pink-500/20 text-[9px] font-semibold text-pink-300">
              AV
            </span>
            <p className="text-zinc-400">ship it 🚀</p>
          </div>

          {/* composer */}
          <div className="!mt-4 flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-zinc-600">
            Message #support — @ summons a mind or agent
            <span className="ml-auto rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-cyan-300">
              Send
            </span>
          </div>
        </div>

        {/* now rail */}
        <div className="hidden w-44 shrink-0 border-l border-white/5 bg-white/[0.015] px-3 py-3 text-[10px] lg:block">
          <div className="pb-1 text-[9px] uppercase tracking-widest text-zinc-600">In motion</div>
          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5">
            <div className="font-medium text-zinc-300">Open fix PR + reply</div>
            <div className="mt-0.5 flex items-center gap-1 font-mono text-[8px] text-cyan-400/80">
              <span className="h-1 w-1 animate-pulse rounded-full bg-cyan-400" />
              Kiko: watching CI
            </div>
          </div>
          <div className="pt-3 pb-1 text-[9px] uppercase tracking-widest text-zinc-600">Receipts</div>
          <div className="flex items-baseline gap-1.5 text-zinc-500">
            <span className="text-emerald-400">✓</span> Trace webhook failures
          </div>
          <div className="pt-3 pb-1 text-[9px] uppercase tracking-widest text-zinc-600">
            In this room
          </div>
          <div className="space-y-1 text-zinc-500">
            <div>Carlos · Ana · Leo</div>
            <div>⚡ Kiko · working</div>
            <div>🔎 Scout · idle</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MultiplayerSection() {
  return (
    <section id="multiplayer" className="relative z-10 py-24 px-6 border-t border-white/5 scroll-mt-24">
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mb-12 max-w-3xl"
        >
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-purple-400/30 bg-purple-400/5 px-3 py-1.5">
            <Sparkles className="h-3.5 w-3.5 text-purple-400" />
            <span className="font-mono text-xs text-zinc-400">new architecture · multiplayer AI</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-white leading-tight">
            One harness. Every channel your company works in.
          </h2>
          <p className="mt-5 text-lg text-zinc-400 leading-relaxed">
            Companies don&apos;t need another agent — they need a harness: model-agnostic, flexible,
            token-efficient, with a wiki-based memory you can actually read. Groovy deploys{" "}
            <span className="text-white font-medium">Cells</span> — an orchestrator, its agents, and
            their memory — for customer service, sales, operations, and engineering. And instead of
            an agent working somewhere off to the side, your team talks <em>with</em> it, and to
            every other agent, in the same rooms you work in.
          </p>
        </motion.div>

        <div className="mb-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CHANNELS.map((channel, i) => (
            <motion.div
              key={channel.name}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.06 }}
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"
            >
              <channel.icon className="mb-3 h-5 w-5 text-cyan-400" />
              <div className="mb-1 font-semibold text-white">{channel.name}</div>
              <p className="text-sm leading-relaxed text-zinc-400">{channel.desc}</p>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <ChatShowcase />
          <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-zinc-500">
            Team chat: humans, minds, and agents in one room — every delegation ends in a receipt,
            every side effect can require an approval.
          </p>
        </motion.div>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mx-auto mt-12 max-w-3xl text-center text-lg text-zinc-400 leading-relaxed"
        >
          Every channel is powered by a <span className="text-white font-medium">Mind</span> you
          shape: its prompt, its models, its memory scope, and exactly which agents it may touch.
          Duplicating a harness for a new job is a clone, not a fork —{" "}
          <span className="text-white font-medium">
            customer support and internal ops can think with different souls on the same engine.
          </span>
        </motion.p>
      </div>
    </section>
  );
}
