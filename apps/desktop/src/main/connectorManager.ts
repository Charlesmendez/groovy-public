/**
 * ConnectorManager — runs the bundled connector as a managed child process.
 *
 * - Spawns resources/connector/node/bin/node connector.mjs --relay <url>
 *   (the connector's native addons are built for the vanilla Node ABI, so we
 *   must NOT use utilityProcess/ELECTRON_RUN_AS_NODE).
 * - Env: GROOVY_MANAGED_BY_DESKTOP=1 (reported in capabilities) and
 *   GROOVY_CONNECTOR_NO_AUTO_UPDATE=1 (the desktop shell owns updates).
 * - Exponential backoff restart (1s → 60s, reset after 5 min healthy).
 * - pair(): stop → one-shot spawn with --pair CODE → poll
 *   ~/.groovy/connector.json for device_token + paired_user_id (90s timeout)
 *   → restart the normal child.
 * - Status: stdout markers + config polling.
 * - Logs: child stdout/stderr piped to ~/.groovy/desktop-connector.log via a
 *   dedicated electron-log instance.
 * - adoptStandalone(): if the standalone connector's LaunchAgent exists,
 *   bootout + remove it and run the connector as our child instead (the
 *   existing ~/.groovy/connector.json already carries the pairing).
 */

import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import log from "electron-log/main";
import { launchAgentInstalled, removeLaunchAgent } from "./launchAgent";
import { configuredAppUrl, configuredRelayUrl } from "./runtimeConfig";
import { groovyDir } from "./settings";

export function relayUrl(): string {
  return configuredRelayUrl();
}

export type ConnectorState = "stopped" | "starting" | "running" | "pairing" | "error";

export type ConnectorStatus = {
  state: ConnectorState;
  paired: boolean;
  pairedUserId: string | null;
  deviceId: string | null;
};

type ConnectorConfig = {
  device_token?: string;
  paired_user_id?: string;
};

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const HEALTHY_RESET_MS = 5 * 60_000;
const PAIR_TIMEOUT_MS = 90_000;
const CONFIG_POLL_MS = 5000;

function configPath(): string {
  return path.join(os.homedir(), ".groovy", "connector.json");
}

function readConfig(): ConnectorConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as ConnectorConfig;
  } catch {
    return {};
  }
}

/** Best-effort device id from the relay device token JWT (sub claim). */
function deviceIdFromToken(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof json.sub === "string" && json.sub ? json.sub : null;
  } catch {
    return null;
  }
}

