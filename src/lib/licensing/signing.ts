import { createHash, createPrivateKey, createPublicKey, sign, verify } from "crypto";
import type {
  GroovyActivationPayload,
  GroovyLicensePayload,
  GroovySignedEnvelope,
} from "@/lib/licensing/types";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

function readPemEnv(...names: string[]): string | null {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw || !raw.trim()) continue;
    const trimmed = raw.trim();
    if (trimmed.includes("-----BEGIN")) return trimmed.replace(/\\n/g, "\n");
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
      if (decoded.includes("-----BEGIN")) return decoded;
    } catch {
      // Ignore and keep looking.
    }
  }
  return null;
}

function getPrivateKeyPem(): string {
  const pem = readPemEnv("GROOVY_LICENSE_PRIVATE_KEY_PEM", "LICENSE_PRIVATE_KEY_PEM");
  if (!pem) throw new Error("Missing GROOVY_LICENSE_PRIVATE_KEY_PEM");
  return pem;
}

function getPublicKeyPem(): string {
  const pem = readPemEnv(
    "NEXT_PUBLIC_GROOVY_LICENSE_PUBLIC_KEY_PEM",
    "GROOVY_LICENSE_PUBLIC_KEY_PEM",
    "LICENSE_PUBLIC_KEY_PEM"
  );
  if (!pem) throw new Error("Missing GROOVY_LICENSE_PUBLIC_KEY_PEM");
  return pem;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalLicensePayload(payload: Record<string, unknown>): string {
  return stableStringify(payload);
}

export function signEnvelope<TPayload extends GroovyLicensePayload | GroovyActivationPayload>(
  typ: GroovySignedEnvelope<TPayload>["typ"],
  payload: TPayload
): GroovySignedEnvelope<TPayload> {
  const privateKey = createPrivateKey(getPrivateKeyPem());
  const message = Buffer.from(canonicalLicensePayload(payload), "utf8");
  const signature = sign(null, message, privateKey).toString("base64url");
  return {
    alg: "Ed25519",
    typ,
    payload,
    signature,
  };
}

export function verifyEnvelope<TPayload extends Record<string, unknown>>(
  envelope: GroovySignedEnvelope<TPayload>
): boolean {
  if (!envelope || envelope.alg !== "Ed25519" || !envelope.payload || !envelope.signature) {
    return false;
  }
  const publicKey = createPublicKey(getPublicKeyPem());
  const message = Buffer.from(canonicalLicensePayload(envelope.payload), "utf8");
  return verify(null, message, publicKey, Buffer.from(envelope.signature, "base64url"));
}

export function hashActivationToken(envelope: GroovySignedEnvelope<GroovyActivationPayload>): string {
  return sha256Hex(JSON.stringify(envelope));
}
