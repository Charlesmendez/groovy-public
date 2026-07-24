import { BrowserWindow, net, Notification } from "electron";
import log from "electron-log/main";
import {
  UiRevisionState,
  type HostedUiUpdateStatus,
} from "./uiRevisionState";

const CHECK_INTERVAL_MS = 2 * 60 * 1000;

type StatusListener = (status: HostedUiUpdateStatus) => void;

function statusesEqual(a: HostedUiUpdateStatus, b: HostedUiUpdateStatus): boolean {
  return a.state === b.state && (a.revision || null) === (b.revision || null);
}

/**
 * Keeps the hosted renderer on the latest deployed revision.
 *
 * A detected revision remains pending until reloadIgnoringCache() finishes.
 * While the window is focused the renderer receives a persistent status so it
 * can offer an explicit refresh action. If the window is backgrounded, the
 * pending update is applied automatically.
 */
export class HostedUiUpdater {
  private readonly revisions = new UiRevisionState();
  private readonly listeners = new Set<StatusListener>();
  private status: HostedUiUpdateStatus = { state: "idle" };
  private win: BrowserWindow | null = null;
  private origin = "";
  private timer: NodeJS.Timeout | null = null;
  private versionCheckInFlight = false;
  private notifiedRevision: string | null = null;
  private detachWindowListeners: (() => void) | null = null;

  attach(win: BrowserWindow, origin: string) {
    this.detach();
    this.win = win;
    this.origin = origin;

    const onDidFinishLoad = () => {
      const completedRevision = this.revisions.completeReload();
      if (completedRevision) {
        this.notifiedRevision = null;
        log.info(`[ui-updater] loaded hosted revision ${completedRevision}`);
      }
      this.publishStatus();
      void this.check();
    };
    const onDidFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean
    ) => {
      if (!isMainFrame || this.revisions.getStatus().state !== "reloading") return;
      log.warn(`[ui-updater] reload failed (${errorCode}): ${errorDescription}`);
      this.revisions.failReload();
      this.publishStatus();
    };
    const onFocus = () => void this.check();
    const onBlur = () => this.reloadPending();
    const onHide = () => this.reloadPending();
    const onClosed = () => this.detach();

    win.webContents.on("did-finish-load", onDidFinishLoad);
    win.webContents.on("did-fail-load", onDidFailLoad);
    win.on("focus", onFocus);
    win.on("blur", onBlur);
    win.on("hide", onHide);
    win.on("closed", onClosed);

    this.detachWindowListeners = () => {
      if (!win.isDestroyed()) {
        win.webContents.off("did-finish-load", onDidFinishLoad);
        win.webContents.off("did-fail-load", onDidFailLoad);
        win.off("focus", onFocus);
        win.off("blur", onBlur);
        win.off("hide", onHide);
        win.off("closed", onClosed);
      }
    };

    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  detach() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.detachWindowListeners?.();
    this.detachWindowListeners = null;
    this.win = null;
    this.origin = "";
    this.versionCheckInFlight = false;
  }

  getStatus(): HostedUiUpdateStatus {
    return this.status;
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async check(): Promise<void> {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.origin || this.versionCheckInFlight) return;
    this.versionCheckInFlight = true;
    try {
      const response = await net.fetch(`${this.origin}/api/app-version`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      if (!response.ok) {
        log.debug(`[ui-updater] revision check returned HTTP ${response.status}`);
        return;
      }

      const payload = (await response.json()) as { revision?: unknown };
      const revision =
        typeof payload.revision === "string" ? payload.revision.trim() : "";
      this.revisions.observe(revision);
      this.publishStatus();

      if (this.revisions.getStatus().state !== "ready") return;
      if (!win.isVisible() || !win.isFocused()) {
        this.reloadPending();
        return;
      }
      this.showReadyNotification(revision);
    } catch (error) {
      log.debug(
        `[ui-updater] revision check failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      this.versionCheckInFlight = false;
    }
  }

  reloadNow(): void {
    this.reloadPending();
  }

  private reloadPending() {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const revision = this.revisions.beginReload();
    if (!revision) return;

    log.info(`[ui-updater] reloading hosted revision ${revision}`);
    this.publishStatus();
    win.webContents.reloadIgnoringCache();
  }

  private showReadyNotification(revision: string) {
    if (
      !revision ||
      !Notification.isSupported() ||
      this.notifiedRevision === revision
    ) {
      return;
    }
    this.notifiedRevision = revision;
    const notification = new Notification({
      title: "Groovy interface update ready",
      body: "The latest Groovy interface is ready. Click to refresh now.",
    });
    notification.on("click", () => this.reloadNow());
    notification.show();
  }

  private publishStatus() {
    const next = this.revisions.getStatus();
    if (statusesEqual(this.status, next)) return;
    this.status = next;
    for (const listener of this.listeners) listener(next);
  }
}
