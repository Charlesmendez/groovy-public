/**
 * Deployment endpoints for the native shell.
 *
 * Release builds write non-secret defaults to resources/runtime-config.json.
 * Runtime environment variables remain the highest-priority override so a
 * self-hosted operator can reuse the same source without hosted fallbacks.
 */

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { getSettings } from "./settings";

type BundledRuntimeConfig = {
  appUrl?: unknown;
  relayUrl?: unknown;
};

let cachedConfig: BundledRuntimeConfig | null = null;

function runtimeConfigPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "runtime-config.json")
    : path.join(__dirname, "..", "..", "resources", "runtime-config.json");
}

function bundledRuntimeConfig(): BundledRuntimeConfig {
  if (cachedConfig) return cachedConfig;
  try {
    cachedConfig = JSON.parse(
      fs.readFileSync(runtimeConfigPath(), "utf8")
    ) as BundledRuntimeConfig;
  } catch {
    cachedConfig = {};
  }
  return cachedConfig;
}

function requireUrl(
  label: string,
  candidate: unknown,
  protocols: readonly string[]
): string {
  const value = typeof candidate === "string" ? candidate.trim() : "";
  if (!value) {
    throw new Error(`${label} is required`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${label} must use ${protocols.join(" or ")}`);
  }
  return value.replace(/\/$/, "");
}

export function configuredAppUrl(): string {
  const bundled = bundledRuntimeConfig();
  return requireUrl(
    "GROOVY_APP_URL",
    process.env.GROOVY_APP_URL || getSettings().appUrl || bundled.appUrl,
    ["http:", "https:"]
  );
}

export function configuredRelayUrl(): string {
  const bundled = bundledRuntimeConfig();
  return requireUrl(
    "GROOVY_RELAY_URL",
    process.env.GROOVY_RELAY_URL || bundled.relayUrl,
    ["ws:", "wss:"]
  );
}
