import { execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { isWindows } from "../detect.mjs";
import { killProcessTree } from "../process/index.mjs";
import { prepareSpawnEnv } from "../shell/index.mjs";

const DEFAULT_CODE_AGENT_TIMEOUT_MS = 20 * 60 * 1000;

function quoteWindowsArg(arg) {
  const s = String(arg ?? "");
  if (!s) return '""';
  if (!/[ \t"]/u.test(s)) return s;

  let out = '"';
  let backslashes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    out += `${"\\".repeat(backslashes)}${ch}`;
    backslashes = 0;
  }
  out += `${"\\".repeat(backslashes * 2)}"`;
  return out;
}

function normalizeCwd(cwd) {
  const value = String(cwd || "").trim();
  if (!value) return process.cwd();
  return path.resolve(value);
}

export function resolveCodexBin() {
  const override = (
    process.env.GROOVY_CODEX_BIN ||
    process.env.CODEX_BIN ||
    ""
  ).trim();
  const candidates = [
    override || null,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "codex", "codex.exe")
      : null,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
    path.join(os.homedir(), ".local", "bin", "codex"),
    path.join(os.homedir(), "bin", "codex"),
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      fs.accessSync(bin, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return String(bin);
    } catch {
      // try next
    }
  }
  return "codex";
}

function addCodexExecutionMode(args, options = {}) {
  if (options.planMode === true) {
    // Real OS-level read-only sandbox. Use the -c form because
    // `codex exec resume` doesn't expose -s/--sandbox; -c is accepted by
    // both `codex exec` and `codex exec resume`.
    args.push("-c", 'sandbox_mode="read-only"');
    return;
  }

  // Groovy's code agent already runs inside the user's local connector. Use
  // the real local execution surface so git metadata writes and pushes work.
  args.push("--dangerously-bypass-approvals-and-sandbox");
}

function addCodexReasoningEffort(args, options = {}) {
  const effort = String(options.reasoningEffort || "").trim();
  if (!effort) return;
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new Error("invalid_reasoning_effort");
  }
  args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
}

// Track the previous turn's plan-mode state per Codex session so we can cue
// the model when the user toggles plan mode off mid-conversation. Without
// this hint, the planning instruction prepended on the prior turn lingers in
// session history and can keep the model in a "I'm just planning" posture.
const codexPlanModeBySession = new Map();
const CODEX_PLAN_MODE_MAX_ENTRIES = 256;

function getLastCodexPlanMode(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  return codexPlanModeBySession.has(id) ? codexPlanModeBySession.get(id) : null;
}

function recordCodexPlanMode(threadId, planMode) {
  const id = String(threadId || "").trim();
  if (!id) return;
  // Move-to-end for LRU-ish eviction.
  codexPlanModeBySession.delete(id);
  codexPlanModeBySession.set(id, planMode === true);
  if (codexPlanModeBySession.size > CODEX_PLAN_MODE_MAX_ENTRIES) {
    const firstKey = codexPlanModeBySession.keys().next().value;
    if (firstKey !== undefined) codexPlanModeBySession.delete(firstKey);
  }
}

function buildCodexArgs(options) {
  if (options.sessionId) {
    // Resume existing session: codex exec resume SESSION_ID "prompt".
    // NOTE: `exec resume` does not accept `--cd`; the child's cwd is set via
    // the spawn() options. Resume also filters by cwd by default, so the
    // spawn cwd must match the original session's workspace.
    const args = ["exec", "resume", String(options.sessionId)];
    if (options.model) args.push("-m", String(options.model));
    addCodexReasoningEffort(args, options);
    addCodexExecutionMode(args, options);
    args.push("--json");
    args.push("--skip-git-repo-check");
    if (options.prompt) args.push(String(options.prompt));
    return args;
  }

  const args = ["exec"];
  if (options.model) args.push("-m", String(options.model));
  addCodexReasoningEffort(args, options);
  if (options.cwd) args.push("--cd", String(options.cwd));
  addCodexExecutionMode(args, options);
  args.push("--json");
  args.push("--skip-git-repo-check");
  if (options.prompt) args.push(String(options.prompt));
  return args;
}

