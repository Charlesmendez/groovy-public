import assert from "node:assert/strict";
import test from "node:test";
import {
  actionAuthorizationDenialReason,
  isBuiltInWriteLikeTool,
} from "./actionAuthorization";

test("read operations and reversible memory remain available", () => {
  assert.equal(isBuiltInWriteLikeTool("data_query", { query: "Show unread mail" }), false);
  assert.equal(
    actionAuthorizationDenialReason({
      mode: "confirmation_required",
      toolName: "app_navigate",
      params: { destination: "email" },
    }),
    null,
  );
  assert.equal(
    actionAuthorizationDenialReason({
      mode: "confirmation_required",
      toolName: "remember",
      params: { content: "The launch is Tuesday" },
    }),
    null,
  );
});

test("outbound, destructive, terminal, and agent writes fail closed", () => {
  for (const [toolName, params] of [
    ["whatsapp_send_text", { text: "hello" }],
    ["terminal_exec", { command: "echo changed > file" }],
    ["site_publish", {}],
    ["assign_task", { access_mode: "read_write" }],
    ["ai_agent_delegate", { task: "change the report" }],
    ["files_agent_request", { task: "write the launch notes" }],
    ["data_query", { query: "Send a reply to this email" }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert.match(
      actionAuthorizationDenialReason({
        mode: "confirmation_required",
        toolName,
        params,
      }) || "",
      /not confirmed/i,
    );
  }
});

test("email drafts are reversible but sending remains confirmation gated", () => {
  assert.equal(isBuiltInWriteLikeTool("email_create_draft", {}), true);
  assert.equal(
    actionAuthorizationDenialReason({
      mode: "confirmation_required",
      toolName: "email_create_draft",
      params: {},
    }),
    null,
  );
  assert.match(
    actionAuthorizationDenialReason({
      mode: "confirmation_required",
      toolName: "email_send_draft",
      params: {},
    }) || "",
    /not confirmed/i,
  );
});

test("chat lookup is read-only but posting remains confirmation gated", () => {
  assert.equal(isBuiltInWriteLikeTool("chat_resolve_channel", {}), false);
  assert.equal(isBuiltInWriteLikeTool("chat_send_message", {}), true);
  assert.equal(
    actionAuthorizationDenialReason({
      mode: "confirmation_required",
      toolName: "chat_resolve_channel",
      params: { query: "launch" },
    }),
    null,
  );
  assert.match(
    actionAuthorizationDenialReason({
      mode: "confirmation_required",
      toolName: "chat_send_message",
      params: { channel_id: "channel-id", content: "Hello" },
    }) || "",
    /not confirmed/i,
  );
});

test("extension-declared risk participates in the same boundary", () => {
  assert.equal(
    actionAuthorizationDenialReason({
      mode: "confirmation_required",
      toolName: "custom_lookup",
      params: {},
      extensionRiskLevel: "read",
    }),
    null,
  );
  assert.match(
    actionAuthorizationDenialReason({
      mode: "confirmation_required",
      toolName: "custom_mutation",
      params: {},
      extensionRiskLevel: "write",
    }) || "",
    /not confirmed/i,
  );
});
