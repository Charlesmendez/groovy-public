import assert from "node:assert/strict";
import test from "node:test";
import {
  canManageChannelSchedules,
  channelScheduleSummary,
  formatChannelSchedule,
  parseChannelScheduleAction,
  parseTeamChatChannelId,
  publicChannelSchedule,
} from "./channelSchedules";

test("Team Chat schedule scope accepts only an explicit channel UUID", () => {
  assert.equal(
    parseTeamChatChannelId(
      "team_chat:12345678-1234-4234-8234-123456789012",
    ),
    "12345678-1234-4234-8234-123456789012",
  );
  assert.equal(parseTeamChatChannelId("team_chat:../../scheduled_jobs"), null);
  assert.equal(
    parseTeamChatChannelId(
      "whatsapp:12345678-1234-4234-8234-123456789012",
    ),
    null,
  );
});

test("channel schedule actions are closed to the supported controls", () => {
  assert.equal(parseChannelScheduleAction("pause"), "pause");
  assert.equal(parseChannelScheduleAction("resume"), "resume");
  assert.equal(parseChannelScheduleAction("skip"), "skip");
  assert.equal(parseChannelScheduleAction("delete"), null);
});

test("workspace members manage channel schedules while guests stay view-only", () => {
  assert.equal(
    canManageChannelSchedules({
      workspaceRole: "member",
      channelCreatedBy: "another-user",
      userId: "member-user",
    }),
    true,
  );
  assert.equal(
    canManageChannelSchedules({
      workspaceRole: "guest",
      channelCreatedBy: "another-user",
      userId: "guest-user",
    }),
    false,
  );
  assert.equal(
    canManageChannelSchedules({
      workspaceRole: null,
      channelCreatedBy: "channel-creator",
      userId: "channel-creator",
    }),
    true,
  );
});

test("channel schedule summaries are bounded and shell details stay private", () => {
  assert.equal(
    channelScheduleSummary({
      kind: "orchestrator",
      task: { message: "Send   a daily\nsummary" },
    }),
    "Send a daily summary",
  );
  assert.equal(
    channelScheduleSummary({
      kind: "shell",
      task: { message: "cat ~/.ssh/id_ed25519" },
    }),
    "Local connector task",
  );
  assert.ok(
    channelScheduleSummary({
      kind: "orchestrator",
      task: { message: "x".repeat(500) },
    }).length <= 220,
  );
});

test("public schedule payloads expose cadence fields only", () => {
  assert.deepEqual(
    publicChannelSchedule({
      type: "weekly",
      weekday: 5,
      hour: 16,
      minute: 30,
      command: "cat ~/.ssh/id_ed25519",
      internal_token: "secret",
    }),
    { type: "weekly", weekday: 5, hour: 16, minute: 30 },
  );
  assert.deepEqual(
    publicChannelSchedule({
      type: "daily",
      hour: 99,
      minute: -1,
    }),
    { type: "daily", hour: undefined, minute: undefined },
  );
  assert.deepEqual(
    publicChannelSchedule({
      type: "once",
      run_at: "internal-token",
    }),
    { type: "once" },
  );
});

test("channel cadence labels cover the scheduler's supported shapes", () => {
  assert.match(
    formatChannelSchedule({ type: "daily", hour: 9, minute: 30 }),
    /^Daily · /,
  );
  assert.match(
    formatChannelSchedule({
      type: "weekly",
      weekday: 1,
      hour: 8,
      minute: 0,
    }),
    /^Every Mon · /,
  );
  assert.equal(
    formatChannelSchedule({ type: "interval_minutes", minutes: 15 }),
    "Every 15 minutes",
  );
});
