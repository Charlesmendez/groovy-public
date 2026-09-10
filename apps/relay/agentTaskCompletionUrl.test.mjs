import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TASK_COMPLETION_PATH,
  requireHttpOrigin,
  resolveAgentTaskCompletionUrl,
} from "./agentTaskCompletionUrl.mjs";

const canonicalOrigin = "https://www.gogroovy.ai";
const canonicalUrl = `${canonicalOrigin}${AGENT_TASK_COMPLETION_PATH}`;

test("accepts and sanitizes the configured callback origin", () => {
  assert.deepEqual(
    resolveAgentTaskCompletionUrl(
      `${canonicalUrl}?preview=1#fragment`,
      canonicalOrigin,
    ),
    { url: canonicalUrl, usedCanonicalFallback: false },
  );
});

test("falls back to the relay-owned origin for an application alias", () => {
  assert.deepEqual(
    resolveAgentTaskCompletionUrl(
      `https://gogroovy.ai${AGENT_TASK_COMPLETION_PATH}`,
      canonicalOrigin,
    ),
    { url: canonicalUrl, usedCanonicalFallback: true },
  );
});

test("falls back for missing, malformed, or unexpected callback paths", () => {
  for (const value of [
    undefined,
    "",
    "not-a-url",
    `${canonicalOrigin}/api/agents/tasks/run`,
    `https://example.com${AGENT_TASK_COMPLETION_PATH}`,
  ]) {
    assert.deepEqual(
      resolveAgentTaskCompletionUrl(value, canonicalOrigin),
      { url: canonicalUrl, usedCanonicalFallback: true },
    );
  }
});

test("supports self-hosted relay origins without a Groovy-specific hostname", () => {
  assert.deepEqual(
    resolveAgentTaskCompletionUrl(
      "https://groovy.internal.example/api/agents/tasks/complete",
      "https://groovy.internal.example/base/",
    ),
    {
      url: "https://groovy.internal.example/api/agents/tasks/complete",
      usedCanonicalFallback: false,
    },
  );
});

test("rejects empty and unsupported configured origins", () => {
  for (const value of ["", "file:///tmp/groovy", "data:text/plain,groovy"]) {
    assert.throws(
      () => requireHttpOrigin(value),
      /completion origin|HTTP or HTTPS/,
    );
  }
});
