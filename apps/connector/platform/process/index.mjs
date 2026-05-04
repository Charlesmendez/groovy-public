import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { isWindows } from "../detect.mjs";

const execFileAsync = promisify(execFile);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseNumericLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map((line) => Number(line))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function toPowerShellSingleQuoted(value) {
  return String(value || "").replace(/'/g, "''");
}

export async function listPidsByCommandFragment(commandFragment, options = {}) {
  const fragment = String(commandFragment || "").trim();
  if (!fragment) return [];

  if (isWindows) {
    const processNameRegex =
      typeof options.processNameRegex === "string" && options.processNameRegex.trim()
        ? options.processNameRegex.trim()
        : typeof options.processNameFilter === "string" && options.processNameFilter.trim()
          ? options.processNameFilter.trim()
          : "";

    const safeFragment = toPowerShellSingleQuoted(fragment);
    const nameClause = processNameRegex
      ? `$_.Name -match '${toPowerShellSingleQuoted(processNameRegex)}' -and `
      : "";

    // NOTE: use case-insensitive substring matching without PowerShell wildcard semantics.
    const script =
      `$needle='${safeFragment}'; ` +
      `$needleLower=$needle.ToLowerInvariant(); ` +
      `Get-CimInstance Win32_Process | ` +
      `Where-Object { ${nameClause}$_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needleLower) } | ` +
      `Select-Object -ExpandProperty ProcessId`;

    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true, timeout: 7000, maxBuffer: 5 * 1024 * 1024 }
      );
      return parseNumericLines(stdout);
    } catch {
      return [];
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-ax", "-o", "pid=,command="],
      { timeout: 7000, maxBuffer: 5 * 1024 * 1024 }
    );

    const includeRegex =
      typeof options.processNameRegex === "string" && options.processNameRegex.trim()
        ? new RegExp(options.processNameRegex, "i")
        : null;

    const out = [];
    for (const rawLine of String(stdout || "").split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const firstSpace = line.indexOf(" ");
      if (firstSpace <= 0) continue;
      const pidText = line.slice(0, firstSpace).trim();
      const command = line.slice(firstSpace + 1);
      if (!command.includes(fragment)) continue;
      if (includeRegex && !includeRegex.test(command)) continue;
      const pid = Number(pidText);
      if (!Number.isFinite(pid) || pid <= 1) continue;
      out.push(pid);
    }
    return out;
  } catch {
    return [];
  }
}

export async function killProcessTree(pid, options = {}) {
  const targetPid = Number(pid);
  if (!Number.isFinite(targetPid) || targetPid <= 0) return false;

  if (isWindows) {
    try {
      await execFileAsync("taskkill", ["/F", "/T", "/PID", String(targetPid)], {
        windowsHide: true,
        timeout: Math.max(1000, Number(options.timeoutMs) || 5000),
      });
      return true;
    } catch {
      try {
        process.kill(targetPid);
        return true;
      } catch {
        return false;
      }
    }
  }

  const graceMs = Math.max(100, Number(options.graceMs) || 800);
  try {
    process.kill(targetPid, "SIGTERM");
  } catch {
    // ignore
  }
  await sleep(graceMs);
  try {
    process.kill(targetPid, "SIGKILL");
  } catch {
    // ignore
  }
  return true;
}

export async function killProcessesByCommandFragment(commandFragment, options = {}) {
  const pids = await listPidsByCommandFragment(commandFragment, options);
  const unique = Array.from(new Set(pids));
  let killed = 0;

  for (const pid of unique) {
    if (Number(options.excludePid) === pid) continue;
    const ok = await killProcessTree(pid, options);
    if (ok) killed += 1;
  }
  return { matched: unique.length, killed, pids: unique };
}

export async function removeSingletonLocks(baseDir, options = {}) {
  const root = String(baseDir || "").trim();
  if (!root) return 0;

  const names = Array.isArray(options.lockNames) && options.lockNames.length
    ? options.lockNames
    : ["SingletonLock", "SingletonCookie", "SingletonSocket"];

  let removed = 0;
  for (const name of names) {
    try {
      const p = path.join(root, name);
      await import("fs").then(({ promises }) => promises.unlink(p));
      removed += 1;
    } catch {
      // ignore missing/locked
    }
  }
  return removed;
}
