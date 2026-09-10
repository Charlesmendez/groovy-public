import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_PRESENCE_ONLINE_WINDOW_MS,
  activeCustomStatus,
  chatHuddlePeerPlan,
  chatTypingIndicatorFromBroadcast,
  groupMessageReactions,
  isPresenceOnline,
  memberDisplayName,
  memberInitials,
  mergeChatHuddleParticipant,
  mergeChatTypingIndicator,
  replaceChannelTypingIndicators,
  socialSchemaUnavailable,
  typingLabel,
  type ChatMemberProfile,
  type ChatHuddleParticipant,
  type ChatMessageReaction,
  type ChatTypingIndicator,
} from "./social";

const huddleParticipant = (
  userId: string,
  patch: Partial<ChatHuddleParticipant> = {},
): ChatHuddleParticipant => ({
  huddle_id: "11111111-1111-4111-8111-111111111111",
  channel_id: "22222222-2222-4222-8222-222222222222",
  user_id: userId,
  muted: true,
  camera_on: false,
  screen_sharing: false,
  joined_at: "2026-08-24T20:00:00.000Z",
  left_at: null,
  updated_at: "2026-08-24T20:00:00.000Z",
  ...patch,
});

const profile: ChatMemberProfile = {
  user_id: "user-1",
  display_name: "  Charles Mendez  ",
  status_emoji: "🎯",
  status_text: "Shipping",
  status_expires_at: null,
};

test("chat identity prefers a custom profile and creates compact initials", () => {
  assert.equal(
    memberDisplayName({
      email: "fallback@example.com",
      profile,
    }),
    "Charles Mendez",
  );
  assert.equal(memberInitials("Charles Mendez"), "CM");
  assert.equal(memberInitials("joh.berrio"), "JB");
});

test("custom status honors optional expiration", () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  assert.deepEqual(activeCustomStatus(profile, now), {
    status_emoji: "🎯",
    status_text: "Shipping",
  });
  assert.equal(
    activeCustomStatus(
      {
        ...profile,
        status_expires_at: "2026-07-26T11:59:59.000Z",
      },
      now,
    ),
    null,
  );
});

test("presence requires a fresh heartbeat and respects away state", () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  assert.equal(
    isPresenceOnline(
      {
        user_id: "user-1",
        availability: "online",
        last_active_at: new Date(now - CHAT_PRESENCE_ONLINE_WINDOW_MS).toISOString(),
      },
      now,
    ),
    true,
  );
  assert.equal(
    isPresenceOnline(
      {
        user_id: "user-1",
        availability: "away",
        last_active_at: new Date(now).toISOString(),
      },
      now,
    ),
    false,
  );
});

test("huddle participant realtime rows appear immediately and leave cleanly", () => {
  const first = huddleParticipant("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const second = huddleParticipant("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
    joined_at: "2026-08-24T20:00:01.000Z",
  });
  const joined = mergeChatHuddleParticipant([first], second);
  assert.deepEqual(
    joined.map((participant) => participant.user_id),
    [first.user_id, second.user_id],
  );
  assert.deepEqual(
    mergeChatHuddleParticipant(joined, {
      ...second,
      left_at: "2026-08-24T20:00:02.000Z",
    }),
    [first],
  );
});

test("a joining huddle browser offers to existing peers regardless of UUID order", () => {
  const currentUserId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const existingPeer = huddleParticipant(
    "11111111-1111-4111-8111-111111111111",
  );
  assert.deepEqual(
    chatHuddlePeerPlan({
      currentUserId,
      currentPeerIds: [],
      participants: [huddleParticipant(currentUserId), existingPeer],
    }),
    {
      activePeerIds: [existingPeer.user_id],
      closePeerIds: [],
      offerPeerIds: [existingPeer.user_id],
    },
  );
  assert.deepEqual(
    chatHuddlePeerPlan({
      currentUserId,
      currentPeerIds: [existingPeer.user_id, "stale-peer"],
      participants: [huddleParticipant(currentUserId), existingPeer],
    }),
    {
      activePeerIds: [existingPeer.user_id],
      closePeerIds: ["stale-peer"],
      offerPeerIds: [],
    },
  );
});

