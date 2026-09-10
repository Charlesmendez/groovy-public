import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptLlmApiKey, encryptLlmApiKey } from "../crypto/llmKey";
import {
  HomeInboxError,
  parseDecisionClaim,
  type DecisionScope,
} from "./contracts";
import type { DecisionRun, DecisionStore, RunState } from "./worker";

export type InboxBinding = DecisionScope & {
  id: string;
  profileId: string;
  ownerUserId: string;
  workspaceId: string | null;
  homeKeyEnc: string;
  homeOrigin: string;
  status: "active" | "paused" | "revoked";
};
export type BindingRow = {
  id: string;
  profile_id: string;
  owner_user_id: string;
  workspace_id: string | null;
  tenant_id: string;
  project_id: string;
  harness_ref: string;
  home_key_enc: string;
  home_origin: string;
  status: InboxBinding["status"];
};
export function bindingFromRow(row: BindingRow): InboxBinding {
  return {
    id: row.id,
    profileId: row.profile_id,
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    harnessRef: row.harness_ref,
    homeKeyEnc: row.home_key_enc,
    homeOrigin: row.home_origin,
    status: row.status,
  };
}
function checked(error: { message: string } | null) {
  if (error)
    throw new HomeInboxError(
      "decision_storage_failed",
      "Could not persist decision state. Execution must not be retried.",
      503,
    );
}

export function createDecisionStore(
  admin: SupabaseClient,
  binding: InboxBinding,
): DecisionStore {
  async function update(
    run: DecisionRun,
    states: RunState[],
    values: Record<string, unknown>,
  ) {
    const { data, error } = await admin
      .from("home_inbox_decision_runs")
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq("id", run.id)
      .eq("binding_id", binding.id)
      .in("state", states)
      .select("id")
      .maybeSingle();
    checked(error);
    return Boolean(data);
  }
  return {
    async reserve(item) {
      const run: DecisionRun = {
        id: randomUUID(),
        decisionId: item.id,
        claimKey: `inbox-${binding.id}-${item.id}`,
        traceId: randomUUID(),
        state: "claiming",
        expiresAt: item.expires_at,
        claim: null,
        result: null,
        deliveryAttempts: 0,
      };
      const { error } = await admin
        .from("home_inbox_decision_runs")
        .insert({
          id: run.id,
          binding_id: binding.id,
          decision_id: item.id,
          claim_key: run.claimKey,
          trace_id: run.traceId,
          state: run.state,
          expires_at: run.expiresAt,
        });
      if (error?.code === "23505") return null;
      checked(error);
      return run;
    },
    begin: (run, claim, profile) =>
      update(run, ["claiming"], {
        state: "running",
        claim_enc: encryptLlmApiKey(JSON.stringify(claim)),
        profile_snapshot: profile,
        expires_at: claim.expires_at,
      }),
    saveResult: (run, result) =>
      update(run, ["running"], {
        state: "completed",
        result,
        next_delivery_at: new Date().toISOString(),
      }),
    async finish(run, state, code) {
      await update(run, ["claiming", "running"], { state, error_code: code });
    },
    async delivered(run, applied) {
      await update(run, ["completed"], {
        state: "delivered",
        applied,
        next_delivery_at: null,
        error_code: applied ? null : "receipt_not_applied",
      });
    },
    async deferReceipt(run, code) {
      await update(run, ["completed"], {
        delivery_attempts: run.deliveryAttempts + 1,
        error_code: code,
        next_delivery_at: new Date(
          Date.now() +
            Math.min(3600, 30 * 2 ** Math.min(run.deliveryAttempts, 7)) * 1000,
        ).toISOString(),
      });
    },
  };
}

export async function pendingReceipt(
  admin: SupabaseClient,
  binding: InboxBinding,
): Promise<DecisionRun | null> {
  const { data, error } = await admin
    .from("home_inbox_decision_runs")
    .select("*")
    .eq("binding_id", binding.id)
    .eq("state", "completed")
    .lte("next_delivery_at", new Date().toISOString())
    .order("next_delivery_at")
    .limit(1)
    .maybeSingle();
  checked(error);
  if (!data) return null;
  const claim = parseDecisionClaim(
    JSON.parse(decryptLlmApiKey(data.claim_enc)),
    binding,
    data.decision_id,
  );
  if (!claim.execute)
    throw new HomeInboxError(
      "invalid_saved_claim",
      "The saved decision claim is invalid.",
    );
  return {
    id: data.id,
    decisionId: data.decision_id,
    claimKey: data.claim_key,
    traceId: data.trace_id,
    state: "completed",
    expiresAt: data.expires_at,
    claim,
    result: data.result,
    deliveryAttempts: data.delivery_attempts,
  };
}

export async function reconcileAbandonedDecisions(admin: SupabaseClient) {
  const { error } = await admin
    .from("home_inbox_decision_runs")
    .update({
      state: "unknown",
      error_code: "execution_expired_without_receipt",
      updated_at: new Date().toISOString(),
    })
    .in("state", ["claiming", "running"])
    .lte("expires_at", new Date().toISOString());
  checked(error);
}
