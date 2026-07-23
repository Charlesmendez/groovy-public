import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { buildRnnoiseNativeAddon } from "./rnnoiseNative.mjs";
import { bundleConnectorRuntime } from "./bundle-connector-runtime.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const connectorDir = path.resolve(__dirname, "..");
const distDir = path.join(connectorDir, "dist");

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, {
    cwd: connectorDir,
    stdio: "inherit",
    ...opts,
  });
}

function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: connectorDir,
    encoding: "utf8",
    ...opts,
  })
    .toString()
    .trim();
}

function requireBuildUrl(name, protocols) {
  const value = process.env[name]?.trim() || "";
  if (!value) {
    throw new Error(`${name} is required when building the macOS connector`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use ${protocols.join(" or ")}`);
  }
  return value.replace(/\/$/, "");
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeMacosEntitlements(targetPath) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.device.audio-input</key>
  <true/>
</dict>
</plist>
`;
  fs.writeFileSync(targetPath, plist, "utf8");
}

function collectMachOBinaries(rootDir) {
  const binaries = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const kind = runCapture("file", ["-b", abs]);
        if (kind.includes("Mach-O")) {
          binaries.push(abs);
        }
      } catch {
        // Ignore files that can't be inspected by `file`.
      }
    }
  };

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }

  return binaries.sort((a, b) => a.localeCompare(b));
}

function signNestedMachOBinaries(appDir, identity, entitlementsPath) {
  const resourcesDir = path.join(appDir, "Contents", "Resources");
  const binaries = collectMachOBinaries(resourcesDir);
  console.log(`Signing ${binaries.length} nested Mach-O files...`);
  for (const binaryPath of binaries) {
    const isEmbeddedNode = binaryPath.endsWith("/node/bin/node");
    const args = [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
    ];
    // Embedded Node needs JIT-related entitlements under hardened runtime.
    if (isEmbeddedNode) {
      args.push("--entitlements", entitlementsPath);
    }
    args.push(
      "--sign",
      identity,
      binaryPath
    );
    run("codesign", args);
  }
}

function signAppBundle(appDir, identity, entitlementsPath) {
  signNestedMachOBinaries(appDir, identity, entitlementsPath);
  run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    entitlementsPath,
    "--sign",
    identity,
    appDir,
  ]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appDir]);
}

function notarizeAndStapleDmg(dmgPath, keychainProfile) {
  run("xcrun", ["notarytool", "submit", dmgPath, "--keychain-profile", keychainProfile, "--wait"]);
  run("xcrun", ["stapler", "staple", dmgPath]);
  run("xcrun", ["stapler", "validate", dmgPath]);
}

function notarizeAndStapleAppBundle(appDir, keychainProfile) {
  const zipPath = path.join(distDir, "Groovy-Connector-app-notary.zip");
  fs.rmSync(zipPath, { force: true });
  run("ditto", ["-c", "-k", "--keepParent", appDir, zipPath], {
    cwd: path.dirname(appDir),
  });
  try {
    run("xcrun", ["notarytool", "submit", zipPath, "--keychain-profile", keychainProfile, "--wait"]);
    run("xcrun", ["stapler", "staple", appDir]);
    run("xcrun", ["stapler", "validate", appDir]);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appDir]);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
}

function isDiskAttached(pathFragment) {
  try {
    const out = runCapture("hdiutil", ["info"]);
    return out.includes(pathFragment);
  } catch {
    return false;
  }
}

function writePlist(targetPath, { name, identifier, version }) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${name}</string>
  <key>CFBundleDisplayName</key>
  <string>${name}</string>
  <key>CFBundleIdentifier</key>
  <string>${identifier}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Groovy Connector needs microphone access for Hey Groovy wake-word detection and voice conversations.</string>
