import assert from "node:assert/strict";
import test from "node:test";
import { buildPersistentConnectorArgs } from "./args.mjs";

test("persists the licensed update endpoint without optional runtimes", () => {
  assert.deepEqual(
    buildPersistentConnectorArgs({ appUrl: "https://www.gogroovy.ai" }),
    ["--app-url", "https://www.gogroovy.ai"]
  );
});

test("persists WhatsApp arguments without duplicating the app URL", () => {
  assert.deepEqual(
    buildPersistentConnectorArgs({
      appUrl: "https://www.gogroovy.ai",
      whatsappEnabled: true,
      whatsappGroupName: "Groovy",
    }),
    [
      "--app-url",
      "https://www.gogroovy.ai",
      "--whatsapp",
      "--whatsapp-group",
      "Groovy",
    ]
  );
});

test("omits empty persistent arguments", () => {
  assert.deepEqual(buildPersistentConnectorArgs(), []);
});
