import { sha256Hex } from "@/lib/crypto/llmKey";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  IncomingWebhookError,
  parseWebhookEventId,
  parseWebhookText,
  readWebhookJson,
} from "@/lib/chat/incomingWebhook";
import {
  deliverIncomingWebhook,
  webhookErrorResponse,
} from "@/lib/chat/incomingWebhookServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    if (!/^gwh_[a-f0-9]{64}$/.test(token)) {
      throw new IncomingWebhookError(
        "webhook_not_found",
        "This webhook URL is not valid.",
        404,
      );
    }
    const eventId = parseWebhookEventId(request.headers.get("idempotency-key"));
    const text = parseWebhookText(await readWebhookJson(request));
    return await deliverIncomingWebhook({
      admin: createSupabaseAdminClient(),
      tokenHash: sha256Hex(token),
      text,
      eventId,
    });
  } catch (error) {
    return webhookErrorResponse(error);
  }
}
