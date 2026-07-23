/**
 * Per-agent usage aggregation for the usage dashboard and the orchestrator's
 * read-only `usage_report` tool (the cost optimizer's data source).
 *
 * Joins billing_usage_events (agent_id/harness attribution) with agent names
 * and agent_tasks outcomes so recommendations can weigh cost against results.
 */

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type AgentUsageEntry = {
  agentId: string | null;
  agentName: string;
  harness: string | null;
  models: Record<string, { totalTokens: number; costUsd: number; events: number }>;
  totalTokens: number;
  costUsd: number;
  events: number;
  tasks: { done: number; failed: number; canceled: number; open: number };
};

export type AgentUsageReport = {
  days: number;
  since: string;
  totalCostUsd: number;
  totalTokens: number;
  agents: AgentUsageEntry[];
};

function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export async function buildAgentUsageReport(args: {
  userId: string;
  days?: number;
}): Promise<AgentUsageReport> {
  const admin = createSupabaseAdminClient();
  const days = Math.min(Math.max(1, Math.trunc(args.days || 30)), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: events }, { data: agents }, { data: tasks }] = await Promise.all([
    admin
      .from("billing_usage_events")
      .select("agent_id, harness, model, source, total_tokens, model_cost_usd, total_charge_usd")
      .eq("user_id", args.userId)
      .gte("created_at", since)
      .limit(20000),
    admin.from("agents").select("id, name, type").eq("user_id", args.userId),
    admin
      .from("agent_tasks")
      .select("agent_id, status")
      .eq("user_id", args.userId)
      .gte("created_at", since)
      .limit(5000),
  ]);

  const agentNameById = new Map<string, { name: string; type: string }>();
  for (const agent of agents || []) {
    const a = agent as { id: string; name: string; type: string };
    agentNameById.set(a.id, { name: a.name, type: a.type });
  }

  const entries = new Map<string, AgentUsageEntry>();
  const virtualAttributionForSource = (source: string | null) => {
    if (source?.startsWith("orchestrator")) {
      return {
        key: "__orchestrator__",
        name: "Orchestrator",
        harness: "orchestrator",
      };
    }
    if (source === "compaction") {
      return {
        key: "__system_utilities__",
        name: "System utilities",
        harness: "utility",
      };
    }
    return {
      key: "__unattributed__",
      name: "Unattributed",
      harness: null,
    };
  };
  const ensureEntry = (
    agentId: string | null,
    harness: string | null,
    source: string | null = null
  ): AgentUsageEntry => {
    const virtual = agentId ? null : virtualAttributionForSource(source);
    const key = agentId || virtual?.key || "__unattributed__";
    let entry = entries.get(key);
    if (!entry) {
      const meta = agentId ? agentNameById.get(agentId) : null;
      entry = {
        agentId,
        agentName: meta
          ? meta.type === "orchestrator-runtime"
            ? "Orchestrator"
            : meta.name
          : agentId
            ? "Deleted agent"
            : virtual?.name || "Unattributed",
        harness: harness || virtual?.harness || null,
        models: {},
        totalTokens: 0,
        costUsd: 0,
        events: 0,
        tasks: { done: 0, failed: 0, canceled: 0, open: 0 },
      };
      entries.set(key, entry);
    }
    if (!entry.harness && harness) entry.harness = harness;
    return entry;
  };

  let totalCostUsd = 0;
  let totalTokens = 0;
  for (const event of events || []) {
    const e = event as {
      agent_id: string | null;
      harness: string | null;
      model: string | null;
      source: string | null;
      total_tokens: unknown;
      model_cost_usd: unknown;
      total_charge_usd: unknown;
    };
    const entry = ensureEntry(e.agent_id, e.harness, e.source);
    const tokens = asNumber(e.total_tokens);
    const cost = asNumber(e.total_charge_usd) || asNumber(e.model_cost_usd);
    const modelKey = e.model || "unknown";
    const model = (entry.models[modelKey] ||= { totalTokens: 0, costUsd: 0, events: 0 });
    model.totalTokens += tokens;
    model.costUsd += cost;
    model.events += 1;
    entry.totalTokens += tokens;
    entry.costUsd += cost;
    entry.events += 1;
    totalTokens += tokens;
    totalCostUsd += cost;
  }

  for (const task of tasks || []) {
    const t = task as { agent_id: string; status: string };
    const entry = ensureEntry(t.agent_id, null);
    if (t.status === "done") entry.tasks.done += 1;
    else if (t.status === "failed") entry.tasks.failed += 1;
    else if (t.status === "canceled") entry.tasks.canceled += 1;
    else entry.tasks.open += 1;
  }

  const list = Array.from(entries.values()).sort((a, b) => b.costUsd - a.costUsd);
  return {
    days,
    since,
    totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
    totalTokens,
    agents: list,
  };
}
