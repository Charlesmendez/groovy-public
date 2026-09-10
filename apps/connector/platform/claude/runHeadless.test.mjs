import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeArgs,
  classifyHeadlessRunError,
  extractHeadlessRunError,
  extractHeadlessSessionId,
  hasHeadlessExecutionActivity,
  runHeadlessClaudeWithResumeRecovery,
  sanitizeHeadlessDiagnostic,
  shouldRetryHeadlessClaudeWithoutResume,
} from "./runHeadless.mjs";

function resultEvent(overrides = {}) {
  return {
    type: "result",
    is_error: true,
    subtype: "error_during_execution",
    ...overrides,
  };
}

test("read-only Claude runs cannot bypass permissions or expose write tools", () => {
  const args = buildClaudeArgs({
    prompt: "Inspect the repository",
    readOnly: true,
    allowedTools: "Read,Edit,Bash,Write",
    sessionId: "session-1",
  });
  assert.deepEqual(
    args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "plan"],
  );
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(args.includes("Read,Grep,Glob"), true);
  assert.deepEqual(args.slice(-2), ["--resume", "session-1"]);
});

test("Vercel read-only Claude runs allow diagnostics without edit or arbitrary shell tools", () => {
  const args = buildClaudeArgs({
    prompt: "Inspect the latest Vercel deployment",
    readOnly: true,
    externalAccess: "vercel_read",
    allowedTools: "Read,Edit,Bash,Write",
  });
  const allowedTools = args[args.indexOf("--allowedTools") + 1];
  assert.match(allowedTools, /Bash\(vercel project inspect\*\)/);
  assert.match(allowedTools, /Bash\(vercel logs\*\)/);
  assert.doesNotMatch(allowedTools, /(?:^|,)Edit(?:,|$)/);
  assert.doesNotMatch(allowedTools, /(?:^|,)Write(?:,|$)/);
  assert.doesNotMatch(allowedTools, /Bash(?:,|$)/);
  assert.deepEqual(
    args.slice(
      args.indexOf("--permission-mode"),
      args.indexOf("--permission-mode") + 2,
    ),
    ["--permission-mode", "dontAsk"],
  );
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("a zero-activity resume failure retries once as a fresh session", async () => {
  const calls = [];
  const run = async (options) => {
    calls.push(options);
    if (calls.length === 1) {
      return {
        code: 1,
        stderr: "",
        streamEvents: [resultEvent()],
      };
    }
    return {
      code: 0,
      stderr: "",
      streamEvents: [
        {
          type: "result",
          is_error: false,
          result: "Repository inspected.",
          session_id: "fresh-session",
        },
      ],
    };
  };

  const output = await runHeadlessClaudeWithResumeRecovery(
    {
      prompt: "Inspect",
      sessionId: "deleted-session",
      readOnly: true,
      planMode: false,
      timeoutMs: 30_000,
    },
    { run },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionId, "deleted-session");
  assert.equal(calls[1].sessionId, undefined);
  assert.equal(calls[1].readOnly, true);
  assert.equal(calls[1].planMode, false);
  assert.equal(output.resumeRecovery.attempted, true);
  assert.equal(output.resumeRecovery.recovered, true);
});

test("resume recovery never retries after assistant or tool activity", async () => {
  const activeFailure = {
    code: 1,
    streamEvents: [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "package.json" },
            },
          ],
        },
      },
      resultEvent(),
    ],
  };
  assert.equal(hasHeadlessExecutionActivity(activeFailure), true);
  assert.equal(
    shouldRetryHeadlessClaudeWithoutResume(activeFailure, {
      sessionId: "session-1",
    }),
    false,
  );

  let calls = 0;
  await runHeadlessClaudeWithResumeRecovery(
    { prompt: "Inspect", sessionId: "session-1" },
    {
      run: async () => {
        calls += 1;
        return activeFailure;
      },
    },
  );
  assert.equal(calls, 1);
});

test("timeouts and aborts are left to the existing continuation policy", () => {
  assert.equal(
    shouldRetryHeadlessClaudeWithoutResume(
      { code: 1, timedOut: true, streamEvents: [] },
      { sessionId: "session-1" },
    ),
    false,
  );
  assert.equal(
    shouldRetryHeadlessClaudeWithoutResume(
      { code: 1, aborted: true, streamEvents: [] },
      { sessionId: "session-1" },
    ),
    false,
  );
});

test("known auth failures do not discard a valid resume session", () => {
  assert.equal(
    shouldRetryHeadlessClaudeWithoutResume(
      {
        code: 1,
        streamEvents: [
          resultEvent({
            errors: [{ message: "Authentication failed: login required" }],
          }),
        ],
      },
      { sessionId: "session-1" },
    ),
    false,
  );
});

test("session ids emitted before a timeout remain available for continuation", () => {
  assert.equal(
    extractHeadlessSessionId({
      streamEvents: [
        {
          type: "system",
          subtype: "init",
          session_id: "started-session",
        },
      ],
    }),
    "started-session",
  );
});

test("structured CLI errors become actionable, sanitized diagnostics", () => {
  const normalized = extractHeadlessRunError(
    {
      code: 1,
      stderr: "",
      streamEvents: [
        resultEvent({
          errors: [
            {
              message:
                "Authentication failed: CLAUDE_CODE_OAUTH_TOKEN=secret-value",
            },
          ],
        }),
      ],
    },
    { provider: "claude" },
  );
  assert.equal(normalized.code, "auth_required");
  assert.match(normalized.message, /Authentication failed/);
  assert.doesNotMatch(normalized.message, /secret-value/);
  assert.equal(
    sanitizeHeadlessDiagnostic("Bearer very-secret-token"),
    "Bearer [redacted]",
  );
});

test("generic empty result errors retain exit and subtype evidence", () => {
  const normalized = extractHeadlessRunError(
    {
      code: 1,
      stderr: "",
      streamEvents: [resultEvent()],
    },
    { provider: "claude" },
  );
  assert.equal(normalized.code, "claude_cli_failed");
  assert.match(normalized.message, /error_during_execution/);
  assert.match(normalized.message, /exit code 1/);
});

test("missing worker workspaces are classified clearly without falling back to home", () => {
  const normalized = classifyHeadlessRunError(
    "worker_workspace_unavailable: /old/missing/path",
    "codex",
  );
  assert.equal(normalized.code, "workspace_unavailable");
  assert.match(normalized.message, /configured worker workspace/i);
  assert.equal(normalized.message.includes("/old/missing"), false);
});

test("Vercel tokens are redacted from headless diagnostics", () => {
  assert.equal(
    sanitizeHeadlessDiagnostic("VERCEL_TOKEN=very-secret-value"),
    "VERCEL_TOKEN=[redacted]",
  );
  assert.equal(
    sanitizeHeadlessDiagnostic("vercel inspect --token very-secret-value"),
    "vercel inspect --token [redacted]",
  );
  assert.equal(
    sanitizeHeadlessDiagnostic('{"VERCEL_TOKEN":"very-secret-value"}'),
    '{"VERCEL_TOKEN":"[redacted]"}',
  );
});
