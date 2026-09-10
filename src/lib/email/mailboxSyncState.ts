import type { SupabaseClient } from "@supabase/supabase-js";

export type EmailMailboxSyncState = {
  connectionId: string;
  historyId: string;
  historyPageToken: string | null;
  syncMode: "history" | "full";
  triagePolicyVersion: number;
  lastFullSyncAt: string | null;
  updatedAt: string;
};

type SyncStateRow = {
  connection_id?: unknown;
  history_id?: unknown;
  history_page_token?: unknown;
  sync_mode?: unknown;
  triage_policy_version?: unknown;
  last_full_sync_at?: unknown;
  updated_at?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function emailMailboxSyncStateFromRow(
  row: SyncStateRow,
): EmailMailboxSyncState | null {
  const connectionId = text(row.connection_id);
  const historyId = text(row.history_id);
  const updatedAt = text(row.updated_at);
  const syncMode = text(row.sync_mode);
  const triagePolicyVersion = Number(row.triage_policy_version || 0);
  if (!connectionId || !/^\d+$/.test(historyId)) return null;
  return {
    connectionId,
    historyId,
    historyPageToken: text(row.history_page_token) || null,
    syncMode: syncMode === "full" ? "full" : "history",
    triagePolicyVersion:
      Number.isFinite(triagePolicyVersion) && triagePolicyVersion >= 0
        ? Math.floor(triagePolicyVersion)
        : 0,
    lastFullSyncAt: text(row.last_full_sync_at) || null,
    updatedAt,
  };
}

export async function loadEmailMailboxSyncStates(args: {
  supabase: SupabaseClient;
  userId: string;
  connectionIds: string[];
}): Promise<Map<string, EmailMailboxSyncState>> {
  const connectionIds = Array.from(new Set(args.connectionIds.filter(Boolean)));
  if (connectionIds.length === 0) return new Map();
  const result = await args.supabase
    .from("email_mailbox_sync_state")
    .select(
      "connection_id,history_id,history_page_token,sync_mode,triage_policy_version,last_full_sync_at,updated_at",
    )
    .eq("user_id", args.userId)
    .eq("provider", "gmail")
    .in("connection_id", connectionIds);
  if (result.error) {
    // Rolling deployments can briefly run before the migration is available.
    if (
      result.error.code === "42P01" ||
      /email_mailbox_sync_state|schema cache/i.test(result.error.message)
    ) {
      return new Map();
    }
    throw new Error(result.error.message);
  }
  return new Map(
    (result.data || [])
      .map((row) => emailMailboxSyncStateFromRow(row))
      .filter((row): row is EmailMailboxSyncState => row !== null)
      .map((row) => [row.connectionId, row]),
  );
}

export async function persistEmailMailboxSyncStates(args: {
  supabase: SupabaseClient;
  userId: string;
  states: Array<{
    connectionId: string;
    historyId: string;
    historyPageToken?: string | null;
    syncMode?: "history" | "full";
    triagePolicyVersion?: number;
    fullSync?: boolean;
  }>;
}): Promise<void> {
  const now = new Date().toISOString();
  const states = Array.from(
    new Map(
      args.states
        .filter(
          (state) => state.connectionId && /^\d+$/.test(state.historyId),
        )
        .map((state) => [state.connectionId, state]),
    ).values(),
  );
  const rows = states.map((state) => ({
    user_id: args.userId,
    provider: "gmail",
    connection_id: state.connectionId,
    history_id: state.historyId,
    history_page_token: text(state.historyPageToken) || null,
    sync_mode: state.syncMode === "full" ? "full" : "history",
    triage_policy_version: Math.max(
      0,
      Math.floor(Number(state.triagePolicyVersion || 0)),
    ),
    updated_at: now,
  }));
  if (rows.length === 0) return;
  const result = await args.supabase
    .from("email_mailbox_sync_state")
    .upsert(rows, { onConflict: "user_id,provider,connection_id" });
  if (
    result.error &&
    result.error.code !== "42P01" &&
    !/email_mailbox_sync_state|schema cache/i.test(result.error.message)
  ) {
    throw new Error(result.error.message);
  }
  const fullSyncConnectionIds = states
    .filter((state) => state.fullSync === true)
    .map((state) => state.connectionId);
  if (fullSyncConnectionIds.length > 0) {
    const fullSyncResult = await args.supabase
      .from("email_mailbox_sync_state")
      .update({ last_full_sync_at: now })
      .eq("user_id", args.userId)
      .eq("provider", "gmail")
      .in("connection_id", fullSyncConnectionIds);
    if (
      fullSyncResult.error &&
      fullSyncResult.error.code !== "42P01" &&
      !/email_mailbox_sync_state|schema cache/i.test(
        fullSyncResult.error.message,
      )
    ) {
      throw new Error(fullSyncResult.error.message);
    }
  }
}

export function shouldPersistEmailHistoryCursor(args: {
  discoveredCandidateIds: readonly string[];
  attemptedCandidateIds: ReadonlySet<string>;
}): boolean {
  return args.discoveredCandidateIds.every((id) =>
    args.attemptedCandidateIds.has(id),
  );
}

export function buildEmailMailboxSyncCheckpoint(args: {
  connectionId: string;
  cursorHistoryId: string;
  historyId: string;
  nextPageToken: string | null;
  fullSync: boolean;
  triagePolicyVersion: number;
  discoveredCandidateIds: readonly string[];
  attemptedCandidateIds: ReadonlySet<string>;
}): {
  connectionId: string;
  historyId: string;
  historyPageToken: string | null;
  syncMode: "history" | "full";
  triagePolicyVersion: number;
  fullSync: boolean;
} | null {
  if (
    !shouldPersistEmailHistoryCursor({
      discoveredCandidateIds: args.discoveredCandidateIds,
      attemptedCandidateIds: args.attemptedCandidateIds,
    })
  ) {
    return null;
  }
  const fullScanContinues = args.fullSync && Boolean(args.nextPageToken);
  return {
    connectionId: args.connectionId,
    historyId: args.nextPageToken
      ? args.cursorHistoryId
      : args.historyId,
    historyPageToken: args.nextPageToken,
    syncMode: fullScanContinues ? "full" : "history",
    triagePolicyVersion: Math.max(
      0,
      Math.floor(Number(args.triagePolicyVersion || 0)),
    ),
    fullSync: args.fullSync && !args.nextPageToken,
  };
}

export function shouldRunEmailMailboxFullSync(args: {
  syncMode: "history" | "full";
  triagePolicyVersion: number;
  currentTriagePolicyVersion: number;
  lastFullSyncAt: string | null;
  now?: number;
  intervalMs: number;
}): boolean {
  if (args.syncMode === "full") return true;
  if (args.triagePolicyVersion < args.currentTriagePolicyVersion) return true;
  const lastFullSyncAt = Date.parse(args.lastFullSyncAt || "");
  if (!Number.isFinite(lastFullSyncAt)) return true;
  return (args.now ?? Date.now()) - lastFullSyncAt >= args.intervalMs;
}
