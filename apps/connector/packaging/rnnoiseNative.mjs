import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function buildEnv() {
  const env = { ...process.env };
  if (!env.PYTHON && process.platform !== "win32" && fs.existsSync("/usr/bin/python3")) {
    env.PYTHON = "/usr/bin/python3";
  }
  return env;
}

export function getRnnoiseNativeAddonOutputPath(connectorDir) {
  return path.resolve(
    connectorDir,
    "native",
    "rnnoise-addon",
    "build",
    "Release",
    "rnnoise.node"
  );
}

export function buildRnnoiseNativeAddon(connectorDir) {
  execSync(
    "npm exec -- node-gyp rebuild --directory native/rnnoise-addon",
    {
      cwd: connectorDir,
      env: buildEnv(),
      stdio: "inherit",
      shell: true,
    }
  );

  const outputPath = getRnnoiseNativeAddonOutputPath(connectorDir);
  if (!fs.existsSync(outputPath)) {
    throw new Error(
      `[rnnoise-native] Expected build output was not generated: ${outputPath}`
    );
  }

  return outputPath;
}
