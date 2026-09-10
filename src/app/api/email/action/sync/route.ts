import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import { persistEmailWorkspaceActionMutation } from "@/lib/email/actionPersistence";
import { GmailApiError, loadGmailMailboxes } from "@/lib/email/gmail";
import {
  EMAIL_PROVIDER_SYNC_STATUS_KEY,
  emailProviderActionIntentFromRow,
  emailProviderSyncMetadata,
  latestEmailProviderActionIntent,
  syncEmailWorkspaceProviderAction,
  type EmailProviderActionIntent,
} from "@/lib/email/providerActionSync";
import { withEmailProviderRequest } from "@/lib/email/providerRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROVIDER_SYNC_BATCH_SIZE = 8;

async function currentProviderIntent(args: {
  supabase: SupabaseClient;
  userId: string;
  candidate: EmailProviderActionIntent;
}): Promise<EmailProviderActionIntent | null> {
  const rows = await args.supabase
    .from("inbox_actions")
    .select(
      "id,connection_id,gmail_thread_id,gmail_message_id,metadata,updated_at",
    )
    .eq("user_id", args.userId)
    .eq("provider", "gmail")
    .eq("connection_id", args.candidate.connectionId)
    .eq("gmail_thread_id", args.candidate.threadId)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (rows.error) throw new Error(rows.error.message);
  return latestEmailProviderActionIntent(rows.data || []);
}

async function markProviderIntent(args: {
  supabase: SupabaseClient;
  userId: string;
  intent: EmailProviderActionIntent;
  status: "pending" | "synced" | "superseded";
  changedAt: string;
  error?: unknown;
}): Promise<void> {
  const gmailError =
    args.error instanceof GmailApiError ? args.error : null;
  await persistEmailWorkspaceActionMutation({
    supabase: args.supabase,
    userId: args.userId,
    actionId: args.intent.actionId,
    changedAt: args.changedAt,
    metadataPatch: emailProviderSyncMetadata({
      operation: args.intent.operation,
      requestId: args.intent.requestId,
      requestedAt: args.intent.requestedAt,
      status: args.status,
      attemptedAt:
        args.status === "superseded" ? null : args.changedAt,
      syncedAt: args.status === "synced" ? args.changedAt : null,
      lastError:
        args.status === "pending" && args.error
          ? args.error instanceof Error
            ? args.error.message.slice(0, 500)
            : "Unknown Gmail synchronization error"
          : null,
      retryAfterMs:
        args.status === "pending"
          ? Math.max(
              1_000,
              gmailError?.retryAfterMs || (args.error ? 15_000 : 1_000),
            )
          : null,
    }),
  });
}

