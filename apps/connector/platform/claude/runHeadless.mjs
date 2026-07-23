import { spawn } from "child_process";
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

function quotePosixArg(arg) {
  const s = String(arg ?? "");
  if (!s) return "''";
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function normalizeCwd(cwd) {
  const value = String(cwd || "").trim();
  if (!value) return process.cwd();
  return path.resolve(value);
}

function isTruthyEnvFlag(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function shouldUseLegacyRunner() {
  if (isWindows) return false;
  return isTruthyEnvFlag(
    process.env.GROOVY_CONNECTOR_USE_LEGACY_CLAUDE_RUNNER ||
      process.env.GROOVY_CLAUDE_LEGACY_RUNNER
  );
}

function buildClaudeArgs(options) {
  const args = [
    "-p",
    String(options.prompt || ""),
    "--output-format",
    String(options.outputFormat || "stream-json"),
  ];

  if (String(options.outputFormat || "stream-json") === "stream-json") {
    args.push("--verbose");
  }
  if (options.model) args.push("--model", String(options.model));
  if (options.reasoningEffort) {
    const effort = String(options.reasoningEffort).trim();
    if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
      throw new Error("invalid_reasoning_effort");
    }
    args.push("--effort", effort);
  }
  if (options.allowedTools) args.push("--allowedTools", String(options.allowedTools));
  if (options.planMode) {
    args.push("--permission-mode", "plan");
  } else {
    // Connector runs Claude headlessly inside the user's local machine; there's
    // no human at the terminal to approve prompts. Skip permission gates so
    // tool use proceeds. Plan mode intentionally keeps the read-only gate.
    args.push("--dangerously-skip-permissions");
  }
  if (options.sessionId) args.push("--resume", String(options.sessionId));
  if (Array.isArray(options.extraArgs)) {
    for (const arg of options.extraArgs) {
      const v = String(arg ?? "");
      if (v) args.push(v);
    }
  }
  return args;
}

function extractAssistantText(event) {
  if (!event || event.type !== "assistant") return "";
  const content = Array.isArray(event?.message?.content) ? event.message.content : [];
  return content
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text)
    .join("");
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // ignore non-JSON output lines
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
    let lastAssistantText = ""; // Track cumulative text to compute deltas
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
      if (typeof onStreamEvent === "function") onStreamEvent(event);
      const assistantText = extractAssistantText(event);
      if (assistantText && typeof onAssistantText === "function") {
        // Claude stream-json emits cumulative assistant text.
        // Send only the newly added suffix so the UI doesn't duplicate content.
        const delta = assistantText.startsWith(lastAssistantText)
          ? assistantText.slice(lastAssistantText.length)
          : assistantText;
        lastAssistantText = assistantText;
        if (delta) onAssistantText(delta, event);
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
        // ignore stop failures; the fallback reject timer above will still fire
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
      void stopChildAndRejectIfNeeded("claude_run_aborted");
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
      timeoutError = `claude_run timed out after ${timeoutMs}ms`;
      void stopChildAndRejectIfNeeded(timeoutError);
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_CODE_AGENT_TIMEOUT_MS));
  });
}

export async function runHeadlessClaude(options = {}) {
  const prompt = String(options.prompt || "");
  if (!prompt.trim()) {
    throw new Error("missing_prompt");
  }

  const claudeBin = String(options.claudeBin || "claude").trim() || "claude";
  const cwd = normalizeCwd(options.cwd);
  const args = buildClaudeArgs(options);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_CODE_AGENT_TIMEOUT_MS);
  const env = prepareSpawnEnv({ ...process.env, ...(options.env || {}) });

  if (options.localAuth === true) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  } else if (options.cliToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = String(options.cliToken);
    delete env.ANTHROPIC_API_KEY;
  } else if (options.apiKey) {
    env.ANTHROPIC_API_KEY = String(options.apiKey);
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  if (options.claudeConfigDir) {
    env.CLAUDE_CONFIG_DIR = String(options.claudeConfigDir);
  }

  if (shouldUseLegacyRunner()) {
    const commandLine = [quotePosixArg(claudeBin), ...args.map((arg) => quotePosixArg(arg))].join(" ");
    return spawnOnce({
      command: `${commandLine} < /dev/null`,
      args: [],
      cwd,
      env,
      timeoutMs,
      onAssistantText: options.onAssistantText,
      onStreamEvent: options.onStreamEvent,
      abortSignal: options.abortSignal,
      shell: true,
    });
  }

  try {
    return await spawnOnce({
      command: claudeBin,
      args,
      cwd,
      env,
      timeoutMs,
      onAssistantText: options.onAssistantText,
      onStreamEvent: options.onStreamEvent,
      abortSignal: options.abortSignal,
    });
  } catch (error) {
    if (!isWindows) throw error;
    const message = error instanceof Error ? error.message : String(error || "");
    const code = error && typeof error === "object" && "code" in error ? String(error.code || "") : "";
    if (code !== "ENOENT" && !/not recognized/i.test(message)) {
      throw error;
    }

    // Fallback for environments where `claude` resolves to a .cmd shim.
    const comSpec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    const commandLine = [quoteWindowsArg(claudeBin), ...args.map((arg) => quoteWindowsArg(arg))].join(" ");
    return spawnOnce({
      command: comSpec,
      args: ["/d", "/s", "/c", commandLine],
      cwd,
      env,
      timeoutMs,
      onAssistantText: options.onAssistantText,
      onStreamEvent: options.onStreamEvent,
      abortSignal: options.abortSignal,
    });
  }
}
