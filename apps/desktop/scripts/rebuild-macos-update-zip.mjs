#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(desktopDir, "dist-app");
const appPath = path.join(outputDir, "mac-arm64", "Groovy.app");
const { version } = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const zipName = `Groovy-${version}-arm64-mac.zip`;
const dmgName = `Groovy-${version}-arm64.dmg`;
const zipPath = path.join(outputDir, zipName);
const dmgPath = path.join(outputDir, dmgName);
const blockmapPath = `${zipPath}.blockmap`;
const feedPath = path.join(outputDir, "latest-mac.yml");
const appBuilder = path.join(
  desktopDir,
  "node_modules",
  "app-builder-bin",
  "mac",
  process.arch === "arm64" ? "app-builder_arm64" : "app-builder_amd64"
);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function runText(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${String(result.stderr || "").trim()}`);
  }
  return String(result.stdout || "").trim();
}

function sha512(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("base64");
}

if (process.platform !== "darwin") {
  throw new Error("The macOS update ZIP must be rebuilt on macOS.");
}

const appVersion = runText("/usr/libexec/PlistBuddy", [
  "-c",
  "Print :CFBundleShortVersionString",
  path.join(appPath, "Contents", "Info.plist"),
]);
if (appVersion !== version) {
  throw new Error(`Signed app version ${appVersion || "unknown"} does not match ${version}.`);
}

rmSync(zipPath, { force: true });
rmSync(blockmapPath, { force: true });

// electron-builder's ZIP archiver drops the extended-attribute signatures
// applied to executable resources in the bundled connector. ditto's
// sequestered resource forks preserve them for Squirrel.Mac extraction.
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
run(appBuilder, ["blockmap", `--input=${zipPath}`, `--output=${blockmapPath}`]);

const extractedDir = mkdtempSync(path.join(tmpdir(), "groovy-update-verify-"));
try {
  run("ditto", ["-x", "-k", zipPath, extractedDir]);
  const extractedApp = path.join(extractedDir, "Groovy.app");
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", extractedApp]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", extractedApp]);
} finally {
  rmSync(extractedDir, { recursive: true, force: true });
}

const releaseDate = new Date().toISOString();
writeFileSync(
  feedPath,
  [
    `version: ${version}`,
    "files:",
    `  - url: ${zipName}`,
    `    sha512: ${sha512(zipPath)}`,
    `    size: ${statSync(zipPath).size}`,
    `  - url: ${dmgName}`,
    `    sha512: ${sha512(dmgPath)}`,
    `    size: ${statSync(dmgPath).size}`,
    `path: ${zipName}`,
    `sha512: ${sha512(zipPath)}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n"),
  "utf8"
);

console.log(`[desktop-release] verified update ZIP and regenerated ${path.basename(feedPath)}`);
