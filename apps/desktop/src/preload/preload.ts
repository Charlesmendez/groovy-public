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
  getSettings: (): Promise<{ keepRunningInBackground: boolean; appUrl?: string }> =>
    ipcRenderer.invoke("groovy:get-settings"),
  setSetting: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke("groovy:set-setting", key, value),
  openLogs: (): Promise<void> => ipcRenderer.invoke("groovy:open-logs"),
};

contextBridge.exposeInMainWorld("groovyDesktop", api);
