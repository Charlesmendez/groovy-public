import type { EmailMailboxConnection } from "@/lib/email/gmail";

type RecordLike = Record<string, unknown>;

const DATAGRAN_ORIGIN = "https://www.datagran.io";
const CAPABILITY_CACHE_MS = 5 * 60_000;
// Vercel rejects function request bodies at roughly 4.5 MB. Leave enough
// headroom for platform framing and headers instead of discovering the limit
// after recipient deliveries have entered the duplicate-sensitive state.
export const PERSONALIZED_EMAIL_REQUEST_MAX_BYTES = 4_000_000;

const capabilityCache = new Map<
  string,
  {
    expiresAt: number;
    available: boolean;
    email: string | null;
  }
>();

function record(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

async function datagranJson(
  mailbox: EmailMailboxConnection,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; value: RecordLike | null }> {
  const response = await fetch(new URL(path, DATAGRAN_ORIGIN), {
    ...init,
    headers: {
      Accept: "application/json",
      "x-api-key": mailbox.datagranApiKey,
      ...(init?.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(35_000),
  });
  const value = record(await response.json().catch(() => null));
  return { response, value };
}

function personalizedEmailRequestBody(args: {
  connectionId: string;
  envelopeFrom: string;
  recipient: string;
  raw: string;
}): string {
  return JSON.stringify({
    connectionId: args.connectionId,
    envelopeFrom: normalizeAddress(args.envelopeFrom),
    recipient: normalizeAddress(args.recipient),
    raw: Buffer.from(args.raw, "utf8").toString("base64url"),
  });
}

export function personalizedEmailRequestFits(args: {
  connectionId: string;
  envelopeFrom: string;
  recipient: string;
  raw: string;
}): boolean {
  return (
    Buffer.byteLength(personalizedEmailRequestBody(args), "utf8") <=
    PERSONALIZED_EMAIL_REQUEST_MAX_BYTES
  );
}

class PersonalizedEmailDeliveryError extends Error {
  readonly definitelyNotSent: boolean;
  readonly status: number | null;

  constructor(
    message: string,
    options: { definitelyNotSent?: boolean; status?: number | null } = {},
  ) {
    super(message);
    this.name = "PersonalizedEmailDeliveryError";
    this.definitelyNotSent = options.definitelyNotSent === true;
    this.status = options.status ?? null;
  }
}

export async function canSendPersonalizedEmailFrom(args: {
  mailbox: EmailMailboxConnection;
  sender: string;
}): Promise<boolean> {
  const sender = normalizeAddress(args.sender);
  if (
    !sender ||
    !args.mailbox.connectionId ||
    !args.mailbox.datagranApiKey
  ) {
    return false;
  }
  const cached = capabilityCache.get(args.mailbox.connectionId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.available && cached.email === sender;
  }
  try {
    const query = new URLSearchParams({
      connection_id: args.mailbox.connectionId,
    });
    const { response, value } = await datagranJson(
      args.mailbox,
      `/api/gmail/smtp/status?${query}`,
    );
    const available = response.ok && value?.available === true;
    const capability = {
      expiresAt:
        Date.now() + (available ? CAPABILITY_CACHE_MS : 5_000),
      available,
      email: text(value?.email).toLowerCase() || null,
    };
    capabilityCache.set(args.mailbox.connectionId, capability);
    return capability.available && capability.email === sender;
  } catch {
    return false;
  }
}

export async function sendPersonalizedEmailVariant(args: {
  mailbox: EmailMailboxConnection;
  envelopeFrom: string;
  recipient: string;
  raw: string;
}): Promise<{ messageId: string | null }> {
  const envelopeFrom = normalizeAddress(args.envelopeFrom);
  const recipient = normalizeAddress(args.recipient);
  if (!envelopeFrom || !recipient) {
    throw new Error("A sender and recipient are required.");
  }
  const requestBody = personalizedEmailRequestBody({
    connectionId: args.mailbox.connectionId,
    envelopeFrom,
    recipient,
    raw: args.raw,
  });
  const { response, value } = await datagranJson(
    args.mailbox,
    "/api/gmail/smtp/send",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: requestBody,
    },
  );
  if (!response.ok || value?.accepted !== true) {
    const details = record(value?.details);
    if (
      response.status === 409 &&
      text(details?.code) === "gmail_smtp_scope_required"
    ) {
      throw new PersonalizedEmailDeliveryError(
        "Reconnect Gmail to enable individual read receipts for group email.",
        { definitelyNotSent: true, status: response.status },
      );
    }
    throw new PersonalizedEmailDeliveryError(
      text(value?.error) ||
        `Gmail did not confirm delivery to ${recipient}.`,
      {
        // A platform 413 is rejected before the SMTP function runs, so Gmail
        // cannot have accepted this recipient. Other failures remain
        // duplicate-sensitive because they may have happened after DATA.
        definitelyNotSent: response.status === 413,
        status: response.status,
      },
    );
  }
  return {
    messageId: text(value.messageId) || null,
  };
}

export type PersonalizedEmailVariant = {
  recipient: string;
  raw: string;
};

export type PersonalizedEmailVariantResult =
  | {
      recipient: string;
      ok: true;
      messageId: string | null;
    }
  | {
      recipient: string;
      ok: false;
      error: string;
      definitelyNotSent: boolean;
      status: number | null;
    };

/**
 * Deliver recipient-specific variants with a small concurrency bound. Every
 * started delivery settles before this returns so the caller can persist one
 * duplicate-safe state transition for the complete batch.
 */
export async function sendPersonalizedEmailVariants(args: {
  mailbox: EmailMailboxConnection;
  envelopeFrom: string;
  variants: readonly PersonalizedEmailVariant[];
  maxConcurrency?: number;
}): Promise<PersonalizedEmailVariantResult[]> {
  if (args.variants.length === 0) return [];
  const results = new Array<PersonalizedEmailVariantResult>(
    args.variants.length,
  );
  const workerCount = Math.min(
    args.variants.length,
    Math.max(1, Math.min(4, Math.floor(args.maxConcurrency || 3))),
  );
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < args.variants.length) {
      const index = nextIndex;
      nextIndex += 1;
      const variant = args.variants[index];
      try {
        const delivered = await sendPersonalizedEmailVariant({
          mailbox: args.mailbox,
          envelopeFrom: args.envelopeFrom,
          recipient: variant.recipient,
          raw: variant.raw,
        });
        results[index] = {
          recipient: variant.recipient,
          ok: true,
          messageId: delivered.messageId,
        };
      } catch (error) {
        results[index] = {
          recipient: variant.recipient,
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Recipient delivery could not be confirmed.",
          definitelyNotSent:
            error instanceof PersonalizedEmailDeliveryError &&
            error.definitelyNotSent,
          status:
            error instanceof PersonalizedEmailDeliveryError
              ? error.status
              : null,
        };
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function resetPersonalizedDeliveryCachesForTests(): void {
  capabilityCache.clear();
}
