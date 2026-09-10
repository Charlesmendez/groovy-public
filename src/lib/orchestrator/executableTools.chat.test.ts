import assert from "node:assert/strict";
import test from "node:test";
import {
  chatResolveChannelSchema,
  chatSendMessageSchema,
  createExecutableTools,
  toolDefinitions,
} from "./executableTools";
import { buildToolPolicyExecutionContext } from "./toolPolicy";

function context(provider: string, surface: "internal" | "external" = "internal") {
  const policy = buildToolPolicyExecutionContext({ provider });
  policy.surface = surface;
  return { userId: "user-1", toolPolicy: policy };
}

test("Live voice and dashboard orchestrators receive native Chat tools", () => {
  for (const provider of ["private_live_voice", "dashboard"]) {
    const tools = createExecutableTools(context(provider));
    assert.ok(tools.chat_resolve_channel, provider);
    assert.ok(tools.chat_send_message, provider);
  }
  assert.match(toolDefinitions.chat_resolve_channel.description, /ambiguous/i);
  assert.match(toolDefinitions.chat_send_message.description, /confirmation/i);
});

test("Chat tools are not exposed inside Team Chat, public API, or external Minds", () => {
  for (const [provider, surface] of [
    ["team_chat", "internal"],
    ["team_chat_guest", "internal"],
    ["api", "internal"],
    ["private_live_voice", "external"],
  ] as const) {
    const tools = createExecutableTools(context(provider, surface));
    assert.equal(tools.chat_resolve_channel, undefined, `${provider}/${surface}`);
    assert.equal(tools.chat_send_message, undefined, `${provider}/${surface}`);
  }
});

test("Chat command schemas require an exact channel id and bounded content", () => {
  assert.deepEqual(
    chatResolveChannelSchema.parse({ query: "launch", kind: "channel", open: true }),
    { query: "launch", kind: "channel", open: true },
  );
  assert.throws(() => chatResolveChannelSchema.parse({ query: "" }));
  assert.throws(() =>
    chatSendMessageSchema.parse({ channel_id: "not-an-id", content: "Hello" }),
  );
  assert.deepEqual(
    chatSendMessageSchema.parse({
      channel_id: "11111111-1111-4111-8111-111111111111",
      content: " Hello ",
      open_after_send: true,
    }),
    {
      channel_id: "11111111-1111-4111-8111-111111111111",
      content: "Hello",
      open_after_send: true,
    },
  );
});
