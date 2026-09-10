import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  defaultChatNotificationMode,
  defaultChatNotificationPreferenceRows,
  ensureDefaultChatNotificationPreferences,
  notificationPreferencesSchemaUnavailable,
} from "./defaults";

test("new channels default to mentions and DMs default to all messages", () => {
  assert.equal(defaultChatNotificationMode("channel"), "mentions");
  assert.equal(defaultChatNotificationMode("dm"), "all");
});

test("default preference rows are normalized and deduplicated", () => {
  assert.deepEqual(
    defaultChatNotificationPreferenceRows({
      channelId: "channel-1",
      kind: "dm",
      userIds: [" user-1 ", "user-2", "user-1", ""],
    }),
    [
      { user_id: "user-1", channel_id: "channel-1", mode: "all" },
      { user_id: "user-2", channel_id: "channel-1", mode: "all" },
    ],
  );
});

test("default insertion ignores conflicts so explicit personal choices survive", async () => {
  const calls: Array<{
    table: string;
    rows: unknown;
    options: unknown;
  }> = [];
  const admin = {
    from: (table: string) => ({
      upsert: async (rows: unknown, options: unknown) => {
        calls.push({ table, rows, options });
        return { error: null };
      },
    }),
  } as unknown as SupabaseClient;

  const result = await ensureDefaultChatNotificationPreferences({
    admin,
    channelId: "channel-1",
    kind: "channel",
    userIds: ["user-1"],
  });

  assert.deepEqual(result, { error: null, applied: true });
  assert.deepEqual(calls, [
    {
      table: "chat_notification_preferences",
      rows: [
        {
          user_id: "user-1",
          channel_id: "channel-1",
          mode: "mentions",
        },
      ],
      options: {
        onConflict: "user_id,channel_id",
        ignoreDuplicates: true,
      },
    },
  ]);
});

test("notification preference migration errors are recognized", () => {
  assert.equal(
    notificationPreferencesSchemaUnavailable({
      code: "42P01",
      message: 'relation "chat_notification_preferences" does not exist',
    }),
    true,
  );
  assert.equal(
    notificationPreferencesSchemaUnavailable({
      code: "23505",
      message: "duplicate key",
    }),
    false,
  );
});
