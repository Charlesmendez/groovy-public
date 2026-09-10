import assert from "node:assert/strict";
import test from "node:test";
import { publicTeamChatAgentProgress } from "./agentTaskProgress";

test("projects only channel-safe live agent activity", () => {
  const progress = publicTeamChatAgentProgress({
    live_text: "Inspecting the request…",
    live_tools: [
      { name: "Read", input: "src/app/page.tsx", at: "private-timestamp" },
      null,
      { name: "", input: "ignored" },
    ],
    live_events: [
      {
        seq: 1,
        type: "assistant",
        content: "Inspecting…",
        at: "private-timestamp",
      },
      {
        seq: 2,
        type: "tool_use",
        name: "Read",
        input: "src/app/page.tsx",
        at: "private-timestamp",
      },
    ],
    live_event_count: 2,
    live_text_truncated: true,
    progress_updated_at: "2026-07-25T18:00:00.000Z",
    relay_request_id: "must-not-leak",
    task_run_billing: { cost: 100 },
    consumed_transfer_ids: ["secret"],
  });

  assert.deepEqual(progress, {
    liveText: "Inspecting the request…",
    liveTextTruncated: true,
    liveTools: [{ name: "Read", input: "src/app/page.tsx" }],
    liveEvents: [
      { seq: 1, type: "assistant", content: "Inspecting…" },
      {
        seq: 2,
        type: "tool_use",
        name: "Read",
        input: "src/app/page.tsx",
      },
    ],
    liveEventCount: 2,
    liveEventsTruncated: false,
    progressUpdatedAt: "2026-07-25T18:00:00.000Z",
  });
  assert.equal("relay_request_id" in progress, false);
  assert.equal("task_run_billing" in progress, false);
});

test("bounds live text and tool activity returned to Team Chat", () => {
  const progress = publicTeamChatAgentProgress({
    live_text: `prefix-${"x".repeat(25_000)}`,
    live_tools: Array.from({ length: 12 }, (_, index) => ({
      name: `Tool ${index}`,
      input: "y".repeat(700),
    })),
  });

  assert.equal(progress.liveText.length, 20_000);
  assert.equal(progress.liveTextTruncated, true);
  assert.equal(progress.liveTools.length, 8);
  assert.equal(progress.liveTools[0]?.name, "Tool 4");
  assert.equal(progress.liveTools[0]?.input.length, 500);
  assert.deepEqual(progress.liveEvents, []);
  assert.equal(progress.liveEventCount, 0);
  assert.equal(progress.liveEventsTruncated, false);
});

test("redacts secret-like material from narrated and tool progress", () => {
  const progress = publicTeamChatAgentProgress({
    live_text:
      "Calling with Authorization: Bearer abcdefghijklmnopqrstuvwxyz and api_key=abcdefghijklmno",
    live_tools: [
      {
        name: "Bash",
        input:
          "curl https://user:supersecretpassword@example.com -H 'x: sk-ant-abcdefghijklmnopqrstuvwxyz'",
      },
    ],
  });

  assert.doesNotMatch(progress.liveText, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(progress.liveText, /Bearer \[redacted\]/);
  assert.match(progress.liveText, /api_key= \[redacted\]/);
  assert.doesNotMatch(progress.liveTools[0]?.input || "", /supersecretpassword/);
  assert.doesNotMatch(
    progress.liveTools[0]?.input || "",
    /sk-ant-abcdefghijklmnopqrstuvwxyz/,
  );
  assert.deepEqual(progress.liveEvents, []);
});

test("preserves ordered narrated and tool events without leaking private fields", () => {
  const progress = publicTeamChatAgentProgress({
    live_events: [
      {
        seq: 7,
        type: "assistant",
        content: "Reading the implementation. ",
        hidden: "must-not-leak",
      },
      {
        seq: 8,
        type: "tool_use",
        name: "Grep",
        input: "api_key=abcdefghijklmnop",
        at: "private-timestamp",
      },
      {
        seq: 9,
        type: "assistant",
        content: "Found the completion path.",
      },
    ],
    live_event_count: 9,
  });

  assert.deepEqual(progress.liveEvents, [
    {
      seq: 7,
      type: "assistant",
      content: "Reading the implementation. ",
    },
    {
      seq: 8,
      type: "tool_use",
      name: "Grep",
      input: "api_key= [redacted]",
    },
    {
      seq: 9,
      type: "assistant",
      content: "Found the completion path.",
    },
  ]);
  assert.equal(progress.liveEventCount, 9);
  assert.equal(progress.liveEventsTruncated, false);
});
