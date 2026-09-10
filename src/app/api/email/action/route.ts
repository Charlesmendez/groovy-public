import { NextResponse } from "next/server";
import { jsonError, requireEmailUser } from "@/lib/email/auth";
import {
  completedEmailWorkspaceAction,
  emailActionBelongsToConversation,
  emailWorkspaceOverrideForOperation,
  parseEmailWorkspaceActionOperation,
} from "@/lib/email/actionState";
import {
  EmailWorkspacePersistenceError,
  persistEmailWorkspaceActionMutation,
  requirePersistedEmailWorkspaceActionId,
} from "@/lib/email/actionPersistence";
import { shouldRecordEmailClassificationFeedback } from "@/lib/email/classificationFeedback";
import {
  findOwnedGmailMailbox,
  GmailApiError,
} from "@/lib/email/gmail";
import {
  emailProviderSyncMetadata,
  emailWorkspaceActionNeedsDurableProviderSync,
  syncEmailWorkspaceProviderAction,
} from "@/lib/email/providerActionSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RecordLike = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

export async function POST(request: Request) {
  const auth = await requireEmailUser();
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as RecordLike | null;
  const connectionId = text(body?.connectionId);
  const threadId = text(body?.threadId);
  const messageId = text(body?.messageId);
  const actionId = text(body?.actionId);
  const requestId = text(body?.requestId).slice(0, 100);
  const op = parseEmailWorkspaceActionOperation(body?.operation);
  if (!connectionId || !threadId || !op) {
    return NextResponse.json(
      { ok: false, error: "connectionId, threadId and operation are required." },
      { status: 400 },
    );
  }
  if (
    !actionId &&
    emailWorkspaceActionNeedsDurableProviderSync(op) &&
    !messageId
  ) {
    return NextResponse.json(
      { ok: false, error: "messageId is required for this operation." },
      { status: 400 },
    );
  }
  const providerSyncRequestId = requestId || crypto.randomUUID();
  let durableProviderSyncActionId = "";
  let durableProviderSyncRequestedAt = "";
  let providerMutationCompleted = false;
  try {
    const mailbox = await findOwnedGmailMailbox({
      supabase: auth.supabase,
      userId: auth.userId,
      connectionId,
    });
    if (!mailbox) {
      return NextResponse.json(
        { ok: false, error: "Mailbox not found." },
        { status: 404 },
      );
    }
    let currentAction: RecordLike | null = null;
    if (actionId) {
      const { data, error } = await auth.supabase
        .from("inbox_actions")
        .select("id,metadata,gmail_thread_id,gmail_message_id")
        .eq("id", actionId)
        .eq("user_id", auth.userId)
        .eq("connection_id", connectionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) {
        return NextResponse.json(
          { ok: false, error: "Email action not found." },
          { status: 404 },
        );
      }
      const storedThreadId = text(data.gmail_thread_id);
      const storedMessageId = text(data.gmail_message_id);
      const belongsToThread = emailActionBelongsToConversation({
        storedThreadId,
        storedMessageId,
        requestedThreadId: threadId,
        requestedMessageId: messageId,
      });
      if (!belongsToThread) {
        return NextResponse.json(
          { ok: false, error: "This action belongs to another conversation." },
          { status: 409 },
        );
      }
      currentAction = data as RecordLike;
    }
    let resolvedActionId = actionId;
    if (emailWorkspaceActionNeedsDurableProviderSync(op)) {
      // The workspace decision is the durable user intent. Persist it before
      // contacting Gmail so a temporary provider throttle cannot make another
      // device resurrect a card that the user already marked Done/moved.
      const now = new Date().toISOString();
      durableProviderSyncRequestedAt = now;
      const complete = completedEmailWorkspaceAction(op);
      const overrideView = emailWorkspaceOverrideForOperation(op);
      const metadataPatch = {
        email_workspace_override_view: overrideView,
        email_workspace_corrected_at: now,
        email_workspace_user_action: op,
        ...emailProviderSyncMetadata({
          operation: op,
          requestId: providerSyncRequestId,
          requestedAt: now,
          status: "pending",
        }),
      };
      if (resolvedActionId && currentAction) {
        await persistEmailWorkspaceActionMutation({
          supabase: auth.supabase,
          userId: auth.userId,
          actionId: text(currentAction.id),
          changedAt: now,
          metadataPatch,
          status: complete ? "done" : null,
          executedAt: complete ? now : null,
          closeActiveSiblings: complete,
          correctionCutoff: complete ? now : null,
        });
      } else {
        const noise = op === "spam" || op === "move_noise";
        const focus = op === "move_focus";
        const inbox = op === "restore" || op === "move_inbox";
        const receivedAt = text(body?.receivedAt);
        const safeReceivedAt = Number.isFinite(Date.parse(receivedAt))
          ? new Date(receivedAt).toISOString()
          : null;
        const recommendedAction = noise
          ? "mark_spam"
          : focus || inbox
            ? "label_only"
            : "archive";
        const created = await auth.supabase
          .from("inbox_actions")
          .upsert(
            {
              user_id: auth.userId,
              provider: "gmail",
              connection_id: connectionId,
              mailbox_label: mailbox.displayName || mailbox.address,
              gmail_message_id: messageId,
              gmail_thread_id: threadId,
              sender_email: text(body?.senderEmail) || null,
              sender_name: text(body?.senderName) || null,
              sender_domain: text(body?.senderEmail).split("@")[1] || null,
              subject: text(body?.subject) || null,
              snippet: text(body?.snippet) || null,
              received_at: safeReceivedAt,
              recommended_action: recommendedAction,
              status: complete ? "done" : "pending",
              confidence: 1,
              p_important: focus ? 1 : 0.5,
              p_spam: noise ? 1 : 0,
              p_actionable: focus ? 1 : 0.2,
              reason: noise
                ? "Moved to Noise by the user."
                : focus
                  ? "Moved to Focus by the user."
                  : inbox
                    ? "Moved to Inbox by the user."
                    : "Handled by the user.",
              metadata: metadataPatch,
              ...(complete ? { executed_at: now } : {}),
              updated_at: now,
            },
            {
              onConflict:
                "user_id,provider,connection_id,gmail_message_id,recommended_action",
              ignoreDuplicates: true,
            },
          )
          .select("id")
          .maybeSingle();
        let markerId = text(created.data?.id);
        if (created.error) {
          requirePersistedEmailWorkspaceActionId(created);
        }
        if (!markerId) {
          const existing = await auth.supabase
            .from("inbox_actions")
            .select("id")
            .eq("user_id", auth.userId)
            .eq("provider", "gmail")
            .eq("connection_id", connectionId)
            .eq("gmail_message_id", messageId)
            .eq("recommended_action", recommendedAction)
            .maybeSingle();
          markerId = requirePersistedEmailWorkspaceActionId(existing);
        }
        await persistEmailWorkspaceActionMutation({
          supabase: auth.supabase,
          userId: auth.userId,
          actionId: markerId,
          changedAt: now,
          metadataPatch,
          status: complete ? "done" : "pending",
          executedAt: complete ? now : null,
          closeActiveSiblings: complete,
          correctionCutoff: complete ? now : null,
        });
        resolvedActionId = markerId;
      }
      durableProviderSyncActionId = resolvedActionId;
    }

    if (shouldRecordEmailClassificationFeedback(op)) {
      const correctedAction = op.replace("move_", "");
      const feedback = {
        user_id: auth.userId,
        provider: "gmail",
        connection_id: connectionId,
        gmail_thread_id: threadId,
        gmail_message_id: messageId || null,
        action_id: resolvedActionId || null,
        sender_email: text(body?.senderEmail) || null,
        sender_domain: text(body?.senderEmail).split("@")[1] || null,
        previous_action: text(body?.previousView) || null,
        corrected_action: correctedAction,
        scope: body?.scope === "global" ? "global" : "mailbox",
        request_id: requestId || null,
      };
      const write = auth.supabase.from("email_classification_feedback");
      const { error } = requestId
        ? await write.upsert(feedback, {
            onConflict: "user_id,request_id",
            ignoreDuplicates: true,
          })
        : await write.insert(feedback);
      if (error) {
        console.warn(
          "[email/action] Workspace saved but learning feedback was not stored:",
          error.message,
        );
      }
    }

    await syncEmailWorkspaceProviderAction({
      mailbox,
      operation: op,
      threadId,
      messageId,
      priority: "interactive",
    });
    providerMutationCompleted = true;
    if (durableProviderSyncActionId) {
      const syncedAt = new Date().toISOString();
      await persistEmailWorkspaceActionMutation({
        supabase: auth.supabase,
        userId: auth.userId,
        actionId: durableProviderSyncActionId,
        changedAt: syncedAt,
        metadataPatch: emailProviderSyncMetadata({
          operation: op,
          requestId: providerSyncRequestId,
          requestedAt: durableProviderSyncRequestedAt,
          status: "synced",
          attemptedAt: syncedAt,
          syncedAt,
        }),
      });
    }
    if (op === "read" || op === "unread") {
      // Read state is a conversation property, so one newest non-tracking
      // action is the durable synchronization marker. Rewriting hundreds of
      // historical rows made a tap wait on many database round trips and
      // emitted a Realtime update storm carrying stale queue corrections.
      let row =
        currentAction &&
        record(currentAction.metadata).email_tracking_record !== true
          ? currentAction
          : null;
      if (!row) {
        const conversationAction = await auth.supabase
          .from("inbox_actions")
          .select("id,metadata")
          .eq("user_id", auth.userId)
          .eq("provider", "gmail")
          .eq("connection_id", connectionId)
          .eq("gmail_thread_id", threadId)
          .order("received_at", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false })
          .limit(10);
        if (conversationAction.error) {
          throw new EmailWorkspacePersistenceError(
            conversationAction.error.message,
          );
        } else {
          row = (conversationAction.data || [])
            .map((value) => record(value))
            .find(
              (value) =>
                record(value.metadata).email_tracking_record !== true,
            ) || null;
        }
      }
      if (row) {
        const now = new Date().toISOString();
        await persistEmailWorkspaceActionMutation({
          supabase: auth.supabase,
          userId: auth.userId,
          actionId: text(row.id),
          changedAt: now,
          metadataPatch: {
            email_workspace_unread: op === "unread",
            email_workspace_read_changed_at: now,
          },
        });
      }
    }
    return NextResponse.json({ ok: true, actionId: resolvedActionId || null });
  } catch (error) {
    if (durableProviderSyncActionId) {
      const failedAt = new Date().toISOString();
      const retryAfterMs =
        error instanceof GmailApiError
          ? Math.max(1_000, error.retryAfterMs || 3_000)
          : 15_000;
      try {
        await persistEmailWorkspaceActionMutation({
          supabase: auth.supabase,
          userId: auth.userId,
          actionId: durableProviderSyncActionId,
          changedAt: failedAt,
          metadataPatch: emailProviderSyncMetadata({
            operation: op,
            requestId: providerSyncRequestId,
            requestedAt: durableProviderSyncRequestedAt,
            status: "pending",
            attemptedAt: failedAt,
            lastError:
              error instanceof Error
                ? error.message.slice(0, 500)
                : "Unknown Gmail synchronization error",
            retryAfterMs,
          }),
        });
      } catch (persistenceError) {
        // The initial durable intent already succeeded. This update only adds
        // diagnostic/backoff metadata, so keep the accepted user decision even
        // if the best-effort error annotation cannot be written.
        console.error("[email/action] pending sync metadata update failed", {
          actionId: durableProviderSyncActionId,
          requestId: providerSyncRequestId,
          message:
            persistenceError instanceof Error
              ? persistenceError.message
              : "Unknown persistence error",
        });
      }
      console.warn("[email/action] provider sync deferred", {
        operation: op,
        connectionId,
        threadId,
        actionId: durableProviderSyncActionId,
        requestId: providerSyncRequestId,
        retryAfterMs,
        message:
          error instanceof Error ? error.message : "Unknown provider error",
      });
      return NextResponse.json(
        {
          ok: true,
          actionId: durableProviderSyncActionId,
          providerSyncPending: true,
          retryAfterMs,
        },
        { status: 202 },
      );
    }
    console.error("[email/action] failed", {
      operation: op,
      connectionId,
      threadId,
      requestId: providerSyncRequestId,
      message:
        error instanceof Error ? error.message : "Unknown email action error",
    });
    if (error instanceof GmailApiError && error.retryable) {
      const retryAfterMs = Math.max(1_000, error.retryAfterMs || 3_000);
      return NextResponse.json(
        {
          ok: false,
          error:
            "Gmail is temporarily limiting updates. Groovy will retry this action.",
          retryable: true,
          retryAfterMs,
        },
        {
          status: error.status === 429 ? 429 : 503,
          headers: {
            "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
          },
        },
      );
    }
    if (error instanceof EmailWorkspacePersistenceError) {
      console.error(
        providerMutationCompleted
          ? "[email/action] Gmail updated but workspace history was not stored:"
          : "[email/action] workspace intent was not stored; Gmail was not updated:",
        error.details || error.message,
      );
      return NextResponse.json(
        {
          ok: false,
          error: providerMutationCompleted
            ? "Gmail was updated, but Groovy is still saving this change. It will retry automatically."
            : "Groovy could not save this email change. It will retry without changing Gmail first.",
          retryable: true,
          retryAfterMs: 1_000,
        },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
    return jsonError(error, "Could not update this email.");
  }
}
