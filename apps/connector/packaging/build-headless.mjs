import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { buildRnnoiseNativeAddon } from "./rnnoiseNative.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const distDir = path.resolve(root, "dist");
const headlessDir = path.resolve(distDir, "headless");
const tarballName = "Groovy-Connector-Headless.tar.gz";
const tarballPath = path.resolve(distDir, tarballName);

const requiredPaths = [
  "connector.mjs",
  "codexPlans.mjs",
  "browser.mjs",
  "browserTask.mjs",
  "files.mjs",
  "obsidian.mjs",
  "siteDev.mjs",
  "linkdb.mjs",
  "credentials.mjs",
  "sqlitedb.mjs",
  "sqliteProjects.mjs",
  "whatsapp.mjs",
  "aiyraVoice.mjs",
  "aec.mjs",
  "rnnoise.mjs",
  "native",
  "platform",
  "package.json",
  "package-lock.json",
];

const optionalPaths = ["wakewords"];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyRecursive(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function assertExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`[headless] Missing required path: ${label}`);
  }
}

function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      "[headless] Groovy Connector headless bundles currently support Apple Silicon macOS builds only."
    );
  }
  ensureDir(distDir);
  buildRnnoiseNativeAddon(root);
  if (fs.existsSync(headlessDir)) {
    fs.rmSync(headlessDir, { recursive: true, force: true });
  }
  ensureDir(headlessDir);

  for (const f of requiredPaths) {
    const src = path.resolve(root, f);
    assertExists(src, f);
    const dest = path.resolve(headlessDir, f);
    copyRecursive(src, dest);
  }

  for (const f of optionalPaths) {
    const src = path.resolve(root, f);
    if (!fs.existsSync(src)) continue;
    const dest = path.resolve(headlessDir, f);
    copyRecursive(src, dest);
  }

  const nodeModules = path.resolve(root, "node_modules");
  assertExists(nodeModules, "node_modules");
  copyRecursive(nodeModules, path.resolve(headlessDir, "node_modules"));

  execFileSync("tar", ["-czf", tarballPath, "-C", headlessDir, "."], {
    stdio: "inherit",
  });

  console.log(`[headless] Built ${tarballPath}`);
}

main();
