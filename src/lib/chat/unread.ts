export type IncomingUnreadDisposition = "ignore" | "read" | "unread";

export function normalizeUnreadCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export function incomingUnreadDisposition(args: {
  channelId: unknown;
  authorType: unknown;
  authorUserId: unknown;
  currentUserId: string;
  activeChannelId: string | null;
  documentVisible: boolean;
}): IncomingUnreadDisposition {
  if (typeof args.channelId !== "string" || !args.channelId) return "ignore";
  if (
    args.authorType === "user" &&
    args.authorUserId === args.currentUserId
  ) {
    return "ignore";
  }
  return args.activeChannelId === args.channelId && args.documentVisible
    ? "read"
    : "unread";
}
