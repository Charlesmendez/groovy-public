import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  isMessageUnreadAtCursor,
  isSameOriginMutation,
  parseBrowserPushSubscription,
  parseChatNotificationMode,
} from "@/lib/notifications/push";
import { getWebPushPublicKey } from "@/lib/notifications/webPush";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(
  body: Record<string, unknown>,
  init?: ResponseInit,
): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function migrationPending(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    Boolean(
      error.message?.includes("web_push_subscriptions") ||
        error.message?.includes("chat_notification_preferences"),
    )
  );
}

function readStateMigrationPending(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    error.message?.includes("chat_channel_read_states") === true
  );
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });

  const searchParams = new URL(req.url).searchParams;
  const channelId = searchParams.get("channelId");
  const messageId = searchParams.get("messageId");
  if (channelId && !UUID_PATTERN.test(channelId)) {
    return json({ error: "Invalid channelId" }, { status: 400 });
  }
  if (messageId && !UUID_PATTERN.test(messageId)) {
    return json({ error: "Invalid messageId" }, { status: 400 });
  }
  if (messageId && !channelId) {
    return json(
      { error: "channelId is required with messageId" },
      { status: 400 },
    );
  }
  if (messageId && channelId) {
    const { data: message, error: messageError } = await supabase
      .from("chat_messages")
      .select("id,channel_id,author_type,author_user_id,created_at")
      .eq("id", messageId)
      .eq("channel_id", channelId)
      .maybeSingle();
    if (messageError) {
      return json({ error: messageError.message }, { status: 500 });
    }
    if (!message) {
      return json({ shouldNotify: false });
    }
    if (
      message.author_type === "user" &&
      message.author_user_id === user.id
    ) {
      return json({ shouldNotify: false });
    }
    const { data: readState, error: readStateError } = await supabase
      .from("chat_channel_read_states")
      .select("last_read_at")
      .eq("channel_id", channelId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (readStateError) {
      if (readStateMigrationPending(readStateError)) {
        return json({ shouldNotify: true, readStateUnavailable: true });
      }
      return json({ error: readStateError.message }, { status: 500 });
    }
    return json({
      shouldNotify: isMessageUnreadAtCursor({
        messageCreatedAt: message.created_at,
        lastReadAt: readState?.last_read_at,
      }),
    });
  }
  const preferenceQuery = supabase
    .from("chat_notification_preferences")
    .select("channel_id,mode,updated_at")
    .eq("user_id", user.id);
  if (channelId) preferenceQuery.eq("channel_id", channelId);

  const [preferencesResult, subscriptionsResult] = await Promise.all([
    preferenceQuery,
    supabase
      .from("web_push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id),
  ]);
  const pending =
    (preferencesResult.error &&
      migrationPending(preferencesResult.error)) ||
    (subscriptionsResult.error &&
      migrationPending(subscriptionsResult.error));
  if (pending) {
    return json({
      configured: Boolean(getWebPushPublicKey()),
      publicKey: getWebPushPublicKey(),
      migrationPending: true,
      subscriptionCount: 0,
      preferences: [],
    });
  }
  if (preferencesResult.error || subscriptionsResult.error) {
    return json(
      {
        error:
          preferencesResult.error?.message ||
          subscriptionsResult.error?.message ||
          "Could not load notification settings",
      },
      { status: 500 },
    );
  }

  const publicKey = getWebPushPublicKey();
  return json({
    configured: Boolean(publicKey),
    publicKey,
    migrationPending: false,
    subscriptionCount: subscriptionsResult.count || 0,
    preferences: preferencesResult.data || [],
  });
}

export async function POST(req: Request) {
  if (!isSameOriginMutation(req)) {
    return json({ error: "Cross-origin request denied" }, { status: 403 });
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body.action !== "string") {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  if (body.action === "subscribe") {
    if (!getWebPushPublicKey()) {
      return json(
        { error: "Web Push is not configured on this deployment" },
        { status: 503 },
      );
    }
    const parsed = parseBrowserPushSubscription(body.subscription);
    if (!parsed.ok) {
      return json({ error: parsed.error }, { status: 400 });
    }
    const admin = createSupabaseAdminClient();
    const { data: existing, error: existingError } = await admin
      .from("web_push_subscriptions")
      .select("id,user_id,p256dh,auth")
      .eq("endpoint", parsed.value.endpoint)
      .maybeSingle();
    if (existingError && migrationPending(existingError)) {
      return json(
        { error: "Browser notifications are still being activated" },
        { status: 503 },
      );
    }
    if (existingError) {
      return json({ error: existingError.message }, { status: 500 });
    }
    if (
      existing &&
      existing.user_id !== user.id &&
      (existing.p256dh !== parsed.value.keys.p256dh ||
        existing.auth !== parsed.value.keys.auth)
    ) {
      return json(
        {
          error:
            "This browser subscription belongs to another account. Turn browser notifications off and retry.",
        },
        { status: 409 },
      );
    }
    if (existing && existing.user_id !== user.id) {
      await admin
        .from("web_push_subscriptions")
        .delete()
        .eq("id", existing.id);
    }
    const deviceLabel =
      typeof body.deviceLabel === "string"
        ? body.deviceLabel.trim().slice(0, 100)
        : null;
    const { error } = await admin.from("web_push_subscriptions").upsert(
      {
        user_id: user.id,
        endpoint: parsed.value.endpoint,
        p256dh: parsed.value.keys.p256dh,
        auth: parsed.value.keys.auth,
        expiration_time: parsed.value.expirationTime,
        device_label: deviceLabel || null,
        user_agent: req.headers.get("user-agent")?.slice(0, 500) || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "endpoint" },
    );
    if (error) {
      return json(
        {
          error: migrationPending(error)
            ? "Browser notifications are still being activated"
            : error.message,
        },
        { status: migrationPending(error) ? 503 : 500 },
      );
    }
    return json({ ok: true });
  }

  if (body.action === "unsubscribe") {
    const endpoint =
      typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      return json({ error: "Invalid endpoint" }, { status: 400 });
    }
    if (parsedEndpoint.protocol !== "https:" || endpoint.length > 2048) {
      return json({ error: "Invalid endpoint" }, { status: 400 });
    }
    const { error } = await supabase
      .from("web_push_subscriptions")
      .delete()
      .eq("user_id", user.id)
      .eq("endpoint", endpoint);
    if (error && !migrationPending(error)) {
      return json({ error: error.message }, { status: 500 });
    }
    return json({ ok: true });
  }

  if (body.action === "preference") {
    const channelId =
      typeof body.channelId === "string" ? body.channelId.trim() : "";
    const mode = parseChatNotificationMode(body.mode);
    if (!UUID_PATTERN.test(channelId) || !mode) {
      return json(
        { error: "A valid channelId and notification mode are required" },
        { status: 400 },
      );
    }
    const { data: channel, error: channelError } = await supabase
      .from("chat_channels")
      .select("id,kind")
      .eq("id", channelId)
      .maybeSingle();
    if (channelError) {
      return json({ error: channelError.message }, { status: 500 });
    }
    if (!channel) {
      return json({ error: "Room not found or no longer accessible" }, {
        status: 404,
      });
    }
    if (channel.kind === "dm" && mode === "mentions") {
      return json(
        { error: "Direct messages support all messages or muted" },
        { status: 400 },
      );
    }
    const { error } = await supabase
      .from("chat_notification_preferences")
      .upsert(
        {
          user_id: user.id,
          channel_id: channelId,
          mode,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,channel_id" },
      );
    if (error) {
      return json(
        {
          error: migrationPending(error)
            ? "Browser notifications are still being activated"
            : error.message,
        },
        { status: migrationPending(error) ? 503 : 500 },
      );
    }
    return json({ ok: true, channelId, mode });
  }

  return json({ error: "Unsupported notification action" }, { status: 400 });
}
