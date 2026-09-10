import assert from "node:assert/strict";
import test from "node:test";
import {
  appendOrchestratorProgressEvent,
  orchestratorToolLabel,
  publicOrchestratorProgress,
} from "./orchestratorProgress";

test("records safe tool lifecycle progress and deduplicates open starts", () => {
  const empty = publicOrchestratorProgress(null);
  const started = appendOrchestratorProgressEvent(
    empty,
    { phase: "start", toolName: "run_skill_action", agent: "Hibe support" },
    "2026-08-13T17:00:00.000Z",
  );
  const duplicate = appendOrchestratorProgressEvent(
    started,
    { phase: "start", toolName: "run_skill_action" },
    "2026-08-13T17:00:01.000Z",
  );
  assert.equal(duplicate, started);
  const finished = appendOrchestratorProgressEvent(
    duplicate,
    { phase: "end", toolName: "run_skill_action", success: true },
    "2026-08-13T17:00:02.000Z",
  );

  assert.equal(finished.events.length, 1);
  assert.equal(finished.events[0]?.status, "completed");
  assert.equal(finished.events[0]?.finishedAt, "2026-08-13T17:00:02.000Z");
  assert.equal(orchestratorToolLabel("run_skill_action"), "Run skill action");
});

test("public progress rejects arbitrary fields and bounds its history", () => {
  const progress = publicOrchestratorProgress({
    secret: "must-not-leak",
    events: Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      toolName: `tool_${index + 1}`,
      status: "completed",
      input: "sensitive arguments",
    })),
  });

  assert.equal(progress.events.length, 12);
  assert.equal(progress.events[0]?.toolName, "tool_9");
  assert.equal("input" in progress.events[0]!, false);
  assert.equal("secret" in progress, false);
});
