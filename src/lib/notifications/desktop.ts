import type { DesktopChatNotification } from "../desktop/shell";
import {
  messageMentionsRecipient,
  notificationExcerpt,
  type ChatNotificationMode,
} from "./push";

export type DesktopNotificationChannel = {
  id: string;
  kind: "channel" | "dm";
  name: string;
  profile_id?: string | null;
};

export type DesktopNotificationMessage = {
  id: string;
  channel_id: string;
  author_type: "user" | "orchestrator" | "agent" | "system";
  author_user_id: string | null;
  author_agent_id: string | null;
  profile_id: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type DesktopNotificationCursor = {
  createdAt: string;
  recentIds: string[];
};

export function advanceDesktopNotificationCursor(
  state: DesktopNotificationCursor,
  message: Pick<DesktopNotificationMessage, "id" | "created_at">,
  maximumIds = 500,
): DesktopNotificationCursor {
  const recentIds = [
    ...state.recentIds.filter((id) => id !== message.id),
    message.id,
  ].slice(-Math.max(1, maximumIds));
  return {
    createdAt:
      message.created_at > state.createdAt ? message.created_at : state.createdAt,
    recentIds,
  };
}

function metadataLabel(
  metadata: Record<string, unknown> | null,
  keys: string[],
): string {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 80);
    }
  }
  return "";
}

function emailLabel(email: string): string {
  const local = email.split("@")[0]?.trim() || "";
  if (!local) return "Teammate";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function desktopNotificationForMessage(args: {
  message: DesktopNotificationMessage;
  channel: DesktopNotificationChannel;
  mode: ChatNotificationMode;
  currentUserId: string;
  currentUserEmail?: string | null;
  activeRoomVisible: boolean;
  messageAlreadyRead?: boolean;
  agentNames: ReadonlyMap<string, string>;
  profileNames: ReadonlyMap<string, string>;
  memberEmails: ReadonlyMap<string, string>;
}): DesktopChatNotification | null {
  const { message, channel } = args;
  if (
    args.mode === "off" ||
    (message.author_type === "user" &&
      message.author_user_id === args.currentUserId) ||
    args.activeRoomVisible ||
    args.messageAlreadyRead === true
  ) {
    return null;
  }
  if (
    args.mode === "mentions" &&
    !messageMentionsRecipient({
      content: message.content,
      email: args.currentUserEmail,
    })
  ) {
    return null;
  }

  let authorLabel = metadataLabel(message.metadata, [
    "author_name",
    "agent_name",
    "profile_name",
    "orchestrator_name",
  ]);
  if (!authorLabel && message.author_type === "agent") {
    authorLabel =
      (message.author_agent_id
        ? args.agentNames.get(message.author_agent_id)
        : "") || "Agent";
  } else if (!authorLabel && message.author_type === "orchestrator") {
    authorLabel =
      (message.profile_id ? args.profileNames.get(message.profile_id) : "") ||
      (channel.profile_id
        ? args.profileNames.get(channel.profile_id)
        : "") ||
      "Groovy";
  } else if (!authorLabel && message.author_type === "user") {
    const email = message.author_user_id
      ? args.memberEmails.get(message.author_user_id)
      : "";
    authorLabel = email ? emailLabel(email) : "Teammate";
  } else if (!authorLabel) {
    authorLabel = "System";
  }

  const roomLabel =
    channel.kind === "channel" ? `#${channel.name}` : channel.name;
  return {
    messageId: message.id,
    channelId: channel.id,
    title: `${roomLabel} · ${authorLabel}`,
    body: notificationExcerpt(message.content) || "New message",
    url: `/chat/${channel.id}`,
  };
}

export function isRoomActivelyVisible(channelId: string): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  return (
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    window.location.pathname === `/chat/${channelId}`
  );
}