function buildCodexPrompt(options) {
  const prompt = String(options.prompt || "");
  if (options.planMode === true) {
    return [
      "You are in Groovy Codex plan mode.",
      "Create a concrete implementation plan for the user's request before making changes.",
      "Call the update_plan tool so the plan is recorded in the Codex session history.",
      "Do not edit files, run write commands, install packages, or commit changes in this turn.",
      "You may inspect the repository with read-only commands if needed.",
      "End after presenting the plan and any brief open questions.",
      "",
      "User request:",
      prompt,
    ].join("\n");
  }
  // Cue the model when transitioning out of plan mode so the prior planning
  // instruction in session history doesn't keep it in a read-only posture.
  if (getLastCodexPlanMode(options.sessionId) === true) {
    return [
      "Plan mode is now off — you may make changes.",
      "",
      prompt,
    ].join("\n");
  }
  return prompt;
}

function parseCodexSlashPrompt(prompt) {
  const match = String(prompt || "").trim().match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const aliases = new Map([
    ["approvals", "permissions"],
    ["clean", "stop"],
    ["quit", "exit"],
  ]);
  const rawName = match[1].toLowerCase();
  const name = aliases.get(rawName) || rawName;
  return {
    command: `/${name}`,
    name,
    args: String(match[2] || "").trim(),
  };
}

function splitCommandArgs(input) {
  const args = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (const ch of String(input || "")) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("unterminated_quote");
  if (current) args.push(current);
  return args;
}

function truncateCommandOutput(text, maxLen = 80_000) {
  const value = String(text || "");
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}\n\n[output truncated: ${value.length - maxLen} more characters]`;
}

function syntheticCodexRunResult({
  text,
  code = 0,
  stderr = "",
  error = false,
  sessionId = "",
}) {
  const resultText = String(text || "").trim();
  const events = [];
  if (resultText) {
    events.push({
      type: "assistant",
      message: {
        content: [{ type: "text", text: resultText }],
      },
    });
  }
  if (error) {
    events.push({
      type: "turn.failed",
      message: resultText || String(stderr || "").trim() || "codex_slash_command_failed",
    });
  }
  events.push({
    type: "result",
    result: resultText,
    ...(sessionId ? { session_id: sessionId } : {}),
  });

  return {
    code: Number.isFinite(Number(code)) ? Number(code) : error ? 1 : 0,
    signal: null,
    stdout: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    stderr: String(stderr || ""),
    streamEvents: events,
    timedOut: false,
    timeoutError: null,
    aborted: false,
    codexThreadId: normalizeCodexThreadId(sessionId),
  };
}

function formatRawCommandResult({ label, stdout, stderr, exitCode }) {
  const sections = [`$ ${label}`];
  const out = truncateCommandOutput(String(stdout || "").trim());
  const err = truncateCommandOutput(String(stderr || "").trim());
  if (out) sections.push("```text\n" + out + "\n```");
  if (err) sections.push("stderr:\n```text\n" + err + "\n```");
  if (!out && !err) sections.push(`Command completed with exit code ${exitCode}.`);
  return sections.join("\n\n");
}

function buildReviewArgs(options, slashArgs) {
  const args = ["exec", "review"];
  if (options.model) args.push("-m", String(options.model));
  addCodexExecutionMode(args, { ...options, planMode: false });
  args.push("--json");
  args.push("--skip-git-repo-check");

  const tokens = splitCommandArgs(slashArgs);
  const instructions = [];
  let hasExplicitScope = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--help" || token === "-h") {
      args.push(token);
      hasExplicitScope = true;
      continue;
    }
    if (token === "--uncommitted") {
      args.push(token);
      hasExplicitScope = true;
      continue;
    }
    if (token.startsWith("--base=") || token.startsWith("--commit=")) {
      args.push(token);
      hasExplicitScope = true;
      continue;
    }
    if (token.startsWith("--title=")) {
      args.push(token);
      continue;
    }
    if (token === "--base" || token === "--commit" || token === "--title") {
      const value = tokens[i + 1];
      if (value) {
        args.push(token, value);
        hasExplicitScope = hasExplicitScope || token === "--base" || token === "--commit";
        i += 1;
        continue;
      }
    }
    instructions.push(token);
  }

  if (!hasExplicitScope) args.push("--uncommitted");
  if (instructions.length > 0) args.push(instructions.join(" "));
  return args;
}

function normalizeGitPathspecs(rawArgs) {
  const tokens = splitCommandArgs(rawArgs);
  return tokens.filter((token) => token && token !== "--");
}

function splitUnifiedDiffs(diffText) {
  const chunks = [];
  let current = [];
  for (const line of String(diffText || "").split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      const chunk = current.join("\n").trim();
      if (chunk) chunks.push(chunk);
      current = [line];
    } else {
      current.push(line);
    }
  }
  const finalChunk = current.join("\n").trim();
  if (finalChunk) chunks.push(finalChunk);
  return chunks;
}

function buildUntrackedFileDiff(cwd, relPath) {
  try {
    const normalized = String(relPath || "").replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("../") || normalized === "..") return "";
    const absPath = path.resolve(cwd, normalized);
    const root = path.resolve(cwd);
    const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (absPath !== root && !absPath.startsWith(rootWithSep)) return "";
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return "";
    const content = fs.readFileSync(absPath, "utf8");
    if (content.includes("\u0000")) return "";
    const lines = content.endsWith("\n")
      ? content.slice(0, -1).split("\n")
      : content.split("\n");
    if (lines.length === 1 && lines[0] === "") {
      return `diff --git a/${normalized} b/${normalized}\nnew file mode 100644\n--- /dev/null\n+++ b/${normalized}\n@@ -0,0 +0,0 @@`;
    }
    const body = lines.map((line) => `+${line}`).join("\n");
    return [
      `diff --git a/${normalized} b/${normalized}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${normalized}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
    ].join("\n");
  } catch {
    return "";
  }
}

