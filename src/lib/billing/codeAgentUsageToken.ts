import { createHmac, timingSafeEqual } from "crypto";
import { normalizeUsageChargeType, type UsageChargeType } from "@/lib/billing/pricing";

export type CodeAgentUsageBillingPayload = {
  userId: string;
  agentId: string;
  requestId: string;
  billable: boolean;
  chargeType: UsageChargeType;
  provider: "anthropic" | "openai";
  codeCliProvider: "claude" | "codex";
  authMethod: "api_key" | "cli_token" | "local_codex_login";
  authOrigin: "groovy" | "user" | "local";
  issuedAt: number;
};

function signingSecret(): string | null {
  return (
    process.env.BILLING_USAGE_SIGNING_SECRET ||
    process.env.RELAY_JWT_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    null
  );
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function createCodeAgentUsageBillingToken(
  payload: CodeAgentUsageBillingPayload
): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${signPayload(payloadB64, secret)}`;
}

export function verifyCodeAgentUsageBillingToken(
  token: string
): CodeAgentUsageBillingPayload | null {
  const secret = signingSecret();
  if (!secret) return null;

  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;

  const expected = signPayload(payloadB64, secret);
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (
    actualBuf.length !== expectedBuf.length ||
    !timingSafeEqual(actualBuf, expectedBuf)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Partial<CodeAgentUsageBillingPayload>;
    if (
      typeof p.userId !== "string" ||
      typeof p.agentId !== "string" ||
      typeof p.requestId !== "string" ||
      typeof p.billable !== "boolean" ||
      normalizeUsageChargeType(p.chargeType) !== p.chargeType ||
      (p.provider !== "anthropic" && p.provider !== "openai") ||
      (p.codeCliProvider !== "claude" && p.codeCliProvider !== "codex") ||
      (p.authMethod !== "api_key" &&
        p.authMethod !== "cli_token" &&
        p.authMethod !== "local_codex_login") ||
      (p.authOrigin !== "groovy" && p.authOrigin !== "user" && p.authOrigin !== "local") ||
      typeof p.issuedAt !== "number"
    ) {
      return null;
    }
    return { ...(p as CodeAgentUsageBillingPayload), chargeType: normalizeUsageChargeType(p.chargeType) };
  } catch {
    return null;
  }
}