</dict>
</plist>
`;
  fs.writeFileSync(targetPath, plist, "utf8");
}

function ensurePngToIcns(pngPath, outIcnsPath) {
  // Requires macOS `sips` + `iconutil` (available on developer Macs).
  // Creates AppIcon.iconset then converts to .icns.
  const iconsetDir = path.join(path.dirname(outIcnsPath), "AppIcon.iconset");
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });

  // IMPORTANT: preserve aspect ratio. `sips -z` will stretch non-square images.
  // We first create a square 1024x1024 base PNG by scaling-to-fit and padding, then resize from it.
  const scaledPng = path.join(iconsetDir, "__scaled-1024.png");
  const squarePng = path.join(iconsetDir, "__square-1024.png");

  // Scale longest side to 1024, preserving aspect ratio.
  execSync(`sips -Z 1024 "${pngPath}" --out "${scaledPng}" >/dev/null`);

  // Pad to 1024x1024. Try transparent padding first; fall back if sips rejects alpha.
  execSync(`sips --padToHeightWidth 1024 1024 "${scaledPng}" --out "${squarePng}" >/dev/null`);

  // iconutil only accepts Apple's canonical iconset filenames. Extra 64px /
  // 1024px entries or temporary PNGs make the entire iconset invalid.
  const sizes = [16, 32, 128, 256, 512];
  for (const s of sizes) {
    const p1x = path.join(iconsetDir, `icon_${s}x${s}.png`);
    const p2x = path.join(iconsetDir, `icon_${s}x${s}@2x.png`);
    const s2 = Math.min(1024, s * 2);
    execSync(`sips -z ${s} ${s} "${squarePng}" --out "${p1x}" >/dev/null`);
    execSync(`sips -z ${s2} ${s2} "${squarePng}" --out "${p2x}" >/dev/null`);
  }

  fs.rmSync(scaledPng, { force: true });
  fs.rmSync(squarePng, { force: true });

  // Convert iconset -> icns. Some macOS beta iconutil builds reject even a
  // canonical iconset; an icon must never prevent producing a testable app.
  try {
    execSync(`iconutil -c icns "${iconsetDir}" -o "${outIcnsPath}"`);
  } catch (error) {
    console.warn(
      `[macos-build] iconutil rejected the generated iconset; continuing without a generated icon: ${error?.message || error}`
    );
  } finally {
    fs.rmSync(iconsetDir, { recursive: true, force: true });
  }
}

function main() {
  fs.mkdirSync(distDir, { recursive: true });
  buildRnnoiseNativeAddon(connectorDir);

  const connectorPkg = JSON.parse(fs.readFileSync(path.join(connectorDir, "package.json"), "utf8"));
  const appVersion = typeof connectorPkg?.version === "string" ? connectorPkg.version : "0.0.0";
  const signingIdentity = process.env.MACOS_SIGN_IDENTITY?.trim() || "";
  const notaryKeychainProfile = process.env.MACOS_NOTARY_KEYCHAIN_PROFILE?.trim() || "";
  const shouldSign = signingIdentity.length > 0;
  const shouldNotarize = notaryKeychainProfile.length > 0;
  const configuredAppUrl = requireBuildUrl("GROOVY_APP_URL", ["http:", "https:"]);
  const configuredRelayUrl = requireBuildUrl("GROOVY_RELAY_URL", ["ws:", "wss:"]);

  if (shouldNotarize && !shouldSign) {
    throw new Error("MACOS_NOTARY_KEYCHAIN_PROFILE was set, but MACOS_SIGN_IDENTITY was not set.");
  }

  // Create a proper .app bundle with embedded Node.js + connector files
  const appName = "Groovy Connector.app";
  const appDir = path.join(distDir, appName);
  const contentsDir = path.join(appDir, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");

  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  // App icon (generated from repo PNG)
  const repoRoot = path.resolve(connectorDir, "..", "..");
  const iconPng = path.join(repoRoot, "public", "sloth_no_bg.png");
  const iconIcns = path.join(resourcesDir, "AppIcon.icns");
  if (fs.existsSync(iconPng)) {
    ensurePngToIcns(iconPng, iconIcns);
  } else {
    console.warn(`Icon PNG not found at ${iconPng}; app will use default icon.`);
  }

  if (process.arch !== "arm64") {
    throw new Error("[macos-build] Groovy Connector macOS builds currently support Apple Silicon hosts only.");
  }

  // Copy connector sources + node_modules + standalone Node runtime to Resources
  // (shared with Groovy Desktop's bundled-connector build).
  bundleConnectorRuntime({
    connectorDir,
    destDir: resourcesDir,
    includeNode: true,
    arch: "arm64",
  });

  // Create launcher script
  const launcherScript = `#!/bin/bash
DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
NODE="$DIR/node/bin/node"
CONNECTOR="$DIR/connector.mjs"
CONFIG_FILE="$HOME/.groovy/connector.json"
CONFIGURED_APP_URL=${shellQuote(configuredAppUrl)}
CONFIGURED_RELAY_URL=${shellQuote(configuredRelayUrl)}
LAUNCH_AGENT_LABEL="ai.gogroovy.connector"

APPLE_SILICON_HW="$(/usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null || true)"
ARCH="$(uname -m 2>/dev/null || true)"
if [ "$APPLE_SILICON_HW" != "1" ] && [ "$ARCH" != "arm64" ] && [ "$ARCH" != "arm64e" ]; then
  echo "Groovy Connector currently supports Apple Silicon Macs only." >&2
  osascript -e 'display alert "Unsupported Mac" message "Groovy Connector currently supports Apple Silicon Macs only."' >/dev/null 2>&1 || true
  exit 1
fi

read_json_field () {
  local field="$1"
  "$NODE" -e "const fs=require('fs'); const field=process.argv[1]||''; try{const p=process.env.HOME+'/.groovy/connector.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); const v=j && typeof j==='object' ? j[field] : ''; process.stdout.write(typeof v==='string'?v:'');}catch(e){}" "$field" 2>/dev/null
}

prompt_pairing_code () {
  osascript -e 'display dialog "Enter your Groovy pairing code:\n\nGet a code from gogroovy.ai → Dashboard" default answer "" buttons {"Cancel", "Connect"} default button "Connect"' -e 'text returned of result' 2>/dev/null
}

read_whatsapp_enabled () {
  "$NODE" -e "const fs=require('fs'); try{const p=process.env.HOME+'/.groovy/connector.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(j && j.whatsapp_enabled===true ? '1' : '0');}catch(e){process.stdout.write('0');}" 2>/dev/null
}

restart_launchagent_connector () {
  local uid
  uid="$(id -u 2>/dev/null)"
  if [ -z "$uid" ]; then
    return 1
  fi

  # If the LaunchAgent exists, force a clean restart so updates take effect
  # immediately after users re-open the app post-install.
  if ! launchctl print "gui/$uid/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1; then
    return 1
  fi

  launchctl kickstart -k "gui/$uid/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1
}

# Check if already paired (config file with device_token exists)
ALREADY_PAIRED=false
if [ -f "$CONFIG_FILE" ]; then
  if grep -q "device_token" "$CONFIG_FILE" 2>/dev/null; then
    ALREADY_PAIRED=true
  fi
fi

