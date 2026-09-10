import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRawMessage,
  buildReplyAllRecipients,
  buildReplyRecipients,
  collapseDuplicateGmailThreadItems,
  createGmailDraft,
  defaultMailboxColor,
  ensureGroovyGmailLabels,
  fetchGmailAttachment,
  fetchGmailCalendarInvitation,
  fetchGmailMessageListItem,
  fetchGmailMailboxHistoryId,
  fetchGmailThread,
  findGmailSentMessageIds,
  gmailApiCall,
  GmailApiError,
  gmailItemDirection,
  GmailCalendarInvitationPayloadError,
  GROOVY_EMAIL_LABELS,
  hydrateGmailMailboxProfile,
  isGmailDraftMessage,
  isGmailTrashMessage,
  isMissingGmailEntityError,
  latestGmailThreadItem,
  listGmailMessageRefs,
  listGmailHistoryMessageRefs,
  listGmailThreads,
  modifyGmailMessagesLabels,
  parseEmailAddresses,
  resolveGmailThreadSummaryAnchor,
  trashGmailSmtpSentCopies,
  updateGmailDraft,
} from "./gmail";
import type {
  EmailMailboxConnection,
  GmailThreadListItem,
} from "./gmail";

function gmailItem(
  id: string,
  internalDate: string,
  labelIds: string[] = ["INBOX"],
): GmailThreadListItem {
  return {
    id,
    threadId: "thread-1",
    from: "Alex <alex@example.com>",
    to: "owner@example.com",
    cc: "",
    subject: "Conversation",
    date: "",
    internalDate,
    messageIdHeader: `<${id}@example.com>`,
    references: "",
    snippet: `Message ${id}`,
    labelIds,
    hasAttachments: false,
    hasCalendarInvitation: false,
  };
}

const connectedMailbox: EmailMailboxConnection = {
  connectionId: "connection-1",
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
  datagranApiKey: "test-key",
};

