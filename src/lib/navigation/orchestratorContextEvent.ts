export const ORCHESTRATOR_CONTEXT_EVENT = "groovy:orchestrator-context";

export type OrchestratorContextEventDetail = {
  agentId: string | null;
  sessionId: string | null;
};

export function dispatchOrchestratorContext(
  detail: OrchestratorContextEventDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OrchestratorContextEventDetail>(ORCHESTRATOR_CONTEXT_EVENT, {
      detail,
    }),
  );
}
