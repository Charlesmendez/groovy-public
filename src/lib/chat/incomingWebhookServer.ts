import { randomBytes } from "node:crypto";
import { after, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAppBaseUrl } from "@/lib/appBaseUrl";
import { getWorkspaceMembershipForUser } from "@/lib/billing/state";
import { canManageChannelSkills } from "@/lib/chat/channelSkills";
import { encryptLlmApiKey, sha256Hex } from "@/lib/crypto/llmKey";
import { sendTeamChatPush } from "@/lib/notifications/webPush";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  buildIncomingWebhookUrl,
  IncomingWebhookError,
} from "./incomingWebhook";

export const WEBHOOK_PUBLIC_COLUMNS =
  "id,channel_id,name,enabled,created_at,last_received_at,message_count";

export type WebhookChannel = {
  id: string;
  name: string;
  visibility: string;
  created_by: string;
};

export async function webhookSettingsContext() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    throw new IncomingWebhookError(
      "unauthorized",
      "Sign in to manage webhooks.",
      401,
    );
  const admin = createSupabaseAdminClient();
  const membership = await getWorkspaceMembershipForUser({
    admin,
    userId: user.id,
  });
  if (!membership || membership.role === "guest") {
    throw new IncomingWebhookError(
      "forbidden",
      "Only workspace members can manage webhooks.",
      403,
    );
  }
  const { data, error } = await supabase
    .from("chat_channels")
    .select("id,name,visibility,created_by")
    .eq("workspace_id", membership.workspace_id)
    .eq("kind", "channel")
    .eq("is_archived", false)
    .order("name");
  if (error) throw error;
  const channels = ((data || []) as WebhookChannel[]).filter((channel) =>
    canManageChannelSkills({
      actorUserId: user.id,
      channelCreatedBy: channel.created_by,
      workspaceRole: membership.role,
    }),
  );
  return {
    admin,
    userId: user.id,
    workspaceId: membership.workspace_id,
    channels,
  };
}

export function newWebhookCredential() {
  const token = `gwh_${randomBytes(32).toString("hex")}`;
  return {
    token,
    token_hash: sha256Hex(token),
    token_enc: encryptLlmApiKey(token),
  };
}

export function webhookUrl(request: Request, token: string): string {
  const origin = resolveAppBaseUrl(request) || new URL(request.url).origin;
  return buildIncomingWebhookUrl(origin, token);
}

export function webhookJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
  });
}

export function webhookErrorResponse(error: unknown) {
  if (error instanceof IncomingWebhookError) {
    return webhookJson(
      { ok: false, error: error.code, message: error.message },
      error.status,
    );
  }
  // Never log a request URL, supplied token, payload, or encrypted credential.
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "unknown";
  console.error("[incoming-webhook] request failed", { code });
  return webhookJson(
    {
      ok: false,
      error: "service_unavailable",
      message:
        "Webhooks are temporarily unavailable. Please try again shortly.",
    },
    503,
  );
}

export async function deliverIncomingWebhook(args: {
  admin: SupabaseClient;
  tokenHash: string;
  text: string;
  eventId: string | null;
}) {
  const { data, error } = await args.admin.rpc(
    "deliver_chat_incoming_webhook",
    {
      p_token_hash: args.tokenHash,
      p_text: args.text,
      p_event_id: args.eventId,
    },
  );
  if (error) throw error;
  if (!data || typeof data !== "object")
    throw new Error("Missing delivery receipt");
  const result = data as Record<string, unknown>;
  if (result.error) {
    const errors: Record<string, [number, string]> = {
      webhook_not_found: [
        404,
        "This webhook URL is no longer valid. Copy its current URL from Settings → Webhooks.",
      ],
      webhook_paused: [
        403,
        "This webhook is paused. Resume it in Settings → Webhooks.",
      ],
      channel_unavailable: [
        403,
        "This webhook no longer has access to its channel. Ask a channel manager to create a new one.",
      ],
      invalid_text: [400, "Send a text string containing 1–40,000 characters."],
      invalid_idempotency_key: [
        400,
        "Use 1–128 visible ASCII characters for Idempotency-Key.",
      ],
      idempotency_conflict: [
        409,
        "This Idempotency-Key was already used for different text.",
      ],
      rate_limited: [
        429,
        "This webhook accepts 60 messages per minute. Retry after the delay in Retry-After.",
      ],
    };
    const code = String(result.error);
    const [status, message] = errors[code] || [
      503,
      "Message delivery is temporarily unavailable.",
    ];
    return webhookJson(
      { ok: false, error: code, message },
      status,
      status === 429
        ? { "Retry-After": String(Number(result.retry_after) || 60) }
        : {},
    );
  }
  if (!result.duplicate) {
    after(async () => {
      try {
        await sendTeamChatPush({
          admin: args.admin,
          channelId: String(result.channel_id),
          messageId: String(result.message_id),
          authorType: "system",
          authorLabel: String(result.name),
          content: args.text,
        });
      } catch {
        console.warn("[incoming-webhook] notification delivery failed");
      }
    });
  }
  return webhookJson({
    ok: true,
    message_id: result.message_id,
    channel_id: result.channel_id,
    duplicate: result.duplicate === true,
  });
}
