import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { insertBillingUsageEventBestEffort } from "@/lib/billing/events";
import { settleGroovyUsageDebitBestEffort } from "@/lib/billing/guard";
import { getOrCreateWorkspaceIdForUser } from "@/lib/billing/workspace";
import { estimateTokensFromCostUsd, normalizeTokenUsage } from "@/lib/billing/usage";
import { verifyCodeAgentUsageBillingToken } from "@/lib/billing/codeAgentUsageToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PostBody = {
  agentId?: string;
  requestId?: string;
  billingToken?: string | null;
  ok?: boolean | null;
  model?: string | null;
  sessionId?: string | null;
  durationMs?: number | null;
  usage?: unknown;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  total_cost_usd?: number | null;
  cost_usd?: number | null;
};

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function fallbackCodeAgentModel(args: {
  provider: "anthropic" | "openai";
  codeCliProvider: "claude" | "codex";
}): string {
  if (args.provider === "openai" || args.codeCliProvider === "codex") {
    return "gpt-5.5";
  }
  return "claude-opus-4-7";
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as PostBody | null;
  const token = typeof body?.billingToken === "string" ? body.billingToken.trim() : "";
  const billing = token ? verifyCodeAgentUsageBillingToken(token) : null;
  if (!billing || billing.userId !== user.id) {
    return NextResponse.json({ error: "Invalid billing context" }, { status: 400 });
  }
  if (
    body?.agentId !== billing.agentId ||
    body?.requestId !== billing.requestId ||
    Date.now() - billing.issuedAt > 24 * 60 * 60 * 1000
  ) {
    return NextResponse.json({ error: "Stale billing context" }, { status: 400 });
  }

  const { data: agentConfig, error: agentErr } = await supabase
    .from("claude_code_agent_configs")
    .select("agent_id")
    .eq("agent_id", billing.agentId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (agentErr || !agentConfig) {
    return NextResponse.json({ error: "Code session not configured" }, { status: 404 });
  }

  const workspaceId = await getOrCreateWorkspaceIdForUser({
    userId: user.id,
    email: user.email || null,
  }).catch((e) => {
    console.warn(
      "[claude-cli/usage] getOrCreateWorkspaceIdForUser failed:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  });
  if (!workspaceId) {
    return NextResponse.json({ ok: true, recorded: false, reason: "no_billing_workspace" });
  }

  const usage = body?.usage;
  const normalizedUsage = normalizeTokenUsage(usage || body);
  const totalCostUsd =
    asFiniteNumber(body?.total_cost_usd) ??
    asFiniteNumber(body?.cost_usd);
  const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : null;
  const modelForEstimation = model || fallbackCodeAgentModel(billing);

  let inputTokens = asFiniteNumber(body?.input_tokens) ?? normalizedUsage?.inputTokens ?? null;
  let outputTokens = asFiniteNumber(body?.output_tokens) ?? normalizedUsage?.outputTokens ?? null;
  let totalTokens = asFiniteNumber(body?.total_tokens) ?? normalizedUsage?.totalTokens ?? null;
  let estimated = false;
  let estimationReason: string | null = null;

  if (
    (typeof totalTokens !== "number" || totalTokens <= 0) &&
    typeof totalCostUsd === "number" &&
    totalCostUsd > 0
  ) {
    const est = estimateTokensFromCostUsd({
      totalCostUsd,
      model: modelForEstimation,
      outputRatio: 0.25,
    });
    if (est) {
      inputTokens = est.inputTokens;
      outputTokens = est.outputTokens;
      totalTokens = est.totalTokens;
      estimated = true;
      estimationReason = est.estimationReason;
    }
  }

  const hasPositiveTokenUsage =
    (typeof inputTokens === "number" && inputTokens > 0) ||
    (typeof outputTokens === "number" && outputTokens > 0) ||
    (typeof totalTokens === "number" && totalTokens > 0);
  const hasPositiveCostUsage = typeof totalCostUsd === "number" && totalCostUsd > 0;
  if (!hasPositiveTokenUsage) {
    inputTokens = null;
    outputTokens = null;
    totalTokens = null;
  }

  const durationMs = asFiniteNumber(body?.durationMs);
  const source = "code_agent_cli";
  const modelForStorage = model || modelForEstimation;
  const meta = {
    agentId: billing.agentId,
    codeCliProvider: billing.codeCliProvider,
    authMethod: billing.authMethod,
    authOrigin: billing.authOrigin,
    upstreamCostUsd: totalCostUsd,
    modelForEstimation: estimated && !model ? modelForEstimation : undefined,
    durationMs,
    sessionId: typeof body?.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null,
    noUsageReturned: !hasPositiveTokenUsage && !hasPositiveCostUsage,
    runOk: typeof body?.ok === "boolean" ? body.ok : null,
  };

  await insertBillingUsageEventBestEffort({
    workspaceId,
    userId: user.id,
    turnId: billing.requestId,
    traceId: billing.requestId,
    source,
    spanId: "main",
    provider: billing.provider,
    model: modelForStorage,
    usage,
    inputTokens,
    outputTokens,
    totalTokens,
    estimated,
    estimationReason,
    modelCostUsd: typeof totalCostUsd === "number" ? totalCostUsd : null,
    billable: hasPositiveTokenUsage || hasPositiveCostUsage ? billing.billable : false,
    chargeType: hasPositiveTokenUsage || hasPositiveCostUsage ? billing.chargeType : "no_charge",
    meta,
  });

  if (billing.billable && (hasPositiveTokenUsage || hasPositiveCostUsage)) {
    await settleGroovyUsageDebitBestEffort({
      workspaceId,
      userId: user.id,
      traceId: billing.requestId,
      turnId: billing.requestId,
      source,
      spanId: "main",
      model: modelForStorage,
      usage: normalizedUsage || { inputTokens, outputTokens, totalTokens },
      modelCostUsdOverride: typeof totalCostUsd === "number" ? totalCostUsd : null,
      chargeType: billing.chargeType,
      meta,
    }).catch(() => {});
  }

  return NextResponse.json({
    ok: true,
    recorded: true,
    billable: hasPositiveTokenUsage || hasPositiveCostUsage ? billing.billable : false,
    chargeType: hasPositiveTokenUsage || hasPositiveCostUsage ? billing.chargeType : "no_charge",
    unmetered: !hasPositiveTokenUsage && !hasPositiveCostUsage,
  });
}
