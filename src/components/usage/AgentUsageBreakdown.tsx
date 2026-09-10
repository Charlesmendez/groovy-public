"use client";

/**
 * AgentUsageBreakdown — estimated API value, charges, and outcomes grouped by agent, with the
 * "Analyze & optimize" entry point (opens the harness dashboard with a canned
 * orchestrator prompt driven by the usage_report tool).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bot, Loader2, Sparkles } from "lucide-react";

type AgentUsageEntry = {
  agentId: string | null;
  agentName: string;
  harness: string | null;
  totalTokens: number;
  costUsd: number;
  chargedUsd: number;
  events: number;
  derivedCostEvents?: number;
  unmeteredEvents?: number;
  noChargeEvents?: number;
  billableEvents?: number;
  models: Record<string, { totalTokens: number; costUsd: number; events: number }>;
  tasks: { done: number; failed: number; canceled: number; open: number };
};

type AgentUsageReport = {
  days: number;
  since: string;
  until: string;
  totalCostUsd: number;
  totalChargedUsd: number;
  totalTokens: number;
  agents: AgentUsageEntry[];
};

function formatUsd(value: number): string {
  return value >= 100 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

const HARNESS_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  orchestrator: "Orchestrator",
  heartbeat: "Heartbeat",
  utility: "System",
};

export function AgentUsageBreakdown({
  days = 30,
  from,
  to,
  teamMemberId,
}: {
  days?: number;
  from?: string;
  to?: string;
  teamMemberId?: string | null;
}) {
  const [report, setReport] = useState<AgentUsageReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ days: String(days) });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (teamMemberId) params.set("teamMemberId", teamMemberId);
    fetch(`/api/billing/usage/by-agent?${params}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled && json && Array.isArray(json.agents)) setReport(json);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, from, to, teamMemberId]);

  const hasEstimatedValue = (report?.agents || []).some((agent) => agent.costUsd > 0);
  const maxBarValue = Math.max(
    1,
    ...(report?.agents || []).map((agent) =>
      hasEstimatedValue ? agent.costUsd : agent.totalTokens,
    ),
  );

  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/40 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div>
          <h3 className="text-sm font-semibold text-white">By agent</h3>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Selected period · estimated API value, charges &amp; task outcomes
          </p>
        </div>
        <Link
          href="/dashboard?ask=optimize-costs"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-400/10 border border-cyan-400/20 text-cyan-300 hover:bg-cyan-400/20 text-xs font-medium transition-colors"
          title="Ask the orchestrator to analyze your usage and recommend cheaper model mixes"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Analyze &amp; optimize
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 text-zinc-600 animate-spin" />
        </div>
      ) : !report || report.agents.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-zinc-600">
          No attributed usage yet — activity appears here as your agents work.
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {report.agents.map((agent) => {
            const successRate =
              agent.tasks.done + agent.tasks.failed > 0
                ? Math.round(
                    (agent.tasks.done / (agent.tasks.done + agent.tasks.failed)) * 100
                  )
                : null;
            const topModels = Object.entries(agent.models)
              .filter(([, usage]) => usage.totalTokens > 0)
              .sort(
                (a, b) =>
                  b[1].totalTokens - a[1].totalTokens ||
                  b[1].costUsd - a[1].costUsd,
              )
              .slice(0, 2);
            const unmeteredEvents = agent.unmeteredEvents || 0;
            const barValue = hasEstimatedValue ? agent.costUsd : agent.totalTokens;
            return (
              <div
                key={`${agent.agentId || agent.agentName}:${agent.harness || "none"}`}
                className="px-4 py-3"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                    <Bot className="w-3.5 h-3.5 text-zinc-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm text-white font-medium truncate">
                        {agent.agentName}
                      </span>
                      {agent.harness && (
                        <span className="text-[10px] text-zinc-500">
                          {HARNESS_LABELS[agent.harness] || agent.harness}
                        </span>
                      )}
                      {successRate !== null && (
                        <span
                          className={`text-[10px] ${
                            successRate >= 80 ? "text-emerald-400" : "text-amber-300"
                          }`}
                        >
                          {successRate}% success
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-zinc-600 mt-0.5">
                      {formatTokens(agent.totalTokens)} tokens · {agent.events} calls
                      {unmeteredEvents > 0 && ` · ${unmeteredEvents} unmetered`}
                      {topModels.length > 0 &&
                        ` · ${topModels.map(([model]) => model).join(", ")}`}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm text-white font-semibold">
                      {agent.costUsd > 0
                        ? formatUsd(agent.costUsd)
                        : agent.totalTokens > 0
                          ? "Value unavailable"
                          : "Unmetered"}
                    </div>
                    {agent.costUsd > 0 && (
                      <div className="text-[10px] text-zinc-500">estimated API value</div>
                    )}
                    {agent.chargedUsd > 0 ? (
                      <div className="text-[10px] text-zinc-500">
                        {formatUsd(agent.chargedUsd)} charged
                      </div>
                    ) : agent.totalTokens > 0 && (agent.noChargeEvents || 0) > 0 ? (
                      <div className="text-[10px] text-emerald-400/80">
                        $0 charged · included
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 h-1 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-400/70 to-violet-400/70"
                    style={{
                      width: `${barValue > 0 ? Math.max(2, (barValue / maxBarValue) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
