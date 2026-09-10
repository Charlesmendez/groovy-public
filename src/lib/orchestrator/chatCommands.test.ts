import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveGroovyChatChannel,
  sendGroovyChatMessage,
  type ChatCommandDependencies,
  type ChatCommandUiAction,
} from "./chatCommands";
import type { AccessibleChatChannel } from "@/lib/chat/channelCommandService";

const channel: AccessibleChatChannel = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "workspace-1",
  kind: "channel",
  name: "launch",
  slug: "launch",
  displayName: "Launch",
  visibility: "workspace",
  isArchived: false,
};

function dependencies(
  overrides: Partial<ChatCommandDependencies> = {},
): ChatCommandDependencies {
  return {
    createAdmin: () => ({}) as SupabaseClient,
    resolveChannel: async () => ({ ok: true, channel }),
    authorizeChannel: async () => ({ ok: true, channel }),
    buildInternalHeaders: () => ({
      "x-groovy-internal-user-id": "user-1",
      "x-groovy-internal-auth": "signed",
    }),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          message: { id: "message-1", content: "Hello" },
          orchestrator: null,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    createClientMessageId: () => "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

test("channel resolution never guesses an ambiguous conversation", async () => {
  const result = await resolveGroovyChatChannel(
    { userId: "user-1", query: "launch" },
    dependencies({
      resolveChannel: async () => ({
        ok: false,
        reason: "ambiguous",
        message: "Choose a conversation.",
        candidates: [channel, { ...channel, id: "channel-2", slug: "launch-2" }],
      }),
    }),
  );
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "ambiguous");
  assert.deepEqual(
    (result.candidates as Array<Record<string, unknown>>).map((candidate) =>
      candidate.id,
    ),
    [channel.id, "channel-2"],
  );
});

test("channel resolution emits a safe Chat UI action only when requested", async () => {
  const actions: ChatCommandUiAction[] = [];
  const result = await resolveGroovyChatChannel(
    {
      userId: "user-1",
      query: "launch",
      open: true,
      onUiAction: (action) => actions.push(action),
    },
    dependencies(),
  );
  assert.equal(result.resolved, true);
  assert.equal(result.opened, true);
  assert.equal(result.url, `/chat/${channel.id}`);
  assert.deepEqual(actions, [
    { type: "open_chat", url: `/chat/${channel.id}`, label: "Launch" },
  ]);
});

test("message delivery uses signed narrow auth, a unique id, timezone, and preserves warnings", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const actions: ChatCommandUiAction[] = [];
  const result = await sendGroovyChatMessage(
    {
      userId: "user-1",
      appBaseUrl: "https://www.gogroovy.ai/",
      channelId: channel.id,
      content: " Hello ",
      timezone: "America/New_York",
      openAfterSend: true,
      onUiAction: (action) => actions.push(action),
    },
    dependencies({
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            message: { id: "message-1", content: "Hello" },
            orchestrator: null,
            error: "Message delivered, but the channel Mind did not respond.",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    }),
  );

  assert.equal(result.delivered, true);
  assert.equal(
    result.warning,
    "Message delivered, but the channel Mind did not respond.",
  );
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `https://www.gogroovy.ai/api/chat/channels/${channel.id}/messages`,
  );
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    content: "Hello",
    clientMessageId: "22222222-2222-4222-8222-222222222222",
    timezone: "America/New_York",
  });
  assert.deepEqual(requests[0].init?.headers, {
    "Content-Type": "application/json",
    "x-groovy-internal-user-id": "user-1",
    "x-groovy-internal-auth": "signed",
  });
  assert.deepEqual(actions, [
    { type: "open_chat", url: `/chat/${channel.id}`, label: "Launch" },
  ]);
});

test("message delivery fails closed when signed internal auth is unavailable", async () => {
  let called = false;
  await assert.rejects(
    sendGroovyChatMessage(
      {
        userId: "user-1",
        appBaseUrl: "https://www.gogroovy.ai",
        channelId: channel.id,
        content: "Hello",
      },
      dependencies({
        buildInternalHeaders: () => ({}),
        fetchImpl: async () => {
          called = true;
          return new Response();
        },
      }),
    ),
    /secure Groovy Chat delivery is unavailable/i,
  );
  assert.equal(called, false);
});

test("a navigation callback failure cannot turn a delivered message into failure", async () => {
  const result = await sendGroovyChatMessage(
    {
      userId: "user-1",
      appBaseUrl: "https://www.gogroovy.ai",
      channelId: channel.id,
      content: "Hello",
      openAfterSend: true,
      onUiAction: () => {
        throw new Error("UI is gone");
      },
    },
    dependencies(),
  );
  assert.equal(result.delivered, true);
  assert.equal(result.opened, false);
  assert.match(String(result.navigationWarning), /returned URL/i);
  assert.equal(result.url, `/chat/${channel.id}`);
});
