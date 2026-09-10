import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrowserTaskRuntimeSettings } from "./browserTask.mjs";

const ENV_KEYS = [
  "GROOVY_BROWSER_TASK_PROVIDER",
  "GROOVY_COMPUTER_USE_PROVIDER",
  "GROOVY_BROWSER_TASK_MODEL",
  "GROOVY_COMPUTER_USE_MODEL",
  "GROOVY_CLAUDE_CLI_MODEL",
  "GROOVY_BROWSER_TASK_REASONING_EFFORT",
  "GROOVY_COMPUTER_USE_REASONING_EFFORT",
  "GROOVY_PLAYWRIGHT_DRIVER",
  "GROOVY_BROWSER_TASK_DRIVER",
];

function withoutBrowserTaskEnv(fn) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("computer browser defaults to skill-fed Playwright CLI with Codex Luna at medium reasoning", () => {
  withoutBrowserTaskEnv(() => {
    assert.deepEqual(resolveBrowserTaskRuntimeSettings(), {
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      playwrightDriver: "cli",
    });
  });
});

test("computer browser forces Claude onto MCP even when CLI is requested", () => {
  withoutBrowserTaskEnv(() => {
    assert.deepEqual(
      resolveBrowserTaskRuntimeSettings({
        provider: "claude",
        model: "claude-sonnet-4-6",
        reasoning_effort: "high",
        playwright_driver: "cli",
      }),
      {
        provider: "claude",
        model: "claude-sonnet-4-6",
        reasoningEffort: "high",
        playwrightDriver: "mcp",
      }
    );
  });
});

test("a model from the wrong provider falls back safely", () => {
  withoutBrowserTaskEnv(() => {
    assert.deepEqual(
      resolveBrowserTaskRuntimeSettings({ provider: "codex", model: "claude-sonnet-4-6" }),
      {
        provider: "codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        playwrightDriver: "cli",
      }
    );
  });
});

test("computer browser can explicitly select the CLI transport", () => {
  withoutBrowserTaskEnv(() => {
    assert.deepEqual(
      resolveBrowserTaskRuntimeSettings({ playwright_driver: "cli" }),
      {
        provider: "codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        playwrightDriver: "cli",
      }
    );
  });
});

test("computer browser can explicitly select MCP for Codex", () => {
  withoutBrowserTaskEnv(() => {
    assert.deepEqual(
      resolveBrowserTaskRuntimeSettings({ playwright_driver: "mcp" }),
      {
        provider: "codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        playwrightDriver: "mcp",
      }
    );
  });
});
