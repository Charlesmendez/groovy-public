#!/bin/bash
set -euo pipefail

TARBALL_URL="${TARBALL_URL:-https://github.com/Charlesmendez/groovy-releases/releases/latest/download/Groovy-Connector-Headless.tar.gz}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.groovy/connector-headless}"
PLIST_PATH="/Library/LaunchDaemons/ai.gogroovy.connector.plist"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
curl -fsSL "$TARBALL_URL" -o connector.tgz
tar -xzf connector.tgz

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found. Please install Node.js."
  exit 1
fi

sudo tee "$PLIST_PATH" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.gogroovy.connector</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>exec "$NODE_BIN" "$INSTALL_DIR/connector.mjs" --relay "$GROOVY_RELAY_URL"</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GROOVY_APP_URL</key>
    <string>${GROOVY_APP_URL:-}</string>
    <key>GROOVY_PAIRING_CODE</key>
    <string>${GROOVY_PAIRING_CODE:-}</string>
    <key>GROOVY_SHARED_ROOT</key>
    <string>${GROOVY_SHARED_ROOT:-}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/groovy-connector.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/groovy-connector.log</string>
</dict>
</plist>
PLIST

sudo launchctl unload "$PLIST_PATH" 2>/dev/null || true
sudo launchctl load "$PLIST_PATH"
echo "Connector installed and started."
