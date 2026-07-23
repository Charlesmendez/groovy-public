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

export function summarizeProcessTreeMemory(records, rootPid) {
  const targetPid = Number(rootPid);
  if (!Number.isFinite(targetPid) || targetPid <= 0 || !Array.isArray(records)) return null;

  const normalized = records
    .map((record) => ({
      pid: Number(record?.pid),
      parentPid: Number(record?.parentPid),
      rssBytes: Math.max(0, Number(record?.rssBytes) || 0),
    }))
    .filter((record) => Number.isFinite(record.pid) && record.pid > 0);
  if (!normalized.some((record) => record.pid === targetPid)) return null;

  const childrenByParent = new Map();
  for (const record of normalized) {
    const children = childrenByParent.get(record.parentPid) || [];
    children.push(record.pid);
    childrenByParent.set(record.parentPid, children);
  }
  const recordByPid = new Map(normalized.map((record) => [record.pid, record]));
  const pending = [targetPid];
  const visited = new Set();
  let totalRssBytes = 0;
  let maxRssBytes = 0;

  while (pending.length > 0) {
    const pid = pending.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const record = recordByPid.get(pid);
    if (record) {
      totalRssBytes += record.rssBytes;
      maxRssBytes = Math.max(maxRssBytes, record.rssBytes);
    }
    for (const childPid of childrenByParent.get(pid) || []) pending.push(childPid);
  }

  return {
    rootPid: targetPid,
    processCount: visited.size,
    totalRssBytes,
    maxRssBytes,
  };
}

export async function getProcessTreeMemory(rootPid) {
  const targetPid = Number(rootPid);
  if (!Number.isFinite(targetPid) || targetPid <= 0) return null;

  try {
    if (isWindows) {
      const script =
        "Get-CimInstance Win32_Process | ForEach-Object { " +
        "Write-Output (\"{0}|{1}|{2}\" -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize) }";
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true, timeout: 7000, maxBuffer: 5 * 1024 * 1024 }
      );
      const records = String(stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim().split("|").map(Number))
        .filter((parts) => parts.length === 3 && parts.every(Number.isFinite))
        .map(([pid, parentPid, rssBytes]) => ({ pid, parentPid, rssBytes }));
      return summarizeProcessTreeMemory(records, targetPid);
    }

    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,ppid=,rss="], {
      timeout: 7000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const records = String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((parts) => parts.length === 3 && parts.every(Number.isFinite))
      .map(([pid, parentPid, rssKb]) => ({
        pid,
        parentPid,
        rssBytes: rssKb * 1024,
      }));
    return summarizeProcessTreeMemory(records, targetPid);
  } catch {
    return null;
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
