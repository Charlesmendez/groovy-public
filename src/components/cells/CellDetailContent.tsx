"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  CalendarDays,
  HeartPulse,
  Loader2,
  Mail,
  Pencil,
  RefreshCcw,
  ShieldCheck,
  Target,
  Users,
  Zap,
  X,
} from "lucide-react";
import type { CellDetail, CellMemberSummary } from "@/lib/cells/types";
import type { CellWorkspaceMemberOption } from "@/components/cells/CellCreateModal";
import { CellEditModal } from "@/components/cells/CellEditModal";

type CellDetailContentProps = { cellId: string };
type CellDetailApiResponse = { cell: CellDetail };
type WorkspaceApiResponse = {
  workspace: {
    id: string;
    name: string;
    role: "admin" | "member";
    members: Array<{ user_id: string; role: "admin" | "member"; email?: string | null }>;
  };
};

const RANGE_OPTIONS = [
  { key: "7d", label: "7D", days: 7 },
  { key: "30d", label: "30D", days: 30 },
  { key: "90d", label: "90D", days: 90 },
] as const;

const VIZ_HEIGHT = 500;

const CELL_CSS = `
@keyframes cell-float-0{0%,100%{transform:translate(0,0)}25%{transform:translate(5px,-9px)}50%{transform:translate(-3px,7px)}75%{transform:translate(7px,-4px)}}
@keyframes cell-float-1{0%,100%{transform:translate(0,0)}25%{transform:translate(-7px,-5px)}50%{transform:translate(4px,9px)}75%{transform:translate(-5px,3px)}}
@keyframes cell-float-2{0%,100%{transform:translate(0,0)}25%{transform:translate(9px,4px)}50%{transform:translate(-6px,-7px)}75%{transform:translate(3px,8px)}}
@keyframes cell-float-3{0%,100%{transform:translate(0,0)}25%{transform:translate(-4px,10px)}50%{transform:translate(7px,-5px)}75%{transform:translate(-8px,-3px)}}
@keyframes cell-pulse{0%{transform:scale(1);opacity:.25}100%{transform:scale(2.8);opacity:0}}
@keyframes cell-glow{0%,100%{box-shadow:0 0 30px rgba(34,211,238,.1),0 0 60px rgba(34,211,238,.03);transform:scale(1)}50%{box-shadow:0 0 45px rgba(34,211,238,.18),0 0 90px rgba(34,211,238,.05);transform:scale(1.03)}}
@keyframes cell-dash{0%{stroke-dashoffset:0}100%{stroke-dashoffset:-24}}
`;

// ── Portal-based tooltip — renders at body level so it never clips ──

function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, above: true });

  const show = useCallback(() => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const above = r.top > 80;
    setPos({
      top: above ? r.top - 6 : r.bottom + 6,
      left: Math.max(16, Math.min(r.left + r.width / 2, window.innerWidth - 16)),
      above,
    });
    setHover(true);
  }, []);

  return (
    <span ref={ref} onMouseEnter={show} onMouseLeave={() => setHover(false)} className="inline-flex">
      {children}
      {hover &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[9999] px-3 py-2 rounded-lg bg-zinc-900 border border-white/10 text-[11px] text-zinc-200 leading-relaxed shadow-2xl max-w-[280px]"
            style={{
              top: pos.top,
              left: pos.left,
              transform: pos.above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}

// ── helpers ──

function fmt(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

function fmtRange(from: string | null | undefined, to: string | null | undefined) {
  if (!from || !to) return "";
  const s = new Date(from),
    e = new Date(to);
  if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return "";
  const f = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return `${f.format(s)} – ${f.format(e)}`;
}

function compact(v: number | null | undefined) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "0";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: v >= 1000 ? 1 : 0 }).format(v);
}

function pct(v: number | null | undefined) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "n/a";
  return `${Math.round(v)}%`;
}

function orbitPos(count: number, radius: number) {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * 2 * Math.PI - Math.PI / 2;
    return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
  });
}

