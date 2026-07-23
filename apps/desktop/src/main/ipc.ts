/**
 * IPC surface backing the preload API (window.groovyDesktop).
 */

import { BrowserWindow, ipcMain, shell } from "electron";
import * as path from "path";
import type { ConnectorManager, ConnectorStatus } from "./connectorManager";
import type { Updater, UpdateStatus } from "./updater";
import { getSettings, groovyDir, setSetting, type DesktopSettings } from "./settings";

export function registerIpc(args: { connector: ConnectorManager; updater: Updater }) {
  const { connector, updater } = args;

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  connector.on("status", (status: ConnectorStatus) => broadcast("groovy:connector-status", status));
  updater.onStatus((status: UpdateStatus) => broadcast("groovy:update-status", status));

  ipcMain.handle("groovy:get-connector-status", () => connector.getStatus());
  ipcMain.handle(
    "groovy:pair",
    async (_event, code: unknown, opts: unknown) => {
      if (typeof code !== "string" || !code.trim()) throw new Error("invalid_pairing_code");
      const allowAccountSwitch =
        !!opts && typeof opts === "object" && (opts as { allowAccountSwitch?: unknown }).allowAccountSwitch === true;
      await connector.pair(code.trim(), { allowAccountSwitch });
    }
  );
  ipcMain.handle("groovy:check-for-updates", () => updater.check());
  ipcMain.handle("groovy:get-update-status", () => updater.getStatus());
  ipcMain.handle("groovy:quit-and-install", () => updater.quitAndInstall());
  ipcMain.handle("groovy:get-settings", () => getSettings());
  ipcMain.handle("groovy:set-setting", (_event, key: unknown, value: unknown) => {
    if (key !== "keepRunningInBackground" && key !== "appUrl") {
      throw new Error(`unknown_setting: ${String(key)}`);
    }
    if (key === "appUrl" && typeof value === "string" && value.trim()) {
      let url: URL;
      try {
        url = new URL(value.trim());
      } catch {
        return { ok: false as const, error: "invalid_app_url" };
      }
      const isLocalhost =
        url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
        return { ok: false as const, error: "app_url_must_be_https" };
      }
    }
    return setSetting(key as keyof DesktopSettings, value as never);
  });
  ipcMain.handle("groovy:open-logs", () =>
    shell.openPath(path.join(groovyDir(), "desktop-connector.log"))
  );
}
