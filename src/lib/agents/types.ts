/**
 * Harness worker agent types.
 *
 * A "worker agent" is the unit of the multi-agent harness: an `agents` row of
 * type `claude-code` plus its `claude_code_agent_configs` row binding it to a
 * device, workspace, and code CLI harness (Claude Code or Codex CLI).
 */

export type WorkerHarness = "claude" | "codex";

export type WorkerAgent = {
  id: string;
  name: string;
  /** Harness that executes this agent's tasks. */
  harness: WorkerHarness;
  /** Per-agent model override; null = harness default. */
  model: string | null;
  deviceId: string | null;
  workspaceId: string | null;
  workspaceRootPath?: string | null;
  emoji?: string | null;
  color?: string | null;
  createdAt?: string;
};

export type WorkerAgentRosterEntry = WorkerAgent & {
  deviceOnline?: boolean;
  /** Convenience label for prompts: "Fixter (codex @ ~/repos/app)" */
  promptLabel?: string;
};

export function workerHarnessFromProvider(value: unknown): WorkerHarness {
  return value === "codex" ? "codex" : "claude";
}

export function workerPromptLabel(agent: WorkerAgent): string {
  const parts = [agent.harness === "codex" ? "codex" : "claude-code"];
  if (agent.model) parts.push(agent.model);
  return `${agent.name} (${parts.join(", ")})`;
}
