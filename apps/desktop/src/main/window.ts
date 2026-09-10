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
import log from "electron-log/main";
import * as path from "path";
import type { HostedUiUpdater } from "./hostedUiUpdater";
import { clearHostedUiDeploymentPin } from "./hostedUiDeploymentPin";
import {
  HostedPageRecovery,
  hostedPageRecoveryUrl,
  isHostedPageUrl,
  shouldRecoverFailedLoad,
  shouldRecoverUnexpectedPage,
} from "./hostedPageRecovery";
import {
  parseNativeAppAreaShortcut,
  parseNativeComposerShortcut,
  parseNativeEmailShortcut,
} from "./nativeShortcuts";
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
  let lastHostedUrl = appUrl();
  hostedUiUpdater.attach(win, origin);

  const pageRecovery = new HostedPageRecovery({
    recover: async () => {
      if (win.isDestroyed()) return;
      await clearHostedUiDeploymentPin(win.webContents.session.cookies, origin);
      if (win.isDestroyed()) return;
      const targetUrl = hostedPageRecoveryUrl(
        win.webContents.getURL(),
        origin,
        lastHostedUrl
      );
      await win.loadURL(targetUrl, { userAgent });
    },
    onScheduled: ({ reason, attempt, delayMs }) => {
      log.warn(
        "[window] hosted page unavailable (" +
          reason +
          "); recovery attempt " +
          attempt +
          " in " +
          delayMs +
          "ms"
      );
    },
    onRecoveryError: (error) => {
      log.warn(
        "[window] hosted page recovery failed: " +
          (error instanceof Error ? error.message : String(error))
      );
    },
  });

  const recoverUnexpectedPage = (source: string) => {
    if (win.isDestroyed()) return;
    const currentUrl = win.webContents.getURL();
    if (
      !shouldRecoverUnexpectedPage(
        currentUrl,
        origin,
        win.webContents.isLoadingMainFrame()
      )
    ) {
      return;
    }
    pageRecovery.noteFailure(
      source + " reached an unexpected page (" + currentUrl + ")"
    );
  };

  win.webContents.on("did-finish-load", () => {
    const currentUrl = win.webContents.getURL();
    if (isHostedPageUrl(currentUrl, origin)) {
      lastHostedUrl = currentUrl;
      pageRecovery.noteSuccess();
      return;
    }
    recoverUnexpectedPage("finished load");
  });
  win.webContents.on("did-stop-loading", () => {
    recoverUnexpectedPage("stopped loading");
  });
  const onFailedLoad = (
    _event: Electron.Event,
    errorCode: number,
    errorDescription: string,
    validatedUrl: string,
    isMainFrame: boolean
  ) => {
    if (!shouldRecoverFailedLoad(errorCode, isMainFrame)) return;
    pageRecovery.noteFailure(
      "main-frame load failed " +
        errorCode +
        " " +
        errorDescription +
        " (" +
        validatedUrl +
        ")"
    );
  };
  win.webContents.on("did-fail-load", onFailedLoad);
  win.webContents.on("did-fail-provisional-load", onFailedLoad);
  win.webContents.on("render-process-gone", (_event, details) => {
    pageRecovery.noteFailure(
      "renderer exited: " +
        details.reason +
        (typeof details.exitCode === "number" ? " (" + details.exitCode + ")" : "")
    );
  });
  // The app can remain alive in the tray for hours. If macOS discards a
  // renderer while the window is hidden, recover as soon as it is shown or
  // focused even when Chromium did not report the original failure.
  win.on("show", () => recoverUnexpectedPage("window shown"));
  win.on("focus", () => recoverUnexpectedPage("window focused"));
  win.once("closed", () => pageRecovery.dispose());

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

  // Electron can consume keyboard input before the hosted UI sees a DOM event.
  // Forward the supported shortcuts as fallbacks; the hosted UI still owns
  // focus checks, deduplication, and the actual action.
  win.webContents.on("before-input-event", (event, input) => {
    const appAreaShortcut = parseNativeAppAreaShortcut(input);
    if (appAreaShortcut) {
      event.preventDefault();
      win.webContents.send(
        "groovy:native-app-area-shortcut",
        appAreaShortcut
      );
      return;
    }
    const composerShortcut = parseNativeComposerShortcut(input);
    if (composerShortcut) {
      win.webContents.send(
        "groovy:native-composer-shortcut",
        composerShortcut
      );
    }
    const emailShortcut = parseNativeEmailShortcut(input);
    if (emailShortcut) {
      win.webContents.send("groovy:native-email-shortcut", emailShortcut);
    }
  });

  // A Vercel deployment pin can outlive the hosted deployment in this
  // persistent session. Clear it before startup so the production alias, and
  // not a stale immutable deployment, supplies the renderer and API routes.
  void clearHostedUiDeploymentPin(ses.cookies, origin)
    .catch((error) => {
      log.warn(
        `[window] could not clear the hosted deployment pin before startup: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    })
    .finally(() => {
      if (win.isDestroyed()) return;
      void win.loadURL(appUrl(), { userAgent }).catch((error) => {
        // did-fail-load schedules the retry. This catch prevents an unhandled
        // rejection and preserves useful diagnostics if Electron rejects first.
        log.warn(
          "[window] initial hosted page load failed: " +
            (error instanceof Error ? error.message : String(error))
        );
        pageRecovery.noteFailure("initial hosted page load rejected");
      });
    });
  return win;
}
