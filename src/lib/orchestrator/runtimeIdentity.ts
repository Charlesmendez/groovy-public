import type { ProviderId } from "@/lib/ai/modelResolver";

export type OrchestratorRuntimeEngine = "anthropic-agent-sdk" | "ai-sdk";

export function buildOrchestratorRuntimeIdentityPrompt(args: {
  provider: ProviderId;
  modelName: string;
  reasoningEffort?: string | null;
  engine: OrchestratorRuntimeEngine;
  selectionSource:
    | "profile"
    | "user-selected"
    | "automatic-default"
    | "scheduled-override";
}): string {
  const reasoningEffort =
    typeof args.reasoningEffort === "string" && args.reasoningEffort.trim()
      ? args.reasoningEffort.trim()
      : "provider default (no explicit override)";

  return `## CURRENT ORCHESTRATOR RUNTIME — AUTHORITATIVE
This block identifies the model serving this exact orchestrator turn.
- Provider: ${args.provider}
- Model: ${args.modelName}
- Reasoning effort: ${reasoningEffort}
- Runtime engine: ${args.engine}
- Selection source: ${args.selectionSource}

Runtime identity rules:
- If the user asks which LLM, model, provider, or reasoning effort you are currently using, answer directly from this block.
- Do not infer your current model from usage reports, billing telemetry, conversation history, worker-agent settings, or Groovy Codex settings.
- Do not confuse this orchestrator runtime with delegated coding agents, browser agents, compaction models, memory models, or other utility calls.
- If telemetry contains other models, explain that those belong to other agents or utility operations; they do not change the model serving this turn.`;
}
