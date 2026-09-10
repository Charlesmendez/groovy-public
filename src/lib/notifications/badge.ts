const TITLE_BADGE_PATTERN = /^\((?:\d+|99\+)\)\s*/;

export function normalizeNotificationBadgeCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export function notificationBadgeLabel(value: unknown): string {
  const count = normalizeNotificationBadgeCount(value);
  return count > 99 ? "99+" : String(count);
}

export function totalNotificationBadgeCount(
  unreadCounts: Iterable<unknown>,
): number {
  let total = 0;
  for (const value of unreadCounts) {
    total += normalizeNotificationBadgeCount(value);
  }
  return total;
}

export function notificationUnreadState(
  unreadCounts: Iterable<readonly [string, unknown]>,
): {
  unreadCount: number;
  unreadChannelIds: string[];
} {
  let unreadCount = 0;
  const unreadChannelIds: string[] = [];
  for (const [channelId, value] of unreadCounts) {
    const count = normalizeNotificationBadgeCount(value);
    if (!channelId || count === 0) continue;
    unreadCount += count;
    unreadChannelIds.push(channelId);
  }
  return { unreadCount, unreadChannelIds };
}

export function titleWithNotificationBadge(
  title: string,
  unreadCount: unknown,
): string {
  const baseTitle = title.replace(TITLE_BADGE_PATTERN, "");
  const count = normalizeNotificationBadgeCount(unreadCount);
  return count > 0
    ? `(${notificationBadgeLabel(count)}) ${baseTitle}`
    : baseTitle;
}
