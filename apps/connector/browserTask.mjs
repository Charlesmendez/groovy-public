import { credentialGetSecret, credentialRequest } from "./credentials.mjs";
import {
  initBrowser,
  browserNavigate,
  browserEvaluate,
  browserPressKey,
  computerUseAction,
  closeBrowser,
} from "./browser.mjs";
import fs from "fs";
import os from "os";
import path from "path";
import {
  killProcessesByCommandFragment,
  removeSingletonLocks,
} from "./platform/process/index.mjs";
import { runHeadlessClaude } from "./platform/claude/runHeadless.mjs";
import { prepareSpawnEnv } from "./platform/shell/index.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveClaudeBin() {
  const override = String(
    process.env.GROOVY_CLAUDE_BIN ||
      process.env.CLAUDE_BIN ||
      process.env.CLAUDE_CODE_BIN ||
      ""
  ).trim();

  const home = os.homedir();
  const candidates = [
    override || null,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "claude", "claude.exe")
      : null,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "claude", "claude.cmd")
      : null,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    path.join(home, ".local/bin/claude"),
    path.join(home, "bin/claude"),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      fs.accessSync(p, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return p;
    } catch {
      // ignore
    }
  }

  return "claude";
}

function resolveClaudeCwd(opts) {
  const candidates = [
    typeof opts?.cwd === "string" ? opts.cwd : "",
    process.env.GROOVY_BROWSER_CWD || "",
    process.env.GROOVY_CODE_CWD || "",
  ]
    .map((p) => String(p || "").trim())
    .filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      // ignore
    }
  }
  return os.homedir();
}

function cleanProgressText(value, maxLen = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function emitProgressSafe(onProgress, text) {
  if (typeof onProgress !== "function") return;
  const safe = cleanProgressText(text, 200);
  if (!safe) return;
  try {
    const maybePromise = onProgress(safe);
    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.catch(() => {});
    }
  } catch {
    // ignore progress callback failures
  }
}

function summarizePlaywrightToolUse(block) {
  const b = block && typeof block === "object" ? block : null;
  if (!b || b.type !== "tool_use") return "";
  const name = String(b.name || "");
  if (!name.startsWith("mcp__playwright__")) return "";
  const input = b.input && typeof b.input === "object" ? b.input : {};
  const element = cleanProgressText(input.element || input.ref || "", 90);
  const url = cleanProgressText(input.url || "", 90);

  if (name === "mcp__playwright__browser_click") {
    return element ? `Click: ${element}` : "Click";
  }
  if (name === "mcp__playwright__browser_type" || name === "mcp__playwright__browser_fill") {
    return element ? `Type into: ${element}` : "Type into field";
  }
  if (name === "mcp__playwright__browser_fill_form") {
    const count = Array.isArray(input.fields) ? input.fields.length : 0;
    return count > 0 ? `Fill form (${count} fields)` : "Fill form";
  }
  if (name === "mcp__playwright__browser_navigate" || name === "mcp__playwright__browser_navigate_back") {
    return url ? `Navigate: ${url}` : "Navigate browser";
  }
  if (name === "mcp__playwright__browser_scroll") {
    const direction = cleanProgressText(input.direction || "", 20);
    return direction ? `Scroll ${direction}` : "Scroll page";
  }
  if (name === "mcp__playwright__browser_press_key") {
    const key = cleanProgressText(input.key || "", 20);
    return key ? `Press key: ${key}` : "Press key";
  }
  if (name === "mcp__playwright__browser_select_option") {
    return element ? `Select option: ${element}` : "Select option";
  }
  if (name === "mcp__playwright__browser_wait_for") {
    const waitText = cleanProgressText(input.text || "", 80);
    return waitText ? `Wait for: ${waitText}` : "Wait for page update";
  }
  if (name === "mcp__playwright__browser_tabs") {
    return "Switch/check browser tab";
  }

  // Skip noisy events that are not useful in WhatsApp progress.
  if (
    name === "mcp__playwright__browser_snapshot" ||
    name === "mcp__playwright__browser_take_screenshot" ||
    name === "mcp__playwright__browser_console_messages" ||
    name === "mcp__playwright__browser_network_requests" ||
    name === "mcp__playwright__browser_run_code" ||
    name === "mcp__playwright__browser_evaluate"
  ) {
    return "";
  }

  return "Browser step running";
}

