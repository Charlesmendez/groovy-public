#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_BUCKET = "groovy-downloads";
const DEFAULT_CHUNK_SIZE = 40 * 1024 * 1024;
const DEFAULT_LICENSE_TYPES = ["personal", "enterprise", "enterprise_reseller"];
const initialEnvKeys = new Set(Object.keys(process.env));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (initialEnvKeys.has(key)) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

loadEnvFile(path.resolve(process.cwd(), ".env"));
loadEnvFile(path.resolve(process.cwd(), ".env.local"));

function usage() {
  console.error(`Usage:
  node scripts/publish-connector-downloads.mjs \\
    --version 0.22.86 \\
    --macos-dmg apps/connector/dist/Groovy-Connector-macOS.dmg

  node scripts/publish-connector-downloads.mjs \\
    --version 0.22.86 \\
    --windows-exe apps/connector/dist/Groovy-Connector-windows.exe

Options:
  --channel <stable|beta|dev|enterprise>      Default: stable
  --bucket <bucket>                           Default: groovy-downloads
  --prefix <storage-prefix>                   Default: connector/releases/<version>
  --license-types <csv>                       Default: personal,enterprise,enterprise_reseller
  --chunk-size <bytes>                        Default: 41943040
  --platform-macos <value>                    Default: macos
  --windows-exe <path>
  --platform-windows <value>                  Default: windows
  --release-notes-url <url>
  --dry-run

Groovy Desktop (Electron) artifacts — all three must be provided together:
  --desktop-macos <path-to-dmg>               Signed+notarized Groovy Desktop DMG
  --desktop-macos-zip <path-to-zip>           electron-builder ZIP (used by auto-update)
  --desktop-feed <path-to-latest-mac.yml>     electron-builder update feed manifest

  Desktop artifacts are chunk-uploaded under <prefix>/macos-desktop/ and the
  latest-mac.yml is stored as a plain object in that same directory; the
  /api/updates/desktop-feed route derives its location from the DMG row's
  file_url. Rows: platform 'macos-desktop' (dmg) + 'macos-desktop-zip' (zip).
`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    channel: "stable",
    bucket: DEFAULT_BUCKET,
    chunkSize: DEFAULT_CHUNK_SIZE,
    dryRun: false,
    licenseTypes: DEFAULT_LICENSE_TYPES,
    macosPlatform: "macos",
    windowsPlatform: "windows",
    releaseNotesUrl: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length || argv[i].startsWith("--")) usage();
      return argv[i];
    };

    if (key === "--version") args.version = next();
    else if (key === "--channel") args.channel = next();
    else if (key === "--bucket") args.bucket = next();
    else if (key === "--prefix") args.prefix = next();
    else if (key === "--chunk-size") args.chunkSize = Number(next());
    else if (key === "--license-types") args.licenseTypes = splitCsv(next());
    else if (key === "--macos-dmg") args.macosDmg = next();
    else if (key === "--platform-macos") args.macosPlatform = next();
    else if (key === "--windows-exe") args.windowsExe = next();
    else if (key === "--platform-windows") args.windowsPlatform = next();
    else if (key === "--release-notes-url") args.releaseNotesUrl = next();
    else if (key === "--desktop-macos") args.desktopMacosDmg = next();
    else if (key === "--desktop-macos-zip") args.desktopMacosZip = next();
    else if (key === "--desktop-feed") args.desktopFeed = next();
    else if (key === "--dry-run") args.dryRun = true;
    else usage();
  }

  if (!args.version || !String(args.version).trim()) usage();
  args.version = String(args.version).trim().replace(/^v/i, "");
  args.prefix = String(args.prefix || `connector/releases/${args.version}`).replace(/^\/+|\/+$/g, "");
  const desktopFlags = [args.desktopMacosDmg, args.desktopMacosZip, args.desktopFeed];
  const desktopFlagCount = desktopFlags.filter(Boolean).length;
  if (desktopFlagCount > 0 && desktopFlagCount < 3) {
    throw new Error(
      "--desktop-macos, --desktop-macos-zip and --desktop-feed must be provided together"
    );
  }
  if (!args.macosDmg && !args.windowsExe && !args.desktopMacosDmg) usage();
  if (!["stable", "beta", "dev", "enterprise"].includes(args.channel)) {
    throw new Error(`Invalid channel: ${args.channel}`);
  }
  if (!Number.isFinite(args.chunkSize) || args.chunkSize < 1024 * 1024) {
    throw new Error("--chunk-size must be at least 1048576 bytes");
  }
  if (!args.licenseTypes.length) {
    throw new Error("--license-types must contain at least one license type");
  }

  return args;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function contentTypeFor(filename) {
  if (filename.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (filename.endsWith(".zip")) return "application/zip";
  if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) return "application/gzip";
  if (filename.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  return "application/octet-stream";
}

function sha256Hex(bufferOrPath) {
  const hash = createHash("sha256");
  if (typeof bufferOrPath === "string") {
    const fd = fs.openSync(bufferOrPath, "r");
    try {
      const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
      while (true) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      fs.closeSync(fd);
    }
  } else {
    hash.update(bufferOrPath);
  }
  return hash.digest("hex");
}

function run(command, args) {
  execFileSync(command, args, { stdio: "pipe", encoding: "utf8" });
}

function verifyMacosDmg(dmgPath) {
  if (process.platform !== "darwin") {
    throw new Error("macOS DMG notarization verification must run on macOS.");
  }

  try {
    run("codesign", ["-dv", "--verbose=4", dmgPath]);
  } catch (err) {
    throw new Error(
      `Refusing to publish unsigned macOS DMG. codesign failed for ${dmgPath}: ${String(
        err.stderr || err.message || err
      ).trim()}`
    );
  }

  try {
    run("spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "-v",
      dmgPath,
    ]);
  } catch (err) {
    throw new Error(
      `Refusing to publish macOS DMG that Gatekeeper rejects. spctl failed for ${dmgPath}: ${String(
        err.stderr || err.message || err
      ).trim()}`
    );
  }

  try {
    run("xcrun", ["stapler", "validate", dmgPath]);
  } catch (err) {
    throw new Error(
      `Refusing to publish macOS DMG without a valid notarization staple. stapler failed for ${dmgPath}: ${String(
        err.stderr || err.message || err
      ).trim()}`
    );
  }
}

