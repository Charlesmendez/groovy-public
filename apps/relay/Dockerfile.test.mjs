import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("relay image copies every local module imported by the server", async () => {
  const [dockerfile, server] = await Promise.all([
    readFile(new URL("./Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("./server.mjs", import.meta.url), "utf8"),
  ]);
  const localImports = Array.from(
    server.matchAll(/from\s+["']\.\/([^"']+)["']/g),
    (match) => match[1],
  );
  const copiedFiles = new Set(
    Array.from(dockerfile.matchAll(/^COPY\s+(\S+)\s+\.\/$/gm), (match) =>
      match[1],
    ),
  );

  assert.ok(localImports.length > 0, "expected local relay imports");
  for (const modulePath of localImports) {
    assert.ok(
      copiedFiles.has(modulePath),
      `${modulePath} must be copied into the relay image`,
    );
  }
});
