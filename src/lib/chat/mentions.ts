export const DEFAULT_TEAM_CHAT_MIND_HANDLE = "groovy";

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
