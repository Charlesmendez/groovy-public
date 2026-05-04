#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const targetRepo = process.env.PUBLIC_MIRROR_REPO || "Charlesmendez/groovy-public";
const targetBranch = process.env.PUBLIC_MIRROR_BRANCH || "main";
const pushUrl =
  process.env.PUBLIC_MIRROR_PUSH_URL || `git@github.com:${targetRepo}.git`;
const delayDays = Number(process.env.PUBLIC_MIRROR_DELAY_DAYS || "90");
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

function latestDelayedTag() {
  const cutoff = Date.now() - delayDays * 24 * 60 * 60 * 1000;
  const lines = git([
    "for-each-ref",
    `refs/tags/${tagPattern}`,
    "--sort=-creatordate",
    "--format=%(refname:short)|%(creatordate:iso-strict)",
  ])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const [tag, date] = line.split("|");
    const createdAt = Date.parse(date);
    if (tag && Number.isFinite(createdAt) && createdAt <= cutoff) return tag;
  }
  return null;
}

function resolveSourceRef() {
  if (explicitRef) return explicitRef;
  const tag = latestDelayedTag();
  if (!tag) {
    if (noopWhenNoTag) {
      console.log(`No tag older than ${delayDays} days found; nothing to publish.`);
      process.exit(0);
    }
    throw new Error(
      `No tag older than ${delayDays} days found. Set PUBLIC_MIRROR_SOURCE_REF to publish a specific release.`
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
    ".github/workflows/publish-public-mirror.yml",
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

const sourceRef = resolveSourceRef();
const sourceSha = git(["rev-parse", sourceRef]);
const sourceName = safeRefName(sourceRef);
const tmpRoot = mkdtempSync(path.join(tmpdir(), "groovy-public-mirror-"));
const archivePath = path.join(tmpRoot, "source.tar");
const sourceDir = path.join(tmpRoot, "source");
const mirrorDir = path.join(tmpRoot, "mirror");

try {
  git(["archive", "--format=tar", "--output", archivePath, sourceRef]);
  run("mkdir", ["-p", sourceDir]);
  run("tar", ["-xf", archivePath, "-C", sourceDir]);
  cleanSourceTree(sourceDir);
  writeFileSync(
    path.join(sourceDir, "PUBLIC-MIRROR-NOTICE.md"),
    [
      "# Groovy Public Mirror",
      "",
      "This repository is a delayed source-available public mirror.",
      "",
      `Published from private source ref: ${sourceRef}`,
      `Private source commit: ${sourceSha}`,
      `Mirror delay policy: ${delayDays} days unless manually overridden`,
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
    console.log("Public mirror already up to date.");
    process.exit(0);
  }

  git(
    [
      "-c",
      "user.name=groovy-public-mirror-bot",
      "-c",
      "user.email=public-mirror@gogroovy.ai",
      "commit",
      "-m",
      `Publish delayed public mirror from ${sourceName}`,
      "-m",
      `Private source commit: ${sourceSha}`,
    ],
    { cwd: mirrorDir, stdio: "inherit" }
  );

  git(["push", "origin", targetBranch], { cwd: mirrorDir, stdio: "inherit" });
  git(["tag", "-f", `public-${sourceName}`], { cwd: mirrorDir, stdio: "inherit" });
  git(["push", "origin", "-f", `public-${sourceName}`], {
    cwd: mirrorDir,
    stdio: "inherit",
  });
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
