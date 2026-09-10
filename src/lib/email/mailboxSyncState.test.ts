import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmailMailboxSyncCheckpoint,
  emailMailboxSyncStateFromRow,
  shouldPersistEmailHistoryCursor,
  shouldRunEmailMailboxFullSync,
} from "./mailboxSyncState";

test("parses only durable numeric Gmail history cursors", () => {
  assert.deepEqual(
    emailMailboxSyncStateFromRow({
      connection_id: "mailbox-1",
      history_id: "12345",
      history_page_token: "page-2",
      sync_mode: "full",
      triage_policy_version: 3,
      last_full_sync_at: "2026-09-01T12:00:00.000Z",
      updated_at: "2026-09-01T12:00:01.000Z",
    }),
    {
      connectionId: "mailbox-1",
      historyId: "12345",
      historyPageToken: "page-2",
      syncMode: "full",
      triagePolicyVersion: 3,
      lastFullSyncAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:01.000Z",
    },
  );
  assert.equal(
    emailMailboxSyncStateFromRow({
      connection_id: "mailbox-1",
      history_id: "not-a-history-id",
    }),
    null,
  );
});

test("persists history only after every discovered candidate was attempted", () => {
  assert.equal(
    shouldPersistEmailHistoryCursor({
      discoveredCandidateIds: ["one", "two"],
      attemptedCandidateIds: new Set(["one"]),
    }),
    false,
  );
  assert.equal(
    shouldPersistEmailHistoryCursor({
      discoveredCandidateIds: ["one", "two"],
      attemptedCandidateIds: new Set(["one", "two"]),
    }),
    true,
  );
  assert.equal(
    shouldPersistEmailHistoryCursor({
      discoveredCandidateIds: ["one"],
      attemptedCandidateIds: new Set(["one"]),
    }),
    true,
  );
  assert.equal(
    shouldPersistEmailHistoryCursor({
      discoveredCandidateIds: [],
      attemptedCandidateIds: new Set(),
    }),
    true,
  );
});

test("keeps a durable full-scan page token until initial reconciliation finishes", () => {
  assert.deepEqual(
    buildEmailMailboxSyncCheckpoint({
      connectionId: "mailbox-1",
      cursorHistoryId: "100",
      historyId: "125",
      nextPageToken: "full-page-2",
      fullSync: true,
      triagePolicyVersion: 3,
      discoveredCandidateIds: ["mailbox-1:message-1"],
      attemptedCandidateIds: new Set(["mailbox-1:message-1"]),
    }),
    {
      connectionId: "mailbox-1",
      historyId: "100",
      historyPageToken: "full-page-2",
      syncMode: "full",
      triagePolicyVersion: 3,
      fullSync: false,
    },
  );
});

test("switches a completed full scan to incremental Gmail history", () => {
  assert.deepEqual(
    buildEmailMailboxSyncCheckpoint({
      connectionId: "mailbox-1",
      cursorHistoryId: "100",
      historyId: "125",
      nextPageToken: null,
      fullSync: true,
      triagePolicyVersion: 3,
      discoveredCandidateIds: [],
      attemptedCandidateIds: new Set(),
    }),
    {
      connectionId: "mailbox-1",
      historyId: "125",
      historyPageToken: null,
      syncMode: "history",
      triagePolicyVersion: 3,
      fullSync: true,
    },
  );
});

test("does not advance a mailbox cursor past unattempted candidates", () => {
  assert.equal(
    buildEmailMailboxSyncCheckpoint({
      connectionId: "mailbox-1",
      cursorHistoryId: "100",
      historyId: "125",
      nextPageToken: "history-page-2",
      fullSync: false,
      triagePolicyVersion: 3,
      discoveredCandidateIds: ["mailbox-1:message-1", "mailbox-1:message-2"],
      attemptedCandidateIds: new Set(["mailbox-1:message-1"]),
    }),
    null,
  );
});

test("runs a bounded full reconciliation for policy changes and daily safety", () => {
  const now = Date.parse("2026-09-01T12:00:00.000Z");
  const intervalMs = 24 * 60 * 60_000;
  assert.equal(
    shouldRunEmailMailboxFullSync({
      syncMode: "history",
      triagePolicyVersion: 2,
      currentTriagePolicyVersion: 3,
      lastFullSyncAt: "2026-09-01T11:00:00.000Z",
      now,
      intervalMs,
    }),
    true,
  );
  assert.equal(
    shouldRunEmailMailboxFullSync({
      syncMode: "history",
      triagePolicyVersion: 3,
      currentTriagePolicyVersion: 3,
      lastFullSyncAt: "2026-08-30T12:00:00.000Z",
      now,
      intervalMs,
    }),
    true,
  );
  assert.equal(
    shouldRunEmailMailboxFullSync({
      syncMode: "history",
      triagePolicyVersion: 3,
      currentTriagePolicyVersion: 3,
      lastFullSyncAt: "2026-09-01T11:00:00.000Z",
      now,
      intervalMs,
    }),
    false,
  );
});
