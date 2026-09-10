import assert from "node:assert/strict";
import test from "node:test";
import {
  actionFromRow,
  actionMatchesWorkspaceView,
  applyConversationWorkspaceOverrides,
  applyReferencedWorkspaceCorrection,
  applyRelatedCalendarWorkspaceOverrides,
  authoritativeEmailConversationRemovals,
  compareEmailThreadSummaries,
  compareEmailThreadSummariesByRecency,
  dedupeEmailConversationSummaries,
  dedupeEmailConversationSummariesDetailed,
  draftFromRow,
  emailActionStateConversationRemovals,
  emailActionIsUnread,
  emailActionHydrationRows,
  emailActionStatRowFromProjection,
  emailActionStats,
  emailFeedStats,
  emailFocusUnreadCount,
  emailThreadSummaryKey,
  emailThreadSummaryComparatorForView,
  emailViewUsesIndexedActionFallback,
  gmailFeedPageRequestOptions,
  gmailFullDepthPageSizePerMailbox,
  gmailInboxConversationView,
  gmailLivePageSizePerMailbox,
  gmailQueryForEmailView,
  gmailViewUsesLatestThreadMessage,
  latestEmailActionRowsByConversation,
  providerVerifiedFocusSummary,
  referencedWorkspaceCorrectionIndex,
  selectFocusRecoveryCandidates,
  summaryFromGmail,
  summaryFromTrackingRow,
} from "./service";
import type { GmailThreadListItem } from "./gmail";
import type { EmailMailbox } from "./types";

const mailbox: EmailMailbox = {
  connectionId: "gmail-1",
  provider: "gmail",
  address: "owner@example.com",
  displayName: "Work",
  color: "#22d3ee",
  monogram: "WO",
  isDefaultSender: true,
  includedInUnified: true,
  aiInstructions: "",
  status: "connected",
  counts: { inbox: 0, focus: 0, drafts: 0, noise: 0 },
};

function gmailMessage(
  id: string,
  threadId = "thread-1",
): GmailThreadListItem {
  return {
    id,
    threadId,
    from: "Alex <alex@example.com>",
    to: "owner@example.com",
    cc: "",
    subject: "Stable identity",
    date: "Mon, 27 Jul 2026 12:00:00 -0400",
    internalDate: "2026-07-27T16:00:00.000Z",
    messageIdHeader: `<${id}@example.com>`,
    references: "",
    snippet: "One exact message",
    labelIds: ["INBOX", "UNREAD"],
    hasAttachments: false,
    hasCalendarInvitation: false,
  };
}

test("AI reply actions with a draft are ready for review", () => {
  const action = actionFromRow({
    id: "action-1",
    recommended_action: "draft_reply",
    status: "pending",
    confidence: 0.91,
    draft_body: "Thanks — Tuesday works well.",
    metadata: { summary: "A meeting time is waiting for confirmation." },
  });
  assert.equal(action?.lane, "ready");
  assert.equal(action?.aiGenerated, true);
  assert.equal(action?.summary, "A meeting time is waiting for confirmation.");
});

test("compact action-stat projections preserve routing metadata types", () => {
  assert.deepEqual(
    emailActionStatRowFromProjection({
      id: "action-1",
      status: "pending",
      metadata_override_view: "focus",
      metadata_corrected_at: "2026-08-24T12:00:00.000Z",
      metadata_unread: false,
      metadata_critical: true,
      metadata_calendar_invite: { responseStatus: "needsAction" },
      metadata_tracking_record: false,
    }),
    {
      id: "action-1",
      status: "pending",
      metadata: {
        email_workspace_override_view: "focus",
        email_workspace_corrected_at: "2026-08-24T12:00:00.000Z",
        email_workspace_unread: false,
        critical: true,
        calendar_invite: { responseStatus: "needsAction" },
        email_tracking_record: false,
      },
    },
  );
});

test("compact routing rows retain rich draft metadata for live cards", () => {
  const [hydrated] = emailActionHydrationRows(
    [
      {
        id: "action-1",
        status: "done",
        metadata: {
          email_workspace_override_view: "handled",
          email_workspace_corrected_at: "2026-08-24T12:00:00.000Z",
        },
      },
    ],
    [
      {
        id: "action-1",
        status: "pending",
        draft_to: ["recipient@example.com"],
        metadata: {
          summary: "A rich summary",
          email_draft_body_html: "<p>Hello</p>",
          email_draft_attachments: [{ filename: "audit.pdf" }],
        },
      },
    ],
  );
  assert.equal(hydrated.status, "done");
  assert.deepEqual(hydrated.draft_to, ["recipient@example.com"]);
  assert.deepEqual(hydrated.metadata, {
    summary: "A rich summary",
    email_draft_body_html: "<p>Hello</p>",
    email_draft_attachments: [{ filename: "audit.pdf" }],
    email_workspace_override_view: "handled",
    email_workspace_corrected_at: "2026-08-24T12:00:00.000Z",
  });
});

test("noise remains visible even after an automatic spam action completes", () => {
  const action = actionFromRow({
    id: "action-2",
    recommended_action: "mark_spam",
    status: "done",
    confidence: 0.98,
    metadata: {},
  });
  assert.equal(action?.lane, "noise");
});

test("low-confidence classifications are put in the decision lane", () => {
  const action = actionFromRow({
    id: "action-3",
    recommended_action: "label_only",
    status: "pending",
    confidence: 0.52,
    metadata: {},
  });
  assert.equal(action?.lane, "decide");
});

test("a completed label-only action remains in Focus when user work remains", () => {
  const action = actionFromRow({
    id: "action-contract-signature",
    recommended_action: "label_only",
    status: "done",
    confidence: 0.95,
    p_important: 0.97,
    p_actionable: 0.97,
    reason: "A legal agreement must be reviewed and signed externally.",
    metadata: {},
  });
  assert.equal(action?.lane, "read");
  assert.equal(action?.important, 0.97);
  assert.equal(action?.actionable, 0.97);
});

