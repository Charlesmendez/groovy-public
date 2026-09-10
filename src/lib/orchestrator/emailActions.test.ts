import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailMailboxConnection } from "@/lib/email/gmail";
import {
  createConnectedGmailDraft,
  sendConnectedGmailDraft,
} from "./emailActions";

function mailbox(overrides: Partial<EmailMailboxConnection> = {}): EmailMailboxConnection {
  return {
    connectionId: "conn-personal",
    provider: "gmail",
    address: "owner@example.com",
    displayName: "Personal",
    color: "#fff",
    monogram: "P",
    isDefaultSender: true,
    includedInUnified: true,
    aiInstructions: "",
    status: "connected",
    counts: { inbox: 0, focus: 0, drafts: 0, noise: 0 },
    datagranApiKey: "test-key",
    ...overrides,
  };
}

const supabase = {} as SupabaseClient;

test("new messages create a reversible draft from the default mailbox", async () => {
  let captured: Record<string, unknown> | null = null;
  const result = await createConnectedGmailDraft(
    {
      supabase,
      userId: "user-1",
      mode: "new",
      to: ["Alex <alex@example.com>"],
      subject: "Hello",
      body: "Checking in",
    },
    {
      loadMailboxes: async () => [mailbox()],
      createDraft: async (args) => {
        captured = args as unknown as Record<string, unknown>;
        return {
          actionId: null,
          draftId: "draft-1",
          connectionId: args.mailbox.connectionId,
          threadId: null,
          sourceMessageId: null,
          to: args.to,
          cc: args.cc || [],
          bcc: args.bcc || [],
          subject: args.subject,
          body: args.body,
          bodyHtml: null,
          attachments: [],
          aiGenerated: false,
          untouched: false,
          updatedAt: null,
        };
      },
      fetchThread: async () => {
        throw new Error("not used");
      },
      hydrateMailbox: async ({ mailbox: selected }) => selected,
    },
  );

  assert.equal(result.status, "draft_created");
  assert.deepEqual(
    (captured as unknown as { to: string[] }).to,
    ["alex@example.com"],
  );
  assert.equal(result.nextAction.includes("confirmation"), true);
});

test("reply drafts derive recipients and headers from the owned Gmail thread", async () => {
  let captured: Record<string, unknown> | null = null;
  const result = await createConnectedGmailDraft(
    {
      supabase,
      userId: "user-1",
      mode: "reply",
      mailbox: "conn-personal",
      threadId: "thread-1",
      body: "Tuesday works.",
    },
    {
      loadMailboxes: async () => [mailbox()],
      fetchThread: async () => ({
        messages: [
          {
            id: "message-1",
            threadId: "thread-1",
            from: "Alex <alex@example.com>",
            to: ["owner@example.com"],
            cc: [],
            bcc: [],
            subject: "Demo",
            sentAt: "2026-08-30T12:00:00.000Z",
            body: "When works?",
            htmlBody: null,
            snippet: "When works?",
            isFromUser: false,
            reply: {
              to: ["alex@example.com"],
              cc: [],
              subject: "Re: Demo",
              inReplyTo: "<message-1@example.com>",
              references: "<message-1@example.com>",
            },
            replyAll: {
              to: ["alex@example.com"],
              cc: [],
              subject: "Re: Demo",
              inReplyTo: "<message-1@example.com>",
              references: "<message-1@example.com>",
            },
            attachments: [],
          },
        ],
        items: [],
        latest: {
          id: "message-1",
          threadId: "thread-1",
          from: "Alex <alex@example.com>",
          to: "owner@example.com",
          cc: "",
          subject: "Demo",
          date: "2026-08-30T12:00:00.000Z",
          internalDate: "2026-08-30T12:00:00.000Z",
          messageIdHeader: "<message-1@example.com>",
          references: "",
          snippet: "When works?",
          labelIds: ["INBOX"],
          hasAttachments: false,
          hasCalendarInvitation: false,
        },
        replyAll: {
          to: ["alex@example.com"],
          cc: [],
          subject: "Re: Demo",
          inReplyTo: "<message-1@example.com>",
          references: "<message-1@example.com>",
        },
      }),
      createDraft: async (args) => {
        captured = args as unknown as Record<string, unknown>;
        return {
          actionId: null,
          draftId: "draft-reply",
          connectionId: args.mailbox.connectionId,
          threadId: args.threadId || null,
          sourceMessageId: args.sourceMessageId || null,
          to: args.to,
          cc: args.cc || [],
          bcc: args.bcc || [],
          subject: args.subject,
          body: args.body,
          bodyHtml: null,
          attachments: [],
          aiGenerated: false,
          untouched: false,
          updatedAt: null,
        };
      },
      hydrateMailbox: async ({ mailbox: selected }) => selected,
    },
  );

  assert.deepEqual(
    (captured as unknown as { to: string[] }).to,
    ["alex@example.com"],
  );
  assert.equal(
    (captured as unknown as { inReplyTo: string }).inReplyTo,
    "<message-1@example.com>",
  );
  assert.equal(result.draft.threadId, "thread-1");
});

test("confirmed sends reuse the robust idempotent Email route", async () => {
  let requestedUrl = "";
  let requestedBody = "";
  const result = await sendConnectedGmailDraft(
    {
      userId: "user-1",
      appBaseUrl: "https://groovy.example",
      connectionId: "conn-personal",
      draftId: "draft-1",
    },
    {
      buildInternalHeaders: ({ userId, scope }) => ({
        "x-test-user": userId || "",
        "x-test-scope": scope,
      }),
      fetch: async (input, init) => {
        requestedUrl = String(input);
        requestedBody = String(init?.body || "");
        return Response.json({
          ok: true,
          alreadySent: true,
          sentThread: { subject: "Hello", threadId: "thread-1" },
        });
      },
    },
  );

  assert.equal(requestedUrl, "https://groovy.example/api/email/draft/send");
  assert.deepEqual(JSON.parse(requestedBody), {
    connectionId: "conn-personal",
    draftId: "draft-1",
  });
  assert.equal(result.status, "already_sent");
  assert.equal(result.sentThread.subject, "Hello");
});

test("send helper does not call Email without signed internal authorization", async () => {
  let called = false;
  await assert.rejects(
    sendConnectedGmailDraft(
      {
        userId: "user-1",
        appBaseUrl: "https://groovy.example",
        connectionId: "conn-personal",
        draftId: "draft-1",
      },
      {
        buildInternalHeaders: () => ({}),
        fetch: async () => {
          called = true;
          return Response.json({ ok: true });
        },
      },
    ),
    /secure email send authorization/i,
  );
  assert.equal(called, false);
});
