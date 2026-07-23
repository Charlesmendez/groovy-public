/**
 * Desktop shell settings persisted at ~/.groovy/desktop.json.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type DesktopSettings = {
  /** Keep the connector running (via LaunchAgent) after the app quits. */
  keepRunningInBackground: boolean;
  /** Optional override for the hosted app URL (defaults to production). */
  appUrl?: string;
};

const DEFAULTS: DesktopSettings = {
  keepRunningInBackground: true,
};

export function groovyDir(): string {
  return path.join(os.homedir(), ".groovy");
}

function settingsPath(): string {
  return path.join(groovyDir(), "desktop.json");
}

export function getSettings(): DesktopSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
    return {
      keepRunningInBackground:
        typeof raw.keepRunningInBackground === "boolean"
          ? raw.keepRunningInBackground
          : DEFAULTS.keepRunningInBackground,
      ...(typeof raw.appUrl === "string" && raw.appUrl.trim()
        ? { appUrl: raw.appUrl.trim() }
        : {}),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setSetting<K extends keyof DesktopSettings>(
  key: K,
  value: DesktopSettings[K]
): DesktopSettings {
  const next = { ...getSettings(), [key]: value };
  if (key === "appUrl" && (typeof value !== "string" || !value.trim())) {
    delete next.appUrl;
  }
  fs.mkdirSync(groovyDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}