test("an archived calendar invitation returns to Focus until it is answered", () => {
  const pending = actionFromRow({
    id: "calendar-invite",
    subject: "Invitation: Quarterly planning @ Friday",
    recommended_action: "archive",
    status: "done",
    confidence: 0.88,
    metadata: {
      calendar_invite_detected: true,
      calendar_invite_verified: true,
    },
  });
  const accepted = actionFromRow({
    id: "calendar-invite",
    subject: "Invitation: Quarterly planning @ Friday",
    recommended_action: "archive",
    status: "done",
    confidence: 0.88,
    metadata: {
      calendar_invite_detected: true,
      calendar_invite_verified: true,
      calendar_rsvp_status: "accepted",
    },
  });

  assert.equal(pending?.lane, "read");
  assert.equal(accepted?.lane, "handled");
});

test("an explicit user placement still wins over invitation routing", () => {
  const action = actionFromRow({
    id: "calendar-invite",
    subject: "Invitation: Quarterly planning @ Friday",
    recommended_action: "archive",
    status: "done",
    confidence: 0.88,
    metadata: {
      calendar_invite_detected: true,
      calendar_invite_verified: true,
      email_workspace_override_view: "noise",
    },
  });

  assert.equal(action?.lane, "noise");
});

test("a forwarded calendar update with no calendar MIME stays non-actionable", () => {
  const summary = summaryFromGmail(
    {
      ...gmailMessage("forwarded-calendar"),
      subject:
        "Updated invitation: KiwiTech Payment || ACID LABS @ Thursday",
      hasCalendarInvitation: false,
    },
    mailbox,
    {
      id: "action-forwarded-calendar",
      recommended_action: "label_only",
      status: "pending",
      confidence: 0.95,
      p_important: 0.95,
      p_actionable: 0.8,
      metadata: {
        calendar_invite_detected: true,
        calendar_invite_verified: true,
      },
    },
  );

  assert.equal(summary.calendarInvite, null);
  assert.equal(summary.action?.lane, "read");
});

test("a genuine Gmail calendar MIME part exposes RSVP controls", () => {
  const summary = summaryFromGmail(
    {
      ...gmailMessage("genuine-calendar"),
      subject: "Invitation: Quarterly planning @ Friday",
      hasCalendarInvitation: true,
    },
    mailbox,
  );

  assert.equal(summary.calendarInvite?.responseStatus, "needsAction");
  assert.equal(summary.calendarInvite?.title, "Quarterly planning");
});

test("a user's visual correction overrides the original classification", () => {
  const action = actionFromRow({
    id: "action-4",
    recommended_action: "mark_spam",
    status: "done",
    confidence: 0.99,
    metadata: { email_workspace_override_view: "handled" },
  });
  assert.equal(action?.lane, "handled");
});

test("an email explicitly restored to Needs Review is excluded from Focus counts", () => {
  assert.equal(
    actionMatchesWorkspaceView(
      {
        recommended_action: "label_only",
        status: "pending",
        confidence: 0.9,
        metadata: { email_workspace_override_view: "inbox" },
      },
      "focus",
    ),
    false,
  );
});

test("Focus unread count follows the persisted Gmail read state", () => {
  const base = {
    connection_id: "gmail-1",
    gmail_thread_id: "thread-1",
    recommended_action: "label_only",
    status: "pending",
    confidence: 0.9,
    created_at: "2026-07-30T18:00:00.000Z",
  };
  assert.equal(emailActionIsUnread(base), true);
  assert.equal(
    emailFocusUnreadCount([
      {
        ...base,
        metadata: { email_workspace_unread: false },
      },
      {
        ...base,
        gmail_thread_id: "thread-2",
        metadata: { email_workspace_unread: true },
      },
      {
        ...base,
        gmail_thread_id: "thread-3",
        metadata: { email_workspace_override_view: "inbox" },
      },
    ]),
    1,
  );
});

test("Gmail-backed views cover every Groovy workspace label", () => {
  const focus = gmailQueryForEmailView("focus") || "";
  const inbox = gmailQueryForEmailView("inbox") || "";
  const all = gmailQueryForEmailView("all") || "";
  const handled = gmailQueryForEmailView("handled") || "";
  const noise = gmailQueryForEmailView("noise") || "";
  assert.equal(focus, "in:inbox");
  assert.equal(inbox, "in:inbox");
  assert.match(all, /^in:anywhere/);
  assert.match(all, /-in:trash/);
  assert.match(all, /-in:drafts/);
  assert.match(handled, /label:"Groovy\/Processed"/);
  assert.match(handled, /-label:"Groovy\/Spam"/);
  assert.match(noise, /label:"Groovy\/Spam"/);
  assert.match(noise, /label:"Groovy\/Unsubscribed"/);
});

test("conversation views resolve the true latest Gmail thread message", () => {
  assert.equal(gmailViewUsesLatestThreadMessage("sent"), true);
  assert.equal(gmailViewUsesLatestThreadMessage("handled"), true);
  assert.equal(gmailViewUsesLatestThreadMessage("noise"), true);
  assert.equal(gmailViewUsesLatestThreadMessage("focus"), true);
  assert.equal(gmailViewUsesLatestThreadMessage("inbox"), true);
  assert.equal(gmailViewUsesLatestThreadMessage("all"), false);
});