export class ConnectorManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: ConnectorState = "stopped";
  private desiredRunning = false;
  private backoffMs = BACKOFF_MIN_MS;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthyTimer: NodeJS.Timeout | null = null;
  private configTimer: NodeJS.Timeout | null = null;
  private pairing = false;
  private connectorLog: ReturnType<typeof log.create>;

  constructor(private connectorDir: string) {
    super();
    this.connectorLog = log.create({ logId: "connector" });
    this.connectorLog.transports.console.level = false;
    this.connectorLog.transports.file.resolvePathFn = () =>
      path.join(groovyDir(), "desktop-connector.log");
    this.connectorLog.transports.file.maxSize = 10 * 1024 * 1024;
  }

  private get nodeBin(): string {
    return path.join(this.connectorDir, "node", "bin", "node");
  }

  get nodeBinPath(): string {
    return this.nodeBin;
  }

  get dir(): string {
    return this.connectorDir;
  }

  getStatus(): ConnectorStatus {
    const cfg = readConfig();
    const paired = !!(cfg.device_token && cfg.paired_user_id);
    return {
      state: this.state,
      paired,
      pairedUserId: typeof cfg.paired_user_id === "string" ? cfg.paired_user_id : null,
      deviceId: deviceIdFromToken(cfg.device_token),
    };
  }

  private setState(state: ConnectorState) {
    if (this.state === state) return;
    this.state = state;
    this.emitStatus();
  }

  private emitStatus() {
    this.emit("status", this.getStatus());
  }

  /** Detect + dissolve a standalone connector install, then run as child. */
  async adoptStandalone(): Promise<void> {
    if (launchAgentInstalled()) {
      log.info("[connector] standalone LaunchAgent detected; adopting");
      await removeLaunchAgent();
    }
  }

  start(): void {
    this.desiredRunning = true;
    this.startConfigPolling();
    if (!fs.existsSync(this.nodeBin)) {
      log.error(
        `[connector] bundled node runtime not found at ${this.nodeBin} — ` +
          `run "npm run bundle-connector" (dev) or rebuild the app; connector disabled`
      );
      this.setState("error");
      return;
    }
    this.spawnChild();
  }

  private spawnChild(extraArgs: string[] = []): ChildProcess {
    this.clearRestartTimer();
    this.setState("starting");

    const args = [
      path.join(this.connectorDir, "connector.mjs"),
      "--relay",
      relayUrl(),
      // Desktop owns the connector lifecycle. Never let the bundled runtime
      // install its legacy self-managed LaunchAgent and race this child.
      "--no-autostart",
      ...extraArgs,
    ];
    log.info(`[connector] spawning ${this.nodeBin} ${args.join(" ")}`);
    const child = spawn(this.nodeBin, args, {
      cwd: this.connectorDir,
      env: {
        ...process.env,
        GROOVY_APP_URL: configuredAppUrl(),
        GROOVY_RELAY_URL: relayUrl(),
        GROOVY_MANAGED_BY_DESKTOP: "1",
        GROOVY_CONNECTOR_NO_AUTO_UPDATE: "1",
        ELECTRON_RUN_AS_NODE: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    const onLine = (line: string, isErr: boolean) => {
      if (!line.trim()) return;
      if (isErr) this.connectorLog.warn(line);
      else this.connectorLog.info(line);
      // stdout marker: "[connector] authenticated as device: <id>"
      if (/authenticated as device:/i.test(line)) {
        if (this.state !== "pairing") this.setState("running");
        this.emitStatus();
      }
    };
    const lineBuffer = (isErr: boolean) => {
      let buf = "";
      return (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) onLine(line, isErr);
      };
    };
    child.stdout?.on("data", lineBuffer(false));
    child.stderr?.on("data", lineBuffer(true));

    // Consider the child healthy after HEALTHY_RESET_MS of uptime.
    this.clearHealthyTimer();
    this.healthyTimer = setTimeout(() => {
      this.backoffMs = BACKOFF_MIN_MS;
    }, HEALTHY_RESET_MS);

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearHealthyTimer();
      log.info(`[connector] exited code=${code} signal=${signal}`);
      if (!this.desiredRunning || this.pairing) {
        this.setState("stopped");
        return;
      }
      this.setState("error");
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      log.info(`[connector] restarting in ${delay}ms`);
      this.restartTimer = setTimeout(() => {
        if (this.desiredRunning && !this.pairing) this.spawnChild();
      }, delay);
    });

    child.on("error", (err) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearHealthyTimer();
      log.error(`[connector] spawn error: ${err.message}`);
      this.setState("error");
      if (!this.desiredRunning || this.pairing) return;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      log.info(`[connector] restarting in ${delay}ms after spawn error`);
      this.restartTimer = setTimeout(() => {
        if (this.desiredRunning && !this.pairing) this.spawnChild();
      }, delay);
    });

    return child;
  }

  /**
   * Pair the connector: stop the managed child, run one connector instance
   * with --pair CODE (and optionally --allow-account-switch), wait until
   * ~/.groovy/connector.json contains device_token + paired_user_id, then
   * restart the normal child.
   */
  async pair(code: string, opts?: { allowAccountSwitch?: boolean }): Promise<void> {
    if (this.pairing) throw new Error("pairing_already_in_progress");
    if (!/^[A-Z0-9-]{4,32}$/i.test(code.trim())) throw new Error("invalid_pairing_code");
    this.pairing = true;
    this.setState("pairing");

    try {
      await this.stopChild();
      // Snapshot the pre-pair config so a stale pairing (already present
      // before we spawned the pair child) is never mistaken for success.
      const before = readConfig();
      const pairedFresh = (cfg: ConnectorConfig): boolean => {
        if (!cfg.device_token || !cfg.paired_user_id) return false;
        if (!before.device_token && !before.paired_user_id) return true;
        return (
          cfg.device_token !== before.device_token ||
          cfg.paired_user_id !== before.paired_user_id
        );
      };
      const args = ["--pair", code.trim()];
      if (opts?.allowAccountSwitch) args.push("--allow-account-switch");
      const pairChild = this.spawnChild(args);

      await new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const poll = setInterval(() => {
          if (pairedFresh(readConfig())) {
            cleanup();
            resolve();
            return;
          }
          if (Date.now() - startedAt > PAIR_TIMEOUT_MS) {
            cleanup();
            reject(new Error("pairing_timeout"));
          }
        }, 1000);
        const onExit = () => {
          // A paired connector keeps running; an early exit before the config
          // shows the pairing means it failed.
          setTimeout(() => {
            if (pairedFresh(readConfig())) {
              cleanup();
              resolve();
            } else {
              cleanup();
              reject(new Error("pairing_failed"));
            }
          }, 500);
        };
        pairChild.once("exit", onExit);
        const cleanup = () => {
          clearInterval(poll);
          pairChild.removeListener("exit", onExit);
        };
      });
    } finally {
      this.pairing = false;
      await this.stopChild();
      if (this.desiredRunning) this.spawnChild();
      else this.setState("stopped");
      this.emitStatus();
    }
  }

  async restart(): Promise<void> {
    this.backoffMs = BACKOFF_MIN_MS;
    await this.stopChild();
    if (this.desiredRunning) this.spawnChild();
  }

  /** SIGTERM, then SIGKILL after 5s. */
  private stopChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.clearRestartTimer();
    this.clearHealthyTimer();
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 5000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    this.stopConfigPolling();
    await this.stopChild();
    this.setState("stopped");
  }

  private startConfigPolling() {
    if (this.configTimer) return;
    let last = "";
    this.configTimer = setInterval(() => {
      const status = this.getStatus();
      const key = JSON.stringify(status);
      if (key !== last) {
        last = key;
        this.emit("status", status);
      }
    }, CONFIG_POLL_MS);
  }

  private stopConfigPolling() {
    if (this.configTimer) clearInterval(this.configTimer);
    this.configTimer = null;
  }

  private clearRestartTimer() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private clearHealthyTimer() {
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.healthyTimer = null;
  }
}
