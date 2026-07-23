import { NextResponse } from "next/server";
import { estimateTokensFromCostUsd } from "@/lib/billing/usage";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UsageRow = {
  id: string;
  user_id: string | null;
  created_at: string;
  source: string;
  provider: string | null;
  model: string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  total_tokens: number | string | null;
  billable: boolean | null;
  charge_type: "groovy_key" | "external_key_fee" | "no_charge" | null;
  model_cost_usd: number | string | null;
  groovy_fee_usd: number | string | null;
  total_charge_usd: number | string | null;
  estimated: boolean;
  meta: Record<string, unknown> | null;
};

type ToolRow = {
  id: string;
  user_id: string | null;
  created_at: string;
  tool_name: string;
  agent: string | null;
};

type WorkspaceMemberRow = {
  user_id: string;
  role: "admin" | "member" | "guest";
  created_at: string | null;
};

type TeamMember = {
  userId: string;
  label: string;
  email: string | null;
  role: "admin" | "member" | "guest";
  isCurrentUser: boolean;
};

function parseIsoDateParam(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function utcHourKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}:00:00.000Z`;
}

function utcDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}T00:00:00.000Z`;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const n = finiteNumber(value);
  return typeof n === "number" && n >= 0 ? n : null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = finiteNumber(value);
    if (typeof n === "number") return n;
  }
  return null;
}

type DisplayTokenUsage = {
  input: number;
  output: number;
  total: number;
  estimated: boolean;
};

type CacheTokenBreakdown = {
  noCacheInputTokens: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number | null;
};

function hasMeteredUsage(usage: DisplayTokenUsage): boolean {
  return usage.total > 0 || usage.input > 0 || usage.output > 0;
}

function inferredModelForEvent(event: UsageRow): string | null {
  if (event.model?.trim()) return event.model.trim();

  const metaModel =
    (typeof event.meta?.modelForEstimation === "string" && event.meta.modelForEstimation.trim()) ||
    (typeof event.meta?.model === "string" && event.meta.model.trim()) ||
    (typeof event.meta?.model_name === "string" && event.meta.model_name.trim()) ||
    "";
  if (metaModel) return metaModel;

  const codeCliProvider = typeof event.meta?.codeCliProvider === "string" ? event.meta.codeCliProvider : "";
  const authMethod = typeof event.meta?.authMethod === "string" ? event.meta.authMethod : "";
  if (
    event.provider === "openai" ||
    codeCliProvider === "codex" ||
    authMethod === "local_codex_login"
  ) {
    return "gpt-5.5";
  }
  if (
    event.provider === "anthropic" ||
    codeCliProvider === "claude" ||
    event.source === "code_agent_cli" ||
    event.source === "connector_code_cli" ||
    event.source === "connector_browser_task"
  ) {
    return "claude-opus-4-7";
  }
  return null;
}

function getCacheTokenBreakdown(meta: Record<string, unknown> | null): CacheTokenBreakdown | null {
  if (!meta) return null;
  const cacheReadTokens =
    nonNegativeNumber(meta.cacheReadInputTokens) ??
    nonNegativeNumber(meta.cache_read_input_tokens) ??
    nonNegativeNumber(meta.cacheReadTokens) ??
    0;
  const cacheWriteTokens =
    nonNegativeNumber(meta.cacheWriteInputTokens) ??
    nonNegativeNumber(meta.cache_creation_input_tokens) ??
    nonNegativeNumber(meta.cacheWriteTokens) ??
    0;

  if (cacheReadTokens <= 0 && cacheWriteTokens <= 0) return null;

  const noCacheInputTokens =
    nonNegativeNumber(meta.noCacheInputTokens) ??
    nonNegativeNumber(meta.no_cache_input_tokens) ??
    null;
  const inputTokens =
    typeof noCacheInputTokens === "number"
      ? noCacheInputTokens + cacheReadTokens + cacheWriteTokens
      : null;

  return {
    noCacheInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens,
  };
}

