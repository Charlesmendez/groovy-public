import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { verifyCodeAgentUsageBillingToken } from "@/lib/billing/codeAgentUsageToken";
import { recordCodeAgentUsage } from "@/lib/billing/recordCodeAgentUsage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PostBody = {
  agentId?: string;
  requestId?: string;
  billingToken?: string;
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

  const outcome = await recordCodeAgentUsage({
    userId: user.id,
    userEmail: user.email || null,
    agentId: billing.agentId,
    requestId: billing.requestId,
    billing: {
      billable: billing.billable,
      chargeType: billing.chargeType,
      provider: billing.provider,
      codeCliProvider: billing.codeCliProvider,
      authMethod: billing.authMethod,
      authOrigin: billing.authOrigin,
    },
    result: {
      ok: typeof body?.ok === "boolean" ? body.ok : null,
      model: typeof body?.model === "string" ? body.model : null,
      sessionId: typeof body?.sessionId === "string" ? body.sessionId : null,
      durationMs: asFiniteNumber(body?.durationMs),
      usage: body?.usage ?? null,
      inputTokens: asFiniteNumber(body?.input_tokens),
      outputTokens: asFiniteNumber(body?.output_tokens),
      totalTokens: asFiniteNumber(body?.total_tokens),
      totalCostUsd: asFiniteNumber(body?.total_cost_usd) ?? asFiniteNumber(body?.cost_usd),
    },
  });

  if (!outcome.recorded) {
    return NextResponse.json({ ok: true, recorded: false, reason: outcome.reason });
  }

  return NextResponse.json({
    ok: true,
    recorded: true,
    billable: outcome.billable,
    chargeType: outcome.chargeType,
    unmetered: outcome.unmetered,
  });
}
