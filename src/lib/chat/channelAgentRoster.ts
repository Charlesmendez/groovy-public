export type ChannelAgentMember = {
  member_type?: unknown;
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