function gitOutput(cwd, args, timeoutMs = 5000) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 12 * 1024 * 1024,
  });
}

function runCodexDiffSlash(cwd, rawArgs) {
  try {
    const pathspecs = normalizeGitPathspecs(rawArgs);
    const pathArgs = pathspecs.length > 0 ? ["--", ...pathspecs] : [];

    gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"], 3000).trim();

    const status = gitOutput(cwd, ["status", "--short", "--untracked-files=all", ...pathArgs]);
    const worktreeDiff = gitOutput(cwd, ["diff", "--no-ext-diff", ...pathArgs]);
    const stagedDiff = gitOutput(cwd, ["diff", "--cached", "--no-ext-diff", ...pathArgs]);
    const untrackedText = gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", ...pathArgs]);
    const untrackedDiffs = untrackedText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((relPath) => buildUntrackedFileDiff(cwd, relPath))
      .filter(Boolean);

    const diffBlocks = [
      ...splitUnifiedDiffs(worktreeDiff),
      ...splitUnifiedDiffs(stagedDiff),
      ...untrackedDiffs,
    ];

    const parts = [`Git diff for ${cwd}`];
    parts.push("Status:\n```text\n" + (status.trim() || "clean") + "\n```");
    if (diffBlocks.length > 0) {
      for (const block of diffBlocks) {
        parts.push("```diff\n" + block + "\n```");
      }
    } else {
      parts.push("No staged, unstaged, or untracked file diffs found.");
    }

    return syntheticCodexRunResult({ text: parts.join("\n\n") });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err || "git_diff_failed");
    return syntheticCodexRunResult({
      text: `\`/diff\` failed in ${cwd}: ${detail}`,
      code: 1,
      error: true,
    });
  }
}

async function runRawCodexSlashCommand({
  codexBin,
  args,
  cwd,
  env,
  timeoutMs,
  abortSignal,
  label,
  sessionId,
}) {
  const result = await spawnOnce({
    command: codexBin,
    args,
    cwd,
    env,
    timeoutMs,
    abortSignal,
  });
  const exitCode = Number.isFinite(Number(result.code)) ? Number(result.code) : 0;
  const text = formatRawCommandResult({
    label,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode,
  });
  return syntheticCodexRunResult({
    text,
    code: exitCode,
    stderr: result.stderr,
    error: exitCode !== 0,
    sessionId,
  });
}

