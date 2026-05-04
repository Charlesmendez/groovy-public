import type { ConnectorClientPlatform } from "./platform";

export type ConnectorInstallGuide = {
  platform: ConnectorClientPlatform;
  title: string;
  ctaLabel: string;
  downloadUrl: string;
  downloadFileLabel: string;
  requirements: string;
  installSteps: string[];
  restartHint: string;
  blockedHint: string;
  repairCommands: string;
};

const MAC_GUIDE: ConnectorInstallGuide = {
  platform: "macos",
  title: "macOS Download",
  ctaLabel: "Download for macOS",
  downloadUrl:
    "https://github.com/Charlesmendez/groovy-releases/releases/latest/download/Groovy-Connector-macOS.dmg",
  downloadFileLabel: "Groovy-Connector-macOS.dmg",
  requirements: "macOS 12+ required • Apple Silicon only",
  installSteps: [
    "Open .dmg and drag Groovy Connector to Applications",
    "Eject \"Groovy Connector\" from Finder (installer disk)",
    "Open the app from Applications and paste pairing code",
  ],
  restartHint: "pkill -f connector.mjs",
  blockedHint: "If blocked: System Settings -> Privacy & Security -> Open Anyway",
  repairCommands: `# Switch Flow account (re-pair connector) — keeps WhatsApp Web session
launchctl unload ~/Library/LaunchAgents/ai.gogroovy.connector.plist 2>/dev/null || true
rm -f ~/.groovy/connector.json ~/.flow/connector.json
security delete-generic-password -s groovy-connector -a device-token-default 2>/dev/null || true
security delete-generic-password -s flow-connector -a device-token-default 2>/dev/null || true

# Re-open "Groovy Connector" from /Applications and enter pairing code`,
};

const WINDOWS_GUIDE: ConnectorInstallGuide = {
  platform: "windows",
  title: "Windows Download",
  ctaLabel: "Download for Windows",
  downloadUrl:
    "https://github.com/Charlesmendez/groovy-releases/releases/latest/download/Groovy-Connector-windows.exe",
  downloadFileLabel: "Groovy-Connector-windows.exe",
  requirements: "Windows 10+ required • x64",
  installSteps: [
    "Run the installer",
    "Open Groovy Connector from Start Menu",
    "Paste pairing code when prompted",
  ],
  restartHint: "schtasks /run /tn \"Groovy Connector\"",
  blockedHint: "If SmartScreen warns: click \"More info\" then \"Run anyway\"",
  repairCommands: `:: Switch Flow account (re-pair connector)
schtasks /delete /tn "Groovy Connector" /f 2>nul
del "%USERPROFILE%\\.groovy\\connector-startup.cmd" 2>nul
del "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Groovy Connector.cmd" 2>nul
del "%USERPROFILE%\\.groovy\\connector.json" 2>nul
del "%USERPROFILE%\\.flow\\connector.json" 2>nul

:: Re-open Groovy Connector and enter pairing code`,
};

export function getConnectorInstallGuide(platform: ConnectorClientPlatform): ConnectorInstallGuide {
  if (platform === "windows") return WINDOWS_GUIDE;
  // Unknown defaults to macOS.
  return MAC_GUIDE;
}
