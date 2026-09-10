import assert from "node:assert/strict";
import test from "node:test";
import {
  draftReplyActionBlocksNewMessage,
  EMAIL_TRIAGE_MODEL_FAILURE_SOURCE,
  EMAIL_TRIAGE_SUPERSEDED_REASON,
  emailActionIsRetryableModelFailure,
  emailActionNeedsPolicyRefresh,
  filterUnorganizedEmails,
  gmailTriageInboxQuery,
  interleaveEmailTriageCandidates,
  shouldSupersedeEmailClassification,
  shouldReleaseDraftReplyThreadClaim,
} from "./triageFreshness";

test("automatic triage only returns messages without an existing action", () => {
  const emails = [
    { connectionId: "work", id: "old", subject: "Already organized" },
    { connectionId: "work", id: "new", subject: "New mail" },
  ];
  const result = filterUnorganizedEmails(emails, [
    { connection_id: "work", gmail_message_id: "old" },
  ]);
  assert.deepEqual(result, [
    { connectionId: "work", id: "new", subject: "New mail" },
  ]);
});

test("pending classifications from an older policy are eligible for one refresh", () => {
  const emails = [{ connectionId: "work", id: "stale" }];
  const stale = {
    connection_id: "work",
    gmail_message_id: "stale",
    status: "pending",
    metadata: { triage_policy_version: 1 },
  };
  assert.equal(emailActionNeedsPolicyRefresh(stale, 2), true);
  assert.deepEqual(
    filterUnorganizedEmails(emails, [stale], { currentPolicyVersion: 2 }),
    emails,
  );
  assert.deepEqual(
    filterUnorganizedEmails(
      emails,
      [{ ...stale, metadata: { triage_policy_version: 2 } }],
      { currentPolicyVersion: 2 },
    ),
    [],
  );
});

test("model failures retry after their cooldown without a policy bump", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const failed = {
    connection_id: "work",
    gmail_message_id: "failed",
    recommended_action: "label_only",
    status: "pending",
    metadata: {
      triage_policy_version: 2,
      triage_decision_source: EMAIL_TRIAGE_MODEL_FAILURE_SOURCE,
      triage_retry_after: past,
    },
  };
  assert.equal(emailActionIsRetryableModelFailure(failed), true);
  assert.equal(emailActionNeedsPolicyRefresh(failed, 2), true);
  assert.deepEqual(
    filterUnorganizedEmails(
      [{ connectionId: "work", id: "failed" }],
      [failed],
      { currentPolicyVersion: 2 },
    ),
    [{ connectionId: "work", id: "failed" }],
  );
});

test("model failure retry cooldown and user placement prevent hot-loop retries", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const failed = {
    recommended_action: "label_only",
    status: "pending",
    metadata: {
      triage_policy_version: 2,
      triage_decision_source: EMAIL_TRIAGE_MODEL_FAILURE_SOURCE,
      triage_retry_after: future,
    },
  };
  assert.equal(emailActionNeedsPolicyRefresh(failed, 2), false);
  assert.equal(
    emailActionNeedsPolicyRefresh(
      {
        ...failed,
        metadata: {
          ...failed.metadata,
          email_workspace_override_view: "focus",
        },
      },
      2,
    ),
    false,
  );
});

test("destructive completed actions and explicit user placements are never reclassified", () => {
  assert.equal(
    emailActionNeedsPolicyRefresh(
      { status: "done", metadata: { triage_policy_version: 0 } },
      2,
    ),
    false,
  );
  assert.equal(
    emailActionNeedsPolicyRefresh(
      {
        status: "pending",
        metadata: { email_workspace_override_view: "focus" },
      },
      2,
    ),
    false,
  );
  assert.equal(
    emailActionNeedsPolicyRefresh(
      {
        recommended_action: "draft_reply",
        status: "pending",
        metadata: { triage_policy_version: 0 },
      },
      2,
    ),
    false,
  );
});

test("completed label bookkeeping can receive a safer classification refresh", () => {
  assert.equal(
    emailActionNeedsPolicyRefresh(
      {
        recommended_action: "label_only",
        status: "done",
        metadata: { triage_policy_version: 0 },
      },
      2,
    ),
    true,
  );
});

test("superseded history does not block a later policy refresh", () => {
  const emails = [{ connectionId: "work", id: "stale" }];
  const actions = [
    {
      connection_id: "work",
      gmail_message_id: "stale",
      recommended_action: "label_only",
      status: "rejected",
      reason: EMAIL_TRIAGE_SUPERSEDED_REASON,
      metadata: { triage_policy_version: 1 },
    },
    {
      connection_id: "work",
      gmail_message_id: "stale",
      recommended_action: "mark_spam",
      status: "pending",
      metadata: { triage_policy_version: 1 },
    },
  ];
  assert.deepEqual(
    filterUnorganizedEmails(emails, actions, { currentPolicyVersion: 2 }),
    emails,
  );
});

