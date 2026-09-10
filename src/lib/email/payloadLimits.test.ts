import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedEmailAssistPayload,
  boundedEmailDraftPayload,
  compactEmailThreadDetailForTransport,
  EMAIL_ASSIST_COMPLETE_BODY_MAX_CHARS,
  EMAIL_ASSIST_COMPLETE_CONTEXT_MAX_CHARS,
  EMAIL_ASSIST_EDIT_BODY_MAX_CHARS,
  EMAIL_DRAFT_BODY_MAX_CHARS,
  EMAIL_DRAFT_HTML_MAX_CHARS,
  EMAIL_THREAD_RESPONSE_MAX_BYTES,
} from "./payloadLimits";
import type {
  EmailMessage,
  EmailThreadDetail,
} from "./types";

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

test("draft requests are bounded before crossing the function boundary", () => {
  const draft = boundedEmailDraftPayload({
    body: "b".repeat(5_000_000),
    bodyHtml: "h".repeat(5_000_000),
    connectionId: "mailbox-1",
  });

  assert.equal(draft.body.length, EMAIL_DRAFT_BODY_MAX_CHARS);
  assert.equal(draft.bodyHtml?.length, EMAIL_DRAFT_HTML_MAX_CHARS);
  assert.equal(draft.connectionId, "mailbox-1");
});

test("completion requests keep the useful tail and edit requests keep the head", () => {
  const currentBody = `start-${"x".repeat(50_000)}-end`;
  const threadContext = `old-${"y".repeat(50_000)}-new`;
  const completion = boundedEmailAssistPayload({
    task: "complete",
    instruction: "continue",
    currentBody,
    subject: "Subject",
    threadContext,
    connectionId: "mailbox-1",
  });
  const rewrite = boundedEmailAssistPayload({
    task: "rewrite",
    instruction: "rewrite",
    currentBody,
    subject: "Subject",
    threadContext,
    connectionId: "mailbox-1",
  });

  assert.equal(
    completion.currentBody,
    currentBody.slice(-EMAIL_ASSIST_COMPLETE_BODY_MAX_CHARS),
  );
  assert.equal(
    completion.threadContext,
    threadContext.slice(-EMAIL_ASSIST_COMPLETE_CONTEXT_MAX_CHARS),
  );
  assert.equal(
    rewrite.currentBody,
    currentBody.slice(0, EMAIL_ASSIST_EDIT_BODY_MAX_CHARS),
  );
});

function message(id: string, value: string): EmailMessage {
  return {
    id,
    threadId: "thread-1",
    from: `${id}@example.com`,
    to: ["owner@example.com"],
    cc: [],
    bcc: [],
    subject: "Large thread",
    sentAt: "2026-09-09T12:00:00.000Z",
    body: value.repeat(700_000),
    htmlBody: `<p>${value.repeat(700_000)}</p>`,
    snippet: `${value} preview`,
    isFromUser: false,
    reply: {
      to: [`${id}@example.com`],
      cc: [],
      subject: "Re: Large thread",
      inReplyTo: null,
      references: null,
    },
    replyAll: {
      to: [`${id}@example.com`],
      cc: [],
      subject: "Re: Large thread",
      inReplyTo: null,
      references: null,
    },
    attachments: [],
  };
}

function detail(messages: EmailMessage[]): EmailThreadDetail {
  return {
    summary: {
      key: "mailbox-1:thread-1",
      connectionId: "mailbox-1",
      mailbox: {
        connectionId: "mailbox-1",
        provider: "gmail",
        address: "owner@example.com",
        displayName: "Owner",
        color: "#fff",
        monogram: "OW",
        isDefaultSender: true,
        includedInUnified: true,
        aiInstructions: "",
        status: "connected",
        counts: { inbox: 1, focus: 0, drafts: 0, noise: 0 },
      },
      messageId: messages.at(-1)?.id || "",
      threadId: "thread-1",
      senderName: "Sender",
      senderEmail: "sender@example.com",
      recipients: ["owner@example.com"],
      subject: "Large thread",
      snippet: "Preview",
      receivedAt: "2026-09-09T12:00:00.000Z",
      unread: false,
      starred: false,
      hasAttachments: false,
      direction: "incoming",
      openStatus: null,
      calendarInvite: null,
      action: null,
      draft: null,
    },
    messages,
    replyAll: {
      to: ["sender@example.com"],
      cc: [],
      subject: "Re: Large thread",
      inReplyTo: null,
      references: null,
    },
    draft: null,
  };
}

test("ordinary thread responses remain unchanged", () => {
  const input = detail([{ ...message("small", "s"), body: "Hello", htmlBody: null }]);
  assert.equal(compactEmailThreadDetailForTransport(input, "small"), input);
});

test("large thread responses stay below the transport budget", () => {
  const input = detail([
    message("old", "o"),
    message("requested", "r"),
    message("newest", "n"),
  ]);
  const compact = compactEmailThreadDetailForTransport(input, "requested");

  assert.ok(
    jsonBytes({ ok: true, thread: compact }) <=
      EMAIL_THREAD_RESPONSE_MAX_BYTES,
  );
  assert.ok(compact.messages.every((item) => item.contentTruncated));
  assert.match(compact.messages[1].body, /^r+$/);
  assert.ok(compact.messages[1].body.length > 0);
  assert.equal(compact.messages[1].htmlBody, null);
});
