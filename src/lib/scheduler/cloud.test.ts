import assert from "node:assert/strict";
import test from "node:test";
import {
  cloudScheduledJobEligibility,
  initialIntervalScheduleAnchor,
  isCloudScheduleDue,
  isSafeCloudScheduleRetry,
  normalizeScheduleTimezone,
  withScheduleTimezone,
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

test("connector-local wall-clock schedules never silently fall back to UTC", () => {
  const job = {
    ...BASE_JOB,
    schedule: { type: "daily", hour: 8, minute: 0 },
  };
  assert.deepEqual(
    isCloudScheduleDue(job, new Date("2026-07-31T08:01:00.000Z")),
    { due: false, timezone: "UTC", reason: "timezone_required" },
  );
});

test("an early failed attempt does not consume the real local occurrence", () => {
  const job = {
    ...BASE_JOB,
    schedule: {
      type: "daily",
      hour: 8,
      minute: 0,
      timezone: "America/Chicago",
    },
    // 3:00 AM in Chicago: the legacy UTC fallback used to reserve the day here.
    last_run_at: "2026-07-31T08:00:00.000Z",
  };
  assert.equal(
    isCloudScheduleDue(job, new Date("2026-07-31T13:01:00.000Z")).due,
    true,
  );
});

test("connector timezone is attached to local daily and weekly schedules", () => {
  assert.deepEqual(
    withScheduleTimezone(
      { type: "daily", hour: 8, minute: 0 },
      "America/Chicago",
    ),
    {
      schedule: {
        type: "daily",
        hour: 8,
        minute: 0,
        timezone: "America/Chicago",
      },
      changed: true,
    },
  );
  assert.deepEqual(
    withScheduleTimezone(
      { type: "weekly", weekday: 1, hour: 9, minute: 30 },
      "America/Chicago",
    ).schedule,
    {
      type: "weekly",
      weekday: 1,
      hour: 9,
      minute: 30,
      timezone: "America/Chicago",
    },
  );
  assert.equal(normalizeScheduleTimezone("not/a-timezone"), null);
});

test("new interval schedules count from creation instead of running immediately", () => {
  const createdAt = new Date("2026-08-13T20:11:00.000Z");
  assert.equal(
    initialIntervalScheduleAnchor(
      { type: "interval_minutes", minutes: 60 },
      createdAt,
    ),
    createdAt.toISOString(),
  );
  assert.equal(
    initialIntervalScheduleAnchor(
      { type: "daily", hour: 8, minute: 0 },
      createdAt,
    ),
    null,
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

test("cloud retries only failures that occur before scheduled work starts", () => {
  assert.equal(isSafeCloudScheduleRetry("Unauthorized"), true);
  assert.equal(isSafeCloudScheduleRetry("scheduler_dispatch_http_401"), true);
  assert.equal(isSafeCloudScheduleRetry("scheduled_channel_busy"), true);
  assert.equal(
    isSafeCloudScheduleRetry("scheduled_channel_resolution_failed"),
    true,
  );
  assert.equal(isSafeCloudScheduleRetry("scheduled_channel_publish_failed"), false);
  assert.equal(
    isSafeCloudScheduleRetry("scheduled_orchestrator_incomplete_final"),
    false,
  );
});
