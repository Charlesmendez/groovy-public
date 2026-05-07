import { createHmac, timingSafeEqual } from "crypto";

type ArtifactTokenPayload = {
  ref: string;
  licenseTypes: string[];
  exp: number;
};

function tokenSecret(): string {
  const secret =
    process.env.DOWNLOAD_TOKEN_SECRET ||
    process.env.RELAY_JWT_SECRET ||
    process.env.STRIPE_WEBHOOK_SECRET ||
    "";
  if (!secret.trim()) throw new Error("Missing DOWNLOAD_TOKEN_SECRET or RELAY_JWT_SECRET");
  return secret;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signPayload(payloadB64: string): string {
  return createHmac("sha256", tokenSecret()).update(payloadB64).digest("base64url");
}

export function createArtifactDownloadToken(args: {
  ref: string;
  licenseTypes: string[];
  ttlSeconds?: number;
}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: ArtifactTokenPayload = {
    ref: args.ref,
    licenseTypes: Array.from(new Set(args.licenseTypes.filter(Boolean))),
    exp: nowSeconds + (args.ttlSeconds || 15 * 60),
  };
  const payloadB64 = base64UrlJson(payload);
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

export function verifyArtifactDownloadToken(
  token: string,
  ref: string
): { ok: true; licenseTypes: string[] } | { ok: false } {
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return { ok: false };

  const expected = signPayload(payloadB64);
  const left = Buffer.from(signature, "base64url");
  const right = Buffer.from(expected, "base64url");
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false };

  let payload: ArtifactTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false };
  }

  if (payload.ref !== ref) return { ok: false };
  if (!Array.isArray(payload.licenseTypes) || payload.licenseTypes.length === 0) {
    return { ok: false };
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false };
  }

  return {
    ok: true,
    licenseTypes: Array.from(
      new Set(payload.licenseTypes.filter((value): value is string => typeof value === "string"))
    ),
  };
}
