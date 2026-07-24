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

import { app, BrowserWindow, session, shell } from "electron";
import * as path from "path";
import type { HostedUiUpdater } from "./hostedUiUpdater";
import { configuredAppUrl } from "./runtimeConfig";

const PARTITION = "persist:groovy";

export function appUrl(): string {
  return configuredAppUrl();
}

export function appOrigin(): string {
  return new URL(appUrl()).origin;
}

export function createMainWindow(hostedUiUpdater: HostedUiUpdater): BrowserWindow {
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
      // The hidden tray window owns the authenticated Realtime connection
      // used for native chat alerts. Keep it responsive while not visible so
      // notifications are not delayed until the window is reopened.
      backgroundThrottling: false,
      additionalArguments: [`--groovy-app-version=${app.getVersion()}`],
    },
  });

  win.once("ready-to-show", () => win.show());

  const origin = appOrigin();
  hostedUiUpdater.attach(win, origin);

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
