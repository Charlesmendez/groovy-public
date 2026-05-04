export type CodeAgentBillingContext = {
  token?: string | null;
  billable?: boolean;
  chargeType?: "groovy_key" | "external_key_fee" | "no_charge";
  provider?: "anthropic" | "openai";
  codeCliProvider?: "claude" | "codex";
  authMethod?: "api_key" | "cli_token" | "local_codex_login";
  authOrigin?: "groovy" | "user" | "local";
};

export type CodeAgentUsageResult = {
  ok?: boolean;
  request_id?: string;
  model?: string;
  session_id?: string | null;
  duration_ms?: number;
  usage?: unknown;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  total_cost_usd?: number;
  cost_usd?: number;
};

function fallbackModelForBilling(billing?: CodeAgentBillingContext | null): string | null {
  if (!billing) return null;
  if (
    billing.provider === "openai" ||
    billing.codeCliProvider === "codex" ||
    billing.authMethod === "local_codex_login"
  ) {
    return "gpt-5.5";
  }
  if (billing.provider === "anthropic" || billing.codeCliProvider === "claude") {
    return "claude-opus-4-7";
  }
  return null;
}

export function inferCodeAgentResultModel(args: {
  model?: string | null;
  billing?: CodeAgentBillingContext | null;
}): string | null {
  const explicit = typeof args.model === "string" ? args.model.trim() : "";
  return explicit || fallbackModelForBilling(args.billing);
}

export async function recordCodeAgentUsageBestEffort(args: {
  agentId: string;
  requestId: string;
  billing?: CodeAgentBillingContext | null;
  result: CodeAgentUsageResult;
}) {
  const token = typeof args.billing?.token === "string" ? args.billing.token.trim() : "";
  if (!token) return null;

  const model = inferCodeAgentResultModel({
    model: args.result.model || null,
    billing: args.billing || null,
  });

  return fetch("/api/claude-cli/usage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: args.agentId,
      requestId: args.requestId,
      billingToken: token,
      ok: args.result.ok ?? null,
      model,
      sessionId: args.result.session_id || null,
      durationMs: args.result.duration_ms || null,
      usage: args.result.usage || null,
      input_tokens: args.result.input_tokens ?? null,
      output_tokens: args.result.output_tokens ?? null,
      total_tokens: args.result.total_tokens ?? null,
      total_cost_usd: args.result.total_cost_usd ?? null,
      cost_usd: args.result.cost_usd ?? null,
    }),
  }).catch((err) => {
    console.warn(
      "[code-agent-usage] failed to record usage:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  });
}
