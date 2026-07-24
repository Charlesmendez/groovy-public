/**
 * Groovy Desktop shell detection + typed accessor for the `window.groovyDesktop`
 * API exposed by apps/desktop/src/preload/preload.ts.
 *
 * In a plain browser every method is a safe no-op so callers never need to
 * branch on environment beyond `isDesktopShell()`.
 */

export type DesktopConnectorState =
  | "stopped"
  | "starting"
  | "running"
  | "pairing"
  | "error";

export type DesktopConnectorStatus = {
  state: DesktopConnectorState;
  paired: boolean;
  pairedUserId: string | null;
  deviceId: string | null;
};

export type DesktopUpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type DesktopUpdateStatus = {
  state: DesktopUpdateState;
  version?: string | null;
  percent?: number | null;
  error?: string | null;
};

export type DesktopUiUpdateStatus = {
  state: "idle" | "ready" | "reloading";
  revision?: string | null;
};

export type DesktopNativeNotificationStatus = {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
};

export type DesktopChatNotification = {
  messageId: string;
  channelId: string;
  title: string;
  body: string;
  url: string;
};

export type DesktopSettings = {
  keepRunningInBackground: boolean;
  appUrl?: string;
};

export type GroovyDesktopApi = {
  isDesktop: boolean;
  versions: { app: string; electron: string; chrome: string; node: string };
  getConnectorStatus: () => Promise<DesktopConnectorStatus>;
  onConnectorStatus: (cb: (status: DesktopConnectorStatus) => void) => () => void;
  pair: (code: string, opts?: { allowAccountSwitch?: boolean }) => Promise<void>;
  checkForUpdates: () => Promise<void>;
  getUpdateStatus: () => Promise<DesktopUpdateStatus>;
  onUpdateStatus: (cb: (status: DesktopUpdateStatus) => void) => () => void;
  quitAndInstall: () => Promise<void>;
  getUiUpdateStatus: () => Promise<DesktopUiUpdateStatus>;
  onUiUpdateStatus: (cb: (status: DesktopUiUpdateStatus) => void) => () => void;
  reloadUi: () => Promise<void>;
  getNativeNotificationStatus: () => Promise<DesktopNativeNotificationStatus>;
  showChatNotification: (
    payload: DesktopChatNotification
  ) => Promise<{ shown: boolean; reason?: string }>;
  onSystemResume: (cb: () => void) => () => void;
  getSettings: () => Promise<DesktopSettings>;
  setSetting: (
    key: keyof DesktopSettings,
    value: DesktopSettings[keyof DesktopSettings]
  ) => Promise<void>;
  openLogs: () => Promise<void>;
};

declare global {
  interface Window {
    groovyDesktop?: GroovyDesktopApi;
  }
}

const FALLBACK_STATUS: DesktopConnectorStatus = {
  state: "stopped",
  paired: false,
  pairedUserId: null,
  deviceId: null,
};

const noopApi: GroovyDesktopApi = {
  isDesktop: false,
  versions: { app: "0.0.0", electron: "", chrome: "", node: "" },
  getConnectorStatus: async () => FALLBACK_STATUS,
  onConnectorStatus: () => () => {},
  pair: async () => {
    throw new Error("Groovy Desktop is not available in this browser");
  },
  checkForUpdates: async () => {},
  getUpdateStatus: async () => ({ state: "idle" as const }),
  onUpdateStatus: () => () => {},
  quitAndInstall: async () => {},
  getUiUpdateStatus: async () => ({ state: "idle" as const }),
  onUiUpdateStatus: () => () => {},
  reloadUi: async () => {},
  getNativeNotificationStatus: async () => ({
    supported: false,
    permission: "unsupported" as const,
  }),
  showChatNotification: async () => ({
    shown: false,
    reason: "desktop_update_required",
  }),
  onSystemResume: () => () => {},
  getSettings: async () => ({ keepRunningInBackground: true }),
  setSetting: async () => {},
  openLogs: async () => {},
};

export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && window.groovyDesktop?.isDesktop === true;
}

/** Typed accessor; returns safe no-ops when not running inside the shell. */
export function getDesktopApi(): GroovyDesktopApi {
  if (typeof window !== "undefined" && window.groovyDesktop) {
    // Hosted UI can deploy before a matching native Desktop release. Fill any
    // newly added bridge methods with safe fallbacks so an older shell never
    // crashes while it is waiting for its own updater.
    return {
      ...noopApi,
      ...window.groovyDesktop,
      versions: {
        ...noopApi.versions,
        ...(window.groovyDesktop.versions || {}),
      },
    };
  }
  return noopApi;
}

/** Version parsed from the shell's user agent suffix "GroovyDesktop/<version>". */
export function desktopShellVersion(): string | null {
  if (typeof navigator === "undefined") return null;
  const match = navigator.userAgent.match(/GroovyDesktop\/(\S+)/);
  return match ? match[1] : null;
}
