import assert from "node:assert/strict";
import test from "node:test";
import {
  cloudScheduledJobEligibility,
  isCloudScheduleDue,
  type CloudScheduledJob,
} from "./cloud";

const BASE_JOB: CloudScheduledJob = {
  id: "job",
  user_id: "user",
  device_id: "device",
  kind: "orchestrator",
  enabled: true,
  task: { message: "Summarize today's public market news", options: {} },
};

test("daily schedules are evaluated in their configured timezone", () => {
  const job = {
    ...BASE_JOB,
    schedule: { type: "daily", hour: 8, minute: 30, timezone: "America/Bogota" },
  };
  assert.equal(
    isCloudScheduleDue(job, new Date("2026-07-23T13:31:00.000Z")).due,
    true
  );
});
test("a daily schedule only runs once per local date", () => {
  const job = {
    ...BASE_JOB,
    schedule: { type: "daily", hour: 8, minute: 30, timezone: "America/Bogota" },
    last_run_at: "2026-07-23T13:30:00.000Z",
  };
  assert.equal(
    isCloudScheduleDue(job, new Date("2026-07-23T15:00:00.000Z")).due,
    false
  );
});

test("connector-dependent jobs are rejected from cloud execution", () => {
  assert.equal(
    cloudScheduledJobEligibility({
      ...BASE_JOB,
      task: { message: "Open the browser and send this on WhatsApp" },
    }).eligible,
    false
  );
});
