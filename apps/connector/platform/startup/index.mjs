import os from "os";
import path from "path";
import { promises as fsp } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { isWindows } from "../detect.mjs";

const execFileAsync = promisify(execFile);

function quoteCmdArg(value) {
  // Always quote for CMD safety:
  // - avoids metacharacter injection (& | < > ( ) etc)
  // - preserves spaces
  // - prevents accidental %VAR% expansion by escaping %
  let s = String(value ?? "");
  if (!s) return '""';
  // Prevent line breaks from injecting new commands in .cmd files.
  s = s.replace(/[\r\n]+/g, " ");
  // Escape percent expansion in batch.
  s = s.replace(/%/g, "%%");
  // Escape embedded quotes (best-effort; should be rare in our inputs).
  s = s.replace(/"/g, '""');
  return `"${s}"`;
}

async function writeWindowsShim({ nodeExe, connectorScript, relayUrl, extraArgs }) {
  const groovyDir = path.join(os.homedir(), ".groovy");
  await fsp.mkdir(groovyDir, { recursive: true });
  const shimPath = path.join(groovyDir, "connector-startup.cmd");
  const logPath = path.join(groovyDir, "connector.log");

  const args = [
    quoteCmdArg(nodeExe),
    quoteCmdArg(connectorScript),
    "--relay",
    quoteCmdArg(relayUrl),
    ...(Array.isArray(extraArgs) ? extraArgs.map((arg) => quoteCmdArg(arg)) : []),
  ];

  const lines = [
    "@echo off",
    "setlocal",
    `if not exist ${quoteCmdArg(groovyDir)} mkdir ${quoteCmdArg(groovyDir)} >nul 2>&1`,
    "set GROOVY_CONNECTOR_SUPERVISED=1",
    ":restart",
    `echo [startup] %date% %time% starting connector >> ${quoteCmdArg(logPath)}`,
    `${args.join(" ")} >> ${quoteCmdArg(logPath)} 2>&1`,
    "set EXIT_CODE=%ERRORLEVEL%",
    `echo [startup] %date% %time% connector exited with code %EXIT_CODE% >> ${quoteCmdArg(logPath)}`,
    "if \"%GROOVY_CONNECTOR_NO_SUPERVISE%\"==\"1\" exit /b %EXIT_CODE%",
    "timeout /t 5 /nobreak >nul",
    "goto restart",
    "",
  ];
  await fsp.writeFile(shimPath, lines.join("\r\n"), "utf8");
  return shimPath;
}

async function installWindowsTaskScheduler({ taskName, shimPath }) {
  const runTarget = quoteCmdArg(shimPath);
  await execFileAsync(
    "schtasks",
    ["/create", "/f", "/sc", "ONLOGON", "/tn", taskName, "/tr", runTarget],
    { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }
  );
}

async function installWindowsStartupFolderShim({ shimPath, fileName = "Groovy Connector.cmd" }) {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("missing_APPDATA");
  }
  const startupDir = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  await fsp.mkdir(startupDir, { recursive: true });
  const shortcutShim = path.join(startupDir, fileName);
  const content = `@echo off\r\ncall ${quoteCmdArg(shimPath)}\r\n`;
  await fsp.writeFile(shortcutShim, content, "utf8");
  return shortcutShim;
}

export async function installWindowsStartupArtifacts(options = {}) {
  if (!isWindows) return { ok: false, reason: "not_windows" };

  const logger = typeof options.log === "function" ? options.log : () => {};
  const taskName = String(options.taskName || "Groovy Connector");
  const nodeExe = String(options.nodeExe || process.execPath || "").trim();
  const connectorScriptRaw = String(options.connectorScript || "").trim();
  const connectorScript = connectorScriptRaw ? path.resolve(connectorScriptRaw) : "";
  const relayUrl = String(options.relayUrl || "").trim();
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];

  if (!nodeExe || !connectorScript || !relayUrl) {
    return { ok: false, reason: "missing_startup_args" };
  }

  try {
    const shimPath = await writeWindowsShim({
      nodeExe,
      connectorScript,
      relayUrl,
      extraArgs,
    });

    try {
      await installWindowsTaskScheduler({ taskName, shimPath });
      logger("startup: installed Windows Task Scheduler auto-start", { taskName, shimPath });
      return { ok: true, method: "task_scheduler", shimPath, taskName };
    } catch (taskErr) {
      logger("startup: Task Scheduler install failed; falling back to Startup folder", {
        error: taskErr instanceof Error ? taskErr.message : String(taskErr),
      });
      const startupShimPath = await installWindowsStartupFolderShim({ shimPath });
      return { ok: true, method: "startup_folder", shimPath: startupShimPath };
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err || "startup_install_failed"),
    };
  }
}
