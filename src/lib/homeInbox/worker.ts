import type { HarnessProfile } from "../orchestrator/harnessProfiles";
import {
  HomeInboxError,
  parseModelDecision,
  type DecisionClaim,
  type DecisionMetadata,
  type DecisionResult,
  type ClaimReply,
} from "./contracts";

export type RunState =
  "claiming" | "running" | "completed" | "delivered" | "unknown" | "cancelled";
export type DecisionRun = {
  id: string;
  decisionId: string;
  claimKey: string;
  traceId: string;
  state: RunState;
  expiresAt: string;
  claim: DecisionClaim | null;
  result: DecisionResult | null;
  deliveryAttempts: number;
};

// The durable insert and state compare-and-swap are the execution boundary.
// Workers never reclaim claiming/running/unknown rows. Only saved receipts retry.
export type DecisionStore = {
  reserve(item: DecisionMetadata): Promise<DecisionRun | null>;
  begin(
    run: DecisionRun,
    claim: DecisionClaim,
    profile: HarnessProfile,
  ): Promise<boolean>;
  saveResult(run: DecisionRun, result: DecisionResult): Promise<boolean>;
  finish(
    run: DecisionRun,
    state: "unknown" | "cancelled",
    code: string,
  ): Promise<void>;
  delivered(run: DecisionRun, applied: boolean): Promise<void>;
  deferReceipt(run: DecisionRun, code: string): Promise<void>;
};
export type DecisionWorkerDependencies = {
  store: DecisionStore;
  home: {
    list(limit?: number): Promise<DecisionMetadata[]>;
    claim(id: string, key: string): Promise<ClaimReply>;
    complete(
      id: string,
      token: string,
      result: DecisionResult,
    ): Promise<{ applied: boolean }>;
  };
  authorize(): Promise<HarnessProfile>;
  execute(
    run: DecisionRun,
    claim: DecisionClaim,
    profile: HarnessProfile,
  ): Promise<string>;
  now(): number;
};

export function decisionErrorCode(error: unknown): string {
  return error instanceof HomeInboxError
    ? error.code
    : "decision_execution_uncertain";
}

export async function deliverSavedDecision(
  run: DecisionRun,
  deps: DecisionWorkerDependencies,
) {
  if (run.state !== "completed" || !run.claim || !run.result) return "skipped";
  try {
    await deps.authorize();
    const receipt = await deps.home.complete(
      run.decisionId,
      run.claim.claim_token,
      run.result,
    );
    await deps.store.delivered(run, receipt.applied);
    return receipt.applied ? "delivered" : "recorded_not_applied";
  } catch (error) {
    // No second model, even if Home applied the receipt and its response was lost.
    await deps.store.deferReceipt(run, decisionErrorCode(error));
    return "receipt_pending";
  }
}

export async function consumeDecision(
  item: DecisionMetadata,
  deps: DecisionWorkerDependencies,
) {
  if (Date.parse(item.expires_at) <= deps.now()) return "expired";
  await deps.authorize();
  const run = await deps.store.reserve(item);
  if (!run) return "already_reserved";
  try {
    const claim = await deps.home.claim(item.id, run.claimKey);
    if (!claim.execute) {
      await deps.store.finish(run, "cancelled", "home_did_not_grant_execution");
      return "not_claimed";
    }
    if (Date.parse(claim.expires_at) <= deps.now() + 5_000)
      throw new HomeInboxError(
        "decision_expired",
        "The decision expired before execution.",
      );
    const profile = await deps.authorize();
    if (!(await deps.store.begin(run, claim, profile)))
      return "already_reserved";
    run.claim = claim;
    run.state = "running";
    run.expiresAt = claim.expires_at;
    const text = await deps.execute(run, claim, profile);
    if (Date.parse(claim.expires_at) <= deps.now())
      throw new HomeInboxError(
        "decision_expired",
        "The decision expired during execution.",
      );
    const parsed = parseModelDecision(text, claim);
    // Protocol v1 has only a single-model usage field. Multi-model accounting
    // now lives in the independent durable usage receipt/report, including
    // failed/held executions; never flatten it into a misleading default model.
    const result: DecisionResult = { ...parsed, usage: null };
    if (!(await deps.store.saveResult(run, result))) return "unknown";
    run.state = "completed";
    run.result = result;
  } catch (error) {
    await deps.store.finish(run, "unknown", decisionErrorCode(error));
    return "unknown";
  }
  return deliverSavedDecision(run, deps);
}
