import {
  DEFAULT_GROOVY_PROFILE,
  type HarnessProfile,
} from "../orchestrator/harnessProfiles";
import type { DecisionClaim, DecisionMetadata } from "./contracts";
export const ids = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000002",
  harnessRef: "retention-review",
};
export const decisionId = "30000000-0000-4000-8000-000000000003";
export const profile: HarnessProfile = {
  ...DEFAULT_GROOVY_PROFILE,
  id: "40000000-0000-4000-8000-000000000004",
  surface: "external",
  authorizationStance: "restricted",
  memoryScope: "profile",
  toolPolicy: { mode: "allowlist", tools: ["web_search"] },
  inheritWorkspaceSkills: false,
  inheritWorkspaceIntegrations: false,
};
export const now = Date.parse("2026-09-06T12:00:00Z");
export function claim(): DecisionClaim {
  return {
    decision_id: decisionId,
    execute: true,
    claim_token: "50000000-0000-4000-8000-000000000005",
    expires_at: "2026-09-06T12:10:00Z",
    harness_ref: ids.harnessRef,
    instruction: "Use the supplied score to choose a client-defined outcome.",
    inputs: { score: 3 },
    input_captured_at: "2026-09-06T11:59:59Z",
    outcomes: [
      { key: "review", label: "Review manually" },
      { key: "keep", label: "Continue the existing flow" },
    ],
    context: {
      tenant_id: ids.tenantId,
      project_id: ids.projectId,
      funnel_id: ids.projectId,
      customer_id: null,
      funnel_lead_id: "60000000-0000-4000-8000-000000000006",
      conversation_id: "70000000-0000-4000-8000-000000000007",
    },
  };
}
export const item: DecisionMetadata = {
  id: decisionId,
  node_id: profile.id,
  created_at: "2026-09-06T12:00:00Z",
  expires_at: "2026-09-06T12:10:00Z",
};
