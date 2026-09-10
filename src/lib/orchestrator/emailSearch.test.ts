import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GmailApiError,
  type EmailMailboxConnection,
  type GmailThreadListItem,
} from "@/lib/email/gmail";
import {
  DEFAULT_CONNECTED_GMAIL_QUERY,
  MAX_CONNECTED_GMAIL_RESULTS,
  searchConnectedGmail,
  type ConnectedGmailSearchDependencies,
} from "./emailSearch";

const supabase = {} as SupabaseClient;

function mailbox(
  connectionId: string,
  options: Partial<EmailMailboxConnection> = {},
): EmailMailboxConnection {
  return {
    connectionId,
    provider: "gmail",
    address: `${connectionId}@example.com`,
    displayName: connectionId,
    color: "#22d3ee",
    monogram: connectionId.slice(0, 2).toUpperCase(),
    isDefaultSender: false,
    includedInUnified: true,
    aiInstructions: "",
    status: "connected",
    counts: { inbox: 0, focus: 0, drafts: 0, noise: 0 },
    datagranApiKey: `secret-${connectionId}`,
    ...options,
  };
}

function message(
  id: string,
  timestamp: string,
  options: Partial<GmailThreadListItem> = {},
): GmailThreadListItem {
  return {
    id,
    threadId: `thread-${id}`,
    from: `${id} sender <${id}@sender.example>`,
    to: "owner@example.com",
    cc: "",
    subject: `Subject ${id}`,
    date: "",
    internalDate: timestamp,
    messageIdHeader: `<${id}@sender.example>`,
    references: "",
    snippet: `Snippet ${id}`,
    labelIds: ["INBOX", "UNREAD"],
    hasAttachments: false,
    hasCalendarInvitation: false,
    ...options,
  };
}

