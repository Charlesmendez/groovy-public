"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { AgentUsageBreakdown } from "@/components/usage/AgentUsageBreakdown";
import { CustomSelect } from "@/components/ui/CustomSelect";
import {
  Loader2,
  Zap,
  Cpu,
  Wrench,
  Calendar,
  ChevronDown,
  AlertCircle,
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  Users,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";

// ─── Types ───────────────────────────────────────────────────────

type RangePreset = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "custom";

type Summary = {
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  billableTokens?: number;
  nonBillableTokens?: number;
  groovyKeyTokens?: number;
  externalKeyTokens?: number;
  noChargeTokens?: number;
  modelCostUsdTotal?: number;
  groovyFeeUsdTotal?: number;
  totalChargeUsdTotal?: number;
  groovyKeyChargeUsdTotal?: number;
  externalKeyCostBasisUsdTotal?: number;
  externalKeyFeeUsdTotal?: number;
  externalKeyChargeUsdTotal?: number;
  totalLlmCalls: number;
  meteredLlmCalls?: number;
  unmeteredLlmCalls?: number;
  totalToolCalls: number;
  estimatedCount: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheSavingsUsd?: number;
};

type TimeSeriesPoint = {
  time: string;
  tokens: number;
  input: number;
  output: number;
  calls: number;
};

type SourceBreakdown = { source: string; tokens: number; calls: number; unmeteredCalls?: number };
type ModelBreakdown = {
  model: string;
  tokens: number;
  input: number;
  output: number;
  calls: number;
  unmeteredCalls?: number;
};
type ToolBreakdown = { tool: string; count: number };
type TeamMember = {
  userId: string;
  label: string;
  email: string | null;
  role: "admin" | "member" | "guest";
  isCurrentUser: boolean;
};
type TeamMemberBreakdown = {
  userId: string;
  label: string;
  email: string | null;
  role: "admin" | "member" | "guest";
  tokens: number;
  input: number;
  output: number;
  calls: number;
  unmeteredCalls?: number;
  toolCalls: number;
  modelCostUsd: number;
  totalChargeUsd: number;
};

type UsageData = {
  range: { from: string; to: string };
  selectedTeamMemberId?: string | null;
  teamMembers?: TeamMember[];
  granularity: "hour" | "day";
  timezone?: "UTC";
  truncated?: { usageEvents: boolean; toolEvents: boolean };
  rowCounts?: { usageEvents: number; toolEvents: number };
  summary: Summary;
  timeSeries: TimeSeriesPoint[];
  bySource: SourceBreakdown[];
  byModel: ModelBreakdown[];
  byTeamMember?: TeamMemberBreakdown[];
  topTools: ToolBreakdown[];
};

// ─── Helpers ─────────────────────────────────────────────────────

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getPresetRange(preset: RangePreset): { from: Date; to: Date } {
  const now = new Date();
  const today = startOfDay(now);

  switch (preset) {
    case "today":
      return { from: today, to: now };
    case "yesterday": {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      return { from: y, to: today };
    }
    case "this_week": {
      const dow = now.getDay();
      const mon = new Date(today);
      mon.setDate(mon.getDate() - ((dow + 6) % 7));
      return { from: mon, to: now };
    }
    case "last_week": {
      const dow = now.getDay();
      const thisMon = new Date(today);
      thisMon.setDate(thisMon.getDate() - ((dow + 6) % 7));
      const lastMon = new Date(thisMon);
      lastMon.setDate(lastMon.getDate() - 7);
      return { from: lastMon, to: thisMon };
    }
    case "this_month":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
    case "last_month": {
      const firstThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const firstLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { from: firstLastMonth, to: firstThisMonth };
    }
    default:
      return { from: today, to: now };
  }
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatUsd(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

function formatDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SOURCE_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator",
  orchestrator_round: "Orchestrator (WhatsApp/Scheduler)",
  heartbeat: "Heartbeat",
  memory_planner: "Memory Planner",
  compaction: "Prompt Compaction",
  ai_agent_delegate: "AI Agent Delegate",
  datagran_agent: "Data Agent",
  code_agent_cli: "Code Agent (CLI)",
  connector_code_cli: "Claude Code (CLI)",
  connector_browser_task: "Browser Task (CLI)",
};

const PRESET_LABELS: Record<RangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This Week",
  last_week: "Last Week",
  this_month: "This Month",
  last_month: "Last Month",
  custom: "Custom",
};

// ─── Chart tooltip ───────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; name: string; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 shadow-xl">
      <p className="text-[11px] text-zinc-400 mb-1">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-zinc-300">{p.name}:</span>
          <span className="text-white font-medium">{formatNumber(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Summary Card ────────────────────────────────────────────────

function SummaryCard({
  icon,
  label,
  value,
  detail,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  color: "cyan" | "violet" | "amber" | "emerald";
}) {
  const colorMap = {
    cyan: { bg: "bg-cyan-500/10", border: "border-cyan-500/20", text: "text-cyan-400", icon: "text-cyan-500" },
    violet: { bg: "bg-violet-500/10", border: "border-violet-500/20", text: "text-violet-400", icon: "text-violet-500" },
    amber: { bg: "bg-amber-500/10", border: "border-amber-500/20", text: "text-amber-400", icon: "text-amber-500" },
    emerald: { bg: "bg-emerald-500/10", border: "border-emerald-500/20", text: "text-emerald-400", icon: "text-emerald-500" },
  };
  const c = colorMap[color];
  return (
    <div className={`rounded-xl border ${c.border} ${c.bg} p-4`}>
      <div className="flex items-center gap-2 mb-2">
        <div className={c.icon}>{icon}</div>
        <span className="text-[11px] text-zinc-500 uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-white tabular-nums">{value}</div>
      {detail && <div className="text-[11px] text-zinc-500 mt-1">{detail}</div>}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────

export function UsageDashboardContent() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<UsageData | null>(null);
  const [preset, setPreset] = useState<RangePreset>("this_month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [showPresets, setShowPresets] = useState(false);
  const [selectedTeamMemberId, setSelectedTeamMemberId] = useState("all");
  const requestSeqRef = useRef(0);

  const fetchUsage = useCallback(async (from: Date, to: Date, teamMemberId: string) => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
      });
      if (teamMemberId !== "all") {
        params.set("teamMemberId", teamMemberId);
      }
      const res = await fetch(`/api/billing/usage?${params}`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (requestSeq !== requestSeqRef.current) return;
        if (res.status === 403) {
          setError("Admin access required to view usage.");
        } else {
          setError(body?.error || `Error ${res.status}`);
        }
        setData(null);
        return;
      }
      const json = await res.json();
      if (requestSeq !== requestSeqRef.current) return;
      setData(json);
    } catch (err) {
      if (requestSeq !== requestSeqRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load usage data");
      setData(null);
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (preset === "custom") return;
    const { from, to } = getPresetRange(preset);
    setCustomFrom(formatDateInput(from));
    setCustomTo(formatDateInput(to));
    fetchUsage(from, to, selectedTeamMemberId);
  }, [preset, selectedTeamMemberId, fetchUsage]);

  const handleCustomApply = () => {
    if (!customFrom || !customTo) return;
    const from = new Date(customFrom + "T00:00:00");
    const to = new Date(customTo + "T23:59:59");
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) return;
    fetchUsage(from, to, selectedTeamMemberId);
  };

  const handleTeamMemberChange = (nextTeamMemberId: string) => {
    setSelectedTeamMemberId(nextTeamMemberId);
    if (preset === "custom") {
      if (!customFrom || !customTo) return;
      const from = new Date(customFrom + "T00:00:00");
      const to = new Date(customTo + "T23:59:59");
      if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) return;
      fetchUsage(from, to, nextTeamMemberId);
    }
  };

  const summary = data?.summary;
  const teamMembers = data?.teamMembers || [];
  const byTeamMember = data?.byTeamMember || [];
  const selectedTeamMember =
    selectedTeamMemberId === "all"
      ? null
      : teamMembers.find((member) => member.userId === selectedTeamMemberId) || null;
  const visibleTeamBreakdown =
    selectedTeamMemberId === "all"
      ? byTeamMember
      : byTeamMember.filter((member) => member.userId === selectedTeamMemberId);
  const maxTeamTokens = Math.max(1, ...visibleTeamBreakdown.map((member) => member.tokens || 0));
  const groovyKeyTokens = summary?.groovyKeyTokens || 0;
  const externalKeyTokens = summary?.externalKeyTokens || 0;
  const noChargeTokens = summary?.noChargeTokens || 0;
  const meteredLlmCalls = summary?.meteredLlmCalls ?? summary?.totalLlmCalls ?? 0;
  const unmeteredLlmCalls = summary?.unmeteredLlmCalls || 0;
  const hasChargeSplit = externalKeyTokens > 0 || noChargeTokens > 0;

  const chartData = (data?.timeSeries || []).map((p) => {
    const d = new Date(p.time);
    const tz = data?.timezone || "UTC";
    const label =
      data?.granularity === "hour"
        ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: tz })
        : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: tz });
    return { ...p, label };
  });

  return (
    <div className="space-y-6">
      {/* Date range picker */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <button
            onClick={() => setShowPresets(!showPresets)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-zinc-300 hover:bg-white/10 transition-colors"
          >
            <Calendar className="w-4 h-4 text-zinc-500" />
            {PRESET_LABELS[preset]}
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
          </button>

          {showPresets && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowPresets(false)} />
              <div className="absolute left-0 top-full mt-1 w-48 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl overflow-hidden z-30">
                {(Object.keys(PRESET_LABELS) as RangePreset[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => {
                      setPreset(p);
                      setShowPresets(false);
                    }}
                    className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                      preset === p
                        ? "bg-cyan-500/10 text-cyan-300"
                        : "text-zinc-300 hover:bg-white/5"
                    }`}
                  >
                    {PRESET_LABELS[p]}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {preset === "custom" && (
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-zinc-300 [color-scheme:dark]"
            />
            <span className="text-zinc-600 text-xs">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-zinc-300 [color-scheme:dark]"
            />
            <button
              onClick={handleCustomApply}
              className="px-3 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-sm hover:bg-cyan-500/25 transition-colors"
            >
              Apply
            </button>
          </div>
        )}

        {teamMembers.length > 1 && (
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-zinc-500" />
            <CustomSelect
              value={selectedTeamMemberId}
              onChange={handleTeamMemberChange}
              options={[
                { value: "all", label: "All team members" },
                ...teamMembers.map((member) => ({
                  value: member.userId,
                  label: `${member.label}${
                    member.isCurrentUser ? " (you)" : ""
                  }`,
                })),
              ]}
              className="w-52"
              ariaLabel="Team member usage"
              size="sm"
            />
          </div>
        )}
      </div>

      {/* Loading */}
      {loading && !data && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-4 rounded-xl bg-red-500/5 border border-red-500/20 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {data && (
        <>
          {(data.truncated?.usageEvents || data.truncated?.toolEvents) && (
            <div className="p-4 rounded-xl bg-amber-500/5 border border-amber-500/20 flex items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-amber-200">Large range: results were capped for performance.</p>
                  <p className="text-xs text-amber-300/80 mt-1">
                    Showing {data.rowCounts?.usageEvents ?? 0} usage events and{" "}
                    {data.rowCounts?.toolEvents ?? 0} tool events.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3">
            <SummaryCard
              icon={<Zap className="w-4 h-4" />}
              label="Total Tokens"
              value={formatNumber(summary?.totalTokens || 0)}
              detail={
                hasChargeSplit
                  ? `${formatNumber(noChargeTokens)} no-charge / ${formatNumber(groovyKeyTokens + externalKeyTokens)} reseller-billable`
                  : [
                      `${formatNumber(summary?.totalInputTokens || 0)} in / ${formatNumber(summary?.totalOutputTokens || 0)} out`,
                      unmeteredLlmCalls > 0 ? `${unmeteredLlmCalls} unmetered` : "",
                    ].filter(Boolean).join(" · ")
              }
              color="cyan"
            />
            <SummaryCard
              icon={<Cpu className="w-4 h-4" />}
              label="LLM Calls"
              value={String(summary?.totalLlmCalls || 0)}
              detail={
                [
                  summary?.estimatedCount ? `${summary.estimatedCount} estimated` : "",
                  unmeteredLlmCalls > 0 ? `${unmeteredLlmCalls} unmetered` : "",
                ].filter(Boolean).join(" · ") || undefined
              }
              color="violet"
            />
            <SummaryCard
              icon={<Wrench className="w-4 h-4" />}
              label="Tool Calls"
              value={String(summary?.totalToolCalls || 0)}
              color="amber"
            />
            <SummaryCard
              icon={<TrendingUp className="w-4 h-4" />}
              label="Avg Tokens / Call"
              value={
                summary && meteredLlmCalls > 0
                  ? formatNumber(Math.round(summary.totalTokens / meteredLlmCalls))
                  : "—"
              }
              detail={unmeteredLlmCalls > 0 ? "excludes unmetered" : undefined}
              color="emerald"
            />
          </div>

          {/* Usage by team member */}
          {visibleTeamBreakdown.length > 0 && (
            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
              <div className="flex items-center justify-between gap-3 mb-4">
                <h2 className="text-sm font-medium text-zinc-300">Usage by Team Member</h2>
                {selectedTeamMember ? (
                  <span className="text-[11px] text-cyan-300 bg-cyan-500/10 border border-cyan-500/20 rounded-full px-2 py-0.5">
                    Filtered: {selectedTeamMember.label}
                  </span>
                ) : (
                  <span className="text-[11px] text-zinc-600">
                    {teamMembers.length} {teamMembers.length === 1 ? "member" : "members"}
                  </span>
                )}
              </div>
              <div className="space-y-3">
                {visibleTeamBreakdown.map((member) => {
                  const pct =
                    member.tokens > 0 ? Math.max(2, Math.round((member.tokens / maxTeamTokens) * 100)) : 0;
                  const unmetered = member.unmeteredCalls || 0;
                  const roleLabel =
                    member.role === "admin"
                      ? "Admin"
                      : member.role === "guest"
                        ? "Channel guest"
                        : "Member";
                  const usageLabel = [
                    member.calls > 0 ? `${member.calls} LLM` : "",
                    unmetered > 0 ? `${unmetered} unmetered` : "",
                    member.toolCalls > 0 ? `${member.toolCalls} tools` : "",
                  ].filter(Boolean).join(" · ");
                  return (
                    <div key={member.userId} className="rounded-lg border border-white/10 bg-black/20 p-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm text-zinc-200 truncate">{member.label}</span>
                            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{roleLabel}</span>
                          </div>
                          <div className="text-[11px] text-zinc-600 truncate">
                            {member.email || usageLabel || "No usage in this range"}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-medium text-white tabular-nums">
                            {member.tokens > 0 ? formatNumber(member.tokens) : "No tokens"}
                          </div>
                          <div className="text-[11px] text-zinc-600">
                            {member.totalChargeUsd > 0 ? formatUsd(member.totalChargeUsd) : usageLabel || "0 calls"}
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 h-1.5 rounded-full bg-white/5 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-cyan-500/70 to-violet-400/50 transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      {member.email && usageLabel && (
                        <div className="text-[11px] text-zinc-600 mt-2">{usageLabel}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Charge breakdown */}
          {summary && (summary.totalChargeUsdTotal ?? 0) > 0 && (
            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
              <div className="flex items-center justify-between gap-3 mb-4">
                <h2 className="text-sm font-medium text-zinc-300">Reseller Usage Charges</h2>
                <span className="text-[11px] text-zinc-600">Hidden for normal licenses unless charges exist</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                  <div className="text-[11px] text-zinc-500">Total charged</div>
                  <div className="text-lg font-medium text-white tabular-nums">
                    {formatUsd(summary.totalChargeUsdTotal || 0)}
                  </div>
                  <div className="text-[11px] text-zinc-600 mt-1">All chargeable usage</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                  <div className="text-[11px] text-zinc-500">Provider-key reseller usage</div>
                  <div className="text-lg font-medium text-white tabular-nums">
                    {formatUsd(summary.groovyKeyChargeUsdTotal || 0)}
                  </div>
                  <div className="text-[11px] text-zinc-600 mt-1">Provider cost plus configured reseller billing</div>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                  <div className="text-[11px] text-zinc-500">Customer-key reseller usage</div>
                  <div className="text-lg font-medium text-white tabular-nums">
                    {formatUsd(summary.externalKeyFeeUsdTotal || 0)}
                  </div>
                  <div className="text-[11px] text-zinc-600 mt-1">
                    Authorized reseller fee on {formatUsd(summary.externalKeyCostBasisUsdTotal || 0)} cost basis
                  </div>
                </div>
              </div>
              {noChargeTokens > 0 ? (
                <div className="text-[11px] text-zinc-600 mt-3">
                  {formatNumber(noChargeTokens)} tokens are marked no-charge.
                </div>
              ) : null}
            </div>
          )}

          {/* Prompt Caching breakdown — only shown when cache data exists */}
          {summary &&
            ((summary.cacheReadTokens ?? 0) > 0 || (summary.cacheWriteTokens ?? 0) > 0) && (() => {
              const cacheRead = summary.cacheReadTokens ?? 0;
              const cacheWrite = summary.cacheWriteTokens ?? 0;
              const totalInput = Math.max(summary.totalInputTokens || 0, cacheRead + cacheWrite, 1);
              const uncached = Math.max(0, totalInput - cacheRead - cacheWrite);
              const hitRate = ((cacheRead / totalInput) * 100);
              const netSavings = summary.cacheSavingsUsd ?? 0;
              // Bar percentages
              const readPct = Math.min(100, (cacheRead / totalInput) * 100);
              const writePct = Math.min(100 - readPct, (cacheWrite / totalInput) * 100);
              const uncachedPct = Math.max(0, 100 - readPct - writePct);

              return (
                <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-medium text-zinc-300">Prompt Caching</h2>
                    <span
                      className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                        hitRate >= 50
                          ? "bg-emerald-500/15 text-emerald-400"
                          : hitRate >= 20
                            ? "bg-amber-500/15 text-amber-400"
                            : "bg-zinc-500/15 text-zinc-400"
                      }`}
                    >
                      {hitRate.toFixed(1)}% hit rate
                    </span>
                  </div>

                  {/* Stacked bar */}
                  <div className="flex h-3 rounded-full overflow-hidden bg-zinc-800 mb-5">
                    {readPct > 0 && (
                      <div
                        className="bg-emerald-500 transition-all"
                        style={{ width: `${readPct}%` }}
                        title={`Cache Hits: ${readPct.toFixed(1)}%`}
                      />
                    )}
                    {writePct > 0 && (
                      <div
                        className="bg-blue-500 transition-all"
                        style={{ width: `${writePct}%` }}
                        title={`Cache Writes: ${writePct.toFixed(1)}%`}
                      />
                    )}
                    {uncachedPct > 0 && (
                      <div
                        className="bg-zinc-600 transition-all"
                        style={{ width: `${uncachedPct}%` }}
                        title={`Uncached: ${uncachedPct.toFixed(1)}%`}
                      />
                    )}
                  </div>

                  {/* Stat rows */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                        <div>
                          <span className="text-sm text-zinc-200">Cache Hits</span>
                          <p className="text-[11px] text-zinc-600">Tokens served from cache at 90% discount</p>
                        </div>
                      </div>
                      <span className="text-sm font-medium text-emerald-400 tabular-nums">{formatNumber(cacheRead)}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                        <div>
                          <span className="text-sm text-zinc-200">Cache Writes</span>
                          <p className="text-[11px] text-zinc-600">Tokens written to cache (25% surcharge)</p>
                        </div>
                      </div>
                      <span className="text-sm font-medium text-blue-400 tabular-nums">{formatNumber(cacheWrite)}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-2.5 h-2.5 rounded-full bg-zinc-600" />
                        <div>
                          <span className="text-sm text-zinc-200">Uncached</span>
                          <p className="text-[11px] text-zinc-600">Standard-rate input tokens</p>
                        </div>
                      </div>
                      <span className="text-sm font-medium text-zinc-400 tabular-nums">{formatNumber(uncached)}</span>
                    </div>
                  </div>

                  {/* Net savings */}
                  {netSavings > 0 && (
                    <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between">
                      <span className="text-[11px] text-zinc-500">Estimated net savings vs. uncached pricing</span>
                      <span className="text-sm font-medium text-emerald-400">${netSavings.toFixed(2)} saved</span>
                    </div>
                  )}
                </div>
              );
            })()}

          {/* Token usage chart */}
          <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-zinc-300">Token Usage Over Time</h2>
              <span className="text-[11px] text-zinc-600">
                {data.granularity === "hour" ? "Hourly" : "Daily"} granularity ·{" "}
                {data.timezone || "UTC"}
              </span>
            </div>
            {chartData.length > 0 ? (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="inputGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="outputGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#a78bfa" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "#71717a", fontSize: 11 }}
                      tickLine={false}
                      axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fill: "#71717a", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={formatNumber}
                    />
                    <Tooltip content={<ChartTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="input"
                      name="Input"
                      stroke="#06b6d4"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#inputGrad)"
                      dot={false}
                      activeDot={{ r: 4, fill: "#06b6d4" }}
                    />
                    <Area
                      type="monotone"
                      dataKey="output"
                      name="Output"
                      stroke="#a78bfa"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#outputGrad)"
                      dot={false}
                      activeDot={{ r: 4, fill: "#a78bfa" }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-48 flex items-center justify-center text-zinc-600 text-sm">
                No usage data for this period
              </div>
            )}
          </div>

          {/* Breakdowns */}
          <div className="grid grid-cols-1 gap-4">
            {/* By Agent (harness) */}
            <AgentUsageBreakdown />
            {/* By Source */}
            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
              <h2 className="text-sm font-medium text-zinc-300 mb-4">Usage by Source</h2>
              {data.bySource.length > 0 ? (
                <div className="space-y-2">
                  {data.bySource.map((s) => {
                    const pct =
                      summary && summary.totalTokens > 0 && s.tokens > 0
                        ? Math.max(1, Math.round((s.tokens / summary.totalTokens) * 100))
                        : 0;
                    const unmetered = s.unmeteredCalls || 0;
                    const callLabel = [
                      s.calls > 0 ? `${s.calls} calls` : "",
                      unmetered > 0 ? `${unmetered} unmetered` : "",
                    ].filter(Boolean).join(" · ");
                    return (
                      <div key={s.source} className="group">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-zinc-400">
                            {SOURCE_LABELS[s.source] || s.source}
                          </span>
                          <div className="flex items-center gap-3">
                            <span className="text-[11px] text-zinc-600">{callLabel}</span>
                            <span className="text-xs text-zinc-300 font-medium tabular-nums">
                              {s.tokens > 0 ? formatNumber(s.tokens) : "Unmetered"}
                            </span>
                          </div>
                        </div>
                        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-cyan-500/60 to-cyan-400/40 transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-zinc-600">No data</p>
              )}
            </div>

            {/* By Model */}
            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
              <h2 className="text-sm font-medium text-zinc-300 mb-4">Usage by Model</h2>
              {data.byModel.length > 0 ? (
                <div className="space-y-3">
                  {data.byModel.map((m) => {
                    const unmetered = m.unmeteredCalls || 0;
                    const callLabel = [
                      m.calls > 0 ? `${m.calls} calls` : "",
                      unmetered > 0 ? `${unmetered} unmetered` : "",
                    ].filter(Boolean).join(" · ");
                    return (
                      <div key={m.model} className="flex items-center justify-between">
                        <div>
                          <span className="text-xs text-zinc-300 font-mono">{m.model}</span>
                          {m.tokens > 0 ? (
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[10px] text-cyan-400/70 flex items-center gap-0.5">
                                <ArrowDownRight className="w-3 h-3" />
                                {formatNumber(m.input)}
                              </span>
                              <span className="text-[10px] text-violet-400/70 flex items-center gap-0.5">
                                <ArrowUpRight className="w-3 h-3" />
                                {formatNumber(m.output)}
                              </span>
                            </div>
                          ) : (
                            <div className="text-[10px] text-zinc-600 mt-0.5">No token data</div>
                          )}
                        </div>
                        <div className="text-right">
                          <span className="text-sm text-white font-medium tabular-nums">
                            {m.tokens > 0 ? formatNumber(m.tokens) : "Unmetered"}
                          </span>
                          <div className="text-[10px] text-zinc-600">{callLabel}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-zinc-600">No data</p>
              )}
            </div>
          </div>

          {/* Top Tools */}
          {data.topTools.length > 0 && (
            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
              <h2 className="text-sm font-medium text-zinc-300 mb-4">Top Tools</h2>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.topTools.slice(0, 10)}
                    layout="vertical"
                    margin={{ top: 0, right: 10, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                    <XAxis
                      type="number"
                      tick={{ fill: "#71717a", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      dataKey="tool"
                      type="category"
                      tick={{ fill: "#a1a1aa", fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={140}
                    />
                    <Tooltip
                      cursor={{ fill: "rgba(255,255,255,0.02)" }}
                      contentStyle={{
                        background: "#18181b",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                      labelStyle={{ color: "#a1a1aa" }}
                      itemStyle={{ color: "#f4f4f5" }}
                    />
                    <Bar dataKey="count" name="Calls" fill="#f59e0b" radius={[0, 4, 4, 0]} barSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
