type ContinuationTimelineMessage = {
  metadata?: Record<string, unknown> | null;
};

/**
 * A terminal worker message is durable before the Mind continuation starts.
 * Keep a transition card visible from that point until the continuation posts
 * either its synthesized response or an explicit follow-up failure.
 */
export function mindContinuationPending(
  messages: readonly ContinuationTimelineMessage[],
): boolean {
  const pendingTaskIds = new Set<string>();
  for (const message of messages) {
    const metadata = message.metadata || {};
    const kind = typeof metadata.kind === "string" ? metadata.kind : "";
    const taskId =
      typeof metadata.task_id === "string" ? metadata.task_id.trim() : "";
    if (kind === "agent_task_result" && taskId) {
      if (metadata.orchestrator_followup_pending === true) {
        pendingTaskIds.add(taskId);
      } else {
        pendingTaskIds.delete(taskId);
      }
      continue;
    }
    if (
      kind === "agent_task_orchestrator_result" ||
      kind === "agent_task_orchestrator_followup_error"
    ) {
      if (taskId) pendingTaskIds.delete(taskId);
      if (Array.isArray(metadata.task_ids)) {
        for (const value of metadata.task_ids) {
          if (typeof value === "string") pendingTaskIds.delete(value.trim());
        }
      }
    }
  }
  return pendingTaskIds.size > 0;
}
