export type ChannelSkillManagerRole = "admin" | "member" | "guest" | null;

export function canManageChannelSkills(args: {
  actorUserId: string;
  channelCreatedBy: string;
  workspaceRole: ChannelSkillManagerRole;
}): boolean {
  return (
    args.workspaceRole === "admin" ||
    (args.workspaceRole === "member" &&
      args.channelCreatedBy === args.actorUserId)
  );
}