function supabaseConfig() {
  const url = (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ""
  ).replace(/\/+$/, "");
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_SUPABASE_SERVICE_ROLE_KEY ||
    "";
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return { url, key };
}

function authHeaders(config) {
  return {
    apikey: config.key,
    authorization: `Bearer ${config.key}`,
  };
}

function encodeStoragePath(bucket, objectPath) {
  return [bucket, ...objectPath.split("/")]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function checkedFetch(url, options, expectedStatus = [200, 201, 204]) {
  const res = await fetch(url, options);
  if (!expectedStatus.includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return res;
}

async function uploadStorageObject(config, bucket, objectPath, body, contentType) {
  const url = `${config.url}/storage/v1/object/${encodeStoragePath(bucket, objectPath)}`;
  await checkedFetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(config),
      "content-type": contentType,
      "x-upsert": "true",
    },
    body,
  });
}

async function publishDownloadRow(config, row) {
  const platformFilter =
    row.platform === "macos"
      ? "in.(macos,macos-arm64,darwin)"
      : row.platform === "windows"
        ? "in.(windows,windows-x64,win32)"
        : `eq.${row.platform}`;
  const filters = new URLSearchParams({
    platform: platformFilter,
    channel: `eq.${row.channel}`,
    is_active: "eq.true",
  });
  await checkedFetch(`${config.url}/rest/v1/downloads?${filters}`, {
    method: "PATCH",
    headers: {
      ...authHeaders(config),
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({ is_active: false }),
  });

  const insert = await checkedFetch(`${config.url}/rest/v1/downloads`, {
    method: "POST",
    headers: {
      ...authHeaders(config),
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  const json = await insert.json().catch(() => null);
  return Array.isArray(json) ? json[0] : json;
}

async function uploadChunkedArtifact(config, artifact, options) {
  const filename = path.basename(artifact.path);
  const size = fs.statSync(artifact.path).size;
  const checksum = `sha256:${sha256Hex(artifact.path)}`;
  const contentType = artifact.contentType || contentTypeFor(filename);
  // storageDir lets multiple downloads rows (e.g. macos-desktop +
  // macos-desktop-zip) share one storage directory per release.
  const artifactPrefix = `${options.prefix}/${artifact.storageDir || artifact.platform}/${filename}`;
  const chunks = [];
  const fd = fs.openSync(artifact.path, "r");

  try {
    let offset = 0;
    let index = 0;
    while (offset < size) {
      const length = Math.min(options.chunkSize, size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw new Error(`Short read while chunking ${artifact.path}`);
      }

      const chunkBuffer = buffer.subarray(0, bytesRead);
      const chunkPath = `${artifactPrefix}.part-${String(index).padStart(4, "0")}`;
      const chunkChecksum = `sha256:${sha256Hex(chunkBuffer)}`;
      if (!options.dryRun) {
        await uploadStorageObject(
          config,
          options.bucket,
          chunkPath,
          chunkBuffer,
          "application/octet-stream"
        );
      }
      chunks.push({
        index,
        path: chunkPath,
        size: bytesRead,
        checksum: chunkChecksum,
      });
      offset += bytesRead;
      index += 1;
      console.log(
        `[publish-downloads] ${options.dryRun ? "prepared" : "uploaded"} chunk ${index} for ${filename}`
      );
    }
  } finally {
    fs.closeSync(fd);
  }

  const manifestPath = `${artifactPrefix}.manifest.json`;
  const manifest = {
    filename,
    contentType,
    size,
    checksum,
    chunks,
  };
  if (!options.dryRun) {
    await uploadStorageObject(
      config,
      options.bucket,
      manifestPath,
      Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
      "application/json"
    );
  }

  return {
    manifestPath,
    row: {
      version: options.version,
      channel: options.channel,
      platform: artifact.platform,
      file_url: `supabase-chunked://${options.bucket}/${manifestPath}`,
      checksum,
      release_notes_url: options.releaseNotesUrl,
      license_type_allowed: options.licenseTypes,
      is_active: true,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const artifacts = [];
  if (args.macosDmg) {
    const macosPath = path.resolve(args.macosDmg);
    if (!fs.existsSync(macosPath)) {
      throw new Error(`Missing macOS DMG: ${macosPath}`);
    }

    console.log(`[publish-downloads] verifying notarized macOS DMG: ${macosPath}`);
    verifyMacosDmg(macosPath);
    artifacts.push({
      path: macosPath,
      platform: args.macosPlatform,
      contentType: "application/x-apple-diskimage",
    });
  }

  if (args.windowsExe) {
    const windowsPath = path.resolve(args.windowsExe);
    if (!fs.existsSync(windowsPath)) {
      throw new Error(`Missing Windows installer: ${windowsPath}`);
    }
    artifacts.push({
      path: windowsPath,
      platform: args.windowsPlatform,
      contentType: "application/vnd.microsoft.portable-executable",
    });
  }

  let desktopFeedPath = null;
  if (args.desktopMacosDmg) {
    const desktopDmgPath = path.resolve(args.desktopMacosDmg);
    const desktopZipPath = path.resolve(args.desktopMacosZip);
    desktopFeedPath = path.resolve(args.desktopFeed);
    for (const [label, filePath] of [
      ["desktop DMG", desktopDmgPath],
      ["desktop ZIP", desktopZipPath],
      ["desktop feed (latest-mac.yml)", desktopFeedPath],
    ]) {
      if (!fs.existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
    }

    console.log(`[publish-downloads] verifying notarized Groovy Desktop DMG: ${desktopDmgPath}`);
    verifyMacosDmg(desktopDmgPath);
    artifacts.push({
      path: desktopDmgPath,
      platform: "macos-desktop",
      storageDir: "macos-desktop",
      contentType: "application/x-apple-diskimage",
    });
    artifacts.push({
      path: desktopZipPath,
      platform: "macos-desktop-zip",
      storageDir: "macos-desktop",
      contentType: "application/zip",
    });
  }

  const config = supabaseConfig();
  const published = [];
  for (const artifact of artifacts) {
    published.push(
      await uploadChunkedArtifact(config, artifact, {
        version: args.version,
        channel: args.channel,
        bucket: args.bucket,
        prefix: args.prefix,
        chunkSize: args.chunkSize,
        licenseTypes: args.licenseTypes,
        releaseNotesUrl: args.releaseNotesUrl,
        dryRun: args.dryRun,
      })
    );
  }

  // Upload latest-mac.yml as a PLAIN storage object in the shared desktop
  // directory before activating rows so /api/updates/desktop-feed never sees
  // an active row without its feed manifest.
  if (desktopFeedPath) {
    const feedObjectPath = `${args.prefix}/macos-desktop/latest-mac.yml`;
    if (!args.dryRun) {
      await uploadStorageObject(
        config,
        args.bucket,
        feedObjectPath,
        fs.readFileSync(desktopFeedPath),
        "text/yaml"
      );
    }
    console.log(
      `[publish-downloads] ${args.dryRun ? "prepared" : "uploaded"} desktop feed: ${feedObjectPath}`
    );
  }

  if (args.dryRun) {
    console.log("[publish-downloads] dry run complete");
    console.log(JSON.stringify(published.map((item) => item.row), null, 2));
    return;
  }

  const rows = [];
  for (const item of published) {
    rows.push(await publishDownloadRow(config, item.row));
  }
  console.log("[publish-downloads] active download rows updated");
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((err) => {
  console.error(`[publish-downloads] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