async function runProviderSync(
  auth: Extract<Awaited<ReturnType<typeof requireEmailUser>>, { ok: true }>,
) {
  const pendingRows = await auth.supabase
    .from("inbox_actions")
    .select(
      "id,connection_id,gmail_thread_id,gmail_message_id,metadata,updated_at",
    )
    .eq("user_id", auth.userId)
    .eq("provider", "gmail")
    .contains("metadata", { [EMAIL_PROVIDER_SYNC_STATUS_KEY]: "pending" })
    .order("updated_at", { ascending: true })
    .limit(PROVIDER_SYNC_BATCH_SIZE);
  if (pendingRows.error) {
    throw new Error(pendingRows.error.message);
  }

  const candidates = (pendingRows.data || [])
    .map(emailProviderActionIntentFromRow)
    .filter((value): value is EmailProviderActionIntent => value !== null);
  if (candidates.length === 0) {
    return {
      ok: true,
      found: 0,
      attempted: 0,
      synced: 0,
      pending: 0,
      superseded: 0,
      actionIds: [],
      providerRetryAfterMs: 0,
    };
  }

  const mailboxes = await loadGmailMailboxes({
    supabase: auth.supabase,
    userId: auth.userId,
    verifyProfile: false,
  });
  const mailboxByConnection = new Map(
    mailboxes.map((mailbox) => [mailbox.connectionId, mailbox]),
  );
  const syncedActionIds: string[] = [];
  let attempted = 0;
  let stillPending = 0;
  let superseded = 0;
  let retryAfterMs = 0;
  let providerRetryAfterMs = 0;

  for (const candidate of candidates) {
    let current: EmailProviderActionIntent | null = null;
    try {
      current = await currentProviderIntent({
        supabase: auth.supabase,
        userId: auth.userId,
        candidate,
      });
    } catch (error) {
      stillPending += 1;
      console.error("[email/action/sync] intent validation failed", {
        actionId: candidate.actionId,
        requestId: candidate.requestId,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      continue;
    }
    if (
      !current ||
      current.status !== "pending" ||
      current.requestId !== candidate.requestId ||
      current.requestedAt !== candidate.requestedAt
    ) {
      if (current && current.actionId !== candidate.actionId) {
        try {
          await markProviderIntent({
            supabase: auth.supabase,
            userId: auth.userId,
            intent: candidate,
            status: "superseded",
            changedAt: new Date().toISOString(),
          });
          superseded += 1;
        } catch (error) {
          stillPending += 1;
          console.error("[email/action/sync] supersede write failed", {
            actionId: candidate.actionId,
            requestId: candidate.requestId,
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
      continue;
    }

    const mailbox = mailboxByConnection.get(current.connectionId);
    if (!mailbox) {
      stillPending += 1;
      retryAfterMs = Math.max(retryAfterMs, 5 * 60_000);
      console.warn("[email/action/sync] mailbox unavailable", {
        actionId: current.actionId,
        connectionId: current.connectionId,
        requestId: current.requestId,
      });
      continue;
    }

    attempted += 1;
    let providerMutationApplied = false;
    try {
      await syncEmailWorkspaceProviderAction({
        mailbox,
        operation: current.operation,
        threadId: current.threadId,
        messageId: current.messageId,
        requestedAt: current.requestedAt,
        priority: "interactive",
      });
      providerMutationApplied = true;
      const stillCurrent = await currentProviderIntent({
        supabase: auth.supabase,
        userId: auth.userId,
        candidate: current,
      });
      if (
        !stillCurrent ||
        stillCurrent.requestId !== current.requestId ||
        stillCurrent.requestedAt !== current.requestedAt
      ) {
        // A newer action arrived while this provider request was running. The
        // older mutation may have landed last, so requeue the newest intent;
        // the next isolated sync cycle restores Gmail to the user's final
        // decision without changing the already-correct workspace state.
        if (stillCurrent && stillCurrent.status !== "superseded") {
          await markProviderIntent({
            supabase: auth.supabase,
            userId: auth.userId,
            intent: stillCurrent,
            status: "pending",
            changedAt: new Date().toISOString(),
          });
          stillPending += 1;
          retryAfterMs = Math.max(retryAfterMs, 1_000);
        }
        if (
          stillCurrent &&
          stillCurrent.actionId !== current.actionId
        ) {
          await markProviderIntent({
            supabase: auth.supabase,
            userId: auth.userId,
            intent: current,
            status: "superseded",
            changedAt: new Date().toISOString(),
          });
          superseded += 1;
        }
        continue;
      }
      if (stillCurrent.status === "synced") {
        syncedActionIds.push(current.actionId);
        continue;
      }
      if (stillCurrent.status !== "pending") continue;
      await markProviderIntent({
        supabase: auth.supabase,
        userId: auth.userId,
        intent: current,
        status: "synced",
        changedAt: new Date().toISOString(),
      });
      syncedActionIds.push(current.actionId);
    } catch (error) {
      const failedAt = new Date().toISOString();
      if (providerMutationApplied) {
        stillPending += 1;
        retryAfterMs = Math.max(retryAfterMs, 1_000);
        console.error("[email/action/sync] reconciliation write failed", {
          actionId: current.actionId,
          requestId: current.requestId,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        continue;
      }
      const delay =
        error instanceof GmailApiError
          ? Math.max(1_000, error.retryAfterMs || 15_000)
          : 15_000;
      retryAfterMs = Math.max(retryAfterMs, delay);
      if (error instanceof GmailApiError && error.status === 429) {
        providerRetryAfterMs = Math.max(providerRetryAfterMs, delay);
      }
      stillPending += 1;
      try {
        await markProviderIntent({
          supabase: auth.supabase,
          userId: auth.userId,
          intent: current,
          status: "pending",
          changedAt: failedAt,
          error,
        });
      } catch (persistenceError) {
        console.error("[email/action/sync] failure write failed", {
          actionId: current.actionId,
          requestId: current.requestId,
          message:
            persistenceError instanceof Error
              ? persistenceError.message
              : "Unknown persistence error",
        });
      }
      console.warn("[email/action/sync] provider sync deferred", {
        operation: current.operation,
        connectionId: current.connectionId,
        threadId: current.threadId,
        actionId: current.actionId,
        requestId: current.requestId,
        retryAfterMs: delay,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return {
    ok: true,
    found: candidates.length,
    attempted,
    synced: syncedActionIds.length,
    pending: stillPending,
    superseded,
    retryAfterMs,
    providerRetryAfterMs,
    actionIds: syncedActionIds,
  };
}

export async function POST() {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  try {
    const coordinated = await withEmailProviderRequest({
      supabase: auth.supabase,
      userId: auth.userId,
      scope: "action-sync",
      execute: () => runProviderSync(auth),
      leaseMs: 60_000,
      freshMs: 8_000,
      staleMs: 15_000,
      waitMs: 2_000,
      serializeProvider: true,
      retryAfterMsFromValue: (value) => value.providerRetryAfterMs,
    });
    return NextResponse.json(coordinated.value, {
      headers: {
        "X-Groovy-Email-Provider-Result": coordinated.disposition,
      },
    });
  } catch (error) {
    return jsonError(error, "Could not synchronize pending email actions.");
  }
}