function unsupportedCodexSlashResult(command) {
  const supported = [
    "/review",
    "/diff",
    "/mcp",
    "/plugins",
    "/experimental",
    "/debug-config",
    "/logout",
  ].join(", ");
  return syntheticCodexRunResult({
    text: [
      `\`${command}\` reached the connector, but the installed Codex CLI does not expose a non-interactive command for it.`,
      "",
      `This was not converted into a prompt. Supported connector-executed Codex commands here: ${supported}.`,
    ].join("\n"),
  });
}

function buildCodexSlashExecution(options, slash, codexBin) {
  switch (slash.name) {
    case "review": {
      const parsed = splitCommandArgs(slash.args);
      if (parsed.includes("--help") || parsed.includes("-h")) {
        const args = ["exec", "review", "--help"];
        return { kind: "raw", command: codexBin, args, label: "codex exec review --help" };
      }
      return {
        kind: "codex-json",
        command: codexBin,
        args: buildReviewArgs(options, slash.args),
      };
    }
    case "diff":
      return { kind: "diff" };
    case "mcp": {
      const parsed = splitCommandArgs(slash.args);
      const args = ["mcp", ...(parsed.length > 0 ? parsed : ["list", "--json"])];
      return { kind: "raw", command: codexBin, args, label: `codex ${args.join(" ")}` };
    }
    case "plugins": {
      const parsed = splitCommandArgs(slash.args);
      const args = ["plugin", ...(parsed.length > 0 ? parsed : ["--help"])];
      return { kind: "raw", command: codexBin, args, label: `codex ${args.join(" ")}` };
    }
    case "experimental": {
      const parsed = splitCommandArgs(slash.args);
      const args = ["features", ...(parsed.length > 0 ? parsed : ["list"])];
      return { kind: "raw", command: codexBin, args, label: `codex ${args.join(" ")}` };
    }
    case "debug-config": {
      const parsed = splitCommandArgs(slash.args);
      const args = ["debug", ...(parsed.length > 0 ? parsed : ["prompt-input"])];
      return { kind: "raw", command: codexBin, args, label: `codex ${args.join(" ")}` };
    }
    case "logout":
      return { kind: "raw", command: codexBin, args: ["logout"], label: "codex logout" };
    default:
      return { kind: "unsupported", command: slash.command };
  }
}

function mapCodexToolName(event) {
  if (!event || !event.item) return null;
  const details = event.item;
  switch (details.type) {
    case "command_execution":
      return "Bash";
    case "file_change":
      return "Edit";
    case "mcp_tool_call":
      return details.server_name
        ? `${details.server_name}:${details.tool_name || "unknown"}`
        : (details.tool_name || "MCP");
    case "web_search":
      return "WebSearch";
    default:
      return null;
  }
}

function synthesizeClaudeStreamEvent(codexEvent) {
  const toolName = mapCodexToolName(codexEvent);
  if (!toolName) return null;
  return {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: toolName,
          input: {
            // Provide enough for the connector's summarizeLiveToolUse
            ...(codexEvent.item?.type === "command_execution"
              ? { command: codexEvent.item.command || "" }
              : {}),
            ...(codexEvent.item?.type === "file_change" && Array.isArray(codexEvent.item.changes)
              ? { file_path: codexEvent.item.changes[0]?.path || "" }
              : {}),
          },
        },
      ],
    },
  };
}

function extractAssistantTextFromCodex(event) {
  if (!event || !event.item) return "";
  if (event.item.type === "agent_message") {
    return event.item.text || "";
  }
  return "";
}

function extractThreadId(events) {
  for (const e of events) {
    if (e.type === "thread.started" && e.thread_id) {
      return String(e.thread_id);
    }
    if (e.type === "session_meta" && e.payload?.id) {
      return String(e.payload.id);
    }
  }
  return null;
}