# If arguments provided, just run with those
if [ $# -gt 0 ]; then
  exec "$NODE" "$CONNECTOR" "$@"
fi

# Resolve WhatsApp config (from saved config only; onboarding controls this)
WHATSAPP_ENABLED="$(read_whatsapp_enabled)"
GROUP_NAME="$(read_json_field whatsapp_group_name)"
APP_URL="$(read_json_field whatsapp_app_url)"
if [ -z "$APP_URL" ]; then
  APP_URL="$CONFIGURED_APP_URL"
fi

WA_ARGS=()
if [ "$WHATSAPP_ENABLED" = "1" ] && [ -n "$GROUP_NAME" ]; then
  WA_ARGS=(--whatsapp --whatsapp-group "$GROUP_NAME" --app-url "$APP_URL")
fi

# If already paired, start connector (and WhatsApp bridge if configured)
if [ "$ALREADY_PAIRED" = true ]; then
  # Prefer restarting the LaunchAgent-owned process for deterministic upgrades.
  if restart_launchagent_connector; then
    exit 0
  fi
  exec "$NODE" "$CONNECTOR" --relay "$CONFIGURED_RELAY_URL" "\${WA_ARGS[@]}" --kill-others
fi

# Not paired yet - prompt for pairing code
CODE="$(prompt_pairing_code)"
if [ -z "$CODE" ]; then
  osascript -e 'display alert "Cancelled" message "No pairing code entered."'
  exit 0
fi

# Pair and then run (WhatsApp only if enabled in config)
exec "$NODE" "$CONNECTOR" --relay "$CONFIGURED_RELAY_URL" --pair "$CODE" "\${WA_ARGS[@]}" --kill-others
`;

  const launcherPath = path.join(macosDir, "launcher");
  fs.writeFileSync(launcherPath, launcherScript, "utf8");
  fs.chmodSync(launcherPath, 0o755);

  writePlist(path.join(contentsDir, "Info.plist"), {
    name: "Groovy Connector",
    identifier: "ai.gogroovy.connector",
    version: appVersion,
  });

  const entitlementsPath = path.join(distDir, "macos.entitlements.plist");
  if (shouldSign) {
    console.log(`Signing app bundle with identity: ${signingIdentity}`);
    writeMacosEntitlements(entitlementsPath);
    signAppBundle(appDir, signingIdentity, entitlementsPath);
  }

  if (shouldNotarize) {
    console.log(`Notarizing app bundle with keychain profile: ${notaryKeychainProfile}`);
    notarizeAndStapleAppBundle(appDir, notaryKeychainProfile);
  }

  // Create DMG for distribution with drag-to-Applications visual
  const dmgName = "Groovy-Connector-macOS.dmg";
  const dmgPath = path.join(distDir, dmgName);
  const dmgTempDir = path.join(distDir, "dmg-temp");
  const dmgVolumeName = "Groovy Connector";

  // Clean up
  try {
    fs.rmSync(dmgPath, { force: true });
    fs.rmSync(dmgTempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  // Create temp directory for DMG contents
  fs.mkdirSync(dmgTempDir, { recursive: true });

  // Copy app to temp directory
  run("cp", ["-R", appDir, dmgTempDir]);

  // Create symlink to Applications
  fs.symlinkSync("/Applications", path.join(dmgTempDir, "Applications"));

  // Create the DMG
  console.log("Creating DMG...");
  
  // Create a temporary DMG (read-write)
  const tempDmg = path.join(distDir, "temp.dmg");
  try { fs.rmSync(tempDmg, { force: true }); } catch {}

  // hdiutil can fail with "Resource busy" on CI runners (Spotlight/mds indexing the source folder).
  // Retry with backoff to ride it out.
  const createDmgWithRetry = (retries = 5) => {
    for (let i = 0; i < retries; i++) {
      try {
        execSync(`hdiutil create -srcfolder "${dmgTempDir}" -volname "${dmgVolumeName}" -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW "${tempDmg}"`, {
          stdio: "inherit",
        });
        return;
      } catch (e) {
        console.warn(`hdiutil create attempt ${i + 1}/${retries} failed: ${e.message || e}`);
        try { fs.rmSync(tempDmg, { force: true }); } catch {}
        if (i < retries - 1) {
          execSync(`sleep ${2 + i * 2}`); // 2s, 4s, 6s, 8s backoff
        }
      }
    }
    // Final attempt — let the error surface
    execSync(`hdiutil create -srcfolder "${dmgTempDir}" -volname "${dmgVolumeName}" -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW "${tempDmg}"`, {
      stdio: "inherit",
    });
  };
  createDmgWithRetry();

  // Mount the DMG
  execSync(`hdiutil attach -readwrite -noverify "${tempDmg}"`, { encoding: "utf8" });
  const mountPoint = `/Volumes/${dmgVolumeName}`;

  // Configure DMG window using AppleScript (positions the icons nicely)
  const appleScript = `
tell application "Finder"
  tell disk "${dmgVolumeName}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {100, 100, 640, 480}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 100
    set position of item "Groovy Connector.app" of container window to {130, 180}
    set position of item "Applications" of container window to {410, 180}
    close
    open
    update without registering applications
    delay 1
  end tell
end tell
`;

  try {
    // IMPORTANT: don't inline multiline AppleScript in a shell string; quoting breaks easily and
    // the DMG will fall back to Finder defaults (often swapping icon positions).
    const scriptPath = path.join(distDir, "dmg-layout.applescript");
    fs.writeFileSync(scriptPath, appleScript, "utf8");
    execFileSync("osascript", [scriptPath], { stdio: "pipe" });
    try {
      fs.rmSync(scriptPath, { force: true });
    } catch {
      // ignore
    }
  } catch {
    // Finder scripting can be flaky in CI, continue anyway
    console.log("Note: AppleScript window customization skipped (may not work in CI)");
  }

  // Finalize permissions
  execSync(`chmod -Rf go-w "${mountPoint}" 2>/dev/null || true`, { stdio: "pipe" });

  // Unmount
  const detachWithRetry = (retries = 6) => {
    for (let i = 0; i < retries; i++) {
      try {
        execSync(`hdiutil detach "${mountPoint}"`, { stdio: "inherit" });
        return;
      } catch {
        // Force-detach often resolves Finder/Spotlight holding the volume briefly.
        try {
          execSync(`hdiutil detach -force "${mountPoint}"`, { stdio: "pipe" });
          return;
        } catch {
          // ignore, we'll retry
        }
        // Backoff a bit before retrying.
        execSync(`sleep ${Math.min(2 + i, 6)}`);
      }
    }
    // Last attempt: let error surface
    execSync(`hdiutil detach -force "${mountPoint}"`, { stdio: "inherit" });
  };
  detachWithRetry();

  // Convert to compressed final DMG
  const convertWithRetry = (retries = 6) => {
    // Give launchd/Finder/Spotlight a brief window to release temp.dmg after detach.
    for (let i = 0; i < 8; i++) {
      if (!isDiskAttached(mountPoint) && !isDiskAttached(tempDmg)) break;
      execSync("sleep 1");
    }

    for (let i = 0; i < retries; i++) {
      try {
        execSync(`hdiutil convert "${tempDmg}" -format UDZO -imagekey zlib-level=9 -ov -o "${dmgPath}"`, {
          stdio: "inherit",
        });
        return;
      } catch (e) {
        // macOS sometimes keeps the temp DMG file busy immediately after detach.
        console.warn(`hdiutil convert attempt ${i + 1}/${retries} failed: ${e.message || e}`);
        execSync(`sleep ${Math.min(2 + i, 6)}`);
      }
    }

    // Fallback for rare persistent file-lock issues on temp.dmg:
    // build compressed DMG directly from src folder (layout customization may be skipped).
    console.warn("hdiutil convert kept failing; falling back to direct UDZO create from source folder.");
    execSync(`hdiutil create -srcfolder "${dmgTempDir}" -volname "${dmgVolumeName}" -format UDZO -imagekey zlib-level=9 -ov "${dmgPath}"`, {
      stdio: "inherit",
    });
  };
  convertWithRetry();

  if (shouldSign) {
    console.log(`Signing DMG with identity: ${signingIdentity}`);
    run("codesign", ["--force", "--timestamp", "--sign", signingIdentity, dmgPath]);
  }

  if (shouldNotarize) {
    console.log(`Notarizing DMG with keychain profile: ${notaryKeychainProfile}`);
    notarizeAndStapleDmg(dmgPath, notaryKeychainProfile);
  }

  // Clean up
  fs.rmSync(tempDmg, { force: true });
  fs.rmSync(dmgTempDir, { recursive: true, force: true });
  fs.rmSync(entitlementsPath, { force: true });

  // Also create ZIP for backwards compatibility
  const zipName = "Groovy-Connector-macOS.zip";
  const zipPath = path.join(distDir, zipName);
  try { fs.rmSync(zipPath, { force: true }); } catch {}
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appDir, zipPath], {
    cwd: distDir,
  });

  console.log(`Built ${dmgName} at ${dmgPath}`);
  console.log(`Built ${zipName} at ${zipPath}`);
}

main();
