import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("normal local worker tasks default to full local CLI permissions", () => {
  const executableTools = fs.readFileSync(
    path.join(repoRoot, "src/lib/orchestrator/executableTools.ts"),
    "utf8",
  );
  const orchestratorPrompt = fs.readFileSync(
    path.join(repoRoot, "src/lib/orchestrator/runOrchestratorRound.ts"),
    "utf8",
  );

  assert.match(executableTools, /Use read_write for normal local worker tasks/);
  assert.match(executableTools, /Use read_write by default/);
  assert.match(executableTools, /existing Vercel CLI login/);
  assert.match(executableTools, /do not guess, inject, or hard-code/i);

  assert.match(
    orchestratorPrompt,
    /Default to \\`read_write\\` so the user's local Codex\/Claude CLI has its normal machine filesystem, terminal, and network permissions/,
  );
  assert.match(
    orchestratorPrompt,
    /Never invent, inject, or hard-code a Vercel project\/team\/scope\/id/,
  );
  assert.match(
    orchestratorPrompt,
    /you MUST use \\`terminal_exec\\` yourself and MUST NOT call \\`assign_task\\` merely to run those commands/,
  );
  assert.match(orchestratorPrompt, /delete executableTools\.assign_task/);
  assert.match(
    orchestratorPrompt,
    /a project name is not a worker assignment/,
  );
  assert.match(
    orchestratorPrompt,
    /Do not give up after the first failed command/,
  );
  assert.match(
    executableTools,
    /do not delegate a separate worker merely to run a few diagnostic commands/,
  );
  assert.match(
    orchestratorPrompt,
    /If the user names a project that matches a worker, infer that worker's workspace even when the user does not @mention the worker/,
  );
  assert.match(
    executableTools,
    /you MUST NOT use assign_task merely for a short diagnostic that only needs a few local CLI commands/,
  );
  assert.doesNotMatch(
    executableTools,
    /Use this whenever work should happen in a workspace/,
  );
});