function normalizeCodexThreadId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 160) return "";
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return "";
  return id;
}

function toEpochMs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function toNonNegativeInt(value) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.trunc(n));
}

function codexTokenInfoFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "event_msg" && event.payload?.type === "token_count") {
    return event.payload.info && typeof event.payload.info === "object"
      ? event.payload.info
      : null;
  }
  if (event.type === "token_count") {
    return event.info && typeof event.info === "object" ? event.info : null;
  }
  return null;
}

function codexUsageFromTokenUsage(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== "object") return null;
  const inputTokens = toNonNegativeInt(tokenUsage.input_tokens);
  const outputTokens = toNonNegativeInt(tokenUsage.output_tokens);
  const totalTokens = toNonNegativeInt(tokenUsage.total_tokens);
  const cachedInputTokens = toNonNegativeInt(tokenUsage.cached_input_tokens);
  const cacheCreationInputTokens = toNonNegativeInt(tokenUsage.cache_creation_input_tokens);
  const reasoningOutputTokens = toNonNegativeInt(tokenUsage.reasoning_output_tokens);

  const usage = {
    ...(inputTokens !== null ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== null ? { output_tokens: outputTokens } : {}),
    ...(totalTokens !== null ? { total_tokens: totalTokens } : {}),
    ...(cachedInputTokens !== null
      ? {
          cached_input_tokens: cachedInputTokens,
          cache_read_input_tokens: cachedInputTokens,
        }
      : {}),
    ...(cacheCreationInputTokens !== null
      ? { cache_creation_input_tokens: cacheCreationInputTokens }
      : {}),
    ...(reasoningOutputTokens !== null
      ? { reasoning_output_tokens: reasoningOutputTokens }
      : {}),
  };

  return Object.keys(usage).length > 0 ? usage : null;
}

function subtractCodexUsageTotals(after, before) {
  if (!after || typeof after !== "object") return null;
  const base = before && typeof before === "object" ? before : {};
  const deltaFor = (key) => {
    const next = toNonNegativeInt(after[key]);
    if (next === null) return null;
    const prev = toNonNegativeInt(base[key]) ?? 0;
    return Math.max(0, next - prev);
  };

  const usage = {
    input_tokens: deltaFor("input_tokens"),
    output_tokens: deltaFor("output_tokens"),
    total_tokens: deltaFor("total_tokens"),
    cached_input_tokens: deltaFor("cached_input_tokens"),
    cache_creation_input_tokens: deltaFor("cache_creation_input_tokens"),
    reasoning_output_tokens: deltaFor("reasoning_output_tokens"),
  };

  if (
    (usage.total_tokens === null || usage.total_tokens <= 0) &&
    (usage.input_tokens || 0) + (usage.output_tokens || 0) > 0
  ) {
    usage.total_tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  }

  const hasPositiveUsage = Object.values(usage).some((value) => typeof value === "number" && value > 0);
  if (!hasPositiveUsage) return null;

  return codexUsageFromTokenUsage(usage);
}

function findCodexSessionFileByThreadId(threadId) {
  const safeThreadId = normalizeCodexThreadId(threadId);
  if (!safeThreadId) return null;

  const root = path.join(os.homedir(), ".codex", "sessions");
  const matches = [];
  let visited = 0;
  const maxVisited = 25000;

  const scan = (dir, depth) => {
    if (visited >= maxVisited || depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited >= maxVisited) return;
      const entryPath = path.join(dir, entry.name);
      visited += 1;
      if (entry.isDirectory()) {
        scan(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".jsonl") || !entry.name.includes(safeThreadId)) continue;
      try {
        const stat = fs.statSync(entryPath);
        matches.push({ filePath: entryPath, mtimeMs: Number(stat.mtimeMs || 0) });
      } catch {
        // ignore unreadable candidates
      }
    }
  };

  scan(root, 0);
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.filePath || null;
}