function getDisplayTokenUsage(event: UsageRow): DisplayTokenUsage {
  const explicitInput = nonNegativeNumber(event.input_tokens);
  const explicitOutput = nonNegativeNumber(event.output_tokens);
  const explicitTotal =
    nonNegativeNumber(event.total_tokens) ??
    (typeof explicitInput === "number" && typeof explicitOutput === "number"
      ? explicitInput + explicitOutput
      : null);
  // Historical code-agent rows may have stored top-level input_tokens as only
  // non-cached input, while cache token counts live in meta. Rebuild the real
  // input total for display so cache hits cannot exceed total usage.
  const cacheBreakdown = getCacheTokenBreakdown(event.meta);
  const cacheAwareInput =
    typeof cacheBreakdown?.inputTokens === "number"
      ? Math.max(explicitInput || 0, cacheBreakdown.inputTokens)
      : null;
  const effectiveInput =
    typeof cacheAwareInput === "number" ? cacheAwareInput : explicitInput;
  const inferredOutputFromTotal =
    typeof explicitTotal === "number" && typeof explicitInput === "number"
      ? Math.max(0, explicitTotal - explicitInput)
      : null;
  const effectiveOutput = explicitOutput ?? inferredOutputFromTotal;
  const cacheAwareTotal =
    typeof cacheAwareInput === "number"
      ? cacheAwareInput + (effectiveOutput || 0)
      : null;
  const effectiveTotal =
    typeof cacheAwareTotal === "number"
      ? Math.max(explicitTotal || 0, cacheAwareTotal)
      : explicitTotal;

  if (typeof effectiveTotal === "number" && effectiveTotal > 0) {
    return {
      input: effectiveInput || 0,
      output: effectiveOutput || 0,
      total: effectiveTotal,
      estimated: false,
    };
  }

  const modelCostUsd = firstFiniteNumber(
    event.model_cost_usd,
    event.meta?.upstreamCostUsd,
    event.meta?.totalCostUsd,
    event.meta?.total_cost_usd,
    event.meta?.costUsd,
    event.meta?.cost_usd,
    event.meta?.modelCostUsd,
    event.meta?.model_cost_usd
  );
  if (typeof modelCostUsd === "number" && modelCostUsd > 0) {
    const estimationModel = inferredModelForEvent(event) || "claude-opus-4-7";
    const estimated = estimateTokensFromCostUsd({
      totalCostUsd: modelCostUsd,
      model: estimationModel,
      outputRatio: 0.25,
    });
    if (estimated) {
      return {
        input: estimated.inputTokens,
        output: estimated.outputTokens,
        total: estimated.totalTokens,
        estimated: true,
      };
    }
  }

  return {
    input: effectiveInput || 0,
    output: effectiveOutput || 0,
    total: effectiveTotal || 0,
    estimated: false,
  };
}

function safeUserLabel(args: {
  userId: string;
  role: string;
  email?: string | null;
  name?: string | null;
  isCurrentUser?: boolean;
}): string {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (name) return name;
  const email = typeof args.email === "string" ? args.email.trim() : "";
  if (email) return email;
  if (args.isCurrentUser) return "You";
  const prefix = args.role === "admin" ? "Admin" : "Member";
  return `${prefix} ${args.userId.slice(0, 8)}`;
}

function userMetadataName(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  const candidates = [m.full_name, m.name, m.display_name, m.preferred_name];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function loadAuthUserInfoMap(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userIds: string[]
): Promise<Map<string, { email: string | null; name: string | null }>> {
  const wanted = new Set(userIds.filter(Boolean));
  const found = new Map<string, { email: string | null; name: string | null }>();
  if (wanted.size === 0) return found;

  const ids = Array.from(wanted);
  const chunkSize = 8;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const results = await Promise.allSettled(
      chunk.map(async (id) => {
        const { data, error } = await admin.auth.admin.getUserById(id);
        if (error || !data?.user) return null;
        return {
          id,
          email: data.user.email || null,
          name: userMetadataName(data.user.user_metadata),
        };
      })
    );
    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value) continue;
      found.set(result.value.id, {
        email: result.value.email,
        name: result.value.name,
      });
    }
  }

  return found;
}

