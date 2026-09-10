export const DEFAULT_TEAM_CHAT_MIND_HANDLE = "groovy";

export type ChatMentionTrigger = {
  query: string;
  start: number;
  end: number;
};

export function chatMentionTrigger(
  value: string,
  cursor: number | null,
): ChatMentionTrigger | null {
  if (cursor === null || cursor < 0 || cursor > value.length) return null;
  const prefix = value.slice(0, cursor);
  const match = prefix.match(/(?:^|\s)@([^\s]*)$/);
  if (!match) return null;
  return {
    query: match[1] || "",
    start: prefix.lastIndexOf("@"),
    end: cursor,
  };
}

export function mentionsHandle(content: string, handle: string): boolean {
  const normalized = handle.trim().replace(/^@/, "");
  if (!normalized) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)@${escaped}(?=\\s|[.,!?;:]|$)`, "i").test(content);
}

export function teamChatMentionHandle(
  value: string,
  fallback = "",
): string {
  const compact = value
    .trim()
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "");
  return compact || fallback;
}
