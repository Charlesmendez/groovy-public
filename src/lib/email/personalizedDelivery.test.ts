import assert from "node:assert/strict";
import test from "node:test";
import type { EmailMailboxConnection } from "./gmail";
import {
  canSendPersonalizedEmailFrom,
  personalizedEmailRequestFits,
  resetPersonalizedDeliveryCachesForTests,
  sendPersonalizedEmailVariant,
  sendPersonalizedEmailVariants,
} from "./personalizedDelivery";

const mailbox: EmailMailboxConnection = {
  connectionId: "3d954b68-f1cb-4f21-b0e7-7411cd6c4060",
  provider: "gmail",
  address: "sender@example.com",
  displayName: "Work",
  color: "#22d3ee",
  monogram: "WO",
  isDefaultSender: true,
  includedInUnified: true,
  aiInstructions: "",
  status: "connected",
  counts: { inbox: 0, focus: 0, drafts: 0, noise: 0 },
  datagranApiKey: "test-partner-key",
};

test("personalized delivery rejects payloads before the function body limit", () => {
  const base = {
    connectionId: mailbox.connectionId,
    envelopeFrom: "sender@example.com",
    recipient: "recipient@example.com",
  };
  assert.equal(
    personalizedEmailRequestFits({ ...base, raw: "Short message" }),
    true,
  );
  assert.equal(
    personalizedEmailRequestFits({
      ...base,
      raw: "x".repeat(3_100_000),
    }),
    false,
  );
});

test("personalized delivery is available only for the connected Gmail identity", async () => {
  const originalFetch = globalThis.fetch;
  resetPersonalizedDeliveryCachesForTests();
  globalThis.fetch = async (input, init) => {
    assert.match(
      String(input),
      /\/api\/gmail\/smtp\/status\?connection_id=3d954b68-/,
    );
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-partner-key");
    return Response.json({
      available: true,
      email: "sender@example.com",
      reason: null,
    });
  };
  try {
    assert.equal(
      await canSendPersonalizedEmailFrom({
        mailbox,
        sender: "Sender@Example.com",
      }),
      true,
    );
    assert.equal(
      await canSendPersonalizedEmailFrom({
        mailbox,
        sender: "alias@example.com",
      }),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetPersonalizedDeliveryCachesForTests();
  }
});

test("recipient variants stay inside the Datagran Gmail connection", async () => {
  const originalFetch = globalThis.fetch;
  let payload: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://www.datagran.io/api/gmail/smtp/send",
    );
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-partner-key");
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      accepted: true,
      messageId: "<shared@example.com>",
    });
  };
  try {
    const raw =
      "From: sender@example.com\r\nTo: recipient@example.com\r\n\r\nHello";
    assert.deepEqual(
      await sendPersonalizedEmailVariant({
        mailbox,
        envelopeFrom: "sender@example.com",
        recipient: "recipient@example.com",
        raw,
      }),
      { messageId: "<shared@example.com>" },
    );
    const sentPayload = payload as Record<string, unknown> | null;
    assert.ok(sentPayload);
    assert.equal(sentPayload.connectionId, mailbox.connectionId);
    assert.equal(sentPayload.envelopeFrom, "sender@example.com");
    assert.equal(sentPayload.recipient, "recipient@example.com");
    assert.equal(
      Buffer.from(String(sentPayload.raw), "base64url").toString("utf8"),
      raw,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing SMTP permission produces a reconnect instruction", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      {
        error:
          "Reconnect Gmail to enable individual read receipts for group email",
        details: {
          code: "gmail_smtp_scope_required",
        },
      },
      { status: 409 },
    );
  try {
    await assert.rejects(
      () =>
        sendPersonalizedEmailVariant({
          mailbox,
          envelopeFrom: "sender@example.com",
          recipient: "recipient@example.com",
          raw: "From: sender@example.com\r\n\r\nHello",
        }),
      /Reconnect Gmail/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recipient variants use bounded parallel delivery and settle every result", async () => {
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async (_input, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const payload = JSON.parse(String(init?.body)) as {
      recipient?: string;
    };
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    if (payload.recipient === "third@example.com") {
      return Response.json(
        { error: "Temporary recipient failure" },
        { status: 503 },
      );
    }
    return Response.json({
      accepted: true,
      messageId: `<${payload.recipient}>`,
    });
  };
  try {
    const recipients = [
      "first@example.com",
      "second@example.com",
      "third@example.com",
      "fourth@example.com",
      "fifth@example.com",
    ];
    const results = await sendPersonalizedEmailVariants({
      mailbox,
      envelopeFrom: "sender@example.com",
      variants: recipients.map((recipient) => ({
        recipient,
        raw: `To: ${recipient}\r\n\r\nHello`,
      })),
      maxConcurrency: 3,
    });
    assert.equal(maxActive, 3);
    assert.deepEqual(
      results.map((result) => [result.recipient, result.ok]),
      [
        ["first@example.com", true],
        ["second@example.com", true],
        ["third@example.com", false],
        ["fourth@example.com", true],
        ["fifth@example.com", true],
      ],
    );
    assert.deepEqual(results[2], {
      recipient: "third@example.com",
      ok: false,
      error: "Temporary recipient failure",
      definitelyNotSent: false,
      status: 503,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a platform payload rejection is known not to have reached Gmail", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Request Entity Too Large FUNCTION_PAYLOAD_TOO_LARGE", {
      status: 413,
    });
  try {
    const results = await sendPersonalizedEmailVariants({
      mailbox,
      envelopeFrom: "sender@example.com",
      variants: [
        {
          recipient: "recipient@example.com",
          raw: "From: sender@example.com\r\n\r\nHello",
        },
      ],
    });
    assert.deepEqual(results, [
      {
        recipient: "recipient@example.com",
        ok: false,
        error: "Gmail did not confirm delivery to recipient@example.com.",
        definitelyNotSent: true,
        status: 413,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