test("an untriaged incoming reply to a sent conversation enters Focus immediately", () => {
  const reply = {
    ...gmailMessage("reply-1"),
    threadHasSentMessage: true,
  };
  assert.equal(
    gmailInboxConversationView({
      item: reply,
      direction: "incoming",
    }),
    "focus",
  );
  assert.equal(
    gmailInboxConversationView({
      item: { ...reply, threadHasSentMessage: false },
      direction: "incoming",
    }),
    "inbox",
  );
  assert.equal(
    gmailInboxConversationView({
      item: reply,
      direction: "outgoing",
    }),
    null,
  );
  assert.equal(
    gmailInboxConversationView({
      item: reply,
      direction: "incoming",
      actionRow: {
        recommended_action: "label_only",
        status: "pending",
        confidence: 0.2,
        metadata: { triage_decision_source: "model_failure" },
      },
    }),
    "focus",
  );
  assert.equal(
    gmailInboxConversationView({
      item: { ...reply, threadHasSentMessage: false },
      direction: "incoming",
      actionRow: {
        recommended_action: "label_only",
        status: "pending",
        confidence: 0.2,
        metadata: { triage_decision_source: "model_failure" },
      },
    }),
    "inbox",
  );
  assert.equal(
    gmailInboxConversationView({
      item: reply,
      direction: "incoming",
      actionRow: {
        recommended_action: "label_only",
        status: "pending",
        confidence: 0.95,
      },
    }),
    "focus",
  );
  assert.equal(
    gmailInboxConversationView({
      item: reply,
      direction: "incoming",
      actionRow: {
        recommended_action: "mark_spam",
        status: "done",
        confidence: 0.98,
      },
    }),
    null,
  );
});

test("a deeper Focus candidate is materialized only after Gmail confirms Inbox", () => {
  const sent = {
    ...gmailMessage("sent-1"),
    from: "owner@example.com",
    to: "Mark <mark@example.com>",
    labelIds: ["SENT"],
    internalDate: "2026-07-29T16:00:00.000Z",
  };
  const reply = {
    ...gmailMessage("reply-1"),
    from: "Mark <mark@example.com>",
    internalDate: "2026-07-30T16:00:00.000Z",
  };
  const actionRow = {
    id: "action-reply",
    recommended_action: "label_only",
    status: "pending",
    confidence: 0.96,
    metadata: {},
  };

  const verified = providerVerifiedFocusSummary({
    items: [sent, reply],
    mailbox,
    ownedAddresses: [mailbox.address],
    actionRow,
  });
  assert.equal(verified?.messageId, "reply-1");
  assert.equal(verified?.senderName, "Mark");
  assert.equal(verified?.action?.lane, "read");

  assert.equal(
    providerVerifiedFocusSummary({
      items: [sent, { ...reply, labelIds: [] }],
      mailbox,
      ownedAddresses: [mailbox.address],
      actionRow,
    }),
    null,
  );
});

test("explicit Focus placement does not compete with automatic recovery cap", () => {
  const automatic = Array.from({ length: 6 }, (_, index) => ({
    id: `automatic-${index + 1}`,
    metadata: {},
  }));
  const mark = {
    id: "mark",
    metadata: {
      email_workspace_override_view: "focus",
      email_workspace_user_action: "move_focus",
    },
  };

  const selected = selectFocusRecoveryCandidates(
    [...automatic.slice(0, 4), mark, ...automatic.slice(4)],
    24,
  );

  assert.deepEqual(
    selected.map((row) => row.id),
    ["mark", "automatic-1", "automatic-2", "automatic-3", "automatic-4"],
  );
});

test("explicit Focus recovery respects the requested first-page budget", () => {
  const explicit = Array.from({ length: 4 }, (_, index) => ({
    id: `explicit-${index + 1}`,
    metadata: {
      email_workspace_override_view: "focus",
      email_workspace_user_action: "move_focus",
    },
  }));

  assert.deepEqual(
    selectFocusRecoveryCandidates(explicit, 2).map((row) => row.id),
    ["explicit-1", "explicit-2"],
  );
});

test("a provider-verified thread with a latest outgoing message stays out of Focus", () => {
  const incoming = gmailMessage("incoming-1");
  const outgoing = {
    ...gmailMessage("outgoing-1"),
    from: "owner@example.com",
    to: "Mark <mark@example.com>",
    labelIds: ["SENT"],
    internalDate: "2026-07-30T16:00:00.000Z",
  };
  assert.equal(
    providerVerifiedFocusSummary({
      items: [incoming, outgoing],
      mailbox,
      ownedAddresses: [mailbox.address],
    }),
    null,
  );
});

test("an active incoming Focus action survives a newer outgoing reply", () => {
  const incoming = {
    ...gmailMessage("mark-reply"),
    from: "Mark <mark@example.com>",
  };
  const outgoing = {
    ...gmailMessage("owner-reply"),
    from: "owner@example.com",
    to: "Mark <mark@example.com>",
    labelIds: ["SENT"],
    internalDate: "2026-07-30T16:00:00.000Z",
  };
  const verified = providerVerifiedFocusSummary({
    items: [incoming, outgoing],
    mailbox,
    ownedAddresses: [mailbox.address],
    actionRow: {
      id: "mark-action",
      gmail_message_id: "mark-reply",
      recommended_action: "draft_reply",
      status: "pending",
      confidence: 0.82,
      draft_body: "A pending reply for Mark",
      metadata: {},
    },
  });
  assert.equal(verified?.messageId, "mark-reply");
  assert.equal(verified?.senderName, "Mark");
  assert.equal(verified?.action?.lane, "ready");
});

test("a newer incoming reply becomes the visible Focus card", () => {
  const original = {
    ...gmailMessage("mark-original"),
    from: "Mark <mark@example.com>",
    snippet: "Can you review this?",
    internalDate: "2026-07-29T16:00:00.000Z",
  };
  const outgoing = {
    ...gmailMessage("owner-reply"),
    from: "owner@example.com",
    to: "Mark <mark@example.com>",
    snippet: "I reviewed it.",
    labelIds: ["SENT"],
    internalDate: "2026-07-30T16:00:00.000Z",
  };
  const newestReply = {
    ...gmailMessage("mark-latest"),
    from: "Mark <mark@example.com>",
    snippet: "Thanks. I have one more question.",
    internalDate: "2026-07-31T16:00:00.000Z",
  };

  const verified = providerVerifiedFocusSummary({
    items: [original, outgoing, newestReply],
    mailbox,
    ownedAddresses: [mailbox.address],
    actionRow: {
      id: "mark-action",
      gmail_message_id: "mark-original",
      recommended_action: "label_only",
      status: "pending",
      confidence: 0.95,
      metadata: {},
    },
  });

  assert.equal(verified?.messageId, "mark-latest");
  assert.equal(verified?.senderName, "Mark");
  assert.equal(verified?.snippet, "Thanks. I have one more question.");
  assert.equal(verified?.unread, true);
});

