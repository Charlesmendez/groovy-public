import assert from "node:assert/strict";
import test from "node:test";
import {
  canManageChannelSchedules,
  canManageCurrentChannelSchedules,
  channelScheduleCreateDenialReason,
  channelScheduleManualRunDeviceCandidates,
  channelScheduleSummary,
  formatChannelSchedule,
  parseChannelScheduleAction,
  parseTeamChatChannelId,
  publicChannelSchedule,
  resolveScheduledTaskRunDevice,
  resolveScheduledWorkerRef,
  resolveTeamChatScheduleChannelId,
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

test("scheduled channel scope uses the stored channel and safely falls back to its external thread", () => {
  const channelA = "12345678-1234-4234-8234-123456789012";
  const channelB = "87654321-4321-4321-8321-210987654321";
  assert.deepEqual(
    resolveTeamChatScheduleChannelId({
      storedChannelId: channelA,
      externalThreadKey: channelA,
    }),
    { channelId: channelA, conflict: false },
  );
  assert.deepEqual(
    resolveTeamChatScheduleChannelId({
      storedChannelId: null,
      externalThreadKey: channelA,
    }),
    { channelId: channelA, conflict: false },
  );
  assert.deepEqual(
    resolveTeamChatScheduleChannelId({
      storedChannelId: channelA,
      externalThreadKey: channelB,
    }),
    { channelId: channelA, conflict: true },
  );
  assert.deepEqual(
    resolveTeamChatScheduleChannelId({
      storedChannelId: "../../scheduled_jobs",
      externalThreadKey: "not-a-channel",
    }),
    { channelId: null, conflict: false },
  );
});

test("Team Chat Mind mentions are not silently converted into worker schedules", () => {
  const channelId = "12345678-1234-4234-8234-123456789012";
  assert.equal(
    resolveScheduledWorkerRef({
      requestedAgent: "@groovy",
      teamChatChannelId: channelId,
      currentMindName: "Groovy default",
      currentMindSlug: "groovy-default",
    }),
    null,
  );
  assert.equal(
    resolveScheduledWorkerRef({
      requestedAgent: "Groovy default",
      teamChatChannelId: channelId,
      currentMindName: "Groovy default",
    }),
    null,
  );
  assert.equal(
    resolveScheduledWorkerRef({
      requestedAgent: "Scout",
      teamChatChannelId: channelId,
      currentMindName: "Groovy default",
    }),
    "Scout",
  );
  assert.equal(
    resolveScheduledWorkerRef({
      requestedAgent: "Groovy",
      teamChatChannelId: channelId,
      currentMindName: "Groovy default",
      explicitWorker: true,
    }),
    "Groovy",
  );
  assert.equal(
    resolveScheduledWorkerRef({
      requestedAgent: "Groovy",
      teamChatChannelId: null,
      currentMindName: "Groovy default",
    }),
    "Groovy",
  );
});

test("channel schedule actions are closed to the supported controls", () => {
  assert.equal(parseChannelScheduleAction("pause"), "pause");
  assert.equal(parseChannelScheduleAction("resume"), "resume");
  assert.equal(parseChannelScheduleAction("skip"), "skip");
  assert.equal(parseChannelScheduleAction("delete"), null);
});

test("workspace members manage channel schedules while guests and stale creators stay view-only", () => {
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
    false,
  );
});

test("Team Chat cannot create direct shell schedules on the owner's connector", () => {
  assert.match(
    channelScheduleCreateDenialReason({
      channelId: "5d959469-a9d8-4f0f-a93f-31df3baf8f8a",
      kind: "shell",
    }) || "",
    /direct shell schedules are not allowed/i,
  );
  assert.equal(
    channelScheduleCreateDenialReason({
      channelId: "5d959469-a9d8-4f0f-a93f-31df3baf8f8a",
      kind: "orchestrator",
    }),
    null,
  );
  assert.equal(
    channelScheduleCreateDenialReason({ channelId: null, kind: "shell" }),
    null,
  );
});

test("private-channel scheduling authority is revoked with channel access", () => {
  assert.equal(
    canManageCurrentChannelSchedules({
      workspaceRole: "member",
      visibility: "private",
      isChannelMember: false,
      isArchived: false,
    }),
    false,
  );
  assert.equal(
    canManageCurrentChannelSchedules({
      workspaceRole: "member",
      visibility: "private",
      isChannelMember: true,
      isArchived: false,
    }),
    true,
  );
  assert.equal(
    canManageCurrentChannelSchedules({
      workspaceRole: "guest",
      visibility: "private",
      isChannelMember: true,
      isArchived: false,
    }),
    false,
  );
  assert.equal(
    canManageCurrentChannelSchedules({
      workspaceRole: "admin",
      visibility: "private",
      isChannelMember: false,
      isArchived: true,
    }),
    false,
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

test("manual runs prefer the assigned connector when it is online", () => {
  assert.equal(
    resolveScheduledTaskRunDevice({
      assignedDeviceId: "assigned",
      activeDeviceId: "active",
      onlineDeviceIds: ["active", "assigned"],
    }),
    "assigned",
  );
});

test("manual runs fall back to the active online connector", () => {
  assert.equal(
    resolveScheduledTaskRunDevice({
      assignedDeviceId: "stale",
      activeDeviceId: "active",
      onlineDeviceIds: ["active"],
    }),
    "active",
  );
  assert.equal(
    resolveScheduledTaskRunDevice({
      assignedDeviceId: "stale",
      activeDeviceId: "offline",
      onlineDeviceIds: ["only-online"],
    }),
    "only-online",
  );
});

test("manual runs require at least one online connector", () => {
  assert.equal(
    resolveScheduledTaskRunDevice({
      assignedDeviceId: "stale",
      activeDeviceId: null,
      onlineDeviceIds: [],
    }),
    null,
  );
});

test("server manual runs try the assigned device before other owned connectors", () => {
  assert.deepEqual(
    channelScheduleManualRunDeviceCandidates({
      assignedDeviceId: "assigned",
      ownedDeviceIds: ["newest", "assigned", "older"],
      canMoveToAnotherDevice: true,
    }),
    ["assigned", "newest", "older"],
  );
});

test("machine-local manual runs stay pinned to their assigned connector", () => {
  assert.deepEqual(
    channelScheduleManualRunDeviceCandidates({
      assignedDeviceId: "assigned",
      ownedDeviceIds: ["newest"],
      canMoveToAnotherDevice: false,
    }),
    ["assigned"],
  );
});
