export const DEFAULT_CHAT_MESSAGE_PAGE_SIZE = 50;
export const MAX_CHAT_MESSAGE_PAGE_SIZE = 100;

export type ChatMessageCursor = {
  createdAt: string;
  id: string;
};

export type ChatMessagePageInfo = {
  hasOlder: boolean;
  olderCursor: string | null;
  hasNewer: boolean;
  newerCursor: string | null;
};

type CursorMessage = {
  created_at: string;
  id: string;
};

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function parseChatMessagePageSize(value: string | null): number {
  if (!value) return DEFAULT_CHAT_MESSAGE_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_CHAT_MESSAGE_PAGE_SIZE;
  }
  return Math.min(parsed, MAX_CHAT_MESSAGE_PAGE_SIZE);
}

export function encodeChatMessageCursor(message: CursorMessage): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: message.created_at,
      id: message.id,
    } satisfies ChatMessageCursor),
    "utf8",
  ).toString("base64url");
}

export function decodeChatMessageCursor(
  value: string | null,
): ChatMessageCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      !isUuid(parsed.id)
    ) {
      return null;
    }
    return {
      createdAt: parsed.createdAt,
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

export function olderThanChatMessageCursor(
  cursor: ChatMessageCursor,
): string {
  return `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`;
}

export function newerThanChatMessageCursor(
  cursor: ChatMessageCursor,
): string {
  return `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`;
}

export function chatMessagePageInfo(
  messages: CursorMessage[],
  {
    hasOlder,
    hasNewer,
  }: {
    hasOlder: boolean;
    hasNewer: boolean;
  },
): ChatMessagePageInfo {
  return {
    hasOlder,
    olderCursor:
      hasOlder && messages.length > 0
        ? encodeChatMessageCursor(messages[0])
        : null,
    hasNewer,
    newerCursor:
      hasNewer && messages.length > 0
        ? encodeChatMessageCursor(messages[messages.length - 1])
        : null,
  };
}
