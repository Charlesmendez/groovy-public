export type TeamChatAgentTaskDecision = {
  action: "approve" | "reject";
  taskIdPrefix: string | null;
};

const TEAM_CHAT_AGENT_TASK_DECISION =
  /^(?:@[a-z0-9][a-z0-9._-]*\s+)?(?:i\s+)?(approve(?:d)?|reject(?:ed)?)(?:\s+(?:task\s+)?([a-f0-9][a-f0-9-]{5,}))?[.!]?$/i;

export function parseTeamChatAgentTaskDecision(
  value: string,
): TeamChatAgentTaskDecision | null {
  const match = value.trim().match(TEAM_CHAT_AGENT_TASK_DECISION);
  if (!match) return null;
  return {
    action: match[1].toLowerCase().startsWith("approve")
      ? "approve"
      : "reject",
    taskIdPrefix: match[2]?.toLowerCase() || null,
  };
}

export function matchingPendingApprovalTasks<T extends { id: string }>(
  tasks: T[],
  taskIdPrefix: string | null,
): T[] {
  if (!taskIdPrefix) return tasks;
  return tasks.filter((task) =>
    task.id.toLowerCase().startsWith(taskIdPrefix),
  );
}
