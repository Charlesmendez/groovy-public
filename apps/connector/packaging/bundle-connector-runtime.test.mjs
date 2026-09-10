import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CONNECTOR_MJS_FILES } from "./bundle-connector-runtime.mjs";

const connectorDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function localMjsImports(relativePath) {
  const source = fs.readFileSync(path.join(connectorDir, relativePath), "utf8");
  const imports = [];
  const pattern = /(?:from\s+|import\s*\()?["'](\.\/[^"']+\.mjs)["']/g;
  for (const match of source.matchAll(pattern)) {
    imports.push(path.normalize(path.join(path.dirname(relativePath), match[1])));
  }
  return imports;
}

test("Desktop connector bundle includes every top-level local runtime import", () => {
  const bundledFiles = new Set(CONNECTOR_MJS_FILES);
  const missingImports = new Set();

  for (const relativePath of bundledFiles) {
    for (const importedPath of localMjsImports(relativePath)) {
      if (importedPath.startsWith(`platform${path.sep}`)) continue;
      if (!bundledFiles.has(importedPath)) missingImports.add(importedPath);
    }
  }

  assert.deepEqual([...missingImports].sort(), []);
  assert.equal(bundledFiles.has("skillActions.mjs"), true);
});
