import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexArgs, extractCodexResult } from "./runHeadlessCodex.mjs";

function configValues(args) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "-c") values.push(args[index + 1]);
  }
  return values;
}

test("ordinary read-only Codex runs remain offline", () => {
  const args = buildCodexArgs({
    prompt: "Inspect the repository",
    cwd: "/tmp/workspace",
    readOnly: true,
  });
  const config = configValues(args);
  assert.ok(config.includes('sandbox_mode="read-only"'));
  assert.equal(
    config.some((value) => value.includes("network.enabled=true")),
    false,
  );
});

test("Vercel read-only Codex runs keep files read-only and allow only Vercel network domains", () => {
  const args = buildCodexArgs({
    prompt: "Inspect the latest Vercel deployment",
    cwd: "/tmp/workspace",
    readOnly: true,
    externalAccess: "vercel_read",
  });
  const config = configValues(args);
  assert.ok(config.includes('default_permissions="groovy-vercel-read"'));
  assert.ok(
    config.includes(
      'permissions.groovy-vercel-read.extends=":read-only"',
    ),
  );
  assert.ok(
    config.includes(
      "permissions.groovy-vercel-read.network.enabled=true",
    ),
  );
  assert.ok(
    config.some(
      (value) =>
        value.startsWith(
          "permissions.groovy-vercel-read.network.domains=",
        ) &&
        value.includes('"**.vercel.com" = "allow"') &&
        value.includes('"**.vercel.app" = "allow"'),
    ),
  );
  assert.equal(
    config.some((value) => value.startsWith("sandbox_mode=")),
    false,
  );
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("Codex browser runs accept scoped Playwright MCP overrides and ephemeral mode", () => {
  const args = buildCodexArgs({
    prompt: "Read the page",
    cwd: "/tmp/workspace",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    ephemeral: true,
    configOverrides: [
      'mcp_servers.playwright.command="npx"',
      'mcp_servers.playwright.args=["@playwright/mcp@latest"]',
    ],
  });
  const config = configValues(args);
  assert.ok(config.includes('model_reasoning_effort="medium"'));
  assert.ok(config.includes('mcp_servers.playwright.command="npx"'));
  assert.ok(config.includes('mcp_servers.playwright.args=["@playwright/mcp@latest"]'));
  assert.ok(args.includes("--ephemeral"));
});

test("Codex JSON completion usage is extracted without a session file", () => {
  const result = extractCodexResult([
    { type: "thread.started", thread_id: "thread-1" },
    { type: "item.completed", item: { type: "agent_message", text: "Done" } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 20,
        output_tokens: 30,
        total_tokens: 150,
      },
    },
  ]);
  assert.equal(result.resultText, "Done");
  assert.deepEqual(result.usage, {
    input_tokens: 120,
    output_tokens: 30,
    total_tokens: 150,
    cached_input_tokens: 20,
    cache_read_input_tokens: 20,
  });
});
