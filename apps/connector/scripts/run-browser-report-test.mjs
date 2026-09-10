#!/usr/bin/env node

import { runBrowserTaskViaPlaywright } from "../browserTask.mjs";

function readArg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

const task = readArg("task").trim();
const startUrl = readArg("start-url").trim();
const provider = readArg("provider").trim() || "codex";
const model = readArg("model").trim() || "gpt-5.6-luna";
const reasoningEffort = readArg("reasoning-effort").trim() || "medium";
const playwrightDriver = readArg("driver").trim() || "cli";
const profileName = readArg("profile").trim() || "report-test";
const timeoutRaw = Number(readArg("timeout-ms"));
const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
  ? timeoutRaw
  : 12 * 60 * 1000;

if (!task) {
  console.error("Missing required --task argument");
  process.exit(2);
}

const startedAt = Date.now();
const result = await runBrowserTaskViaPlaywright({
  task,
  start_url: startUrl || undefined,
  provider,
  model,
  reasoning_effort: reasoningEffort,
  playwright_driver: playwrightDriver,
  profile_name: profileName,
  timeout_ms: timeoutMs,
  report_only: true,
  ephemeral: true,
  onProgress: (message) => console.error(`[browser-report] ${message}`),
});

console.log(
  JSON.stringify(
    {
      ...result,
      report_only: true,
      database_recorded: false,
      duration_ms: Date.now() - startedAt,
    },
    null,
    2
  )
);

if (result?.ok !== true) process.exitCode = 1;
