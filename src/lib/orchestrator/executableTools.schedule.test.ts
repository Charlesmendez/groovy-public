import assert from "node:assert/strict";
import test from "node:test";
import {
  scheduleUpdateSchema,
  toolDefinitions,
} from "./executableTools";

test("schedule_update requires a job id and complete non-empty prompt", () => {
  assert.deepEqual(
    scheduleUpdateSchema.parse({
      job_id: "05fab069-3dcc-407d-9d1e-047cab329c66",
      task: "Keep extracting every account and calculate realized ROI from actual cost.",
    }),
    {
      job_id: "05fab069-3dcc-407d-9d1e-047cab329c66",
      task: "Keep extracting every account and calculate realized ROI from actual cost.",
    },
  );
  assert.equal(
    scheduleUpdateSchema.safeParse({ job_id: "job-1", task: "   " }).success,
    false,
  );
});

test("schedule tools direct the orchestrator to discover before updating", () => {
  assert.match(toolDefinitions.schedule_list.description, /before asking/i);
  assert.match(toolDefinitions.schedule_update.description, /schedule_list first/i);
});