function recoverCodexUsageFromSessionFile({ threadId, startedAtMs, finishedAtMs }) {
  const sessionFile = findCodexSessionFileByThreadId(threadId);
  if (!sessionFile) return null;

  const startMs = Number(startedAtMs);
  const endMs = Number(finishedAtMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  const beforeCutoffMs = startMs - 250;
  const afterCutoffMs = endMs + 5000;
  let beforeTotal = null;
  let afterTotal = null;

  try {
    const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event = null;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const tsMs = toEpochMs(event.timestamp);
      if (tsMs === null || tsMs > afterCutoffMs) continue;

      const tokenInfo = codexTokenInfoFromEvent(event);
      const totalUsage =
        tokenInfo && typeof tokenInfo === "object" && tokenInfo.total_token_usage
          ? tokenInfo.total_token_usage
          : null;
      if (!totalUsage || typeof totalUsage !== "object") continue;

      if (tsMs < beforeCutoffMs) {
        beforeTotal = totalUsage;
      } else {
        afterTotal = totalUsage;
      }
    }
  } catch {
    return null;
  }

  return subtractCodexUsageTotals(afterTotal, beforeTotal);
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // ignore non-JSON lines
    }
  }
  return events;
}

function mergeUniqueEvents(primaryEvents, allStdoutEvents) {
  const merged = Array.isArray(primaryEvents) ? [...primaryEvents] : [];
  const seen = new Set(merged.map((item) => JSON.stringify(item)));
  for (const event of allStdoutEvents) {
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    merged.push(event);
    seen.add(key);
  }
  return merged;
}

