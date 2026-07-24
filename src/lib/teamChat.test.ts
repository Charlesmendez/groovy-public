import { strict as assert } from "node:assert";
import test from "node:test";
import {
  createChatChannelInRlsOrder,
  mentionsHandle,
  parseTeamChatControlRequest,
  shouldRunChannelOrchestrator,
  type ChatChannelRow,
} from "./teamChat";

const channel: ChatChannelRow = {
  id: "c",
  workspace_id: "w",
  kind: "channel",
  name: "support",
  slug: "support",
  topic: null,
  profile_id: "p",
  orchestrator_mode: "mention",
  visibility: "workspace",
  is_archived: false,
  created_by: "u",
};

test("mention parsing has word boundaries", () => {
  assert.equal(mentionsHandle("hello @Scout, please look", "Scout"), true);
  assert.equal(mentionsHandle("hello@Scout", "Scout"), false);
  assert.equal(mentionsHandle("@ScoutExtra", "Scout"), false);
});

test("channel modes and profile/agent mentions route correctly", () => {
  assert.equal(
    shouldRunChannelOrchestrator({
      content: "humans only",
      channel,
      profileName: "Support Mind",
    }),
    false,
  );
  assert.equal(
    shouldRunChannelOrchestrator({
      content: "@Support help",
      channel,
      profileName: "Support Mind",
    }),
    true,
  );
  assert.equal(
    shouldRunChannelOrchestrator({
      content: "@Kiko fix this",
      channel,
      agentNames: ["Kiko"],
    }),
    true,
  );
  assert.equal(
    shouldRunChannelOrchestrator({
      content: "always answer",
      channel: { ...channel, orchestrator_mode: "always" },
    }),
    true,
  );
  assert.equal(
    shouldRunChannelOrchestrator({
      content: "@orchestrator answer",
      channel: { ...channel, orchestrator_mode: "off" },
    }),
    false,
  );
});

test("team chat control requests require explicit targets and redirect text", () => {
  assert.deepEqual(parseTeamChatControlRequest({ action: "stop" }), {
    ok: false,
    error: "action and target are required",
  });
  assert.deepEqual(
    parseTeamChatControlRequest({
      action: "redirect",
      target: "orchestrator",
      direction: "   ",
    }),
    {
      ok: false,
      error: "direction must be 1-4000 characters",
    },
  );
  assert.deepEqual(
    parseTeamChatControlRequest({
      action: "redirect",
      target: "agent",
      taskId: "task-123",
      direction: "Focus only on the API.",
    }),
    {
      ok: true,
      value: {
        action: "redirect",
        target: "agent",
        taskId: "task-123",
        direction: "Focus only on the API.",
      },
    },
  );
});

test("DM creation adds membership before reading the RLS-protected channel", async () => {
  const operations: string[] = [];
  const result = await createChatChannelInRlsOrder({
    insertChannelWithoutReturning: async () => {
      operations.push("insert channel without returning");
      return null;
    },
    insertMembers: async () => {
      operations.push("insert members");
      return null;
    },
    readChannel: async () => {
      operations.push("read channel");
      return { data: { id: "dm-1" }, error: null };
    },
    rollbackChannel: async () => {
      operations.push("rollback channel");
    },
  });

  assert.deepEqual(operations, [
    "insert channel without returning",
    "insert members",
    "read channel",
  ]);
  assert.deepEqual(result, {
    data: { id: "dm-1" },
    error: null,
    stage: null,
  });
});

test("channel capabilities are added only after creator membership exists", async () => {
  const operations: string[] = [];
  const result = await createChatChannelInRlsOrder({
    insertChannelWithoutReturning: async () => {
      operations.push("insert channel");
      return null;
    },
    insertMembers: async () => {
      operations.push("insert members");
      return null;
    },
    insertCapabilities: async () => {
      operations.push("insert capabilities");
      return null;
    },
    readChannel: async () => {
      operations.push("read channel");
      return { data: { id: "channel-1" }, error: null };
    },
    rollbackChannel: async () => {
      operations.push("rollback channel");
    },
  });

  assert.deepEqual(operations, [
    "insert channel",
    "insert members",
    "insert capabilities",
    "read channel",
  ]);
  assert.deepEqual(result, {
    data: { id: "channel-1" },
    error: null,
    stage: null,
  });
});

test("channel creation rolls back if capability assignment fails", async () => {
  const operations: string[] = [];
  const result = await createChatChannelInRlsOrder({
    insertChannelWithoutReturning: async () => null,
    insertMembers: async () => null,
    insertCapabilities: async () => ({
      message: "skill unavailable",
      code: "42501",
    }),
    readChannel: async () => ({
      data: { id: "unreachable" },
      error: null,
    }),
    rollbackChannel: async () => {
      operations.push("rollback channel");
    },
  });

  assert.deepEqual(operations, ["rollback channel"]);
  assert.deepEqual(result, {
    data: null,
    error: { message: "skill unavailable", code: "42501" },
    stage: "capabilities",
  });
});
