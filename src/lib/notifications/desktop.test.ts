import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceDesktopNotificationCursor,
  desktopNotificationForMessage,
  type DesktopNotificationMessage,
} from "./desktop";

const message: DesktopNotificationMessage = {
  id: "11111111-1111-4111-8111-111111111111",
  channel_id: "22222222-2222-4222-8222-222222222222",
  author_type: "agent",
  author_user_id: null,
  author_agent_id: "33333333-3333-4333-8333-333333333333",
  profile_id: null,
  content: "The analysis is ready.",
  metadata: {},
  created_at: "2026-07-24T16:00:00.000Z",
};

const base = {
  message,
  channel: {
    id: message.channel_id,
    kind: "channel" as const,
    name: "launch",
    profile_id: null,
  },
  mode: "all" as const,
  currentUserId: "44444444-4444-4444-8444-444444444444",
  currentUserEmail: "carlos@example.com",
  activeRoomVisible: false,
  agentNames: new Map([[message.author_agent_id!, "Researcher"]]),
  profileNames: new Map<string, string>(),
  memberEmails: new Map<string, string>(),
};

test("desktop notifications use room and resolved author labels", () => {
  assert.deepEqual(desktopNotificationForMessage(base), {
    messageId: message.id,
    channelId: message.channel_id,
    title: "#launch · Researcher",
    body: "The analysis is ready.",
    url: `/chat/${message.channel_id}`,
  });
});

test("desktop notifications suppress own messages, muted rooms, and active rooms", () => {
  assert.equal(
    desktopNotificationForMessage({
      ...base,
      message: {
        ...message,
        author_type: "user",
        author_user_id: base.currentUserId,
      },
    }),
    null,
  );
  assert.equal(
    desktopNotificationForMessage({ ...base, mode: "off" }),
    null,
  );
  assert.equal(
    desktopNotificationForMessage({ ...base, activeRoomVisible: true }),
    null,
  );
  assert.equal(
    desktopNotificationForMessage({ ...base, messageAlreadyRead: true }),
    null,
  );
});

test("mention-only mode only alerts the addressed recipient", () => {
  assert.equal(
    desktopNotificationForMessage({
      ...base,
      mode: "mentions",
      message: { ...message, content: "This is for @carlos." },
    })?.messageId,
    message.id,
  );
  assert.equal(
    desktopNotificationForMessage({
      ...base,
      mode: "mentions",
      message: { ...message, content: "This is for @daniel." },
    }),
    null,
  );
});

test("desktop cursor advancement is monotonic and keeps bounded dedupe ids", () => {
  const afterNew = advanceDesktopNotificationCursor(
    {
      createdAt: "2026-07-24T16:00:00.000Z",
      recentIds: ["old", "duplicate"],
    },
    {
      id: "duplicate",
      created_at: "2026-07-24T16:01:00.000Z",
    },
    2,
  );
  assert.deepEqual(afterNew, {
    createdAt: "2026-07-24T16:01:00.000Z",
    recentIds: ["old", "duplicate"],
  });
  assert.deepEqual(
    advanceDesktopNotificationCursor(
      afterNew,
      { id: "new", created_at: "2026-07-24T15:59:00.000Z" },
      2,
    ),
    {
      createdAt: "2026-07-24T16:01:00.000Z",
      recentIds: ["duplicate", "new"],
    },
  );
});