test("searchConnectedGmail searches included mailboxes with bounded concurrency and results", async () => {
  const mailboxes = [
    mailbox("work"),
    mailbox("personal"),
    mailbox("team"),
    mailbox("support"),
    mailbox("excluded", { includedInUnified: false }),
  ];
  const itemsByMailbox: Record<string, GmailThreadListItem[]> = {
    work: [message("work-new", "1788100000000")],
    personal: [message("personal-new", "1788200000000")],
    team: [message("team-new", "1788300000000")],
    support: [message("support-new", "1788400000000")],
  };
  let active = 0;
  let maxActive = 0;
  const calls: Array<{ connectionId: string; query?: string; maxResults?: number }> =
    [];
  const dependencies: ConnectedGmailSearchDependencies = {
    loadGmailMailboxes: async (args) => {
      assert.equal(args.userId, "user-1");
      assert.equal(args.verifyProfile, false);
      return mailboxes;
    },
    listGmailThreads: async (args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push({
        connectionId: args.mailbox.connectionId,
        query: args.query,
        maxResults: args.maxResults,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        items: itemsByMailbox[args.mailbox.connectionId] || [],
        nextPageToken: null,
        resultSizeEstimate: 1,
      };
    },
  };

  const result = await searchConnectedGmail(
    { supabase, userId: "user-1", limit: 3 },
    dependencies,
  );

  assert.equal(result.query, DEFAULT_CONNECTED_GMAIL_QUERY);
  assert.equal(result.counts.configuredMailboxes, 5);
  assert.equal(result.counts.selectedMailboxes, 4);
  assert.equal(result.counts.successfulMailboxes, 4);
  assert.equal(result.counts.estimatedMatches, 4);
  assert.equal(result.counts.returnedMessages, 3);
  assert.equal(result.counts.unreadMessages, 3);
  assert.deepEqual(
    result.messages.map((item) => item.id),
    ["support-new", "team-new", "personal-new"],
  );
  assert.equal(calls.some((call) => call.connectionId === "excluded"), false);
  assert.equal(calls.every((call) => call.query === DEFAULT_CONNECTED_GMAIL_QUERY), true);
  assert.equal(calls.every((call) => call.maxResults === 2), true);
  assert.ok(maxActive <= 3);
  assert.ok(result.warnings.some((warning) => warning.code === "results_truncated"));
  assert.equal(result.partial, true);
  assert.equal(JSON.stringify(result).includes("secret-"), false);
});

test("searchConnectedGmail allows an explicitly selected owned mailbox and ignores unknown IDs", async () => {
  const selected = mailbox("excluded", { includedInUnified: false });
  const queried: string[] = [];
  const dependencies: ConnectedGmailSearchDependencies = {
    loadGmailMailboxes: async () => [mailbox("work"), selected],
    listGmailThreads: async (args) => {
      queried.push(args.mailbox.connectionId);
      return {
        items: [
          message("selected-message", "2026-08-30T12:00:00.000Z", {
            labelIds: ["INBOX"],
          }),
        ],
        nextPageToken: null,
        resultSizeEstimate: 1,
      };
    },
  };

  const result = await searchConnectedGmail(
    {
      supabase,
      userId: "user-1",
      connectionIds: ["excluded", "missing", "excluded"],
      query: "  in:inbox from:alex@example.com  ",
    },
    dependencies,
  );

  assert.deepEqual(queried, ["excluded"]);
  assert.equal(result.query, "in:inbox from:alex@example.com");
  assert.equal(result.counts.selectedMailboxes, 1);
  assert.equal(result.messages[0].mailbox.connectionId, "excluded");
  assert.equal(result.messages[0].unread, false);
  assert.ok(result.warnings.some((warning) => warning.code === "mailbox_not_found"));
  assert.equal(result.partial, true);
});

test("searchConnectedGmail describes the matching message instead of a later sent reply", async () => {
  const exactMatch = message("unread-incoming", "1788100000000", {
    from: "Alex <alex@example.com>",
    subject: "Question from Alex",
    snippet: "Could you review this?",
  });
  const latestReply = message("later-sent-reply", "1788200000000", {
    from: "Owner <owner@example.com>",
    subject: "Re: Question from Alex",
    snippet: "I will review it.",
    labelIds: ["SENT"],
    hasAttachments: true,
    matchedItem: exactMatch,
  });
  const result = await searchConnectedGmail(
    { supabase, userId: "user-1" },
    {
      loadGmailMailboxes: async () => [mailbox("work")],
      listGmailThreads: async () => ({
        items: [latestReply],
        nextPageToken: null,
        resultSizeEstimate: 1,
      }),
    },
  );

  assert.equal(result.messages[0].id, "unread-incoming");
  assert.equal(result.messages[0].from, "Alex <alex@example.com>");
  assert.equal(result.messages[0].subject, "Question from Alex");
  assert.equal(result.messages[0].snippet, "Could you review this?");
  assert.equal(result.messages[0].unread, true);
  assert.equal(result.messages[0].hasAttachments, false);
});

test("searchConnectedGmail isolates mailbox failures without exposing upstream errors", async () => {
  const reauth = mailbox("reauth", { status: "reauth_required" });
  const unavailable = mailbox("unavailable");
  const healthy = mailbox("healthy");
  const dependencies: ConnectedGmailSearchDependencies = {
    loadGmailMailboxes: async () => [reauth, unavailable, healthy],
    listGmailThreads: async ({ mailbox: current }) => {
      if (current.connectionId === "reauth") {
        throw new GmailApiError("upstream contained sk-secret-one", {
          status: 401,
          retryable: false,
          needsReauth: true,
        });
      }
      if (current.connectionId === "unavailable") {
        throw new Error("upstream contained sk-secret-two");
      }
      return {
        items: [message("healthy-message", "1788300000000")],
        nextPageToken: null,
        resultSizeEstimate: 1,
      };
    },
  };

  const result = await searchConnectedGmail(
    { supabase, userId: "user-1" },
    dependencies,
  );

  assert.equal(result.counts.successfulMailboxes, 1);
  assert.equal(result.counts.failedMailboxes, 2);
  assert.equal(result.messages[0].id, "healthy-message");
  assert.ok(result.warnings.some((warning) => warning.code === "mailbox_needs_reauth"));
  assert.ok(result.warnings.some((warning) => warning.code === "mailbox_unavailable"));
  assert.equal(result.partial, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("sk-secret-one"), false);
  assert.equal(serialized.includes("sk-secret-two"), false);
});

test("searchConnectedGmail clamps output and reports when no mailbox is connected", async () => {
  const noMailboxes: ConnectedGmailSearchDependencies = {
    loadGmailMailboxes: async () => [],
    listGmailThreads: async () => {
      throw new Error("should not run");
    },
  };
  const empty = await searchConnectedGmail(
    { supabase, userId: "user-1" },
    noMailboxes,
  );
  assert.equal(empty.counts.selectedMailboxes, 0);
  assert.deepEqual(empty.messages, []);
  assert.ok(empty.warnings.some((warning) => warning.code === "no_mailboxes"));

  const many = Array.from({ length: 40 }, (_, index) =>
    message(`message-${index}`, String(1788300000000 + index)),
  );
  const bounded = await searchConnectedGmail(
    { supabase, userId: "user-1", limit: 10_000 },
    {
      loadGmailMailboxes: async () => [mailbox("work")],
      listGmailThreads: async () => ({
        items: many,
        nextPageToken: "next",
        resultSizeEstimate: many.length,
      }),
    },
  );
  assert.equal(bounded.messages.length, MAX_CONNECTED_GMAIL_RESULTS);
  assert.equal(bounded.counts.returnedMessages, MAX_CONNECTED_GMAIL_RESULTS);
  assert.ok(bounded.warnings.some((warning) => warning.code === "results_truncated"));
});

test("searchConnectedGmail propagates cancellation instead of returning a mailbox error", async () => {
  const controller = new AbortController();
  const dependencies: ConnectedGmailSearchDependencies = {
    loadGmailMailboxes: async () => [mailbox("work")],
    listGmailThreads: async () => {
      controller.abort();
      throw new DOMException("Cancelled", "AbortError");
    },
  };

  await assert.rejects(
    searchConnectedGmail(
      { supabase, userId: "user-1", signal: controller.signal },
      dependencies,
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});
