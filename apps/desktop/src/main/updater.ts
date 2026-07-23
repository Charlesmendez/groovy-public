/**
 * Auto-updates via electron-updater against the license-gated generic feed
 * <GROOVY_APP_URL>/api/updates/desktop-feed (served by the web app).
 *
 * Auth: the feed requires the connector's device token (x-device-token). The
 * token is re-read from ~/.groovy/connector.json before every check; when the
 * connector is not paired yet we simply skip the check.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Notification } from "electron";
import log from "electron-log/main";
import { autoUpdater } from "electron-updater";
import { appOrigin } from "./window";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export type UpdateState = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

export type UpdateStatus = {
  state: UpdateState;
  version?: string | null;
  percent?: number | null;
  error?: string | null;
};

type StatusListener = (status: UpdateStatus) => void;

/** Errors that really mean "the feed had no update for us" (e.g. empty 204). */
function isNoUpdateAvailableError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ERR_UPDATER_INVALID_UPDATE_INFO") return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    message.includes("ERR_UPDATER_INVALID_UPDATE_INFO") ||
    /unable to find latest version/i.test(message) ||
    /No published versions/i.test(message)
  );
}

function readDeviceToken(): string | null {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".groovy", "connector.json"), "utf8")
    ) as { device_token?: unknown };
    return typeof cfg.device_token === "string" && cfg.device_token ? cfg.device_token : null;
  } catch {
    return null;
  }
}

export class Updater {
  private listeners = new Set<StatusListener>();
  private status: UpdateStatus = { state: "idle" };
  private timer: NodeJS.Timeout | null = null;
  private installInProgress = false;
  private notifiedVersion: string | null = null;

  constructor(private beforeInstall: () => Promise<void>) {
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    // Installation must go through quitAndInstall(), which removes the bundled
    // connector LaunchAgent before Squirrel replaces /Applications/Groovy.app.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.setFeedURL({
      provider: "generic",
      url: `${appOrigin()}/api/updates/desktop-feed`,
    });

    autoUpdater.on("checking-for-update", () => this.setStatus({ state: "checking" }));
    autoUpdater.on("update-available", (info) =>
      this.setStatus({ state: "available", version: info?.version || null })
    );
    autoUpdater.on("update-not-available", () => this.setStatus({ state: "idle" }));
    autoUpdater.on("download-progress", (progress) =>
      this.setStatus({
        state: "downloading",
        version: this.status.version || null,
        percent: typeof progress?.percent === "number" ? progress.percent : null,
      })
    );
    autoUpdater.on("update-downloaded", (info) => {
      const version = info?.version || null;
      this.setStatus({ state: "ready", version });
      this.showReadyNotification(version);
    });
    autoUpdater.on("error", (err) => {
      if (isNoUpdateAvailableError(err)) {
        // Empty/204 feed responses (unpaired or unlicensed clients) surface as
        // ERR_UPDATER_INVALID_UPDATE_INFO — that just means "no update".
        this.setStatus({ state: "idle" });
        return;
      }
      this.setStatus({ state: "error", error: err?.message || String(err) });
    });
  }

  private showReadyNotification(version: string | null) {
    if (!Notification.isSupported() || (version && this.notifiedVersion === version)) return;
    this.notifiedVersion = version;
    const notification = new Notification({
      title: "Groovy update ready",
      body: `${version ? `Version ${version} is` : "A new version is"} ready with the latest connector. Click to install and reopen Groovy.`,
      silent: false,
    });
    notification.on("click", () => void this.quitAndInstall());
    notification.show();
  }

  private setStatus(status: UpdateStatus) {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Check on launch + every 6h. */
  startSchedule() {
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  stopSchedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    const token = readDeviceToken();
    if (!token) {
      log.info("[updater] no device token yet; skipping update check");
      return;
    }
    autoUpdater.requestHeaders = { "x-device-token": token };
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      if (isNoUpdateAvailableError(err)) {
        this.setStatus({ state: "idle" });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[updater] check failed: ${message}`);
      this.setStatus({ state: "error", error: message });
    }
  }

  async quitAndInstall(): Promise<void> {
    if (this.status.state !== "ready" || this.installInProgress) return;
    this.installInProgress = true;
    try {
      await this.beforeInstall();
      // isSilent=false, isForceRunAfter=true: show normal installer behavior
      // and relaunch Groovy even when the user's login-item setting is off.
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      this.installInProgress = false;
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[updater] install preparation failed: ${message}`);
      this.setStatus({ state: "error", version: this.status.version, error: message });
    }
  }
}
