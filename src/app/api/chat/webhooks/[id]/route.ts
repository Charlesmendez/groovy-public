import { decryptLlmApiKey } from "@/lib/crypto/llmKey";
import {
  IncomingWebhookError,
  readWebhookJson,
} from "@/lib/chat/incomingWebhook";
import {
  deliverIncomingWebhook,
  newWebhookCredential,
  WEBHOOK_PUBLIC_COLUMNS,
  webhookErrorResponse,
  webhookJson,
  webhookSettingsContext,
  webhookUrl,
} from "@/lib/chat/incomingWebhookServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { admin, workspaceId, channels } = await webhookSettingsContext();
    const { id } = await params;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      ) ||
      channels.length === 0
    ) {
      throw new IncomingWebhookError("not_found", "Webhook not found.", 404);
    }
    const { data: hook, error } = await admin
      .from("chat_incoming_webhooks")
      .select(`${WEBHOOK_PUBLIC_COLUMNS},token_enc,token_hash`)
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .in(
        "channel_id",
        channels.map((channel) => channel.id),
      )
      .is("revoked_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!hook)
      throw new IncomingWebhookError("not_found", "Webhook not found.", 404);
    const body = (await readWebhookJson(request)) as {
      operation?: unknown;
    } | null;
    if (body?.operation === "url") {
      return webhookJson({
        url: webhookUrl(request, decryptLlmApiKey(hook.token_enc)),
      });
    }
    if (body?.operation === "test") {
      return await deliverIncomingWebhook({
        admin,
        tokenHash: hook.token_hash,
        text: `You're connected! ${hook.name} can now send messages to this channel.`,
        eventId: null,
      });
    }
    let patch: Record<string, unknown>;
    let url: string | undefined;
    switch (body?.operation) {
      case "pause":
        patch = { enabled: false };
        break;
      case "resume":
        patch = { enabled: true };
        break;
      case "revoke":
        patch = {
          enabled: false,
          revoked_at: new Date().toISOString(),
          token_enc: "",
        };
        break;
      case "rotate": {
        const credential = newWebhookCredential();
        patch = {
          token_hash: credential.token_hash,
          token_enc: credential.token_enc,
        };
        url = webhookUrl(request, credential.token);
        break;
      }
      default:
        throw new IncomingWebhookError(
          "invalid_operation",
          "Choose a valid webhook action.",
        );
    }
    const { data, error: updateError } = await admin
      .from("chat_incoming_webhooks")
      .update(patch)
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .is("revoked_at", null)
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .maybeSingle();
    if (updateError) throw updateError;
    if (!data)
      throw new IncomingWebhookError(
        "not_found",
        "This webhook was removed. Refresh the page.",
        404,
      );
    return webhookJson({ ok: true, webhook: data, ...(url ? { url } : {}) });
  } catch (error) {
    return webhookErrorResponse(error);
  }
}
