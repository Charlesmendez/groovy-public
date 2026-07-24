import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  sendTransactionalEmail,
  transactionalEmailFrom,
} from "./resend.ts";

const originalApiKey = process.env.RESEND_API_KEY;
const originalFrom = process.env.RESEND_FROM_EMAIL;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalApiKey;

  if (originalFrom === undefined) delete process.env.RESEND_FROM_EMAIL;
  else process.env.RESEND_FROM_EMAIL = originalFrom;

  globalThis.fetch = originalFetch;
});

test("uses the verified Groovy sender by default", () => {
  delete process.env.RESEND_FROM_EMAIL;
  assert.equal(
    transactionalEmailFrom(),
    "Groovy <notifications@hi.gogroovy.ai>",
  );
});

test("sends transactional email through Resend", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM_EMAIL = "Groovy Test <test@hi.gogroovy.ai>";

  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://api.resend.com/emails");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, {
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
    });
    assert.deepEqual(JSON.parse(String(init?.body)), {
      from: "Groovy Test <test@hi.gogroovy.ai>",
      to: ["person@example.com"],
      subject: "Test subject",
      text: "Plain text",
      html: "<p>Plain text</p>",
      reply_to: "support@gogroovy.ai",
    });
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
  };

  const result = await sendTransactionalEmail({
    to: "person@example.com",
    subject: "Test subject",
    text: "Plain text",
    html: "<p>Plain text</p>",
    replyTo: "support@gogroovy.ai",
  });

  assert.deepEqual(result, { ok: true, id: "email_123" });
});

test("fails closed when Resend is not configured", async () => {
  delete process.env.RESEND_API_KEY;
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    return new Response(null, { status: 200 });
  };

  const result = await sendTransactionalEmail({
    to: "person@example.com",
    subject: "Test subject",
    text: "Plain text",
  });

  assert.equal(result.ok, false);
  assert.equal(requested, false);
  if (!result.ok) assert.equal(result.code, "not_configured");
});

test("returns a bounded provider error without exposing raw response data", async () => {
  process.env.RESEND_API_KEY = "re_test_key";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        name: "validation_error",
        message: "The hi.gogroovy.ai domain is not verified.",
        internal: "do-not-expose",
      }),
      { status: 403 },
    );

  const result = await sendTransactionalEmail({
    to: "person@example.com",
    subject: "Test subject",
    text: "Plain text",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "provider_rejected");
    assert.equal(result.status, 403);
    assert.match(result.error, /domain is not verified/);
    assert.doesNotMatch(result.error, /do-not-expose/);
  }
});