test("triage discovery interleaves mailboxes instead of starving later ones", () => {
  assert.deepEqual(
    interleaveEmailTriageCandidates([
      ["work-1", "work-2", "work-3"],
      ["personal-1"],
      ["ops-1", "ops-2"],
    ]),
    ["work-1", "personal-1", "ops-1", "work-2", "ops-2", "work-3"],
  );
});

test("a newer triage policy deterministically supersedes an older classification", () => {
  assert.equal(
    shouldSupersedeEmailClassification({
      candidateId: "older-policy",
      candidateDecisionAt: "2026-08-08T10:00:00.000Z",
      candidatePolicyVersion: 1,
      currentId: "current-policy",
      currentDecisionAt: "2026-08-08T09:00:00.000Z",
      currentPolicyVersion: 2,
    }),
    true,
  );
});

test("only the latest same-policy classification survives concurrent triage", () => {
  const base = {
    candidatePolicyVersion: 2,
    currentPolicyVersion: 2,
  };
  assert.equal(
    shouldSupersedeEmailClassification({
      ...base,
      candidateId: "earlier",
      candidateDecisionAt: "2026-08-08T10:00:00.000Z",
      currentId: "later",
      currentDecisionAt: "2026-08-08T10:00:01.000Z",
    }),
    true,
  );
  assert.equal(
    shouldSupersedeEmailClassification({
      ...base,
      candidateId: "later",
      candidateDecisionAt: "2026-08-08T10:00:01.000Z",
      currentId: "earlier",
      currentDecisionAt: "2026-08-08T10:00:00.000Z",
    }),
    false,
  );
  assert.equal(
    shouldSupersedeEmailClassification({
      ...base,
      candidateId: "00000000-0000-0000-0000-000000000001",
      candidateDecisionAt: "2026-08-08T10:00:00.000Z",
      currentId: "00000000-0000-0000-0000-000000000002",
      currentDecisionAt: "2026-08-08T10:00:00.000Z",
    }),
    true,
  );
});

test("the same Gmail message id remains isolated by mailbox", () => {
  const emails = [
    { connectionId: "work", id: "shared-id" },
    { connectionId: "personal", id: "shared-id" },
  ];
  const result = filterUnorganizedEmails(emails, [
    { connection_id: "work", gmail_message_id: "shared-id" },
  ]);
  assert.deepEqual(result, [
    { connectionId: "personal", id: "shared-id" },
  ]);
});

test("triage sees new replies on previously processed threads", () => {
  const query = gmailTriageInboxQuery(7);

  assert.equal(query, "in:inbox -from:me newer_than:7d");
  assert.equal(query.includes("Groovy/Processed"), false);
  assert.equal(query.includes("Groovy/Unsubscribed"), false);
  assert.equal(query.includes("Groovy/Spam"), false);
});

test("triage bounds invalid lookback values", () => {
  assert.equal(gmailTriageInboxQuery(0), "in:inbox -from:me newer_than:1d");
  assert.equal(gmailTriageInboxQuery(90), "in:inbox -from:me newer_than:30d");
  assert.equal(gmailTriageInboxQuery(Number.NaN), "in:inbox -from:me newer_than:7d");
});

test("only an active draft blocks a new reply in the same thread", () => {
  assert.equal(draftReplyActionBlocksNewMessage("pending"), true);
  assert.equal(draftReplyActionBlocksNewMessage("approved"), true);
  assert.equal(draftReplyActionBlocksNewMessage("executing"), true);
  assert.equal(draftReplyActionBlocksNewMessage("done"), false);
  assert.equal(draftReplyActionBlocksNewMessage("rejected"), false);
  assert.equal(draftReplyActionBlocksNewMessage("failed"), false);
});

test("a completed draft releases its legacy thread claim for a new message", () => {
  assert.equal(
    shouldReleaseDraftReplyThreadClaim({
      status: "done",
      existingMessageId: "old-message",
      incomingMessageId: "new-reply",
    }),
    true,
  );
  assert.equal(
    shouldReleaseDraftReplyThreadClaim({
      status: "pending",
      existingMessageId: "old-message",
      incomingMessageId: "new-reply",
    }),
    false,
  );
  assert.equal(
    shouldReleaseDraftReplyThreadClaim({
      status: "done",
      existingMessageId: "same-message",
      incomingMessageId: "same-message",
    }),
    false,
  );
});
