#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const targetRepo = process.env.PUBLIC_MIRROR_REPO || "Charlesmendez/groovy-public";
const targetBranch = process.env.PUBLIC_MIRROR_BRANCH || "main";
const pushUrl =
  process.env.PUBLIC_MIRROR_PUSH_URL || `git@github.com:${targetRepo}.git`;
const explicitRef = (process.env.PUBLIC_MIRROR_SOURCE_REF || "").trim();
const noopWhenNoTag = process.env.PUBLIC_MIRROR_NOOP_WHEN_NO_TAG === "1";
const tagPattern = (process.env.PUBLIC_MIRROR_TAG_PATTERN || "source-v*").trim();

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    stdio: opts.stdio || "pipe",
    encoding: opts.encoding || "utf8",
    ...opts,
  });
}

function git(args, opts = {}) {
  const out = run("git", args, opts);
  return typeof out === "string" ? out.trim() : "";
}

function safeRefName(value) {
  return value.replace(/^refs\/tags\//, "").replace(/[^A-Za-z0-9._-]+/g, "-");
}

function latestSourceTag() {
  return (
    git([
      "for-each-ref",
      `refs/tags/${tagPattern}`,
      "--sort=-creatordate",
      "--format=%(refname:short)",
    ])
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || null
  );
}

function resolveSourceRef() {
  if (explicitRef) return explicitRef;
  const tag = latestSourceTag();
  if (!tag) {
    if (noopWhenNoTag) {
      console.log(`No source tag matching ${tagPattern} found; nothing to publish.`);
      process.exit(0);
    }
    throw new Error(
      `No source tag matching ${tagPattern} found. Set PUBLIC_MIRROR_SOURCE_REF to publish a specific release.`
    );
  }
  return tag;
}

function removeIfExists(root, relativePath) {
  const fullPath = path.join(root, relativePath);
  if (existsSync(fullPath)) rmSync(fullPath, { recursive: true, force: true });
}

function cleanSourceTree(root) {
  [
    ".git",
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".vercel",
    ".next",
    ".turbo",
    ".playwright-mcp",
    "node_modules",
    "apps/connector/dist",
    "apps/connector/.wwebjs_cache",
    "apps/connector/platform/wake/__pycache__",
    "supabase/.temp",
    ".github/workflows/deploy-relay-fly.yml",
    ".github/workflows/release-connector.yml",
    ".github/workflows/release-desktop.yml",
    ".github/workflows/publish-public-mirror.yml",
    "AGENTS.md",
  ].forEach((relativePath) => removeIfExists(root, relativePath));
}

function emptyMirrorWorktree(root) {
  for (const entry of run("find", [root, "-mindepth", "1", "-maxdepth", "1"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)) {
    if (path.basename(entry) === ".git") continue;
    rmSync(entry, { recursive: true, force: true });
  }
}

function remoteTagSha(root, tag) {
  const result = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`], {
    cwd: root,
  });
  return result ? result.split(/\s+/)[0] || null : null;
}

function createPublicTag(root, tag) {
  git(["tag", tag], { cwd: root, stdio: "inherit" });
  git(["push", "origin", tag], { cwd: root, stdio: "inherit" });
}

const sourceRef = resolveSourceRef();
if (/[\r\n]/.test(sourceRef)) {
  throw new Error("PUBLIC_MIRROR_SOURCE_REF must not contain line breaks.");
}
const sourceSha = git([
  "rev-parse",
  "--verify",
  "--end-of-options",
  `${sourceRef}^{commit}`,
]);
const sourceName = safeRefName(sourceRef);
const publicTag = `public-${sourceName}`;
const tmpRoot = mkdtempSync(path.join(tmpdir(), "groovy-public-mirror-"));
const archivePath = path.join(tmpRoot, "source.tar");
const sourceDir = path.join(tmpRoot, "source");
const mirrorDir = path.join(tmpRoot, "mirror");

try {
  git(["archive", "--format=tar", "--output", archivePath, sourceSha]);
  run("mkdir", ["-p", sourceDir]);
  run("tar", ["-xf", archivePath, "-C", sourceDir]);
  cleanSourceTree(sourceDir);
  writeFileSync(
    path.join(sourceDir, "PUBLIC-MIRROR-NOTICE.md"),
    [
      "# Groovy Public Mirror",
      "",
      "This repository is the release-synchronized source-available public mirror.",
      "",
      `Published from private source ref: ${sourceRef}`,
      `Private source commit: ${sourceSha}`,
      "Publication policy: source-v* releases are mirrored when their private tag is pushed.",
      "",
      "This mirror is for transparency, evaluation, security review, documentation, and contributions.",
      "Viewing, cloning, or forking this repository does not grant production, commercial, hosted, resale, sublicensing, managed-service, or internal business rights.",
      "",
    ].join("\n")
  );

  git(["clone", pushUrl, mirrorDir], { stdio: "inherit" });
  git(["checkout", "-B", targetBranch], { cwd: mirrorDir, stdio: "inherit" });
  emptyMirrorWorktree(mirrorDir);
  cpSync(sourceDir, mirrorDir, { recursive: true, force: true });
  git(["add", "-A"], { cwd: mirrorDir, stdio: "inherit" });

  const status = git(["status", "--porcelain"], { cwd: mirrorDir });
  if (!status) {
    const existingPublicTagSha = remoteTagSha(mirrorDir, publicTag);
    const publicHeadSha = git(["rev-parse", "HEAD"], { cwd: mirrorDir });
    if (existingPublicTagSha && existingPublicTagSha !== publicHeadSha) {
      throw new Error(
        `Public tag ${publicTag} points to ${existingPublicTagSha}, not ${publicHeadSha}. ` +
          "Source release tags are immutable; resolve the public repository state before retrying."
      );
    }
    if (!existingPublicTagSha) {
      createPublicTag(mirrorDir, publicTag);
    }
    console.log("Public mirror already up to date.");
  } else {
    if (remoteTagSha(mirrorDir, publicTag)) {
      throw new Error(
        `Public tag ${publicTag} already exists but the mirror contents differ. ` +
          "Source release tags are immutable; publish a new source-v* tag instead of rewriting a published release."
      );
    }

    git(
      [
        "-c",
        "user.name=groovy-public-mirror-bot",
        "-c",
        "user.email=public-mirror@gogroovy.ai",
        "commit",
        "-m",
        `Publish public mirror from ${sourceName}`,
        "-m",
        `Private source commit: ${sourceSha}`,
      ],
      { cwd: mirrorDir, stdio: "inherit" }
    );

    git(["push", "origin", targetBranch], { cwd: mirrorDir, stdio: "inherit" });
    createPublicTag(mirrorDir, publicTag);
  }
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
