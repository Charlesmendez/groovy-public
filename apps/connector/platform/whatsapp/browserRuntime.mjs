import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const localRequire = createRequire(import.meta.url);

function readPuppeteerRuntime() {
  const puppeteer = localRequire("puppeteer");
  const packageJson = localRequire("puppeteer/package.json");
  const expectedRevision = String(puppeteer?.PUPPETEER_REVISIONS?.chrome || "").trim();
  let executablePath = "";
  try {
    executablePath = String(puppeteer.executablePath?.() || "").trim();
  } catch {
    executablePath = "";
  }
  return {
    expectedRevision,
    executablePath,
    puppeteerVersion: String(packageJson?.version || "").trim(),
  };
}

export function parseChromiumMajor(versionText) {
  const match = String(versionText || "").match(
    /(?:Google Chrome(?: for Testing)?|Microsoft Edge|Chrome|Chromium|HeadlessChrome)[\/\s]+(\d+)(?:\.|\b)/i
  );
  return match ? Number(match[1]) : null;
}

export function parseRevisionMajor(revision) {
  const match = String(revision || "").trim().match(/^(\d+)(?:\.|\b)/);
  return match ? Number(match[1]) : null;
}

export function getSystemBrowserCandidates({
  platform = process.platform,
  homeDirectory = os.homedir(),
  env = process.env,
} = {}) {
  const explicit = [
    env.GROOVY_WHATSAPP_CHROME_PATH,
    env.PUPPETEER_EXECUTABLE_PATH,
    env.CHROME_PATH,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((executablePath) => ({ executablePath, source: "explicit" }));

  const macApp = (appName, executableName = appName) => [
    path.join("/Applications", `${appName}.app`, "Contents", "MacOS", executableName),
    path.join(homeDirectory, "Applications", `${appName}.app`, "Contents", "MacOS", executableName),
  ];

  let discovered = [];
  if (platform === "darwin") {
    discovered = [
      ...macApp("Google Chrome"),
      ...macApp("Google Chrome Beta"),
      ...macApp("Chromium"),
      ...macApp("Microsoft Edge"),
    ];
  } else if (platform === "win32") {
    discovered = [
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
      env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    ];
  } else {
    discovered = [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
    ];
  }

  return [
    ...explicit,
    ...discovered.filter(Boolean).map((executablePath) => ({
      executablePath,
      source: "system",
    })),
  ];
}

export function getWhatsAppPuppeteerInfo(overrides = {}) {
  const discovered = overrides.discovered || readPuppeteerRuntime();
  return {
    expectedRevision: String(overrides.expectedRevision || discovered.expectedRevision || "").trim(),
    executablePath: String(overrides.executablePath || discovered.executablePath || "").trim(),
    puppeteerVersion: String(overrides.puppeteerVersion || discovered.puppeteerVersion || "").trim(),
  };
}

export function buildPowerEfficientPuppeteerOptions({
  executablePath,
  headless,
  width = 1280,
  height = 800,
} = {}) {
  const browserPath = String(executablePath || "").trim();
  if (!browserPath) throw new Error("missing_browser_executable");
  return {
    headless,
    executablePath: browserPath,
    protocolTimeout: 240_000,
    // Puppeteer disables these Chromium background throttles by default. The
    // WhatsApp tab is a long-lived background service, so restore them.
    ignoreDefaultArgs: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--mute-audio",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--window-position=0,0",
      `--window-size=${width},${height}`,
    ],
    defaultViewport: {
      width,
      height,
      deviceScaleFactor: 1,
    },
  };
}

export async function readBrowserVersion(executablePath) {
  const { stdout, stderr } = await execFileAsync(executablePath, ["--version"], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return String(stdout || stderr || "").trim();
}

export async function resolveWhatsAppBrowserRuntime({
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
  existsSync = fs.existsSync,
  inspectVersion = readBrowserVersion,
  puppeteerInfo,
} = {}) {
  const info = getWhatsAppPuppeteerInfo(puppeteerInfo || {});
  const expectedMajor = parseRevisionMajor(info.expectedRevision);
  const configuredMinimumMajor = Number.parseInt(
    String(env.GROOVY_WHATSAPP_MIN_CHROME_MAJOR || ""),
    10
  );
  const minimumMajor = Number.isFinite(configuredMinimumMajor)
    ? Math.max(100, Math.min(999, configuredMinimumMajor))
    : 150;
  if (!info.puppeteerVersion) {
    return {
      ok: false,
      error: "puppeteer_runtime_metadata_missing",
      expectedRevision: info.expectedRevision || null,
      puppeteerVersion: info.puppeteerVersion || null,
      minimumMajor,
      rejected: [],
    };
  }

  const candidates = [];
  const systemCandidates = getSystemBrowserCandidates({ platform, homeDirectory, env });
  candidates.push(...systemCandidates.filter((candidate) => candidate.source === "explicit"));
  candidates.push(...systemCandidates.filter((candidate) => candidate.source === "system"));
  if (info.executablePath) {
    candidates.push({ executablePath: info.executablePath, source: "puppeteer_cache" });
  }

  const allowOldExplicitBrowser = ["1", "true", "yes", "on"].includes(
    String(
      env.GROOVY_WHATSAPP_ALLOW_OLD_BROWSER ||
        env.GROOVY_WHATSAPP_ALLOW_BROWSER_MISMATCH ||
        ""
    ).trim().toLowerCase()
  );
  const seen = new Set();
  const rejected = [];

  for (const candidate of candidates) {
    const rawExecutable = String(candidate?.executablePath || "").trim();
    if (!rawExecutable) continue;
    const executablePath = path.resolve(rawExecutable);
    if (seen.has(executablePath)) continue;
    seen.add(executablePath);
    if (!existsSync(executablePath)) {
      rejected.push({ source: candidate.source, executablePath, reason: "not_found" });
      continue;
    }

    let version = "";
    try {
      version = await inspectVersion(executablePath);
    } catch (error) {
      rejected.push({
        source: candidate.source,
        executablePath,
        reason: "version_probe_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const actualMajor = parseChromiumMajor(version);
    const whatsappCompatible = Number(actualMajor) >= minimumMajor;
    if (
      !whatsappCompatible &&
      !(candidate.source === "explicit" && allowOldExplicitBrowser)
    ) {
      rejected.push({
        source: candidate.source,
        executablePath,
        reason: actualMajor ? "browser_too_old" : "unsupported_version_format",
        version,
        actualMajor,
        minimumMajor,
      });
      continue;
    }

    return {
      ok: true,
      executablePath,
      source: candidate.source,
      version,
      actualMajor,
      expectedMajor,
      minimumMajor,
      expectedRevision: info.expectedRevision,
      puppeteerVersion: info.puppeteerVersion,
      compatible: whatsappCompatible,
      protocolExact: actualMajor === expectedMajor,
      protocolMajorSkew:
        expectedMajor && actualMajor ? actualMajor - expectedMajor : null,
      mismatchAllowed: !whatsappCompatible,
      rejected,
    };
  }

  return {
    ok: false,
    error: "supported_browser_not_found",
    expectedMajor,
    minimumMajor,
    expectedRevision: info.expectedRevision,
    puppeteerVersion: info.puppeteerVersion,
    rejected,
  };
}
