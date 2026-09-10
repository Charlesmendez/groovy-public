export const TEAM_CHAT_CONTROLLABLE_ORCHESTRATOR_RUN_STATUSES = [
  "running",
  "stop_requested",
  "redirect_requested",
] as const;

// Finalizing is still visible work: the model run has finished, but the
// response and any delegated-task handoff are not durable in Chat yet.
export const TEAM_CHAT_VISIBLE_ORCHESTRATOR_RUN_STATUSES = [
  ...TEAM_CHAT_CONTROLLABLE_ORCHESTRATOR_RUN_STATUSES,
  "finalizing",
] as const;

export type TeamChatVisibleOrchestratorRunStatus =
  (typeof TEAM_CHAT_VISIBLE_ORCHESTRATOR_RUN_STATUSES)[number];
