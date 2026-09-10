import assert from "node:assert/strict";
import test from "node:test";
import {
  relayExecutableScheduledJobs,
  scheduledJobRelayExecutionDenialReason,
} from "./scheduledJobSafety.mjs";

test("relay never sends channel shell schedules to a connector", () => {
  const personalShell = { id: "personal", kind: "shell", channel_id: null };
  const channelMind = {
    id: "mind",
    kind: "orchestrator",
    channel_id: "channel",
  };
  const channelShell = {
    id: "unsafe",
    kind: "shell",
    channel_id: "channel",
  };

  assert.equal(
    scheduledJobRelayExecutionDenialReason(channelShell),
    "channel_shell_schedule_forbidden",
  );
  assert.deepEqual(
    relayExecutableScheduledJobs([personalShell, channelMind, channelShell]),
    [personalShell, channelMind],
  );
});

test("legacy channel jobs without an explicit orchestrator kind fail closed", () => {
  assert.equal(
    scheduledJobRelayExecutionDenialReason({
      id: "legacy",
      kind: null,
      channel_id: "channel",
    }),
    "channel_shell_schedule_forbidden",
  );
});
