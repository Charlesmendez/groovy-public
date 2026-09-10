import { strict as assert } from "node:assert";
import test from "node:test";
import type { OrchestratorRoundResult } from "@/lib/orchestrator/runOrchestratorRound";
import {
  completeTeamChatConnectorRoundTrips,
  teamChatConnectorResultsMessage,
} from "./teamChatConnectorRoundTrip";

function pendingRound(traceId = "trace-1"): OrchestratorRoundResult {
  return {
    kind: "needs_connector",
    traceId,
    partialText: "",
    toolCallsExecuted: ["terminal_exec"],
    connectorExecutes: [
      {
        toolCallId: "call-1",
        toolName: "terminal_exec",
        agent: "terminal",
        connectorType: "terminal_exec",
        connectorParams: {
          command: "vercel inspect",
          timeout_ms: 20_000,
        },
      },
    ],
  };
}

test("Team Chat executes local connector work and continues the same Mind turn", async () => {
  let continuationHistory = "";
  const final = await completeTeamChatConnectorRoundTrips({
    initialResult: pendingRound(),
    initialHistory: [{ role: "user", content: "check the Vercel logs" }],
    deadlineAtMs: 100_000,
    now: () => 0,
    execute: async (execute, timeoutMs) => {
      assert.equal(execute.connectorType, "terminal_exec");
      assert.equal(timeoutMs, 30_000);
      return { ok: true, stdout: "decisive Vercel log" };
    },
    continueRound: async ({ history, toolResults, traceId }) => {
      continuationHistory = String(history.at(-1)?.content || "");
      assert.equal(traceId, "trace-1");
      assert.equal(toolResults[0]?.toolName, "terminal_exec");
      return {
        kind: "final",
        traceId,
        text: "The deployment package was invalid.",
        toolCallsExecuted: ["terminal_exec"],
      };
    },
  });

  assert.equal(final.kind, "final");
  assert.match(continuationHistory, /decisive Vercel log/);
});

test("connector failures return to the Mind so it can diagnose or retry", async () => {
  let returnedError = "";
  const final = await completeTeamChatConnectorRoundTrips({
    initialResult: pendingRound(),
    initialHistory: [],
    deadlineAtMs: 100_000,
    now: () => 0,
    execute: async () => {
      throw new Error("device_not_online");
    },
    continueRound: async ({ toolResults }) => {
      returnedError = toolResults[0]?.result || "";
      return {
        kind: "final",
        traceId: "trace-1",
        text: "The connector is offline.",
        toolCallsExecuted: ["terminal_exec"],
      };
    },
  });

  assert.equal(final.kind, "final");
  assert.match(returnedError, /device_not_online/);
});

test("connector result messages escape attributes and bound local output", () => {
  const message = teamChatConnectorResultsMessage([
    {
      toolCallId: 'call"<1',
      toolName: "terminal_exec",
      result: "x".repeat(25_000),
    },
  ]);
  const content = String(message.content);
  assert.match(content, /call&quot;&lt;1/);
  assert.match(content, /\.\.\.\[truncated\]/);
  assert.ok(content.length < 21_000);
});

test("connector round trips stop at the configured bound", async () => {
  await assert.rejects(
    completeTeamChatConnectorRoundTrips({
      initialResult: pendingRound("trace-0"),
      initialHistory: [],
      deadlineAtMs: 100_000,
      now: () => 0,
      maxRounds: 2,
      execute: async () => ({ ok: true }),
      continueRound: async ({ traceId }) => pendingRound(`${traceId}-next`),
    }),
    /exceeded 2 consecutive tool rounds/,
  );
});
