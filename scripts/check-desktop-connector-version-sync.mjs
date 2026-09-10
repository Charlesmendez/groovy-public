#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseRefIndex = process.argv.indexOf("--base-ref");
const baseRef =
  baseRefIndex >= 0 && baseRefIndex + 1 < process.argv.length
    ? process.argv[baseRefIndex + 1].trim()
    : "";
const manifests = [
  "apps/connector/package.json",
  "apps/connector/package-lock.json",
  "apps/desktop/package.json",
  "apps/desktop/package-lock.json",
];

const versions = manifests.flatMap((relativePath) => {
  const absolutePath = path.join(repoRoot, relativePath);
  const manifest = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const candidates = [
    { relativePath, version: String(manifest?.version || "").trim() },
  ];
  if (relativePath.endsWith("package-lock.json")) {
    candidates.push({
      relativePath: `${relativePath} packages[""]`,
      version: String(manifest?.packages?.[""]?.version || "").trim(),
    });
  }
  for (const candidate of candidates) {
    if (
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
        candidate.version
      )
    ) {
      throw new Error(
        `${candidate.relativePath} has an invalid version: ${
          candidate.version || "<empty>"
        }`
      );
    }
  }
  return candidates;
});

const expectedVersion = versions[0].version;
const connectorVersionSource = fs.readFileSync(
  path.join(repoRoot, "src/lib/connector/version.ts"),
  "utf8"
);
const minimumVersionMatch = connectorVersionSource.match(
  /export const MIN_CONNECTOR_VERSION\s*=\s*"([^"]+)"/
);
if (!minimumVersionMatch) {
  throw new Error(
    "src/lib/connector/version.ts does not export MIN_CONNECTOR_VERSION as a string"
  );
}
versions.push({
  relativePath: "src/lib/connector/version.ts MIN_CONNECTOR_VERSION",
  version: minimumVersionMatch[1],
});

const mismatches = versions.filter(({ version }) => version !== expectedVersion);
if (mismatches.length > 0) {
  const details = versions
    .map(({ relativePath, version }) => `  ${relativePath}: ${version}`)
    .join("\n");
  throw new Error(
    `Groovy Desktop and Connector release versions must match so Desktop-managed connectors receive every connector release.\n${details}`
  );
}

if (baseRef && !/^0{40}$/.test(baseRef)) {
  const changedFiles = execFileSync(
    "git",
    ["diff", "--name-only", baseRef, "--"],
    { cwd: repoRoot, encoding: "utf8" }
  )
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
  const releaseAffectingChange = changedFiles.some(
    (file) =>
      file.startsWith("apps/connector/") ||
      file.startsWith("apps/desktop/src/") ||
      file.startsWith("apps/desktop/scripts/") ||
      file.startsWith("apps/desktop/resources/") ||
      file === "apps/desktop/electron-builder.yml" ||
      file === "apps/desktop/package.json" ||
      file === "apps/desktop/package-lock.json" ||
      file === ".github/workflows/release-connector.yml" ||
      file === ".github/workflows/release-desktop.yml" ||
      file === "scripts/check-desktop-connector-version-sync.mjs"
  );

  if (releaseAffectingChange) {
    const previousManifest = JSON.parse(
      execFileSync(
        "git",
        ["show", `${baseRef}:apps/connector/package.json`],
        { cwd: repoRoot, encoding: "utf8" }
      )
    );
    const previousVersion = String(previousManifest?.version || "").trim();
    const parseSemver = (version) => {
      const match = version.match(
        /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
      );
      if (!match) throw new Error(`Invalid previous Connector version: ${version}`);
      return {
        core: match.slice(1, 4).map(Number),
        prerelease: match[4] || "",
      };
    };
    const current = parseSemver(expectedVersion);
    const previous = parseSemver(previousVersion);
    let comparison = 0;
    for (let index = 0; index < 3 && comparison === 0; index += 1) {
      comparison = Math.sign(current.core[index] - previous.core[index]);
    }
    if (comparison === 0 && current.prerelease !== previous.prerelease) {
      if (!current.prerelease) comparison = 1;
      else if (!previous.prerelease) comparison = -1;
      else {
        comparison = current.prerelease.localeCompare(previous.prerelease, "en", {
          numeric: true,
        });
      }
    }
    if (comparison <= 0) {
      throw new Error(
        `Release-affecting Connector/Desktop changes require a synchronized version bump (${previousVersion} -> ${expectedVersion}).`
      );
    }
    console.log(
      `[release-version-sync] release version advances ${previousVersion} -> ${expectedVersion}`
    );
  }
}

console.log(`[release-version-sync] Desktop and Connector are both ${expectedVersion}`);
