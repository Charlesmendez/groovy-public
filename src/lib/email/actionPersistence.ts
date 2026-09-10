import type { SupabaseClient } from "@supabase/supabase-js";

type EmailWorkspaceActionWriteResult = {
  data?: { id?: unknown } | null;
  error?: { message?: unknown } | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Gmail label mutations and Groovy's workspace history are one user action.
 * Gmail mutations are idempotent, so a failed history write must make the
 * request retry instead of reporting a success that an older Focus record can
 * later undo.
 */
export class EmailWorkspacePersistenceError extends Error {
  readonly details: string;

  constructor(details = "") {
    super("Groovy could not save the email workspace change.");
    this.name = "EmailWorkspacePersistenceError";
    this.details = details;
  }
}

export function requirePersistedEmailWorkspaceActionId(
  result: EmailWorkspaceActionWriteResult,
): string {
  const failure = text(result.error?.message);
  if (failure) throw new EmailWorkspacePersistenceError(failure);

  const actionId = text(result.data?.id);
  if (!actionId) {
    throw new EmailWorkspacePersistenceError(
      "The workspace action write returned no action id.",
    );
  }
  return actionId;
}

export type EmailWorkspaceActionMutationStatus =
  | "pending"
  | "approved"
  | "executing"
  | "done"
  | "rejected"
  | "failed";

export type EmailWorkspaceActionMutationResult = {
  actionId: string;
  updatedAt: string;
  closedSiblingCount: number;
};

export type ClosedCoveredInboxAction = {
  actionId: string;
  updatedAt: string;
};

/**
 * Atomically merges action metadata in Postgres. Object-spreading a metadata
 * snapshot in an API route can erase a correction written by another device
 * while the first request is waiting on Gmail.
 */
export async function persistEmailWorkspaceActionMutation(args: {
  supabase: SupabaseClient;
  userId: string;
  actionId: string;
  metadataPatch?: Record<string, unknown>;
  changedAt: string;
  expectedStatus?: EmailWorkspaceActionMutationStatus | null;
  status?: EmailWorkspaceActionMutationStatus | null;
  executedAt?: string | null;
  closeActiveSiblings?: boolean;
  correctionCutoff?: string | null;
}): Promise<EmailWorkspaceActionMutationResult> {
  const mutation = await args.supabase
    .rpc("apply_email_workspace_action_mutation", {
      p_action_id: args.actionId,
      p_user_id: args.userId,
      p_metadata_patch: args.metadataPatch || {},
      p_changed_at: args.changedAt,
      p_expected_status: args.expectedStatus || null,
      p_status: args.status || null,
      p_executed_at: args.executedAt || null,
      p_close_active_siblings: args.closeActiveSiblings === true,
      p_correction_cutoff: args.correctionCutoff || null,
    })
    .maybeSingle();
  const failure = text(mutation.error?.message);
  const row = mutation.data as Record<string, unknown> | null;
  const actionId = text(row?.action_id);
  if (failure || !actionId) {
    throw new EmailWorkspacePersistenceError(
      failure || "The workspace action mutation returned no action id.",
    );
  }
  const closedSiblingCount = Number(row?.closed_sibling_count);
  return {
    actionId,
    updatedAt: text(row?.action_updated_at) || args.changedAt,
    closedSiblingCount: Number.isFinite(closedSiblingCount)
      ? Math.max(0, Math.floor(closedSiblingCount))
      : 0,
  };
}

/**
 * Releases active-action uniqueness claims held by pending rows that are
 * already covered by a later Done/Noise placement. Postgres rechecks the
 * latest conversation marker before closing each candidate, so a newer
 * Focus/Inbox reversal remains pending.
 */
export async function closeCoveredPendingInboxActions(args: {
  supabase: SupabaseClient;
  userId: string;
  actionIds: readonly string[];
  changedAt: string;
}): Promise<ClosedCoveredInboxAction[]> {
  const actionIds = Array.from(
    new Set(args.actionIds.map((value) => text(value)).filter(Boolean)),
  );
  if (actionIds.length === 0) return [];
  const mutation = await args.supabase.rpc(
    "close_covered_pending_inbox_actions",
    {
      p_action_ids: actionIds,
      p_user_id: args.userId,
      p_changed_at: args.changedAt,
    },
  );
  const failure = text(mutation.error?.message);
  if (failure) {
    throw new EmailWorkspacePersistenceError(failure);
  }
  const rows = Array.isArray(mutation.data) ? mutation.data : [];
  return rows
    .map((value) => {
      const row = value as Record<string, unknown>;
      const actionId = text(row.action_id);
      if (!actionId) return null;
      return {
        actionId,
        updatedAt: text(row.action_updated_at) || args.changedAt,
      };
    })
    .filter((value): value is ClosedCoveredInboxAction => value !== null);
}
