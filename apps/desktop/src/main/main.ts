/**
 * Groovy Desktop — app lifecycle.
 *
 * - Single-instance lock (second launches focus the existing window).
 * - Registers the groovy:// protocol.
 * - Manages the bundled connector as a child process (adopting any existing
 *   standalone LaunchAgent install on first run).
 * - On quit: if "keep running in background" is enabled and the connector is
 *   paired, installs a LaunchAgent pointing at the app-bundled runtime so the
 *   connector survives the app; otherwise everything stops with the app.
 */

import { app, BrowserWindow } from "electron";
import * as path from "path";
import log from "electron-log/main";
import { ConnectorManager, relayUrl } from "./connectorManager";
import { registerIpc } from "./ipc";
import { installLaunchAgent, removeLaunchAgent } from "./launchAgent";
import { getSettings } from "./settings";
import { GroovyTray } from "./tray";
import { Updater } from "./updater";
import { appUrl, createMainWindow } from "./window";

log.initialize();
log.transports.file.level = "info";

function connectorResourcesDir(): string {
  // Packaged: <App>.app/Contents/Resources/connector (electron-builder
  // extraResources). Dev: apps/desktop/resources/connector (populated by
  // `npm run bundle-connector`).
  return app.isPackaged
    ? path.join(process.resourcesPath, "connector")
    : path.join(__dirname, "..", "..", "resources", "connector");
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  const connector = new ConnectorManager(connectorResourcesDir());
  let mainWindow: BrowserWindow | null = null;
  let tray: GroovyTray | null = null;
  let quitting = false;
  let cleanupDone = false;

  const cleanup = async (forUpdate: boolean) => {
    if (cleanupDone) return;
    updater?.stopSchedule();
    await connector.stop();
    if (forUpdate) {
      // The updater is about to replace /Applications/Groovy.app. A connector
      // LaunchAgent pointing inside that bundle would race the replacement.
      await removeLaunchAgent();
    } else {
      const keepRunning = getSettings().keepRunningInBackground;
      const paired = connector.getStatus().paired;
      if (keepRunning && paired) {
        await installLaunchAgent({
          nodeBin: connector.nodeBinPath,
          connectorDir: connector.dir,
          appUrl: appUrl(),
          relayUrl: relayUrl(),
        });
      } else {
        await removeLaunchAgent();
      }
    }
    cleanupDone = true;
  };

  const updater = new Updater(async () => {
    quitting = true;
    await cleanup(true);
  });

  const showWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    mainWindow = createMainWindow();
    mainWindow.on("close", (event) => {
      // Closing the window keeps the app (and connector) alive in the tray.
      if (!quitting) {
        event.preventDefault();
        mainWindow?.hide();
      }
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  };

  app.on("second-instance", () => showWindow());

  if (!app.isDefaultProtocolClient("groovy")) {
    app.setAsDefaultProtocolClient("groovy");
  }
  app.on("open-url", () => showWindow());

  app.whenReady().then(async () => {
    registerIpc({ connector, updater });

    // Take over any standalone connector install, then run it ourselves.
    await connector.adoptStandalone();
    connector.start();

    tray = new GroovyTray({
      onOpen: showWindow,
      onRestartConnector: () => void connector.restart(),
      onCheckForUpdates: () => void updater.check(),
      onQuit: () => {
        quitting = true;
        app.quit();
      },
    });
    connector.on("status", (status) => tray?.updateConnectorStatus(status));
    let updateCheckedForPairedConnector = false;
    connector.on("status", (status) => {
      if (!status.paired || updateCheckedForPairedConnector) return;
      updateCheckedForPairedConnector = true;
      void updater.check();
    });
    tray.updateConnectorStatus(connector.getStatus());

    updater.startSchedule();
    showWindow();
  });

  app.on("activate", () => showWindow());

  // We stay alive in the tray even with all windows closed (all platforms).
  app.on("window-all-closed", () => {
    /* keep running */
  });

  app.on("before-quit", (event) => {
    quitting = true;
    if (cleanupDone) return;
    event.preventDefault();
    void (async () => {
      try {
        await cleanup(false);
      } catch (err) {
        log.error(`[main] quit cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        cleanupDone = true;
        app.quit();
      }
    })();
  });
}
