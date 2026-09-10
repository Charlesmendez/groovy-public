export const CHAT_PRESENCE_ONLINE_WINDOW_MS = 95_000;
export const CHAT_TYPING_TTL_MS = 8_000;
export const CHAT_PROFILE_MAX_AVATAR_BYTES = 3 * 1024 * 1024;

export const QUICK_REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;

export type ChatMemberProfile = {
  user_id: string;
  display_name: string | null;
  avatar_path?: string | null;
  has_avatar?: boolean;
  status_emoji: string | null;
  status_text: string | null;
  status_expires_at: string | null;
  updated_at?: string | null;
};

export type ChatMemberPresence = {
  user_id: string;
  availability: "online" | "away" | "dnd";
  last_active_at: string;
  updated_at?: string | null;
};

export type ChatMessageReaction = {
  id: string;
  channel_id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
};

export type ChatReactionGroup = {
  emoji: string;
  count: number;
  reacted: boolean;
  userIds: string[];
};

export type ChatChannelPin = {
  channel_id: string;
  message_id: string;
  pinned_by: string;
  created_at: string;
};

export type ChatHuddle = {
  id: string;
  channel_id: string;
  started_by: string;
  status: "active" | "ended";
  title: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
};

export type ChatHuddleParticipant = {
  huddle_id: string;
  channel_id: string;
  user_id: string;
  muted: boolean;
  camera_on: boolean;
  screen_sharing: boolean;
  joined_at: string;
  left_at: string | null;
  updated_at: string;
};

export function mergeChatHuddleParticipant(
  current: ChatHuddleParticipant[],
  incoming: ChatHuddleParticipant,
): ChatHuddleParticipant[] {
  const withoutParticipant = current.filter(
    (participant) =>
      participant.huddle_id !== incoming.huddle_id ||
      participant.user_id !== incoming.user_id,
  );
  if (incoming.left_at) return withoutParticipant;
  return [...withoutParticipant, incoming].sort(
    (left, right) =>
      Date.parse(left.joined_at) - Date.parse(right.joined_at) ||
      left.user_id.localeCompare(right.user_id),
  );
}

export function chatHuddlePeerPlan(args: {
  currentUserId: string;
  currentPeerIds: Iterable<string>;
  participants: ChatHuddleParticipant[];
}): {
  activePeerIds: string[];
  closePeerIds: string[];
  offerPeerIds: string[];
} {
  const currentPeerIds = new Set(args.currentPeerIds);
  const activePeerIds = args.participants
    .filter(
      (participant) =>
        !participant.left_at && participant.user_id !== args.currentUserId,
    )
    .map((participant) => participant.user_id);
  const activePeerIdSet = new Set(activePeerIds);
  return {
    activePeerIds,
    closePeerIds: [...currentPeerIds].filter(
      (peerId) => !activePeerIdSet.has(peerId),
    ),
    // The joining browser must offer regardless of UUID ordering. Otherwise a
    // missed participant event on the existing browser leaves both sides
    // waiting forever.
    offerPeerIds: activePeerIds.filter((peerId) => !currentPeerIds.has(peerId)),
  };
}

export type ChatTypingIndicator = {
  channel_id: string;
  user_id: string;
  thread_root_message_id: string | null;
  expires_at: string;
  updated_at: string;
};

export function chatTypingIndicatorFromBroadcast(
  payload: unknown,
  expectedChannelId: string,
): ChatTypingIndicator | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (
    candidate.channel_id !== expectedChannelId ||
    typeof candidate.user_id !== "string" ||
    (candidate.thread_root_message_id !== null &&
      typeof candidate.thread_root_message_id !== "string") ||
    typeof candidate.expires_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.expires_at)) ||
    typeof candidate.updated_at !== "string" ||
    !Number.isFinite(Date.parse(candidate.updated_at))
  ) {
    return null;
  }
  return candidate as ChatTypingIndicator;
}

