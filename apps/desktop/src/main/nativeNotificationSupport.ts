export type NativeNotificationPermission =
  | "default"
  | "denied"
  | "granted"
  | "unknown"
  | "unsupported";

export type NativeNotificationStatus = {
  supported: boolean;
  permission: NativeNotificationPermission;
};

const MAC_NOTIFICATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension?ai.gogroovy.desktop";

/**
 * Electron 33 exposes whether native notifications are supported, but it does
 * not expose macOS authorization. Never turn capability into a fabricated
 * permission grant: macOS remains the source of truth.
 */
export function nativeNotificationStatus(
  supported: boolean,
): NativeNotificationStatus {
  return supported
    ? { supported: true, permission: "unknown" }
    : { supported: false, permission: "unsupported" };
}

export function nativeNotificationSettingsUrl(
  platform: NodeJS.Platform,
): string | null {
  return platform === "darwin" ? MAC_NOTIFICATION_SETTINGS_URL : null;
}
