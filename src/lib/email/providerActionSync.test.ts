import assert from "node:assert/strict";
import test from "node:test";
import {
  emailProviderActionIntentFromRow,
  emailProviderSyncMetadata,
  emailWorkspaceActionNeedsDurableProviderSync,
  gmailLabelChangeForEmailWorkspaceOperation,
  gmailMessageIdsAtOrBefore,
  latestEmailProviderActionIntent,
} from "./providerActionSync";
import { GROOVY_EMAIL_LABELS } from "./gmail";
import type { GmailThreadListItem } from "./gmail";

function gmailItem(id: string, internalDate: string): GmailThreadListItem {
  return {
    id,
    threadId: "thread-1",
    from: "sender@example.com",
    to: "owner@example.com",
    cc: "",
    subject: "Conversation",
    date: internalDate,
    internalDate,
    messageIdHeader: `<${id}@example.com>`,
    references: "",
    snippet: id,
    labelIds: ["INBOX"],
    hasAttachments: false,
    hasCalendarInvitation: false,
  };
}

test("queue placement operations persist before provider synchronization", () => {
  for (const operation of [
    "archive",
    "spam",
    "restore",
    "move_focus",
    "move_inbox",
    "move_noise",
    "move_handled",
  ] as const) {
    assert.equal(emailWorkspaceActionNeedsDurableProviderSync(operation), true);
  }
  for (const operation of ["read", "unread", "star", "unstar"] as const) {
    assert.equal(
      emailWorkspaceActionNeedsDurableProviderSync(operation),
      false,
    );
  }
});

test("Done removes Inbox and applies the durable processed label", () => {
  assert.deepEqual(
    gmailLabelChangeForEmailWorkspaceOperation({
      operation: "move_handled",
      labels: {
        [GROOVY_EMAIL_LABELS.processed]: "processed-id",
        [GROOVY_EMAIL_LABELS.spam]: "spam-id",
      },
    }),
    {
      addLabelIds: ["processed-id"],
      removeLabelIds: ["INBOX", "SPAM", "TRASH", "spam-id"],
    },
  );
});

test("pending provider metadata retains a stable retry identity", () => {
  const metadata = emailProviderSyncMetadata({
    operation: "move_handled",
    requestId: "request-1",
    requestedAt: "2026-08-28T12:17:53.000Z",
    status: "pending",
    attemptedAt: "2026-08-28T12:17:54.000Z",
    lastError: "Rate limit exceeded",
    retryAfterMs: 7_000.9,
  });
  assert.deepEqual(metadata, {
    email_workspace_provider_sync_status: "pending",
    email_workspace_provider_sync_operation: "move_handled",
    email_workspace_provider_sync_request_id: "request-1",
    email_workspace_provider_sync_requested_at:
      "2026-08-28T12:17:53.000Z",
    email_workspace_provider_sync_last_attempt_at:
      "2026-08-28T12:17:54.000Z",
    email_workspace_provider_synced_at: null,
    email_workspace_provider_sync_last_error: "Rate limit exceeded",
    email_workspace_provider_sync_retry_after_ms: 7_000,
  });
});

test("a deferred Done never archives a reply received after the action", () => {
  assert.deepEqual(
    gmailMessageIdsAtOrBefore({
      items: [
        gmailItem("original", "2026-08-28T12:00:00.000Z"),
        gmailItem("new-reply", "2026-08-28T12:02:00.000Z"),
      ],
      cutoff: "2026-08-28T12:01:00.000Z",
      fallbackMessageId: "original",
    }),
    ["original"],
  );
});

test("a deferred action falls back to its stored message identity", () => {
  assert.deepEqual(
    gmailMessageIdsAtOrBefore({
      items: [gmailItem("undated", "")],
      cutoff: "2026-08-28T12:01:00.000Z",
      fallbackMessageId: "stored-message",
    }),
    ["stored-message"],
  );
});

test("retry parsing rejects malformed and non-placement rows", () => {
  assert.equal(
    emailProviderActionIntentFromRow({
      id: "action-1",
      connection_id: "connection-1",
      gmail_thread_id: "thread-1",
      metadata: emailProviderSyncMetadata({
        operation: "read",
        requestId: "request-1",
        requestedAt: "2026-08-28T12:00:00.000Z",
        status: "pending",
      }),
    }),
    null,
  );
  assert.equal(
    emailProviderActionIntentFromRow({
      id: "action-1",
      connection_id: "connection-1",
      metadata: emailProviderSyncMetadata({
        operation: "move_handled",
        requestId: "request-1",
        requestedAt: "2026-08-28T12:00:00.000Z",
        status: "pending",
      }),
    }),
    null,
  );
});

test("only the newest provider intent for a conversation is eligible", () => {
  const row = (
    id: string,
    operation: "move_handled" | "move_inbox",
    requestedAt: string,
    status: "pending" | "synced" = "pending",
  ) => ({
    id,
    connection_id: "connection-1",
    gmail_thread_id: "thread-1",
    gmail_message_id: "message-1",
    metadata: emailProviderSyncMetadata({
      operation,
      requestId: `request-${id}`,
      requestedAt,
      status,
    }),
  });
  const latest = latestEmailProviderActionIntent([
    row("older-done", "move_handled", "2026-08-28T12:00:00.000Z"),
    row(
      "newer-inbox",
      "move_inbox",
      "2026-08-28T12:01:00.000Z",
      "synced",
    ),
  ]);
  assert.equal(latest?.actionId, "newer-inbox");
  assert.equal(latest?.operation, "move_inbox");
  assert.equal(latest?.status, "synced");
});