function engagementColor(label: string) {
  if (label === "high") return "text-emerald-300 border-emerald-500/20 bg-emerald-500/10";
  if (label === "moderate") return "text-cyan-300 border-cyan-500/20 bg-cyan-500/10";
  if (label === "low") return "text-amber-300 border-amber-500/20 bg-amber-500/10";
  return "text-rose-300 border-rose-500/20 bg-rose-500/10";
}

function hDot(label: string) {
  if (label === "strong") return "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.6)]";
  if (label === "watch") return "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,.6)]";
  if (label === "strained") return "bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,.6)]";
  return "bg-zinc-500";
}

function hBorder(label: string) {
  if (label === "strong") return "border-emerald-500/20";
  if (label === "watch") return "border-amber-500/20";
  if (label === "strained") return "border-rose-500/20";
  return "border-white/8";
}

function hLine(label: string) {
  if (label === "strong") return "rgba(52,211,153,.15)";
  if (label === "watch") return "rgba(251,191,36,.15)";
  if (label === "strained") return "rgba(251,113,133,.15)";
  return "rgba(255,255,255,.06)";
}

function hLineActive(label: string) {
  if (label === "strong") return "rgba(52,211,153,.35)";
  if (label === "watch") return "rgba(251,191,36,.35)";
  if (label === "strained") return "rgba(251,113,133,.35)";
  return "rgba(255,255,255,.15)";
}

function krBar(status: string) {
  if (status === "on_track") return "bg-emerald-400";
  if (status === "at_risk") return "bg-amber-400";
  if (status === "off_track") return "bg-rose-400";
  return "bg-zinc-600";
}

function statusPill(s: string) {
  if (s === "active") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-300";
  if (s === "paused") return "border-amber-500/25 bg-amber-500/10 text-amber-300";
  return "border-zinc-500/25 bg-zinc-500/10 text-zinc-300";
}

function effPill(l: string) {
  if (l === "efficient") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-200";
  if (l === "expensive_but_productive") return "border-cyan-500/25 bg-cyan-500/10 text-cyan-200";
  if (l === "looping") return "border-rose-500/25 bg-rose-500/10 text-rose-200";
  return "border-zinc-500/25 bg-zinc-500/10 text-zinc-300";
}

function tlTone(t: string) {
  if (t === "human_command") return "text-cyan-300 border-cyan-500/20 bg-cyan-500/10";
  if (t === "team_request") return "text-amber-300 border-amber-500/20 bg-amber-500/10";
  if (t === "inbox_action") return "text-emerald-300 border-emerald-500/20 bg-emerald-500/10";
  if (t === "assistant_output") return "text-fuchsia-300 border-fuchsia-500/20 bg-fuchsia-500/10";
  if (t === "heartbeat_run") return "text-sky-300 border-sky-500/20 bg-sky-500/10";
  if (t === "health_signal") return "text-rose-300 border-rose-500/20 bg-rose-500/10";
  return "text-zinc-300 border-white/10 bg-white/[0.03]";
}

// ── Orbit human card — NO custom tooltips, uses native title attrs ──

