import assert from "node:assert/strict";
import test from "node:test";
import { createExecutableTools, toolDefinitions } from "./executableTools";
import { buildToolPolicyExecutionContext } from "./toolPolicy";

function context(provider: string, surface: "internal" | "external" = "internal") {
  const policy = buildToolPolicyExecutionContext({ provider });
  policy.surface = surface;
  return { userId: "user-1", toolPolicy: policy };
}

test("dashboard and Live voice receive native email read, draft, and send tools", () => {
  for (const provider of ["dashboard", "private_live_voice"]) {
    const tools = createExecutableTools(context(provider));
    assert.ok(tools.email_search, provider);
    assert.ok(tools.email_create_draft, provider);
    assert.ok(tools.email_send_draft, provider);
  }
  assert.match(toolDefinitions.email_search.description, /does not delegate/i);
  assert.match(toolDefinitions.email_send_draft.description, /confirmation/i);
  assert.match(toolDefinitions.data_query.description, /do not select provider=gmail/i);
});

test("private Email tools fail closed outside authenticated app and voice turns", () => {
  const contexts = [
    { userId: "user-1" },
    context("team_chat"),
    context("team_chat_guest"),
    context("api"),
    context("scheduler_cloud"),
    context("whatsapp_web"),
    context("private_live_voice", "external"),
  ];
  for (const candidate of contexts) {
    const tools = createExecutableTools(candidate);
    assert.equal(tools.email_search, undefined);
    assert.equal(tools.email_create_draft, undefined);
    assert.equal(tools.email_send_draft, undefined);
  }
});
