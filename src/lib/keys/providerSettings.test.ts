import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInitialProviderModes,
  deriveGlobalProviderMode,
  hasPrimaryProviderKey,
  providerKeyModesChanged,
} from "./providerSettings";

test("hosted Groovy requires user keys while CLI runtimes keep local login", () => {
  const modes = buildInitialProviderModes(
    "groovy",
    {
      anthropic: "groovy",
      claude_cli: "groovy",
    },
    false,
  );
  assert.equal(modes.anthropic, "user");
  assert.equal(modes.openai, "user");
  assert.equal(modes.claude_cli, "groovy");
  assert.equal(modes.codex_cli, "groovy");
});

test("self-hosted provider modes preserve explicit choices", () => {
  const modes = buildInitialProviderModes(
    "groovy",
    {
      openai: "user",
      codex_cli: "user",
    },
    true,
  );
  assert.equal(modes.anthropic, "groovy");
  assert.equal(modes.openai, "user");
  assert.equal(modes.codex_cli, "user");
  assert.equal(deriveGlobalProviderMode(modes, true), "user");
});

test("mode comparisons and primary-key validation are deterministic", () => {
  const initial = buildInitialProviderModes("user", {}, false);
  assert.equal(providerKeyModesChanged({ ...initial }, initial), false);
  assert.equal(
    providerKeyModesChanged({ ...initial, codex_cli: "user" }, initial),
    true,
  );
  assert.equal(
    hasPrimaryProviderKey({
      configured: { anthropic: { configured: true } },
      entered: {},
    }),
    true,
  );
  assert.equal(
    hasPrimaryProviderKey({
      configured: {},
      entered: { google: "AIza-test" },
    }),
    false,
  );
});
