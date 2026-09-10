import assert from "node:assert/strict";
import test from "node:test";
import { scheduledJobManualRunDeviceDecision } from "./scheduledJobManualRun.mjs";

test("keeps a manual run on its assigned connector when it is online", () => {
  assert.deepEqual(
    scheduledJobManualRunDeviceDecision(
      { device_id: "assigned", kind: "orchestrator", target_agent_id: null },
      "assigned",
    ),
    { ok: true, rebind: false },
  );
});

test("allows ordinary orchestrator jobs to move to the selected online connector", () => {
  assert.deepEqual(
    scheduledJobManualRunDeviceDecision(
      { device_id: "stale", kind: "orchestrator", target_agent_id: null },
      "online",
    ),
    { ok: true, rebind: true },
  );
});

test("does not move machine-local or worker-targeted jobs", () => {
  assert.equal(
    scheduledJobManualRunDeviceDecision(
      { device_id: "stale", kind: "shell", target_agent_id: null },
      "online",
    ).error,
    "scheduled_job_requires_assigned_connector",
  );
  assert.equal(
    scheduledJobManualRunDeviceDecision(
      {
        device_id: "stale",
        kind: "orchestrator",
        target_agent_id: "worker",
      },
      "online",
    ).error,
    "scheduled_job_requires_assigned_connector",
  );
});
