/**
 * Shared connector runtime bundler.
 *
 * Copies the connector source files, node_modules (with native-module
 * permission fixes), and optionally a standalone Node.js runtime into a
 * destination directory. Used by:
 * - build-macos.mjs (the standalone "Groovy Connector.app" bundle)
 * - apps/desktop (Groovy Desktop bundles the connector as a managed child
 *   process and needs the exact same layout under resources/connector)
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const CONNECTOR_NODE_VERSION = "v20.17.0";

export const CONNECTOR_MJS_FILES = [
  "connector.mjs",
  "codexPlans.mjs",
  "browser.mjs",
  "browserTask.mjs",
  "credentials.mjs",
  "files.mjs",
  "obsidian.mjs",
  "siteDev.mjs",
  "whatsapp.mjs",
  "aiyraVoice.mjs",
  "aec.mjs",
  "rnnoise.mjs",
  "linkdb.mjs",
  "sqlitedb.mjs",
  "sqliteProjects.mjs",
];

function assertExists(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(`[bundle-connector-runtime] Missing ${label}: ${p}`);
  }
}

/**
 * Copy connector sources + node_modules into destDir and (optionally)
 * download a standalone Node runtime into destDir/node.
 *
 * @param {object} opts
 * @param {string} opts.connectorDir - apps/connector checkout with node_modules installed
 * @param {string} opts.destDir - target directory (created if missing)
 * @param {boolean} [opts.includeNode=true] - download Node into destDir/node
 * @param {string} [opts.nodeVersion] - Node version tag (default CONNECTOR_NODE_VERSION)
 * @param {string} [opts.arch] - target arch (default: host arch; only arm64 supported on macOS)
 */
export function bundleConnectorRuntime({
  connectorDir,
  destDir,
  includeNode = true,
  nodeVersion = CONNECTOR_NODE_VERSION,
  arch = process.arch,
}) {
  assertExists(connectorDir, "connector directory");
  fs.mkdirSync(destDir, { recursive: true });

  // Connector source files
  for (const f of CONNECTOR_MJS_FILES) {
    const src = path.join(connectorDir, f);
    assertExists(src, f);
    fs.copyFileSync(src, path.join(destDir, f));
  }
  const platformDir = path.join(connectorDir, "platform");
  assertExists(platformDir, "platform");
  fs.cpSync(platformDir, path.join(destDir, "platform"), { recursive: true });
  const nativeDir = path.join(connectorDir, "native");
  assertExists(nativeDir, "native");
  fs.cpSync(nativeDir, path.join(destDir, "native"), { recursive: true });
  const wakewordsDir = path.join(connectorDir, "wakewords");
  if (fs.existsSync(wakewordsDir)) {
    fs.cpSync(wakewordsDir, path.join(destDir, "wakewords"), { recursive: true });
  }
  const packageJsonPath = path.join(connectorDir, "package.json");
  assertExists(packageJsonPath, "package.json");
  fs.copyFileSync(packageJsonPath, path.join(destDir, "package.json"));

  // node_modules (cp -R preserves symlinks + native modules)
  const srcNodeModules = path.join(connectorDir, "node_modules");
  const destNodeModules = path.join(destDir, "node_modules");
  assertExists(srcNodeModules, "node_modules");
  fs.rmSync(destNodeModules, { recursive: true, force: true });
  if (process.platform === "win32") {
    fs.cpSync(srcNodeModules, destNodeModules, { recursive: true });
  } else {
    execFileSync("cp", ["-R", srcNodeModules, destNodeModules]);
  }

  // Native helper permissions can be lost during copy/zip.
  const spawnHelpers = [
    path.join(destNodeModules, "node-pty/prebuilds/darwin-arm64/spawn-helper"),
    path.join(destNodeModules, "node-pty/prebuilds/darwin-x64/spawn-helper"),
  ];
  for (const helper of spawnHelpers) {
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
    }
  }

  if (includeNode) {
    downloadNodeRuntime({ destDir: path.join(destDir, "node"), nodeVersion, arch });
  }

  return { destDir, nodeDir: includeNode ? path.join(destDir, "node") : null };
}

/**
 * Download a standalone Node.js runtime into destDir (bin/node inside).
 */
export function downloadNodeRuntime({
  destDir,
  nodeVersion = CONNECTOR_NODE_VERSION,
  arch = process.arch,
}) {
  if (process.platform === "darwin" && arch !== "arm64") {
    throw new Error(
      "[bundle-connector-runtime] macOS bundles currently support Apple Silicon (arm64) only."
    );
  }
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  const nodeTarball = `node-${nodeVersion}-${platform}-${arch}.tar.gz`;
  const nodeUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeTarball}`;
  const archivePath = path.join(destDir, nodeTarball);
  const nodeExecutable = path.join(destDir, platform === "win32" ? "node.exe" : "bin/node");

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  console.log(`Downloading Node.js ${nodeVersion} for ${platform}-${arch}...`);
  try {
    execFileSync("curl", ["-fSL", nodeUrl, "-o", archivePath], { stdio: "inherit" });
    execFileSync(
      "tar",
      ["xzf", archivePath, "-C", destDir, "--strip-components=1"],
      { stdio: "inherit" }
    );
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
  assertExists(nodeExecutable, "Node.js executable");
  return destDir;
}