test("an immediate Focus reply ranks as Worth Reading before triage", () => {
  const olderRead = summaryFromGmail(
    gmailMessage("classified-read", "thread-read"),
    mailbox,
    {
      id: "action-read",
      recommended_action: "label_only",
      status: "pending",
      confidence: 0.95,
      metadata: {},
    },
  );
  const liveReply = summaryFromGmail(
    {
      ...gmailMessage("live-reply", "thread-reply"),
      internalDate: "2026-07-28T16:00:00.000Z",
      threadHasSentMessage: true,
    },
    mailbox,
  );

  assert.ok(compareEmailThreadSummaries(liveReply, olderRead) < 0);
});

test("All Mail remains a complete safety view after Groovy classifies mail", () => {
  const query = gmailQueryForEmailView("all") || "";
  assert.equal(query.includes("Groovy/Processed"), false);
  assert.equal(query.includes("Groovy/Spam"), false);
  assert.equal(query.includes("Groovy/Unsubscribed"), false);
});

test("sent tracking records make a truthful outgoing snapshot", () => {
  const summary = summaryFromTrackingRow(
    {
      id: "tracking-1",
      connection_id: "gmail-1",
      gmail_message_id: "sent-message-1",
      gmail_thread_id: "sent-thread-1",
      subject: "Quarterly update",
      snippet: "Here is the latest update.",
      created_at: "2026-07-28T14:00:00.000Z",
      metadata: {
        email_tracking_record: true,
        email_tracking_recipients: [
          "First@Example.com",
          "second@example.com",
        ],
        email_tracking_subject: "Quarterly update",
        email_tracking_sent_at: "2026-07-28T14:01:00.000Z",
        email_tracking_open_count: 2,
        email_tracking_first_opened_at: "2026-07-28T14:05:00.000Z",
      },
    },
    mailbox,
  );

  assert.equal(summary.direction, "outgoing");
  assert.equal(summary.senderName, "first@example.com +1");
  assert.deepEqual(summary.recipients, [
    "first@example.com",
    "second@example.com",
  ]);
  assert.equal(summary.receivedAt, "2026-07-28T14:01:00.000Z");
  assert.equal(summary.openStatus?.openCount, 2);
  assert.equal(summary.action, null);
});

test("Needs Review starts from the complete Gmail Inbox before action filtering", () => {
  const query = gmailQueryForEmailView("inbox") || "";
  assert.equal(query, "in:inbox");
  assert.equal(query.includes("Groovy/Processed"), false);
  assert.equal(query.includes("Groovy/Spam"), false);
  assert.equal(query.includes("Groovy/Unsubscribed"), false);
});

test("unified Gmail pages bound per-mailbox fanout without hiding pagination", () => {
  assert.equal(gmailFullDepthPageSizePerMailbox(8), 8);
  assert.equal(gmailFullDepthPageSizePerMailbox(24), 12);
  assert.equal(gmailFullDepthPageSizePerMailbox(100), 12);
  assert.equal(gmailLivePageSizePerMailbox("all", 24, 1), 12);
  assert.equal(gmailLivePageSizePerMailbox("all", 12, 3), 4);
  assert.equal(gmailLivePageSizePerMailbox("focus", 24, 3), 8);
  assert.equal(gmailLivePageSizePerMailbox("inbox", 24, 3), 8);
  assert.equal(gmailLivePageSizePerMailbox("sent", 24, 1), 8);
  assert.equal(gmailLivePageSizePerMailbox("sent", 24, 3), 8);
  assert.equal(gmailLivePageSizePerMailbox("handled", 24, 1), 8);
  assert.equal(gmailLivePageSizePerMailbox("noise", 12, 3), 4);
});

test("visible Gmail pages are prioritized without saturating Gmail", () => {
  assert.deepEqual(gmailFeedPageRequestOptions("all", true), {
    detailConcurrency: 4,
    priority: "interactive",
  });
  assert.deepEqual(gmailFeedPageRequestOptions("all", false), {
    priority: "interactive",
  });
  assert.deepEqual(gmailFeedPageRequestOptions("sent", true), {
    priority: "interactive",
  });
});

test("Needs Review keeps uncertainty while confident junk goes to Noise", () => {
  assert.equal(
    actionMatchesWorkspaceView(
      {
        recommended_action: "label_only",
        status: "pending",
        confidence: 0.79,
        metadata: {},
      },
      "inbox",
    ),
    true,
  );
  assert.equal(
    actionMatchesWorkspaceView(
      {
        recommended_action: "mark_spam",
        status: "pending",
        confidence: 0.8,
        metadata: {},
      },
      "noise",
    ),
    true,
  );
  assert.equal(
    actionMatchesWorkspaceView(
      {
        recommended_action: "mark_spam",
        status: "pending",
        confidence: 0.8,
        metadata: {},
      },
      "inbox",
    ),
    false,
  );
  assert.equal(
    actionMatchesWorkspaceView(
      {
        recommended_action: "unsubscribe",
        status: "pending",
        confidence: 0.95,
        metadata: {},
      },
      "inbox",
    ),
    false,
  );
  assert.equal(
    actionMatchesWorkspaceView(
      {
        recommended_action: "unsubscribe",
        status: "pending",
        confidence: 0.95,
        metadata: {},
      },
      "noise",
    ),
    true,
  );
});

