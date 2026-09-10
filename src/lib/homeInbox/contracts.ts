// Home / Inbox decision protocol v1 (Agents migration 0060). These envelopes
// carry identity and decision receipts, not scheduling or message authority.
export type DecisionScope = {
  tenantId: string;
  projectId: string;
  harnessRef: string;
};
export type DecisionUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number | null;
} | null;
export type DecisionResult = {
  outcome_key: string;
  summary: string | null;
  usage: DecisionUsage;
};
export type DecisionClaim = {
  decision_id: string;
  execute: true;
  claim_token: string;
  expires_at: string;
  harness_ref: string;
  instruction: string;
  inputs: Record<string, string | number | boolean | null>;
  input_captured_at: string;
  outcomes: Array<{ key: string; label: string }>;
  context: {
    tenant_id: string;
    project_id: string;
    funnel_id: string;
    customer_id: string | null;
    funnel_lead_id: string;
    conversation_id: string;
  };
};
export type ClaimReply =
  DecisionClaim | { decision_id: string; execute: false; status: string };
export type DecisionMetadata = {
  id: string;
  node_id: string;
  created_at: string;
  expires_at: string;
};

export class HomeInboxError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
    this.name = "HomeInboxError";
  }
}
export function invalidProtocol(): never {
  throw new HomeInboxError(
    "invalid_home_decision",
    "Home returned an invalid or differently scoped decision. No execution is authorized.",
    502,
  );
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
export function harnessRef(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,119}$/.test(value);
}
function text(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" && value.length >= min && value.length <= max
  );
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function parseDecisionMetadata(value: unknown): DecisionMetadata[] {
  if (
    !record(value) ||
    !exact(value, ["items"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 50
  )
    invalidProtocol();
  for (const item of value.items) {
    if (
      !record(item) ||
      !exact(item, ["id", "node_id", "created_at", "expires_at"]) ||
      !uuid(item.id) ||
      !uuid(item.node_id) ||
      !timestamp(item.created_at) ||
      !timestamp(item.expires_at)
    )
      invalidProtocol();
  }
  return value.items as DecisionMetadata[];
}
export function parseDecisionClaim(
  value: unknown,
  scope: DecisionScope,
  decisionId: string,
): ClaimReply {
  if (!record(value) || value.decision_id !== decisionId) invalidProtocol();
  if (value.execute === false) {
    if (
      !exact(value, ["decision_id", "execute", "status"]) ||
      !["queued", "claimed", "completed", "unknown", "cancelled"].includes(
        String(value.status),
      )
    )
      invalidProtocol();
    return value as ClaimReply;
  }
  if (
    value.execute !== true ||
    !exact(value, [
      "decision_id",
      "execute",
      "claim_token",
      "expires_at",
      "harness_ref",
      "instruction",
      "inputs",
      "input_captured_at",
      "outcomes",
      "context",
    ]) ||
    !uuid(value.claim_token) ||
    !timestamp(value.expires_at) ||
    !timestamp(value.input_captured_at) ||
    value.harness_ref !== scope.harnessRef ||
    !text(value.instruction, 1, 4000) ||
    !record(value.inputs) ||
    Object.keys(value.inputs).length > 20 ||
    !Array.isArray(value.outcomes) ||
    value.outcomes.length < 2 ||
    value.outcomes.length > 10
  )
    invalidProtocol();
  for (const [key, input] of Object.entries(value.inputs)) {
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(key) ||
      ["constructor", "prototype", "__proto__"].includes(key) ||
      !(
        input === null ||
        typeof input === "boolean" ||
        (typeof input === "number" && Number.isFinite(input)) ||
        text(input, 0, 1024)
      )
    )
      invalidProtocol();
  }
  const outcomeKeys = new Set<string>();
  for (const option of value.outcomes) {
    if (
      !record(option) ||
      !exact(option, ["key", "label"]) ||
      !text(option.key, 1, 64) ||
      !/^[a-z][a-z0-9_-]*$/.test(option.key) ||
      !text(option.label, 1, 80) ||
      outcomeKeys.has(option.key)
    )
      invalidProtocol();
    outcomeKeys.add(option.key);
  }
  const context = value.context;
  if (
    !record(context) ||
    !exact(context, [
      "tenant_id",
      "project_id",
      "funnel_id",
      "customer_id",
      "funnel_lead_id",
      "conversation_id",
    ]) ||
    context.tenant_id !== scope.tenantId ||
    context.project_id !== scope.projectId ||
    context.funnel_id !== scope.projectId ||
    !(context.customer_id === null || uuid(context.customer_id)) ||
    !uuid(context.funnel_lead_id) ||
    !uuid(context.conversation_id)
  )
    invalidProtocol();
  return value as DecisionClaim;
}
export function parseModelDecision(
  textOutput: string,
  claim: DecisionClaim,
): Omit<DecisionResult, "usage"> {
  // Do not repair JSON, infer outcomes or run a second model after a malformed result.
  let value: unknown;
  const invalid = () => {
    throw new HomeInboxError(
      "invalid_decision_output",
      "The harness did not return a valid client-configured decision. Review this run; it will not be repeated automatically.",
    );
  };
  try {
    value = JSON.parse(textOutput);
  } catch {
    invalid();
  }
  if (
    !record(value) ||
    !exact(value, ["outcome_key", "summary"]) ||
    !claim.outcomes.some((option) => option.key === value.outcome_key) ||
    !(value.summary === null || text(value.summary, 0, 2000))
  )
    return invalid();
  return {
    outcome_key: value.outcome_key as string,
    summary: value.summary === null ? null : (value.summary as string).trim(),
  };
}
export function parseCompletion(value: unknown, decisionId: string) {
  if (
    !record(value) ||
    !exact(value, ["decision_id", "recorded", "replay", "applied"]) ||
    value.decision_id !== decisionId ||
    value.recorded !== true ||
    typeof value.replay !== "boolean" ||
    typeof value.applied !== "boolean"
  )
    invalidProtocol();
  return {
    recorded: true as const,
    replay: value.replay,
    applied: value.applied,
  };
}