function OrbitCard({ member, selected, onClick }: { member: CellMemberSummary; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-[160px] rounded-2xl border ${hBorder(member.healthSignal.label)} ${
        selected ? "ring-1 ring-cyan-400/40 scale-[1.04]" : ""
      } bg-[#0c0c0f]/90 backdrop-blur-md p-3 shadow-2xl text-left transition-all hover:scale-[1.03] active:scale-[0.98]`}
      title="Click to see details"
    >
      <div className="flex items-center gap-2.5">
        <div className="relative w-8 h-8 rounded-full bg-white/[0.08] flex items-center justify-center text-[11px] font-medium text-white/80 uppercase shrink-0">
          {(member.email || member.userId)?.[0] || "?"}
          <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${hDot(member.healthSignal.label)}`} />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-white truncate">{member.email?.split("@")[0] || member.userId.slice(0, 8)}</div>
          <div className="text-[10px] text-zinc-500 mt-px flex items-center gap-1">
            {member.role}
            {member.isStale && <span className="text-amber-400">· stale</span>}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-px mt-2.5 rounded-xl bg-white/[0.015] overflow-hidden">
        <div className="bg-white/[0.025] py-1.5 text-center">
          <div className="text-[11px] font-semibold text-white">{member.engagement.score}</div>
          <div className="text-[8px] uppercase tracking-wider text-zinc-600">eng</div>
        </div>
        <div className="bg-white/[0.025] py-1.5 text-center">
          <div className="text-[11px] font-semibold text-white">{member.commandCount}</div>
          <div className="text-[8px] uppercase tracking-wider text-zinc-600">cmd</div>
        </div>
        <div className="bg-white/[0.025] py-1.5 text-center">
          <div className="text-[11px] font-semibold text-white">{member.healthSignal.latestScore !== null ? Math.round(member.healthSignal.latestScore) : "—"}</div>
          <div className="text-[8px] uppercase tracking-wider text-zinc-600">hp</div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-2 pl-0.5">
        <Mail className={`w-3 h-3 ${member.integrations.gmailConnected ? "text-zinc-400" : "text-zinc-700"}`} />
        <CalendarDays className={`w-3 h-3 ${member.integrations.calendarConnected ? "text-zinc-400" : "text-zinc-700"}`} />
        <ShieldCheck className={`w-3 h-3 ${member.integrations.heartbeatEnabled ? "text-zinc-400" : "text-zinc-700"}`} />
        <HeartPulse className={`w-3 h-3 ${member.integrations.upreadyConnected ? "text-zinc-400" : "text-zinc-700"}`} />
      </div>
    </button>
  );
}

// ── Member detail view ──

function MemberView({ member, onClose }: { member: CellMemberSummary; onClose: () => void }) {
  const eng = member.engagement;
  return (
    <div className="rounded-[22px] border border-white/6 bg-white/[0.025] p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative w-10 h-10 rounded-full bg-white/[0.08] flex items-center justify-center text-sm font-medium text-white/80 uppercase shrink-0">
            {(member.email || member.userId)?.[0] || "?"}
            <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#070709] ${hDot(member.healthSignal.label)}`} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-white">{member.email || member.userId.slice(0, 12)}</div>
            <div className="text-[11px] text-zinc-500 mt-0.5">{member.role}{member.isStale ? " · stale" : ""} · diversity {member.signalDiversity}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Tip text="Engagement: composite of agent interaction (35%), integration breadth (15%), signal quality (20%), recency (15%), and wellbeing (15%)">
            <span className={`px-2.5 py-1 rounded-full border text-[11px] font-medium cursor-default ${engagementColor(eng.label)}`}>{eng.score} {eng.label}</span>
          </Tip>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-white/5 bg-black/20 p-4">
        <div className="text-[9px] uppercase tracking-wider text-zinc-600">Engagement Breakdown</div>
        <div className="grid grid-cols-5 gap-2 mt-3">
          {([
            ["Agent", eng.breakdown.agentInteraction, "How often this person interacts with the AI"],
            ["Integr.", eng.breakdown.integrationBreadth, "How many data sources are connected"],
            ["Signal", eng.breakdown.signalQuality, "Quality and variety of signals sent to the agent"],
            ["Recency", eng.breakdown.recency, "Whether active recently or gone silent"],
            ["Health", eng.breakdown.wellbeing, "Upready readiness score"],
          ] as const).map(([label, val, tip]) => (
            <Tip key={label} text={tip}>
              <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2 text-center cursor-default w-full">
                <div className="text-sm font-semibold text-white">{val}</div>
                <div className="text-[8px] uppercase tracking-wider text-zinc-600 mt-0.5">{label}</div>
              </div>
            </Tip>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {([
          ["Commands", member.commandCount, "Direct messages sent to the AI agent"],
          ["Handoffs", member.requestCount, "Tasks delegated via team request flow"],
          ["Signal Str.", member.signalStrengthScore, "Weighted score of frequency, diversity, and high-quality signals"],
          ["Health", member.healthSignal.latestScore !== null ? Math.round(member.healthSignal.latestScore) : "n/a", "Upready readiness score"],
        ] as const).map(([label, val, tip]) => (
          <Tip key={label} text={tip}>
            <div className="rounded-xl border border-white/5 bg-black/20 p-3 text-center cursor-default w-full">
              <div className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</div>
              <div className="text-xl font-semibold text-white mt-1">{val}</div>
            </div>
          </Tip>
        ))}
      </div>

      {member.healthSignal.connected && (
        <div className="rounded-xl border border-white/5 bg-black/20 p-4">
          <div className="text-[9px] uppercase tracking-wider text-zinc-600">Health Signal</div>
          <div className="text-sm text-white mt-2">
            Readiness {member.healthSignal.latestScore !== null ? Math.round(member.healthSignal.latestScore) : "n/a"}
            {member.healthSignal.trendDelta7d !== null && (
              <span className="text-zinc-500"> · trend {member.healthSignal.trendDelta7d >= 0 ? "+" : ""}{member.healthSignal.trendDelta7d}</span>
            )}
          </div>
          {member.healthSignal.summary && <div className="text-[11px] text-zinc-400 mt-1.5 leading-relaxed">{member.healthSignal.summary}</div>}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="rounded-xl border border-white/5 bg-black/20 p-4">
          <div className="text-[9px] uppercase tracking-wider text-zinc-600">Integrations</div>
          <div className="flex flex-wrap gap-2 mt-3">
            {([
              [member.integrations.gmailConnected, "Gmail", <Mail key="m" className="w-3 h-3" />, "Email monitoring"],
              [member.integrations.calendarConnected, "Calendar", <CalendarDays key="c" className="w-3 h-3" />, "Calendar access"],
              [member.integrations.heartbeatEnabled, "Heartbeat", <ShieldCheck key="h" className="w-3 h-3" />, "Background agent runs"],
              [member.integrations.upreadyConnected, "Health", <HeartPulse key="u" className="w-3 h-3" />, "Readiness tracking"],
            ] as const).map(([active, label, icon, tip]) => (
              <Tip key={label} text={tip}>
                <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[10px] cursor-default ${active ? "border-emerald-500/20 bg-emerald-500/8 text-emerald-200" : "border-white/6 bg-white/[0.02] text-zinc-600"}`}>
                  {icon} {label}
                </span>
              </Tip>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-white/5 bg-black/20 p-4">
          <div className="text-[9px] uppercase tracking-wider text-zinc-600">Top Signal Types</div>
          {member.topSignalTypes.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {member.topSignalTypes.map((s) => (
                <span key={s.key} className="px-2 py-1 rounded-full border border-white/6 bg-white/[0.02] text-[10px] text-zinc-300">{s.label} · {s.count}</span>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-zinc-600 mt-3">No classified signal yet.</div>
          )}
        </div>
      </div>
      <div className="text-[10px] text-zinc-600">Last signal {fmt(member.lastSignalAt)} · last heartbeat {fmt(member.lastHeartbeatRunAt)}</div>
    </div>
  );
}

// ── Agent detail view ──

function AgentView({ detail, usageMax, onClose }: { detail: CellDetail; usageMax: number; onClose: () => void }) {
  return (
    <div className="rounded-[22px] border border-white/6 bg-white/[0.025] p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
          <Zap className="w-3.5 h-3.5 text-cyan-400/40" />
          AI Efficiency · {detail.summary.agentName}
        </div>
        <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-white transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {([
          ["Score", detail.summary.efficiency.score, "Overall AI efficiency 0-100"],
          ["Loop Risk", pct(detail.summary.efficiency.loopRisk * 100), "Probability the agent is stuck in repetitive loops"],
          ["Tok / Outcome", detail.summary.efficiency.tokensPerMeaningfulOutcome !== null ? compact(detail.summary.efficiency.tokensPerMeaningfulOutcome) : "n/a", "Average tokens consumed per meaningful outcome"],
          ["Turns / Cmd", detail.summary.efficiency.assistantTurnsPerCommand ?? "n/a", "Agent turns needed per human command"],
          ["Pending Inbox", detail.summary.activity.pendingInboxActions, "Inbox actions awaiting approval or execution"],
          ["Error Rate", detail.summary.activity.errorRate !== null ? pct(detail.summary.activity.errorRate * 100) : "n/a", "Percentage of actions that errored"],
        ] as [string, string | number, string][]).map(([label, val, tip]) => (
          <Tip key={label} text={tip}>
            <div className="rounded-xl border border-white/5 bg-black/20 p-3 cursor-default w-full">
              <div className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</div>
              <div className="text-lg font-semibold text-white mt-1">{val}</div>
            </div>
          </Tip>
        ))}
      </div>
      {detail.summary.efficiency.reasons.length > 0 && (
        <div className="space-y-1.5">
          {detail.summary.efficiency.reasons.map((r, i) => (
            <div key={`r-${i}`} className="flex items-start gap-2 text-[11px] text-zinc-500">
              <span className="mt-1.5 w-1 h-1 rounded-full bg-cyan-400/50 shrink-0" />
              <span>{r}</span>
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-3">
          <Activity className="w-3.5 h-3.5 text-cyan-400/40" />
          Usage by Model
        </div>
        {detail.usageByModel.length === 0 && <div className="text-sm text-zinc-600 py-2">No usage data.</div>}
        <div className="space-y-2">
          {detail.usageByModel.map((entry, i) => {
            const w = `${Math.max(6, Math.round((entry.totalTokens / usageMax) * 100))}%`;
            return (
              <div key={`usage-${i}`} className="rounded-xl border border-white/5 bg-black/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-white truncate">{entry.model || "Unknown"}</div>
                  <div className="text-xs text-white shrink-0">{compact(entry.totalTokens)}</div>
                </div>
                <div className="mt-2 h-1 rounded-full bg-white/[0.04] overflow-hidden">
                  <div className="h-full rounded-full bg-cyan-400/40" style={{ width: w }} />
                </div>
                <div className="text-[10px] text-zinc-600 mt-1.5">{entry.calls} calls · in {compact(entry.inputTokens)} · out {compact(entry.outputTokens)}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-3">
          <Activity className="w-3.5 h-3.5 text-cyan-400/40" />
          Timeline
        </div>
        {detail.timeline.length === 0 && <div className="text-sm text-zinc-600 py-2">No activity in this range.</div>}
        {detail.timeline.map((item, idx) => (
          <div key={item.id} className={`flex items-start gap-3 py-3 ${idx < detail.timeline.length - 1 ? "border-b border-white/[0.03]" : ""}`}>
            <span className={`mt-0.5 px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wide shrink-0 ${tlTone(item.type)}`}>{item.type.replaceAll("_", " ")}</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-white">{item.title}</div>
              <div className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">{item.detail}</div>
            </div>
            <div className="text-[10px] text-zinc-700 shrink-0 text-right">
              <div>{item.actorLabel || "System"}</div>
              <div className="mt-0.5">{fmt(item.at)}</div>
            </div>
          </div>
        ))}
      </div>

      {detail.signalTaxonomy.length > 0 && (
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-3">
            <Users className="w-3.5 h-3.5 text-cyan-400/40" />
            Signal Taxonomy
          </div>
          <div className="flex flex-wrap gap-2">
            {detail.signalTaxonomy.map((s) => (
              <Tip key={s.key} text={s.description}>
                <span className="px-2.5 py-1.5 rounded-full border border-white/6 bg-white/[0.02] text-[11px] text-zinc-400 cursor-default">{s.label}</span>
              </Tip>
            ))}
          </div>
          {detail.signalBreakdown.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-white/[0.04]">
              {detail.signalBreakdown.map((s) => (
                <span key={s.key} className="px-2 py-1 rounded-full border border-white/5 bg-white/[0.015] text-[10px] text-zinc-500">{s.label} · {s.count}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Key Results — always visible ──

function KeyResultsView({ detail }: { detail: CellDetail }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1">
        <Target className="w-3.5 h-3.5 text-cyan-400/40" />
        Key Results
      </div>
      {detail.summary.keyResults.map((kr) => (
        <div key={kr.id} className="rounded-2xl border border-white/5 bg-black/20 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-white">{kr.label}</div>
              {kr.description && <div className="text-[11px] text-zinc-500 mt-1 leading-relaxed">{kr.description}</div>}
            </div>
            <div className="text-right shrink-0">
              <div className="text-sm text-white">{kr.currentValue || kr.status.replaceAll("_", " ")}</div>
              {kr.targetValue && <div className="text-[10px] text-zinc-600 mt-0.5">→ {kr.targetValue}</div>}
            </div>
          </div>
          <div className="mt-3 h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${krBar(kr.status)}`}
              style={{ width: kr.progressPercent === null ? "0%" : `${Math.max(6, kr.progressPercent)}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-2.5 text-[10px] text-zinc-500">
            <Tip text="Measurement: computed (auto), hybrid (data + human), or manual">
              <span className="px-1.5 py-0.5 rounded border border-white/6 text-zinc-400 cursor-default">{kr.measurementMode}</span>
            </Tip>
            {kr.progressPercent !== null && (
              <Tip text="AI-estimated progress toward target">
                <span className="cursor-default">{Math.round(kr.progressPercent)}%</span>
              </Tip>
            )}
            {typeof kr.confidence === "number" && (
              <Tip text="AI confidence in this estimate">
                <span className="cursor-default">conf {Math.round(kr.confidence * 100)}%</span>
              </Tip>
            )}
          </div>
          {kr.evaluationMethod && <div className="text-[10px] text-zinc-600 mt-2">{kr.evaluationMethod}</div>}
          {kr.evidence.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              {kr.evidence.map((e, j) => (
                <span key={`${kr.id}-ev-${j}`} className="px-2 py-1 rounded-full border border-white/5 bg-white/[0.015] text-[10px] text-zinc-400">{e}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════

export function CellDetailContent({ cellId }: CellDetailContentProps) {
  const router = useRouter();
  const [selectedRange, setSelectedRange] = useState<(typeof RANGE_OPTIONS)[number]>(RANGE_OPTIONS[1]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CellDetail | null>(null);
  const [workspaceMembers, setWorkspaceMembers] = useState<CellWorkspaceMemberOption[]>([]);
  const [showEdit, setShowEdit] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);

  const vizRef = useRef<HTMLDivElement>(null);
  const [vizWidth, setVizWidth] = useState(800);

  useEffect(() => {
    if (!vizRef.current) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) setVizWidth(entry.contentRect.width);
    });
    obs.observe(vizRef.current);
    return () => obs.disconnect();
  }, []);

  const load = async (rangeDays = selectedRange.days) => {
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const from = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);
      const [detailRes, workspaceRes] = await Promise.all([
        fetch(`/api/workspaces/cells/${cellId}?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(now.toISOString())}`, { cache: "no-store" }),
        fetch("/api/workspaces/current", { cache: "no-store" }),
      ]);
      const [detailJson, workspaceJson] = await Promise.all([detailRes.json().catch(() => ({})), workspaceRes.json().catch(() => ({}))]);
      if (!detailRes.ok) throw new Error(typeof detailJson?.error === "string" ? detailJson.error : "Failed to load cell");
      if (!workspaceRes.ok) throw new Error(typeof workspaceJson?.error === "string" ? workspaceJson.error : "Failed to load workspace");
      setDetail((detailJson as CellDetailApiResponse).cell);
      setWorkspaceMembers(
        Array.isArray((workspaceJson as WorkspaceApiResponse)?.workspace?.members)
          ? (workspaceJson as WorkspaceApiResponse).workspace.members.map((m) => ({ userId: m.user_id, email: m.email || null, role: m.role }))
          : [],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cell");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(selectedRange.days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellId, selectedRange.days]);

  const members = detail?.summary.members || [];
  const orbitRadius = Math.min(vizWidth * 0.26, 195);
  const positions = useMemo(() => orbitPos(members.length, orbitRadius), [members.length, orbitRadius]);
  const cx = vizWidth / 2;
  const cy = VIZ_HEIGHT / 2;
  const usageMax = useMemo(() => {
    const vals = detail?.usageByModel.map((e) => e.totalTokens) || [];
    return vals.length > 0 ? Math.max(...vals, 1) : 1;
  }, [detail]);
  const selectedMember = selection && selection !== "agent" ? members.find((m) => m.userId === selection) || null : null;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CELL_CSS }} />
      <div className="relative h-screen overflow-y-auto bg-[#070709] text-white">
        {/* Sticky header */}
        <div className="sticky top-0 z-30 border-b border-white/5 bg-[#070709]/90 backdrop-blur-xl">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <button type="button" onClick={() => router.push("/dashboard/cells")} className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-colors shrink-0">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h1 className="text-sm font-medium text-white truncate">{detail?.summary.name || "Cell"}</h1>
              {detail?.summary && (
                <div className="hidden sm:flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] border ${statusPill(detail.summary.status)}`} title="Cell tracking status">{detail.summary.status}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] border ${effPill(detail.summary.efficiency.label)}`} title="AI efficiency label">{detail.summary.efficiency.label.replaceAll("_", " ")}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="inline-flex items-center rounded-xl border border-white/8 bg-white/[0.03] p-0.5">
                {RANGE_OPTIONS.map((opt) => (
                  <button key={opt.key} type="button" onClick={() => setSelectedRange(opt)} className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${selectedRange.key === opt.key ? "bg-white text-black" : "text-zinc-400 hover:text-white"}`}>{opt.label}</button>
                ))}
              </div>
              <button type="button" onClick={() => void load(selectedRange.days)} className="p-2 rounded-xl border border-white/8 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] transition-colors">
                <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </button>
              <button type="button" onClick={() => setShowEdit(true)} disabled={!detail} className="p-2 rounded-xl border border-cyan-400/25 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-40 transition-colors">
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-3 text-zinc-400 py-40"><Loader2 className="w-5 h-5 animate-spin" /> Loading cell…</div>
        )}
        {error && !loading && (
          <div className="max-w-xl mx-auto mt-16 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-5 py-4 text-sm text-rose-200">{error}</div>
        )}

        {!loading && !error && detail && (
          <>
            {/* Cell Visualization — no custom tooltips here, only native title attrs */}
            <div
              ref={vizRef}
              className="relative w-full overflow-hidden"
              style={{ height: VIZ_HEIGHT, backgroundImage: "radial-gradient(circle at 50% 50%, rgba(34,211,238,.03) 0%, transparent 40%), radial-gradient(circle, rgba(255,255,255,.015) 1px, transparent 1px)", backgroundSize: "100% 100%, 28px 28px" }}
            >
              <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${vizWidth} ${VIZ_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
                <circle cx={cx} cy={cy} r={orbitRadius * 0.4} fill="none" stroke="rgba(255,255,255,.02)" strokeWidth={0.5} />
                <circle cx={cx} cy={cy} r={orbitRadius} fill="none" stroke="rgba(255,255,255,.035)" strokeWidth={0.5} strokeDasharray="4 14" />
                <circle cx={cx} cy={cy} r={orbitRadius * 1.6} fill="none" stroke="rgba(255,255,255,.018)" strokeWidth={0.5} strokeDasharray="2 10" />
                {positions.map((pos, i) => {
                  const m = members[i];
                  const active = m && selection === m.userId;
                  return <line key={`conn-${m?.userId || i}`} x1={cx} y1={cy} x2={cx + pos.x} y2={cy + pos.y} stroke={active ? hLineActive(m.healthSignal.label) : hLine(m?.healthSignal.label || "unknown")} strokeWidth={active ? 2 : 1} strokeDasharray="4 8" style={{ animation: "cell-dash 3s linear infinite", transition: "stroke .3s, stroke-width .3s" }} />;
                })}
              </svg>

              {/* Nucleus */}
              <div className="absolute" style={{ left: cx, top: cy, width: 148, height: 148, transform: "translate(-50%,-50%)" }}>
                {[0, 1, 2].map((i) => (
                  <div key={`pulse-${i}`} className={`absolute inset-0 rounded-full border ${selection === "agent" ? "border-cyan-400/20" : "border-cyan-400/10"}`} style={{ animation: "cell-pulse 4.5s ease-out infinite", animationDelay: `${i * 1.5}s` }} />
                ))}
                <button
                  type="button"
                  onClick={() => setSelection(selection === "agent" ? null : "agent")}
                  title={`AI efficiency score: ${detail.summary.efficiency.score}/100 · Health: ${detail.summary.healthSignal.avgLatestScore !== null ? Math.round(detail.summary.healthSignal.avgLatestScore) : "n/a"} · Outcomes: ${detail.summary.activity.meaningfulOutcomes} · Turns: ${detail.summary.activity.assistantTurns}`}
                  className={`absolute inset-0 rounded-full border ${selection === "agent" ? "border-cyan-400/30 ring-1 ring-cyan-400/25" : "border-white/10"} bg-[#0b0b0e] flex flex-col items-center justify-center transition-all hover:scale-[1.04] active:scale-[0.97] cursor-pointer`}
                  style={{ animation: "cell-glow 4s ease-in-out infinite" }}
                >
                  <div className="text-3xl font-bold text-white leading-none">{detail.summary.efficiency.score}</div>
                  <div className="text-[9px] font-medium text-white/50 mt-1 px-5 truncate max-w-full">{detail.summary.agentName}</div>
                  <div className="flex items-center gap-2.5 mt-2.5">
                    <span className="flex items-center gap-1 text-[9px] text-zinc-500"><HeartPulse className="w-3 h-3" />{detail.summary.healthSignal.avgLatestScore !== null ? Math.round(detail.summary.healthSignal.avgLatestScore) : "—"}</span>
                    <span className="flex items-center gap-1 text-[9px] text-zinc-500"><Target className="w-3 h-3" />{detail.summary.activity.meaningfulOutcomes}</span>
                    <span className="flex items-center gap-1 text-[9px] text-zinc-500"><Zap className="w-3 h-3" />{detail.summary.activity.assistantTurns}</span>
                  </div>
                </button>
              </div>

              {positions.map((pos, i) => {
                const m = members[i];
                if (!m) return null;
                return (
                  <div key={m.userId} className="absolute z-10" style={{ left: cx + pos.x, top: cy + pos.y, transform: "translate(-50%,-50%)", animation: `cell-float-${i % 4} ${20 + (i % 3) * 7}s ease-in-out infinite`, animationDelay: `${i * 1.3}s` }}>
                    <OrbitCard member={m} selected={selection === m.userId} onClick={() => setSelection(selection === m.userId ? null : m.userId)} />
                  </div>
                );
              })}
            </div>

            {/* Objective */}
            <div className="text-center max-w-2xl mx-auto px-6 mt-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-600">Objective</div>
              <p className="text-base sm:text-lg text-zinc-300 mt-2 leading-relaxed">{detail.summary.objectiveSummary || detail.summary.objective}</p>
              <div className="flex flex-wrap items-center justify-center gap-2 mt-3 text-[11px] text-zinc-600">
                <span>{members.length} human{members.length !== 1 ? "s" : ""}</span>
                <span className="w-1 h-1 rounded-full bg-zinc-800 inline-block" />
                <span>{fmtRange(detail.range.from, detail.range.to)}</span>
                <span className="w-1 h-1 rounded-full bg-zinc-800 inline-block" />
                <span>Last activity {fmt(detail.summary.activity.lastActivityAt)}</span>
              </div>
            </div>

            {/* Content: contextual panel ABOVE, KRs ALWAYS below */}
            <div className="max-w-4xl mx-auto px-4 sm:px-6 mt-10 pb-16 space-y-6">
              {selection === "agent" && <AgentView detail={detail} usageMax={usageMax} onClose={() => setSelection(null)} />}
              {selectedMember && <MemberView member={selectedMember} onClose={() => setSelection(null)} />}
              <KeyResultsView detail={detail} />
            </div>
          </>
        )}

        {!loading && !detail && !error && (
          <div className="flex items-center justify-center py-40 text-sm text-zinc-600">Cell not found.</div>
        )}
      </div>
      <CellEditModal isOpen={showEdit} cell={detail} members={workspaceMembers} onClose={() => setShowEdit(false)} onSaved={() => void load(selectedRange.days)} />
    </>
  );
}