test("a Done correction suppresses every old action in the conversation", () => {
  const rows = applyConversationWorkspaceOverrides([
    {
      id: "ready-action",
      connection_id: "gmail-1",
      gmail_message_id: "message-1",
      gmail_thread_id: "thread-1",
      recommended_action: "draft_reply",
      status: "pending",
      confidence: 0.9,
      draft_body: "A ready reply",
      received_at: "2026-07-01T12:00:00.000Z",
      metadata: {},
    },
    {
      id: "done-action",
      connection_id: "gmail-1",
      gmail_message_id: "message-1",
      gmail_thread_id: "thread-1",
      recommended_action: "archive",
      status: "done",
      confidence: 1,
      received_at: "2026-07-01T12:00:00.000Z",
      metadata: {
        email_workspace_override_view: "handled",
        email_workspace_corrected_at: "2026-07-27T12:00:00.000Z",
      },
    },
    {
      id: "new-reply",
      connection_id: "gmail-1",
      gmail_message_id: "message-2",
      gmail_thread_id: "thread-1",
      recommended_action: "draft_reply",
      status: "pending",
      confidence: 0.9,
      draft_body: "A fresh reply",
      received_at: "2026-07-28T12:00:00.000Z",
      metadata: {},
    },
  ]);
  assert.equal(actionFromRow(rows[0])?.lane, "handled");
  assert.equal(actionFromRow(rows[1])?.lane, "handled");
  assert.equal(actionFromRow(rows[2])?.lane, "ready");
});

test("queue statistics count each Gmail conversation exactly once", () => {
  const rows = [
    {
      id: "newest",
      connection_id: "gmail-1",
      gmail_message_id: "message-2",
      gmail_thread_id: "thread-1",
      recommended_action: "archive",
      status: "done",
      confidence: 1,
      metadata: { email_workspace_override_view: "handled" },
    },
    {
      id: "older",
      connection_id: "gmail-1",
      gmail_message_id: "message-1",
      gmail_thread_id: "thread-1",
      recommended_action: "draft_reply",
      status: "pending",
      confidence: 0.9,
      draft_body: "An obsolete draft",
      metadata: {},
    },
    {
      id: "other-thread",
      connection_id: "gmail-1",
      gmail_message_id: "message-3",
      gmail_thread_id: "thread-2",
      recommended_action: "label_only",
      status: "pending",
      confidence: 0.97,
      metadata: {},
    },
  ];

  assert.deepEqual(
    latestEmailActionRowsByConversation(rows).map((row) => row.id),
    ["newest", "other-thread"],
  );
  assert.deepEqual(emailActionStats(rows), {
    focus: 1,
    processed: 1,
    draftsReady: 0,
    needsReview: 0,
    noiseCaught: 0,
  });
});

test("historical action rows cannot materialize Focus cards", () => {
  assert.equal(emailViewUsesIndexedActionFallback("focus"), false);
  assert.equal(emailViewUsesIndexedActionFallback("inbox"), false);
  assert.equal(emailViewUsesIndexedActionFallback("handled"), true);
  assert.equal(emailViewUsesIndexedActionFallback("noise"), true);
});

test("Focus totals only count conversations the current queue can materialize", () => {
  const currentRows = [
    {
      id: "current-focus",
      connection_id: "gmail-1",
      gmail_message_id: "message-current",
      gmail_thread_id: "thread-current",
      recommended_action: "draft_reply",
      status: "pending",
      confidence: 0.95,
      draft_body: "Current draft",
      metadata: {},
    },
  ];
  const historicalRows = [
    ...currentRows,
    {
      id: "historical-focus",
      connection_id: "gmail-1",
      gmail_message_id: "message-historical",
      gmail_thread_id: "thread-historical",
      recommended_action: "label_only",
      status: "done",
      confidence: 0.95,
      metadata: {},
    },
    {
      id: "historical-handled",
      connection_id: "gmail-1",
      gmail_message_id: "message-handled",
      gmail_thread_id: "thread-handled",
      recommended_action: "archive",
      status: "done",
      confidence: 0.95,
      metadata: {},
    },
  ];

  assert.deepEqual(
    emailFeedStats({
      materializedRows: currentRows,
      allRows: historicalRows,
    }),
    {
      focus: 1,
      processed: 1,
      draftsReady: 1,
      needsReview: 0,
      noiseCaught: 0,
    },
  );
});

test("a live Needs Review queue overrides stale historical action totals", () => {
  const historicalRows = Array.from({ length: 250 }, (_, index) => ({
    id: `historical-review-${index}`,
    connection_id: "gmail-1",
    gmail_message_id: `message-${index}`,
    gmail_thread_id: `thread-${index}`,
    recommended_action: "label_only",
    status: "pending",
    confidence: 0.5,
    metadata: {},
  }));

  assert.equal(
    emailFeedStats({
      materializedRows: historicalRows.slice(0, 10),
      allRows: historicalRows,
      liveNeedsReviewCount: 5,
    }).needsReview,
    5,
  );
});

test("a newer reply wins over an older Calendar correction without received_at", () => {
  const rows = applyConversationWorkspaceOverrides([
    {
      id: "calendar-response",
      connection_id: "gmail-1",
      gmail_message_id: "message-1",
      gmail_thread_id: "thread-1",
      recommended_action: "label_only",
      status: "done",
      confidence: 1,
      created_at: "2026-07-28T12:00:00.000Z",
      metadata: {
        email_workspace_override_view: "handled",
        email_workspace_corrected_at: "2026-07-28T12:00:00.000Z",
        email_workspace_user_action: "calendar_rsvp",
      },
    },
    {
      id: "new-reply",
      connection_id: "gmail-1",
      gmail_message_id: "message-2",
      gmail_thread_id: "thread-1",
      recommended_action: "draft_reply",
      status: "pending",
      confidence: 0.9,
      draft_body: "A fresh reply",
      received_at: "2026-07-29T12:00:00.000Z",
      created_at: "2026-07-29T12:01:00.000Z",
      metadata: {},
    },
  ]);

  assert.equal(latestEmailActionRowsByConversation(rows)[0]?.id, "new-reply");
  assert.deepEqual(emailActionStats(rows), {
    focus: 1,
    processed: 0,
    draftsReady: 1,
    needsReview: 0,
    noiseCaught: 0,
  });
});

