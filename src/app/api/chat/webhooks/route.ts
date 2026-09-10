import {
  IncomingWebhookError,
  readWebhookJson,
  WEBHOOK_NAME_LIMIT,
} from "@/lib/chat/incomingWebhook";
import {
  newWebhookCredential,
  WEBHOOK_PUBLIC_COLUMNS,
  webhookErrorResponse,
  webhookJson,
  webhookSettingsContext,
  webhookUrl,
} from "@/lib/chat/incomingWebhookServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { admin, workspaceId, channels } = await webhookSettingsContext();
    const { data, error } = channels.length
      ? await admin
          .from("chat_incoming_webhooks")
          .select(WEBHOOK_PUBLIC_COLUMNS)
          .eq("workspace_id", workspaceId)
          .in(
            "channel_id",
            channels.map((channel) => channel.id),
          )
          .is("revoked_at", null)
          .order("created_at", { ascending: false })
      : { data: [], error: null };
    if (error) throw error;
    return webhookJson({ channels, webhooks: data || [] });
  } catch (error) {
    return webhookErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { admin, workspaceId, userId, channels } =
      await webhookSettingsContext();
    const body = (await readWebhookJson(request)) as {
      channelId?: unknown;
      name?: unknown;
    } | null;
    const channel = channels.find((item) => item.id === body?.channelId);
    if (!channel)
      throw new IncomingWebhookError(
        "forbidden",
        "Choose a channel you manage.",
        403,
      );
    if (body?.name !== undefined && typeof body.name !== "string") {
      throw new IncomingWebhookError(
        "invalid_name",
        "Use a short name for this service.",
      );
    }
    const name =
      (typeof body?.name === "string" ? body.name.trim() : "") ||
      "Service updates";
    if (
      name.length > WEBHOOK_NAME_LIMIT ||
      /[\u0000-\u001f\u007f]/.test(name)
    ) {
      throw new IncomingWebhookError(
        "invalid_name",
        "Use a name of 60 characters or less, without line breaks.",
      );
    }
    const credential = newWebhookCredential();
    const { data, error } = await admin
      .from("chat_incoming_webhooks")
      .insert({
        workspace_id: workspaceId,
        channel_id: channel.id,
        created_by: userId,
        name,
        token_hash: credential.token_hash,
        token_enc: credential.token_enc,
      })
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .single();
    if (error) throw error;
    return webhookJson(
      { webhook: data, url: webhookUrl(request, credential.token) },
      201,
    );
  } catch (error) {
    return webhookErrorResponse(error);
  }
}
