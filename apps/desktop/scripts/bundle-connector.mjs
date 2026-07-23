#!/usr/bin/env node
/**
 * Populate apps/desktop/resources/connector/ with the connector runtime
 * (connector.mjs + node_modules + a standalone Node v20 arm64 under node/).
 *
 * Reuses the shared bundler used by the standalone "Groovy Connector.app"
 * build so the layout is byte-for-byte the same. Requires `npm ci` to have
 * been run inside apps/connector first.
 *
 * Usage: node scripts/bundle-connector.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleConnectorRuntime } from "../../connector/packaging/bundle-connector-runtime.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const connectorDir = path.resolve(desktopDir, "../connector");
const destDir = path.join(desktopDir, "resources", "connector");
const runtimeConfigPath = path.join(desktopDir, "resources", "runtime-config.json");

function requireUrl(name, protocols) {
  const value = process.env[name]?.trim() || "";
  if (!value) {
    throw new Error(`${name} is required when bundling Groovy Desktop`);
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

const runtimeConfig = {
  appUrl: requireUrl("GROOVY_APP_URL", ["http:", "https:"]),
  relayUrl: requireUrl("GROOVY_RELAY_URL", ["ws:", "wss:"]),
};

console.log(`[bundle-connector] connector: ${connectorDir}`);
console.log(`[bundle-connector] dest:      ${destDir}`);

fs.rmSync(destDir, { recursive: true, force: true });
const result = bundleConnectorRuntime({
  connectorDir,
  destDir,
  includeNode: true,
  arch: "arm64",
});

fs.writeFileSync(runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
console.log(`[bundle-connector] done: ${result.destDir}`);
console.log(`[bundle-connector] runtime config: ${runtimeConfigPath}`);