test("Done follows an existing RFC reply across connected mailboxes", () => {
  const correctedAt = "2026-08-09T22:41:39.175Z";
  const corrections = referencedWorkspaceCorrectionIndex([
    {
      connection_id: "gmail-1",
      gmail_message_id: "first-reply",
      gmail_thread_id: "first-thread",
      sender_email: "jack@example.com",
      subject: "Re: Hibe Strategic Sale Process",
      metadata: {
        message_id_header: "<first-reply@example.com>",
        email_workspace_override_view: "handled",
        email_workspace_corrected_at: correctedAt,
        email_workspace_user_action: "move_handled",
      },
    },
  ]);
  const crossMailboxReply: GmailThreadListItem = {
    ...gmailMessage("second-reply", "second-thread"),
    from: "Jack <jack@example.com>",
    subject: "Re: Re: Hibe Strategic Sale Process",
    internalDate: "2026-08-09T22:39:29.000Z",
    messageIdHeader: "<second-reply@example.com>",
    references:
      "<original@example.com> <first-reply@example.com> <our-reply@example.com>",
  };
  const corrected = applyReferencedWorkspaceCorrection({
    item: crossMailboxReply,
    actionRow: {
      id: "second-action",
      recommended_action: "archive",
      status: "pending",
      confidence: 0.72,
      metadata: {},
    },
    corrections,
  });

  assert.equal(actionFromRow(corrected || {})?.lane, "handled");
  assert.equal(
    (corrected?.metadata as Record<string, unknown>)
      .email_workspace_corrected_at,
    correctedAt,
  );
});

test("an RFC reply received after Done reopens the conversation", () => {
  const corrections = referencedWorkspaceCorrectionIndex([
    {
      sender_email: "jack@example.com",
      subject: "Re: Hibe Strategic Sale Process",
      metadata: {
        message_id_header: "<first-reply@example.com>",
        email_workspace_override_view: "handled",
        email_workspace_corrected_at: "2026-08-09T22:41:39.175Z",
        email_workspace_user_action: "move_handled",
      },
    },
  ]);
  const laterReply: GmailThreadListItem = {
    ...gmailMessage("later-reply", "later-thread"),
    from: "Jack <jack@example.com>",
    subject: "Re: Re: Hibe Strategic Sale Process",
    internalDate: "2026-08-09T22:45:00.000Z",
    messageIdHeader: "<later-reply@example.com>",
    references: "<first-reply@example.com>",
  };
  const actionRow = {
    recommended_action: "archive",
    status: "pending",
    confidence: 0.72,
    metadata: {},
  };

  assert.equal(
    applyReferencedWorkspaceCorrection({
      item: laterReply,
      actionRow,
      corrections,
    }),
    actionRow,
  );
});

test("RFC correction matching requires the same sender and subject", () => {
  const corrections = referencedWorkspaceCorrectionIndex([
    {
      sender_email: "jack@example.com",
      subject: "Re: Hibe Strategic Sale Process",
      metadata: {
        message_id_header: "<first-reply@example.com>",
        email_workspace_override_view: "handled",
        email_workspace_corrected_at: "2026-08-09T22:41:39.175Z",
        email_workspace_user_action: "move_handled",
      },
    },
  ]);
  const base: GmailThreadListItem = {
    ...gmailMessage("candidate", "candidate-thread"),
    internalDate: "2026-08-09T22:39:29.000Z",
    references: "<first-reply@example.com>",
  };

  assert.equal(
    applyReferencedWorkspaceCorrection({
      item: {
        ...base,
        from: "Mallory <mallory@example.com>",
        subject: "Re: Hibe Strategic Sale Process",
      },
      corrections,
    }),
    undefined,
  );
  assert.equal(
    applyReferencedWorkspaceCorrection({
      item: {
        ...base,
        from: "Jack <jack@example.com>",
        subject: "Re: A different conversation",
      },
      corrections,
    }),
    undefined,
  );
});

test("label-backed history excludes actions whose resolved lane is still active", () => {
  const active = {
    recommended_action: "archive",
    status: "pending",
    confidence: 0.72,
    metadata: {},
  };

  assert.equal(actionMatchesWorkspaceView(active, "handled"), false);
  assert.equal(actionMatchesWorkspaceView(active, "inbox"), true);
});

test("an RSVP also handles its exact scheduling confirmation but not a human reply", () => {
  const acceptedAt = "2026-08-09T22:39:29.437Z";
  const rows = applyRelatedCalendarWorkspaceOverrides([
    {
      id: "scheduling-confirmation",
      connection_id: "gmail-1",
      gmail_message_id: "confirmation-message",
      gmail_thread_id: "confirmation-thread",
      sender_email: "jack@example.com",
      subject:
        "Confirmed: Monday, August 10, 2026 · 12:30 PM EDT with Jack Pitts",
      received_at: "2026-08-09T22:36:10.000Z",
      recommended_action: "archive",
      status: "pending",
      confidence: 0.72,
      metadata: { message_kind: "calendar" },
    },
    {
      id: "invitation",
      connection_id: "gmail-1",
      gmail_message_id: "invitation-message",
      gmail_thread_id: "invitation-thread",
      sender_email: "jack@example.com",
      subject:
        "Invitation: Meeting @ Mon Aug 10, 2026 12:30pm - 1pm (EDT)",
      received_at: "2026-08-09T22:36:22.000Z",
      recommended_action: "label_only",
      status: "done",
      confidence: 1,
      metadata: {
        message_kind: "calendar",
        calendar_rsvp_status: "accepted",
        calendar_rsvp_responded_at: acceptedAt,
        calendar_invite: { start: "2026-08-10T12:30:00-04:00" },
        email_workspace_override_view: "handled",
        email_workspace_corrected_at: acceptedAt,
        email_workspace_user_action: "calendar_rsvp",
      },
    },
    {
      id: "human-reply",
      connection_id: "gmail-1",
      gmail_message_id: "reply-message",
      gmail_thread_id: "reply-thread",
      sender_email: "jack@example.com",
      subject: "Re: A separate conversation",
      received_at: "2026-08-09T22:39:29.000Z",
      recommended_action: "archive",
      status: "pending",
      confidence: 0.72,
      metadata: { message_kind: "human" },
    },
  ]);

  assert.equal(actionFromRow(rows[0])?.lane, "handled");
  assert.equal(
    (rows[0].metadata as Record<string, unknown>)
      .email_workspace_user_action,
    "calendar_rsvp_related_confirmation",
  );
  assert.equal(actionFromRow(rows[2])?.lane, "decide");
  assert.deepEqual(
    authoritativeEmailConversationRemovals([rows[0]], "inbox"),
    [
      {
        id: "gmail-1:confirmation-thread",
        correctedAt: acceptedAt,
      },
    ],
  );
});