export async function GET(req: Request) {
  // Auth: require logged-in user who is a workspace admin
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();

  // Resolve workspace + admin check
  const { data: membership, error: mErr } = await admin
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (mErr || !membership) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }
  if (membership.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const workspaceId: string = membership.workspace_id;

  // Parse date range from query
  const url = new URL(req.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const teamMemberIdParam = (url.searchParams.get("teamMemberId") || "").trim();
  const parsedFrom = parseIsoDateParam(fromParam);
  const parsedTo = parseIsoDateParam(toParam);

  if (fromParam && !parsedFrom) {
    return NextResponse.json({ error: "Invalid 'from' date" }, { status: 400 });
  }
  if (toParam && !parsedTo) {
    return NextResponse.json({ error: "Invalid 'to' date" }, { status: 400 });
  }

  const now = new Date();
  const defaultFrom = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
  );
  const fromDate = parsedFrom || defaultFrom;
  const toDate = parsedTo || now;

  if (fromDate.getTime() > toDate.getTime()) {
    return NextResponse.json({ error: "'from' must be before or equal to 'to'" }, { status: 400 });
  }

  // Clamp to reasonable range (max 90 days)
  const maxRange = 90 * 24 * 60 * 60 * 1000;
  const clampedFrom = new Date(Math.max(fromDate.getTime(), toDate.getTime() - maxRange));

  const fromIso = clampedFrom.toISOString();
  const toIso = toDate.toISOString();

  const { data: memberRowsRaw, error: memberRowsErr } = await admin
    .from("workspace_members")
    .select("user_id, role, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (memberRowsErr) {
    return NextResponse.json({ error: memberRowsErr.message }, { status: 500 });
  }
  const memberRows = (memberRowsRaw || []) as WorkspaceMemberRow[];
  const memberIds = memberRows.map((m) => String(m.user_id || "")).filter(Boolean);
  const memberIdSet = new Set(memberIds);
  const selectedTeamMemberId =
    teamMemberIdParam && teamMemberIdParam !== "all" ? teamMemberIdParam : null;
  if (selectedTeamMemberId && !memberIdSet.has(selectedTeamMemberId)) {
    return NextResponse.json({ error: "Team member is not in this workspace" }, { status: 400 });
  }

  const authInfoByUserId = await loadAuthUserInfoMap(admin, memberIds);
  const teamMembers: TeamMember[] = memberRows
    .map((m) => {
      const userId = String(m.user_id || "");
      const authInfo = authInfoByUserId.get(userId) || null;
      const role: TeamMember["role"] =
        m.role === "admin" ? "admin" : m.role === "guest" ? "guest" : "member";
      const isCurrentUser = userId === user.id;
      return {
        userId,
        email: authInfo?.email || null,
        role,
        isCurrentUser,
        label: safeUserLabel({
          userId,
          role,
          email: authInfo?.email || null,
          name: authInfo?.name || null,
          isCurrentUser,
        }),
      };
    })
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

  const PAGE_SIZE = 1000;
  const MAX_ROWS = 200_000;

  // 1) Usage events in range (paged to avoid silent truncation at 10k rows)
  const events: UsageRow[] = [];
  let usageOffset = 0;
  let usageTruncated = false;
  while (true) {
    let usageQuery = admin
      .from("billing_usage_events")
      .select(
        "id, user_id, created_at, source, provider, model, input_tokens, output_tokens, total_tokens, billable, charge_type, model_cost_usd, groovy_fee_usd, total_charge_usd, estimated, meta"
      )
      .eq("workspace_id", workspaceId)
      .gte("created_at", fromIso)
      .lte("created_at", toIso);
    if (selectedTeamMemberId) {
      usageQuery = usageQuery.eq("user_id", selectedTeamMemberId);
    }
    const { data: usageRows, error: usageErr } = await usageQuery
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(usageOffset, usageOffset + PAGE_SIZE - 1);

    if (usageErr) {
      return NextResponse.json({ error: usageErr.message }, { status: 500 });
    }

    const batch = (usageRows || []) as UsageRow[];
    if (batch.length === 0) break;

    const remaining = MAX_ROWS - events.length;
    if (remaining <= 0) {
      usageTruncated = true;
      break;
    }
    if (batch.length > remaining) {
      events.push(...batch.slice(0, remaining));
      usageTruncated = true;
      break;
    }

    events.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    usageOffset += PAGE_SIZE;
  }

  // 2) Tool events in range (paged)
  const toolEvents: ToolRow[] = [];
  let toolOffset = 0;
  let toolTruncated = false;
  while (true) {
    let toolQuery = admin
      .from("billing_tool_events")
      .select("id, user_id, created_at, tool_name, agent")
      .eq("workspace_id", workspaceId)
      .gte("created_at", fromIso)
      .lte("created_at", toIso);
    if (selectedTeamMemberId) {
      toolQuery = toolQuery.eq("user_id", selectedTeamMemberId);
    }
    const { data: toolRows, error: toolErr } = await toolQuery
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(toolOffset, toolOffset + PAGE_SIZE - 1);

    if (toolErr) {
      return NextResponse.json({ error: toolErr.message }, { status: 500 });
    }

    const batch = (toolRows || []) as ToolRow[];
    if (batch.length === 0) break;

    const remaining = MAX_ROWS - toolEvents.length;
    if (remaining <= 0) {
      toolTruncated = true;
      break;
    }
    if (batch.length > remaining) {
      toolEvents.push(...batch.slice(0, remaining));
      toolTruncated = true;
      break;
    }

    toolEvents.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    toolOffset += PAGE_SIZE;
  }

  // Aggregate summary
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let meteredLlmCalls = 0;
  let unmeteredLlmCalls = 0;
  let billableTokens = 0;
  let nonBillableTokens = 0;
  let groovyKeyTokens = 0;
  let externalKeyTokens = 0;
  let noChargeTokens = 0;
  let estimatedCount = 0;
  let modelCostUsdTotal = 0;
  let groovyFeeUsdTotal = 0;
  let totalChargeUsdTotal = 0;
  let groovyKeyChargeUsdTotal = 0;
  let externalKeyCostBasisUsdTotal = 0;
  let externalKeyFeeUsdTotal = 0;
  let externalKeyChargeUsdTotal = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheSavingsUsd = 0;

  // Model pricing lookup (mirrors pricing.ts PRICING_ALIASES)
  const CACHE_PRICING: Array<{ match: RegExp; input: number; cacheRead: number; cacheWrite: number }> = [
    { match: /^claude-opus-4[.-][67]/i, input: 5, cacheRead: 0.5, cacheWrite: 6.25 },
    { match: /^claude-sonnet-4[.-][56]/i, input: 3, cacheRead: 0.3, cacheWrite: 3.75 },
    { match: /^claude-haiku-4[.-]5/i, input: 0.8, cacheRead: 0.08, cacheWrite: 1 },
    { match: /^gpt-5\.5-pro/i, input: 30, cacheRead: 30, cacheWrite: 30 },
    { match: /^gpt-5\.5/i, input: 5, cacheRead: 0.5, cacheWrite: 5 },
    { match: /^gpt-5\.4/i, input: 2.5, cacheRead: 0.25, cacheWrite: 2.5 },
  ];
  function getCachePricing(model: string | null) {
    const m = model?.trim() || "";
    for (const p of CACHE_PRICING) {
      if (p.match.test(m)) return p;
    }
    return CACHE_PRICING[0]; // fallback to Opus (matches billing policy)
  }

  const displayUsageByEventId = new Map<string, DisplayTokenUsage>();
  const displayUsageFor = (event: UsageRow): DisplayTokenUsage => {
    const cached = displayUsageByEventId.get(event.id);
    if (cached) return cached;
    const usage = getDisplayTokenUsage(event);
    displayUsageByEventId.set(event.id, usage);
    return usage;
  };

  for (const e of events) {
    const usage = displayUsageFor(e);
    const input = usage.input;
    const output = usage.output;
    const total = usage.total;
    if (hasMeteredUsage(usage)) {
      meteredLlmCalls++;
    } else {
      unmeteredLlmCalls++;
    }
    totalInputTokens += input;
    totalOutputTokens += output;
    totalTokens += total;
    const chargeType =
      e.charge_type === "external_key_fee" ||
      e.charge_type === "no_charge" ||
      e.charge_type === "groovy_key"
        ? e.charge_type
        : e.billable === false
          ? "no_charge"
          : "groovy_key";
    if (chargeType === "no_charge") {
      nonBillableTokens += total;
      noChargeTokens += total;
    } else {
      billableTokens += total;
      if (chargeType === "external_key_fee") {
        externalKeyTokens += total;
      } else {
        groovyKeyTokens += total;
      }
    }
    if (e.estimated || usage.estimated) estimatedCount++;
    const modelCostUsd = finiteNumber(e.model_cost_usd) || 0;
    const groovyFeeUsd = finiteNumber(e.groovy_fee_usd) || 0;
    const totalChargeUsd = finiteNumber(e.total_charge_usd) || 0;
    modelCostUsdTotal += modelCostUsd;
    groovyFeeUsdTotal += groovyFeeUsd;
    totalChargeUsdTotal += totalChargeUsd;
    if (chargeType === "external_key_fee") {
      externalKeyCostBasisUsdTotal += modelCostUsd;
      externalKeyFeeUsdTotal += groovyFeeUsd;
      externalKeyChargeUsdTotal += totalChargeUsd;
    } else if (chargeType === "groovy_key") {
      groovyKeyChargeUsdTotal += totalChargeUsd;
    }
    // Aggregate prompt-cache token counts and per-model savings from meta
    const cacheBreakdown = getCacheTokenBreakdown(e.meta);
    if (cacheBreakdown) {
      const readTk = cacheBreakdown.cacheReadTokens;
      const writeTk = cacheBreakdown.cacheWriteTokens;
      cacheReadTokens += readTk;
      cacheWriteTokens += writeTk;
      if (readTk > 0 || writeTk > 0) {
        const p = getCachePricing(inferredModelForEvent(e));
        // Savings = what it would cost at full input price minus actual cache price
        cacheSavingsUsd += (readTk * (p.input - p.cacheRead) - writeTk * (p.cacheWrite - p.input)) / 1_000_000;
      }
    }
  }

  // Determine granularity: if range <= 2 days → hourly, else daily
  const rangeMs = toDate.getTime() - clampedFrom.getTime();
  const granularity = rangeMs <= 2 * 24 * 60 * 60 * 1000 ? "hour" : "day";

  // Build time-series buckets
  function bucketKey(dateStr: string): string {
    const d = new Date(dateStr);
    return granularity === "hour" ? utcHourKey(d) : utcDayKey(d);
  }

  const timeSeriesMap = new Map<string, { tokens: number; input: number; output: number; calls: number }>();

  // Initialize empty buckets across the range
  const cursor = new Date(clampedFrom);
  if (granularity === "hour") {
    cursor.setUTCMinutes(0, 0, 0);
  } else {
    cursor.setUTCHours(0, 0, 0, 0);
  }
  while (cursor <= toDate) {
    const key = bucketKey(cursor.toISOString());
    if (!timeSeriesMap.has(key)) {
      timeSeriesMap.set(key, { tokens: 0, input: 0, output: 0, calls: 0 });
    }
    if (granularity === "hour") {
      cursor.setUTCHours(cursor.getUTCHours() + 1);
    } else {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  for (const e of events) {
    const key = bucketKey(e.created_at);
    const bucket = timeSeriesMap.get(key) || { tokens: 0, input: 0, output: 0, calls: 0 };
    const usage = displayUsageFor(e);
    const input = usage.input;
    const output = usage.output;
    const total = usage.total;
    bucket.tokens += total;
    bucket.input += input;
    bucket.output += output;
    bucket.calls += 1;
    timeSeriesMap.set(key, bucket);
  }

  const timeSeries = Array.from(timeSeriesMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, data]) => ({ time, ...data }));

  // Breakdown by source
  const bySourceMap = new Map<string, { tokens: number; calls: number; unmeteredCalls: number }>();
  for (const e of events) {
    const src = e.source || "unknown";
    const prev = bySourceMap.get(src) || { tokens: 0, calls: 0, unmeteredCalls: 0 };
    const usage = displayUsageFor(e);
    if (hasMeteredUsage(usage)) {
      prev.tokens += usage.total;
      prev.calls += 1;
    } else {
      prev.unmeteredCalls += 1;
    }
    bySourceMap.set(src, prev);
  }
  const bySource = Array.from(bySourceMap.entries())
    .map(([source, data]) => ({ source, ...data }))
    .sort((a, b) => b.tokens - a.tokens || (b.calls + b.unmeteredCalls) - (a.calls + a.unmeteredCalls));

  // Breakdown by model
  const byModelMap = new Map<
    string,
    { tokens: number; input: number; output: number; calls: number; unmeteredCalls: number }
  >();
  for (const e of events) {
    const usage = displayUsageFor(e);
    const mdl = inferredModelForEvent(e) || "unknown";
    const prev = byModelMap.get(mdl) || { tokens: 0, input: 0, output: 0, calls: 0, unmeteredCalls: 0 };
    const input = usage.input;
    const output = usage.output;
    const total = usage.total;
    if (hasMeteredUsage(usage)) {
      prev.tokens += total;
      prev.input += input;
      prev.output += output;
      prev.calls += 1;
    } else {
      prev.unmeteredCalls += 1;
    }
    byModelMap.set(mdl, prev);
  }
  const byModel = Array.from(byModelMap.entries())
    .map(([model, data]) => ({ model, ...data }))
    .sort((a, b) => b.tokens - a.tokens || (b.calls + b.unmeteredCalls) - (a.calls + a.unmeteredCalls));

  // Top tools
  const byToolMap = new Map<string, number>();
  for (const t of toolEvents) {
    byToolMap.set(t.tool_name, (byToolMap.get(t.tool_name) || 0) + 1);
  }
  const topTools = Array.from(byToolMap.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const byTeamMemberMap = new Map<
    string,
    {
      userId: string;
      label: string;
      email: string | null;
      role: "admin" | "member" | "guest";
      tokens: number;
      input: number;
      output: number;
      calls: number;
      unmeteredCalls: number;
      toolCalls: number;
      modelCostUsd: number;
      totalChargeUsd: number;
    }
  >();
  for (const member of teamMembers) {
    byTeamMemberMap.set(member.userId, {
      userId: member.userId,
      label: member.label,
      email: member.email,
      role: member.role,
      tokens: 0,
      input: 0,
      output: 0,
      calls: 0,
      unmeteredCalls: 0,
      toolCalls: 0,
      modelCostUsd: 0,
      totalChargeUsd: 0,
    });
  }

  const ensureTeamMemberUsage = (userId: string | null | undefined) => {
    const id = userId || "unknown";
    const existing = byTeamMemberMap.get(id);
    if (existing) return existing;
    const fallback = {
      userId: id,
      label: id === "unknown" ? "Unknown member" : `Member ${id.slice(0, 8)}`,
      email: null,
      role: "member" as const,
      tokens: 0,
      input: 0,
      output: 0,
      calls: 0,
      unmeteredCalls: 0,
      toolCalls: 0,
      modelCostUsd: 0,
      totalChargeUsd: 0,
    };
    byTeamMemberMap.set(id, fallback);
    return fallback;
  };

  for (const e of events) {
    const usage = displayUsageFor(e);
    const row = ensureTeamMemberUsage(e.user_id);
    if (hasMeteredUsage(usage)) {
      row.tokens += usage.total;
      row.input += usage.input;
      row.output += usage.output;
      row.calls += 1;
    } else {
      row.unmeteredCalls += 1;
    }
    row.modelCostUsd += finiteNumber(e.model_cost_usd) || 0;
    row.totalChargeUsd += finiteNumber(e.total_charge_usd) || 0;
  }

  for (const t of toolEvents) {
    ensureTeamMemberUsage(t.user_id).toolCalls += 1;
  }

  const byTeamMember = Array.from(byTeamMemberMap.values())
    .map((member) => ({
      ...member,
      modelCostUsd: Math.round((member.modelCostUsd + Number.EPSILON) * 1_000_000) / 1_000_000,
      totalChargeUsd: Math.round((member.totalChargeUsd + Number.EPSILON) * 1_000_000) / 1_000_000,
    }))
    .sort(
      (a, b) =>
        b.tokens - a.tokens ||
        b.calls + b.unmeteredCalls + b.toolCalls - (a.calls + a.unmeteredCalls + a.toolCalls) ||
        a.label.localeCompare(b.label)
    );

  return NextResponse.json({
    workspaceId,
    range: { from: fromIso, to: toIso },
    selectedTeamMemberId,
    teamMembers,
    granularity,
    timezone: "UTC",
    truncated: {
      usageEvents: usageTruncated,
      toolEvents: toolTruncated,
    },
    rowCounts: {
      usageEvents: events.length,
      toolEvents: toolEvents.length,
    },
    summary: {
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      billableTokens,
      nonBillableTokens,
      groovyKeyTokens,
      externalKeyTokens,
      noChargeTokens,
      totalLlmCalls: events.length,
      meteredLlmCalls,
      unmeteredLlmCalls,
      totalToolCalls: toolEvents.length,
      estimatedCount,
      modelCostUsdTotal: Math.round((modelCostUsdTotal + Number.EPSILON) * 1_000_000) / 1_000_000,
      groovyFeeUsdTotal: Math.round((groovyFeeUsdTotal + Number.EPSILON) * 1_000_000) / 1_000_000,
      totalChargeUsdTotal: Math.round((totalChargeUsdTotal + Number.EPSILON) * 1_000_000) / 1_000_000,
      groovyKeyChargeUsdTotal: Math.round((groovyKeyChargeUsdTotal + Number.EPSILON) * 1_000_000) / 1_000_000,
      externalKeyCostBasisUsdTotal: Math.round((externalKeyCostBasisUsdTotal + Number.EPSILON) * 1_000_000) / 1_000_000,
      externalKeyFeeUsdTotal: Math.round((externalKeyFeeUsdTotal + Number.EPSILON) * 1_000_000) / 1_000_000,
      externalKeyChargeUsdTotal: Math.round((externalKeyChargeUsdTotal + Number.EPSILON) * 1_000_000) / 1_000_000,
      cacheReadTokens,
      cacheWriteTokens,
      cacheSavingsUsd: Math.round((cacheSavingsUsd + Number.EPSILON) * 1_000_000) / 1_000_000,
    },
    timeSeries,
    bySource,
    byModel,
    byTeamMember,
    topTools,
  });
}
