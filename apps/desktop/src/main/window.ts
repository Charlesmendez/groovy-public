/**
 * Main BrowserWindow loading the HOSTED Groovy web app.
 *
 * - Persistent session partition 'persist:groovy' (keeps the Supabase cookie
 *   session across launches).
 * - contextIsolation + sandbox on; nodeIntegration off. The preload only ever
 *   runs on the app origin: in-window navigation is restricted to the app
 *   origin and everything else opens in the default browser.
 * - Appends " GroovyDesktop/<version>" to the user agent so the web app can
 *   detect the shell (src/lib/desktop/shell.ts).
 */

import { app, BrowserWindow, net, Notification, session, shell } from "electron";
import * as path from "path";
import { configuredAppUrl } from "./runtimeConfig";

const PARTITION = "persist:groovy";
const UI_VERSION_CHECK_INTERVAL_MS = 2 * 60 * 1000;

export function appUrl(): string {
  return configuredAppUrl();
}

export function appOrigin(): string {
  return new URL(appUrl()).origin;
}

export function createMainWindow(): BrowserWindow {
  const ses = session.fromPartition(PARTITION);
  const userAgent = `${ses.getUserAgent()} GroovyDesktop/${app.getVersion()}`;
  ses.setUserAgent(userAgent);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    // Keep the native macOS title bar. It provides a reliable drag target and
    // prevents the traffic-light controls from overlapping the hosted app UI.
    titleBarStyle: "default",
    backgroundColor: "#09090b",
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--groovy-app-version=${app.getVersion()}`],
    },
  });

  win.once("ready-to-show", () => win.show());

  const origin = appOrigin();
  let deployedRevision: string | null = null;
  let notifiedRevision: string | null = null;
  let versionCheckInFlight = false;

  const reloadLatestUi = () => {
    if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
  };

  const checkForUiUpdate = async () => {
    if (win.isDestroyed() || versionCheckInFlight) return;
    versionCheckInFlight = true;
    try {
      const response = await net.fetch(`${origin}/api/app-version`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { revision?: unknown };
      const revision = typeof payload.revision === "string" ? payload.revision.trim() : "";
      if (!revision || revision === "local") return;
      if (!deployedRevision) {
        deployedRevision = revision;
        return;
      }
      if (revision === deployedRevision) return;
      deployedRevision = revision;

      // Refresh silently when the window is in the background. Never replace
      // an active UI while the user may be typing or reviewing agent output.
      if (!win.isVisible() || !win.isFocused()) {
        reloadLatestUi();
        return;
      }

      if (!Notification.isSupported() || notifiedRevision === revision) return;
      notifiedRevision = revision;
      const notification = new Notification({
        title: "Groovy UI update ready",
        body: "A new Groovy interface is available. Click to refresh now.",
      });
      notification.on("click", reloadLatestUi);
      notification.show();
    } catch {
      // Hosted UI checks are best-effort; native and connector updates continue independently.
    } finally {
      versionCheckInFlight = false;
    }
  };

  const uiVersionTimer = setInterval(() => void checkForUiUpdate(), UI_VERSION_CHECK_INTERVAL_MS);
  uiVersionTimer.unref();
  win.webContents.on("did-finish-load", () => void checkForUiUpdate());
  win.on("focus", () => void checkForUiUpdate());
  win.on("closed", () => clearInterval(uiVersionTimer));

  // Open non-app origins in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).origin === origin) return { action: "allow" };
    } catch {
      /* fallthrough */
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Keep in-window navigation on the app origin (preload only on app origin).
  win.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === origin) return;
    } catch {
      /* fallthrough */
    }
    event.preventDefault();
    void shell.openExternal(url);
  });

  void win.loadURL(appUrl(), { userAgent });
  return win;
}