test("calendar correlation preserves confirmations for another event or sender", () => {
  const rows = applyRelatedCalendarWorkspaceOverrides([
    {
      connection_id: "gmail-1",
      gmail_message_id: "different-time",
      gmail_thread_id: "different-time-thread",
      sender_email: "jack@example.com",
      subject:
        "Confirmed: Monday, August 10, 2026 · 1:30 PM EDT with Jack Pitts",
      received_at: "2026-08-09T22:36:10.000Z",
      recommended_action: "archive",
      status: "pending",
      confidence: 0.72,
      metadata: { message_kind: "calendar" },
    },
    {
      connection_id: "gmail-1",
      gmail_message_id: "different-sender",
      gmail_thread_id: "different-sender-thread",
      sender_email: "someone-else@example.com",
      subject:
        "Confirmed: Monday, August 10, 2026 · 12:30 PM EDT with Someone Else",
      received_at: "2026-08-09T22:36:10.000Z",
      recommended_action: "archive",
      status: "pending",
      confidence: 0.72,
      metadata: { message_kind: "calendar" },
    },
    {
      connection_id: "gmail-1",
      gmail_message_id: "invitation-message",
      gmail_thread_id: "invitation-thread",
      sender_email: "jack@example.com",
      received_at: "2026-08-09T22:36:22.000Z",
      recommended_action: "label_only",
      status: "done",
      confidence: 1,
      metadata: {
        message_kind: "calendar",
        calendar_rsvp_status: "accepted",
        calendar_rsvp_responded_at: "2026-08-09T22:39:29.437Z",
        calendar_invite: { start: "2026-08-10T12:30:00-04:00" },
        email_workspace_override_view: "handled",
      },
    },
  ]);

  assert.equal(actionFromRow(rows[0])?.lane, "decide");
  assert.equal(actionFromRow(rows[1])?.lane, "decide");
});

test("only explicit user actions authorize cross-client queue removal", () => {
  const correctedAt = "2026-07-28T12:00:00.000Z";
  const explicit = {
    connection_id: "gmail-1",
    gmail_thread_id: "thread-1",
    metadata: {
      email_workspace_override_view: "handled",
      email_workspace_corrected_at: correctedAt,
      email_workspace_user_action: "move_handled",
    },
  };
  const automatic = {
    connection_id: "gmail-1",
    gmail_thread_id: "thread-2",
    metadata: {
      email_workspace_override_view: "handled",
      email_workspace_corrected_at: correctedAt,
    },
  };

  assert.deepEqual(
    authoritativeEmailConversationRemovals(
      [explicit, automatic],
      "inbox",
    ),
    [
      {
        id: "gmail-1:thread-1",
        correctedAt,
      },
    ],
  );
  assert.deepEqual(
    authoritativeEmailConversationRemovals([explicit], "handled"),
    [],
  );
});

test("a bounded action delta removes an automatically completed Focus card", () => {
  const updatedAt = "2026-08-16T23:22:02.370Z";
  const completedArchive = {
    id: "action-1",
    connection_id: "gmail-1",
    gmail_message_id: "message-1",
    gmail_thread_id: "thread-1",
    recommended_action: "archive",
    status: "done",
    confidence: 0.94,
    received_at: "2026-08-16T23:21:04.000Z",
    updated_at: updatedAt,
    metadata: {},
  };

  assert.deepEqual(
    emailActionStateConversationRemovals(
      [completedArchive],
      "focus",
    ),
    [
      {
        id: "gmail-1:thread-1",
        correctedAt: updatedAt,
      },
    ],
  );
  assert.deepEqual(
    emailActionStateConversationRemovals(
      [completedArchive],
      "handled",
    ),
    [],
  );
});

test("draft recipients preserve To, Cc, and Bcc separately", () => {
  const draft = draftFromRow({
    id: "action-5",
    connection_id: "gmail-1",
    gmail_thread_id: "thread-1",
    gmail_message_id: "message-1",
    gmail_draft_id: "draft-1",
    draft_to: ["to@example.com"],
    draft_cc: ["copy@example.com"],
    draft_bcc: ["private@example.com"],
    draft_subject: "Hello",
    draft_body: "Body",
    metadata: {},
  });
  assert.deepEqual(draft?.to, ["to@example.com"]);
  assert.deepEqual(draft?.cc, ["copy@example.com"]);
  assert.deepEqual(draft?.bcc, ["private@example.com"]);
});

test("stored automatic drafts hide connected identities but preserve external recipients", () => {
  const draft = draftFromRow(
    {
      id: "action-owned-recipient",
      connection_id: "gmail-1",
      gmail_thread_id: "thread-1",
      gmail_message_id: "message-1",
      gmail_draft_id: "draft-1",
      draft_to: ["client@example.com", "ME@HIBE.AI"],
      draft_cc: ["alias@hibe.ai", "copy@example.com"],
      draft_bcc: ["client@example.com", "private@example.com"],
      draft_subject: "Hello",
      draft_body: "Body",
      metadata: { owned_addresses: ["alias@hibe.ai"] },
    },
    { ownedAddresses: ["me@hibe.ai"] },
  );
  assert.deepEqual(draft?.to, ["client@example.com"]);
  assert.deepEqual(draft?.cc, ["copy@example.com"]);
  assert.deepEqual(draft?.bcc, ["private@example.com"]);
});

