import { createHmac } from "node:crypto";
import { constantTimeStringEqual } from "./auth";

function secret(): string {
  const value =
    process.env.HARNESS_THREAD_TOKEN_SECRET ||
    process.env.RELAY_JWT_SECRET ||
    "";
  if (!value) throw new Error("HARNESS_THREAD_TOKEN_SECRET is not configured");
  return value;
}

function signature(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function tokenPayload(args: {
  threadId: string;
  keyId: string;
  expiresAt: string | number;
  requestOrigin?: string | null;
}): string {
  // Keep the visible token compact while binding its signature to the browser
  // origin. A publishable key allowed on multiple sites must not be able to
  // replay one site's thread token from another allowed site.
  return `${args.threadId}.${args.keyId}.${args.expiresAt}.${args.requestOrigin || ""}`;
}

export function createHarnessThreadToken(args: {
  threadId: string;
  keyId: string;
  requestOrigin?: string | null;
  ttlSeconds?: number;
}): string {
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(300, args.ttlSeconds || 31_536_000);
  const visiblePayload = `${args.threadId}.${args.keyId}.${expiresAt}`;
  const signedPayload = tokenPayload({
    threadId: args.threadId,
    keyId: args.keyId,
    expiresAt,
    requestOrigin: args.requestOrigin,
  });
  return `${visiblePayload}.${signature(signedPayload)}`;
}

export function verifyHarnessThreadToken(args: {
  token: string;
  threadId: string;
  keyId: string;
  requestOrigin?: string | null;
}): boolean {
  const parts = args.token.trim().split(".");
  if (parts.length !== 4) return false;
  const [threadId, keyId, expiresRaw, provided] = parts;
  if (threadId !== args.threadId || keyId !== args.keyId) return false;
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  const payload = tokenPayload({
    threadId,
    keyId,
    expiresAt: expiresRaw,
    requestOrigin: args.requestOrigin,
  });
  return constantTimeStringEqual(provided, signature(payload));
}
