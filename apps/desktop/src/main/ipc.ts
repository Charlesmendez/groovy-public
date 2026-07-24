/**
 * IPC surface backing the preload API (window.groovyDesktop).
 */

import {
  BrowserWindow,
  ipcMain,
  Notification,
  powerMonitor,
  shell,
} from "electron";
import * as path from "path";
import type { ConnectorManager, ConnectorStatus } from "./connectorManager";
import type { HostedUiUpdater } from "./hostedUiUpdater";
import {
  NativeNotificationDeduper,
  parseNativeChatNotificationPayload,
} from "./nativeChatNotifications";
import type { Updater, UpdateStatus } from "./updater";
import { getSettings, groovyDir, setSetting, type DesktopSettings } from "./settings";
import { appUrl } from "./window";

export function registerIpc(args: {
  connector: ConnectorManager;
  updater: Updater;
  hostedUiUpdater: HostedUiUpdater;
  showWindow: () => BrowserWindow;
}) {
  const { connector, updater, hostedUiUpdater, showWindow } = args;
  const notificationIds = new NativeNotificationDeduper();
  const liveNotifications = new Set<Notification>();

  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  connector.on("status", (status: ConnectorStatus) => broadcast("groovy:connector-status", status));
  updater.onStatus((status: UpdateStatus) => broadcast("groovy:update-status", status));
  hostedUiUpdater.onStatus((status) => broadcast("groovy:ui-update-status", status));
  const broadcastResume = () => broadcast("groovy:system-resumed", {});
  powerMonitor.on("resume", broadcastResume);
  powerMonitor.on("unlock-screen", broadcastResume);

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
  ipcMain.handle("groovy:get-ui-update-status", () => hostedUiUpdater.getStatus());
  ipcMain.handle("groovy:reload-ui", () => hostedUiUpdater.reloadNow());
  ipcMain.handle("groovy:get-native-notification-status", () => {
    if (!Notification.isSupported()) {
      return { supported: false as const, permission: "unsupported" as const };
    }
    // Electron 33 does not expose macOS notification authorization state.
    // The first native Notification prompts when needed; macOS owns any
    // subsequent allow/deny choice in System Settings.
    return { supported: true as const, permission: "granted" as const };
  });
  ipcMain.handle("groovy:show-chat-notification", (event, input: unknown) => {
    const payload = parseNativeChatNotificationPayload(input);
    if (!payload) return { shown: false as const, reason: "invalid_payload" };
    if (!Notification.isSupported()) {
      return { shown: false as const, reason: "unsupported" };
    }
    if (notificationIds.has(payload.messageId)) {
      return { shown: false as const, reason: "duplicate" };
    }
    notificationIds.add(payload.messageId);

    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (
      sourceWindow?.isVisible() &&
      sourceWindow.isFocused() &&
      (() => {
        try {
          return new URL(sourceWindow.webContents.getURL()).pathname === payload.url;
        } catch {
          return false;
        }
      })()
    ) {
      return { shown: false as const, reason: "active_room" };
    }

    const notification = new Notification({
      title: payload.title,
      body: payload.body,
      silent: false,
    });
    liveNotifications.add(notification);
    const release = () => liveNotifications.delete(notification);
    notification.once("close", release);
    notification.once("failed", release);
    notification.on("click", () => {
      release();
      const win = showWindow();
      const target = new URL(payload.url, appUrl()).toString();
      try {
        if (new URL(win.webContents.getURL()).pathname === payload.url) return;
      } catch {
        // A not-yet-loaded window should navigate to the notification target.
      }
      void win.loadURL(target);
    });
    notification.show();
    return { shown: true as const };
  });
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
