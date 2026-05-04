export type ConnectorClientPlatform = "macos" | "windows" | "unknown";

export function normalizeConnectorPlatform(value: unknown): ConnectorClientPlatform {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "unknown";
  if (v === "macos" || v === "mac" || v === "darwin" || v === "osx" || v === "macosx") {
    return "macos";
  }
  if (v === "windows" || v === "win" || v === "win32" || v === "windows_nt") {
    return "windows";
  }
  return "unknown";
}

export function detectConnectorPlatformFromUserAgent(userAgent: string): ConnectorClientPlatform {
  const ua = String(userAgent || "").toLowerCase();
  if (!ua) return "unknown";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os x") || ua.includes("macintosh")) return "macos";
  return "unknown";
}

export function detectConnectorPlatformFromNavigator(nav: Navigator | null | undefined): ConnectorClientPlatform {
  if (!nav) return "unknown";

  const byUserAgent = detectConnectorPlatformFromUserAgent(nav.userAgent || "");
  if (byUserAgent !== "unknown") return byUserAgent;

  // Fallback for userAgent reduction cases.
  const platform = String((nav as Navigator & { platform?: string }).platform || "").toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("mac")) return "macos";

  return "unknown";
}
