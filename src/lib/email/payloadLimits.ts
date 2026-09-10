import type { EmailMessage, EmailThreadDetail } from "@/lib/email/types";

export const EMAIL_DRAFT_BODY_MAX_CHARS = 100_000;
export const EMAIL_DRAFT_HTML_MAX_CHARS = 250_000;
export const EMAIL_ASSIST_COMPLETE_BODY_MAX_CHARS = 8_000;
export const EMAIL_ASSIST_EDIT_BODY_MAX_CHARS = 30_000;
export const EMAIL_ASSIST_COMPLETE_CONTEXT_MAX_CHARS = 8_000;
export const EMAIL_ASSIST_EDIT_CONTEXT_MAX_CHARS = 18_000;
export const EMAIL_ASSIST_INSTRUCTION_MAX_CHARS = 2_000;
export const EMAIL_ASSIST_SUBJECT_MAX_CHARS = 1_000;

// Keep enough headroom below the hosting provider's function payload ceiling
// for response headers and framework bookkeeping.
export const EMAIL_THREAD_RESPONSE_MAX_BYTES = 3_250_000;
const EMAIL_THREAD_BODY_MAX_JSON_BYTES = 160_000;
const EMAIL_THREAD_HTML_MAX_JSON_BYTES = 450_000;

export type EmailAssistPayloadTask =
  | "complete"
  | "rewrite"
  | "draft"
  | "steer";

type DraftPayload = {
  body: string;
  bodyHtml: string | null;
};

export function boundedEmailDraftPayload<T extends DraftPayload>(draft: T): T {
  return {
    ...draft,
    body: draft.body.slice(0, EMAIL_DRAFT_BODY_MAX_CHARS),
    bodyHtml:
      typeof draft.bodyHtml === "string"
        ? draft.bodyHtml.slice(0, EMAIL_DRAFT_HTML_MAX_CHARS)
        : null,
  };
}

export function boundedEmailAssistPayload(args: {
  task: EmailAssistPayloadTask;
  instruction: string;
  currentBody: string;
  subject: string;
  threadContext: string;
  connectionId: string;
}) {
  const completing = args.task === "complete";
  return {
    ...args,
    instruction: args.instruction.slice(0, EMAIL_ASSIST_INSTRUCTION_MAX_CHARS),
    currentBody: completing
      ? args.currentBody.slice(-EMAIL_ASSIST_COMPLETE_BODY_MAX_CHARS)
      : args.currentBody.slice(0, EMAIL_ASSIST_EDIT_BODY_MAX_CHARS),
    subject: args.subject.slice(0, EMAIL_ASSIST_SUBJECT_MAX_CHARS),
    threadContext: completing
      ? args.threadContext.slice(-EMAIL_ASSIST_COMPLETE_CONTEXT_MAX_CHARS)
      : args.threadContext.slice(0, EMAIL_ASSIST_EDIT_CONTEXT_MAX_CHARS),
  };
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function truncateForJsonBytes(value: string, maxBytes: number): string {
  if (maxBytes <= jsonBytes("")) return "";
  if (jsonBytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (jsonBytes(value.slice(0, midpoint)) <= maxBytes) low = midpoint;
    else high = midpoint - 1;
  }
  // Avoid returning half of a UTF-16 surrogate pair.
  const end =
    low > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(low - 1))
      ? low - 1
      : low;
  return value.slice(0, end);
}

/**
 * Vercel rejects oversized function responses before the browser can read
 * them. Preserve ordinary conversations verbatim, but compact unusually large
 * threads to a deterministic transport budget. The requested message and the
 * newest messages receive content budget first; metadata and attachment
 * references always remain available.
 */
export function compactEmailThreadDetailForTransport(
  detail: EmailThreadDetail,
  preferredMessageId = "",
): EmailThreadDetail {
  const payload = { ok: true as const, thread: detail };
  if (jsonBytes(payload) <= EMAIL_THREAD_RESPONSE_MAX_BYTES) return detail;

  const messages: EmailMessage[] = detail.messages.map((message) => ({
    ...message,
    body: "",
    htmlBody: null,
    contentTruncated: Boolean(message.body || message.htmlBody),
  }));
  const compact: EmailThreadDetail = {
    ...detail,
    summary: {
      ...detail.summary,
      draft: detail.summary.draft
        ? boundedEmailDraftPayload(detail.summary.draft)
        : null,
    },
    messages,
    draft: detail.draft ? boundedEmailDraftPayload(detail.draft) : null,
  };
  let remaining = Math.max(
    0,
    EMAIL_THREAD_RESPONSE_MAX_BYTES -
      jsonBytes({ ok: true as const, thread: compact }),
  );
  const preferredIndex = detail.messages.findIndex(
    (message) => message.id === preferredMessageId,
  );
  const priority = Array.from(
    new Set([
      preferredIndex,
      ...detail.messages.map((_, index) => index).reverse(),
    ]),
  ).filter((index) => index >= 0);

  for (const index of priority) {
    const source = detail.messages[index];
    const target = messages[index];
    const emptyBodyBytes = jsonBytes("");
    const bodyBudget = Math.min(
      EMAIL_THREAD_BODY_MAX_JSON_BYTES,
      remaining + emptyBodyBytes,
    );
    const body = truncateForJsonBytes(source.body, bodyBudget);
    const bodyDelta = Math.max(0, jsonBytes(body) - emptyBodyBytes);
    target.body = body;
    remaining = Math.max(0, remaining - bodyDelta);

    const htmlBytes = source.htmlBody ? jsonBytes(source.htmlBody) : 0;
    const nullBytes = jsonBytes(null);
    const htmlDelta = Math.max(0, htmlBytes - nullBytes);
    if (
      source.htmlBody &&
      htmlBytes <= EMAIL_THREAD_HTML_MAX_JSON_BYTES &&
      htmlDelta <= remaining
    ) {
      target.htmlBody = source.htmlBody;
      remaining -= htmlDelta;
    }
    if (target.body === source.body && target.htmlBody === source.htmlBody) {
      delete target.contentTruncated;
    }
  }

  return compact;
}