function spawnOnce({
  command,
  args,
  cwd,
  env,
  timeoutMs,
  onAssistantText,
  onStreamEvent,
  abortSignal,
  shell = false,
}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    const streamEvents = [];
    let onAbort = null;
    let timer = null;
    let finalizeKillTimer = null;
    let timedOut = false;
    let timeoutError = null;
    let aborted = false;

    const child = spawn(command, args, {
      shell,
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const handleParsedEvent = (event) => {
      streamEvents.push(event);

      // Forward tool-use events to the connector (synthesize Claude-compatible shape)
      if (
        (event.type === "item.started" || event.type === "item.updated") &&
        typeof onStreamEvent === "function"
      ) {
        const synth = synthesizeClaudeStreamEvent(event);
        if (synth) onStreamEvent(synth);
      }

      // Forward assistant text deltas
      const text = extractAssistantTextFromCodex(event);
      if (text && typeof onAssistantText === "function") {
        // Codex item.updated with agent_message contains the full text so far.
        // We send the whole text; the caller deduplicates via lastAssistantText tracking.
        onAssistantText(text, event);
      }
    };

    const finish = (fn) => (value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (finalizeKillTimer) clearTimeout(finalizeKillTimer);
      if (onAbort && abortSignal && typeof abortSignal.removeEventListener === "function") {
        abortSignal.removeEventListener("abort", onAbort);
      }
      fn(value);
    };

    const resolveOnce = finish(resolve);
    const rejectOnce = finish(reject);

    const stopChildAndRejectIfNeeded = async (errorMessage) => {
      if (finalizeKillTimer) clearTimeout(finalizeKillTimer);
      finalizeKillTimer = setTimeout(() => {
        rejectOnce(new Error(errorMessage));
      }, 5000);

      try {
        if (child.pid) await killProcessTree(child.pid, { timeoutMs: 4000 });
      } catch {
        // ignore
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      const lines = (lineBuffer + text).split("\n");
      lineBuffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          handleParsedEvent(event);
        } catch {
          // ignore
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", rejectOnce);

    child.on("close", (code, signal) => {
      const pending = lineBuffer.trim();
      if (pending) {
        try {
          const event = JSON.parse(pending);
          handleParsedEvent(event);
        } catch {
          // ignore
        }
      }

      const stdoutEvents = parseJsonLines(stdout);
      const dedupedEvents = mergeUniqueEvents(streamEvents, stdoutEvents);

      resolveOnce({
        code: Number.isFinite(Number(code)) ? Number(code) : null,
        signal: signal ? String(signal) : null,
        stdout,
        stderr,
        streamEvents: dedupedEvents,
        timedOut,
        timeoutError,
        aborted,
      });
    });

    onAbort = () => {
      aborted = true;
      void stopChildAndRejectIfNeeded("codex_run_aborted");
    };

    if (abortSignal && typeof abortSignal.addEventListener === "function") {
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      timedOut = true;
      timeoutError = `codex_run timed out after ${timeoutMs}ms`;
      void stopChildAndRejectIfNeeded(timeoutError);
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_CODE_AGENT_TIMEOUT_MS));
  });
}

export async function runHeadlessCodex(options = {}) {
  const prompt = buildCodexPrompt(options);
  if (!prompt.trim()) {
    throw new Error("missing_prompt");
  }

  const codexBin = String(options.codexBin || "codex").trim() || "codex";
  const cwd = normalizeCwd(options.cwd);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_CODE_AGENT_TIMEOUT_MS);
  const env = prepareSpawnEnv({ ...process.env, ...(options.env || {}) });

  // With no explicit key, Codex CLI uses the connector machine's cached
  // `codex login` credentials. If a key is supplied, use Codex's API-key env.
  // Otherwise strip inherited API-key env vars so a local-login run cannot
  // silently switch back to API-key auth.
  if (options.apiKey) {
    env.CODEX_API_KEY = String(options.apiKey).trim();
  } else {
    delete env.CODEX_API_KEY;
  }
  delete env.OPENAI_API_KEY;

  const slash = options.planMode === true ? null : parseCodexSlashPrompt(prompt);
  let slashExecution = null;
  try {
    slashExecution = slash ? buildCodexSlashExecution(options, slash, codexBin) : null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err || "invalid_arguments");
    return syntheticCodexRunResult({
      text: `Invalid Codex slash command arguments for \`${slash?.command || "/"}\`: ${detail}`,
      code: 1,
      error: true,
      sessionId: options.sessionId,
    });
  }

  if (slashExecution?.kind === "diff") {
    return runCodexDiffSlash(cwd, slash.args);
  }

  if (slashExecution?.kind === "unsupported") {
    return unsupportedCodexSlashResult(slashExecution.command);
  }

  if (slashExecution?.kind === "raw") {
    return runRawCodexSlashCommand({
      codexBin,
      args: slashExecution.args,
      cwd,
      env,
      timeoutMs,
      abortSignal: options.abortSignal,
      label: slashExecution.label,
      sessionId: options.sessionId,
    });
  }

  // Track cumulative assistant text for delta computation
  let lastAssistantText = "";
  const wrappedOnAssistantText = (text, event) => {
    // Codex sends full text per item, compute delta
    const delta = text.startsWith(lastAssistantText)
      ? text.slice(lastAssistantText.length)
      : text;
    lastAssistantText = text;
    if (delta && typeof options.onAssistantText === "function") {
      options.onAssistantText(delta, event);
    }
  };

  try {
    const args =
      slashExecution?.kind === "codex-json"
        ? slashExecution.args
        : buildCodexArgs({ ...options, prompt, cwd });
    const runStartedAtMs = Date.now();
    const result = await spawnOnce({
      command: codexBin,
      args,
      cwd,
      env,
      timeoutMs,
      onAssistantText: wrappedOnAssistantText,
      onStreamEvent: options.onStreamEvent,
      abortSignal: options.abortSignal,
    });
    const runFinishedAtMs = Date.now();

    // Attach extracted session ID (thread_id) for resume support
    result.codexThreadId =
      extractThreadId(result.streamEvents || []) || normalizeCodexThreadId(options.sessionId);
    recordCodexPlanMode(result.codexThreadId, options.planMode);
    const recoveredUsage = recoverCodexUsageFromSessionFile({
      threadId: result.codexThreadId,
      startedAtMs: runStartedAtMs,
      finishedAtMs: runFinishedAtMs,
    });
    if (recoveredUsage) {
      result.codexUsage = recoveredUsage;
      result.streamEvents = [
        ...(Array.isArray(result.streamEvents) ? result.streamEvents : []),
        {
          type: "token_count",
          info: { last_token_usage: recoveredUsage },
          source: "codex_session_delta",
        },
      ];
    }
    return result;
  } catch (error) {
    if (!isWindows) throw error;
    const message = error instanceof Error ? error.message : String(error || "");
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code || "")
        : "";
    if (code !== "ENOENT" && !/not recognized/i.test(message)) {
      throw error;
    }

    const comSpec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    const commandLine = [
      quoteWindowsArg(codexBin),
      ...args.map((a) => quoteWindowsArg(a)),
    ].join(" ");
    const runStartedAtMs = Date.now();
    const result = await spawnOnce({
      command: comSpec,
      args: ["/d", "/s", "/c", commandLine],
      cwd,
      env,
      timeoutMs,
      onAssistantText: wrappedOnAssistantText,
      onStreamEvent: options.onStreamEvent,
      abortSignal: options.abortSignal,
    });
    const runFinishedAtMs = Date.now();
    result.codexThreadId =
      extractThreadId(result.streamEvents || []) || normalizeCodexThreadId(options.sessionId);
    recordCodexPlanMode(result.codexThreadId, options.planMode);
    const recoveredUsage = recoverCodexUsageFromSessionFile({
      threadId: result.codexThreadId,
      startedAtMs: runStartedAtMs,
      finishedAtMs: runFinishedAtMs,
    });
    if (recoveredUsage) {
      result.codexUsage = recoveredUsage;
      result.streamEvents = [
        ...(Array.isArray(result.streamEvents) ? result.streamEvents : []),
        {
          type: "token_count",
          info: { last_token_usage: recoveredUsage },
          source: "codex_session_delta",
        },
      ];
    }
    return result;
  }
}

