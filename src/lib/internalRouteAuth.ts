import { createHmac, timingSafeEqual } from "crypto";

const INTERNAL_AUTH_MAX_AGE_MS = 60_000;
const INTERNAL_USER_ID_HEADER = "x-groovy-internal-user-id";
const INTERNAL_AUTH_HEADER = "x-groovy-internal-auth";

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getInternalAuthSecret(): string {
  return trimmed(process.env.RELAY_JWT_SECRET);
}

function signInternalScope(scope: string, userId: string, ts: string): string {
  return createHmac("sha256", getInternalAuthSecret())
    .update(JSON.stringify({ scope, userId, ts }))
    .digest("base64url");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function buildInternalRouteAuthHeaders(args: {
  userId?: string | null;
  scope: string;
}): Record<string, string> {
  const userId = trimmed(args.userId);
  const scope = trimmed(args.scope);
  const secret = getInternalAuthSecret();
  if (!userId || !scope || !secret) return {};
  const ts = String(Date.now());
  return {
    [INTERNAL_USER_ID_HEADER]: userId,
    [INTERNAL_AUTH_HEADER]: `${ts}.${signInternalScope(scope, userId, ts)}`,
  };
}

export function verifyInternalRouteAuth(
  req: Request,
  scope: string
): { userId: string } | null {
  const secret = getInternalAuthSecret();
  const userId = trimmed(req.headers.get(INTERNAL_USER_ID_HEADER) || "");
  const rawAuth = trimmed(req.headers.get(INTERNAL_AUTH_HEADER) || "");
  const normalizedScope = trimmed(scope);
  if (!secret || !userId || !rawAuth || !normalizedScope) return null;

  const [ts, providedSig] = rawAuth.split(".");
  if (!ts || !providedSig) return null;

  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs)) return null;
  if (Math.abs(Date.now() - tsMs) > INTERNAL_AUTH_MAX_AGE_MS) return null;

  const expectedSig = signInternalScope(normalizedScope, userId, ts);
  if (!timingSafeStringEqual(expectedSig, providedSig)) return null;

  return { userId };
}
