import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveScheduledBrowserTaskTimeoutMs,
  runScheduledBrowserTask,
} from "./scheduledBrowserTask.mjs";

test("scheduled browser tasks receive the connector runtime explicitly", async () => {
  const browserTaskRuntime = {
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    playwrightDriver: "cli",
  };
  const availabilityCalls = [];
  const runCalls = [];

  const result = await runScheduledBrowserTask(
    {
      task: "  extract today's Schwab trades  ",
      startUrl: "https://client.schwab.com/",
      profile_name: "schwab",
      api_key: "  api-key  ",
      cli_token: "  cli-token  ",
      timeout_ms: 45_000,
    },
    {
      browserTaskRuntime,
      isPlaywrightAvailable: async (runtime) => {
        availabilityCalls.push(runtime);
        return true;
      },
      runBrowserTaskViaPlaywright: async (options) => {
        runCalls.push(options);
        return { ok: true, text: "one trade" };
      },
      env: {},
    }
  );

  assert.deepEqual(result, { ok: true, text: "one trade" });
  assert.deepEqual(availabilityCalls, [browserTaskRuntime]);
  assert.deepEqual(runCalls, [
    {
      ...browserTaskRuntime,
      task: "extract today's Schwab trades",
      start_url: "https://client.schwab.com/",
      api_key: "api-key",
      cli_token: "cli-token",
      timeout_ms: 45_000,
      profile_name: "schwab",
    },
  ]);
});

test("scheduled browser tasks return a stable unavailable error", async () => {
  let runCalled = false;
  const result = await runScheduledBrowserTask(
    { task: "extract trades" },
    {
      browserTaskRuntime: { provider: "codex" },
      isPlaywrightAvailable: async () => false,
      runBrowserTaskViaPlaywright: async () => {
        runCalled = true;
        return { ok: true };
      },
      env: {},
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "playwright_mcp_unavailable");
  assert.equal(runCalled, false);
});

test("scheduled browser timeout prefers the request, then environment, then default", () => {
  assert.equal(
    resolveScheduledBrowserTaskTimeoutMs(
      { timeout_ms: 30_000 },
      { GROOVY_BROWSER_TASK_TIMEOUT_MS: "60_000" }
    ),
    30_000
  );
  assert.equal(
    resolveScheduledBrowserTaskTimeoutMs({}, { GROOVY_PLAYWRIGHT_TIMEOUT_MS: "90000" }),
    90_000
  );
  assert.equal(resolveScheduledBrowserTaskTimeoutMs({}, {}), 12 * 60 * 1000);
});
