/**
 * Per-agent usage aggregation for the usage dashboard and the orchestrator's
 * read-only `usage_report` tool (the cost optimizer's data source).
 *
 * Joins billing_usage_events (agent_id/harness attribution) with agent names
 * and agent_tasks outcomes so recommendations can weigh cost against results.
 */

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";
import { resolveProviderCostUsd } from "@/lib/billing/usageCost";

export type AgentUsageEntry = {
  agentId: string | null;
  agentName: string;
  harness: string | null;
  models: Record<string, { totalTokens: number; costUsd: number; events: number }>;
  totalTokens: number;
  /** API-equivalent model value, including usage that Groovy did not charge for. */
  costUsd: number;
  /** Amount actually charged by Groovy. */
  chargedUsd: number;
  events: number;
  derivedCostEvents: number;
  unmeteredEvents: number;
  noChargeEvents: number;
  billableEvents: number;
  tasks: { done: number; failed: number; canceled: number; open: number };
};

export type AgentUsageReport = {
  days: number;
  since: string;
  until: string;
  totalCostUsd: number;
  totalChargedUsd: number;
  totalTokens: number;
  agents: AgentUsageEntry[];
};

function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export async function buildAgentUsageReport(args: {
  userId: string;
  workspaceId?: string;
  teamMemberId?: string | null;
  from?: string;
  to?: string;
  days?: number;
}): Promise<AgentUsageReport> {
  const admin = createSupabaseAdminClient();
  const days = Math.min(Math.max(1, Math.trunc(args.days || 30)), 365);
  const parsedUntil = args.to ? new Date(args.to) : new Date();
  const untilDate = Number.isFinite(parsedUntil.getTime()) ? parsedUntil : new Date();
  const parsedSince = args.from ? new Date(args.from) : null;
  const sinceDate =
    parsedSince && Number.isFinite(parsedSince.getTime())
      ? parsedSince
      : new Date(untilDate.getTime() - days * 24 * 60 * 60 * 1000);
  const since = sinceDate.toISOString();
  const until = untilDate.toISOString();

  const membership = args.workspaceId
    ? null
    : await getWorkspaceMembershipForUser({ userId: args.userId, admin });
  const workspaceId = args.workspaceId || membership?.workspace_id || null;
  if (!workspaceId) {
    return {
      days,
      since,
      until,
      totalCostUsd: 0,
      totalChargedUsd: 0,
      totalTokens: 0,
      agents: [],
    };
  }

  let eventsQuery = admin
    .from("billing_usage_events")
    .select("agent_id, harness, model, source, input_tokens, output_tokens, total_tokens, model_cost_usd, total_charge_usd, billable, charge_type, meta")
    .eq("workspace_id", workspaceId)
    .gte("created_at", since)
    .lte("created_at", until);
  if (args.teamMemberId) {
    eventsQuery = eventsQuery.eq("user_id", args.teamMemberId);
  }
  const { data: events, error: eventsError } = await eventsQuery.limit(20000);
  if (eventsError) throw new Error(eventsError.message);

  const agentIds = Array.from(
    new Set(
      (events || [])
        .map((event) => String(event.agent_id || ""))
        .filter(Boolean),
    ),
  );
  const [{ data: agents, error: agentsError }, { data: tasks, error: tasksError }] =
    await Promise.all([
      agentIds.length > 0
        ? admin.from("agents").select("id, name, type").in("id", agentIds)
        : Promise.resolve({ data: [], error: null }),
      agentIds.length > 0 && !args.teamMemberId
        ? admin
            .from("agent_tasks")
            .select("agent_id, status")
            .in("agent_id", agentIds)
            .gte("created_at", since)
            .lte("created_at", until)
            .limit(5000)
        : Promise.resolve({ data: [], error: null }),
    ]);
  if (agentsError) throw new Error(agentsError.message);
  if (tasksError) throw new Error(tasksError.message);

  const agentNameById = new Map<string, { name: string; type: string }>();
  for (const agent of agents || []) {
    const a = agent as { id: string; name: string; type: string };
    agentNameById.set(a.id, { name: a.name, type: a.type });
  }

  const entries = new Map<string, AgentUsageEntry>();
  const virtualAttributionForSource = (source: string | null) => {
    if (
      source?.startsWith("orchestrator") ||
      source === "durable_context_checkpoint"
    ) {
      return {
        key: "__orchestrator__",
        name: "Orchestrator",
        harness: "orchestrator",
      };
    }
    if (source?.startsWith("heartbeat")) {
      return {
        key: "__heartbeat__",
        name: "Heartbeat",
        harness: "heartbeat",
      };
    }
    if (source === "compaction") {
      return {
        key: "__system_utilities__",
        name: "System utilities",
        harness: "utility",
      };
    }
    const normalizedSource = String(source || "unknown").trim();
    return {
      key: `__source__:${normalizedSource}`,
      name: normalizedSource
        .split("_")
        .filter(Boolean)
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join(" ") || "Unattributed",
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
        chargedUsd: 0,
        events: 0,
        derivedCostEvents: 0,
        unmeteredEvents: 0,
        noChargeEvents: 0,
        billableEvents: 0,
        tasks: { done: 0, failed: 0, canceled: 0, open: 0 },
      };
      entries.set(key, entry);
    }
    if (!entry.harness && harness) entry.harness = harness;
    return entry;
  };

  let totalCostUsd = 0;
  let totalChargedUsd = 0;
  let totalTokens = 0;
  for (const event of events || []) {
    const e = event as {
      agent_id: string | null;
      harness: string | null;
      model: string | null;
      source: string | null;
      input_tokens: unknown;
      output_tokens: unknown;
      total_tokens: unknown;
      model_cost_usd: unknown;
      total_charge_usd: unknown;
      billable: boolean | null;
      charge_type: string | null;
      meta: Record<string, unknown> | null;
    };
    const entry = ensureEntry(e.agent_id, e.harness, e.source);
    const tokens = asNumber(e.total_tokens);
    const providerCost = resolveProviderCostUsd({
      model: e.model,
      inputTokens: e.input_tokens,
      outputTokens: e.output_tokens,
      totalTokens: e.total_tokens,
      storedModelCostUsd: e.model_cost_usd,
      meta: e.meta,
    });
    const chargedUsd = asNumber(e.total_charge_usd);
    const modelKey = e.model || "unknown";
    const model = (entry.models[modelKey] ||= { totalTokens: 0, costUsd: 0, events: 0 });
    model.totalTokens += tokens;
    model.costUsd += providerCost.costUsd;
    model.events += 1;
    entry.totalTokens += tokens;
    entry.costUsd += providerCost.costUsd;
    entry.chargedUsd += chargedUsd;
    entry.events += 1;
    if (providerCost.derived) entry.derivedCostEvents += 1;
    if (tokens <= 0) entry.unmeteredEvents += 1;
    if (e.billable === false || e.charge_type === "no_charge") {
      entry.noChargeEvents += 1;
    } else {
      entry.billableEvents += 1;
    }
    totalTokens += tokens;
    totalCostUsd += providerCost.costUsd;
    totalChargedUsd += chargedUsd;
  }

  for (const task of tasks || []) {
    const t = task as { agent_id: string; status: string };
    const entry = ensureEntry(t.agent_id, null);
    if (t.status === "done") entry.tasks.done += 1;
    else if (t.status === "failed") entry.tasks.failed += 1;
    else if (t.status === "canceled") entry.tasks.canceled += 1;
    else entry.tasks.open += 1;
  }

  const list = Array.from(entries.values()).sort(
    (a, b) =>
      b.totalTokens - a.totalTokens ||
      b.costUsd - a.costUsd ||
      b.events - a.events,
  );
  return {
    days: Math.max(
      1,
      Math.ceil((untilDate.getTime() - sinceDate.getTime()) / (24 * 60 * 60 * 1000)),
    ),
    since,
    until,
    totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
    totalChargedUsd: Math.round(totalChargedUsd * 10000) / 10000,
    totalTokens,
    agents: list,
  };
}