export function mergeChatTypingIndicator(
  current: ChatTypingIndicator[],
  incoming: ChatTypingIndicator,
): ChatTypingIndicator[] {
  return [
    ...current.filter(
      (candidate) =>
        !(
          candidate.channel_id === incoming.channel_id &&
          candidate.user_id === incoming.user_id &&
          candidate.thread_root_message_id ===
            incoming.thread_root_message_id
        ),
    ),
    incoming,
  ];
}

export function replaceChannelTypingIndicators(
  current: ChatTypingIndicator[],
  channelId: string,
  incoming: ChatTypingIndicator[],
): ChatTypingIndicator[] {
  return [
    ...current.filter((candidate) => candidate.channel_id !== channelId),
    ...incoming.filter((candidate) => candidate.channel_id === channelId),
  ];
}

export function socialSchemaUnavailable(error: {
  code?: string | null;
  message?: string | null;
} | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "PGRST204" ||
    error.code === "PGRST205" ||
    error.message?.includes("chat_member_profiles") === true ||
    error.message?.includes("chat_member_presence") === true ||
    error.message?.includes("chat_typing_indicators") === true ||
    error.message?.includes("chat_message_reactions") === true ||
    error.message?.includes("chat_saved_messages") === true ||
    error.message?.includes("chat_channel_pins") === true ||
    error.message?.includes("chat_huddles") === true ||
    error.message?.includes("chat_huddle_participants") === true ||
    error.message?.includes("chat_huddle_signals") === true
  );
}

export function memberDisplayName(args: {
  email?: string | null;
  profile?: Pick<ChatMemberProfile, "display_name"> | null;
  fallback?: string;
}): string {
  const profileName = args.profile?.display_name?.trim();
  if (profileName) return profileName;
  const emailName = args.email?.split("@")[0]?.trim();
  return emailName || args.fallback || "Teammate";
}

export function memberInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  return `${words[0]?.[0] || ""}${words.length > 1 ? words.at(-1)?.[0] || "" : ""}`
    .toUpperCase()
    .slice(0, 2);
}

export function memberHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function activeCustomStatus(
  profile: ChatMemberProfile | null | undefined,
  now = Date.now(),
): Pick<ChatMemberProfile, "status_emoji" | "status_text"> | null {
  if (!profile || (!profile.status_emoji && !profile.status_text)) return null;
  const expiresAt = profile.status_expires_at
    ? Date.parse(profile.status_expires_at)
    : null;
  if (
    expiresAt !== null &&
    (!Number.isFinite(expiresAt) || expiresAt <= now)
  ) {
    return null;
  }
  return {
    status_emoji: profile.status_emoji,
    status_text: profile.status_text,
  };
}

export function isPresenceOnline(
  presence: ChatMemberPresence | null | undefined,
  now = Date.now(),
): boolean {
  if (!presence || presence.availability === "away") return false;
  const lastActiveAt = Date.parse(presence.last_active_at);
  return (
    Number.isFinite(lastActiveAt) &&
    now - lastActiveAt >= -5_000 &&
    now - lastActiveAt <= CHAT_PRESENCE_ONLINE_WINDOW_MS
  );
}

export function groupMessageReactions(
  reactions: ChatMessageReaction[],
  currentUserId: string,
): ChatReactionGroup[] {
  const groups = new Map<string, ChatReactionGroup>();
  for (const reaction of reactions) {
    const current = groups.get(reaction.emoji) || {
      emoji: reaction.emoji,
      count: 0,
      reacted: false,
      userIds: [],
    };
    current.count += 1;
    current.reacted ||= reaction.user_id === currentUserId;
    current.userIds.push(reaction.user_id);
    groups.set(reaction.emoji, current);
  }
  return Array.from(groups.values()).sort(
    (left, right) =>
      right.count - left.count || left.emoji.localeCompare(right.emoji),
  );
}

export function typingLabel(names: string[]): string | null {
  const unique = Array.from(new Set(names.filter(Boolean)));
  if (unique.length === 0) return null;
  if (unique.length === 1) return `${unique[0]} is typing`;
  if (unique.length === 2) return `${unique[0]} and ${unique[1]} are typing`;
  return `${unique[0]}, ${unique[1]}, and ${unique.length - 2} more are typing`;
}
