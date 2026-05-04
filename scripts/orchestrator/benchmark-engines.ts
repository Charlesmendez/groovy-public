import { runOrchestratorRound } from "../../src/lib/orchestrator/runOrchestratorRound";
import { createSupabaseAdminClient } from "../../src/lib/supabase/admin";
import type { ModelMessage } from "ai";

type Engine = "agent_sdk" | "legacy";

type BenchRun = {
  engine: Engine;
  promptIndex: number;
  prompt: string;
  elapsedMs: number;
  kind: "final" | "needs_connector" | "ui_open_code" | "browser_task";
  toolCallsExecuted: number;
  connectorExecutes: number;
  textPreview: string;
  traceId: string;
};

const DEFAULT_PROMPTS = [
  "Hello. Reply in one short sentence.",
  "@schedule list my scheduled jobs and their next run.",
  "@schedule count how many scheduled jobs I currently have.",
];

function parsePromptList(): string[] {
  const fromEnv = process.env.BENCH_PROMPTS_JSON;
  if (!fromEnv) return DEFAULT_PROMPTS;
  try {
    const parsed = JSON.parse(fromEnv);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string" && p.trim())) {
      return parsed;
    }
  } catch {
    // Use defaults if env is invalid JSON.
  }
  return DEFAULT_PROMPTS;
}

function summarizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

async function runOne(engine: Engine, prompt: string, promptIndex: number): Promise<BenchRun> {
  process.env.ORCH_USE_AGENT_SDK = engine === "agent_sdk" ? "1" : "0";

  const supabase = createSupabaseAdminClient();
  const userId = process.env.BENCH_USER_ID;
  if (!userId) {
    throw new Error("Missing BENCH_USER_ID. Set BENCH_USER_ID to the target user UUID.");
  }
  const userEmail = process.env.BENCH_USER_EMAIL || null;
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const traceId = `bench-${engine}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const history: ModelMessage[] = [{ role: "user", content: prompt }];

  const startedAt = Date.now();
  const result = await runOrchestratorRound({
    supabase,
    userId,
    userEmail,
    history,
    message: prompt,
    memoryEnabled: false,
    maxSteps: 6,
    appBaseUrl,
    traceId,
  });
  const elapsedMs = Date.now() - startedAt;

  if (result.kind === "needs_connector") {
    return {
      engine,
      promptIndex,
      prompt,
      elapsedMs,
      kind: result.kind,
      toolCallsExecuted: result.toolCallsExecuted.length,
      connectorExecutes: result.connectorExecutes.length,
      textPreview: summarizeText(result.partialText || ""),
      traceId: result.traceId,
    };
  }

  if (result.kind === "browser_task") {
    return {
      engine,
      promptIndex,
      prompt,
      elapsedMs,
      kind: result.kind,
      toolCallsExecuted: result.toolCallsExecuted.length,
      connectorExecutes: 0,
      textPreview: summarizeText(result.partialText || ""),
      traceId: result.traceId,
    };
  }

  if (result.kind === "ui_open_code") {
    return {
      engine,
      promptIndex,
      prompt,
      elapsedMs,
      kind: result.kind,
      toolCallsExecuted: result.toolCallsExecuted.length,
      connectorExecutes: 0,
      textPreview: summarizeText(result.partialText || ""),
      traceId: result.traceId,
    };
  }

  return {
    engine,
    promptIndex,
    prompt,
    elapsedMs,
    kind: result.kind,
    toolCallsExecuted: result.toolCallsExecuted.length,
    connectorExecutes: 0,
    textPreview: summarizeText(result.text || ""),
    traceId: result.traceId,
  };
}

function summarizeRuns(runs: BenchRun[]) {
  const elapsedValues = runs.map((r) => r.elapsedMs);
  const totalElapsedMs = elapsedValues.reduce((acc, v) => acc + v, 0);
  const avgElapsedMs = runs.length ? Math.round(totalElapsedMs / runs.length) : 0;
  const maxElapsedMs = elapsedValues.length ? Math.max(...elapsedValues) : 0;
  const minElapsedMs = elapsedValues.length ? Math.min(...elapsedValues) : 0;
  const totalToolCalls = runs.reduce((acc, r) => acc + r.toolCallsExecuted, 0);
  const totalConnectorExecutes = runs.reduce((acc, r) => acc + r.connectorExecutes, 0);

  return {
    runs: runs.length,
    avgElapsedMs,
    minElapsedMs,
    maxElapsedMs,
    totalElapsedMs,
    totalToolCalls,
    avgToolCallsPerRun: runs.length ? Number((totalToolCalls / runs.length).toFixed(2)) : 0,
    totalConnectorExecutes,
    kinds: {
      final: runs.filter((r) => r.kind === "final").length,
      needs_connector: runs.filter((r) => r.kind === "needs_connector").length,
      ui_open_code: runs.filter((r) => r.kind === "ui_open_code").length,
      browser_task: runs.filter((r) => r.kind === "browser_task").length,
    },
  };
}

async function main() {
  const prompts = parsePromptList();
  const engines: Engine[] = ["agent_sdk", "legacy"];
  const runs: BenchRun[] = [];

  for (const engine of engines) {
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      const run = await runOne(engine, prompt, i + 1);
      runs.push(run);
      console.log(
        JSON.stringify({
          type: "bench_run",
          engine,
          promptIndex: i + 1,
          elapsedMs: run.elapsedMs,
          kind: run.kind,
          toolCallsExecuted: run.toolCallsExecuted,
          connectorExecutes: run.connectorExecutes,
          traceId: run.traceId,
          textPreview: run.textPreview,
        })
      );
    }
  }

  const byEngine = {
    agent_sdk: summarizeRuns(runs.filter((r) => r.engine === "agent_sdk")),
    legacy: summarizeRuns(runs.filter((r) => r.engine === "legacy")),
  };

  console.log(
    JSON.stringify(
      {
        type: "bench_summary",
        prompts,
        byEngine,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error("[benchmark-engines] failed", err);
  process.exit(1);
});
