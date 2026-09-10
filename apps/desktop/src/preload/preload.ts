/**
 * Preload — exposes the typed window.groovyDesktop API to the hosted web app.
 * Runs with contextIsolation + sandbox; only ever loaded on the app origin
 * (see window.ts navigation guards). Mirror of src/lib/desktop/shell.ts in
 * the web repo.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type ConnectorStatus = {
  state: string;
  paired: boolean;
  pairedUserId: string | null;
  deviceId: string | null;
};

type UpdateStatus = {
  state: string;
  version?: string | null;
  percent?: number | null;
  error?: string | null;
};

type HostedUiUpdateStatus = {
  state: "idle" | "ready" | "reloading";
  revision?: string | null;
};

type NativeNotificationStatus = {
  supported: boolean;
  permission:
    | "default"
    | "denied"
    | "granted"
    | "unknown"
    | "unsupported";
};

type NativeComposerShortcut = "mod-enter" | "mod-j";

type NativeAppAreaShortcut = "command-center" | "chat" | "email";

const NATIVE_APP_AREA_SHORTCUTS = new Set<NativeAppAreaShortcut>([
  "command-center",
  "chat",
  "email",
]);

type NativeEmailShortcut =
  | "escape"
  | "open-shortcuts"
  | "search"
  | "compose"
  | "next"
  | "previous"
  | "open-reply-all"
  | "forward"
  | "mark-done"
  | "archive"
  | "toggle-star"
  | "mark-unread";

const NATIVE_EMAIL_SHORTCUTS = new Set<NativeEmailShortcut>([
  "escape",
  "open-shortcuts",
  "search",
  "compose",
  "next",
  "previous",
  "open-reply-all",
  "forward",
  "mark-done",
  "archive",
  "toggle-star",
  "mark-unread",
]);

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// App version is passed by window.ts via webPreferences.additionalArguments.
const appVersion = (() => {
  const arg = process.argv.find((value) => value.startsWith("--groovy-app-version="));
  return arg ? arg.slice("--groovy-app-version=".length) : "";
})();

const api = {
  isDesktop: true as const,
  versions: {
    app: appVersion,
    electron: process.versions.electron || "",
    chrome: process.versions.chrome || "",
    node: process.versions.node || "",
  },
  getConnectorStatus: (): Promise<ConnectorStatus> =>
    ipcRenderer.invoke("groovy:get-connector-status"),
  onConnectorStatus: (cb: (status: ConnectorStatus) => void) =>
    subscribe<ConnectorStatus>("groovy:connector-status", cb),
  pair: (code: string, opts?: { allowAccountSwitch?: boolean }): Promise<void> =>
    ipcRenderer.invoke("groovy:pair", code, opts || {}),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke("groovy:check-for-updates"),
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke("groovy:get-update-status"),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) =>
    subscribe<UpdateStatus>("groovy:update-status", cb),
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke("groovy:quit-and-install"),
  getUiUpdateStatus: (): Promise<HostedUiUpdateStatus> =>
    ipcRenderer.invoke("groovy:get-ui-update-status"),
  onUiUpdateStatus: (cb: (status: HostedUiUpdateStatus) => void) =>
    subscribe<HostedUiUpdateStatus>("groovy:ui-update-status", cb),
  reloadUi: (): Promise<void> => ipcRenderer.invoke("groovy:reload-ui"),
  getNativeNotificationStatus: (): Promise<NativeNotificationStatus> =>
    ipcRenderer.invoke("groovy:get-native-notification-status"),
  testNativeNotification: (): Promise<{
    requested: boolean;
    reason?: string;
  }> => ipcRenderer.invoke("groovy:test-native-notification"),
  openNativeNotificationSettings: (): Promise<{
    opened: boolean;
    reason?: string;
  }> => ipcRenderer.invoke("groovy:open-native-notification-settings"),
  showChatNotification: (payload: {
    messageId: string;
    channelId: string;
    title: string;
    body: string;
    url: string;
    silent?: boolean;
  }): Promise<{ shown: boolean; reason?: string }> =>
    ipcRenderer.invoke("groovy:show-chat-notification", payload),
  setChatBadgeCount: (count: number): Promise<{ updated: boolean }> =>
    ipcRenderer.invoke("groovy:set-chat-badge-count", count),
  onSystemResume: (cb: () => void) =>
    subscribe<Record<string, never>>("groovy:system-resumed", () => cb()),
  onNativeComposerShortcut: (cb: (shortcut: NativeComposerShortcut) => void) =>
    subscribe<unknown>("groovy:native-composer-shortcut", (payload) => {
      if (payload === "mod-enter" || payload === "mod-j") cb(payload);
    }),
  onNativeAppAreaShortcut: (cb: (shortcut: NativeAppAreaShortcut) => void) =>
    subscribe<unknown>("groovy:native-app-area-shortcut", (payload) => {
      if (
        typeof payload === "string" &&
        NATIVE_APP_AREA_SHORTCUTS.has(payload as NativeAppAreaShortcut)
      ) {
        cb(payload as NativeAppAreaShortcut);
      }
    }),
  onNativeEmailShortcut: (cb: (shortcut: NativeEmailShortcut) => void) =>
    subscribe<unknown>("groovy:native-email-shortcut", (payload) => {
      if (
        typeof payload === "string" &&
        NATIVE_EMAIL_SHORTCUTS.has(payload as NativeEmailShortcut)
      ) {
        cb(payload as NativeEmailShortcut);
      }
    }),
  getSettings: (): Promise<{ keepRunningInBackground: boolean; appUrl?: string }> =>
    ipcRenderer.invoke("groovy:get-settings"),
  setSetting: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke("groovy:set-setting", key, value),
  openLogs: (): Promise<void> => ipcRenderer.invoke("groovy:open-logs"),
};

contextBridge.exposeInMainWorld("groovyDesktop", api);