test("Gmail discovery lists IDs without hydrating every message", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return new Response(
      JSON.stringify({
        messages: [
          { id: "new-1", threadId: "thread-1" },
          { id: "new-2", threadId: "thread-2" },
        ],
        resultSizeEstimate: 2,
      }),
      { status: 200 },
    );
  };
  try {
    const result = await listGmailMessageRefs({
      mailbox: connectedMailbox,
      query: "in:inbox discovery-only-test",
      maxResults: 12,
    });
    assert.deepEqual(result.items, [
      { id: "new-1", threadId: "thread-1" },
      { id: "new-2", threadId: "thread-2" },
    ]);
    assert.equal(requested.length, 1);
    assert.match(requested[0], /\/users\/me\/messages\?/);
    assert.doesNotMatch(requested[0], /\/messages\/new-/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail incremental discovery returns added and label-changed message IDs", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({
        historyId: "125",
        history: [
          {
            id: "123",
            messages: [
              { id: "changed-2", threadId: "thread-3" },
            ],
            messagesAdded: [
              { message: { id: "new-1", threadId: "thread-1" } },
            ],
            labelsRemoved: [
              { message: { id: "changed-1", threadId: "thread-2" }, labelIds: ["INBOX"] },
            ],
          },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    const result = await listGmailHistoryMessageRefs({
      mailbox: { ...connectedMailbox, connectionId: "history-connection" },
      startHistoryId: "120",
    });
    assert.deepEqual(result.added, [
      { id: "new-1", threadId: "thread-1" },
    ]);
    assert.deepEqual(result.changed, [
      { id: "new-1", threadId: "thread-1" },
      { id: "changed-1", threadId: "thread-2" },
      { id: "changed-2", threadId: "thread-3" },
    ]);
    assert.equal(result.historyId, "125");
    assert.match(requestedUrl, /\/users\/me\/history\?/);
    assert.match(requestedUrl, /startHistoryId=120/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reads the current Gmail history cursor from a fresh profile", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ emailAddress: "owner@example.com", historyId: "9001" }),
      { status: 200 },
    );
  try {
    const historyId = await fetchGmailMailboxHistoryId({
      userId: "history-profile-user",
      mailbox: { ...connectedMailbox, connectionId: "history-profile-connection" },
    });
    assert.equal(historyId, "9001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshes a cached mailbox profile before establishing a durable history cursor", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(
      JSON.stringify({
        emailAddress: "owner@example.com",
        historyId: attempts === 1 ? "9001" : "9002",
      }),
      { status: 200 },
    );
  };
  const mailbox = {
    ...connectedMailbox,
    connectionId: "fresh-history-profile-connection",
  };
  try {
    await hydrateGmailMailboxProfile({
      userId: "fresh-history-profile-user",
      mailbox,
    });
    const historyId = await fetchGmailMailboxHistoryId({
      userId: "fresh-history-profile-user",
      mailbox,
    });
    assert.equal(historyId, "9002");
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a missing Gmail history cursor instead of repeating full scans", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ emailAddress: "owner@example.com" }), {
      status: 200,
    });
  try {
    await assert.rejects(
      fetchGmailMailboxHistoryId({
        userId: "missing-history-profile-user",
        mailbox: {
          ...connectedMailbox,
          connectionId: "missing-history-profile-connection",
        },
      }),
      (error: unknown) =>
        error instanceof GmailApiError &&
        error.status === 502 &&
        error.retryable === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deferred actions update only their cutoff-safe Gmail messages in one batch", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody: unknown = null;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body || "{}"));
    return new Response("{}", { status: 200 });
  };
  try {
    await modifyGmailMessagesLabels({
      mailbox: {
        ...connectedMailbox,
        connectionId: "batch-modify-connection",
      },
      messageIds: ["old-1", "old-2", "old-1"],
      addLabelIds: ["processed-id"],
      removeLabelIds: ["INBOX"],
      priority: "interactive",
    });
    assert.match(requestedUrl, /\/messages\/batchModify\?/);
    assert.deepEqual(requestedBody, {
      ids: ["old-1", "old-2"],
      addLabelIds: ["processed-id"],
      removeLabelIds: ["INBOX"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent mailbox hydration shares one Gmail profile request", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(
      JSON.stringify({ emailAddress: "owner@example.com" }),
      { status: 200 },
    );
  };
  const mailbox = {
    ...connectedMailbox,
    connectionId: "profile-inflight-connection",
    address: "",
  };
  try {
    const [first, second] = await Promise.all([
      hydrateGmailMailboxProfile({
        userId: "profile-inflight-user",
        mailbox,
      }),
      hydrateGmailMailboxProfile({
        userId: "profile-inflight-user",
        mailbox,
      }),
    ]);
    assert.equal(attempts, 1);
    assert.equal(first.address, "owner@example.com");
    assert.equal(second.address, "owner@example.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("outgoing MIME nests inline images and regular attachments correctly", () => {
  const raw = buildRawMessage({
    to: ["recipient@example.com"],
    subject: "Inline image test",
    body: "Before\n\nAfter",
    bodyHtml:
      '<p>Before</p><img src="cid:groovy-image-1@inline" alt="Chart"><p>After</p>' +
      '<script>alert("unsafe")</script>',
    trackingPixelUrl: "https://example.com/api/email/open/token",
    attachments: [
      {
        id: "image-1",
        storagePath: "user/email-drafts/session/chart.png",
        filename: "chart.png",
        mimeType: "image/png",
        size: 3,
        disposition: "inline",
        contentId: "groovy-image-1@inline",
        data: new Uint8Array([1, 2, 3]),
      },
      {
        id: "document-1",
        storagePath: "user/email-drafts/session/report.pdf",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 4,
        disposition: "attachment",
        contentId: null,
        data: new Uint8Array([4, 5, 6, 7]),
      },
    ],
  });

  assert.match(raw, /Content-Type: multipart\/mixed/);
  assert.match(raw, /Content-Type: multipart\/related/);
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /Content-ID: <groovy-image-1@inline>/);
  assert.match(raw, /Content-Disposition: inline;/);
  assert.match(raw, /Content-Disposition: attachment;/);
  assert.match(raw, /src="cid:groovy-image-1@inline"/);
  assert.match(raw, /https:\/\/example\.com\/api\/email\/open\/token/);
  assert.match(raw, /\r\nAQID\r\n/);
  assert.match(raw, /\r\nBAUGBw==\r\n/);
  assert.doesNotMatch(raw, /script|alert\("unsafe"\)/i);
});

test("recipient variants keep visible recipients but hide the Bcc header", () => {
  const raw = buildRawMessage({
    from: '"Carlos" <carlos@example.com>',
    to: ["to@example.com"],
    cc: ["cc@example.com"],
    bcc: ["hidden@example.com"],
    includeBccHeader: false,
    subject: "Recipient-specific message",
    body: "Hello",
    date: "Thu, 30 Jul 2026 20:00:00 GMT",
    messageId: "<shared-message@example.com>",
  });

  assert.match(raw, /^From: "Carlos" <carlos@example\.com>/m);
  assert.match(raw, /^To: to@example\.com/m);
  assert.match(raw, /^Cc: cc@example\.com/m);
  assert.doesNotMatch(raw, /^Bcc:/m);
  assert.match(raw, /^Date: Thu, 30 Jul 2026 20:00:00 GMT/m);
  assert.match(raw, /^Message-ID: <shared-message@example\.com>/m);
});

test("Gmail drafts can be created and updated before a recipient is chosen", async () => {
  const originalFetch = globalThis.fetch;
  const rawMessages: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      message?: { raw?: string };
    };
    rawMessages.push(
      Buffer.from(request.message?.raw || "", "base64url").toString("utf8"),
    );
    return Response.json({ id: "recipientless-draft" });
  };
  try {
    const created = await createGmailDraft({
      mailbox: connectedMailbox,
      to: [],
      subject: "Not ready yet",
      body: "Still composing",
    });
    assert.ok(created.draftId);
    await updateGmailDraft({
      mailbox: connectedMailbox,
      draftId: created.draftId,
      to: [],
      subject: "Still not ready",
      body: "Keep composing",
    });

    assert.equal(created.to.length, 0);
    assert.equal(rawMessages.length, 2);
    assert.ok(rawMessages.every((raw) => /^To: *$/m.test(raw)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("draft attachments use Gmail media upload without double base64 encoding", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedContentType = "";
  let requestedBody = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedContentType = new Headers(init?.headers).get("content-type") || "";
    requestedBody = Buffer.from(
      (init?.body as ArrayBuffer | undefined) || new ArrayBuffer(0),
    ).toString("utf8");
    return Response.json({ id: "media-draft" });
  };
  try {
    const created = await createGmailDraft({
      mailbox: connectedMailbox,
      to: ["recipient@example.com"],
      subject: "Media draft",
      body: "See attachment",
      attachments: [
        {
          id: "image-1",
          storagePath: "user/email-drafts/session/image.png",
          filename: "image.png",
          mimeType: "image/png",
          size: 3,
          disposition: "inline",
          contentId: "groovy-image-1@inline",
          data: new Uint8Array([1, 2, 3]),
        },
      ],
    });

    const url = new URL(requestedUrl);
    assert.equal(url.pathname, "/api/proxy/gmail/upload/gmail/v1/users/me/drafts");
    assert.equal(url.searchParams.get("uploadType"), "multipart");
    assert.match(requestedContentType, /^multipart\/related; boundary=/);
    assert.match(requestedBody, /Content-Type: message\/rfc822/);
    assert.match(requestedBody, /Content-ID: <groovy-image-1@inline>/);
    assert.match(requestedBody, /\r\nAQID\r\n/);
    assert.doesNotMatch(requestedBody, /"raw"\s*:/);
    assert.equal(created.draftId, "media-draft");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("large draft media is uploaded through bounded resumable chunks", async () => {
  const originalFetch = globalThis.fetch;
  const chunkSizes: number[] = [];
  const contentRanges: string[] = [];
  let expectedSize = 0;
  let initiated = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (!url.searchParams.has("upload_id")) {
      initiated = true;
      expectedSize = Number(headers.get("x-upload-content-length"));
      const metadata = JSON.parse(String(init?.body)) as {
        id?: string;
        message?: { threadId?: string };
      };
      assert.equal(init?.method, "PUT");
      assert.equal(metadata.id, "existing-large-draft");
      assert.equal(metadata.message?.threadId, "thread-1");
      assert.equal(url.searchParams.get("uploadType"), "resumable");
      assert.equal(headers.get("x-upload-content-type"), "message/rfc822");
      return new Response(null, {
        status: 200,
        headers: {
          Location:
            "https://www.googleapis.com/upload/gmail/v1/users/me/drafts/existing-large-draft" +
            "?uploadType=resumable&upload_id=upload-session-1",
        },
      });
    }

    const body = (init?.body as ArrayBuffer | undefined) || new ArrayBuffer(0);
    const contentRange = headers.get("content-range") || "";
    const rangeMatch = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    assert.ok(rangeMatch);
    const end = Number(rangeMatch[2]);
    const total = Number(rangeMatch[3]);
    chunkSizes.push(body.byteLength);
    contentRanges.push(contentRange);
    assert.equal(total, expectedSize);
    assert.equal(url.searchParams.get("connection_id"), connectedMailbox.connectionId);
    if (end + 1 < total) {
      return new Response(null, {
        status: 308,
        headers: { Range: `bytes=0-${end}` },
      });
    }
    return Response.json({ id: "resumable-draft" });
  };
  try {
    const attachmentSize = 2_500_000;
    const updated = await updateGmailDraft({
      mailbox: connectedMailbox,
      draftId: "existing-large-draft",
      threadId: "thread-1",
      to: ["recipient@example.com"],
      subject: "Large media draft",
      body: "See attachment",
      attachments: [
        {
          id: "large-image",
          storagePath: "user/email-drafts/session/large.png",
          filename: "large.png",
          mimeType: "image/png",
          size: attachmentSize,
          disposition: "inline",
          contentId: "groovy-large-image@inline",
          data: new Uint8Array(attachmentSize),
        },
      ],
    });

    assert.equal(initiated, true);
    assert.equal(updated.draftId, "existing-large-draft");
    assert.ok(chunkSizes.length > 1);
    assert.ok(chunkSizes.every((size) => size <= 3 * 1024 * 1024));
    assert.match(contentRanges[0], /^bytes 0-3145727\//);
    assert.equal(chunkSizes.reduce((total, size) => total + size, 0), expectedSize);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail sent-copy verification searches by the exact RFC Message-ID", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method || "GET", "GET");
    assert.equal(
      url.searchParams.get("q"),
      "in:sent rfc822msgid:verify-message@example.com",
    );
    return Response.json({ messages: [{ id: "verified-copy" }] });
  };
  try {
    assert.deepEqual(
      await findGmailSentMessageIds({
        mailbox: connectedMailbox,
        messageIdHeader: "<verify-message@example.com>",
      }),
      ["verified-copy"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail SMTP variants are replaced with one clean sent copy safely", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method || "GET"} ${url.pathname}${url.search}`);
    if ((init?.method || "GET") === "GET") {
      assert.equal(
        url.searchParams.get("q"),
        "in:sent rfc822msgid:shared-message@example.com",
      );
      return Response.json({
        messages: [
          { id: "smtp-copy-1", threadId: "thread-1" },
          { id: "smtp-copy-2", threadId: "thread-1" },
        ],
      });
    }
    assert.match(url.pathname, /\/messages\/smtp-copy-[12]\/trash$/);
    return Response.json({ id: url.pathname.split("/").at(-2) });
  };
  try {
    assert.deepEqual(
      await trashGmailSmtpSentCopies({
        mailbox: connectedMailbox,
        messageIdHeader: "<shared-message@example.com>",
        expectedCopyCount: 2,
      }),
      {
        messageIds: ["smtp-copy-1", "smtp-copy-2"],
        alreadyTrashed: false,
      },
    );
    assert.equal(
      requests.filter((request) => request.startsWith("GET ")).length,
      1,
    );
    assert.equal(
      requests.filter((request) => request.startsWith("POST ")).length,
      2,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail SMTP cleanup never trashes the canonical sent copy", async () => {
  const originalFetch = globalThis.fetch;
  const trashed: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if ((init?.method || "GET") === "GET") {
      return Response.json({
        messages: [
          { id: "smtp-copy-1", threadId: "thread-1" },
          { id: "canonical-copy", threadId: "thread-1" },
          { id: "smtp-copy-2", threadId: "thread-1" },
        ],
      });
    }
    const messageId = url.pathname.split("/").at(-2) || "";
    trashed.push(messageId);
    return Response.json({ id: messageId });
  };
  try {
    assert.deepEqual(
      await trashGmailSmtpSentCopies({
        mailbox: connectedMailbox,
        messageIdHeader: "<canonical-safe@example.com>",
        expectedCopyCount: 2,
        excludeMessageIds: ["canonical-copy"],
      }),
      {
        messageIds: ["smtp-copy-1", "smtp-copy-2"],
        alreadyTrashed: false,
      },
    );
    assert.deepEqual(trashed, ["smtp-copy-1", "smtp-copy-2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail sent-copy cleanup waits for a late SMTP variant", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let sentSearchCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || "GET";
    const query = url.searchParams.get("q");
    requests.push(`${method} ${query || url.pathname}`);
    if (method === "GET" && query?.startsWith("in:sent ")) {
      sentSearchCount += 1;
      return Response.json({
        messages:
          sentSearchCount === 1
            ? [{ id: "smtp-copy-1", threadId: "thread-1" }]
            : [
                { id: "smtp-copy-1", threadId: "thread-1" },
                { id: "smtp-copy-2", threadId: "thread-1" },
              ],
      });
    }
    if (method === "GET" && query?.startsWith("in:trash ")) {
      return Response.json({ messages: [] });
    }
    assert.match(url.pathname, /\/messages\/smtp-copy-[12]\/trash$/);
    return Response.json({ id: url.pathname.split("/").at(-2) });
  };
  try {
    assert.deepEqual(
      await trashGmailSmtpSentCopies({
        mailbox: connectedMailbox,
        messageIdHeader: "<late-copy@example.com>",
        expectedCopyCount: 2,
        pollDelaysMs: [0, 0],
      }),
      {
        messageIds: ["smtp-copy-1", "smtp-copy-2"],
        alreadyTrashed: false,
      },
    );
    assert.equal(sentSearchCount, 2);
    assert.equal(
      requests.filter((request) =>
        request.startsWith("GET in:trash"),
      ).length,
      1,
    );
    assert.equal(
      requests.filter((request) => request.startsWith("POST ")).length,
      2,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail sent-copy cleanup resumes after a partial prior cleanup", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || "GET";
    const query = url.searchParams.get("q");
    if (method === "GET" && query?.startsWith("in:sent ")) {
      return Response.json({
        messages: [{ id: "smtp-copy-2", threadId: "thread-1" }],
      });
    }
    if (method === "GET" && query?.startsWith("in:trash ")) {
      return Response.json({
        messages: [{ id: "smtp-copy-1", threadId: "thread-1" }],
      });
    }
    assert.match(url.pathname, /\/messages\/smtp-copy-2\/trash$/);
    return Response.json({ id: "smtp-copy-2" });
  };
  try {
    assert.deepEqual(
      await trashGmailSmtpSentCopies({
        mailbox: connectedMailbox,
        messageIdHeader: "<partial-cleanup@example.com>",
        expectedCopyCount: 2,
        pollDelaysMs: [0],
      }),
      {
        messageIds: ["smtp-copy-2", "smtp-copy-1"],
        alreadyTrashed: false,
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail sent-copy cleanup retries instead of saving a premature copy", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("q");
    return Response.json({
      messages: query?.startsWith("in:sent ")
        ? [{ id: "smtp-copy-1", threadId: "thread-1" }]
        : [],
    });
  };
  try {
    await assert.rejects(
      trashGmailSmtpSentCopies({
        mailbox: connectedMailbox,
        messageIdHeader: "<missing-copy@example.com>",
        expectedCopyCount: 2,
        pollDelaysMs: [0, 0],
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "GmailApiError" &&
        "retryable" in error &&
        error.retryable === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mailbox colors are stable for a connection", () => {
  assert.equal(
    defaultMailboxColor("connection-alpha"),
    defaultMailboxColor("connection-alpha"),
  );
  assert.match(defaultMailboxColor("connection-alpha"), /^#[0-9a-f]{6}$/i);
});

test("address parsing is normalized and deduplicated", () => {
  assert.deepEqual(
    parseEmailAddresses(
      'Carlos <Carlos@example.com>, duplicate <carlos@example.com>, b@example.org',
    ),
    ["carlos@example.com", "b@example.org"],
  );
});

test("Gmail conversations collapse mailbox copies with one RFC Message-ID", () => {
  const first = {
    ...gmailItem("smtp-copy-1", "2026-08-03T14:17:00.000Z", ["SENT"]),
    messageIdHeader: "<group-send@example.com>",
  };
  const duplicate = {
    ...gmailItem("smtp-copy-2", "2026-08-03T14:17:00.100Z", ["SENT"]),
    messageIdHeader: "<GROUP-SEND@example.com>",
  };
  const next = gmailItem("next-message", "2026-08-03T15:00:00.000Z");

  assert.deepEqual(
    collapseDuplicateGmailThreadItems([first, duplicate, next]).map(
      (item) => item.id,
    ),
    ["smtp-copy-1", "next-message"],
  );
  assert.equal(isGmailTrashMessage(["SENT", "trash"]), true);
  assert.equal(isGmailTrashMessage(["SENT"]), false);
});

test("reply all excludes every connected identity owned by the user", () => {
  assert.deepEqual(
    buildReplyAllRecipients({
      from: "Alex <alex@example.com>",
      to: "primary@me.com, second@me.com, teammate@example.com",
      cc: "copy@example.com",
      userAddress: "primary@me.com",
      ownedAddresses: ["primary@me.com", "second@me.com"],
    }),
    {
      to: ["alex@example.com"],
      cc: ["teammate@example.com", "copy@example.com"],
    },
  );
});

test("automatic reply identities are independent from the account login email", () => {
  assert.deepEqual(
    buildReplyAllRecipients({
      from: "Mark Rattin <mark@example.com>",
      to: "Carlos <carlos@hibe.ai>, teammate@example.com",
      cc: "alias@hibe.ai",
      userAddress: "charlesmendez@hotmail.com",
      ownedAddresses: [
        "charlesmendez@hotmail.com",
        "carlos@hibe.ai",
        "alias@hibe.ai",
      ],
    }),
    {
      to: ["mark@example.com"],
      cc: ["teammate@example.com"],
    },
  );
});

test("replying to a sent message targets its original recipients", () => {
  const message = {
    from: "Owner <primary@me.com>",
    to: "alex@example.com, second@me.com",
    cc: "copy@example.com",
    userAddress: "primary@me.com",
    ownedAddresses: ["primary@me.com", "second@me.com"],
  };
  assert.deepEqual(buildReplyRecipients(message), {
    to: ["alex@example.com"],
    cc: [],
  });
  assert.deepEqual(buildReplyRecipients(message, true), {
    to: ["alex@example.com"],
    cc: ["copy@example.com"],
  });
});

test("conversation summaries use the actual latest non-draft message", () => {
  const latest = latestGmailThreadItem([
    gmailItem("old", "2026-07-20T12:00:00.000Z"),
    gmailItem("draft", "2026-07-28T13:00:00.000Z", ["DRAFT"]),
    gmailItem("new", "2026-07-28T12:00:00.000Z", ["INBOX", "UNREAD"]),
  ]);
  assert.equal(latest?.id, "new");
});

test("conversation detail falls back when an All Mail anchor is no longer present", () => {
  const surviving = gmailItem("surviving-copy", "2026-07-28T12:00:00.000Z");
  assert.equal(
    resolveGmailThreadSummaryAnchor({
      items: [surviving],
      latest: surviving,
      requestedMessageId: "collapsed-smtp-copy",
    })?.id,
    "surviving-copy",
  );
});

test("conversation detail preserves an exact anchor and rejects an empty thread", () => {
  const first = gmailItem("first", "2026-07-28T11:00:00.000Z");
  const latest = gmailItem("latest", "2026-07-28T12:00:00.000Z");
  assert.equal(
    resolveGmailThreadSummaryAnchor({
      items: [first, latest],
      latest,
      requestedMessageId: "first",
    })?.id,
    "first",
  );
  assert.equal(
    resolveGmailThreadSummaryAnchor({
      items: [],
      latest: { ...latest, id: "" },
      requestedMessageId: "gone",
    }),
    null,
  );
});

test("message direction recognizes every mailbox identity owned by the user", () => {
  assert.equal(
    gmailItemDirection(
      {
        ...gmailItem("sent", "2026-07-28T12:00:00.000Z"),
        from: "Second mailbox <second@me.com>",
      },
      ["primary@me.com", "second@me.com"],
    ),
    "outgoing",
  );
});

test("mailbox listing can replace a matching message with the true latest thread message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/gmail/v1/users/me/messages")) {
      return new Response(
        JSON.stringify({
          messages: [
            { id: "matched-new", threadId: "thread-1" },
            { id: "matched-old", threadId: "thread-1" },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.pathname.includes("/gmail/v1/users/me/threads/thread-1")) {
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: "sent-first",
              threadId: "thread-1",
              internalDate: String(Date.parse("2026-07-19T12:00:00.000Z")),
              labelIds: ["SENT"],
              snippet: "The message that started the conversation",
              payload: {
                headers: [
                  { name: "From", value: "Owner <owner@example.com>" },
                  { name: "To", value: "Alex <alex@example.com>" },
                  { name: "Subject", value: "Old subject" },
                ],
              },
            },
            {
              id: "matched-old",
              threadId: "thread-1",
              internalDate: String(Date.parse("2026-07-20T12:00:00.000Z")),
              labelIds: ["INBOX"],
              snippet: "Old matching text",
              payload: {
                headers: [
                  { name: "From", value: "Alex <alex@example.com>" },
                  { name: "To", value: "owner@example.com" },
                  { name: "Subject", value: "Old subject" },
                ],
              },
            },
            {
              id: "matched-new",
              threadId: "thread-1",
              internalDate: String(Date.parse("2026-07-25T12:00:00.000Z")),
              labelIds: ["INBOX"],
              snippet: "Newer matching text",
              payload: {
                headers: [
                  { name: "From", value: "Alex <alex@example.com>" },
                  { name: "To", value: "owner@example.com" },
                  { name: "Subject", value: "Newer matching subject" },
                ],
              },
            },
            {
              id: "actual-latest",
              threadId: "thread-1",
              internalDate: String(Date.parse("2026-07-28T12:00:00.000Z")),
              labelIds: ["INBOX", "UNREAD"],
              snippet: "The actual latest reply",
              payload: {
                mimeType: "multipart/mixed",
                headers: [
                  { name: "From", value: "Taylor <taylor@example.com>" },
                  { name: "To", value: "owner@example.com" },
                  { name: "Subject", value: "Current subject" },
                ],
                parts: [
                  {
                    mimeType: "multipart/alternative",
                    parts: [
                      { mimeType: "text/plain", body: {} },
                      { mimeType: "text/calendar", body: {} },
                    ],
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("Not found", { status: 404 });
  };
  try {
    const result = await listGmailThreads({
      mailbox: connectedMailbox,
      query: 'in:anywhere "contract"',
      latestInThread: true,
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, "actual-latest");
    assert.equal(result.items[0].snippet, "The actual latest reply");
    assert.equal(result.items[0].matchedItem?.id, "matched-new");
    assert.equal(result.items[0].threadHasSentMessage, true);
    assert.equal(result.items[0].labelIds.includes("UNREAD"), true);
    assert.equal(result.items[0].hasCalendarInvitation, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail draft messages are excluded from sent conversation history", () => {
  assert.equal(isGmailDraftMessage(["DRAFT"]), true);
  assert.equal(isGmailDraftMessage(["INBOX", "UNREAD"]), false);
  assert.equal(isGmailDraftMessage(["SENT"]), false);
});

test("Gmail calendar replies are not classified as actionable invitations", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "calendar-reply",
        threadId: "calendar-reply-thread",
        internalDate: String(Date.parse("2026-08-27T21:36:00.000Z")),
        labelIds: ["INBOX", "UNREAD"],
        snippet: "Kaylie McGonagle has accepted this invitation.",
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: "Kaylie <kaylie@example.com>" },
            { name: "To", value: "owner@example.com" },
            {
              name: "Subject",
              value: "Accepted: Hibe<>BestRoof @ Friday",
            },
          ],
          parts: [
            {
              mimeType: "text/calendar",
              headers: [
                {
                  name: "Content-Type",
                  value: 'text/calendar; charset="UTF-8"; method=REPLY',
                },
              ],
              body: { attachmentId: "calendar-reply-attachment" },
            },
            {
              filename: "invite.ics",
              mimeType: "application/ics",
              body: { attachmentId: "calendar-reply-copy" },
            },
          ],
        },
      }),
      { status: 200 },
    );
  try {
    const result = await fetchGmailMessageListItem({
      mailbox: {
        ...connectedMailbox,
        connectionId: "calendar-reply-list-connection",
      },
      messageId: "calendar-reply",
    });
    assert.equal(result?.hasCalendarInvitation, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a subject-only calendar update fails permanently before RSVP retries", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "forwarded-calendar-update",
        threadId: "forwarded-calendar-update",
        payload: {
          mimeType: "multipart/alternative",
          headers: [
            {
              name: "Subject",
              value: "Updated invitation: KiwiTech Payment || ACID LABS",
            },
          ],
          parts: [
            {
              mimeType: "text/plain",
              body: {
                data: Buffer.from(
                  "Reply for satyam@kiwitech.com",
                  "utf8",
                ).toString("base64url"),
              },
            },
            {
              mimeType: "text/html",
              body: {
                data: Buffer.from(
                  "<p>Reply for satyam@kiwitech.com</p>",
                  "utf8",
                ).toString("base64url"),
              },
            },
          ],
        },
      }),
      { status: 200 },
    );
  try {
    await assert.rejects(
      fetchGmailCalendarInvitation({
        mailbox: {
          ...connectedMailbox,
          connectionId: "forwarded-calendar-update-connection",
        },
        messageId: "forwarded-calendar-update",
      }),
      (error) =>
        error instanceof GmailCalendarInvitationPayloadError &&
        error.code === "missing_calendar_part" &&
        /forwarded calendar update/i.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a calendar reply fails permanently with a non-actionable explanation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "calendar-reply",
        threadId: "calendar-reply-thread",
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "text/calendar",
              headers: [
                {
                  name: "Content-Type",
                  value: 'text/calendar; charset="UTF-8"; method=REPLY',
                },
              ],
              body: {
                data: Buffer.from(
                  [
                    "BEGIN:VCALENDAR",
                    "METHOD:REPLY",
                    "BEGIN:VEVENT",
                    "UID:event-123@google.com",
                    "SUMMARY:Hibe<>BestRoof",
                    "END:VEVENT",
                    "END:VCALENDAR",
                  ].join("\r\n"),
                  "utf8",
                ).toString("base64url"),
              },
            },
          ],
        },
      }),
      { status: 200 },
    );
  try {
    await assert.rejects(
      fetchGmailCalendarInvitation({
        mailbox: {
          ...connectedMailbox,
          connectionId: "calendar-reply-rsvp-connection",
        },
        messageId: "calendar-reply",
      }),
      (error) =>
        error instanceof GmailCalendarInvitationPayloadError &&
        error.code === "non_actionable_calendar_method" &&
        /not an invitation you can answer/i.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stale Gmail draft IDs are recognized for transparent recreation", () => {
  assert.equal(
    isMissingGmailEntityError(new Error("Requested entity was not found.")),
    true,
  );
  assert.equal(
    isMissingGmailEntityError(new Error("Rate limit exceeded")),
    false,
  );
});

test("Gmail transport retries bounded rate-limit responses", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts < 2
      ? new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
        })
      : new Response(JSON.stringify({ id: "recovered" }), { status: 200 });
  };
  try {
    const result = await gmailApiCall({
      datagranApiKey: "retry-test-key",
      connectionId: "retry-test-connection",
      method: "GET",
      endpoint:
        "/api/proxy/gmail/gmail/v1/users/me/messages/retry-test?format=full",
    });
    assert.equal(result.ok, true);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interactive Gmail reads wait for an existing rate-limit window", async () => {
  const originalFetch = globalThis.fetch;
  const seedController = new AbortController();
  let throttling = true;
  let successfulFetches = 0;
  globalThis.fetch = async () => {
    if (throttling) {
      seedController.abort();
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
      });
    }
    successfulFetches += 1;
    return new Response(JSON.stringify({ id: "attachment-ready" }), {
      status: 200,
    });
  };
  try {
    const throttled = await gmailApiCall({
      datagranApiKey: "interactive-rate-limit-key",
      connectionId: "interactive-rate-limit-connection",
      method: "GET",
      endpoint:
        "/api/proxy/gmail/gmail/v1/users/me/messages/seed?format=full",
      signal: seedController.signal,
    });
    assert.equal(throttled.status, 429);

    throttling = false;
    const recovered = await gmailApiCall({
      datagranApiKey: "interactive-rate-limit-key",
      connectionId: "interactive-rate-limit-connection",
      method: "GET",
      endpoint:
        "/api/proxy/gmail/gmail/v1/users/me/messages/attachment/attachments/file",
      priority: "interactive",
    });
    assert.equal(recovered.ok, true);
    assert.equal(successfulFetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an ambiguous draft send is never retried at the transport layer", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new TypeError("Connection closed after upload");
  };
  try {
    const result = await gmailApiCall({
      datagranApiKey: "ambiguous-send-key",
      connectionId: "ambiguous-send-connection",
      method: "POST",
      endpoint: "/api/proxy/gmail/gmail/v1/users/me/drafts/send",
      body: { id: "draft-1" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a throttled draft send returns control to the idempotent route", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: { "Retry-After": "1" },
    });
  };
  try {
    const result = await gmailApiCall({
      datagranApiKey: "throttled-send-key",
      connectionId: "throttled-send-connection",
      method: "POST",
      endpoint: "/api/proxy/gmail/gmail/v1/users/me/drafts/send",
      body: { id: "draft-2" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a superseded Gmail list stops before spending another request", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  try {
    await assert.rejects(
      listGmailThreads({
        mailbox: connectedMailbox,
        query: "in:sent cancellation-test",
        signal: controller.signal,
      }),
      /cancelled/i,
    );
    assert.equal(attempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail transport caps request fanout across mailboxes", async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
  };
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        gmailApiCall({
          datagranApiKey: "fanout-test-key",
          connectionId: `fanout-connection-${index}`,
          method: "GET",
          endpoint: `/api/proxy/gmail/gmail/v1/users/me/messages/fanout-${index}?format=full`,
        }),
      ),
    );
    assert.ok(maxActive <= 6, `expected at most 6 requests, saw ${maxActive}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interactive Gmail reads move ahead of queued background reads", async () => {
  const originalFetch = globalThis.fetch;
  const started: string[] = [];
  let releaseInitial: () => void = () => {};
  const initialGate = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  let resolveInitialStarted: () => void = () => {};
  const initialStarted = new Promise<void>((resolve) => {
    resolveInitialStarted = resolve;
  });
  let activeStarted = 0;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    started.push(path);
    if (path.includes("priority-active-")) {
      activeStarted += 1;
      if (activeStarted === 6) resolveInitialStarted();
      await initialGate;
    }
    return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
  };
  try {
    const active = Array.from({ length: 6 }, (_, index) =>
      gmailApiCall({
        datagranApiKey: "priority-key",
        connectionId: `priority-active-${index}`,
        method: "GET",
        endpoint: `/api/proxy/gmail/gmail/v1/users/me/messages/priority-active-${index}?format=full`,
      }),
    );
    await initialStarted;
    const background = gmailApiCall({
      datagranApiKey: "priority-key",
      connectionId: "priority-background",
      method: "GET",
      endpoint:
        "/api/proxy/gmail/gmail/v1/users/me/messages/priority-background?format=full",
    });
    const interactive = gmailApiCall({
      datagranApiKey: "priority-key",
      connectionId: "priority-interactive",
      method: "GET",
      endpoint:
        "/api/proxy/gmail/gmail/v1/users/me/messages/priority-interactive/attachments/file",
      priority: "interactive",
    });
    releaseInitial();
    await Promise.all([...active, background, interactive]);

    const interactiveIndex = started.findIndex((path) =>
      path.includes("priority-interactive"),
    );
    const backgroundIndex = started.findIndex((path) =>
      path.includes("priority-background"),
    );
    assert.ok(interactiveIndex >= 0);
    assert.ok(backgroundIndex >= 0);
    assert.ok(interactiveIndex < backgroundIndex);
  } finally {
    releaseInitial();
    globalThis.fetch = originalFetch;
  }
});

test("Gmail transport serializes mutations within one mailbox", async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
  };
  try {
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        gmailApiCall({
          datagranApiKey: "mutation-lock-test-key",
          connectionId: "mutation-lock-test-connection",
          method: "POST",
          endpoint: `/api/proxy/gmail/gmail/v1/users/me/threads/thread-${index}/modify`,
          body: { addLabelIds: ["Label_processed"] },
        }),
      ),
    );
    assert.equal(maxActive, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("interactive Gmail mutations move ahead of queued background mutations", async () => {
  const originalFetch = globalThis.fetch;
  const started: string[] = [];
  let releaseActive: () => void = () => {};
  const activeGate = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  let resolveActiveStarted: () => void = () => {};
  const activeStarted = new Promise<void>((resolve) => {
    resolveActiveStarted = resolve;
  });
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    started.push(path);
    if (path.includes("priority-mutation-active")) {
      resolveActiveStarted();
      await activeGate;
    }
    return Response.json({ id: "ok" });
  };
  const call = (suffix: string, priority?: "interactive") =>
    gmailApiCall({
      datagranApiKey: "priority-mutation-key",
      connectionId: "priority-mutation-connection",
      method: "POST",
      endpoint: `/api/proxy/gmail/gmail/v1/users/me/threads/${suffix}/modify`,
      body: { addLabelIds: ["Label_processed"] },
      priority,
    });
  try {
    const active = call("priority-mutation-active");
    await activeStarted;
    const background = call("priority-mutation-background");
    const interactive = call(
      "priority-mutation-interactive",
      "interactive",
    );
    releaseActive();
    await Promise.all([active, background, interactive]);
    const interactiveIndex = started.findIndex((path) =>
      path.includes("priority-mutation-interactive"),
    );
    const backgroundIndex = started.findIndex((path) =>
      path.includes("priority-mutation-background"),
    );
    assert.ok(interactiveIndex >= 0);
    assert.ok(backgroundIndex >= 0);
    assert.ok(interactiveIndex < backgroundIndex);
  } finally {
    releaseActive();
    globalThis.fetch = originalFetch;
  }
});

test("concurrent email actions share one Gmail label preparation", async () => {
  const originalFetch = globalThis.fetch;
  const mailbox = {
    ...connectedMailbox,
    connectionId: "label-single-flight-connection",
  };
  let listCalls = 0;
  let createCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/gmail/v1/users/me/labels")) {
      return new Response("Not found", { status: 404 });
    }
    if (init?.method === "GET") {
      listCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(
        JSON.stringify({
          labels: [
            {
              id: "Label_processed",
              name: GROOVY_EMAIL_LABELS.processed,
            },
            {
              id: "Label_spam",
              name: GROOVY_EMAIL_LABELS.spam,
            },
          ],
        }),
        { status: 200 },
      );
    }
    createCalls += 1;
    return new Response("Unexpected create", { status: 500 });
  };
  try {
    const requiredLabels = [
      GROOVY_EMAIL_LABELS.processed,
      GROOVY_EMAIL_LABELS.spam,
    ] as const;
    const [first, second] = await Promise.all([
      ensureGroovyGmailLabels({ mailbox, requiredLabels }),
      ensureGroovyGmailLabels({ mailbox, requiredLabels }),
    ]);
    assert.equal(first[GROOVY_EMAIL_LABELS.processed], "Label_processed");
    assert.equal(second[GROOVY_EMAIL_LABELS.spam], "Label_spam");
    assert.equal(listCalls, 1);
    assert.equal(createCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("label preparation recovers when another server creates the label first", async () => {
  const originalFetch = globalThis.fetch;
  const mailbox = {
    ...connectedMailbox,
    connectionId: "label-conflict-connection",
  };
  let listCalls = 0;
  let createCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/gmail/v1/users/me/labels")) {
      return new Response("Not found", { status: 404 });
    }
    if (init?.method === "GET") {
      listCalls += 1;
      return new Response(
        JSON.stringify({
          labels:
            listCalls === 1
              ? []
              : [
                  {
                    id: "Label_processed_elsewhere",
                    name: GROOVY_EMAIL_LABELS.processed,
                  },
                ],
        }),
        { status: 200 },
      );
    }
    createCalls += 1;
    return new Response(
      JSON.stringify({ error: "Label name already exists" }),
      { status: 409 },
    );
  };
  try {
    const labels = await ensureGroovyGmailLabels({
      mailbox,
      requiredLabels: [GROOVY_EMAIL_LABELS.processed],
    });
    assert.equal(
      labels[GROOVY_EMAIL_LABELS.processed],
      "Label_processed_elsewhere",
    );
    assert.equal(listCalls, 2);
    assert.equal(createCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("full Gmail threads retain sanitized HTML alongside the text fallback", async () => {
  const originalFetch = globalThis.fetch;
  const encoded = (value: string) => Buffer.from(value).toString("base64url");
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        messages: [
          {
            id: "message-with-html",
            threadId: "thread-with-html",
            internalDate: String(Date.parse("2026-07-28T15:34:00.000Z")),
            labelIds: ["INBOX"],
            snippet: "Meeting records",
            payload: {
              headers: [
                { name: "From", value: "Google Meet <meetings@example.com>" },
                { name: "To", value: "owner@example.com" },
                { name: "Subject", value: "Meeting records" },
              ],
              parts: [
                {
                  mimeType: "text/plain",
                  body: { data: encoded("Meeting records\nRecording") },
                },
                {
                  mimeType: "text/html",
                  body: {
                    data: encoded(
                      '<style>@media (max-width:480px){.recording{width:100%}}</style><a class="recording" href="https://drive.google.com/recording" style="display:inline-block">Recording</a><script>alert(1)</script>',
                    ),
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  try {
    const thread = await fetchGmailThread({
      mailbox: connectedMailbox,
      threadId: "thread-with-html",
    });
    assert.equal(thread.messages[0].body, "Meeting records\nRecording");
    assert.match(
      thread.messages[0].htmlBody || "",
      /href="https:\/\/drive\.google\.com\/recording"/,
    );
    assert.match(
      thread.messages[0].htmlBody || "",
      /@media \(max-width:480px\)/,
    );
    assert.match(thread.messages[0].htmlBody || "", /class="recording"/);
    assert.doesNotMatch(thread.messages[0].htmlBody || "", /script|alert/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("full Gmail threads hide trashed recipient delivery copies", async () => {
  const originalFetch = globalThis.fetch;
  const encoded = (value: string) => Buffer.from(value).toString("base64url");
  const message = (
    id: string,
    messageIdHeader: string,
    labelIds: string[],
    internalDate: string,
  ) => ({
    id,
    threadId: "thread-with-group-send",
    internalDate: String(Date.parse(internalDate)),
    labelIds,
    snippet: id,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Owner <owner@example.com>" },
        { name: "To", value: "first@example.com" },
        {
          name: "Cc",
          value: "second@example.com, third@example.com",
        },
        { name: "Subject", value: "Group update" },
        { name: "Message-ID", value: messageIdHeader },
      ],
      body: { data: encoded("One logical group message") },
    },
  });
  globalThis.fetch = async () =>
    Response.json({
      messages: [
        {
          ...message(
            "incoming-message",
            "<incoming@example.com>",
            ["INBOX"],
            "2026-08-03T08:18:00.000Z",
          ),
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "First <first@example.com>" },
              { name: "To", value: "owner@example.com" },
              { name: "Subject", value: "Group update" },
              { name: "Message-ID", value: "<incoming@example.com>" },
            ],
            body: { data: encoded("Original message") },
          },
        },
        message(
          "smtp-copy-1",
          "<group-send@example.com>",
          ["SENT", "TRASH"],
          "2026-08-03T14:17:00.000Z",
        ),
        message(
          "smtp-copy-2",
          "<group-send@example.com>",
          ["SENT", "TRASH"],
          "2026-08-03T14:17:00.100Z",
        ),
        message(
          "smtp-copy-3",
          "<group-send@example.com>",
          ["SENT", "TRASH"],
          "2026-08-03T14:17:00.200Z",
        ),
        message(
          "canonical-sent-copy",
          "<group-send@example.com>",
          ["SENT"],
          "2026-08-03T14:17:00.300Z",
        ),
      ],
    });
  try {
    const thread = await fetchGmailThread({
      mailbox: connectedMailbox,
      threadId: "thread-with-group-send",
    });
    assert.deepEqual(
      thread.messages.map((item) => item.id),
      ["incoming-message", "canonical-sent-copy"],
    );
    assert.deepEqual(
      thread.items.map((item) => item.id),
      ["incoming-message", "canonical-sent-copy"],
    );
    assert.equal(thread.latest.id, "canonical-sent-copy");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("full Gmail threads resolve CID images to their exact inline attachments", async () => {
  const originalFetch = globalThis.fetch;
  const encoded = (value: string) => Buffer.from(value).toString("base64url");
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        messages: [
          {
            id: "message-with-inline-image",
            threadId: "thread-with-inline-image",
            internalDate: String(Date.parse("2026-07-29T15:34:00.000Z")),
            labelIds: ["INBOX"],
            snippet: "A job card",
            payload: {
              headers: [
                { name: "From", value: "Auditor <audit@example.com>" },
                { name: "To", value: "owner@example.com" },
                { name: "Subject", value: "Payroll audit" },
              ],
              parts: [
                {
                  mimeType: "text/html",
                  body: {
                    data: encoded(
                      '<p>Audit result</p><img src="cid:II_JOB_CARD" alt="image.png" width="562" height="85">',
                    ),
                  },
                },
                {
                  partId: "1.2",
                  filename: "image.png",
                  mimeType: "image/png",
                  headers: [
                    { name: "Content-ID", value: "<ii_job_card>" },
                    { name: "Content-Disposition", value: "inline" },
                  ],
                  body: { attachmentId: "inline-image-1", size: 1234 },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  try {
    const thread = await fetchGmailThread({
      mailbox: connectedMailbox,
      threadId: "thread-with-inline-image",
    });
    const message = thread.messages[0];
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].contentId, "ii_job_card");
    assert.equal(message.attachments[0].inline, true);
    assert.match(
      message.htmlBody || "",
      /src="\/api\/email\/attachment\?connectionId=connection-1&amp;messageId=message-with-inline-image&amp;attachmentId=inline-image-1&amp;threadId=thread-with-inline-image&amp;partId=1.2&amp;filename=image.png&amp;mimeType=image%2Fpng"/,
    );
    assert.doesNotMatch(message.htmlBody || "", /cid:/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PDFs with inline MIME metadata remain visible as attachments", async () => {
  const originalFetch = globalThis.fetch;
  const encoded = (value: string) => Buffer.from(value).toString("base64url");
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        messages: [
          {
            id: "message-with-pdf",
            threadId: "thread-with-pdf",
            internalDate: String(Date.parse("2026-08-09T12:00:00.000Z")),
            labelIds: ["INBOX"],
            snippet: "Agreement attached",
            payload: {
              headers: [
                { name: "From", value: "Jack <jack@example.com>" },
                { name: "To", value: "owner@example.com" },
                { name: "Subject", value: "Agreement attached" },
              ],
              parts: [
                {
                  mimeType: "text/html",
                  body: { data: encoded("<p>Agreement attached.</p>") },
                },
                {
                  partId: "1.2",
                  filename: "agreement.pdf",
                  mimeType: "application/octet-stream",
                  headers: [
                    { name: "Content-ID", value: "<agreement-document>" },
                    { name: "Content-Disposition", value: "inline" },
                  ],
                  body: { attachmentId: "pdf-attachment-1", size: 4096 },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  try {
    const thread = await fetchGmailThread({
      mailbox: connectedMailbox,
      threadId: "thread-with-pdf",
    });
    const message = thread.messages[0];
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].filename, "agreement.pdf");
    assert.equal(message.attachments[0].inline, false);
    assert.equal(thread.items[0].hasAttachments, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a CID link does not hide an image that is not embedded in the body", async () => {
  const originalFetch = globalThis.fetch;
  const encoded = (value: string) => Buffer.from(value).toString("base64url");
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        messages: [
          {
            id: "message-with-cid-link",
            threadId: "thread-with-cid-link",
            internalDate: String(Date.parse("2026-08-09T12:30:00.000Z")),
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "Jack <jack@example.com>" },
                { name: "To", value: "owner@example.com" },
                { name: "Subject", value: "Image attachment" },
              ],
              parts: [
                {
                  mimeType: "text/html",
                  body: {
                    data: encoded(
                      '<p><a href="cid:linked-image">Attachment reference</a></p>',
                    ),
                  },
                },
                {
                  partId: "1.2",
                  filename: "diagram.png",
                  mimeType: "image/png",
                  headers: [
                    { name: "Content-ID", value: "<linked-image>" },
                  ],
                  body: { attachmentId: "linked-image-1", size: 1024 },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  try {
    const thread = await fetchGmailThread({
      mailbox: connectedMailbox,
      threadId: "thread-with-cid-link",
    });
    assert.equal(thread.messages[0].attachments[0].inline, false);
    assert.equal(thread.items[0].hasAttachments, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("attachment downloads recover from stale message identity within a thread", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPaths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    if (url.pathname.endsWith("/messages/stale-message")) {
      return new Response(JSON.stringify({ error: "Message not found" }), {
        status: 404,
      });
    }
    if (url.pathname.endsWith("/threads/thread-with-image")) {
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: "actual-message",
              payload: {
                parts: [
                  {
                    partId: "2.1",
                    filename: "chart.png",
                    mimeType: "image/png",
                    body: { attachmentId: "actual-attachment", size: 3 },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (
      url.pathname.endsWith(
        "/messages/actual-message/attachments/actual-attachment",
      )
    ) {
      return new Response(JSON.stringify({ data: "AQID" }), {
        status: 200,
      });
    }
    return new Response("Not found", { status: 404 });
  };
  try {
    const attachment = await fetchGmailAttachment({
      mailbox: connectedMailbox,
      messageId: "stale-message",
      threadId: "thread-with-image",
      attachmentId: "old-attachment",
      partId: "2.1",
      filename: "chart.png",
      mimeType: "image/png",
    });
    assert.deepEqual([...attachment.data], [1, 2, 3]);
    assert.equal(attachment.filename, "chart.png");
    assert.equal(attachment.mimeType, "image/png");
    assert.ok(
      requestedPaths.some((path) =>
        path.endsWith(
          "/messages/actual-message/attachments/actual-attachment",
        ),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("attachment downloads preserve Gmail error status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Mailbox permission denied" }), {
      status: 403,
    });
  try {
    await assert.rejects(
      fetchGmailAttachment({
        mailbox: {
          ...connectedMailbox,
          connectionId: "attachment-error-connection",
          datagranApiKey: "attachment-error-key",
        },
        messageId: "message-with-protected-attachment",
        attachmentId: "protected-attachment",
        filename: "proposal.pdf",
        mimeType: "application/pdf",
      }),
      (error: unknown) =>
        error instanceof GmailApiError &&
        error.status === 403 &&
        /permission denied/i.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
