import assert from "node:assert/strict";
import test from "node:test";
import { shouldGroupChatMessage } from "./messageGrouping";

const base = {
  channel_id: "channel-1",
  author_type: "user" as const,
  author_user_id: "user-1",
  author_agent_id: null,
  profile_id: null,
  metadata: {},
  created_at: "2026-07-28T14:00:00.000Z",
};

test("groups consecutive messages by the same author within five minutes", () => {
  assert.equal(
    shouldGroupChatMessage(base, {
      ...base,
      created_at: "2026-07-28T14:04:59.000Z",
    }),
    true,
  );
});

test("starts a new group when author, room, or time window changes", () => {
  assert.equal(
    shouldGroupChatMessage(base, {
      ...base,
      author_user_id: "user-2",
      created_at: "2026-07-28T14:01:00.000Z",
    }),
    false,
  );
  assert.equal(
    shouldGroupChatMessage(base, {
      ...base,
      channel_id: "channel-2",
      created_at: "2026-07-28T14:01:00.000Z",
    }),
    false,
  );
  assert.equal(
    shouldGroupChatMessage(base, {
      ...base,
      created_at: "2026-07-28T14:05:01.000Z",
    }),
    false,
  );
});

test("keeps different agents and Minds in separate groups", () => {
  const agent = {
    ...base,
    author_type: "agent" as const,
    author_user_id: null,
    author_agent_id: "agent-1",
  };
  assert.equal(
    shouldGroupChatMessage(agent, {
      ...agent,
      author_agent_id: "agent-2",
      created_at: "2026-07-28T14:01:00.000Z",
    }),
    false,
  );
  const mind = {
    ...base,
    author_type: "orchestrator" as const,
    author_user_id: null,
    profile_id: "mind-1",
  };
  assert.equal(
    shouldGroupChatMessage(mind, {
      ...mind,
      profile_id: "mind-2",
      created_at: "2026-07-28T14:01:00.000Z",
    }),
    false,
  );
});

test("keeps scheduled results separate from live Mind replies", () => {
  const mind = {
    ...base,
    author_type: "orchestrator" as const,
    author_user_id: null,
    profile_id: "mind-1",
  };
  assert.equal(
    shouldGroupChatMessage(mind, {
      ...mind,
      metadata: { kind: "scheduled_task_result" },
      created_at: "2026-07-28T14:01:00.000Z",
    }),
    false,
  );
  assert.equal(
    shouldGroupChatMessage(
      { ...mind, metadata: { kind: "scheduled_task_result" } },
      { ...mind, created_at: "2026-07-28T14:01:00.000Z" },
    ),
    false,
  );
});
