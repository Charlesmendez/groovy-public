import type { ModelMessage } from "ai";
import type {
  ConnectorExecute,
  OrchestratorRoundResult,
} from "@/lib/orchestrator/runOrchestratorRound";

export type TeamChatConnectorToolResult = {
  toolCallId: string;
  toolName: string;
  result: string;
};

const MAX_TOOL_RESULT_CHARS = 20_000;

function escapeToolAttribute(value: string): string {
  return String(value || "").replace(/["&<>]/g, (char) => {
    if (char === '"') return "&quot;";
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    return "&gt;";
  });
}

export function teamChatConnectorResultsMessage(
  toolResults: TeamChatConnectorToolResult[],
): ModelMessage {
  const content = toolResults
    .map((toolResult) => {
      let resultText = toolResult.result;
      try {
        resultText = JSON.stringify(JSON.parse(toolResult.result), null, 2);
      } catch {
        // Preserve non-JSON connector output.
      }
      if (resultText.length > MAX_TOOL_RESULT_CHARS) {
        resultText = `${resultText.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
      }
      return `<tool_result name="${escapeToolAttribute(toolResult.toolName)}" tool_call_id="${escapeToolAttribute(toolResult.toolCallId)}">\n${resultText}\n</tool_result>`;
    })
    .join("\n\n");

  return {
    role: "user",
    content: `[SYSTEM: Tool execution results from the local connector]\n\n${content}`,
  };
}

function requestedConnectorTimeoutMs(execute: ConnectorExecute): number {
  const params = execute.connectorParams || {};
  if (execute.connectorType === "terminal_exec") {
    const requested = Number(params.timeout_ms);
    return Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(30_000, requested + 10_000), 10 * 60 * 1000)
      : 3 * 60 * 1000;
  }
  if (execute.connectorType === "terminal_step") {
    const requested = Number(params.max_wait_ms);
    return Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(30_000, requested + 10_000), 10 * 60 * 1000)
      : 3 * 60 * 1000;
  }
  if (execute.connectorType === "claude_run") {
    const requested = Number(params.timeout_ms);
    return Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(30_000, requested + 10_000), 10 * 60 * 1000)
      : 5 * 60 * 1000;
  }
  if (execute.connectorType === "browser_task_run") return 5 * 60 * 1000;
  if (
    execute.connectorType.startsWith("browser_") ||
    execute.connectorType.startsWith("file_") ||
    execute.connectorType.startsWith("obsidian_")
  ) {
    return 2 * 60 * 1000;
  }
  return 60_000;
}

export async function completeTeamChatConnectorRoundTrips(args: {
  initialResult: OrchestratorRoundResult;
  initialHistory: ModelMessage[];
  deadlineAtMs: number;
  maxRounds?: number;
  now?: () => number;
  execute: (
    execute: ConnectorExecute,
    timeoutMs: number,
  ) => Promise<Record<string, unknown>>;
  continueRound: (args: {
    history: ModelMessage[];
    toolResults: TeamChatConnectorToolResult[];
    traceId: string;
  }) => Promise<OrchestratorRoundResult>;
}): Promise<OrchestratorRoundResult> {
  const maxRounds = Math.max(1, Math.min(args.maxRounds ?? 8, 12));
  const now = args.now ?? Date.now;
  let result = args.initialResult;
  let history = args.initialHistory;

  for (let round = 0; result.kind === "needs_connector"; round += 1) {
    if (round >= maxRounds) {
      throw new Error(
        `The local connector exceeded ${maxRounds} consecutive tool rounds.`,
      );
    }

    const toolResults: TeamChatConnectorToolResult[] = [];
    for (const execute of result.connectorExecutes) {
      const remainingMs = args.deadlineAtMs - now();
      if (remainingMs <= 5_000) {
        throw new Error(
          "The Team Chat turn ran out of time while waiting for local tools.",
        );
      }

      let rpcResult: Record<string, unknown>;
      try {
        rpcResult = await args.execute(
          execute,
          Math.max(
            1_000,
            Math.min(requestedConnectorTimeoutMs(execute), remainingMs - 5_000),
          ),
        );
      } catch (error) {
        rpcResult = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      toolResults.push({
        toolCallId: execute.toolCallId,
        toolName: execute.toolName,
        result: JSON.stringify(rpcResult),
      });
    }

    history = [...history, teamChatConnectorResultsMessage(toolResults)];
    result = await args.continueRound({
      history,
      toolResults,
      traceId: result.traceId,
    });
  }

  return result;
}
