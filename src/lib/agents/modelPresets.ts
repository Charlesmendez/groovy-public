import type { WorkerHarness } from "./types";

export const WORKER_MODEL_PRESETS: Record<WorkerHarness, string[]> = {
  claude: [
    "claude-fable-5",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ],
  codex: ["gpt-5.6-sol", "gpt-5.5", "gpt-5.5-codex", "gpt-4o"],
};
