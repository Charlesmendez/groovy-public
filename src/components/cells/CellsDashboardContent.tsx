"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Bot,
  CalendarDays,
  HeartPulse,
  Loader2,
  Mail,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  Zap,
} from "lucide-react";
import { CellCreateModal, type CellWorkspaceMemberOption } from "@/components/cells/CellCreateModal";
import type { CellAgentOption, CellSummary } from "@/lib/cells/types";

type CellsApiResponse = {
  workspace: { id: string; name: string };
  range: { from: string; to: string };
  cells: CellSummary[];
};

type WorkspaceApiResponse = {
  workspace: {
    id: string;
    name: string;
    role: "admin" | "member";
    members: Array<{
      user_id: string;
      role: "admin" | "member";
      email?: string | null;
    }>;
  };
};

const RANGE_OPTIONS = [
  { key: "7d", label: "7D", days: 7 },
  { key: "30d", label: "30D", days: 30 },
  { key: "90d", label: "90D", days: 90 },
] as const;

function formatCompactNumber(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

function formatPercent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${Math.round(value)}%`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "No activity yet";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "No activity yet";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getStatusTone(status: CellSummary["status"]) {
  if (status === "active") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-300";
  if (status === "paused") return "border-amber-500/25 bg-amber-500/10 text-amber-300";
  return "border-zinc-500/25 bg-zinc-500/10 text-zinc-300";
}

function getHealthTone(label: CellSummary["healthSignal"]["label"]) {
  if (label === "strong") return "text-emerald-300";
  if (label === "strained") return "text-rose-300";
  if (label === "watch") return "text-amber-300";
  return "text-zinc-500";
}

function getEfficiencyTone(label: CellSummary["efficiency"]["label"]) {
  if (label === "efficient") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-200";
  if (label === "expensive_but_productive")
    return "border-cyan-500/25 bg-cyan-500/10 text-cyan-200";
  if (label === "looping") return "border-rose-500/25 bg-rose-500/10 text-rose-200";
  return "border-zinc-500/25 bg-zinc-500/10 text-zinc-300";
}

function StatCard({
  title,
  value,
  detail,
  icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-[24px] border border-white/8 bg-white/[0.03] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">{title}</div>
          <div className="text-2xl font-semibold text-white mt-3">{value}</div>
          <div className="text-sm text-zinc-400 mt-2 leading-relaxed">{detail}</div>
        </div>
        <div className="w-11 h-11 rounded-2xl border border-white/10 bg-white/[0.04] flex items-center justify-center text-cyan-300 shrink-0">
          {icon}
        </div>
      </div>
    </div>
  );
}

function CoverageRow({ label, value, total, icon }: { label: string; value: number; total: number; icon: React.ReactNode }) {
  const width = total > 0 ? `${Math.max(8, Math.round((value / total) * 100))}%` : "0%";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 text-zinc-400">
          <span className="text-zinc-500">{icon}</span>
          {label}
        </div>
        <span className="text-zinc-300">
          {value}/{total}
        </span>
      </div>
      <div className="h-2 rounded-full bg-white/[0.04] overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-400/80 to-emerald-400/80"
          style={{ width }}
        />
      </div>
    </div>
  );
}

export function CellsDashboardContent() {
  const router = useRouter();
  const [selectedRange, setSelectedRange] = useState<(typeof RANGE_OPTIONS)[number]>(RANGE_OPTIONS[1]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [cellsData, setCellsData] = useState<CellsApiResponse | null>(null);
  const [agentOptions, setAgentOptions] = useState<CellAgentOption[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<CellWorkspaceMemberOption[]>([]);

  const load = async (rangeDays = selectedRange.days) => {
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const from = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);
      const [cellsRes, agentsRes, workspaceRes] = await Promise.all([
        fetch(`/api/workspaces/cells?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(now.toISOString())}`, { cache: "no-store" }),
        fetch("/api/workspaces/cells/agents", { cache: "no-store" }),
        fetch("/api/workspaces/current", { cache: "no-store" }),
      ]);

      const [cellsJson, agentsJson, workspaceJson] = await Promise.all([
        cellsRes.json().catch(() => ({})),
        agentsRes.json().catch(() => ({})),
        workspaceRes.json().catch(() => ({})),
      ]);

      if (!cellsRes.ok) throw new Error(typeof cellsJson?.error === "string" ? cellsJson.error : "Failed to load cells");
      if (!agentsRes.ok) throw new Error(typeof agentsJson?.error === "string" ? agentsJson.error : "Failed to load agents");
      if (!workspaceRes.ok) throw new Error(typeof workspaceJson?.error === "string" ? workspaceJson.error : "Failed to load workspace");

      setCellsData(cellsJson as CellsApiResponse);
      setAgentOptions(Array.isArray(agentsJson?.agents) ? (agentsJson.agents as CellAgentOption[]) : []);
      setWorkspaceMembers(
        Array.isArray((workspaceJson as WorkspaceApiResponse)?.workspace?.members)
          ? (workspaceJson as WorkspaceApiResponse).workspace.members.map((member) => ({
              userId: member.user_id,
              email: member.email || null,
              role: member.role,
            }))
          : []
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cells");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(selectedRange.days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRange.days]);

  const overview = useMemo(() => {
    const cells = cellsData?.cells || [];
    const totalHumans = cells.reduce((sum, cell) => sum + cell.signalCoverage.humans, 0);
    const avgEfficiency =
      cells.length > 0
        ? Math.round(cells.reduce((sum, cell) => sum + cell.efficiency.score, 0) / cells.length)
        : 0;
    const avgHealth =
      cells.length > 0
        ? Math.round(
            cells.reduce((sum, cell) => sum + (cell.healthSignal.avgLatestScore || 0), 0) /
              Math.max(
                1,
                cells.filter((cell) => typeof cell.healthSignal.avgLatestScore === "number").length
              )
          )
        : 0;

    return {
      cellCount: cells.length,
      totalHumans,
      avgEfficiency,
      avgHealth,
      totalOutcomes: cells.reduce((sum, cell) => sum + cell.activity.meaningfulOutcomes, 0),
    };
  }, [cellsData]);

  return (
    <>
      <div className="relative h-screen overflow-y-auto bg-[#070709] text-white">
        <div className="absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(circle_at_20%_0%,rgba(34,211,238,0.14),transparent_32%),radial-gradient(circle_at_85%_8%,rgba(16,185,129,0.12),transparent_28%),radial-gradient(circle_at_55%_18%,rgba(217,70,239,0.08),transparent_24%)] pointer-events-none" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
            <div className="max-w-3xl">
              <button
                type="button"
                onClick={() => router.push("/dashboard")}
                className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Dashboard
              </button>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 text-[11px] uppercase tracking-[0.18em] text-cyan-200">
                <Sparkles className="w-3.5 h-3.5" />
                Living Cells
              </div>
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-white mt-4">
                See whether each human + AI cell is actually getting stronger.
              </h1>
              <p className="text-sm sm:text-base text-zinc-400 mt-4 leading-relaxed max-w-2xl">
                Track signal coverage, health signal, AI efficiency, and dynamic OKR progress for the
                agents your workspace is organizing around.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex items-center rounded-2xl border border-white/8 bg-white/[0.03] p-1">
                {RANGE_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setSelectedRange(option)}
                    className={`px-3.5 py-2 rounded-xl text-xs font-medium transition-colors ${
                      selectedRange.key === option.key
                        ? "bg-white text-black"
                        : "text-zinc-400 hover:text-white"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => void load(selectedRange.days)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl border border-white/10 bg-white/[0.03] text-sm text-zinc-200 hover:bg-white/[0.06] transition-colors"
              >
                <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>

              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl border border-cyan-400/30 bg-cyan-500/12 text-sm text-cyan-100 hover:bg-cyan-500/18 transition-colors"
              >
                <Plus className="w-4 h-4" />
                New Cell
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mt-8">
            <StatCard
              title="Active Cells"
              value={String(overview.cellCount)}
              detail={`${formatCompactNumber(overview.totalOutcomes)} meaningful outcomes across the selected window.`}
              icon={<Target className="w-5 h-5" />}
            />
            <StatCard
              title="Tracked Humans"
              value={String(overview.totalHumans)}
              detail="Humans feeding signal, corrections, approvals, and operating context into cells."
              icon={<Users className="w-5 h-5" />}
            />
            <StatCard
              title="Avg Efficiency"
              value={`${overview.avgEfficiency}`}
              detail="Composite score blending loop risk, spend, repetition, and outcomes."
              icon={<Zap className="w-5 h-5" />}
            />
            <StatCard
              title="Avg Health Signal"
              value={overview.avgHealth > 0 ? `${overview.avgHealth}` : "n/a"}
              detail="Readiness average for members who have health signal connected."
              icon={<HeartPulse className="w-5 h-5" />}
            />
          </div>

          {loading && (
            <div className="mt-8 rounded-[28px] border border-white/8 bg-white/[0.03] p-8 flex items-center justify-center gap-3 text-zinc-400">
              <Loader2 className="w-5 h-5 animate-spin" />
              Loading cell analytics...
            </div>
          )}

          {error && !loading && (
            <div className="mt-8 rounded-[28px] border border-rose-500/20 bg-rose-500/10 px-5 py-4 text-sm text-rose-200">
              {error}
            </div>
          )}

          {!loading && !error && (cellsData?.cells || []).length === 0 && (
            <div className="mt-8 rounded-[32px] border border-dashed border-white/10 bg-white/[0.025] p-8 sm:p-10">
              <div className="max-w-2xl">
                <div className="w-14 h-14 rounded-3xl border border-white/10 bg-white/[0.04] flex items-center justify-center text-cyan-300">
                  <BarChart3 className="w-6 h-6" />
                </div>
                <h2 className="text-2xl font-semibold text-white mt-5">No cells yet</h2>
                <p className="text-sm text-zinc-400 mt-3 leading-relaxed">
                  Create your first living cell to track one existing agent, the humans feeding it,
                  the health signal around those humans, and whether the agent is compounding or just looping.
                </p>
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="inline-flex items-center gap-2 mt-6 px-4 py-2.5 rounded-2xl border border-cyan-400/30 bg-cyan-500/12 text-sm text-cyan-100 hover:bg-cyan-500/18 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Create First Cell
                </button>
              </div>
            </div>
          )}

          {!loading && !error && (cellsData?.cells || []).length > 0 && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mt-8">
              {(cellsData?.cells || []).map((cell) => (
                <button
                  key={cell.id}
                  type="button"
                  onClick={() => router.push(`/dashboard/cells/${cell.id}`)}
                  className="group text-left rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] hover:border-cyan-400/25 transition-all overflow-hidden"
                >
                  <div className="h-1 bg-gradient-to-r from-cyan-400/80 via-emerald-400/80 to-fuchsia-400/80 opacity-60 group-hover:opacity-100 transition-opacity" />
                  <div className="p-5 sm:p-6">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center flex-wrap gap-2">
                          <span className={`px-2.5 py-1 rounded-full text-[11px] border ${getStatusTone(cell.status)}`}>
                            {cell.status}
                          </span>
                          <span
                            className={`px-2.5 py-1 rounded-full text-[11px] border ${getEfficiencyTone(cell.efficiency.label)}`}
                          >
                            {cell.efficiency.label.replaceAll("_", " ")}
                          </span>
                        </div>
                        <h3 className="text-xl font-semibold text-white mt-4">{cell.name}</h3>
                        <div className="flex items-center gap-2 text-sm text-zinc-400 mt-2">
                          <Bot className="w-4 h-4 text-cyan-300" />
                          {cell.agentName}
                        </div>
                      </div>

                      <div className="w-12 h-12 rounded-3xl border border-white/10 bg-white/[0.04] text-zinc-300 flex items-center justify-center group-hover:text-cyan-200 group-hover:border-cyan-400/25 transition-colors shrink-0">
                        <ArrowRight className="w-5 h-5" />
                      </div>
                    </div>

                    <p className="text-sm text-zinc-300/90 mt-5 leading-relaxed">
                      {cell.objectiveSummary || cell.objective}
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
                      <div className="rounded-2xl border border-white/8 bg-black/25 p-4 space-y-3">
                        <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                          Signal Coverage
                        </div>
                        <CoverageRow
                          label="Gmail"
                          value={cell.signalCoverage.gmailConnected}
                          total={cell.signalCoverage.humans}
                          icon={<Mail className="w-3.5 h-3.5" />}
                        />
                        <CoverageRow
                          label="Calendar"
                          value={cell.signalCoverage.calendarConnected}
                          total={cell.signalCoverage.humans}
                          icon={<CalendarDays className="w-3.5 h-3.5" />}
                        />
                        <CoverageRow
                          label="Heartbeat"
                          value={cell.signalCoverage.heartbeatEnabled}
                          total={cell.signalCoverage.humans}
                          icon={<ShieldCheck className="w-3.5 h-3.5" />}
                        />
                        <CoverageRow
                          label="Health"
                          value={cell.signalCoverage.upreadyConnected}
                          total={cell.signalCoverage.humans}
                          icon={<HeartPulse className="w-3.5 h-3.5" />}
                        />
                      </div>

                      <div className="rounded-2xl border border-white/8 bg-black/25 p-4">
                        <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                          Performance Snapshot
                        </div>
                        <div className="grid grid-cols-2 gap-3 mt-4">
                          <div className="rounded-2xl bg-white/[0.03] border border-white/6 p-3">
                            <div className="text-xs text-zinc-500">Efficiency</div>
                            <div className="text-xl font-semibold text-white mt-1">{cell.efficiency.score}</div>
                          </div>
                          <div className="rounded-2xl bg-white/[0.03] border border-white/6 p-3">
                            <div className="text-xs text-zinc-500">Loop Risk</div>
                            <div className="text-xl font-semibold text-white mt-1">
                              {formatPercent(cell.efficiency.loopRisk * 100)}
                            </div>
                          </div>
                          <div className="rounded-2xl bg-white/[0.03] border border-white/6 p-3">
                            <div className="text-xs text-zinc-500">Outcomes</div>
                            <div className="text-xl font-semibold text-white mt-1">
                              {cell.activity.meaningfulOutcomes}
                            </div>
                          </div>
                          <div className="rounded-2xl bg-white/[0.03] border border-white/6 p-3">
                            <div className="text-xs text-zinc-500">Health</div>
                            <div className={`text-xl font-semibold mt-1 ${getHealthTone(cell.healthSignal.label)}`}>
                              {cell.healthSignal.avgLatestScore !== null
                                ? Math.round(cell.healthSignal.avgLatestScore)
                                : "n/a"}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/8 bg-black/25 p-4 mt-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                          Key Results
                        </div>
                        <div className="text-xs text-zinc-500">
                          Last activity {formatDate(cell.activity.lastActivityAt)}
                        </div>
                      </div>
                      <div className="space-y-3 mt-4">
                        {cell.keyResults.slice(0, 3).map((kr) => (
                          <div key={kr.id}>
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-sm text-zinc-200 truncate">{kr.label}</div>
                              <div className="text-xs text-zinc-500">
                                {kr.progressPercent !== null ? `${Math.round(kr.progressPercent)}%` : kr.status.replaceAll("_", " ")}
                              </div>
                            </div>
                            <div className="mt-2 h-2 rounded-full bg-white/[0.05] overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  kr.status === "on_track"
                                    ? "bg-emerald-400"
                                    : kr.status === "at_risk"
                                      ? "bg-amber-400"
                                      : kr.status === "off_track"
                                        ? "bg-rose-400"
                                        : "bg-zinc-600"
                                }`}
                                style={{ width: `${Math.max(8, kr.progressPercent ?? 8)}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/8 bg-black/25 p-4 mt-4">
                      <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Blockers</div>
                      <div className="flex flex-wrap gap-2 mt-4">
                        {cell.signalCoverage.staleMembers > 0 && (
                          <span className="px-2.5 py-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 text-[11px] text-amber-200">
                            {cell.signalCoverage.staleMembers} stale human{cell.signalCoverage.staleMembers === 1 ? "" : "s"}
                          </span>
                        )}
                        {cell.activity.pendingInboxActions > 0 && (
                          <span className="px-2.5 py-1.5 rounded-full border border-cyan-500/25 bg-cyan-500/10 text-[11px] text-cyan-200">
                            {cell.activity.pendingInboxActions} pending inbox action{cell.activity.pendingInboxActions === 1 ? "" : "s"}
                          </span>
                        )}
                        {cell.activity.errorRate !== null && cell.activity.errorRate > 0 && (
                          <span className="px-2.5 py-1.5 rounded-full border border-rose-500/25 bg-rose-500/10 text-[11px] text-rose-200">
                            {formatPercent(cell.activity.errorRate * 100)} error rate
                          </span>
                        )}
                        {cell.signalCoverage.staleMembers === 0 &&
                          cell.activity.pendingInboxActions === 0 &&
                          (!cell.activity.errorRate || cell.activity.errorRate <= 0) && (
                            <span className="px-2.5 py-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 text-[11px] text-emerald-200">
                              No obvious blockers
                            </span>
                          )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-4 mt-5 text-sm">
                      <div className="flex items-center gap-2 text-zinc-400">
                        <Activity className="w-4 h-4 text-cyan-300" />
                        {cell.activity.userCommands} commands · {cell.activity.assistantTurns} assistant turns
                      </div>
                      <div className="text-zinc-500 group-hover:text-zinc-300 transition-colors">
                        Open Cell
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <CellCreateModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        agents={agentOptions}
        members={workspaceMembers}
        onCreated={(cellId) => {
          setShowCreate(false);
          router.push(`/dashboard/cells/${cellId}`);
        }}
      />
    </>
  );
}
