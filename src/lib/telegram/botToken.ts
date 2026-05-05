import { decryptLlmApiKey, encryptLlmApiKey } from "@/lib/crypto/llmKey";

export function encryptTelegramBotToken(token: string): string {
  return encryptLlmApiKey(token.trim());
}

export function decryptTelegramBotToken(stored: string | null | undefined): string {
  const trimmed = typeof stored === "string" ? stored.trim() : "";
  if (!trimmed) return "";
  try {
    return decryptLlmApiKey(trimmed).trim();
  } catch {
    // Backward compatibility for rows written before bot_token_encrypted
    // actually stored encrypted ciphertext.
    return trimmed;
  }
}
