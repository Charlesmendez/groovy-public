export type ChannelAgentMember = {
  member_type?: unknown;
  user_id?: unknown;
  agent_id?: unknown;
};

export function channelAgentIds(
  members: ChannelAgentMember[],
): string[] {
  return Array.from(
    new Set(
      members
        .filter((member) => member.member_type === "agent")
        .map((member) =>
          typeof member.agent_id === "string" ? member.agent_id.trim() : "",
        )
        .filter(Boolean),
    ),
  );
}

export function selectedChannelAgents<T extends { id: string }>(
  agents: T[],
  members: ChannelAgentMember[],
): T[] {
  const selectedIds = new Set(channelAgentIds(members));
  return agents.filter((agent) => selectedIds.has(agent.id));
}

/**
 * A direct Agent conversation is defined by its roster, never by its name,
 * slug, bound Mind, or other presentation metadata. This keeps stale legacy
 * channel settings from silently routing a user-selected Agent DM through an
 * orchestrator.
 */
export function directAgentMessageTargetId(args: {
  kind: unknown;
  members: ChannelAgentMember[];
}): string | null {
  if (args.kind !== "dm") return null;
  const agentIds = channelAgentIds(args.members);
  const userIds = new Set(
    args.members
      .filter((member) => member.member_type === "user")
      .map((member) =>
        typeof member.user_id === "string" ? member.user_id.trim() : "",
      )
      .filter(Boolean),
  );
  return agentIds.length === 1 && userIds.size === 1 ? agentIds[0] : null;
}

export function isAgentDirectMessageForRecipient(args: {
  kind: unknown;
  agentId: string;
  members: ChannelAgentMember[];
}): boolean {
  return directAgentMessageTargetId(args) === args.agentId;
}
