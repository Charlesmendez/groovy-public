import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeSkillAction, normalizeSkillActionsManifest } from "./skillActions.mjs";

const validHttp = {
  schemaVersion: 1,
  actions: [{
    name: "lookup_customer",
    description: "Look up a customer",
    secrets: ["CUSTOMER_API_KEY"],
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    http: { method: "GET", url: "https://api.example.com/customers/{{args.id}}", headers: { Authorization: "Bearer {{secret.CUSTOMER_API_KEY}}" } },
  }],
};

test("normalizes a fixed-origin HTTPS action", () => {
  const manifest = normalizeSkillActionsManifest(validHttp);
  assert.equal(manifest.actions[0].name, "lookup_customer");
  assert.equal(manifest.actions[0].http.method, "GET");
});

test("rejects secret values in URLs", () => {
  assert.throws(() => normalizeSkillActionsManifest({ ...validHttp, actions: [{ ...validHttp.actions[0], http: { url: "https://api.example.com/{{secret.CUSTOMER_API_KEY}}" } }] }), /secret_in_action_url/);
});

test("rejects shell and arbitrary command executables", () => {
  assert.throws(() => normalizeSkillActionsManifest({ schemaVersion: 1, actions: [{ name: "bad_command", secrets: [], inputSchema: { type: "object", properties: {} }, command: { executable: "bash", args: ["scripts/run.sh"] } }] }), /invalid_action_executable/);
});

test("rejects secret values in process arguments", () => {
  assert.throws(() => normalizeSkillActionsManifest({ schemaVersion: 1, actions: [{ name: "bad_argument", secrets: ["API_KEY"], inputSchema: { type: "object", properties: {} }, command: { executable: "node", args: ["scripts/run.mjs", "{{secret.API_KEY}}"] } }] }), /secret_in_action_arguments/);
});

test("accepts exact secret injection through a command environment", () => {
  const manifest = normalizeSkillActionsManifest({ schemaVersion: 1, actions: [{ name: "safe_command", secrets: ["API_KEY"], inputSchema: { type: "object", properties: {} }, command: { executable: "node", args: ["scripts/run.mjs"], env: { API_KEY: "{{secret.API_KEY}}" } } }] });
  assert.equal(manifest.actions[0].command.env.API_KEY, "{{secret.API_KEY}}");
});

test("rejects command environments that can alter the runtime loader", () => {
  assert.throws(() => normalizeSkillActionsManifest({ schemaVersion: 1, actions: [{ name: "unsafe_env", secrets: [], inputSchema: { type: "object", properties: {} }, command: { executable: "node", args: ["scripts/run.mjs"], env: { NODE_OPTIONS: "--require ./hook.cjs" } } }] }), /invalid_action_environment/);
});

test("returns validation errors instead of rejecting and crashing the connector", async (t) => {
  const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "groovy-skill-action-"));
  t.after(() => fs.rm(skillDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(skillDir, "groovy-actions.json"), JSON.stringify(validHttp));

  const result = await executeSkillAction({
    skillDir,
    actionName: "lookup_customer",
    args: {},
    workspaceId: "workspace",
    secretBindings: [],
  });

  assert.deepEqual(result, { ok: false, error: "missing_action_argument:id" });
});

test("returns current actions when a stale catalog requests an undeclared action", async (t) => {
  const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "groovy-skill-action-"));
  t.after(() => fs.rm(skillDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(skillDir, "groovy-actions.json"), JSON.stringify(validHttp));

  const result = await executeSkillAction({
    skillDir,
    actionName: "legacy_customer_lookup",
    args: {},
    workspaceId: "workspace",
    secretBindings: [],
  });

  assert.deepEqual(result, {
    ok: false,
    error: "action_not_declared",
    message:
      "Action legacy_customer_lookup is not declared in the current skill manifest. Use one of: lookup_customer.",
    availableActions: ["lookup_customer"],
  });
});