test("reactions group by emoji and track the current teammate", () => {
  const reactions: ChatMessageReaction[] = [
    {
      id: "1",
      channel_id: "channel",
      message_id: "message",
      user_id: "me",
      emoji: "👍",
      created_at: "2026-07-26T12:00:00.000Z",
    },
    {
      id: "2",
      channel_id: "channel",
      message_id: "message",
      user_id: "other",
      emoji: "👍",
      created_at: "2026-07-26T12:00:01.000Z",
    },
    {
      id: "3",
      channel_id: "channel",
      message_id: "message",
      user_id: "other",
      emoji: "🎉",
      created_at: "2026-07-26T12:00:02.000Z",
    },
  ];
  assert.deepEqual(groupMessageReactions(reactions, "me"), [
    {
      emoji: "👍",
      count: 2,
      reacted: true,
      userIds: ["me", "other"],
    },
    {
      emoji: "🎉",
      count: 1,
      reacted: false,
      userIds: ["other"],
    },
  ]);
});

test("typing copy is compact and migration detection is table-specific", () => {
  assert.equal(typingLabel(["Daniel", "Daniel"]), "Daniel is typing");
  assert.equal(
    typingLabel(["Daniel", "Joh", "Charles"]),
    "Daniel, Joh, and 1 more are typing",
  );
  assert.equal(
    socialSchemaUnavailable({
      code: "PGRST205",
      message: "chat_message_reactions is missing",
    }),
    true,
  );
  assert.equal(
    socialSchemaUnavailable({ code: "23505", message: "duplicate key" }),
    false,
  );
});

test("typing broadcasts are channel-bound and replace the matching scope", () => {
  const mainTyping: ChatTypingIndicator = {
    channel_id: "channel-1",
    user_id: "user-2",
    thread_root_message_id: null,
    expires_at: "2026-08-04T14:00:08.000Z",
    updated_at: "2026-08-04T14:00:00.000Z",
  };
  assert.deepEqual(
    chatTypingIndicatorFromBroadcast(mainTyping, "channel-1"),
    mainTyping,
  );
  assert.equal(
    chatTypingIndicatorFromBroadcast(mainTyping, "channel-2"),
    null,
  );
  assert.equal(
    chatTypingIndicatorFromBroadcast(
      { ...mainTyping, expires_at: "not-a-date" },
      "channel-1",
    ),
    null,
  );

  const stoppedTyping = {
    ...mainTyping,
    expires_at: "1970-01-01T00:00:00.000Z",
    updated_at: "2026-08-04T14:00:01.000Z",
  };
  assert.deepEqual(
    mergeChatTypingIndicator(
      [
        mainTyping,
        {
          ...mainTyping,
          thread_root_message_id: "thread-1",
        },
      ],
      stoppedTyping,
    ),
    [
      {
        ...mainTyping,
        thread_root_message_id: "thread-1",
      },
      stoppedTyping,
    ],
  );
});

test("desktop typing reconciliation replaces only the active channel", () => {
  const active: ChatTypingIndicator = {
    channel_id: "channel-1",
    user_id: "user-2",
    thread_root_message_id: null,
    expires_at: "2026-08-04T14:00:08.000Z",
    updated_at: "2026-08-04T14:00:00.000Z",
  };
  const other = { ...active, channel_id: "channel-2", user_id: "user-3" };
  const refreshed = {
    ...active,
    expires_at: "2026-08-04T14:00:11.000Z",
    updated_at: "2026-08-04T14:00:03.000Z",
  };

  assert.deepEqual(
    replaceChannelTypingIndicators([active, other], "channel-1", [refreshed]),
    [other, refreshed],
  );
  assert.deepEqual(
    replaceChannelTypingIndicators([active, other], "channel-1", []),
    [other],
  );
});