export function extractCodexResult(streamEvents) {
  const events = Array.isArray(streamEvents) ? streamEvents : [];
  let resultText = "";
  let threadId = null;
  let turnFailed = false;
  let usage = null;
  const errorMessages = [];
  const diffs = [];

  for (const e of events) {
    if (e.type === "thread.started" && e.thread_id) {
      threadId = String(e.thread_id);
    }
    if (e.type === "session_meta" && e.payload?.id) {
      threadId = String(e.payload.id);
    }

    const tokenInfo = codexTokenInfoFromEvent(e);
    const tokenUsage =
      tokenInfo && typeof tokenInfo === "object"
        ? tokenInfo.last_token_usage || tokenInfo.total_token_usage || null
        : null;
    const normalizedUsage = codexUsageFromTokenUsage(tokenUsage);
    if (normalizedUsage) {
      usage = normalizedUsage;
    }

    // Codex streams top-level `error` events and a `turn.failed` event when a
    // turn cannot complete. Surface their messages so callers can propagate
    // them as errorText instead of falling back to noisy stderr (e.g. the
    // informational "Reading additional input from stdin..." line codex
    // always prints when stdin is piped).
    if (e.type === "error") {
      const msg =
        (typeof e.message === "string" && e.message.trim()) ||
        (typeof e.error === "string" && e.error.trim()) ||
        (e.error && typeof e.error.message === "string" && e.error.message.trim()) ||
        "";
      if (msg) errorMessages.push(msg);
    }

    if (e.type === "turn.failed") {
      turnFailed = true;
      const msg =
        (typeof e.message === "string" && e.message.trim()) ||
        (e.error && typeof e.error.message === "string" && e.error.message.trim()) ||
        (typeof e.reason === "string" && e.reason.trim()) ||
        "";
      if (msg) errorMessages.push(msg);
    }

    const item = e.item;
    if (!item) continue;

    if (item.type === "agent_message" && item.text) {
      resultText = item.text;
    }

    if (item.type === "file_change" && Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (change.path) {
          diffs.push({
            file_path: change.path,
            kind: change.kind || "update",
          });
        }
      }
    }
  }

  // Deduplicate error messages but preserve order.
  const seen = new Set();
  const errorText = errorMessages
    .filter((m) => {
      if (seen.has(m)) return false;
      seen.add(m);
      return true;
    })
    .join("\n");

  return { resultText, threadId, diffs, errorText, turnFailed, usage };
}
