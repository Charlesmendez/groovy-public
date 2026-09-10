export function isHumanDirectMessageForRecipient(args: {
  currentUserId: string;
  recipientUserId: string;
  memberUserIds: Array<string | null | undefined>;
  hasAgent: boolean;
}): boolean {
  return isHumanDirectMessageForParticipants({
    currentUserId: args.currentUserId,
    participantUserIds:
      args.recipientUserId === args.currentUserId
        ? []
        : [args.recipientUserId],
    memberUserIds: args.memberUserIds,
    hasAgent: args.hasAgent,
  });
}

export function isHumanDirectMessageForParticipants(args: {
  currentUserId: string;
  participantUserIds: Array<string | null | undefined>;
  memberUserIds: Array<string | null | undefined>;
  hasAgent: boolean;
}): boolean {
  if (args.hasAgent) return false;

  const expected = new Set(
    [args.currentUserId, ...args.participantUserIds].filter(
      (value): value is string => Boolean(value),
    ),
  );
  const actual = new Set(
    args.memberUserIds.filter((value): value is string => Boolean(value)),
  );
  return (
    actual.size === expected.size &&
    Array.from(expected).every((userId) => actual.has(userId))
  );
}

export function directMessageDisplayName(args: {
  fallbackName: string;
  currentUserId: string;
  memberUserIds: Array<string | null | undefined>;
  hasAgent: boolean;
  memberNames: ReadonlyMap<string, string>;
}): string {
  if (args.hasAgent) return args.fallbackName;

  const memberUserIds = Array.from(
    new Set(args.memberUserIds.filter((value): value is string => Boolean(value))),
  );
  if (!memberUserIds.includes(args.currentUserId)) return args.fallbackName;

  const otherUserIds = memberUserIds.filter(
    (userId) => userId !== args.currentUserId,
  );
  if (otherUserIds.length === 0) return "Notes to self";

  const otherNames = otherUserIds.map((userId) =>
    args.memberNames.get(userId)?.trim(),
  );
  if (otherNames.some((name) => !name)) return args.fallbackName;
  return otherNames.join(", ");
}

export function chatChannelDisplayName(channel: {
  name: string;
  display_name?: string | null;
}): string {
  return channel.display_name?.trim() || channel.name;
}

export function selfDirectMessageSlug(currentUserId: string): string {
  return `notes-${currentUserId.trim().toLowerCase()}`;
}
