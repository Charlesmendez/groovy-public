import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIncomingWebhookUrl,
  IncomingWebhookError,
  parseWebhookEventId,
  parseWebhookText,
  readWebhookJson,
  WEBHOOK_BODY_LIMIT,
  webhookCurlExample,
  webhookMessageLabel,
} from "./incomingWebhook";

test("hosted webhook URLs bypass the apex redirect without rotating the secret", () => {
  const token = `gwh_${"a".repeat(64)}`;
  for (const baseUrl of [
    "https://gogroovy.ai",
    "https://gogroovy.ai/",
    "https://www.gogroovy.ai",
    "http://gogroovy.ai",
    "http://www.gogroovy.ai",
  ]) {
    assert.equal(
      buildIncomingWebhookUrl(baseUrl, token),
      `https://www.gogroovy.ai/api/hooks/${token}`,
    );
  }
});

test("webhook URL normalization preserves self-hosted, local, preview, and look-alike hosts", () => {
  for (const origin of [
    "https://chat.customer.example",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://groovy-preview.vercel.app",
    "https://gogroovy.ai.example",
    "https://gogroovy.ai:8443",
  ]) {
    assert.equal(
      buildIncomingWebhookUrl(`${origin}/settings?tab=webhooks`, "test-token"),
      `${origin}/api/hooks/test-token`,
    );
  }
});

test("webhook text preserves Markdown and treats other fields as untrusted data", () => {
  assert.equal(
    parseWebhookText({
      text: " **Build passed**\nReady to ship. ",
      channel: "other",
      username: "Admin",
      metadata: { kind: "agent" },
    }),
    "**Build passed**\nReady to ship.",
  );
  for (const body of [
    null,
    [],
    "text",
    { text: 1 },
    { text: "  " },
    { blocks: [] },
    { text: "hello\u0000" },
  ]) {
    assert.throws(() => parseWebhookText(body), IncomingWebhookError);
  }
  assert.throws(
    () => parseWebhookText({ text: "x".repeat(40001) }),
    (error: unknown) =>
      error instanceof IncomingWebhookError && error.status === 413,
  );
});

test("body limits work even without Content-Length", async () => {
  const request = (body: string, type = "application/json") =>
    new Request("https://groovy.example/api/hooks/test", {
      method: "POST",
      headers: { "Content-Type": type },
      body,
    });
  assert.deepEqual(await readWebhookJson(request('{"text":"Hello 👋"}')), {
    text: "Hello 👋",
  });
  await assert.rejects(
    readWebhookJson(request("{broken")),
    (error: unknown) =>
      error instanceof IncomingWebhookError && error.code === "invalid_json",
  );
  await assert.rejects(
    readWebhookJson(request("{}", "text/plain")),
    (error: unknown) =>
      error instanceof IncomingWebhookError && error.status === 415,
  );
  await assert.rejects(
    readWebhookJson(request("x".repeat(WEBHOOK_BODY_LIMIT + 1))),
    (error: unknown) =>
      error instanceof IncomingWebhookError && error.status === 413,
  );
});

test("idempotency keys are bounded and optional", () => {
  assert.equal(parseWebhookEventId(null), null);
  assert.equal(parseWebhookEventId("event-123"), "event-123");
  for (const key of ["", "two words", "line\nbreak", "a".repeat(129)])
    assert.throws(() => parseWebhookEventId(key), IncomingWebhookError);
});

test("webhook attribution cannot relabel a human or a Mind", () => {
  const metadata = {
    kind: "incoming_webhook",
    webhook_name: "Release updates",
  };
  assert.equal(
    webhookMessageLabel({ author_type: "system", metadata }),
    "Release updates",
  );
  assert.equal(webhookMessageLabel({ author_type: "user", metadata }), null);
  assert.equal(
    webhookMessageLabel({ author_type: "orchestrator", metadata }),
    null,
  );
  assert.equal(
    webhookMessageLabel({ author_type: "system", metadata: {} }),
    null,
  );
});

test("the copyable cURL example uses real continuation lines and quotes the URL", () => {
  assert.ok(
    webhookCurlExample("https://groovy.example/api/hooks/test").startsWith(
      "curl --location --fail-with-body ",
    ),
  );
  assert.equal(
    webhookCurlExample("https://groovy.example/api/hooks/test").split("\n")
      .length,
    3,
  );
  assert.ok(
    webhookCurlExample("https://groovy.example/api/hooks/test").includes(
      "\\\n  -H",
    ),
  );
  assert.ok(
    webhookCurlExample("https://groovy.example/'test").includes("'\\''"),
  );
});
