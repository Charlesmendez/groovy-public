export function resolveScheduledBrowserTaskTimeoutMs(params = {}, env = process.env) {
  const requestedTimeoutMs = Number(params?.timeout_ms);
  const envBrowserTimeoutMs = Number(
    env?.GROOVY_BROWSER_TASK_TIMEOUT_MS || env?.GROOVY_PLAYWRIGHT_TIMEOUT_MS || ""
  );

  if (Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0) {
    return requestedTimeoutMs;
  }
  if (Number.isFinite(envBrowserTimeoutMs) && envBrowserTimeoutMs > 0) {
    return envBrowserTimeoutMs;
  }
  return 12 * 60 * 1000;
}

export async function runScheduledBrowserTask(
  params = {},
  {
    browserTaskRuntime,
    isPlaywrightAvailable,
    runBrowserTaskViaPlaywright,
    env = process.env,
  }
) {
  const p = params && typeof params === "object" ? params : {};
  const runtime =
    browserTaskRuntime && typeof browserTaskRuntime === "object"
      ? { ...browserTaskRuntime }
      : {};
  const task = String(p.task || "").trim();
  const startUrl =
    typeof p.start_url === "string"
      ? p.start_url
      : typeof p.startUrl === "string"
        ? p.startUrl
        : undefined;
  const profileName = typeof p.profile_name === "string" ? p.profile_name : "default";
  const apiKey = typeof p.api_key === "string" ? p.api_key.trim() : "";
  const cliToken = typeof p.cli_token === "string" ? p.cli_token.trim() : "";
  const timeoutMs = resolveScheduledBrowserTaskTimeoutMs(p, env);

  const usePlaywright = await isPlaywrightAvailable(runtime);
  if (!usePlaywright) {
    return {
      ok: false,
      error: "playwright_mcp_unavailable",
      message:
        `Browser automation requires ${runtime.provider === "codex" ? "Codex CLI plus Playwright" : "Claude Code plus Playwright MCP"}. Install the selected browser runtime and retry.`,
    };
  }

  return await runBrowserTaskViaPlaywright({
    ...runtime,
    task,
    start_url: startUrl,
    api_key: apiKey,
    cli_token: cliToken,
    timeout_ms: timeoutMs,
    profile_name: profileName,
  });
}
