import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildManagedConnectorArgs } = require("../dist/main/connectorLaunch.js");

test("Desktop-managed connector takes ownership of stale processes", () => {
  const args = buildManagedConnectorArgs({
    connectorDir: "/Applications/Groovy.app/Contents/Resources/connector",
    relayUrl: "wss://groovy-relay.fly.dev",
  });

  assert.deepEqual(args, [
    "/Applications/Groovy.app/Contents/Resources/connector/connector.mjs",
    "--relay",
    "wss://groovy-relay.fly.dev",
    "--no-autostart",
    "--kill-others",
  ]);
});

test("pairing arguments remain after lifecycle ownership flags", () => {
  const args = buildManagedConnectorArgs({
    connectorDir: "/tmp/connector",
    relayUrl: "wss://relay.example",
    extraArgs: ["--pair", "ABCD-1234", "--allow-account-switch"],
  });

  assert.deepEqual(args.slice(-3), [
    "--pair",
    "ABCD-1234",
    "--allow-account-switch",
  ]);
  assert.equal(args.includes("--kill-others"), true);
});
