import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatNotificationMode } from "@/lib/notifications/push";

type ChatRoomKind = "channel" | "dm";

type NotificationPreferenceError = {
  code?: string | null;
  message?: string | null;
};

export function defaultChatNotificationMode(
  kind: ChatRoomKind,
): ChatNotificationMode {
  return kind === "dm" ? "all" : "mentions";
}

export function defaultChatNotificationPreferenceRows(args: {
  channelId: string;
  kind: ChatRoomKind;
  userIds: Iterable<string>;
}): Array<{
  user_id: string;
  channel_id: string;
  mode: ChatNotificationMode;
}> {
  const userIds = Array.from(
    new Set(
      Array.from(args.userIds)
        .map((userId) => userId.trim())
        .filter(Boolean),
    ),
  );
  const mode = defaultChatNotificationMode(args.kind);
  return userIds.map((userId) => ({
    user_id: userId,
    channel_id: args.channelId,
    mode,
  }));
}

export function notificationPreferencesSchemaUnavailable(
  error: NotificationPreferenceError,
): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    error.message?.includes("chat_notification_preferences") === true
  );
}

/**
 * Adds only missing defaults. `ignoreDuplicates` is deliberate: an existing
 * `off`, `mentions`, or `all` row is a personal choice and must never be
 * overwritten by room creation or a later DM.
 */
export async function ensureDefaultChatNotificationPreferences(args: {
  admin: SupabaseClient;
  channelId: string;
  kind: ChatRoomKind;
  userIds: Iterable<string>;
}): Promise<{ error: NotificationPreferenceError | null; applied: boolean }> {
  const rows = defaultChatNotificationPreferenceRows(args);
  if (rows.length === 0) return { error: null, applied: false };
  const { error } = await args.admin
    .from("chat_notification_preferences")
    .upsert(rows, {
      onConflict: "user_id,channel_id",
      ignoreDuplicates: true,
    });
  return {
    error,
    applied: !error,
  };
}
