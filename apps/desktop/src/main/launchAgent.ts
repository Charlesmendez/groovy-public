/**
 * LaunchAgent management for keeping the bundled connector running after the
 * app quits ("keep running in background").
 *
 * Uses the SAME label as the standalone connector install
 * (ai.gogroovy.connector) so at most one connector LaunchAgent ever exists;
 * the desktop app adopts/replaces a standalone install on startup
 * (see connectorManager.adoptStandalone).
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import log from "electron-log/main";

export const LAUNCH_AGENT_LABEL = "ai.gogroovy.connector";

export function launchAgentPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function launchctl(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile("launchctl", args, (err) => {
      if (err) log.warn(`[launchAgent] launchctl ${args.join(" ")} failed: ${err.message}`);
      resolve();
    });
  });
}

export function launchAgentInstalled(): boolean {
  return fs.existsSync(launchAgentPlistPath());
}

/**
 * Write + bootstrap a LaunchAgent that runs the APP-BUNDLED node + connector
 * with the managed-by-desktop env flags.
 */
export async function installLaunchAgent(args: {
  nodeBin: string;
  connectorDir: string;
  appUrl: string;
  relayUrl: string;
}): Promise<void> {
  const logPath = path.join(os.homedir(), ".groovy", "connector.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(args.nodeBin)}</string>
    <string>${xmlEscape(path.join(args.connectorDir, "connector.mjs"))}</string>
    <string>--relay</string>
    <string>${xmlEscape(args.relayUrl)}</string>
    <string>--no-autostart</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(args.connectorDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GROOVY_MANAGED_BY_DESKTOP</key>
    <string>1</string>
    <key>GROOVY_CONNECTOR_NO_AUTO_UPDATE</key>
    <string>1</string>
    <key>GROOVY_APP_URL</key>
    <string>${xmlEscape(args.appUrl)}</string>
    <key>GROOVY_RELAY_URL</key>
    <string>${xmlEscape(args.relayUrl)}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;

  const plistPath = launchAgentPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  // Remove any prior registration first (ignore failures).
  await launchctl(["bootout", `gui/${process.getuid?.() ?? 501}/${LAUNCH_AGENT_LABEL}`]);
  fs.writeFileSync(plistPath, plist, "utf8");
  await launchctl(["bootstrap", `gui/${process.getuid?.() ?? 501}`, plistPath]);
  log.info(`[launchAgent] installed ${plistPath}`);
}

/** Bootout + delete the LaunchAgent plist (no-op when absent). */
export async function removeLaunchAgent(): Promise<void> {
  const plistPath = launchAgentPlistPath();
  await launchctl(["bootout", `gui/${process.getuid?.() ?? 501}/${LAUNCH_AGENT_LABEL}`]);
  try {
    fs.rmSync(plistPath, { force: true });
    log.info(`[launchAgent] removed ${plistPath}`);
  } catch (err) {
    log.warn(`[launchAgent] failed to remove plist: ${String(err)}`);
  }
}
