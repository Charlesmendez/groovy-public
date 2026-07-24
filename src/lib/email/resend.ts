const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Groovy <notifications@hi.gogroovy.ai>";
const REQUEST_TIMEOUT_MS = 10_000;

export type TransactionalEmail = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
};

export type EmailDeliveryResult =
  | { ok: true; id: string | null }
  | {
      ok: false;
      error: string;
      code: "not_configured" | "provider_rejected" | "request_failed";
      status?: number;
    };

export function transactionalEmailFrom(): string {
  return process.env.RESEND_FROM_EMAIL?.trim() || DEFAULT_FROM;
}

function boundedProviderMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value.replace(/\s+/g, " ").trim().slice(0, 240);
  return message || null;
}

export async function sendTransactionalEmail(
  email: TransactionalEmail,
): Promise<EmailDeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      code: "not_configured",
      error: "Email delivery is not configured (missing RESEND_API_KEY).",
    };
  }

  try {
    const response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: email.from?.trim() || transactionalEmailFrom(),
        to: Array.isArray(email.to) ? email.to : [email.to],
        subject: email.subject,
        text: email.text,
        ...(email.html ? { html: email.html } : {}),
        ...(email.replyTo?.trim() ? { reply_to: email.replyTo.trim() } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const responseText = await response.text().catch(() => "");
    let responseBody: { id?: unknown; message?: unknown } | null = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText) as {
          id?: unknown;
          message?: unknown;
        };
      } catch {
        responseBody = null;
      }
    }

    if (!response.ok) {
      const providerMessage = boundedProviderMessage(responseBody?.message);
      return {
        ok: false,
        code: "provider_rejected",
        status: response.status,
        error: providerMessage
          ? `Email provider rejected the request (${response.status}): ${providerMessage}`
          : `Email provider rejected the request (${response.status}).`,
      };
    }

    return {
      ok: true,
      id:
        typeof responseBody?.id === "string" && responseBody.id.trim()
          ? responseBody.id.trim()
          : null,
    };
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      code: "request_failed",
      error: timedOut
        ? "Email delivery timed out. Please try again."
        : "Email delivery failed. Please try again.",
    };
  }
}
