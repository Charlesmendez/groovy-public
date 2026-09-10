// Run after a production build. SDK subprocess files are not ordinary imports.
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sdkFiles = ["cli.js", "sdk.mjs", "package.json"];
for (const route of ["orchestrator", "home-inbox/run"]) {
  const tracePath = resolve(root, `.next/server/app/api/${route}/route.js.nft.json`);
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  const files = new Set(trace.files.map((file) => resolve(dirname(tracePath), file)));
  for (const file of sdkFiles) {
    const relative = `node_modules/@anthropic-ai/claude-agent-sdk/${file}`;
    assert(files.has(resolve(root, relative)), `${route} must trace the SDK ${file}`);
    await access(resolve(root, ".next/standalone", relative));
  }
  console.log(`Verified SDK subprocess runtime in ${route} trace and standalone package.`);
}
