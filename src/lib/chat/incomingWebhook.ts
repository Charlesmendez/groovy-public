import { MAX_CHAT_MESSAGE_CHARACTERS } from "./messageLimits";

export const WEBHOOK_BODY_LIMIT = 256 * 1024;
export const WEBHOOK_NAME_LIMIT = 60;
export const WEBHOOK_RATE_LIMIT = 60;

export class IncomingWebhookError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function webhookMessageLabel(message: {
  author_type: string;
  metadata?: Record<string, unknown> | null;
}): string | null {
  if (
    message.author_type !== "system" ||
    message.metadata?.kind !== "incoming_webhook"
  )
    return null;
  const name = message.metadata.webhook_name;
  return typeof name === "string" && name.trim()
    ? name.trim().slice(0, WEBHOOK_NAME_LIMIT)
    : "Webhook";
}

export function parseWebhookText(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new IncomingWebhookError(
      "invalid_payload",
      'Send a JSON object with a "text" field.',
    );
  }
  const payload = body as Record<string, unknown>;
  if (typeof payload.text !== "string" || !payload.text.trim()) {
    throw new IncomingWebhookError(
      "text_required",
      'Add a non-empty "text" string to your JSON body.',
    );
  }
  const text = payload.text.trim();
  if (text.includes("\u0000")) {
    throw new IncomingWebhookError(
      "invalid_text",
      "Text cannot contain null characters.",
    );
  }
  if (text.length > MAX_CHAT_MESSAGE_CHARACTERS) {
    throw new IncomingWebhookError(
      "text_too_long",
      "Keep your message under 40,000 characters.",
      413,
    );
  }
  // Channel, identity, and metadata are always taken from the saved webhook.
  // This endpoint publishes messages only; it never invokes a Mind or tools.
  return text;
}

export function parseWebhookEventId(value: string | null): string | null {
  if (value === null) return null;
  if (!/^[\x21-\x7e]{1,128}$/.test(value)) {
    throw new IncomingWebhookError(
      "invalid_idempotency_key",
      "Use 1–128 visible ASCII characters for Idempotency-Key.",
    );
  }
  return value;
}

export async function readWebhookJson(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    throw new IncomingWebhookError(
      "unsupported_content_type",
      "Set Content-Type to application/json.",
      415,
    );
  }
  if (Number(request.headers.get("content-length")) > WEBHOOK_BODY_LIMIT) {
    throw new IncomingWebhookError(
      "payload_too_large",
      "Keep the JSON body under 256 KB.",
      413,
    );
  }
  const reader = request.body?.getReader();
  if (!reader)
    throw new IncomingWebhookError("invalid_payload", "Send a JSON body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > WEBHOOK_BODY_LIMIT) {
        await reader.cancel();
        throw new IncomingWebhookError(
          "payload_too_large",
          "Keep the JSON body under 256 KB.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new IncomingWebhookError(
      "invalid_json",
      "The body is not valid JSON. Try the example in Settings → Webhooks.",
    );
  }
}

export function buildIncomingWebhookUrl(
  baseUrl: string,
  token: string,
): string {
  let origin = new URL(baseUrl).origin;
  // The hosted apex is a Vercel domain redirect, before the API can run.
  // Publish its direct destination even when an older app URL is configured.
  // Never rewrite custom/self-hosted, preview, or local development origins.
  if (
    origin === "https://gogroovy.ai" ||
    origin === "http://gogroovy.ai" ||
    origin === "http://www.gogroovy.ai"
  ) {
    origin = "https://www.gogroovy.ai";
  }
  return `${origin}/api/hooks/${encodeURIComponent(token)}`;
}

export function webhookCurlExample(url: string): string {
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  return [
    `curl --location --fail-with-body ${quote(url)} \\`,
    "  -H 'Content-Type: application/json' \\",
    '  -d \'{"text":"Hello from my service!"}\'',
  ].join("\n");
}
