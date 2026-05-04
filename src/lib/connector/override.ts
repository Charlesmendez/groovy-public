import type { ConnectorClientPlatform } from "./platform";

export type ConnectorPlatformOverride = ConnectorClientPlatform | "auto";

const STORAGE_KEY = "groovy:connector:platformOverride";

export function readConnectorPlatformOverride(): ConnectorPlatformOverride {
  if (typeof window === "undefined") return "auto";
  try {
    const v = String(window.localStorage.getItem(STORAGE_KEY) || "").trim().toLowerCase();
    if (!v || v === "auto") return "auto";
    if (v === "windows") return "windows";
    if (v === "macos") return "macos";
    return "auto";
  } catch {
    return "auto";
  }
}

export function writeConnectorPlatformOverride(next: ConnectorPlatformOverride) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next || "auto"));
    try {
      window.dispatchEvent(new CustomEvent("groovy:connector:platformOverrideChanged"));
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