function summarizeComputerUseToolCall(toolCall) {
  const tc = toolCall && typeof toolCall === "object" ? toolCall : null;
  if (!tc) return "";
  const action = cleanProgressText(tc.action || "", 30).toLowerCase();
  if (!action || action === "screenshot") return "";

  if (action === "click" || action === "left_click" || action === "double_click") {
    if (Array.isArray(tc.coordinate) && tc.coordinate.length >= 2) {
      const x = Number(tc.coordinate[0]);
      const y = Number(tc.coordinate[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return `Click at (${Math.round(x)}, ${Math.round(y)})`;
      }
    }
    return "Click";
  }
  if (action === "type") return "Type into field";
  if (action === "key") {
    const key = cleanProgressText(tc.key || "", 20);
    return key ? `Press key: ${key}` : "Press key";
  }
  if (action === "scroll") {
    const dir = cleanProgressText(tc.scrollDirection || "", 20);
    return dir ? `Scroll ${dir}` : "Scroll page";
  }
  if (action === "wait") return "Wait for page update";

  return `Browser action: ${action}`;
}

// ---------------------------------------------------------------------------
// Playwright MCP browser task runner (preferred path)
// Uses `claude -p` + Playwright MCP for reliable, headless browser automation.
// Falls back to the legacy Computer Use loop if claude CLI is unavailable.
// ---------------------------------------------------------------------------

const PLAYWRIGHT_ALLOWED_TOOLS = [
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_click",
  "mcp__playwright__browser_type",
  "mcp__playwright__browser_wait_for",
  "mcp__playwright__browser_press_key",
  "mcp__playwright__browser_select_option",
  "mcp__playwright__browser_hover",
  "mcp__playwright__browser_drag",
  "mcp__playwright__browser_take_screenshot",
  "mcp__playwright__browser_network_requests",
  "mcp__playwright__browser_console_messages",
  "mcp__playwright__browser_tabs",
  "mcp__playwright__browser_close",
  "mcp__playwright__browser_resize",
  "mcp__playwright__browser_navigate_back",
  "mcp__playwright__browser_fill_form",
  "mcp__playwright__browser_handle_dialog",
  "mcp__playwright__browser_file_upload",
  "mcp__playwright__browser_run_code",
  "mcp__playwright__browser_evaluate",
  "mcp__playwright__browser_install",
].join(",");

export async function runBrowserTaskViaPlaywright(opts) {
  const task = String(opts?.task || "").trim();
  const startUrl =
    typeof opts?.start_url === "string"
      ? opts.start_url.trim()
      : typeof opts?.startUrl === "string"
        ? opts.startUrl.trim()
        : "";
  const profileNameRaw =
    typeof opts?.profile_name === "string"
      ? opts.profile_name
      : typeof opts?.profileName === "string"
        ? opts.profileName
        : "default";
  const profileSlug =
    String(profileNameRaw || "default")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 48) || "default";
  const userDataDir = path.join(os.homedir(), ".groovy", "playwright-mcp-profiles", profileSlug);
  const apiKey = typeof opts?.api_key === "string" ? opts.api_key.trim() : "";
  const cliToken = typeof opts?.cli_token === "string" ? opts.cli_token.trim() : "";
  const envTimeoutRaw =
    process.env.GROOVY_BROWSER_TASK_TIMEOUT_MS || process.env.GROOVY_PLAYWRIGHT_TIMEOUT_MS || "";
  const envTimeoutMs = Number(envTimeoutRaw);
  const timeoutMs = Number.isFinite(Number(opts?.timeout_ms))
    ? Number(opts.timeout_ms)
    : Number.isFinite(envTimeoutMs) && envTimeoutMs > 0
      ? envTimeoutMs
      : 8 * 60 * 1000;
  const continueSessionIdRaw =
    typeof opts?.session_id === "string"
      ? opts.session_id
      : typeof opts?.sessionId === "string"
        ? opts.sessionId
        : "";
  const continueSessionId = String(continueSessionIdRaw || "").trim();
  const shouldContinueSession = continueSessionId.length > 0;
  const abortSignal =
    opts?.abortSignal && typeof opts.abortSignal === "object" ? opts.abortSignal : null;
  const onProgress = typeof opts?.onProgress === "function" ? opts.onProgress : null;
  const emitProgress = (text) => emitProgressSafe(onProgress, text);

  if (!task) return { ok: false, error: "missing_task" };
  if (abortSignal?.aborted) return { ok: false, error: "aborted" };

  // Close any open Puppeteer browser so it doesn't conflict with Playwright's Chromium.
  // The legacy runBrowserTaskOnConnector path may have left one running.
  try {
    await closeBrowser();
  } catch {
    // ignore — no browser open
  }

  // Keep Playwright MCP on a connector-managed persistent profile directory.
  // This lets us clear stale lock files and kill orphaned profile-owned Chrome
  // processes when a prior run crashed or timed out.
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
  } catch {
    // ignore
  }

  let killedStaleChrome = 0;
  if (!shouldContinueSession) {
    try {
      const killResult = await killProcessesByCommandFragment(userDataDir, {
        processNameRegex: "chrome|chromium|msedge|playwright|puppeteer",
      });
      killedStaleChrome = killResult.killed;
    } catch {
      // ignore
    }

    if (killedStaleChrome > 0) {
      await sleep(400);
    }
    await removeSingletonLocks(userDataDir);
  }
  if (killedStaleChrome > 0) {
    console.log(
      "[browser-task-playwright] killed",
      killedStaleChrome,
      "stale Playwright Chrome processes",
      { profile: profileSlug }
    );
    await sleep(500);
  }

  // Build the prompt: include credentials if we have them for the start URL domain
  let credentialHint = "";
  if (startUrl) {
    try {
      const domain = new URL(startUrl).hostname.toLowerCase();
      const secret = await credentialGetSecret({ domain }).catch(() => null);
      if (secret?.ok && secret.hasCredential && secret.password) {
        credentialHint =
          `\n\nIMPORTANT: If the page requires login, use these credentials:\n` +
          `<robot_credentials>\n` +
          `  Username: ${secret.username}\n` +
          `  Password: ${secret.password}\n` +
          `</robot_credentials>\n` +
          `Fill the username/email field, submit, wait for the password field, fill it, then submit.\n`;
      }
    } catch {
      // ignore
    }
  }

  const startUrlInstruction = shouldContinueSession
    ? `- Continue from the CURRENT browser/tab state from the previous run.\n` +
      `- Only navigate to the Start URL if the current tab is missing, wrong domain, or clearly broken.\n`
    : `- Use browser_navigate to go to the start URL first.\n`;

  const fullPrompt =
    `Use playwright mcp to complete this browser task:\n\n` +
    (startUrl ? `Start URL: ${startUrl}\n\n` : "") +
    `Task: ${task}` +
    credentialHint +
    `\n\nIMPORTANT:\n` +
    startUrlInstruction +
    `- Use browser_snapshot (not screenshots) to understand page content.\n` +
    `- After each action, take a snapshot to verify the result.\n` +
    `- If a click opens a new tab/window, use browser_tabs to list/select the new tab (usually the newest), then continue there.\n` +
    `- If the page seems "stuck" after a click (snapshot doesn't change), check browser_tabs — you may be on the wrong tab.\n` +
    `- NEVER repeat the same action more than 2 times when URL/title/snapshot are unchanged.\n` +
    `- If the page stays blank/about:blank or no progress is possible, STOP and return a blocked summary instead of looping.\n` +
    `- If you encounter a login page, fill credentials step by step.\n` +
    `- When done, provide a clear text summary of what you found/accomplished.\n` +
    `- Always include a final status line in plain text: status=completed|partial|blocked plus what remains.`;

  const claudeBin = resolveClaudeBin();
  const cliModelRaw =
    [
      process.env.GROOVY_BROWSER_TASK_MODEL,
      process.env.GROOVY_COMPUTER_USE_MODEL,
      process.env.GROOVY_CLAUDE_CLI_MODEL,
    ]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .find((v) => !!v) || "";
  const cliModel = cliModelRaw || "claude-sonnet-4-6";

  // Default to visible browser so users can watch automation.
  // Set GROOVY_PLAYWRIGHT_HEADLESS=1 (or true/on/yes) to force headless mode.
  const headlessEnvRaw = String(
    process.env.GROOVY_PLAYWRIGHT_HEADLESS ??
      process.env.PLAYWRIGHT_MCP_HEADLESS ??
      ""
  )
    .trim()
    .toLowerCase();
  const headless = ["1", "true", "yes", "on"].includes(headlessEnvRaw);

  console.log("[browser-task-playwright] starting", {
    taskLen: task.length,
    startUrl,
    model: cliModel,
    hasCredentials: !!credentialHint,
    timeoutMs,
    profile: profileSlug,
    headless,
    continueSession: shouldContinueSession ? `${continueSessionId.slice(0, 8)}...` : null,
  });

  if (abortSignal?.aborted) return { ok: false, error: "aborted" };

  const spawnEnv = {
    ...(headless ? { PLAYWRIGHT_MCP_HEADLESS: "true" } : {}),
    PLAYWRIGHT_MCP_USER_DATA_DIR: userDataDir,
  };

  try {
    const spawnResult = await runHeadlessClaude({
      prompt: fullPrompt,
      cwd: resolveClaudeCwd(opts),
      timeoutMs,
      claudeBin,
      model: cliModel,
      allowedTools: PLAYWRIGHT_ALLOWED_TOOLS,
      sessionId: shouldContinueSession ? continueSessionId : undefined,
      apiKey: cliToken ? undefined : apiKey,
      cliToken: cliToken || undefined,
      env: spawnEnv,
      abortSignal,
      onStreamEvent: (event) => {
        if (!event || event.type !== "assistant") return;
        const content = Array.isArray(event?.message?.content) ? event.message.content : [];
        for (const block of content) {
          const progress = summarizePlaywrightToolUse(block);
          if (progress) emitProgress(progress);
        }
      },
    });

    let resultText = "";
    let sessionId = "";
    let totalCostUsd = null;
    let usageObj = null;
    let inputTokens = null;
    let outputTokens = null;
    let totalTokens = null;
    let modelFromResult = "";

    const streamEvents = Array.isArray(spawnResult.streamEvents) ? spawnResult.streamEvents : [];
    for (const ev of streamEvents) {
      if (ev.type === "result") {
        resultText = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result);
        sessionId = ev.session_id || "";
        if (typeof ev.total_cost_usd === "number") totalCostUsd = ev.total_cost_usd;
        if (ev.usage && typeof ev.usage === "object") usageObj = ev.usage;
        if (typeof ev.model === "string" && ev.model.trim()) modelFromResult = ev.model.trim();

        const u = usageObj && typeof usageObj === "object" ? usageObj : null;
        if (typeof ev.input_tokens === "number") inputTokens = ev.input_tokens;
        else if (u && typeof u.input_tokens === "number") inputTokens = u.input_tokens;

        if (typeof ev.output_tokens === "number") outputTokens = ev.output_tokens;
        else if (u && typeof u.output_tokens === "number") outputTokens = u.output_tokens;

        if (typeof ev.total_tokens === "number") totalTokens = ev.total_tokens;
        else if (typeof inputTokens === "number" && typeof outputTokens === "number") {
          totalTokens = inputTokens + outputTokens;
        }
      } else if (ev.type === "assistant" && ev.message?.content) {
        const assistantText = Array.isArray(ev.message.content)
          ? ev.message.content
              .filter((block) => block?.type === "text" && typeof block?.text === "string")
              .map((block) => block.text)
              .join("")
              .trim()
          : "";
        if (assistantText) {
          resultText = assistantText;
        }
      }
    }
    if (!sessionId && shouldContinueSession) {
      sessionId = continueSessionId;
    }

    const text = String(resultText || "").trim();
    const exitCode = Number.isFinite(Number(spawnResult.code)) ? Number(spawnResult.code) : null;
    const stderr = String(spawnResult.stderr || "");
    const timedOut = spawnResult.timedOut === true;
    const aborted = spawnResult.aborted === true;

    console.log("[browser-task-playwright] finished", {
      exitCode,
      signal: spawnResult.signal || null,
      resultLen: text.length,
      stderrLen: stderr.length,
      sessionId: sessionId ? sessionId.slice(0, 8) + "..." : null,
      timedOut,
      aborted,
    });

    if (timedOut || aborted) {
      return {
        ok: false,
        error: timedOut
          ? spawnResult.timeoutError || `claude_run timed out after ${timeoutMs}ms`
          : "claude_run_aborted",
        text,
        sessionId,
        partial: text.length > 0,
        meta: {
          exitCode,
          signal: spawnResult.signal || null,
          playwright: true,
          profile: profileSlug,
          killedStaleChrome,
          timedOut,
          aborted,
        },
      };
    }

    if (exitCode !== null && exitCode !== 0 && !text) {
      return {
        ok: false,
        error: stderr.slice(0, 500) || `claude exited with code ${exitCode}`,
      };
    }

    return {
      ok: true,
      text,
      sessionId,
      model: modelFromResult || cliModel,
      total_cost_usd: typeof totalCostUsd === "number" ? totalCostUsd : undefined,
      input_tokens: typeof inputTokens === "number" ? inputTokens : undefined,
      output_tokens: typeof outputTokens === "number" ? outputTokens : undefined,
      total_tokens: typeof totalTokens === "number" ? totalTokens : undefined,
      usage: usageObj || undefined,
      meta: { exitCode, playwright: true, profile: profileSlug, killedStaleChrome },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || "browser_task_failed");
    if (message === "claude_run_aborted") return { ok: false, error: "aborted" };
    if (/timed out/i.test(message)) {
      return {
        ok: false,
        error: `Browser task timed out after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    return { ok: false, error: message };
  }
}

function hasPlaywrightInMcpConfigJson(obj) {
  const o = obj && typeof obj === "object" ? obj : null;
  const mcpServers = o?.mcpServers && typeof o.mcpServers === "object" ? o.mcpServers : null;
  if (mcpServers && mcpServers.playwright) return true;
  return false;
}

function hasPlaywrightInClaudeConfigJson(config, projectKey) {
  const c = config && typeof config === "object" ? config : null;
  if (!c) return false;

  // User-scope servers
  if (hasPlaywrightInMcpConfigJson(c)) return true;

  // Local-scope servers stored under project paths in ~/.claude.json
  const projects = c.projects && typeof c.projects === "object" ? c.projects : null;
  if (!projects) return false;

  const cwd = String(projectKey || "").trim();
  if (!cwd) return false;

  const keyCandidates = [];
  try {
    keyCandidates.push(fs.realpathSync(cwd));
  } catch {
    // ignore
  }
  keyCandidates.push(cwd, path.resolve(cwd));

  const seen = new Set();
  for (const raw of keyCandidates) {
    let cur = String(raw || "").replace(/\/+$/, "");
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const proj = projects[cur];
      if (proj && hasPlaywrightInMcpConfigJson(proj)) return true;
      const parent = path.dirname(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
  }

  return false;
}

// Check if claude CLI + Playwright MCP is available
let _playwrightAvailable = null;
export async function isPlaywrightAvailable() {
  if (_playwrightAvailable !== null) return _playwrightAvailable;
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const claudeBin = resolveClaudeBin();
    const env = prepareSpawnEnv({ ...process.env });
    const { stdout } = await execFileAsync(claudeBin, ["--version"], { timeout: 10000, env });

    const cwd = resolveClaudeCwd(null);
    const userClaudePath = path.join(os.homedir(), ".claude.json");

    // 1) Project-scope: .mcp.json in the project root
    try {
      let dir = cwd;
      for (let i = 0; i < 12; i++) {
        const projectMcpPath = path.join(dir, ".mcp.json");
        if (fs.existsSync(projectMcpPath)) {
          const projectConfig = JSON.parse(fs.readFileSync(projectMcpPath, "utf8"));
          if (hasPlaywrightInMcpConfigJson(projectConfig)) {
            _playwrightAvailable = true;
            console.log("[browser-task] playwright available (project scope)", {
              claude: stdout.trim(),
              cwd: dir,
            });
            return _playwrightAvailable;
          }
          // .mcp.json exists but doesn't include playwright → stop searching upward
          break;
        }
        const parent = path.dirname(dir);
        if (!parent || parent === dir) break;
        dir = parent;
      }
    } catch {
      // ignore
    }

    // 2) User/local scope: ~/.claude.json
    try {
      if (fs.existsSync(userClaudePath)) {
        const userConfig = JSON.parse(fs.readFileSync(userClaudePath, "utf8"));
        _playwrightAvailable = hasPlaywrightInClaudeConfigJson(userConfig, cwd);
        console.log("[browser-task] playwright available:", _playwrightAvailable, {
          claude: stdout.trim(),
          cwd,
        });
        return _playwrightAvailable;
      }
    } catch {
      // ignore
    }

    _playwrightAvailable = false;
    console.log("[browser-task] playwright not configured", { claude: stdout.trim(), cwd });
  } catch {
    _playwrightAvailable = false;
  }
  return _playwrightAvailable;
}

function normalizeAppUrl(appUrl) {
  const u = String(appUrl || "").trim();
  return u.replace(/\/+$/, "");
}

function safeDomainFromUrl(u) {
  try {
    const url = new URL(String(u));
    return String(url.hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

// Prevent request bodies from exploding (413) by stripping old screenshot images
// from the conversation history. We keep ALL messages (never drop assistant/user turns)
// to preserve tool_use → tool_result pairing that Anthropic requires.
// Only the last N screenshots are kept as actual images; older ones become text placeholders.
function trimBrowserAgentMessages(messages, { keepRecentImages = 2 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // Count image blocks from the end to find which ones to keep
  let imageCount = 0;
  const imagePositions = []; // [{ msgIdx, blockIdx }]

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object" || !Array.isArray(m.content)) continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j];
      if (b && typeof b === "object" && b.type === "image") {
        imagePositions.push({ msgIdx: i, blockIdx: j, keep: imageCount < keepRecentImages });
        imageCount++;
      }
    }
  }

  // If few enough images, return as-is
  if (imageCount <= keepRecentImages) return messages;

  // Deep-copy messages and replace old images with text placeholders
  const result = messages.map((m, mi) => {
    if (!m || typeof m !== "object" || !Array.isArray(m.content)) return m;

    const hasOldImage = imagePositions.some((p) => p.msgIdx === mi && !p.keep);
    if (!hasOldImage) return m;

    const newContent = m.content.map((b, bi) => {
      const pos = imagePositions.find((p) => p.msgIdx === mi && p.blockIdx === bi);
      if (pos && !pos.keep) {
        return { type: "text", text: "[screenshot image omitted to save space]" };
      }
      return b;
    });

    return { ...m, content: newContent };
  });

  return result;
}

async function detectLikelyLogin({ pageId = "default" }) {
  const r = await browserEvaluate({
    pageId,
    script: `
      const url = String(window.location && window.location.href || "");
      const title = String(document && document.title || "");
      const pw = document.querySelector('input[type="password"]');
      const hasPw = !!(pw && (pw.offsetParent !== null));
      const hasSubmit = !!document.querySelector('button[type="submit"], input[type="submit"]');
      const hasUserish = !!document.querySelector('input[type="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i], input[id*="login" i]');
      const urlHint = /login|signin|sign-in|auth/i.test(url) || /login|sign in|signin/i.test(title);
      return { url, title, hasPw, hasSubmit, hasUserish, urlHint };
    `,
  });
  if (!r?.ok) return { ok: false, error: r?.error || "detect_failed" };
  return { ok: true, ...r.result };
}

async function heuristicLoginFill({ pageId = "default", username, password }) {
  const u = String(username || "");
  const p = String(password || "");
  if (!p) return { ok: false, error: "missing_password" };
  const r = await browserEvaluate({
    pageId,
    script: `
      (function() {
        const username = ${JSON.stringify(u)};
        const password = ${JSON.stringify(p)};

        function isVisible(el) {
          try { return !!(el && (el.offsetParent !== null)); } catch { return false; }
        }

        const pw = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible);
        if (!pw) return { ok: false, reason: "no_password_field" };

        const userCandidates = [
          'input[type="email"]',
          'input[name*="user" i]',
          'input[name*="login" i]',
          'input[name*="email" i]',
          'input[id*="user" i]',
          'input[id*="login" i]',
          'input[id*="email" i]',
          'input[autocomplete*="user" i]',
          'input[autocomplete*="email" i]',
          'input[placeholder*="user" i]',
          'input[placeholder*="email" i]',
          'input[placeholder*="login" i]',
          'input[aria-label*="user" i]',
          'input[aria-label*="email" i]',
          'input[type="text"]',
          'input[type="tel"]',
          'input:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'
        ];
        let user = null;
        for (const sel of userCandidates) {
          const cand = Array.from(document.querySelectorAll(sel)).find(isVisible);
          if (cand && cand !== pw) { user = cand; break; }
        }

        function setValue(el, val) {
          try {
            // Use the native setter to bypass React/Vue controlled inputs
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            )?.set;
            el.focus();
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(el, '');
            } else {
              el.value = '';
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(el, val);
            } else {
              el.value = val;
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            // Also dispatch InputEvent for modern frameworks
            try {
              el.dispatchEvent(new InputEvent("input", { bubbles: true, data: val, inputType: "insertText" }));
            } catch {}
          } catch {}
        }

        if (user && username) setValue(user, username);
        setValue(pw, password);
        try { pw.focus(); } catch {}

        // Try to click submit button — look in the form first, then the whole page.
        const form = pw.form || (user && user.form) || null;
        let clicked = false;
        const submitSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:not([type="button"]):not([type="reset"])',
          '[role="button"]',
          'a[href*="login" i]',
          'button',
        ];
        const searchRoots = form ? [form, document] : [document];
        for (const root of searchRoots) {
          if (clicked) break;
          for (const sel of submitSelectors) {
            const btn = root.querySelector(sel);
            if (btn && isVisible(btn) && btn !== user && btn !== pw) {
              try { btn.click(); clicked = true; break; } catch {}
            }
          }
        }

        return {
          ok: true,
          filled_user: !!(user && username),
          filled_pw: true,
          clicked_submit: clicked,
        };
      })()
    `,
  });
  if (!r?.ok) return { ok: false, error: r?.error || "login_fill_failed" };
  return { ok: true, ...(r.result || {}) };
}

async function maybeAutoLogin({ domain, pageId = "default" }) {
  const det = await detectLikelyLogin({ pageId });
  if (!det.ok) return { ok: true, skipped: true };

  // Be more forgiving: if there's a password field, that's enough to try auto-login.
  // Some sites (like ClassLink) don't have URL hints or standard username selectors.
  const likely = det.hasPw;
  if (!likely) return { ok: true, skipped: true };

  const secret = await credentialGetSecret({ domain });
  if (!secret.ok) return { ok: false, error: secret.error || "credential_get_failed" };
  if (!secret.hasCredential) {
    const req = await credentialRequest({ domain, reason: "Browser task requires login." });
    if (!req.ok) return { ok: false, error: req.error || "credential_request_failed" };
  }

  const secret2 = await credentialGetSecret({ domain });
  if (!secret2.ok) return { ok: false, error: secret2.error || "credential_get_failed" };
  if (!secret2.hasCredential) return { ok: false, error: "missing_credentials" };

  const filled = await heuristicLoginFill({
    pageId,
    username: secret2.username,
    password: secret2.password,
  });
  if (!filled.ok) return { ok: false, error: filled.error || "login_fill_failed" };

  // If we didn't click submit, try Enter.
  if (!filled.clicked_submit) {
    await browserPressKey({ pageId, key: "Enter" }).catch(() => {});
  }

  // Wait for navigation/redirect after login
  await sleep(2500);
  return { ok: true, attempted: true, domain, url: det.url };
}

async function postBrowserAgent({ appUrl, deviceToken, body }) {
  const url = `${normalizeAppUrl(appUrl)}/api/browser-agent`;
  const headers = { "Content-Type": "application/json" };
  if (deviceToken) headers["X-Device-Token"] = deviceToken;

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: text || `HTTP ${res.status}`, status: res.status };
  }
  return { ok: true, res };
}

async function readSse(res, onEvent) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("missing_response_body");
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const p of parts) {
      if (!p.startsWith("data: ")) continue;
      try {
        const ev = JSON.parse(p.slice(6));
        onEvent(ev);
      } catch {
        // ignore
      }
    }
  }
}

export async function runBrowserTaskOnConnector(opts) {
  const task = String(opts?.task || "").trim();
  const startUrl = typeof opts?.start_url === "string" ? opts.start_url.trim() : typeof opts?.startUrl === "string" ? opts.startUrl.trim() : "";
  const appUrl = String(opts?.app_url || opts?.appUrl || "").trim();
  const deviceToken = typeof opts?.device_token === "string" ? opts.device_token : typeof opts?.deviceToken === "string" ? opts.deviceToken : null;
  const profileName = typeof opts?.profile_name === "string" ? opts.profile_name : typeof opts?.profileName === "string" ? opts.profileName : "default";
  const onProgress = typeof opts?.onProgress === "function" ? opts.onProgress : null;
  const emitProgress = (text) => emitProgressSafe(onProgress, text);

  if (!task) return { ok: false, error: "missing_task" };
  if (!appUrl) return { ok: false, error: "missing_app_url" };

  const pageId = "default";

  // Start/reuse browser with a persistent profile so sessions persist across runs.
  const init = await initBrowser({ headless: true, profile_name: profileName });
  if (!init?.ok) return { ok: false, error: init?.error || "browser_init_failed" };

  const targetUrl = startUrl || "https://www.google.com";
  // Large sites often never reach networkidle; start from DOMContentLoaded and let Computer Use proceed.
  const nav = await browserNavigate({ url: targetUrl, pageId, waitUntil: "domcontentloaded", timeoutMs: 30_000 });
  if (!nav?.ok) return { ok: false, error: nav?.error || "browser_navigate_failed" };

  await sleep(500);

  // Auto-login is now handled inside computerUseScreenshot (browser.mjs).
  // No need to call maybeAutoLogin here — the first screenshot will trigger it.

  // Initial screenshot for browser-agent context
  const initialShot = await computerUseAction({ action: "screenshot", pageId });
  const initialScreenshot = initialShot?.ok
    ? {
        screenshot: initialShot.screenshot,
        screenshotMediaType: initialShot.screenshotMediaType,
        url: initialShot.url || nav.url || targetUrl,
        title: initialShot.title || "",
      }
    : null;

  let previousMessages = [];
  let pendingToolResult = null;
  let iteration = 0;
  const maxIterations = 30;
  let accumulatedText = "";
  let finalText = "";
  let lastScreenshot = initialScreenshot?.screenshot || null;
  let lastPageUrl = initialScreenshot?.url || nav.url || targetUrl;
  let lastPageTitle = initialScreenshot?.title || "";

  // --- Loop detection state ---
  // Track recent actions to detect stuck-in-a-loop patterns (e.g. repeated click/type at same coords)
  const actionHistory = []; // { action, coordinate, text }
  const LOOP_WINDOW = 6; // look at last N actions
  const LOOP_REPEAT_THRESHOLD = 3; // same action+coord repeated this many times → stuck
  let sameViewStreak = 0; // consecutive steps with identical screenshot+url+title

  function isStuckInLoop() {
    if (actionHistory.length < LOOP_REPEAT_THRESHOLD) return false;
    const recent = actionHistory.slice(-LOOP_WINDOW);
    // Check if the same (action, coordinate) pair appears >= threshold times
    const counts = {};
    for (const h of recent) {
      const key = `${h.action}|${JSON.stringify(h.coordinate || [])}`;
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] >= LOOP_REPEAT_THRESHOLD) return true;
    }
    // Also detect alternating patterns: A-B-A-B-A-B (2-step cycle repeated 3+x)
    if (recent.length >= 4) {
      const keys = recent.map((h) => `${h.action}|${JSON.stringify(h.coordinate || [])}`);
      const last4 = keys.slice(-4);
      if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) return true;
    }
    return false;
  }

  while (iteration < maxIterations) {
    iteration++;

    const body = {};
    if (iteration === 1) {
      body.task = task;
      if (initialScreenshot?.screenshot) body.initialScreenshot = initialScreenshot;
    } else {
      body.previousMessages = previousMessages;
      if (pendingToolResult) body.toolResult = pendingToolResult;
    }

    const call = await postBrowserAgent({ appUrl, deviceToken, body });
    if (!call.ok) return { ok: false, error: call.error || "browser_agent_failed", status: call.status };

    let toolCall = null;
    let awaitingMessages = null;
    let textResponse = "";
    let isComplete = false;

    try {
      await readSse(call.res, (ev) => {
        if (!ev || typeof ev !== "object") return;
        if (ev.type === "text" && typeof ev.text === "string") {
          textResponse += ev.text;
          accumulatedText += ev.text;
        } else if (ev.type === "tool_call") {
          toolCall = {
            toolUseId: ev.toolUseId,
            action: ev.action,
            coordinate: ev.coordinate,
            text: ev.text,
            key: ev.key,
            scrollDirection: ev.scrollDirection,
            scrollAmount: ev.scrollAmount,
            region: ev.region,
          };
          const progress = summarizeComputerUseToolCall(toolCall);
          if (progress) emitProgress(progress);
        } else if (ev.type === "awaiting_tool_result") {
          awaitingMessages = ev.messages;
        } else if (ev.type === "complete") {
          finalText = (ev.text || textResponse || "").trim();
          isComplete = true;
        } else if (ev.type === "error") {
          throw new Error(String(ev.error || "browser_agent_error"));
        }
      });
    } catch (e) {
      const err = e instanceof Error ? e : null;
      return { ok: false, error: err?.message || String(e) };
    }

    if (isComplete) break;
    if (!toolCall) {
      finalText = (textResponse || "").trim();
      break;
    }

    // Execute the Computer Use action locally.
    const action = String(toolCall.action || "");
    const params = {
      action,
      coordinate: toolCall.coordinate,
      text: toolCall.text,
      key: toolCall.key,
      scrollDirection: toolCall.scrollDirection,
      scrollAmount: toolCall.scrollAmount,
      region: toolCall.region,
      pageId,
    };

    // Track action for loop detection
    actionHistory.push({ action, coordinate: toolCall.coordinate, text: toolCall.text });

    let connectorResult = await computerUseAction(params);

    // Auto-login is handled inside computerUseScreenshot (browser.mjs) now.
    // For non-screenshot actions, take a follow-up screenshot.
    if (action !== "screenshot") {
      // For non-screenshot actions, always take a follow-up screenshot so Claude
      // can see the result of the action (clicks, typing, scrolling, wait, etc.).
      try {
        const followUp = await computerUseAction({ action: "screenshot", pageId });
        if (followUp?.ok && followUp.screenshot) {
          connectorResult = {
            ...connectorResult,
            screenshot: followUp.screenshot,
            screenshotMediaType: followUp.screenshotMediaType || connectorResult.screenshotMediaType,
            url: followUp.url || connectorResult.url,
            title: followUp.title || connectorResult.title,
          };
        }
      } catch {
        // If follow-up screenshot fails, still return the original result
      }
    }

    // If scroll didn't move, add a lightweight hint (but don't spam notes every time).
    if (action === "scroll" && connectorResult?.ok && connectorResult?.scrolled === false && !connectorResult?.note) {
      connectorResult = {
        ...connectorResult,
        note: "Scroll had no visible effect (already at boundary or wrong scroll container). Try scrolling a different area, or use PageDown/Space, or click inside the scrollable panel first.",
      };
    }

    // No-progress detection: only count no-progress when Claude did a real action
    // (click/type/scroll/key), not when it just takes screenshots or waits.
    const isPassiveAction = action === "screenshot" || action === "wait";
    if (connectorResult?.screenshot && !isPassiveAction) {
      const curUrl = connectorResult.url || lastPageUrl;
      const curTitle = connectorResult.title || lastPageTitle;
      if (
        lastScreenshot &&
        connectorResult.screenshot === lastScreenshot &&
        curUrl === lastPageUrl &&
        curTitle === lastPageTitle
      ) {
        sameViewStreak += 1;
      } else {
        sameViewStreak = 0;
      }
    }

    // --- Loop detection: if stuck, inject a note and force bail ---
    // sameViewStreak >= 4: after 4 consecutive real actions with no page change
    if (isStuckInLoop() || sameViewStreak >= 4) {
      const stuckReason = sameViewStreak >= 4 ? "NO_PROGRESS" : "REPEATED_ACTIONS";
      console.warn(`[browser-task] Loop detected at iteration ${iteration}: ${JSON.stringify(actionHistory.slice(-LOOP_WINDOW))}`);
      // Give Claude one last chance with an explicit "you are stuck" note
      connectorResult = {
        ...connectorResult,
        note:
          stuckReason === "NO_PROGRESS"
            ? "CRITICAL: The screenshot/URL/title have not changed for multiple steps (no visible progress). You MUST stop using tools and provide a final answer now. Summarize what you attempted, what you see on screen, and what is blocking progress (e.g. login wall, MFA/CAPTCHA, broken page, blank/black screen)."
            : "CRITICAL: You are repeating the same actions in a loop and making no progress. You MUST stop using tools and provide a final answer now. Summarize what you were able to accomplish and report any issues (e.g. login page that could not be passed).",
      };
      // Set this as the tool result and do one final API call to get a text response
      if (awaitingMessages) previousMessages = trimBrowserAgentMessages(awaitingMessages);
      pendingToolResult = {
        toolUseId: toolCall.toolUseId,
        result: connectorResult,
      };
      // Force one more call then break regardless
      const bailBody = {
        previousMessages: trimBrowserAgentMessages(awaitingMessages || previousMessages),
        toolResult: pendingToolResult,
      };
      const bailCall = await postBrowserAgent({ appUrl, deviceToken, body: bailBody }).catch(() => null);
      if (bailCall?.ok) {
        try {
          await readSse(bailCall.res, (ev) => {
            if (ev?.type === "text" && typeof ev.text === "string") {
              accumulatedText += ev.text;
              finalText += ev.text;
            } else if (ev?.type === "complete") {
              finalText = (ev.text || finalText || "").trim();
            }
          });
        } catch {}
      }
      if (!finalText) finalText = `Browser task stuck in a loop after ${iteration} iterations. The page may require manual intervention.`;
      break;
    }

    // Track the latest screenshot for the final result (so the dashboard can display it)
    if (connectorResult?.screenshot) {
      lastScreenshot = connectorResult.screenshot;
      lastPageUrl = connectorResult.url || lastPageUrl;
      lastPageTitle = connectorResult.title || lastPageTitle;
    }

    if (awaitingMessages) previousMessages = trimBrowserAgentMessages(awaitingMessages);
    pendingToolResult = {
      toolUseId: toolCall.toolUseId,
      result: connectorResult,
    };
  }

  const text = (finalText || accumulatedText || "").trim();
  if (iteration >= maxIterations && !finalText) {
    return {
      ok: false,
      error: `browser_task exceeded ${maxIterations} iterations (likely stuck).`,
      text,
      screenshot: lastScreenshot,
      pageUrl: lastPageUrl,
      pageTitle: lastPageTitle,
      meta: { iterations: iteration, startUrl: targetUrl, profileName },
    };
  }

  return {
    ok: true,
    text,
    screenshot: lastScreenshot,
    pageUrl: lastPageUrl,
    pageTitle: lastPageTitle,
    meta: { iterations: iteration, startUrl: targetUrl, profileName },
  };
}

