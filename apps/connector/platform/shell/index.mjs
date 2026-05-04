import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import { isWindows } from "../detect.mjs";

const execFileAsync = promisify(execFile);

function normalizeWindowsEnv(rawEnv) {
  if (!isWindows) return rawEnv || {};

  const source = rawEnv || {};
  const env = {};
  let pathValue = "";

  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() === "path") {
      pathValue = String(value || "");
      continue;
    }
    env[key] = value;
  }

  if (!pathValue) {
    pathValue = process.env.Path || process.env.PATH || "";
  }
  env.Path = pathValue;
  return env;
}

export function augmentPathForPlatform(existingPath) {
  const sep = isWindows ? ";" : ":";
  const parts = String(existingPath || "")
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean);

  const extras = isWindows
    ? [
        process.env.LOCALAPPDATA
          ? path.join(process.env.LOCALAPPDATA, "Programs")
          : null,
        process.env.LOCALAPPDATA
          ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps")
          : null,
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "bin") : null,
      ].filter(Boolean)
    : [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        path.join(os.homedir(), ".local", "bin"),
        path.join(os.homedir(), "bin"),
      ];

  for (const entry of extras.slice().reverse()) {
    if (!parts.includes(entry)) parts.unshift(entry);
  }

  return parts.join(sep);
}

export function getPtyShellCandidates() {
  if (isWindows) {
    return [
      process.env.ComSpec,
      process.env.COMSPEC,
      "powershell.exe",
      "cmd.exe",
    ]
      .map((v) => (v ? String(v).trim() : ""))
      .filter(Boolean);
  }

  return [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"]
    .map((v) => (v ? String(v).trim() : ""))
    .filter(Boolean);
}

export async function execPortableCommand(command, options = {}) {
  const {
    cwd,
    env,
    timeout = 0,
    maxBuffer = 1024 * 1024,
    preferPowerShell = false,
    windowsHide = true,
  } = options;

  const safeEnv = normalizeWindowsEnv(env || process.env);

  if (isWindows) {
    if (preferPowerShell) {
      return execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", String(command || "")],
        { cwd, env: safeEnv, timeout, maxBuffer, windowsHide }
      );
    }

    const comSpec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    return execFileAsync(
      comSpec,
      ["/d", "/s", "/c", String(command || "")],
      { cwd, env: safeEnv, timeout, maxBuffer, windowsHide }
    );
  }

  return execFileAsync(
    "/bin/bash",
    ["-lc", String(command || "")],
    { cwd, env: safeEnv, timeout, maxBuffer }
  );
}

export function getShellForExec(command) {
  if (isWindows) {
    const comSpec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    return { executable: comSpec, args: ["/d", "/s", "/c", String(command || "")] };
  }
  return { executable: "/bin/bash", args: ["-lc", String(command || "")] };
}

export function prepareSpawnEnv(baseEnv = process.env) {
  const env = { ...(baseEnv || process.env) };
  const pathKey = isWindows ? "Path" : "PATH";
  const currentPath = env[pathKey] || env.PATH || env.Path || process.env[pathKey] || "";
  env[pathKey] = augmentPathForPlatform(currentPath);
  if (isWindows) {
    delete env.PATH;
  }
  return env;
}
