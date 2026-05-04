import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function getMasterKey(): Buffer {
  const raw = process.env.LLM_KEY_ENCRYPTION_KEY || "";
  if (!raw) {
    throw new Error("LLM_KEY_ENCRYPTION_KEY not configured");
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("LLM_KEY_ENCRYPTION_KEY must be base64");
  }
  if (key.length !== 32) {
    throw new Error("LLM_KEY_ENCRYPTION_KEY must be 32 bytes (base64)");
  }
  return key;
}

// Format: v1:{iv_b64}:{tag_b64}:{ciphertext_b64}
export function encryptLlmApiKey(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptLlmApiKey(enc: string): string {
  if (!enc.startsWith("v1:")) throw new Error("Unsupported key encryption format");
  const parts = enc.split(":");
  if (parts.length !== 4) throw new Error("Invalid encrypted key format");
  const [, ivB64, tagB64, ctB64] = parts;
  const key = getMasterKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return plaintext;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashLlmApiKey(apiKey: string): string {
  return sha256Hex(apiKey);
}
