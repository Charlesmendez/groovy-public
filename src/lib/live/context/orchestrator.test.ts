import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestratorRoundResult } from "@/lib/orchestrator/runOrchestratorRound";
import { formatOrchestratorResult } from "./orchestrator";

const finalResult: OrchestratorRoundResult = {
  kind: "final",
  traceId: "trace-1",
  text: "You have two unread messages.",
  toolOutputText: '{"private":"raw tool payload"}',
  toolCallsExecuted: ["email_search"],
};

test("speech-oriented orchestration excludes raw tool output", () => {
  const speakable = formatOrchestratorResult(finalResult, false);
  assert.equal(speakable, "You have two unread messages.");
  assert.doesNotMatch(speakable, /Tool output:/i);
  assert.doesNotMatch(speakable, /raw tool payload/i);
});

test("non-voice callers retain the legacy tool-output formatting by default", () => {
  assert.match(formatOrchestratorResult(finalResult), /Tool output:/i);
});