test("messages in the same Gmail conversation keep separate card identities", () => {
  const first = summaryFromGmail(gmailMessage("message-1"), mailbox);
  const second = summaryFromGmail(gmailMessage("message-2"), mailbox);
  assert.notEqual(first.key, second.key);
  assert.equal(first.key, "gmail-1:message:message-1");
  assert.equal(second.key, "gmail-1:message:message-2");
});

test("a feed shows one card per conversation using its newest message", () => {
  const oldMessage = summaryFromGmail(
    gmailMessage("message-1"),
    mailbox,
  );
  const newMessage = summaryFromGmail(
    {
      ...gmailMessage("message-2"),
      internalDate: "2026-07-28T16:00:00.000Z",
      snippet: "The actual latest reply",
    },
    mailbox,
  );
  const deduped = dedupeEmailConversationSummaries([
    oldMessage,
    newMessage,
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].messageId, "message-2");
  assert.equal(deduped[0].snippet, "The actual latest reply");
});

test("Unified shows one canonical card for one RFC email delivered to two mailboxes", () => {
  const secondaryMailbox: EmailMailbox = {
    ...mailbox,
    connectionId: "gmail-2",
    address: "alias@example.com",
    displayName: "Secondary",
    isDefaultSender: false,
  };
  const sharedMessage = {
    ...gmailMessage("primary-copy", "primary-thread"),
    to: "Owner <owner@example.com>",
    messageIdHeader: "<SHARED-DELIVERY@example.com>",
  };
  const primary = summaryFromGmail(sharedMessage, mailbox, {
    id: "primary-action",
    gmail_message_id: "primary-copy",
    recommended_action: "draft_reply",
    status: "pending",
    confidence: 0.95,
    draft_body: "Reply from the canonical mailbox",
    metadata: {},
  });
  const secondary = summaryFromGmail(
    {
      ...sharedMessage,
      id: "secondary-copy",
      threadId: "secondary-thread",
    },
    secondaryMailbox,
    {
      id: "secondary-action",
      gmail_message_id: "secondary-copy",
      recommended_action: "draft_reply",
      status: "pending",
      confidence: 0.95,
      draft_body: "Duplicate reply",
      metadata: {},
    },
  );

  const result = dedupeEmailConversationSummariesDetailed([
    secondary,
    primary,
  ]);
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0].connectionId, "gmail-1");
  assert.equal(
    result.threads[0].internetMessageId,
    "shared-delivery@example.com",
  );
  assert.deepEqual(
    result.suppressedMailboxCopies.map((thread) => thread.connectionId),
    ["gmail-2"],
  );
});

test("different RFC emails remain separate even when their visible content matches", () => {
  const secondaryMailbox: EmailMailbox = {
    ...mailbox,
    connectionId: "gmail-2",
    address: "alias@example.com",
  };
  const first = summaryFromGmail(gmailMessage("message-a"), mailbox);
  const second = summaryFromGmail(
    gmailMessage("message-b", "thread-b"),
    secondaryMailbox,
  );
  assert.equal(
    dedupeEmailConversationSummaries([first, second]).length,
    2,
  );
});

test("chronological views are newest-first even when an older message has a higher AI rank", () => {
  const olderReady = summaryFromGmail(
    gmailMessage("message-1"),
    mailbox,
    {
      id: "action-1",
      recommended_action: "draft_reply",
      status: "pending",
      confidence: 0.95,
      draft_body: "A ready reply",
      metadata: {},
    },
  );
  const newerUnclassified = summaryFromGmail(
    {
      ...gmailMessage("message-2", "thread-2"),
      internalDate: "2026-07-28T16:00:00.000Z",
    },
    mailbox,
  );

  assert.ok(
    compareEmailThreadSummaries(olderReady, newerUnclassified) < 0,
  );
  assert.ok(
    emailThreadSummaryComparatorForView("inbox")(
      newerUnclassified,
      olderReady,
    ) < 0,
  );
  assert.ok(
    emailThreadSummaryComparatorForView("all")(
      newerUnclassified,
      olderReady,
    ) < 0,
  );
  assert.ok(
    compareEmailThreadSummariesByRecency(
      newerUnclassified,
      olderReady,
    ) < 0,
  );
});

test("conversation deduplication always keeps the newest preview", () => {
  const olderReady = summaryFromGmail(
    gmailMessage("message-1"),
    mailbox,
    {
      id: "action-1",
      recommended_action: "draft_reply",
      status: "pending",
      confidence: 0.95,
      draft_body: "A ready reply",
      metadata: {},
    },
  );
  const newerUnclassified = summaryFromGmail(
    {
      ...gmailMessage("message-2"),
      internalDate: "2026-07-28T16:00:00.000Z",
      snippet: "Newest message wins",
    },
    mailbox,
  );

  const [deduped] = dedupeEmailConversationSummaries([
    olderReady,
    newerUnclassified,
  ]);
  assert.equal(deduped.messageId, "message-2");
  assert.equal(deduped.snippet, "Newest message wins");
});

test("an action identity remains stable between feed and detail summaries", () => {
  const actionRow = {
    id: "action-1",
    gmail_message_id: "message-1",
    gmail_thread_id: "thread-1",
    recommended_action: "label_only",
    status: "pending",
    confidence: 0.9,
    metadata: {},
  };
  const summary = summaryFromGmail(
    gmailMessage("message-1"),
    mailbox,
    actionRow,
  );
  assert.equal(
    summary.key,
    emailThreadSummaryKey({
      connectionId: "gmail-1",
      actionId: "action-1",
      messageId: "message-1",
      threadId: "thread-1",
    }),
  );
  assert.equal(summary.key, "gmail-1:message:message-1");
});

test("equal-ranked cards sort deterministically by immutable key", () => {
  const first = summaryFromGmail(gmailMessage("message-a"), mailbox);
  const second = summaryFromGmail(gmailMessage("message-b"), mailbox);
  assert.equal(compareEmailThreadSummaries(first, second), -1);
  assert.equal(compareEmailThreadSummaries(second, first), 1);
});
