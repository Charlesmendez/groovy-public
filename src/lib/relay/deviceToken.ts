import { createHmac, timingSafeEqual } from "crypto";

function base64urlDecode(str: string): Buffer {
  const pad = 4 - ((str.length % 4) || 4);
  const b64 = str.replaceAll("-", "+").replaceAll("_", "/").concat("=".repeat(pad));
  return Buffer.from(b64, "base64");
}

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function hmacSha256(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export type VerifiedDeviceToken = {
  deviceId: string;
  userId: string;
  exp?: number;
};

export function verifyRelayDeviceToken(
  token: string,
  secret: string
): VerifiedDeviceToken | null {
  if (!token || typeof token !== "string") return null;
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, sigPart] = parts;

  const signingInput = `${headerPart}.${payloadPart}`;
  const expectedSig = base64urlEncode(hmacSha256(secret, signingInput));

  try {
    const a = Buffer.from(sigPart);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(base64urlDecode(payloadPart).toString("utf8")) as {
      sub?: unknown;
      user_id?: unknown;
      exp?: unknown;
    };
    const now = Math.floor(Date.now() / 1000);
    const exp = typeof payload.exp === "number" ? payload.exp : Number(payload.exp);
    if (Number.isFinite(exp) && exp < now) return null;

    const deviceId = typeof payload.sub === "string" ? payload.sub : String(payload.sub || "");
    const userId =
      typeof payload.user_id === "string" ? payload.user_id : String(payload.user_id || "");
    if (!deviceId || !userId) return null;

    return { deviceId, userId, exp: Number.isFinite(exp) ? exp : undefined };
  } catch {
    return null;
  }
}

