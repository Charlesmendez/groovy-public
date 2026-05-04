import WebSocket from "ws";
import pty from "node-pty";
import os from "os";
import path from "path";
import dns from "dns";
import net from "net";
import fs from "fs";
import { promises as fsp } from "fs";
import { createHash } from "crypto";
import { execFile, execFileSync, spawn } from "child_process";
import { promisify } from "util";
import { createRequire } from "module";
import { Readable } from "stream";
import { fileURLToPath } from "url";

// Import new capability modules
import {
  fileRead,
  fileWrite,
  fileList,
  fileSearch,
  fileDelete,
  fileCreateDir,
  fileMove,
} from "./files.mjs";

import {
  discoverVaults,
  obsidianRead,
  obsidianWrite,
  obsidianSearch,
  obsidianList,
  obsidianDelete,
  obsidianDailyNote,
} from "./obsidian.mjs";

import {
  initBrowser,
  closeBrowser,
  browserNavigate,
  browserClick,
  browserType,
  browserPressKey,
  browserScreenshot,
  browserExtract,
  browserWait,
  browserScroll,
  browserGetInfo,
  browserEvaluate,
  browserFillForm,
  browserClosePage,
  browserListPages,
  // Claude Computer Use actions
  computerUseAction,
  getDisplayDimensions,
} from "./browser.mjs";

import { startWhatsAppBridge } from "./whatsapp.mjs";
import { startAiyraVoiceRuntime } from "./aiyraVoice.mjs";

const DEFAULT_OPENWAKEWORD_THRESHOLD = 0.27;
const DEFAULT_OPENWAKEWORD_ALLOW_APPROXIMATE = false;
const AIYRA_RUNTIME_RECOVERY_BASE_DELAY_MS = 2000;
const AIYRA_RUNTIME_RECOVERY_MAX_DELAY_MS = 30000;
import { runBrowserTaskOnConnector, runBrowserTaskViaPlaywright, isPlaywrightAvailable } from "./browserTask.mjs";
import { credentialGetMeta, credentialRequest } from "./credentials.mjs";
import {
  linkdbInit,
  linkdbUpsertLinks,
  linkdbUpdate,
  linkdbQuery,
  linkdbDigest,
} from "./linkdb.mjs";
import { sqliteExec, sqliteQuery, sqliteListDbs } from "./sqlitedb.mjs";
import {
  sqliteProjectList,
  sqliteProjectGetOrCreate,
  sqliteProjectUpdate,
} from "./sqliteProjects.mjs";
import { execPortableCommand, getPtyShellCandidates } from "./platform/shell/index.mjs";
import { killProcessTree, killProcessesByCommandFragment } from "./platform/process/index.mjs";
import {
  pickFolder as pickFolderPrompt,
  promptForPairingCode as promptForPairingCodePrompt,
} from "./platform/prompt/index.mjs";
import { installWindowsStartupArtifacts } from "./platform/startup/index.mjs";
import { runHeadlessClaude } from "./platform/claude/runHeadless.mjs";
import { runHeadlessCodex, resolveCodexBin, extractCodexResult } from "./platform/codex/runHeadlessCodex.mjs";
import {
  siteDevStart,
  siteDevStop,
  siteDevStopAll,
  siteReadFiles,
  siteTunnelRequest,
} from "./siteDev.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

// Optional: system keychain for storing device tokens securely
let keytar = null;
try {
  keytar = require("keytar");
} catch {
  keytar = null;
}

const KEYCHAIN_SERVICE = "groovy-connector";
const LEGACY_KEYCHAIN_SERVICE = "flow-connector";
const KEYCHAIN_ACCOUNT = "device-token-default";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LAUNCH_AGENT_LABEL = "ai.gogroovy.connector";
const LAUNCH_AGENT_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCH_AGENT_LABEL}.plist`
);

function getLockPath() {
  return path.join(os.homedir(), ".groovy", "connector.lock");
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureSingleInstance(opts = {}) {
  // Prevent multiple connector instances from killing each other (e.g. launchd + manual run).
  // We use a PID lock file with stale-lock recovery.
  const killOthers = opts?.killOthers === true;
  const lockPath = getLockPath();
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
          "utf8"
        );
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      return true;
    } catch {
      // If lock exists, check if it's stale.
      try {
        const raw = await fsp.readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw || "{}");
        const pid = Number(parsed?.pid || 0);
        if (isPidAlive(pid)) {
          if (!killOthers) {
            log(`another connector instance is already running (pid=${pid}); exiting`);
            return false;
          }

          log(`killing other connector instance (pid=${pid}) due to --kill-others`);
          await killProcessTree(pid, { graceMs: 800 });
          await new Promise((r) => setTimeout(r, 300));

          // Remove lock and retry acquiring it.
          await fsp.unlink(lockPath).catch(() => {});
          continue;
        }
        // Stale lock: remove and retry once.
        await fsp.unlink(lockPath).catch(() => {});
      } catch {
        // If we can't read/parse, remove and retry once.
        await fsp.unlink(lockPath).catch(() => {});
      }
    }
  }

  warn("failed to acquire connector lock; exiting");
  return false;
}

async function releaseSingleInstanceLock() {
  const lockPath = getLockPath();
  try {
    const raw = await fsp.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    const pid = Number(parsed?.pid || 0);
    if (pid === process.pid) {
      await fsp.unlink(lockPath).catch(() => {});
    }
  } catch {
    // ignore
  }
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const val = process.argv[idx + 1];
  return val && !val.startsWith("--") ? val : null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function normalizeCliString(v) {
  return typeof v === "string" ? v.trim() : "";
}

const CODEX_PLAN_SCAN_TIMEOUT_MS = 60_000;
const CLAUDE_PLAN_FILE_MAX_BYTES = 100 * 1024;
const CLAUDE_PLAN_TARGET_SCAN_TIMEOUT_MS = 3_000;

function withTimeoutResult(promise, timeoutMs, fallbackValue) {
  let timeoutId = null;
  const settledPromise = Promise.resolve(promise).then(
    (value) => ({ timedOut: false, value }),
    (error) => ({ timedOut: false, error })
  );
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ timedOut: true, value: fallbackValue });
    }, timeoutMs);
  });
  return Promise.race([settledPromise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function expandHomePath(value) {
  const raw = normalizeCliString(value);
  if (!raw) return "";
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function normalizePlanRoot(value) {
  const expanded = expandHomePath(value);
  return expanded ? path.resolve(expanded) : "";
}

async function collectCodexPlansInChild(workspaceRoots, timeoutMs) {
  const scriptPath = fileURLToPath(new URL("./codexPlans.mjs", import.meta.url));
  const { stdout } = await execFileAsync(
    process.execPath,
    [scriptPath, JSON.stringify(Array.isArray(workspaceRoots) ? workspaceRoots : [])],
    {
      timeout: timeoutMs + 5_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }
  );
  const parsed = JSON.parse(String(stdout || "{}"));
  if (!parsed?.ok) {
    throw new Error(String(parsed?.error || "codex_plan_child_failed"));
  }
  return Array.isArray(parsed.plans) ? parsed.plans : [];
}

function buildClaudePlanScanTargets(workspaceRoots) {
  const homeClaudeRoot = path.join(os.homedir(), ".claude");
  const targets = [
    {
      labelRoot: homeClaudeRoot,
      plansDir: path.join(homeClaudeRoot, "plans"),
    },
    ...workspaceRoots
      .map((root) => normalizePlanRoot(root))
      .filter(Boolean)
      .map((safeRoot) => ({
        labelRoot: safeRoot,
        plansDir: path.join(safeRoot, ".claude", "plans"),
      })),
  ];
  const seenDirs = new Set();
  return targets.filter((target) => {
    const key = normalizePlanRoot(target.plansDir);
    if (!key || seenDirs.has(key)) return false;
    seenDirs.add(key);
    return true;
  });
}

async function scanClaudePlanTarget(target) {
  const plans = [];
  try {
    const stat = await fsp.stat(target.plansDir);
    if (!stat.isDirectory()) return plans;
    const entries = await fsp.readdir(target.plansDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) return;
        const fullPath = path.join(target.plansDir, entry.name);
        try {
          const fileStat = await fsp.stat(fullPath);
          if (fileStat.size > CLAUDE_PLAN_FILE_MAX_BYTES) return;
          const content = await fsp.readFile(fullPath, "utf8");
          const titleMatch = content.match(/^#\s+(.+)$/m);
          const title = titleMatch ? titleMatch[1].trim() : entry.name.replace(/\.md$/i, "");
          plans.push({
            provider: "claude",
            workspaceRoot: target.labelRoot,
            filename: entry.name,
            title,
            content,
            modifiedAt: fileStat.mtime.toISOString(),
            sizeBytes: fileStat.size,
            sourcePath: fullPath,
          });
        } catch {
          // skip unreadable files
        }
      })
    );
  } catch {
    // no plans dir for this target
  }
  return plans;
}

function normalizeClampedNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeIntegerRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!s) return fallback;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function normalizeAiyraMicMode(value, fallback = "computer_default") {
  const raw = normalizeCliString(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (raw === "computer_default" || raw === "system_default" || raw === "specific") {
    return raw;
  }
  if (raw === "computer" || raw === "builtin" || raw === "built_in") {
    return "computer_default";
  }
  if (raw === "default" || raw === "os_default") {
    return "system_default";
  }
  return fallback;
}

function normalizeAiyraAecBackend(value, fallback = "webrtc") {
  const raw = normalizeCliString(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (raw === "legacy" || raw === "webrtc" || raw === "off") {
    return raw;
  }
  return fallback;
}

function normalizeAiyraMicName(value) {
  return normalizeCliString(value).replace(/\s+/g, " ");
}

function normalizeAiyraMicNameKey(value) {
  return normalizeAiyraMicName(value).toLowerCase();
}

function normalizeAiyraMicNameLooseKey(value) {
  return normalizeAiyraMicNameKey(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(stereo|mono|microphone|mic|input|audio|device)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findAiyraSpecificMicMatch(devices, micName) {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  const targetKey = normalizeAiyraMicNameKey(micName);
  if (!targetKey) return null;
  const exactMatch =
    devices.find((device) => normalizeAiyraMicNameKey(device?.name) === targetKey) || null;
  if (exactMatch) return exactMatch;

  const looseTargetKey = normalizeAiyraMicNameLooseKey(micName);
  if (!looseTargetKey) return null;
  const looseMatches = devices.filter((device) => {
    const looseDeviceKey = normalizeAiyraMicNameLooseKey(device?.name);
    if (!looseDeviceKey) return false;
    return (
      looseDeviceKey === looseTargetKey ||
      looseDeviceKey.includes(looseTargetKey) ||
      looseTargetKey.includes(looseDeviceKey)
    );
  });
  return looseMatches.length === 1 ? looseMatches[0] : null;
}

async function waitForSpecificAiyraMicAvailability(micName, opts = {}) {
  const targetMicName = normalizeAiyraMicName(micName);
  if (!targetMicName) {
    return { matchedDevice: null, waitedMs: 0 };
  }
  const timeoutMs = Math.max(0, Math.trunc(Number(opts.timeoutMs) || 0));
  const pollMs = Math.max(100, Math.trunc(Number(opts.pollMs) || 250));
  const startedAt = Date.now();
  while (true) {
    const devices = listAvailableAiyraAudioDevices();
    const matchedDevice = findAiyraSpecificMicMatch(devices, targetMicName);
    if (matchedDevice) {
      return {
        matchedDevice,
        waitedMs: Math.max(0, Date.now() - startedAt),
      };
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return {
        matchedDevice: null,
        waitedMs: Math.max(0, elapsedMs),
      };
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollMs, Math.max(100, timeoutMs - elapsedMs)))
    );
  }
}

function isDefaultLikeAudioDeviceName(name) {
  const normalized = normalizeAiyraMicNameKey(name);
  return (
    normalized === "default" ||
    normalized === "system default" ||
    normalized.startsWith("default ")
  );
}

function listAvailableAiyraAudioDevices() {
  try {
    const recorderMod = require("@picovoice/pvrecorder-node");
    const PvRecorder = recorderMod?.PvRecorder || recorderMod?.default?.PvRecorder;
    const names =
      PvRecorder && typeof PvRecorder.getAvailableDevices === "function"
        ? PvRecorder.getAvailableDevices()
        : [];
    if (!Array.isArray(names)) return [];
    return names.map((name, index) => ({
      index,
      name: normalizeAiyraMicName(name) || `Input ${index}`,
    }));
  } catch {
    return [];
  }
}

function isHostIntegratedComputerMicName(name) {
  const normalized = normalizeAiyraMicNameKey(name);
  if (!normalized) return false;
  return [
    "macbook",
    "macbook pro microphone",
    "macbook air microphone",
    "built-in",
    "built in",
    "internal microphone",
    "microphone array",
    "array microphone",
    "imac",
    "realtek",
    "surface",
  ].some((hint) => normalized.includes(hint));
}

function isDisplayAttachedComputerMicName(name) {
  const normalized = normalizeAiyraMicNameKey(name);
  if (!normalized) return false;
  return ["studio display", "display microphone"].some((hint) =>
    normalized.includes(hint)
  );
}

function scoreComputerPreferredAudioDevice(device) {
  const normalized = normalizeAiyraMicNameKey(device?.name);
  if (!normalized) return -10000;
  let score = 0;
  if (isDefaultLikeAudioDeviceName(normalized)) score -= 3000;

  if (isHostIntegratedComputerMicName(normalized)) {
    score += 9000;
  } else if (isDisplayAttachedComputerMicName(normalized)) {
    score += 4500;
  }

  if (normalized.includes("microphone")) score += 100;

  const strongNegativeHints = [
    "teams",
    "zoom",
    "virtual",
    "aggregate",
    "blackhole",
    "loopback",
    "iphone",
    "airpods",
    "bluetooth",
    "headset",
    "speakerphone",
    "yeti",
    "usb",
  ];
  for (const hint of strongNegativeHints) {
    if (normalized.includes(hint)) score -= 2500;
  }

  return score - Math.max(0, Number(device?.index) || 0);
}

function pickComputerDefaultAudioDevice(devices) {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const device of devices) {
    const score = scoreComputerPreferredAudioDevice(device);
    if (score > bestScore) {
      best = device;
      bestScore = score;
    }
  }
  if (best && bestScore > -1000) {
    return best;
  }
  const fallback = devices.find((device) => {
    const normalized = normalizeAiyraMicNameKey(device?.name);
    return (
      normalized &&
      !isDefaultLikeAudioDeviceName(normalized) &&
      ![
        "teams",
        "zoom",
        "virtual",
        "aggregate",
        "blackhole",
        "loopback",
      ].some((hint) => normalized.includes(hint))
    );
  });
  return fallback || devices[0] || null;
}

function resolveAiyraMicSelection({
  micMode,
  micName,
  legacyDeviceIndex,
}) {
  const devices = listAvailableAiyraAudioDevices();
  const normalizedLegacyIndex = normalizeIntegerRange(legacyDeviceIndex, -1, -1, 99);
  let storedMicMode = normalizeAiyraMicMode(micMode, "");
  let storedMicName = normalizeAiyraMicName(micName);

  if (!storedMicMode) {
    if (storedMicName) {
      storedMicMode = "specific";
    } else if (
      normalizedLegacyIndex >= 0 &&
      normalizedLegacyIndex < devices.length &&
      devices[normalizedLegacyIndex]?.name
    ) {
      storedMicMode = "specific";
      storedMicName = normalizeAiyraMicName(devices[normalizedLegacyIndex].name);
    } else {
      storedMicMode = "computer_default";
    }
  }

  let resolvedDeviceIndex = -1;
  let resolvedDeviceName = "";
  let fallbackReason = "";

  if (storedMicMode === "specific") {
    const matched = findAiyraSpecificMicMatch(devices, storedMicName);
    if (matched) {
      resolvedDeviceIndex = matched.index;
      resolvedDeviceName = matched.name;
      return {
        devices,
        micMode: storedMicMode,
        micName: storedMicName,
        resolvedDeviceIndex,
        resolvedDeviceName,
        fallbackReason,
      };
    }
    fallbackReason = storedMicName ? "specific_device_missing" : "specific_device_name_missing";
  }

  if (storedMicMode === "system_default") {
    return {
      devices,
      micMode: storedMicMode,
      micName: "",
      resolvedDeviceIndex: -1,
      resolvedDeviceName: "",
      fallbackReason,
    };
  }

  const pickedComputerMic = pickComputerDefaultAudioDevice(devices);
  if (pickedComputerMic) {
    return {
      devices,
      micMode: storedMicMode || "computer_default",
      micName: storedMicName,
      resolvedDeviceIndex: pickedComputerMic.index,
      resolvedDeviceName: pickedComputerMic.name,
      fallbackReason,
    };
  }

  return {
    devices,
    micMode: storedMicMode || "computer_default",
    micName: storedMicName,
    resolvedDeviceIndex: -1,
    resolvedDeviceName: "",
    fallbackReason: fallbackReason || "no_audio_devices_listed",
  };
}

function isPrivateIpAddress(ip) {
  const raw = String(ip || "").trim().toLowerCase();
  if (!raw) return true;
  if (net.isIP(raw) === 4) {
    const parts = raw.split(".").map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIP(raw) === 6) {
    if (raw === "::1" || raw === "::") return true;
    if (raw.startsWith("fc") || raw.startsWith("fd")) return true; // unique local
    if (raw.startsWith("fe8") || raw.startsWith("fe9") || raw.startsWith("fea") || raw.startsWith("feb")) return true; // link-local
    return false;
  }
  return true;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!host) return true;
  if (host === "localhost" || host === "localhost.localdomain") return true;
  if (host.endsWith(".local")) return true;
  if (!host.includes(".")) return true;
  return false;
}

async function assertPublicHostname(hostname) {
  const host = String(hostname || "").trim();
  if (!host) throw new Error("missing_host");
  if (net.isIP(host)) {
    if (isPrivateIpAddress(host)) throw new Error("private_ip_blocked");
    return;
  }
  if (isBlockedHostname(host)) throw new Error("local_host_blocked");
  let records = [];
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("dns_lookup_failed");
  }
  if (!Array.isArray(records) || records.length === 0) throw new Error("dns_lookup_empty");
  for (const rec of records) {
    const ip = String((rec && rec.address) || "").trim();
    if (!ip || isPrivateIpAddress(ip)) throw new Error("private_ip_blocked");
  }
}

function parseMailtoUnsubscribe(mailtoRaw) {
  const input = String(mailtoRaw || "").trim();
  if (!input) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "mailto:") return null;
    const to = (url.pathname || "").replace(/^\/+/, "").trim();
    if (!to) return null;
    const subject = url.searchParams.get("subject") || "";
    const body = url.searchParams.get("body") || "";
    return { to, subject, body, raw: input };
  } catch {
    return null;
  }
}

async function fetchWithSafeRedirects({ startUrl, method, timeoutMs = 8000, maxRedirects = 3 }) {
  let currentUrl = String(startUrl || "").trim();
  let httpMethod = String(method || "GET").toUpperCase();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(currentUrl, {
        method: httpMethod,
        redirect: "manual",
        signal: ac.signal,
        headers:
          httpMethod === "POST"
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
              }
            : undefined,
        body: httpMethod === "POST" ? "" : undefined,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, finalUrl: currentUrl, redirects: hop };
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop >= maxRedirects) {
        return { ok: false, error: "redirect_limit_exceeded", status: res.status, finalUrl: currentUrl };
      }
      const location = res.headers.get("location");
      if (!location) {
        return { ok: false, error: "redirect_missing_location", status: res.status, finalUrl: currentUrl };
      }
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        return { ok: false, error: "redirect_invalid_location", status: res.status, finalUrl: currentUrl };
      }
      if (nextUrl.protocol !== "https:") {
        return { ok: false, error: "redirect_non_https_blocked", status: res.status, finalUrl: currentUrl };
      }
      await assertPublicHostname(nextUrl.hostname);
      currentUrl = nextUrl.toString();
      if (res.status === 303) httpMethod = "GET";
      continue;
    }

    return {
      ok: false,
      error: `http_status_${res.status}`,
      status: res.status,
      finalUrl: currentUrl,
    };
  }
  return { ok: false, error: "redirect_loop", finalUrl: currentUrl };
}

async function executeLocalUnsubscribe({ unsubscribeUrl, unsubscribeMailto }) {
  const urlRaw = String(unsubscribeUrl || "").trim();
  const mailto = parseMailtoUnsubscribe(unsubscribeMailto);
  if (urlRaw) {
    let normalizedUrl;
    try {
      const parsed = new URL(urlRaw);
      if (parsed.protocol !== "https:") {
        return { ok: false, error: "unsubscribe_url_must_be_https" };
      }
      await assertPublicHostname(parsed.hostname);
      normalizedUrl = parsed.toString();
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "invalid_unsubscribe_url",
      };
    }

    const postAttempt = await fetchWithSafeRedirects({
      startUrl: normalizedUrl,
      method: "POST",
    });
    if (postAttempt.ok) {
      return {
        ok: true,
        detail: `Unsubscribe URL succeeded (${postAttempt.status}).`,
        method: "url_post",
        status: postAttempt.status,
        final_url: postAttempt.finalUrl,
      };
    }

    const getAttempt = await fetchWithSafeRedirects({
      startUrl: normalizedUrl,
      method: "GET",
    });
    if (getAttempt.ok) {
      return {
        ok: true,
        detail: `Unsubscribe URL succeeded (${getAttempt.status}).`,
        method: "url_get",
        status: getAttempt.status,
        final_url: getAttempt.finalUrl,
      };
    }

    if (mailto) {
      return {
        ok: true,
        detail: "Unsubscribe URL failed. Mailto unsubscribe prepared for manual send.",
        method: "mailto_prepared",
        mailto,
        url_error: getAttempt.error || postAttempt.error,
      };
    }

    return {
      ok: false,
      error: getAttempt.error || postAttempt.error || "unsubscribe_url_failed",
    };
  }

  if (mailto) {
    return {
      ok: true,
      detail: "Mailto unsubscribe prepared for manual send.",
      method: "mailto_prepared",
      mailto,
    };
  }

  return { ok: false, error: "missing_unsubscribe_target" };
}

function resolveClaudeBin() {
  const override = normalizeCliString(
    process.env.GROOVY_CLAUDE_BIN || process.env.CLAUDE_BIN || process.env.CLAUDE_CODE_BIN || ""
  );
  const candidates = [
    override || null,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "claude", "claude.exe")
      : null,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "claude", "claude.cmd")
      : null,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), "bin", "claude"),
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      fs.accessSync(bin, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return String(bin);
    } catch {
      // try next candidate
    }
  }
  return "claude";
}

function buildClaudeStartCommand() {
  const bin = resolveClaudeBin();
  if (bin === "claude") return "claude --allowedTools All";
  const escaped = bin.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}" --allowedTools All`;
}

const CLAUDE_SLASH_DISCOVERY_COMPAT_PROMPT = "__GROOVY_DISCOVER_SLASH_COMMANDS__";
const CLAUDE_SLASH_DISCOVERY_RESULT_PREFIX = "__GROOVY_SLASH_COMMANDS__:";

function getConfigPath() {
  const home = os.homedir();
  return path.join(home, ".groovy", "connector.json");
}

function getLegacyConfigPath() {
  const home = os.homedir();
  return path.join(home, ".flow", "connector.json");
}

const HEARTBEAT_DEDUPE_WINDOW_MS_DEFAULT = 4 * 60 * 60 * 1000;
const HEARTBEAT_DEDUPE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function getHeartbeatDedupePath() {
  const home = os.homedir();
  return path.join(home, ".groovy", "heartbeat-whatsapp-dedupe.json");
}

function normalizeHeartbeatMessageText(value) {
  return String(value || "")
    .replace(/\u200B/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hashHeartbeatMessage(normalizedText) {
  return createHash("sha256").update(String(normalizedText || "")).digest("hex");
}

function coerceHeartbeatDedupeState(raw) {
  const root = raw && typeof raw === "object" ? raw : {};
  const jobsRaw = root.jobs && typeof root.jobs === "object" ? root.jobs : {};
  const jobs = {};
  for (const [jobId, item] of Object.entries(jobsRaw)) {
    if (!jobId) continue;
    if (!item || typeof item !== "object") continue;
    jobs[jobId] = {
      lastHash: typeof item.lastHash === "string" ? item.lastHash : "",
      lastSentAtMs: Number(item.lastSentAtMs || 0),
      lastChatId: typeof item.lastChatId === "string" ? item.lastChatId : "",
      lastTraceId: typeof item.lastTraceId === "string" ? item.lastTraceId : "",
      lastToolCallId: typeof item.lastToolCallId === "string" ? item.lastToolCallId : "",
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
    };
  }
  return { version: 1, jobs };
}

async function readHeartbeatDedupeState() {
  const p = getHeartbeatDedupePath();
  try {
    const raw = await fsp.readFile(p, "utf8");
    return coerceHeartbeatDedupeState(JSON.parse(raw || "{}"));
  } catch {
    return { version: 1, jobs: {} };
  }
}

async function writeHeartbeatDedupeState(state) {
  const p = getHeartbeatDedupePath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(state, null, 2), "utf8");
}

async function checkHeartbeatMessageDedupe({ jobId, text, windowMs }) {
  const normalized = normalizeHeartbeatMessageText(text);
  const hash = hashHeartbeatMessage(normalized);
  if (!jobId || !normalized) {
    return { deduped: false, hash, ageMs: null, lastChatId: "" };
  }

  const nowMs = Date.now();
  const window = Math.max(0, Number(windowMs) || 0);
  const state = await readHeartbeatDedupeState();
  const jobs = state.jobs && typeof state.jobs === "object" ? state.jobs : {};

  let pruned = false;
  for (const [id, item] of Object.entries(jobs)) {
    const ts = Number(item?.lastSentAtMs || 0);
    if (!Number.isFinite(ts) || ts <= 0 || nowMs - ts > HEARTBEAT_DEDUPE_RETENTION_MS) {
      delete jobs[id];
      pruned = true;
    }
  }
  if (pruned) {
    await writeHeartbeatDedupeState({ version: 1, jobs });
  }

  const prev = jobs[jobId] && typeof jobs[jobId] === "object" ? jobs[jobId] : null;
  const prevHash = typeof prev?.lastHash === "string" ? prev.lastHash : "";
  const prevSentAtMs = Number(prev?.lastSentAtMs || 0);
  const sameHash = !!prevHash && prevHash === hash;
  const ageMs =
    sameHash && Number.isFinite(prevSentAtMs) && prevSentAtMs > 0
      ? Math.max(0, nowMs - prevSentAtMs)
      : null;
  const deduped = !!(sameHash && ageMs !== null && ageMs <= window);

  return {
    deduped,
    hash,
    ageMs,
    lastChatId: typeof prev?.lastChatId === "string" ? prev.lastChatId : "",
  };
}

async function markHeartbeatMessageSent({ jobId, hash, chatId, traceId, toolCallId, sentAtMs }) {
  if (!jobId || !hash) return;
  const state = await readHeartbeatDedupeState();
  const jobs = state.jobs && typeof state.jobs === "object" ? state.jobs : {};
  const atMs = Number.isFinite(Number(sentAtMs)) ? Number(sentAtMs) : Date.now();
  jobs[jobId] = {
    lastHash: String(hash),
    lastSentAtMs: atMs,
    lastChatId: typeof chatId === "string" ? chatId : "",
    lastTraceId: typeof traceId === "string" ? traceId : "",
    lastToolCallId: typeof toolCallId === "string" ? toolCallId : "",
    updatedAt: new Date(atMs).toISOString(),
  };
  await writeHeartbeatDedupeState({ version: 1, jobs });
}

async function readConfig() {
  // Try new path first, then legacy
  for (const p of [getConfigPath(), getLegacyConfigPath()]) {
    try {
      const raw = await fsp.readFile(p, "utf8");
      return JSON.parse(raw);
    } catch {
      // continue
    }
  }
  return {};
}

async function writeConfig(next) {
  const p = getConfigPath();
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
  await fsp.writeFile(p, JSON.stringify(next, null, 2), "utf8");
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // ignore
  }
}

async function pickFolder() {
  const result = await pickFolderPrompt({
    title: "Groovy Connector",
    prompt: "Select a folder to share with Groovy",
  });
  if (!result?.ok) return { ok: false, error: result?.error || "cancelled" };
  const p = String(result.path || "").trim();
  if (!p) return { ok: false, error: "no_folder_selected" };
  return { ok: true, path: p };
}

async function promptForPairingCode() {
  const result = await promptForPairingCodePrompt({
    title: "Groovy Connector",
    prompt: "Enter your Groovy pairing code",
  });
  if (!result?.ok) {
    warn("pairing prompt failed", result?.error || "cancelled");
    return null;
  }
  const code = String(result.value || "").trim();
  return code || null;
}

function log(...args) {
  console.log("[connector]", ...args);
}

function warn(...args) {
  console.warn("[connector]", ...args);
}

let hostedDeviceRegistered = false;

async function registerHostedMacDeviceIfNeeded() {
  if (hostedDeviceRegistered) return;
  const requestId = (process.env.GROOVY_HOSTED_MAC_REQUEST_ID || "").trim();
  if (!requestId) return;
  if (!activeAppUrl) return;
  if (!activeDeviceToken) return;

  try {
    const url = `${String(activeAppUrl).replace(/\/$/, "")}/api/hosted-macs/register-device`;
    log("hosted mac: registering device", { requestId, url });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-token": String(activeDeviceToken),
      },
      body: JSON.stringify({ request_id: requestId }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      let json = null;
      try {
        json = txt ? JSON.parse(txt) : null;
      } catch {
        json = null;
      }
      warn("hosted mac: failed to register device", {
        requestId,
        status: res.status,
        statusText: res.statusText,
        error: (json && typeof json === "object" && "error" in json) ? json.error : txt.slice(0, 200),
      });
      return;
    }
    hostedDeviceRegistered = true;
    const out = await res.json().catch(() => ({}));
    log("hosted mac: registered device for request", {
      requestId,
      deviceId: out?.device_id || null,
    });
  } catch (e) {
    warn("hosted mac: register request failed", e instanceof Error ? e.message : String(e));
  }
}

async function updateHostedConnectorInPlace() {
  const requestId = (process.env.GROOVY_HOSTED_MAC_REQUEST_ID || "").trim();
  if (!requestId) {
    throw new Error("not_hosted_mac");
  }
  const DEFAULT_HOSTED_TARBALL_URL =
    "https://github.com/Charlesmendez/groovy-releases/releases/latest/download/Groovy-Connector-Headless.tar.gz";
  const tarballUrl =
    (process.env.GROOVY_HOSTED_TARBALL_URL || "").trim() || DEFAULT_HOSTED_TARBALL_URL;

  const installDir =
    (process.env.GROOVY_HOSTED_INSTALL_DIR || "").trim() ||
    path.join(os.homedir(), ".groovy", "connector-headless");

  await fsp.mkdir(installDir, { recursive: true });

  const tgzPath = path.join(installDir, "connector.update.tgz");
  const started = Date.now();
  let stage = "init";
  log("hosted mac: updating connector in-place", {
    requestId,
    tarballUrl,
    installDir,
  });

  // Download tarball
  try {
    stage = "download";
    await execFileAsync("/usr/bin/curl", ["-fsSL", tarballUrl, "-o", tgzPath], {
      cwd: installDir,
      env: process.env,
      timeout: 10 * 60 * 1000,
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    warn("hosted mac: update download failed", { stage, requestId, errMsg });
    throw e;
  }

  // Extract over current files
  try {
    stage = "extract";
    await execFileAsync("/usr/bin/tar", ["-xzf", tgzPath], {
      cwd: installDir,
      env: process.env,
      timeout: 10 * 60 * 1000,
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    warn("hosted mac: update extract failed", { stage, requestId, errMsg });
    throw e;
  }

  // Cleanup
  try {
    await fsp.unlink(tgzPath);
  } catch {
    // ignore
  }

  log("hosted mac: update extracted", { requestId, durationMs: Date.now() - started });
}

const CONNECTOR_RELEASES_LATEST_API =
  "https://api.github.com/repos/Charlesmendez/groovy-releases/releases/latest";
const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_UPDATE_INITIAL_DELAY_MS = 45 * 1000;
const AUTO_UPDATE_INITIAL_JITTER_MS = 30 * 1000;
const AUTO_UPDATE_BUSY_RETRY_MS = 5 * 60 * 1000;
const AUTO_UPDATE_FAILURE_RETRY_MS = 30 * 60 * 1000;
const AUTO_UPDATE_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const AUTO_UPDATE_RELEASE_FETCH_TIMEOUT_MS = 30 * 1000;

function getConnectorVersion() {
  try {
    const pkgPath = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return String(pkg?.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function parseSemverTriplet(rawVersion) {
  const v = String(rawVersion || "")
    .trim()
    .replace(/^v/i, "")
    .split("-", 1)[0];
  const parts = v.split(".");
  return [0, 1, 2].map((idx) => {
    const n = Number(parts[idx] || "0");
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
}

function compareSemver(a, b) {
  const aa = parseSemverTriplet(a);
  const bb = parseSemverTriplet(b);
  for (let i = 0; i < 3; i += 1) {
    if ((aa[i] || 0) > (bb[i] || 0)) return 1;
    if ((aa[i] || 0) < (bb[i] || 0)) return -1;
  }
  return 0;
}

function isAutoUpdateDisabledByConfig() {
  if (hasFlag("--no-auto-update")) {
    return { disabled: true, source: "--no-auto-update" };
  }
  if (process.env.GROOVY_CONNECTOR_NO_AUTO_UPDATE === "1") {
    return { disabled: true, source: "GROOVY_CONNECTOR_NO_AUTO_UPDATE=1" };
  }
  if (process.env.GROOVY_NO_AUTO_UPDATE === "1") {
    return { disabled: true, source: "GROOVY_NO_AUTO_UPDATE=1" };
  }
  return { disabled: false, source: "" };
}

function isAppleSiliconHardware() {
  if (process.platform !== "darwin") return false;
  if (process.arch === "arm64") return true;
  try {
    const value = String(
      execFileSync("/usr/sbin/sysctl", ["-in", "hw.optional.arm64"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }) || ""
    ).trim();
    return value === "1";
  } catch {
    return false;
  }
}

function getLocalAutoUpdateContext() {
  if ((process.env.GROOVY_HOSTED_MAC_REQUEST_ID || "").trim()) {
    return { ok: false, reason: "hosted_runtime" };
  }

  const scriptPath = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptPath);
  const scriptPathLower = scriptPath.toLowerCase();

  if (process.platform === "darwin") {
    if (!isAppleSiliconHardware()) {
      return { ok: false, reason: "unsupported_arch" };
    }
    const marker = `${path.sep}Contents${path.sep}Resources${path.sep}connector.mjs`;
    const markerIdx = scriptPath.lastIndexOf(marker);
    if (markerIdx === -1) {
      return { ok: false, reason: "not_app_bundle" };
    }
    const appPath = scriptPath.slice(0, markerIdx);
    const launcherPath = path.join(appPath, "Contents", "MacOS", "launcher");
    if (!fs.existsSync(launcherPath)) {
      return { ok: false, reason: "missing_launcher" };
    }
    return {
      ok: true,
      platform: "darwin",
      scriptPath,
      appPath,
      launcherPath,
    };
  }

  if (process.platform === "win32") {
    if (scriptPathLower.endsWith("\\apps\\connector\\connector.mjs")) {
      return { ok: false, reason: "dev_repo_runtime" };
    }
    const launcherPath = path.join(scriptDir, "Groovy Connector.cmd");
    if (!fs.existsSync(launcherPath)) {
      return { ok: false, reason: "missing_launcher" };
    }
    return {
      ok: true,
      platform: "win32",
      scriptPath,
      installDir: scriptDir,
      launcherPath,
    };
  }

  return { ok: false, reason: "unsupported_platform" };
}

function isConnectorBusyForUpdate() {
  return terminals.size > 0 || pendingBrowserTaskRuns.size > 0 || pendingClaudeRuns.size > 0 || inFlightJobs.size > 0;
}

function toPowerShellSingleQuoted(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

async function downloadUrlToFile(url, destinationPath, timeoutMs = AUTO_UPDATE_DOWNLOAD_TIMEOUT_MS) {
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(30_000, Number(timeoutMs) || AUTO_UPDATE_DOWNLOAD_TIMEOUT_MS));

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
      headers: {
        accept: "application/octet-stream",
        "user-agent": "groovy-connector-updater",
      },
    });
    if (!res.ok || !res.body) {
      throw new Error(`download_failed_status_${res.status}`);
    }

    await new Promise((resolve, reject) => {
      const bodyStream = Readable.fromWeb(res.body);
      const file = fs.createWriteStream(destinationPath);
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      bodyStream.on("error", done);
      file.on("error", done);
      file.on("finish", () => done());
      bodyStream.pipe(file);
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatestConnectorRelease(platform) {
  const expectedAssetName =
    platform === "darwin" ? "Groovy-Connector-macOS.zip" : "Groovy-Connector-windows.zip";

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AUTO_UPDATE_RELEASE_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(CONNECTOR_RELEASES_LATEST_API, {
      method: "GET",
      signal: ac.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "groovy-connector-updater",
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`release_fetch_failed_status_${res.status}`);
  }

  const json = await res.json().catch(() => null);
  if (!json || typeof json !== "object") {
    throw new Error("release_fetch_invalid_json");
  }

  const tagName = String(json.tag_name || "").trim();
  const version = String(tagName || json.name || "")
    .trim()
    .replace(/^v/i, "");
  if (!version) {
    throw new Error("release_missing_version");
  }

  const assets = Array.isArray(json.assets) ? json.assets : [];
  let asset = assets.find((item) => String(item?.name || "") === expectedAssetName);
  if (!asset) {
    const target = expectedAssetName.toLowerCase();
    asset = assets.find((item) => String(item?.name || "").toLowerCase() === target);
  }
  const assetUrl = String(asset?.browser_download_url || "").trim();
  if (!assetUrl) {
    throw new Error(`release_missing_asset_${expectedAssetName}`);
  }

  return {
    version,
    tagName: tagName || `v${version}`,
    assetName: expectedAssetName,
    assetUrl,
  };
}

async function applyLocalMacConnectorUpdate(context, release) {
  const updateRoot = path.join(
    os.tmpdir(),
    `groovy-connector-update-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const zipPath = path.join(updateRoot, release.assetName);
  const extractDir = path.join(updateRoot, "extract");
  const helperPath = path.join(updateRoot, "apply-update.sh");

  await fsp.mkdir(extractDir, { recursive: true });
  await downloadUrlToFile(release.assetUrl, zipPath, AUTO_UPDATE_DOWNLOAD_TIMEOUT_MS);
  await execFileAsync("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir], {
    timeout: AUTO_UPDATE_DOWNLOAD_TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
  });

  const extractedAppPath = path.join(extractDir, path.basename(context.appPath));
  if (!fs.existsSync(extractedAppPath)) {
    throw new Error("mac_update_missing_extracted_app_bundle");
  }

  const helperScript = `#!/bin/bash
set -euo pipefail
OLD_PID="$1"
SRC_APP="$2"
DST_APP="$3"
LAUNCHER="$4"
TMP_DIR="$5"
LAUNCH_AGENT_PATH="$6"
LAUNCH_AGENT_LABEL="$7"

if [ -n "$LAUNCH_AGENT_PATH" ] && [ -f "$LAUNCH_AGENT_PATH" ]; then
  launchctl unload "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true
fi

for _ in $(seq 1 400); do
  if ! kill -0 "$OLD_PID" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! /usr/bin/ditto "$SRC_APP" "$DST_APP"; then
  if [ -x "$LAUNCHER" ]; then
    "$LAUNCHER" >/dev/null 2>&1 &
  fi
  rm -rf "$TMP_DIR" >/dev/null 2>&1 || true
  exit 1
fi

did_start=0
if [ -n "$LAUNCH_AGENT_PATH" ] && [ -f "$LAUNCH_AGENT_PATH" ]; then
  launchctl load "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true
  uid="$(id -u 2>/dev/null || true)"
  if [ -n "$uid" ]; then
    if launchctl kickstart -k "gui/$uid/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1; then
      did_start=1
    fi
  fi
fi

if [ "$did_start" -eq 0 ] && [ -x "$LAUNCHER" ]; then
  "$LAUNCHER" >/dev/null 2>&1 &
fi

rm -rf "$TMP_DIR" >/dev/null 2>&1 || true
exit 0
`;

  await fsp.writeFile(helperPath, helperScript, "utf8");
  fs.chmodSync(helperPath, 0o700);

  const child = spawn(
    "/bin/bash",
    [
      helperPath,
      String(process.pid),
      extractedAppPath,
      context.appPath,
      context.launcherPath,
      updateRoot,
      LAUNCH_AGENT_PATH,
      LAUNCH_AGENT_LABEL,
    ],
    {
      detached: true,
      stdio: "ignore",
      cwd: "/",
    }
  );
  child.unref();
  return { ok: true };
}

async function applyLocalWindowsConnectorUpdate(context, release) {
  const updateRoot = path.join(
    os.tmpdir(),
    `groovy-connector-update-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const zipPath = path.join(updateRoot, release.assetName);
  const helperPath = path.join(updateRoot, "apply-update.ps1");

  await fsp.mkdir(updateRoot, { recursive: true });
  await downloadUrlToFile(release.assetUrl, zipPath, AUTO_UPDATE_DOWNLOAD_TIMEOUT_MS);

  const helperScript = `
$ErrorActionPreference = 'Stop'
$oldPid = ${Number(process.pid) || 0}
$zipPath = ${toPowerShellSingleQuoted(zipPath)}
$stagingDir = ${toPowerShellSingleQuoted(updateRoot)}
$installDir = ${toPowerShellSingleQuoted(context.installDir)}
$launcherPath = ${toPowerShellSingleQuoted(context.launcherPath)}
$launched = $false

try {
  for ($i = 0; $i -lt 400; $i++) {
    try {
      Get-Process -Id $oldPid -ErrorAction Stop | Out-Null
      Start-Sleep -Milliseconds 200
    } catch {
      break
    }
  }

  $payloadDir = Join-Path $stagingDir 'payload'
  if (Test-Path $payloadDir) {
    Remove-Item -Path $payloadDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Path $payloadDir -Force | Out-Null
  Expand-Archive -Path $zipPath -DestinationPath $payloadDir -Force

  if (!(Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  }

  $robocopy = Join-Path $env:SystemRoot 'System32\\robocopy.exe'
  & $robocopy $payloadDir $installDir /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  $rc = $LASTEXITCODE
  if ($rc -ge 8) {
    throw "robocopy_failed_$rc"
  }

  Start-Process -FilePath $launcherPath -WorkingDirectory $installDir -WindowStyle Hidden
  $launched = $true
} catch {
  if (Test-Path $launcherPath) {
    Start-Process -FilePath $launcherPath -WorkingDirectory $installDir -WindowStyle Hidden
    $launched = $true
  }
} finally {
  Start-Sleep -Milliseconds 500
  Remove-Item -Path $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not $launched) {
  exit 1
}
`;

  await fsp.writeFile(helperPath, helperScript.trim(), "utf8");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: process.cwd(),
    }
  );
  child.unref();
  return { ok: true };
}

async function applyLocalConnectorUpdate(context, release) {
  if (!context?.ok) {
    return { ok: false, error: "invalid_local_update_context" };
  }
  if (context.platform === "darwin") {
    return applyLocalMacConnectorUpdate(context, release);
  }
  if (context.platform === "win32") {
    return applyLocalWindowsConnectorUpdate(context, release);
  }
  return { ok: false, error: "unsupported_platform" };
}

async function maybeApplyLocalConnectorUpdate({ force = false } = {}) {
  const disabled = isAutoUpdateDisabledByConfig();
  if (disabled.disabled) {
    return { ok: false, updated: false, reason: "disabled", error: disabled.source };
  }

  const context = getLocalAutoUpdateContext();
  if (!context.ok) {
    return { ok: false, updated: false, reason: context.reason || "unsupported_runtime" };
  }

  const currentVersion = getConnectorVersion();
  const latest = await fetchLatestConnectorRelease(context.platform);
  const cmp = compareSemver(latest.version, currentVersion);
  if (cmp <= 0) {
    return {
      ok: true,
      updated: false,
      reason: "up_to_date",
      currentVersion,
      latestVersion: latest.version,
    };
  }

  if (!force && isConnectorBusyForUpdate()) {
    return {
      ok: false,
      updated: false,
      reason: "connector_busy",
      currentVersion,
      latestVersion: latest.version,
    };
  }

  const applied = await applyLocalConnectorUpdate(context, latest);
  if (!applied?.ok) {
    return {
      ok: false,
      updated: false,
      reason: "apply_failed",
      error: String(applied?.error || "unknown_error"),
      currentVersion,
      latestVersion: latest.version,
    };
  }

  return {
    ok: true,
    updated: true,
    currentVersion,
    latestVersion: latest.version,
    latestTag: latest.tagName,
  };
}

function fatal(...args) {
  console.error("[connector]", ...args);
  process.exit(1);
}

const terminals = new Map();
const terminalMeta = new Map(); // terminalId -> { persist: boolean }
const webrtcPeers = new Map(); // webrtcId -> { terminalId, pc, dc }
const webrtcChannelsByTerminal = new Map(); // terminalId -> Set<dc>
const pendingBrowserTaskRuns = new Map(); // requestId -> AbortController
const pendingClaudeRuns = new Map(); // requestId -> { abortController, agentId, sessionId, provider, startedAtMs }
let browserTaskRunQueue = Promise.resolve(); // serialize browser_task_run executions
const recentBrowserTaskSuccessBySignature = new Map(); // signature -> { tsMs, duplicateHits, result }
const BROWSER_TASK_SUCCESS_CACHE_TTL_MS = 5 * 60 * 1000;
const browserTaskClaudeSessionByProfile = new Map(); // sessionKey -> { sessionId, tsMs }
const BROWSER_TASK_CLAUDE_SESSION_TTL_MS = 20 * 60 * 1000;
let activeRelayWs = null; // current relay websocket (changes on reconnect)
let whatsappBridge = null; // { sendText, ... } from startWhatsAppBridge (optional)
let whatsappBridgeOpts = null; // startup options for restarting the bridge on frame detach

function getPendingClaudeRunAbortController(entry) {
  if (!entry) return null;
  if (entry instanceof AbortController) return entry;
  if (entry.abortController instanceof AbortController) return entry.abortController;
  return null;
}

function abortPendingClaudeRun(entry) {
  const controller = getPendingClaudeRunAbortController(entry);
  if (!controller) return false;
  controller.abort();
  return true;
}
let activeDeviceToken = null; // device token for API calls (set during auth)
let activeAppUrl = null; // app URL for scheduler API calls (set during main init)
const WHATSAPP_RECENT_RESOLVE_GUARD_WINDOW_MS = 60_000;
const WHATSAPP_RECENT_RESOLVE_MAX_EVENTS = 30;
const recentWhatsAppResolveEventsByScope = new Map(); // scopeKey -> [{ atMs, exactChatId, query, source }]
const WHATSAPP_HEALTH_FAILURE_WINDOW_MS = 3 * 60 * 1000;
const WHATSAPP_HEALTH_AUTO_RESTART_THRESHOLD = 3;
const WHATSAPP_HEALTH_AUTO_RESTART_COOLDOWN_MS = 5 * 60 * 1000;
// Scheduler-scoped failures (e.g. scheduler_whatsapp_send_*) are intentionally
// excluded from the general auto-restart counter so a single flapping schedule
// doesn't bounce the whole connector. But if the *same* restartable error keeps
// surfacing from scheduler paths with no successful recovery in between, the
// bridge is wedged (e.g. ready_fallback_dom declared ready while Store is still
// not injected). Track consecutive same-class scheduler failures separately and
// escalate to a full process restart after this many.
const WHATSAPP_SCHEDULER_WEDGED_RESTART_THRESHOLD = 5;
// whatsapp.mjs can legitimately take up to 90s to mark the client ready via DOM fallback
// on cold boots or after browser/session recovery. Give it extra headroom before we
// classify startup as failed and trigger restart/retry logic.
const WHATSAPP_BRIDGE_READY_TIMEOUT_MS = 2 * 60 * 1000;
let requestConnectorProcessRestart = null;
let whatsappFailureTimesMs = [];
let whatsappAutoRestartCount = 0;
let lastWhatsappAutoRestartAtMs = 0;
let whatsappSchedulerWedgedCount = 0;
let lastWhatsappSchedulerWedgedReason = "";
let lastWhatsappSchedulerWedgedAtMs = 0;
// Reset the wedged counter if no matching failure has occurred for this long.
// Keeps the 5-in-a-row rule from accumulating across unrelated, far-apart events.
const WHATSAPP_SCHEDULER_WEDGED_WINDOW_MS = 10 * 60 * 1000;
let lastConnectorHealthDigest = "";
let aiyraVoiceRuntime = null;
let whatsappHealthState = {
  status: "unknown",
  reason: null,
  detail: null,
  updated_at: null,
  last_healthy_at: null,
  last_failure_at: null,
  consecutive_failures: 0,
  recent_failures: 0,
  auto_restart_pending: false,
  auto_restart_count: 0,
};
let aiyraVoiceHealthState = {
  status: "unknown",
  reason: null,
  detail: null,
  updated_at: null,
  last_healthy_at: null,
  last_failure_at: null,
  listening: false,
  active: false,
  muted: false,
  wake_word: null,
  wake_sensitivity: null,
  openwakeword_threshold: null,
  idle_timeout_ms: null,
  wake_hits: 0,
  wake_suppressed: 0,
  missed_reports: 0,
  false_trigger_reports: 0,
  session_count: 0,
  session_error_count: 0,
  reconnect_attempt_count: 0,
  last_session_duration_ms: null,
  aec_enabled: null,
  aec_backend_requested: null,
  aec_backend: null,
  aec_status: null,
  aec_last_error: null,
  aec_render_underrun_count: 0,
  last_metric_at: null,
  last_metric_event: null,
  configured_mic_name: null,
  resolved_device_name: null,
  mic_selection_fallback_reason: null,
  mic_input_level: 0,
  mic_input_updated_at: null,
};
let schedulerWhatsAppRuntimeConfig = {
  enabled: false,
  groupName: "",
  appUrl: "",
};

function resolveWhatsAppRuntimeConfig(cfg = {}) {
  const whatsappFlag = hasFlag("--whatsapp") || hasFlag("--whatsapp-web");
  return {
    enabled:
      cfg?.whatsapp_enabled === true ||
      (whatsappFlag && cfg?.whatsapp_enabled !== false),
    groupName:
      normalizeCliString(argValue("--whatsapp-group")) ||
      normalizeCliString(process.env.WHATSAPP_GROUP_NAME) ||
      normalizeCliString(process.env.GROOVY_WHATSAPP_GROUP) ||
      normalizeCliString(cfg?.whatsapp_group_name) ||
      "",
    appUrl:
      normalizeCliString(argValue("--app-url")) ||
      normalizeCliString(process.env.GROOVY_APP_URL) ||
      normalizeCliString(process.env.FLOW_APP_URL) ||
      normalizeCliString(process.env.NEXT_PUBLIC_APP_URL) ||
      normalizeCliString(cfg?.whatsapp_app_url) ||
      "",
  };
}

function applySchedulerWhatsAppRuntimeConfig(nextConfig = {}) {
  schedulerWhatsAppRuntimeConfig = {
    enabled: nextConfig?.enabled === true,
    groupName:
      typeof nextConfig?.groupName === "string" ? nextConfig.groupName : "",
    appUrl: typeof nextConfig?.appUrl === "string" ? nextConfig.appUrl : "",
  };
}

function normalizeChatId(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

function normalizeResolveScope(scopeKey) {
  const raw = typeof scopeKey === "string" ? scopeKey.trim() : "";
  return raw || "__global__";
}

function extractResolveExactChatId(result) {
  if (!result || typeof result !== "object") return "";
  const exact = result.exact && typeof result.exact === "object" ? result.exact : null;
  if (exact && typeof exact.chatId === "string" && exact.chatId.trim()) {
    return exact.chatId.trim();
  }
  return "";
}

function pruneRecentWhatsAppResolves(scopeKey, nowMs = Date.now()) {
  const scope = normalizeResolveScope(scopeKey);
  const rows = recentWhatsAppResolveEventsByScope.get(scope);
  if (!rows || rows.length === 0) return [];
  const cutoff = nowMs - WHATSAPP_RECENT_RESOLVE_GUARD_WINDOW_MS;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const atMs = Number(rows[i]?.atMs || 0);
    if (!Number.isFinite(atMs) || atMs < cutoff) {
      rows.splice(i, 1);
    }
  }
  if (rows.length > WHATSAPP_RECENT_RESOLVE_MAX_EVENTS) {
    rows.splice(0, rows.length - WHATSAPP_RECENT_RESOLVE_MAX_EVENTS);
  }
  if (rows.length === 0) {
    recentWhatsAppResolveEventsByScope.delete(scope);
    return [];
  }
  return rows;
}

function rememberWhatsAppResolve(result, { query, source, scopeKey }) {
  const exactChatId = extractResolveExactChatId(result);
  if (!exactChatId) return;
  const scope = normalizeResolveScope(scopeKey);
  const atMs = Date.now();
  const rows = pruneRecentWhatsAppResolves(scope, atMs);
  rows.push({
    atMs,
    exactChatId,
    query: String(query || "").slice(0, 120),
    source: String(source || "").slice(0, 80),
  });
  recentWhatsAppResolveEventsByScope.set(scope, rows);
}

function getSingleRecentResolvedChatId({
  windowMs = WHATSAPP_RECENT_RESOLVE_GUARD_WINDOW_MS,
  scopeKey,
}) {
  const scope = normalizeResolveScope(scopeKey);
  const nowMs = Date.now();
  const rows = pruneRecentWhatsAppResolves(scope, nowMs);
  if (!rows.length) return "";
  const cutoff = nowMs - Math.max(1000, Number(windowMs) || WHATSAPP_RECENT_RESOLVE_GUARD_WINDOW_MS);
  const unique = new Set();
  for (const row of rows) {
    const atMs = Number(row?.atMs || 0);
    const chatId = normalizeChatId(row?.exactChatId);
    if (!chatId || !Number.isFinite(atMs) || atMs < cutoff) continue;
    unique.add(chatId);
  }
  if (unique.size !== 1) return "";
  return Array.from(unique)[0] || "";
}

async function pickWhatsAppSendChatId({
  requestedChatId,
  recipientQuery,
  source,
  scopeKey,
  preferRecentResolve = true,
  requireRecipientQueryForRecentResolve = true,
}) {
  let chatId = normalizeChatId(requestedChatId);
  const query = String(recipientQuery || "").trim();
  let correctionReason = "";
  let correctedFrom = "";

  // Strongest guard: re-resolve by recipient query when available (dashboard confirm sends include this).
  if (query && whatsappBridge && typeof whatsappBridge.resolveRecipient === "function") {
    try {
      const resolved = await whatsappBridge.resolveRecipient({ query, limit: 10 });
      rememberWhatsAppResolve(resolved, {
        query,
        source: `${source}:query_guard`,
        scopeKey,
      });
      const exactChatId = extractResolveExactChatId(resolved);
      if (exactChatId && exactChatId !== chatId) {
        correctedFrom = chatId;
        chatId = exactChatId;
        correctionReason = "recipient_query_exact";
      } else if (exactChatId && !chatId) {
        chatId = exactChatId;
        correctionReason = "recipient_query_exact_missing_chat_id";
      }
    } catch (e) {
      warn("whatsapp_send guard: recipient_query resolve failed", {
        source,
        query: query.slice(0, 120),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Secondary guard: if the connector just resolved exactly one chat recently, enforce it.
  const allowRecentFallback =
    preferRecentResolve && (!requireRecipientQueryForRecentResolve || !!query);
  if (!correctionReason && allowRecentFallback) {
    const recentExact = getSingleRecentResolvedChatId({ scopeKey });
    if (recentExact && recentExact !== chatId) {
      correctedFrom = chatId;
      chatId = recentExact;
      correctionReason = "recent_single_exact_resolve";
    } else if (recentExact && !chatId) {
      chatId = recentExact;
      correctionReason = "recent_single_exact_missing_chat_id";
    }
  }

  if (correctionReason) {
    warn("whatsapp_send target corrected", {
      source,
      requestedChatId: normalizeChatId(requestedChatId) || undefined,
      resolvedChatId: chatId || undefined,
      recipientQuery: query || undefined,
      scopeKey: normalizeResolveScope(scopeKey),
      reason: correctionReason,
    });
  }

  return {
    chatId,
    correctionReason: correctionReason || undefined,
    correctedFrom: correctedFrom || undefined,
  };
}

function normalizeBrowserTaskText(v) {
  return String(v || "").trim().replace(/\s+/g, " ").slice(0, 4000);
}

function buildBrowserTaskSignature({ task, startUrl, profileName }) {
  const normalizedTask = normalizeBrowserTaskText(task);
  const normalizedStartUrl = String(startUrl || "").trim();
  const normalizedProfile = String(profileName || "default").trim() || "default";
  return JSON.stringify({
    task: normalizedTask,
    startUrl: normalizedStartUrl,
    profileName: normalizedProfile,
  });
}

function pruneBrowserTaskSuccessCache(nowMs = Date.now()) {
  for (const [signature, cached] of recentBrowserTaskSuccessBySignature.entries()) {
    const tsMs = Number(cached?.tsMs || 0);
    if (!Number.isFinite(tsMs) || nowMs - tsMs > BROWSER_TASK_SUCCESS_CACHE_TTL_MS) {
      recentBrowserTaskSuccessBySignature.delete(signature);
    }
  }
}

function parseHostFromUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    return String(u.host || "").toLowerCase();
  } catch {
    return "";
  }
}

function buildBrowserTaskSessionKey({ profileName, startUrl }) {
  const profile = String(profileName || "default").trim() || "default";
  const host = parseHostFromUrl(startUrl || "");
  return `${profile}::${host || "*"}`;
}

function pruneBrowserTaskClaudeSessions(nowMs = Date.now()) {
  for (const [key, cached] of browserTaskClaudeSessionByProfile.entries()) {
    const tsMs = Number(cached?.tsMs || 0);
    const sessionId = String(cached?.sessionId || "").trim();
    if (!sessionId || !Number.isFinite(tsMs) || nowMs - tsMs > BROWSER_TASK_CLAUDE_SESSION_TTL_MS) {
      browserTaskClaudeSessionByProfile.delete(key);
    }
  }
}

// Keep a small rolling buffer per terminal so WhatsApp can reply with recent output.
const terminalLocalBuffers = new Map(); // terminalId -> string
const TERMINAL_LOCAL_BUFFER_MAX = 25_000;

function appendTerminalLocalBuffer(terminalId, chunk) {
  if (!terminalId || !chunk) return;
  const prev = terminalLocalBuffers.get(terminalId) || "";
  const next = (prev + String(chunk)).slice(-TERMINAL_LOCAL_BUFFER_MAX);
  terminalLocalBuffers.set(terminalId, next);
}

function getTerminalLocalBufferLen(terminalId) {
  return (terminalLocalBuffers.get(terminalId) || "").length;
}

function getTerminalLocalBufferTail(terminalId, maxLen = 3500) {
  const buf = (terminalLocalBuffers.get(terminalId) || "").trimEnd();
  if (!buf) return "";
  return buf.length > maxLen ? buf.slice(-maxLen) : buf;
}

function getTerminalLocalBufferDelta(terminalId, fromLen, maxLen = 3500) {
  const buf = terminalLocalBuffers.get(terminalId) || "";
  const start = Math.max(0, Number(fromLen) || 0);
  const delta = buf.slice(start).trim();
  if (!delta) return "";
  return delta.length > maxLen ? delta.slice(-maxLen) : delta;
}

async function ensureTerminalForWhatsApp(opts = {}) {
  const terminalId = String(opts.terminalId || "");
  const cwd = String(opts.cwd || "").trim() || os.homedir();
  const persist = opts.persist !== false; // default true
  const startClaude = opts.startClaude !== false; // default true
  if (!terminalId) return { ok: false, error: "missing_terminal_id" };
  if (terminals.has(terminalId)) return { ok: true, existed: true };

  const requestedCwd = cwd.trim();
  const safeCwd = isDirectory(requestedCwd) ? requestedCwd : os.homedir();

  const shells = uniqueStrings(getPtyShellCandidates()).filter((s) => isExecutable(s));

  let p = null;
  let lastErr = null;
  for (const shell of shells) {
    try {
      ensureNodePtySpawnHelperExecutable();
      p = pty.spawn(shell, getPtyShellArgs(shell), {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        cwd: safeCwd,
        env: buildSanitizedEnv(safeCwd),
      });
      break;
    } catch (err) {
      lastErr = err;
      warn("whatsapp ensureTerminal: pty.spawn failed; trying next shell", {
        shell,
        cwd: safeCwd,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!p) {
    const error = lastErr instanceof Error ? lastErr.message : String(lastErr || "spawn_failed");
    return { ok: false, error };
  }

  terminals.set(terminalId, p);
  terminalMeta.set(terminalId, { persist });
  terminalLocalBuffers.set(terminalId, "");

  p.onData((data) => {
    appendTerminalLocalBuffer(terminalId, data);

    const chans = webrtcChannelsByTerminal.get(terminalId);
    if (chans && chans.size > 0) {
      for (const dc of Array.from(chans)) {
        if (!dc || dc.readyState !== "open") {
          chans.delete(dc);
          continue;
        }
        try {
          dc.send(data);
        } catch {
          chans.delete(dc);
        }
      }
      if (chans.size === 0) webrtcChannelsByTerminal.delete(terminalId);
    }

    const outWs = activeRelayWs;
    if (outWs && outWs.readyState === WebSocket.OPEN) {
      outWs.send(JSON.stringify({ type: "terminal_data", terminal_id: terminalId, data }));
    }
  });

  p.onExit(() => {
    terminals.delete(terminalId);
    terminalMeta.delete(terminalId);
    terminalLocalBuffers.delete(terminalId);

    const chans = webrtcChannelsByTerminal.get(terminalId);
    if (chans) {
      for (const dc of chans) {
        try {
          dc.close();
        } catch {
          // ignore
        }
      }
      webrtcChannelsByTerminal.delete(terminalId);
    }
    for (const [wid, sess] of webrtcPeers.entries()) {
      if (sess.terminalId === terminalId) {
        try {
          sess.dc?.close();
        } catch {}
        try {
          sess.pc?.close();
        } catch {}
        webrtcPeers.delete(wid);
      }
    }

    const outWs = activeRelayWs;
    if (outWs && outWs.readyState === WebSocket.OPEN) {
      outWs.send(JSON.stringify({ type: "terminal_closed", terminal_id: terminalId }));
    }
  });

  if (startClaude) {
    // Use --allowedTools "All" to auto-accept tool permissions and skip interactive prompts
    p.write(`${buildClaudeStartCommand()}\r`);
  }

  return { ok: true, existed: false, cwd: safeCwd };
}

function sendTerminalInputForWhatsApp(opts = {}) {
  const terminalId = String(opts.terminalId || "");
  const data = String(opts.data || "");
  const p = terminals.get(terminalId);
  if (!p) return { ok: false, error: "terminal_not_found" };
  try {
    p.write(data);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler (local cron-like jobs)
// ─────────────────────────────────────────────────────────────────────────────

const scheduledJobs = new Map(); // jobId -> job row from server
const inFlightJobs = new Set(); // jobId
const scheduleRetryState = new Map(); // jobId -> { attempt, nextAttemptAtMs, lastError, waitForWhatsAppHealthy? }
let scheduleSyncInterval = null;
let scheduleSyncWatchdogInterval = null;
let scheduleTickInterval = null;
let scheduleSyncPending = false;
let scheduleSyncPendingStartedAtMs = 0;
let lastScheduleSyncAtMs = 0;
let pendingScheduleTickForWhatsAppHealthy = false;

const SCHEDULE_RETRY_BASE_MS = 30_000;
const SCHEDULE_RETRY_MAX_MS = 15 * 60 * 1000;
const SCHEDULE_RETRY_MAX_ATTEMPTS = 8;

// Global connector operation queue:
// - high priority: interactive orchestrator/chat tool RPCs (relay -> connector)
// - low priority: scheduled-job connector executes
// High-priority waiters are dequeued first. Up to MAX_CONCURRENT_CONNECTOR_OPS
// operations run in parallel; excess waiters queue until a slot frees up.
const MAX_CONCURRENT_CONNECTOR_OPS = 5;
const connectorOpWaitersHigh = [];
const connectorOpWaitersLow = [];
let connectorOpSlotsInUse = 0;
let connectorOpSeq = 0;

function maybeGrantNextConnectorOpSlot() {
  while (connectorOpSlotsInUse < MAX_CONCURRENT_CONNECTOR_OPS) {
    const next =
      connectorOpWaitersHigh.length > 0
        ? connectorOpWaitersHigh.shift()
        : connectorOpWaitersLow.shift();
    if (!next) break;

    connectorOpSlotsInUse++;
    const waitedMs = Math.max(0, Date.now() - Number(next.enqueuedAtMs || Date.now()));
    if (waitedMs > 2000) {
      log("connector priority queue: dequeued", {
        id: next.id,
        priority: next.priority,
        label: next.label,
        waitedMs,
        slotsInUse: connectorOpSlotsInUse,
        highPending: connectorOpWaitersHigh.length,
        lowPending: connectorOpWaitersLow.length,
      });
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      connectorOpSlotsInUse--;
      setImmediate(() => {
        maybeGrantNextConnectorOpSlot();
      });
    };

    next.resolve(release);
  }
}

function acquireConnectorOpSlot(priority, label) {
  const normalizedPriority = priority === "high" ? "high" : "low";
  const safeLabel = typeof label === "string" ? label : "";
  return new Promise((resolve) => {
    const waiter = {
      id: ++connectorOpSeq,
      priority: normalizedPriority,
      label: safeLabel,
      enqueuedAtMs: Date.now(),
      resolve,
    };
    if (normalizedPriority === "high") connectorOpWaitersHigh.push(waiter);
    else connectorOpWaitersLow.push(waiter);
    maybeGrantNextConnectorOpSlot();
  });
}

async function runConnectorOpWithPriority(priority, label, fn) {
  const release = await acquireConnectorOpSlot(priority, label);
  try {
    return await fn();
  } finally {
    try {
      release();
    } catch {
      // ignore
    }
  }
}

// Dedicated WhatsApp bridge queue:
// - serializes direct bridge access so WhatsApp searches/sends do not overlap
// - stays separate from the global connector slot so interactive WhatsApp work
//   does not wait behind unrelated Claude/browser/file operations
const whatsappBridgeOpWaiters = [];
let whatsappBridgeOpSlotInUse = false;
let whatsappBridgeOpSeq = 0;

function maybeGrantNextWhatsAppBridgeOpSlot() {
  if (whatsappBridgeOpSlotInUse) return;
  const next = whatsappBridgeOpWaiters.shift();
  if (!next) return;

  whatsappBridgeOpSlotInUse = true;
  const waitedMs = Math.max(0, Date.now() - Number(next.enqueuedAtMs || Date.now()));
  if (waitedMs > 1000) {
    log("whatsapp bridge queue: dequeued", {
      id: next.id,
      label: next.label,
      waitedMs,
      pending: whatsappBridgeOpWaiters.length,
    });
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    whatsappBridgeOpSlotInUse = false;
    setImmediate(() => {
      maybeGrantNextWhatsAppBridgeOpSlot();
    });
  };

  next.resolve(release);
}

function acquireWhatsAppBridgeOpSlot(label) {
  const safeLabel = typeof label === "string" ? label : "";
  return new Promise((resolve) => {
    whatsappBridgeOpWaiters.push({
      id: ++whatsappBridgeOpSeq,
      label: safeLabel,
      enqueuedAtMs: Date.now(),
      resolve,
    });
    maybeGrantNextWhatsAppBridgeOpSlot();
  });
}

async function runWhatsAppBridgeOp(label, fn) {
  const release = await acquireWhatsAppBridgeOpSlot(label);
  try {
    return await fn();
  } finally {
    try {
      release();
    } catch {
      // ignore
    }
  }
}

function shouldAcquireGlobalConnectorPrioritySlot(msgType) {
  const t = String(msgType || "");
  if (!t) return false;
  if (t === "schedule_trigger") return false;
  if (t.startsWith("whatsapp_")) return false;
  return (
    t === "terminal_exec" ||
    t === "claude_run" ||
    t.startsWith("browser_") ||
    t.startsWith("email_") ||
    t.startsWith("file_") ||
    t.startsWith("obsidian_") ||
    t.startsWith("computer_use_") ||
    t.startsWith("site_") ||
    t.startsWith("linkdb_") ||
    t.startsWith("sqlite_") ||
    t.startsWith("credential_")
  );
}

function parseIsoDate(d) {
  if (!d || typeof d !== "string") return null;
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

function computeScheduleRetryDelayMs(attempt) {
  const n = Math.max(1, Number(attempt) || 1);
  const ms = SCHEDULE_RETRY_BASE_MS * Math.pow(2, Math.min(n - 1, 5));
  return Math.min(ms, SCHEDULE_RETRY_MAX_MS);
}

function isRetryableScheduleError(v) {
  const t = String(v || "").toLowerCase();
  if (!t) return false;
  if (isNonRetryableScheduledWhatsAppUnavailableError(t)) return false;
  return (
    t.includes("fetch failed") ||
    t.includes("failed to fetch") ||
    t.includes("und_err") ||
    t.includes("headers timeout") ||
    t.includes("body timeout") ||
    t.includes("terminated") ||
    t.includes("abort") ||
    t.includes("whatsapp_not_running") ||
    t.includes("client_not_ready") ||
    t.includes("chat_not_ready") ||
    t.includes("detached frame") ||
    t.includes("execution context was destroyed") ||
    t.includes("target closed") ||
    t.includes("download_failed") ||
    t.includes("scheduled_whatsapp_send_missing_after_final") ||
    t.includes("scheduler_connector_rounds_exhausted") ||
    t.includes("timeout") ||
    t.includes("timed out") ||
    t.includes("econnreset") ||
    t.includes("socket hang up") ||
    t.includes("network")
  );
}

function isNonRetryableScheduledWhatsAppUnavailableError(v) {
  const t = String(v || "").toLowerCase();
  if (!t) return false;
  return t.includes("whatsapp_disabled") || t.includes("missing_whatsapp_config");
}

function shouldRetryScheduledJobWhenWhatsAppIsHealthy(v) {
  const raw = typeof v === "string" ? v : String(v || "");
  const t = raw.trim().toLowerCase();
  if (!t || isNonRetryableScheduledWhatsAppUnavailableError(t)) return false;
  return (
    t.includes("whatsapp_not_running") ||
    t.includes("whatsapp_qr_required") ||
    t.includes("whatsapp_auth_failure") ||
    t.includes("bridge_needs_restart") ||
    t.includes("client_not_ready") ||
    t.includes("chat_not_ready") ||
    t.includes("whatsapp_ready_timeout_after_start") ||
    t.includes("operational_ready_timeout") ||
    isDetachedWhatsAppErrorMessage(raw)
  );
}

function hasPendingScheduleRetryWaitingForWhatsAppHealthy() {
  for (const retryState of scheduleRetryState.values()) {
    if (retryState && typeof retryState === "object" && retryState.waitForWhatsAppHealthy === true) {
      return true;
    }
  }
  return false;
}

function requestScheduleTickForWhatsAppHealthy() {
  if (pendingScheduleTickForWhatsAppHealthy) return;
  if (!hasPendingScheduleRetryWaitingForWhatsAppHealthy()) return;
  pendingScheduleTickForWhatsAppHealthy = true;
  setImmediate(() => {
    pendingScheduleTickForWhatsAppHealthy = false;
    tickSchedules().catch(() => {});
  });
}

function normalizeScheduledWhatsAppTargetValue(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().replace(/^['"`]+|['"`]+$/g, "").trim();
}

function isLikelyScheduledWhatsAppRecipientQuery(raw) {
  const value = normalizeScheduledWhatsAppTargetValue(raw);
  if (!value || value.length < 2 || value.length > 96) return false;
  const lower = value.toLowerCase();
  if (
    lower === "whatsapp" ||
    lower === "whats app" ||
    lower === "group" ||
    lower === "chat" ||
    lower === "team" ||
    lower === "thread" ||
    lower === "channel" ||
    lower === "default group"
  ) {
    return false;
  }
  if (/^https?:\/\//i.test(value)) return false;
  return /[a-z]/i.test(value);
}

function parseScheduledWhatsAppRecipientQueryFromMessage(taskMessage) {
  const text = typeof taskMessage === "string" ? taskMessage : "";
  if (!text.trim()) return "";
  const patterns = [
    /(?:send|text|message|deliver|post|notify|share)[^.\n]{0,180}?\bto\b[^.\n]{0,20}?(?:"([^"\n]{2,96})"|'([^'\n]{2,96})'|`([^`\n]{2,96})`)\s+(?:on\s+)?(?:whatsapp|whats app|group|chat|team|thread|channel)\b/i,
    /(?:whatsapp|whats app)\s+(?:group|chat|team|thread|channel)\s+(?:named\s+)?(?:"([^"\n]{2,96})"|'([^'\n]{2,96})'|`([^`\n]{2,96})`)/i,
    /(?:send|text|message|deliver|post|notify|share)[^.\n]{0,180}?\bto\b\s+(?:the\s+)?([A-Z][A-Za-z0-9&().,'\/-]*(?:\s+[A-Za-z0-9&().,'\/-]+){0,6})\s+(?:on\s+)?(?:whatsapp|whats app|group|chat|team|thread|channel)\b/i,
    /(?:whatsapp|whats app)\s+(?:group|chat|team|thread|channel)\s+(?:named\s+)?([A-Z][A-Za-z0-9&().,'\/-]*(?:\s+[A-Za-z0-9&().,'\/-]+){0,6})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const candidate = normalizeScheduledWhatsAppTargetValue(
      match.slice(1).find((part) => typeof part === "string" && part.trim()) || ""
    );
    if (isLikelyScheduledWhatsAppRecipientQuery(candidate)) {
      return candidate;
    }
  }
  return "";
}

function extractScheduledWhatsAppFallbackTarget(taskObj) {
  if (!taskObj || typeof taskObj !== "object") {
    return { chatId: "", recipientQuery: "", source: "none" };
  }
  const task = taskObj;
  const delivery =
    task.delivery && typeof task.delivery === "object" && !Array.isArray(task.delivery)
      ? task.delivery
      : null;
  const options =
    task.options && typeof task.options === "object" && !Array.isArray(task.options)
      ? task.options
      : null;
  const firstString = (...values) => {
    for (const value of values) {
      const normalized = normalizeScheduledWhatsAppTargetValue(value);
      if (normalized) return normalized;
    }
    return "";
  };
  const chatId = firstString(
    delivery?.whatsapp_chat_id,
    delivery?.chat_id,
    delivery?.whatsapp_thread_key,
    delivery?.thread_key,
    options?.whatsapp_chat_id,
    options?.chat_id,
    options?.whatsapp_thread_key,
    options?.thread_key
  );
  const explicitRecipientQuery = firstString(
    delivery?.whatsapp_recipient_query,
    delivery?.recipient_query,
    delivery?.whatsapp_recipient,
    delivery?.recipient_display,
    delivery?.group_name,
    options?.whatsapp_recipient_query,
    options?.recipient_query,
    options?.whatsapp_recipient,
    options?.recipient_display,
    options?.group_name
  );
  const messageText = typeof task.message === "string" ? task.message : "";
  const parsedRecipientQuery =
    explicitRecipientQuery || parseScheduledWhatsAppRecipientQueryFromMessage(messageText);
  return {
    chatId,
    recipientQuery: parsedRecipientQuery,
    source: explicitRecipientQuery
      ? "task_options_or_delivery"
      : chatId
        ? "task_chat_id"
        : parsedRecipientQuery
          ? "task_message"
          : "none",
  };
}

function toLocalDateAtTime(baseDate, hour, minute) {
  const d = new Date(baseDate);
  d.setHours(Number(hour) || 0, Number(minute) || 0, 0, 0);
  return d;
}

function getDayOfWeekLocal(d) {
  try {
    return new Date(d).getDay(); // 0=Sun..6=Sat
  } catch {
    return null;
  }
}

function isDueNow(job, now = new Date()) {
  if (!job || job.enabled === false) return { due: false };
  const schedule = job.schedule;
  if (!schedule || typeof schedule !== "object") return { due: false };
  const t = schedule.type;
  const lastRun = parseIsoDate(job.last_run_at);

  if (t === "once") {
    const runAt = parseIsoDate(schedule.run_at);
    if (!runAt) return { due: false };
    if (now.getTime() < runAt.getTime()) return { due: false };
    if (lastRun && lastRun.getTime() >= runAt.getTime()) return { due: false };
    return { due: true, dueAt: runAt };
  }

  if (t === "daily") {
    const hour = Number(schedule.hour);
    const minute = Number(schedule.minute);
    const candidate = toLocalDateAtTime(now, hour, minute);
    if (now.getTime() < candidate.getTime()) return { due: false };
    if (lastRun && lastRun.getTime() >= candidate.getTime()) return { due: false };
    return { due: true, dueAt: candidate };
  }

  if (t === "weekly") {
    const weekday = Number(schedule.weekday);
    const hour = Number(schedule.hour);
    const minute = Number(schedule.minute);
    const today = getDayOfWeekLocal(now);
    if (today === null) return { due: false };
    const diff = (today - weekday + 7) % 7; // 0..6
    const candidateBase = new Date(now);
    candidateBase.setDate(candidateBase.getDate() - diff);
    const candidate = toLocalDateAtTime(candidateBase, hour, minute);
    if (now.getTime() < candidate.getTime()) return { due: false };
    if (lastRun && lastRun.getTime() >= candidate.getTime()) return { due: false };
    return { due: true, dueAt: candidate };
  }

  if (t === "interval_minutes") {
    const minutes = Number(schedule.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return { due: false };
    if (!lastRun) return { due: true, dueAt: now };
    const elapsed = now.getTime() - lastRun.getTime();
    if (elapsed >= minutes * 60_000) return { due: true, dueAt: new Date(lastRun.getTime() + minutes * 60_000) };
    return { due: false };
  }

  return { due: false };
}

function sendToRelay(msg) {
  const ws = activeRelayWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

function isDetachedWhatsAppErrorMessage(message) {
  const raw = typeof message === "string" ? message : String(message || "");
  const lower = raw.trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.includes("bridge_needs_restart") ||
    lower.includes("detached frame") ||
    lower.includes("execution context was destroyed") ||
    lower.includes("target closed") ||
    lower.includes("session closed") ||
    lower.includes("browser has disconnected") ||
    lower.includes("protocol error") ||
    (lower.includes("cannot read properties of undefined") &&
      (lower.includes("'getchat'") || lower.includes("'getchats'") ||
       lower.includes("'sendmessage'") || lower.includes("'findchat'") ||
       lower.includes("'getcontact'") || lower.includes("'modelclass'")))
  );
}

function isRetryableWhatsAppStartupErrorMessage(message) {
  const lower = String(message || "").trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.includes("target closed") ||
    lower.includes("protocol error") ||
    lower.includes("protocoltimeout") ||
    lower.includes("session closed") ||
    lower.includes("browser has disconnected") ||
    lower.includes("detached frame") ||
    lower.includes("execution context was destroyed") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("whatsapp_ready_timeout_after_start") ||
    lower.includes("operational_ready_timeout") ||
    (lower.includes("cannot read properties of undefined") &&
      (lower.includes("'getchat'") ||
        lower.includes("'getchats'") ||
        lower.includes("'sendmessage'") ||
        lower.includes("'findchat'") ||
        lower.includes("'getcontact'") ||
        lower.includes("'modelclass'")))
  );
}

function shouldRetryWhatsAppStartupWithoutPin(message) {
  const lower = String(message || "").trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.includes("runtime.callfunctionon timed out") ||
    lower.includes("protocoltimeout") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("webversioncache")
  );
}

function shouldHardResetWhatsAppSessionOnStartupRetry(message) {
  const lower = String(message || "").trim().toLowerCase();
  if (!lower) return false;
  // Do NOT hard-reset the WhatsApp session for generic startup flake / Store
  // races. That wipes LocalAuth, forces a QR re-link, and can create a logout
  // loop when the real problem is just whatsapp-web.js becoming usable slowly.
  // Reserve session wipes for explicit auth-invalid / logged-out states.
  return (
    lower.includes("logged out") ||
    lower.includes("logout") ||
    lower.includes("auth failure") ||
    lower.includes("auth_failure") ||
    lower.includes("unpaired")
  );
}

function isAutoRestartableWhatsAppFailure(reason, detail = "") {
  const combined = `${String(reason || "")}; ${String(detail || "")}`;
  return isDetachedWhatsAppErrorMessage(combined);
}

function shouldImmediateRestartWhatsAppDisconnect(reason, detail = "") {
  const lowerReason = String(reason || "").trim().toLowerCase();
  const lowerDetail = String(detail || "").trim().toLowerCase();
  if (lowerReason !== "disconnected") return false;
  if (
    lowerDetail.includes("logout") ||
    lowerDetail.includes("logged out") ||
    lowerDetail.includes("auth failure") ||
    lowerDetail.includes("auth_failure") ||
    lowerDetail.includes("qr") ||
    lowerDetail.includes("unpaired")
  ) {
    return false;
  }
  return true;
}

function pruneWhatsAppFailureTimes(nowMs = Date.now()) {
  const cutoff = nowMs - WHATSAPP_HEALTH_FAILURE_WINDOW_MS;
  whatsappFailureTimesMs = whatsappFailureTimesMs.filter((t) => Number.isFinite(t) && t >= cutoff);
  return whatsappFailureTimesMs;
}

function connectorHealthForDigest(health) {
  if (!health || typeof health !== "object") return {};
  const copy = JSON.parse(JSON.stringify(health));

  if (copy.whatsapp && typeof copy.whatsapp === "object") {
    delete copy.whatsapp.updated_at;
    delete copy.whatsapp.last_healthy_at;
    delete copy.whatsapp.last_failure_at;
  }
  if (copy.aiyra_voice && typeof copy.aiyra_voice === "object") {
    delete copy.aiyra_voice.updated_at;
    delete copy.aiyra_voice.last_healthy_at;
    delete copy.aiyra_voice.last_failure_at;
  }

  return copy;
}

function sendConnectorHealthUpdate(force = false) {
  const payload = {
    type: "connector_health",
    health: {
      whatsapp: { ...whatsappHealthState },
      aiyra_voice: { ...aiyraVoiceHealthState },
    },
  };
  const digest = JSON.stringify(connectorHealthForDigest(payload.health));
  if (!force && digest === lastConnectorHealthDigest) {
    return false;
  }
  const sent = sendToRelay(payload);
  if (sent) {
    lastConnectorHealthDigest = digest;
  }
  return sent;
}

function applyWhatsAppHealthPatch(patch, opts = {}) {
  const nowIso = new Date().toISOString();
  whatsappHealthState = {
    ...whatsappHealthState,
    ...patch,
    updated_at: nowIso,
  };
  sendConnectorHealthUpdate(opts.force === true);
}

function applyAiyraVoiceHealthPatch(patch, opts = {}) {
  const nowIso = new Date().toISOString();
  aiyraVoiceHealthState = {
    ...aiyraVoiceHealthState,
    ...patch,
    updated_at: nowIso,
  };
  sendConnectorHealthUpdate(opts.force === true);
}

function noteAiyraVoiceDisabled(
  reason = "aiyra_voice_disabled",
  detail = "Aiyra voice runtime disabled",
  extra = {}
) {
  applyAiyraVoiceHealthPatch(
    {
      status: "disabled",
      reason,
      detail,
      listening: false,
      active: false,
      muted: false,
      ...extra,
    },
    { force: true }
  );
}

function noteAiyraVoiceDegraded(reason, detail = "", extra = {}) {
  applyAiyraVoiceHealthPatch({
    status: "degraded",
    reason: reason || "aiyra_voice_degraded",
    detail: detail || null,
    last_failure_at: new Date().toISOString(),
    listening: false,
    muted: false,
    ...extra,
  });
}

function noteAiyraVoiceHealthy(reason, detail = "", extra = {}) {
  applyAiyraVoiceHealthPatch({
    status: "healthy",
    reason: reason || "aiyra_voice_healthy",
    detail: detail || null,
    last_healthy_at: new Date().toISOString(),
    ...extra,
  });
}

function noteAiyraVoiceRecovering(reason, detail = "", extra = {}) {
  applyAiyraVoiceHealthPatch({
    status: "recovering",
    reason: reason || "aiyra_voice_recovering",
    detail: detail || null,
    ...extra,
  });
}

function incrementAiyraVoiceCounter(field, delta = 1) {
  const prev = Number(aiyraVoiceHealthState?.[field] || 0);
  const next = Math.max(0, prev + Number(delta || 0));
  return Number.isFinite(next) ? next : prev;
}

function clampAiyraMicInputLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function computeAiyraMicInputLevel(metric) {
  const candidates = [
    metric?.sent_rms,
    metric?.denoised_rms,
    metric?.aec_output_rms,
    metric?.rms,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (candidates.length === 0) return null;
  const observedRms = candidates[0];
  const targetRms = Math.max(
    600,
    Number.isFinite(Number(metric?.effective_target_rms))
      ? Number(metric.effective_target_rms)
      : 1800
  );
  const ratio = Math.max(0, observedRms) / targetRms;
  return clampAiyraMicInputLevel(Math.sqrt(Math.min(ratio, 1.6) / 1.6));
}

function recordAiyraVoiceMetric(metric) {
  if (!metric || typeof metric !== "object") return;
  const event = typeof metric.event === "string" ? metric.event.trim() : "";
  if (!event) return;
  const textPreview =
    typeof metric.text_preview === "string" && metric.text_preview.trim()
      ? metric.text_preview.trim()
      : null;

  const patch = {
    last_metric_event: event,
    last_metric_at: new Date().toISOString(),
  };

  if (event === "wake_detected") {
    patch.wake_hits = incrementAiyraVoiceCounter("wake_hits", 1);
  } else if (event === "wake_cooldown_suppressed") {
    patch.wake_suppressed = incrementAiyraVoiceCounter("wake_suppressed", 1);
  } else if (event === "voice_session_started") {
    patch.session_count = incrementAiyraVoiceCounter("session_count", 1);
    patch.mic_input_level = 0;
    patch.mic_input_updated_at = null;
    if (typeof metric.aec_requested === "boolean") {
      patch.aec_enabled = metric.aec_requested;
    }
    if (typeof metric.aec_backend_requested === "string") {
      patch.aec_backend_requested = normalizeAiyraAecBackend(
        metric.aec_backend_requested,
        aiyraVoiceHealthState?.aec_backend_requested || "webrtc"
      );
    }
  } else if (
    event === "voice_user_speech_detected" ||
    event === "voice_user_speech_activity"
  ) {
    const micInputLevel = computeAiyraMicInputLevel(metric);
    if (micInputLevel !== null) {
      patch.mic_input_level = micInputLevel;
      patch.mic_input_updated_at = new Date().toISOString();
    }
  } else if (event === "voice_session_error") {
    patch.session_error_count = incrementAiyraVoiceCounter("session_error_count", 1);
    patch.mic_input_level = 0;
    patch.mic_input_updated_at = null;
  } else if (event === "bootstrap_failed") {
    patch.reconnect_attempt_count = incrementAiyraVoiceCounter("reconnect_attempt_count", 1);
  } else if (event === "voice_session_ended") {
    const durationMs = Number(metric.duration_ms);
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      patch.last_session_duration_ms = Math.trunc(durationMs);
    }
    patch.mic_input_level = 0;
    patch.mic_input_updated_at = null;
  } else if (event === "voice_aec_ready") {
    patch.aec_status = "ready";
    patch.aec_last_error = null;
    if (typeof metric.backend_requested === "string") {
      patch.aec_backend_requested = normalizeAiyraAecBackend(
        metric.backend_requested,
        aiyraVoiceHealthState?.aec_backend_requested || "webrtc"
      );
    }
    if (typeof metric.backend === "string") {
      patch.aec_backend = normalizeAiyraAecBackend(
        metric.backend,
        aiyraVoiceHealthState?.aec_backend || "webrtc"
      );
    }
  } else if (event === "voice_aec_unavailable") {
    patch.aec_status = "unavailable";
    patch.aec_last_error =
      typeof metric.reason === "string" && metric.reason ? metric.reason : null;
    if (typeof metric.backend_requested === "string") {
      patch.aec_backend_requested = normalizeAiyraAecBackend(
        metric.backend_requested,
        aiyraVoiceHealthState?.aec_backend_requested || "webrtc"
      );
    }
  } else if (event === "voice_aec_failed") {
    patch.aec_status = "failed";
    patch.aec_last_error =
      typeof metric.reason === "string" && metric.reason ? metric.reason : null;
    if (typeof metric.backend === "string") {
      patch.aec_backend = normalizeAiyraAecBackend(
        metric.backend,
        aiyraVoiceHealthState?.aec_backend || "webrtc"
      );
    }
  } else if (event === "voice_aec_render_underrun") {
    patch.aec_render_underrun_count = incrementAiyraVoiceCounter(
      "aec_render_underrun_count",
      1
    );
  } else if (event === "voice_thinking_pulse_started") {
    patch.detail = "Working on that now.";
  } else if (event === "voice_spoken_progress_started") {
    patch.detail = textPreview || "Working on that now.";
  } else if (event === "voice_deferred_followup_started") {
    patch.detail = textPreview || "Finishing that request.";
    patch.active = true;
    patch.listening = false;
  } else if (event === "voice_deferred_followup_finished") {
    patch.active = false;
  }

  applyAiyraVoiceHealthPatch(patch);
}

function noteWhatsAppHealthy(source, detail = "") {
  pruneWhatsAppFailureTimes();
  whatsappSchedulerWedgedCount = 0;
  lastWhatsappSchedulerWedgedReason = "";
  lastWhatsappSchedulerWedgedAtMs = 0;
  applyWhatsAppHealthPatch({
    status: "healthy",
    reason: source || "ok",
    detail: detail || null,
    last_healthy_at: new Date().toISOString(),
    consecutive_failures: 0,
    recent_failures: 0,
    auto_restart_pending: false,
    auto_restart_count: whatsappAutoRestartCount,
  });
  requestScheduleTickForWhatsAppHealthy();
}

function noteWhatsAppRecovering(source, detail = "") {
  applyWhatsAppHealthPatch({
    status: "recovering",
    reason: source || "recovering",
    detail: detail || null,
    auto_restart_pending: false,
    auto_restart_count: whatsappAutoRestartCount,
  });
}

function isSchedulerScopedWhatsAppHealthSource(source) {
  const lower = String(source || "").trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.startsWith("scheduler_whatsapp_send_") ||
    lower.startsWith("scheduler_whatsapp_bridge_")
  );
}

function noteWhatsAppDegraded(source, reason, detail = "") {
  const nowMs = Date.now();
  const sourceKey = typeof source === "string" && source.trim() ? source.trim() : "degraded";
  const schedulerScoped = isSchedulerScopedWhatsAppHealthSource(sourceKey);
  const countTowardsAutoRestart = !schedulerScoped;
  if (countTowardsAutoRestart) {
    whatsappFailureTimesMs.push(nowMs);
  }
  const failures = pruneWhatsAppFailureTimes(nowMs);
  const recentFailures = countTowardsAutoRestart ? failures.length : 0;
  const previousConsecutive = Number(whatsappHealthState.consecutive_failures || 0);
  const nextConsecutive = Math.max(1, previousConsecutive + 1);
  const errorReason = typeof reason === "string" && reason.trim() ? reason.trim() : "whatsapp_unhealthy";
  const restartableFailure = isAutoRestartableWhatsAppFailure(errorReason, detail);
  const canAutoRestart =
    countTowardsAutoRestart &&
    restartableFailure &&
    recentFailures >= WHATSAPP_HEALTH_AUTO_RESTART_THRESHOLD &&
    nowMs - lastWhatsappAutoRestartAtMs >= WHATSAPP_HEALTH_AUTO_RESTART_COOLDOWN_MS;
  const shouldImmediateRestart =
    countTowardsAutoRestart &&
    !canAutoRestart &&
    shouldImmediateRestartWhatsAppDisconnect(errorReason, detail) &&
    nowMs - lastWhatsappAutoRestartAtMs >= WHATSAPP_HEALTH_AUTO_RESTART_COOLDOWN_MS;

  // Scheduler-scoped escalation: the rolling failure window + auto-restart
  // counters intentionally ignore scheduler paths. But if scheduler keeps
  // hitting the same restartable error (e.g. bridge_needs_restart from a
  // wedged post-sleep recovery where Store never finishes injecting), nothing
  // else trips the restart and whatsappStatus stays "degraded" forever.
  // Track consecutive same-class scheduler failures and escalate.
  let schedulerWedgedRestart = false;
  if (schedulerScoped && restartableFailure) {
    const staleWedgeWindow =
      lastWhatsappSchedulerWedgedAtMs > 0 &&
      nowMs - lastWhatsappSchedulerWedgedAtMs > WHATSAPP_SCHEDULER_WEDGED_WINDOW_MS;
    if (staleWedgeWindow || lastWhatsappSchedulerWedgedReason !== errorReason) {
      whatsappSchedulerWedgedCount = 1;
      lastWhatsappSchedulerWedgedReason = errorReason;
    } else {
      whatsappSchedulerWedgedCount += 1;
    }
    lastWhatsappSchedulerWedgedAtMs = nowMs;
    schedulerWedgedRestart =
      whatsappSchedulerWedgedCount >= WHATSAPP_SCHEDULER_WEDGED_RESTART_THRESHOLD &&
      nowMs - lastWhatsappAutoRestartAtMs >= WHATSAPP_HEALTH_AUTO_RESTART_COOLDOWN_MS;
  } else if (!schedulerScoped) {
    whatsappSchedulerWedgedCount = 0;
    lastWhatsappSchedulerWedgedReason = "";
    lastWhatsappSchedulerWedgedAtMs = 0;
  }

  if (canAutoRestart || shouldImmediateRestart || schedulerWedgedRestart) {
    lastWhatsappAutoRestartAtMs = nowMs;
    whatsappAutoRestartCount += 1;
    if (schedulerWedgedRestart) {
      whatsappSchedulerWedgedCount = 0;
      lastWhatsappSchedulerWedgedReason = "";
      lastWhatsappSchedulerWedgedAtMs = 0;
    }
  }
  applyWhatsAppHealthPatch({
    status: "degraded",
    reason: sourceKey,
    detail: detail || errorReason,
    last_failure_at: new Date(nowMs).toISOString(),
    consecutive_failures: nextConsecutive,
    recent_failures: recentFailures,
    auto_restart_pending: canAutoRestart || shouldImmediateRestart || schedulerWedgedRestart,
    auto_restart_count: whatsappAutoRestartCount,
  });

  if (
    (canAutoRestart || shouldImmediateRestart || schedulerWedgedRestart) &&
    typeof requestConnectorProcessRestart === "function"
  ) {
    const restartReason = schedulerWedgedRestart
      ? `whatsapp_scheduler_wedged:${errorReason}`
      : shouldImmediateRestart
        ? `whatsapp_disconnected:${detail || errorReason}`
        : `whatsapp_unhealthy:${errorReason}`;
    if (schedulerWedgedRestart) {
      warn("whatsapp scheduler wedged — requesting connector restart", {
        source: sourceKey,
        reason: errorReason,
        consecutiveSchedulerFailures: WHATSAPP_SCHEDULER_WEDGED_RESTART_THRESHOLD,
      });
    }
    Promise.resolve(requestConnectorProcessRestart(restartReason)).catch((err) => {
      warn(
        "auto-restart request failed",
        err instanceof Error ? err.message : String(err)
      );
      applyWhatsAppHealthPatch({ auto_restart_pending: false });
    });
  }
}

async function waitForWhatsAppBridgeReadyOrThrow(bridge, timeoutMs = WHATSAPP_BRIDGE_READY_TIMEOUT_MS) {
  if (!bridge || typeof bridge.waitUntilReady !== "function") {
    throw new Error("whatsapp_bridge_missing_waitUntilReady");
  }

  let timeoutId = null;
  try {
    const readyPromise = Promise.resolve(bridge.waitUntilReady())
      .then(() => ({ kind: "ready" }))
      .catch((error) => ({ kind: "error", error }));
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({
          kind: "timeout",
          error: new Error(
            `whatsapp_ready_timeout_after_start:${Math.max(0, Math.trunc(timeoutMs || 0))}ms`
          ),
        });
      }, timeoutMs);
    });
    const outcome = await Promise.race([readyPromise, timeoutPromise]);
    if (outcome && typeof outcome === "object" && outcome.kind === "error") {
      throw outcome.error;
    }
    if (outcome && typeof outcome === "object" && outcome.kind === "timeout") {
      throw outcome.error;
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function observeWhatsAppSendResult(result, source) {
  if (!result || typeof result !== "object") return;
  if (result.ok === true) {
    noteWhatsAppHealthy(source || "whatsapp_send_ok");
    return;
  }
  const errorText = typeof result.error === "string" ? result.error : "";
  const primaryError = typeof result.primary_error === "string" ? result.primary_error : "";
  const detail = typeof result.detail === "string" ? result.detail : "";
  const combined = [errorText, primaryError, detail].filter(Boolean).join("; ");
  if (!isDetachedWhatsAppErrorMessage(combined)) return;
  noteWhatsAppDegraded(
    source || "whatsapp_send_failed",
    errorText || primaryError || "bridge_needs_restart",
    combined
  );
}

function requestScheduleSync() {
  const sent = sendToRelay({ type: "schedule_sync_request" });
  if (sent) {
    scheduleSyncPending = true;
    scheduleSyncPendingStartedAtMs = Date.now();
  }
  return sent;
}

function startSchedulerLoops() {
  if (scheduleSyncInterval) clearInterval(scheduleSyncInterval);
  if (scheduleSyncWatchdogInterval) clearInterval(scheduleSyncWatchdogInterval);
  if (scheduleTickInterval) clearInterval(scheduleTickInterval);

  scheduleSyncInterval = setInterval(() => {
    requestScheduleSync();
  }, 60_000);

  // Watchdog: if we don't receive a schedule_sync response, retry faster than 60s.
  // This helps "came online briefly, missed the sync, went offline again" cases.
  scheduleSyncWatchdogInterval = setInterval(() => {
    if (!activeRelayWs || activeRelayWs.readyState !== WebSocket.OPEN) return;
    const now = Date.now();

    // If we recently requested sync but haven't received it, retry.
    if (scheduleSyncPending && now - scheduleSyncPendingStartedAtMs > 10_000) {
      warn("schedule_sync pending too long; retrying schedule_sync_request");
      requestScheduleSync();
      return;
    }

    // If we have no jobs yet (fresh boot/reconnect), try to sync sooner.
    if (scheduledJobs.size === 0 && now - lastScheduleSyncAtMs > 15_000) {
      requestScheduleSync();
    }
  }, 10_000);

  scheduleTickInterval = setInterval(() => {
    tickSchedules().catch(() => {});
  }, 15_000);
}

function stopSchedulerLoops() {
  if (scheduleSyncInterval) clearInterval(scheduleSyncInterval);
  if (scheduleSyncWatchdogInterval) clearInterval(scheduleSyncWatchdogInterval);
  if (scheduleTickInterval) clearInterval(scheduleTickInterval);
  scheduleSyncInterval = null;
  scheduleSyncWatchdogInterval = null;
  scheduleTickInterval = null;
}

function skillsManagerRoot() {
  return path.join(os.homedir(), ".groovy", "skills-manager");
}

function sanitizeSkillsId(value, fallback = "item") {
  const safe = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return safe || fallback;
}

function safeRelativePath(value) {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("unsafe_relative_path");
  }
  return normalized;
}

function safeJoinUnder(root, relPath) {
  const safeRel = safeRelativePath(relPath);
  const full = path.resolve(root, safeRel);
  const resolvedRoot = path.resolve(root);
  if (full !== resolvedRoot && !full.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("path_outside_repo");
  }
  return full;
}

function allowedSkillsRepoUrl(repoUrl) {
  const url = String(repoUrl || "").trim();
  return (
    /^git@[\w.-]+:[\w./-]+(?:\.git)?$/i.test(url) ||
    /^ssh:\/\/[\w.@:-]+\/[\w./-]+(?:\.git)?$/i.test(url) ||
    /^https:\/\/[\w.-]+\/[\w./-]+(?:\.git)?(?:[?#].*)?$/i.test(url)
  );
}

function skillsRepoLocalPath({ workspaceId, repositoryId, repoUrl }) {
  const key = createHash("sha256")
    .update(`${workspaceId || "workspace"}:${repositoryId || ""}:${repoUrl || ""}`)
    .digest("hex")
    .slice(0, 24);
  return path.join(skillsManagerRoot(), "repos", key);
}

function sha256Text(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function scanRiskFlagsFromText(text) {
  const lower = String(text || "").toLowerCase();
  const flags = new Set();
  if (/\b(curl|wget)\b/.test(lower) || /https?:\/\//.test(lower)) flags.add("network_access_hint");
  if (/\b(api[_-]?key|secret|token|password|process\.env)\b/.test(lower)) flags.add("secret_reference_hint");
  if (/rm\s+-rf|git\s+reset\s+--hard|\bsudo\b/.test(lower)) flags.add("destructive_shell_hint");
  if (/bypass\s+(tests|security|review)|ignore\s+(tests|errors|security)/.test(lower)) flags.add("policy_bypass_hint");
  return Array.from(flags);
}

async function checksumFiles(files, root) {
  const parts = [];
  for (const file of [...files].sort()) {
    try {
      const buf = await fsp.readFile(file);
      parts.push(`${path.relative(root, file).replace(/\\/g, "/")}:${sha256Buffer(buf)}`);
    } catch {
      parts.push(`${path.relative(root, file).replace(/\\/g, "/")}:unreadable`);
    }
  }
  return sha256Text(parts.join("\n"));
}

async function runGit(args, opts = {}) {
  const cwd = opts.cwd || os.homedir();
  const timeout = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 60_000;
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: buildSanitizedEnv(cwd),
    });
    return {
      ok: true,
      stdout: String(stdout || ""),
      stderr: String(stderr || ""),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error || "git_failed"),
      stdout: error && typeof error === "object" && "stdout" in error ? String(error.stdout || "") : "",
      stderr: error && typeof error === "object" && "stderr" in error ? String(error.stderr || "") : "",
      code: error && typeof error === "object" && "code" in error ? String(error.code || "") : "",
    };
  }
}

function gitPreview(text, max = 500) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function logSkillsRepo(event, payload = {}) {
  log(`skills repo: ${event}`, {
    pid: process.pid,
    connectorPath: fileURLToPath(import.meta.url),
    ...payload,
  });
}

function normalizeSkillsBranchName(ref) {
  const candidate = String(ref || "main")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "");
  if (
    !candidate ||
    candidate.startsWith("-") ||
    candidate.includes("..") ||
    /[~^:?*[\\\s]/.test(candidate) ||
    candidate.endsWith("/") ||
    candidate.endsWith(".")
  ) {
    return "main";
  }
  return candidate;
}

async function ensureSkillsRepoLocal(args) {
  const repoUrl = String(args.repo_url || args.repoUrl || "").trim();
  const workspaceId = String(args.workspace_id || args.workspaceId || "workspace").trim();
  const repositoryId = String(args.repository_id || args.repositoryId || "").trim();
  const ref = normalizeSkillsBranchName(args.ref || args.branch || "main");
  if (!repoUrl || !allowedSkillsRepoUrl(repoUrl)) {
    return { ok: false, error: "invalid_repo_url" };
  }
  const localPath = skillsRepoLocalPath({ workspaceId, repositoryId, repoUrl });
  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  logSkillsRepo("ensure start", {
    repoUrl,
    workspaceId,
    repositoryId,
    ref,
    localPath,
    hasGitDir: fs.existsSync(path.join(localPath, ".git")),
  });

  if (!fs.existsSync(path.join(localPath, ".git"))) {
    const cloned = await runGit(["clone", repoUrl, localPath], {
      cwd: path.dirname(localPath),
      timeoutMs: 3 * 60 * 1000,
    });
    logSkillsRepo("clone complete", {
      ok: cloned.ok,
      localPath,
      stderr: gitPreview(cloned.stderr || cloned.error),
    });
    if (!cloned.ok) {
      return { ...cloned, ok: false, localPath, error: cloned.error || "git_clone_failed" };
    }
  }

  const fetched = await runGit(["fetch", "--all", "--prune"], {
    cwd: localPath,
    timeoutMs: 2 * 60 * 1000,
  });
  logSkillsRepo("fetch complete", {
    ok: fetched.ok,
    ref,
    localPath,
    stderr: gitPreview(fetched.stderr || fetched.error),
  });
  if (!fetched.ok) {
    return { ...fetched, ok: false, localPath, error: fetched.error || "git_fetch_failed" };
  }

  const head = await runGit(["rev-parse", "--verify", "HEAD"], { cwd: localPath, timeoutMs: 30_000 });
  logSkillsRepo("head check", {
    ok: head.ok,
    ref,
    localPath,
    head: gitPreview(head.stdout),
    stderr: gitPreview(head.stderr || head.error),
  });
  if (!head.ok) {
    const unborn = await runGit(["checkout", "-B", ref], { cwd: localPath, timeoutMs: 60_000 });
    logSkillsRepo("empty repo branch init", {
      ok: unborn.ok,
      ref,
      localPath,
      stderr: gitPreview(unborn.stderr || unborn.error),
    });
    if (!unborn.ok) {
      return { ...unborn, ok: false, localPath, ref, error: unborn.error || "git_create_branch_failed" };
    }
    return { ok: true, localPath, commitSha: "", ref, empty: true };
  }

  let checkedOut = await runGit(["checkout", ref], { cwd: localPath, timeoutMs: 60_000 });
  if (!checkedOut.ok) {
    logSkillsRepo("checkout local failed; trying remote branch", {
      ref,
      localPath,
      stderr: gitPreview(checkedOut.stderr || checkedOut.error),
    });
    checkedOut = await runGit(["checkout", "-B", ref, `origin/${ref}`], {
      cwd: localPath,
      timeoutMs: 60_000,
    });
  }
  logSkillsRepo("checkout complete", {
    ok: checkedOut.ok,
    ref,
    localPath,
    stderr: gitPreview(checkedOut.stderr || checkedOut.error),
  });
  if (!checkedOut.ok) {
    return { ...checkedOut, ok: false, localPath, error: checkedOut.error || "git_checkout_failed" };
  }

  // Best-effort fast-forward for branch refs. Detached commits/tags may not have an upstream.
  await runGit(["pull", "--ff-only"], { cwd: localPath, timeoutMs: 2 * 60 * 1000 });

  const rev = await runGit(["rev-parse", "HEAD"], { cwd: localPath, timeoutMs: 30_000 });
  const commitSha = rev.ok ? String(rev.stdout || "").trim() : "";
  return { ok: true, localPath, commitSha, ref };
}

function parseMarkdownFrontmatter(text) {
  const raw = String(text || "");
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: raw };
  const block = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  const data = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    } else {
      data[key] = value;
    }
  }
  return { data, body };
}

function normalizeSkillTargets(value, fallback = ["all"]) {
  const arr = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const targets = arr
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => ["all", "flow", "claude", "codex"].includes(item));
  return Array.from(new Set(targets.length ? targets : fallback));
}

function inferInstructionTargets(relativePath, filename) {
  const rel = String(relativePath || "").toLowerCase();
  const file = String(filename || "").toLowerCase();
  if (rel.includes("/claude/") || file === "claude.md") return ["claude"];
  if (rel.includes("/codex/") || file === "codex.md") return ["codex"];
  if (rel.includes("/flow/")) return ["flow"];
  if (file === "agents.md") return ["codex"];
  return ["all"];
}

async function listFilesRecursive(root, options = {}) {
  const maxFiles = Number.isFinite(Number(options.maxFiles)) ? Number(options.maxFiles) : 500;
  const out = [];
  async function walk(dir) {
    if (out.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

async function scanSkillsRepo(localPath, commitSha) {
  const files = await listFilesRecursive(localPath, { maxFiles: 1000 });
  const artifacts = [];
  for (const full of files) {
    const rel = path.relative(localPath, full).replace(/\\/g, "/");
    const filename = path.basename(full);
    if (!/\.md$/i.test(filename)) continue;
    const isSkill = filename === "SKILL.md" && rel.toLowerCase().startsWith("skills/");
    const isInstruction =
      rel.toLowerCase().startsWith("instructions/") ||
      ["AGENTS.md", "CLAUDE.md", "CODEX.md"].includes(filename);
    if (!isSkill && !isInstruction) continue;

    let content = "";
    try {
      content = await fsp.readFile(full, "utf8");
    } catch {
      continue;
    }
    const { data } = parseMarkdownFrontmatter(content);
    if (isSkill) {
      const dir = path.dirname(rel);
      const slug = sanitizeSkillsId(path.basename(dir), "skill");
      const skillDir = path.join(localPath, dir);
      const skillFiles = await listFilesRecursive(skillDir, { maxFiles: 300 });
      const hasScripts =
        fs.existsSync(path.join(skillDir, "scripts")) ||
        skillFiles.some((file) => /\.(sh|mjs|js|py|ts|tsx|rb|go|rs)$/i.test(file));
      const riskFlags = new Set(scanRiskFlagsFromText(content));
      if (hasScripts) riskFlags.add("has_scripts");
      for (const file of skillFiles) {
        if (!/\.(sh|mjs|js|py|ts|tsx|rb|go|rs)$/i.test(file)) continue;
        try {
          for (const flag of scanRiskFlagsFromText(await fsp.readFile(file, "utf8"))) {
            riskFlags.add(flag);
          }
        } catch {
          // ignore unreadable support files
        }
      }
      artifacts.push({
        artifactType: "skill",
        slug,
        name: String(data.name || slug),
        description: String(data.description || "Repo-backed Agent Skill").slice(0, 500),
        relativePath: rel,
        exactFilename: "SKILL.md",
        targets: normalizeSkillTargets(data.targets || data.target, ["all"]),
        checksum: await checksumFiles(skillFiles, skillDir),
        commitSha,
        metadata: {
          standard: "agent-skills",
          directory: dir,
          fileCount: skillFiles.length,
          storesBody: false,
        },
        riskFlags: Array.from(riskFlags),
      });
    } else {
      const slug = sanitizeSkillsId(rel.replace(/\.md$/i, ""), "instruction");
      artifacts.push({
        artifactType: "instruction_doc",
        slug,
        name: String(data.name || filename),
        description: String(data.description || "Markdown instruction document").slice(0, 500),
        relativePath: rel,
        exactFilename: filename,
        targets: normalizeSkillTargets(data.targets || data.target, inferInstructionTargets(rel, filename)),
        checksum: sha256Text(content),
        commitSha,
        metadata: {
          exactFilename: filename,
          preservesFilename: true,
          storesBody: false,
        },
        riskFlags: scanRiskFlagsFromText(content),
      });
    }
  }
  return artifacts;
}

async function copyRecursive(src, dest) {
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      await copyRecursive(path.join(src, entry.name), path.join(dest, entry.name));
    }
    return;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
}

async function skillsRepoCheck(params) {
  const repoUrl = String(params.repo_url || params.repoUrl || "").trim();
  if (!repoUrl || !allowedSkillsRepoUrl(repoUrl)) return { ok: false, error: "invalid_repo_url" };
  const result = await runGit(["ls-remote", repoUrl], { cwd: os.homedir(), timeoutMs: 60_000 });
  return {
    ok: result.ok,
    error: result.ok ? null : result.error || "git_ls_remote_failed",
    stderr: result.stderr,
    stdout_preview: result.stdout.slice(0, 1000),
    diagnostics: {
      command: `git ls-remote ${repoUrl}`,
    },
  };
}

async function skillsRepoSync(params) {
  const ensured = await ensureSkillsRepoLocal(params);
  if (!ensured.ok) {
    return {
      ...ensured,
      diagnostics: {
        command: "git clone/fetch/checkout",
        remediation: [
          `git ls-remote ${String(params.repo_url || params.repoUrl || "").trim()}`,
          "ssh -T git@github.com",
        ],
      },
    };
  }
  const artifacts = await scanSkillsRepo(ensured.localPath, ensured.commitSha);
  return {
    ok: true,
    localPath: ensured.localPath,
    commitSha: ensured.commitSha,
    ref: ensured.ref,
    artifacts,
    diagnostics: {
      artifactCount: artifacts.length,
    },
  };
}

async function skillsArtifactCreate(params) {
  const ensured = await ensureSkillsRepoLocal(params);
  if (!ensured.ok) return ensured;
  const artifactType = String(params.artifact_type || params.artifactType || "").trim();
  if (artifactType !== "skill" && artifactType !== "instruction_doc") {
    return { ok: false, error: "invalid_artifact_type" };
  }
  const relativePath = safeRelativePath(params.relative_path || params.relativePath || "");
  if (!relativePath.endsWith(".md")) return { ok: false, error: "artifact_must_be_markdown" };
  if (artifactType === "skill" && path.basename(relativePath) !== "SKILL.md") {
    return { ok: false, error: "skill_artifacts_must_use_SKILL_md" };
  }
  const fullPath = safeJoinUnder(ensured.localPath, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  if (fs.existsSync(fullPath)) {
    return { ok: false, error: "artifact_already_exists", relativePath };
  }
  await fsp.writeFile(fullPath, String(params.content || ""), "utf8");
  const status = await runGit(["status", "--short", "--", relativePath], {
    cwd: ensured.localPath,
    timeoutMs: 30_000,
  });
  const artifacts = await scanSkillsRepo(ensured.localPath, ensured.commitSha);
  return {
    ok: true,
    localPath: ensured.localPath,
    commitSha: ensured.commitSha,
    relativePath,
    exactFilename: path.basename(relativePath),
    gitStatus: status.stdout || "",
    artifacts: artifacts.filter((artifact) => artifact.relativePath === relativePath),
    nextSteps: [
      `cd ${ensured.localPath}`,
      `git add ${relativePath}`,
      'git commit -m "Add agent skill guidance"',
      `git push -u origin ${ensured.ref || "main"}`,
    ],
  };
}

async function skillsArtifactMaterialize(params) {
  const ensured = await ensureSkillsRepoLocal(params);
  if (!ensured.ok) return ensured;
  const target = sanitizeSkillsId(params.target || "flow", "flow");
  const workspaceId = sanitizeSkillsId(params.workspace_id || params.workspaceId || "workspace", "workspace");
  const agentId = sanitizeSkillsId(params.agent_id || params.agentId || "workspace", "workspace");
  const materialRoot = path.join(skillsManagerRoot(), "materialized", workspaceId, target, agentId);
  const artifacts = Array.isArray(params.artifacts) ? params.artifacts : [];
  const materialized = [];
  await fsp.mkdir(materialRoot, { recursive: true });
  for (const raw of artifacts) {
    const artifact = raw && typeof raw === "object" ? raw : {};
    const artifactType = String(artifact.artifact_type || artifact.artifactType || "").trim();
    const rel = safeRelativePath(artifact.relative_path || artifact.relativePath || "");
    const src = safeJoinUnder(ensured.localPath, rel);
    if (!fs.existsSync(src)) {
      materialized.push({ relativePath: rel, ok: false, error: "source_missing" });
      continue;
    }
    if (artifactType === "skill") {
      const skillDir = path.dirname(src);
      const slug = sanitizeSkillsId(artifact.slug || path.basename(skillDir), "skill");
      const dest = path.join(materialRoot, "skills", slug);
      await fsp.rm(dest, { recursive: true, force: true });
      await copyRecursive(skillDir, dest);
      materialized.push({ relativePath: rel, ok: true, path: dest, kind: "skill" });
      } else {
        const exactFilename = path.basename(src);
        const instructionRel = rel.replace(/^instructions\//i, "");
        const dest = path.join(materialRoot, "instructions", instructionRel);
        await copyRecursive(src, dest);
        materialized.push({ relativePath: rel, ok: true, path: dest, kind: "instruction_doc", exactFilename });
      }
    }
    const guideName = target === "claude" ? "CLAUDE.md" : target === "codex" ? "AGENTS.md" : "FLOW.md";
    const assignedLines = materialized
      .filter((row) => row && row.ok === true && typeof row.path === "string")
      .map((row) => `- ${row.kind === "skill" ? "Skill" : "Instruction"}: ${row.path}`);
    await fsp.writeFile(
      path.join(materialRoot, guideName),
      [
        `# Groovy ${target} Agent Context`,
        "",
        "This file was generated by Groovy Connector from your local skills repository checkout.",
        "Flow stores only metadata and assignments; the source bodies stay in Git and on this machine.",
        "",
        "Follow the assigned local capabilities below when relevant:",
        ...assignedLines,
        "",
      ].join("\n"),
      "utf8"
    );
    const readme = [
      "# Groovy Materialized Agent Context",
      "",
      `Target: ${target}`,
      `Source repo: ${String(params.repo_url || params.repoUrl || "").trim()}`,
      `Commit: ${ensured.commitSha}`,
      `Target guide: ${path.join(materialRoot, guideName)}`,
      "",
      "These files are generated from your local Git checkout. Flow does not store their contents.",
      "",
  ].join("\n");
  await fsp.writeFile(path.join(materialRoot, "README.md"), readme, "utf8");
  return {
    ok: true,
    localPath: ensured.localPath,
    materializedPath: materialRoot,
    commitSha: ensured.commitSha,
    artifacts: materialized,
    diagnostics: {
      artifactCount: materialized.length,
    },
  };
}

async function executeSkillsConnectorRpc(type, params) {
  if (type === "skills_repo_check") return await skillsRepoCheck(params);
  if (type === "skills_repo_sync" || type === "skills_catalog_scan") return await skillsRepoSync(params);
  if (type === "skills_artifact_create") return await skillsArtifactCreate(params);
  if (type === "skills_artifact_materialize") return await skillsArtifactMaterialize(params);
  return { ok: false, error: `unsupported_skills_rpc:${type}` };
}


async function runScheduledJob(job) {
  const jobId = String(job?.id || "");
  if (!jobId) return;
  if (inFlightJobs.has(jobId)) return;
  inFlightJobs.add(jobId);
  const whatsappResolveScopeKey = `scheduler:${jobId}`;

  const startedAt = new Date();
  const kind = typeof job.kind === "string" ? job.kind : "shell";
  log("scheduler: starting job", {
    jobId,
    name: String(job?.name || ""),
    kind,
    deviceId: String(job?.device_id || ""),
    schedule: job?.schedule || null,
    last_run_at: job?.last_run_at || null,
    enabled: job?.enabled !== false,
    skip_next_run: job?.skip_next_run === true,
  });
  const cwd = typeof job.cwd === "string" && job.cwd.trim() ? job.cwd.trim() : os.homedir();
  const env = buildSanitizedEnv(cwd);

  let status = "success";
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  let errorText = null;
  let retryableFailure = false;
  let retryReason = "";
  let nonRetryableFailure = false;
  let nonRetryableReason = "";
  let retryWhenWhatsAppHealthy = false;
  const priorRetryState =
    kind === "orchestrator" ? scheduleRetryState.get(jobId) || null : null;
  const priorSentWhatsAppMeta =
    priorRetryState &&
    typeof priorRetryState === "object" &&
    priorRetryState.sentWhatsAppMeta &&
    typeof priorRetryState.sentWhatsAppMeta === "object"
      ? {
          chatId:
            typeof priorRetryState.sentWhatsAppMeta.chatId === "string"
              ? priorRetryState.sentWhatsAppMeta.chatId
              : "",
          name:
            typeof priorRetryState.sentWhatsAppMeta.name === "string"
              ? priorRetryState.sentWhatsAppMeta.name
              : "",
        }
      : null;
  const connectorErrors = [];
  let didSendWhatsApp =
    !!priorSentWhatsAppMeta ||
    !!(
      priorRetryState &&
      typeof priorRetryState === "object" &&
      priorRetryState.didSendWhatsApp === true
    ); // Track if whatsapp_send_text was executed (to skip auto-post)
  let sentWhatsAppMeta = priorSentWhatsAppMeta; // { chatId, name } from whatsapp_send_text result
  let expectedWhatsAppSend =
    !!(
      priorRetryState &&
      typeof priorRetryState === "object" &&
      priorRetryState.expectedWhatsAppSend === true
    );
  let expectedWhatsAppChatId =
    priorRetryState &&
    typeof priorRetryState === "object" &&
    typeof priorRetryState.expectedWhatsAppChatId === "string"
      ? priorRetryState.expectedWhatsAppChatId
      : "";
  let expectedWhatsAppRecipientQuery =
    priorRetryState &&
    typeof priorRetryState === "object" &&
    typeof priorRetryState.expectedWhatsAppRecipientQuery === "string"
      ? priorRetryState.expectedWhatsAppRecipientQuery
      : "";
  const taskObj =
    job && typeof job.task === "object" && job.task ? job.task : null;
  const configuredScheduledWhatsAppTarget =
    kind === "orchestrator" ? extractScheduledWhatsAppFallbackTarget(taskObj) : null;
  const noteNonRetryableScheduledWhatsAppFailure = (value) => {
    if (!isNonRetryableScheduledWhatsAppUnavailableError(value)) return false;
    nonRetryableFailure = true;
    if (!nonRetryableReason) {
      nonRetryableReason = String(value || "");
    }
    return true;
  };
  const noteRetryWhenWhatsAppHealthy = (value) => {
    if (!shouldRetryScheduledJobWhenWhatsAppIsHealthy(value)) return false;
    retryWhenWhatsAppHealthy = true;
    retryableFailure = true;
    if (!retryReason) {
      retryReason = String(value || "");
    }
    return true;
  };
  const scheduledJobExplicitlyRequiresWhatsAppDelivery = (task) => {
    if (!task || typeof task !== "object") return false;
    const delivery =
      task.delivery && typeof task.delivery === "object" ? task.delivery : null;
    if (delivery && typeof delivery.whatsapp === "boolean") {
      return delivery.whatsapp;
    }
    const options =
      task.options && typeof task.options === "object" ? task.options : null;
    if (options && typeof options.requires_whatsapp_delivery === "boolean") {
      return options.requires_whatsapp_delivery;
    }
    const normalized = String(task.message || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return false;
    return (
      normalized.includes("whatsapp_send_text") ||
      normalized.includes("whatsapp_send_media") ||
      normalized.includes("whatsapp_send_default_group") ||
      normalized.includes("whatsapp_resolve_recipient")
    );
  };
  const scheduledJobRequiresWhatsAppDelivery = (task) => {
    if (!task || typeof task !== "object") return false;
    const delivery =
      task.delivery && typeof task.delivery === "object" ? task.delivery : null;
    if (delivery && typeof delivery.whatsapp === "boolean") {
      return delivery.whatsapp;
    }
    const options =
      task.options && typeof task.options === "object" ? task.options : null;
    if (options && typeof options.requires_whatsapp_delivery === "boolean") {
      return options.requires_whatsapp_delivery;
    }
    const normalized = String(task.message || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return false;
    if (
      normalized.includes("whatsapp") ||
      normalized.includes("whats app") ||
      normalized.includes("whatsapp_send_text") ||
      normalized.includes("whatsapp_send_media") ||
      normalized.includes("whatsapp_send_default_group") ||
      normalized.includes("whatsapp_resolve_recipient")
    ) {
      return true;
    }
    if (
      normalized.includes("email") ||
      normalized.includes("gmail") ||
      normalized.includes("slack") ||
      normalized.includes("discord") ||
      normalized.includes("telegram") ||
      normalized.includes("twilio") ||
      normalized.includes("sms") ||
      normalized.includes("phone call") ||
      normalized.includes(" call ") ||
      normalized.includes("signal") ||
      normalized.includes("imessage") ||
      normalized.includes("microsoft teams") ||
      normalized.includes("teams")
    ) {
      return false;
    }
    const hasSendVerb = /\b(send|text|message|deliver|post|notify|share)\b/.test(normalized);
    const hasChatTarget = /\b(group|chat|team|recipient|thread|channel)\b/.test(normalized);
    return hasSendVerb && hasChatTarget;
  };
  const isHeartbeatJob =
    !!taskObj &&
    typeof taskObj === "object" &&
    taskObj.type === "heartbeat_v1";
  const explicitScheduledWhatsAppRequirement =
    !isHeartbeatJob &&
    (scheduledJobExplicitlyRequiresWhatsAppDelivery(taskObj) ||
      !!configuredScheduledWhatsAppTarget?.chatId ||
      !!configuredScheduledWhatsAppTarget?.recipientQuery);
  if (!isHeartbeatJob && scheduledJobRequiresWhatsAppDelivery(taskObj)) {
    expectedWhatsAppSend = true;
  }
  if (!expectedWhatsAppChatId && configuredScheduledWhatsAppTarget?.chatId) {
    expectedWhatsAppChatId = configuredScheduledWhatsAppTarget.chatId;
  }
  if (!expectedWhatsAppRecipientQuery && configuredScheduledWhatsAppTarget?.recipientQuery) {
    expectedWhatsAppRecipientQuery = configuredScheduledWhatsAppTarget.recipientQuery;
  }
  if (
    expectedWhatsAppSend &&
    configuredScheduledWhatsAppTarget &&
    (configuredScheduledWhatsAppTarget.chatId || configuredScheduledWhatsAppTarget.recipientQuery)
  ) {
    log("runScheduledJob: seeded whatsapp fallback target", {
      jobId,
      source: configuredScheduledWhatsAppTarget.source,
      chatId: expectedWhatsAppChatId || undefined,
      recipientQuery: expectedWhatsAppRecipientQuery || undefined,
    });
  }
  const heartbeatWhatsAppEnabled = (() => {
    if (!isHeartbeatJob) return false;
    const delivery =
      taskObj &&
      typeof taskObj === "object" &&
      taskObj.delivery &&
      typeof taskObj.delivery === "object"
        ? taskObj.delivery
        : null;
    return !(delivery && delivery.whatsapp === false);
  })();
  const heartbeatDedupeWindowMs = (() => {
    const raw = Number(process.env.GROOVY_HEARTBEAT_DEDUPE_WINDOW_MS || "");
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return HEARTBEAT_DEDUPE_WINDOW_MS_DEFAULT;
  })();
  const getScheduledWhatsAppUnavailableResult = () => {
    if (!schedulerWhatsAppRuntimeConfig.enabled) {
      return {
        ok: false,
        error: "whatsapp_disabled",
        detail: "WhatsApp bridge disabled in connector config",
      };
    }
    if (
      !schedulerWhatsAppRuntimeConfig.groupName ||
      !schedulerWhatsAppRuntimeConfig.appUrl
    ) {
      return {
        ok: false,
        error: "missing_whatsapp_config",
        detail: "WhatsApp enabled but missing group name or app URL",
      };
    }
    return null;
  };

  async function execTerminalOnce({ command, cwd: cwdIn, timeoutMs, maxOutputChars, extraEnv }) {
    const safeCwd = typeof cwdIn === "string" && cwdIn.trim() ? cwdIn.trim() : os.homedir();
    const env = mergeExtraEnv(buildSanitizedEnv(safeCwd), extraEnv);
    const started = Date.now();
    let ok = true;
    let exitCodeLocal = 0;
    let outStdout = "";
    let outStderr = "";
    let errText = null;
    try {
      const { stdout: out, stderr: err } = await execPortableCommand(String(command || ""), {
        cwd: safeCwd,
        env,
        timeout: Math.max(1000, Number(timeoutMs) || 10 * 60 * 1000),
        maxBuffer: 5 * 1024 * 1024,
      });
      outStdout = typeof out === "string" ? out : String(out || "");
      outStderr = typeof err === "string" ? err : String(err || "");
    } catch (e) {
      ok = false;
      const err = e && typeof e === "object" ? e : null;
      const code = err && "code" in err ? Number(err.code) : NaN;
      exitCodeLocal = Number.isFinite(code) ? code : 1;
      errText = err && "message" in err ? String(err.message) : "command_failed";
      outStdout = err && "stdout" in err ? String(err.stdout || "") : "";
      outStderr = err && "stderr" in err ? String(err.stderr || "") : "";
    }

    // Truncate output deterministically (tail)
    const maxChars = Math.max(1000, Number(maxOutputChars) || 40_000);
    if (outStdout.length + outStderr.length > maxChars) {
      const half = Math.floor(maxChars / 2);
      outStdout = outStdout.length > half ? outStdout.slice(-half) : outStdout;
      const remaining = Math.max(0, maxChars - outStdout.length);
      outStderr = outStderr.length > remaining ? outStderr.slice(-remaining) : outStderr;
    }

    return {
      ok,
      exit_code: exitCodeLocal,
      stdout: outStdout,
      stderr: outStderr,
      error: errText,
      duration_ms: Math.max(0, Date.now() - started),
    };
  }

  async function sendScheduledDefaultGroupMessage(params, { observe = true } = {}) {
    const p = params && typeof params === "object" ? params : {};
    const unavailableResult = getScheduledWhatsAppUnavailableResult();
    if (unavailableResult) return unavailableResult;
    if (!whatsappBridge || typeof whatsappBridge.sendText !== "function") {
      return { ok: false, error: "whatsapp_not_running" };
    }
    const text = String(p.text || "").trim();
    if (!text) return { ok: false, error: "empty_message" };
    const sendOptions = {
      openFollowupWindow: p.open_followup_window === true,
      followupWindowSec: Number(p.followup_window_sec),
      source: typeof p.followup_source === "string" ? p.followup_source : "heartbeat",
    };
    const finalize = (result) => {
      if (observe) {
        observeWhatsAppSendResult(result, "scheduler_whatsapp_send_default_group");
      }
      return result;
    };

    return await runWhatsAppBridgeOp("scheduler_whatsapp_send_default_group", async () => {
      const primaryResult = await whatsappBridge.sendText(text, sendOptions);
      if (primaryResult && typeof primaryResult === "object" && primaryResult.ok === true) {
        return finalize(primaryResult);
      }

      const threadChatId = String(p.chat_id || "").trim();
      if (threadChatId && typeof whatsappBridge.sendTextToChatId === "function") {
        const fallbackResult = await whatsappBridge.sendTextToChatId({
          chatId: threadChatId,
          text,
          ...sendOptions,
        });
        if (fallbackResult && typeof fallbackResult === "object") {
          const primaryError =
            primaryResult &&
            typeof primaryResult === "object" &&
            typeof primaryResult.error === "string"
              ? primaryResult.error
              : "";
          const fallbackError = typeof fallbackResult.error === "string" ? fallbackResult.error : "";
          // Preserve bridge-restart recovery semantics even when direct chat-id fallback also fails.
          if (fallbackResult.ok !== true && primaryError === "bridge_needs_restart") {
            return finalize({
              ...fallbackResult,
              error: "bridge_needs_restart",
              detail: fallbackError ? `${primaryError}; fallback_failed: ${fallbackError}` : primaryError,
              primary_error: primaryError,
              ...(fallbackError ? { fallback_error: fallbackError } : {}),
            });
          }
          return finalize({
            ...fallbackResult,
            ...(primaryError ? { primary_error: primaryError } : {}),
            ...(fallbackResult.ok === true ? { fallback: "thread_chat_id" } : {}),
          });
        }
        return finalize(fallbackResult);
      }

      return finalize(primaryResult);
    });
  }

  async function executeConnectorType(connectorType, connectorParams) {
    const t = String(connectorType || "");
    const p = connectorParams && typeof connectorParams === "object" ? connectorParams : {};
    try {
      if (t === "terminal_exec") {
        return await execTerminalOnce({
          command: p.command,
          cwd: p.cwd || cwd,
          timeoutMs: p.timeout_ms,
          maxOutputChars: p.max_output_chars,
          extraEnv: p.env,
        });
      }

      if (t.startsWith("skills_")) {
        return await executeSkillsConnectorRpc(t, p);
      }

      if (t === "runtime_branch_parallel_batch") {
        const compactParallelToolResult = (toolName, value) => {
          let text = "";
          try {
            text = typeof value === "string" ? value : JSON.stringify(value ?? null);
          } catch {
            text = String(value ?? "");
          }
          if (text.length > 8000) {
            text = `${text.slice(0, 8000)}\n...[truncated]`;
          }
          return text;
        };

        const baseUrl = String(
          p.app_url ||
          p.appUrl ||
          p?.state?.context?.appBaseUrl ||
          activeAppUrl ||
          ""
        ).trim().replace(/\/$/, "");
        const kind = String(p.kind || "").trim();

        if (kind === "final") {
          const finalResult =
            p.result && typeof p.result === "object" ? p.result : { result: p.result };
          return { ok: true, ...(finalResult || {}) };
        }

        if (kind !== "needs_connector") {
          return { ok: false, error: "invalid_parallel_branch_batch" };
        }
        if (!baseUrl) {
          return { ok: false, error: "missing_app_url" };
        }
        if (!activeDeviceToken) {
          return { ok: false, error: "missing_device_token" };
        }

        const executeBatchRows = async (rows) => {
          const toolResults = [];
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i] && typeof rows[i] === "object" ? rows[i] : {};
            const branchId = String(row.branchId || "").trim();
            const toolCallId = String(row.toolCallId || "").trim();
            const toolName = String(row.toolName || "").trim();
            const nestedType = String(row.connectorType || "").trim();
            const nestedParams =
              row.connectorParams && typeof row.connectorParams === "object"
                ? row.connectorParams
                : {};

            if (!branchId || !toolCallId || !toolName || !nestedType) {
              toolResults.push({
                branchId,
                toolCallId: toolCallId || `parallel-branch-missing-${Date.now()}-${i}`,
                toolName: toolName || "unknown_connector_tool",
                result: JSON.stringify({ ok: false, error: "invalid_parallel_branch_execute" }),
              });
              continue;
            }

            let nestedResult;
            try {
              nestedResult = await executeConnectorType(nestedType, nestedParams);
            } catch (err) {
              nestedResult = {
                ok: false,
                error: err instanceof Error ? err.message : String(err || "connector_execute_failed"),
              };
            }
            toolResults.push({
              branchId,
              toolCallId,
              toolName,
              result: compactParallelToolResult(toolName, nestedResult),
            });
          }
          return toolResults;
        };

        let state = p.state && typeof p.state === "object" ? p.state : null;
        let rows = Array.isArray(p.connectorExecutes) ? p.connectorExecutes : [];
        const MAX_BRANCH_BATCH_ROUNDS = 20;
        if (rows.length === 0) {
          return { ok: false, error: "missing_parallel_branch_executes" };
        }

        for (let round = 0; round < MAX_BRANCH_BATCH_ROUNDS; round++) {
          const toolResults = await executeBatchRows(rows);
          const resp = await fetch(`${baseUrl}/api/orchestrator/parallel-branches/continue`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-device-token": String(activeDeviceToken),
            },
            body: JSON.stringify({
              state,
              toolResults,
            }),
          });
          const json = await resp.json().catch(() => ({}));
          if (!resp.ok || json?.ok === false) {
            const err =
              typeof json?.error === "string" && json.error.trim()
                ? json.error.trim()
                : `parallel_branch_continue_failed_${resp.status}`;
            return { ok: false, error: err };
          }

          if (json?.kind === "final") {
            const finalResult =
              json.result && typeof json.result === "object" ? json.result : { result: json.result };
            return { ok: true, ...(finalResult || {}) };
          }

          state = json?.state && typeof json.state === "object" ? json.state : null;
          rows = Array.isArray(json?.connectorExecutes) ? json.connectorExecutes : [];
          if (!state || rows.length === 0) {
            return { ok: false, error: "invalid_parallel_branch_continue_payload" };
          }
        }

        return { ok: false, error: "parallel_branch_batch_round_limit" };
      }

      // ===== Browser Tasks (Playwright MCP preferred) =====
      // NOTE: scheduled jobs execute connector tools directly (not via relay WS),
      // so we must support browser tooling here too.
      if (t === "browser_task_run") {
        const task = String(p.task || "").trim();
        const startUrl =
          typeof p.start_url === "string"
            ? p.start_url
            : typeof p.startUrl === "string"
              ? p.startUrl
              : undefined;
        const appUrl = String(p.app_url || p.appUrl || "").trim();
        const profileName = typeof p.profile_name === "string" ? p.profile_name : "default";
        const apiKey = typeof p.api_key === "string" ? p.api_key.trim() : "";
        const cliToken = typeof p.cli_token === "string" ? p.cli_token.trim() : "";
        const requestedTimeoutMs = Number(p.timeout_ms);
        const envBrowserTimeoutMs = Number(
          process.env.GROOVY_BROWSER_TASK_TIMEOUT_MS || process.env.GROOVY_PLAYWRIGHT_TIMEOUT_MS || ""
        );
        const timeoutMs =
          Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
            ? requestedTimeoutMs
            : Number.isFinite(envBrowserTimeoutMs) && envBrowserTimeoutMs > 0
              ? envBrowserTimeoutMs
              : 8 * 60 * 1000;

        const usePlaywright = await isPlaywrightAvailable();
        const hasCliAuth = !!(cliToken || apiKey);
        if (usePlaywright && hasCliAuth) {
          return await runBrowserTaskViaPlaywright({
            task,
            start_url: startUrl,
            api_key: apiKey,
            cli_token: cliToken,
            timeout_ms: timeoutMs,
            profile_name: profileName,
          });
        }

        return await runBrowserTaskOnConnector({
          task,
          start_url: startUrl,
          app_url: appUrl,
          profile_name: profileName,
          device_token: activeDeviceToken || undefined,
        });
      }

      // ===== Credentials (local prompt + local encrypted vault) =====
      if (t === "browser_credential_get") {
        const domain = String(p.domain || "").trim();
        return await credentialGetMeta({ domain });
      }

      if (t === "browser_credential_request") {
        const domain = String(p.domain || "").trim();
        const reason = typeof p.reason === "string" ? p.reason : undefined;
        return await credentialRequest({ domain, reason });
      }

      // ===== Browser Automation Operations (legacy low-level) =====
      if (t === "browser_init") {
        const headless = p.headless !== false;
        return await initBrowser({ headless });
      }

      if (t === "browser_close") {
        return await closeBrowser();
      }

      if (t === "browser_navigate") {
        const url = String(p.url || "");
        const pageId = String(p.page_id || "default");
        const waitUntil = p.wait_until ? String(p.wait_until) : undefined;
        const timeoutMs = p.timeout_ms !== undefined ? Number(p.timeout_ms) : undefined;
        return await browserNavigate({ url, pageId, waitUntil, timeoutMs });
      }

      if (t === "browser_click") {
        const selector = String(p.selector || "");
        const pageId = String(p.page_id || "default");
        const waitForNav = p.wait_for_nav === true;
        return await browserClick({ selector, pageId, waitForNav });
      }

      if (t === "browser_type") {
        const selector = String(p.selector || "");
        const text = String(p.text || "");
        const pageId = String(p.page_id || "default");
        const clear = p.clear !== false;
        return await browserType({ selector, text, pageId, clear });
      }

      if (t === "browser_press_key") {
        const key = String(p.key || "");
        const pageId = String(p.page_id || "default");
        return await browserPressKey({ key, pageId });
      }

      if (t === "browser_screenshot") {
        const pageId = String(p.page_id || "default");
        const fullPage = p.full_page === true;
        const selector = p.selector ? String(p.selector) : null;
        return await browserScreenshot({ pageId, fullPage, selector });
      }

      if (t === "browser_extract") {
        const pageId = String(p.page_id || "default");
        const selector = p.selector ? String(p.selector) : null;
        const extractType = String(p.extract_type || "text");
        return await browserExtract({ pageId, selector, type: extractType });
      }

      if (t === "browser_wait") {
        const pageId = String(p.page_id || "default");
        const selector = p.selector ? String(p.selector) : null;
        const timeout = Number(p.timeout) || 10_000;
        return await browserWait({ pageId, selector, timeout });
      }

      if (t === "browser_scroll") {
        const pageId = String(p.page_id || "default");
        const direction = String(p.direction || "down");
        const amount = Number(p.amount) || 500;
        return await browserScroll({ pageId, direction, amount });
      }

      if (t === "browser_info") {
        const pageId = String(p.page_id || "default");
        return await browserGetInfo({ pageId });
      }

      if (t === "browser_evaluate") {
        const pageId = String(p.page_id || "default");
        const script = String(p.script || "");
        return await browserEvaluate({ pageId, script });
      }

      if (t === "browser_fill_form") {
        const pageId = String(p.page_id || "default");
        const formSelector = String(p.form_selector || "form");
        const fields = p.fields && typeof p.fields === "object" ? p.fields : {};
        return await browserFillForm({ pageId, formSelector, fields });
      }

      if (t === "browser_close_page") {
        const pageId = String(p.page_id || "default");
        return await browserClosePage({ pageId });
      }

      if (t === "browser_list_pages") {
        return await browserListPages();
      }

      // Claude Computer Use action (coordinate-based)
      if (t === "computer_use_action") {
        const action = String(p.action || "screenshot");
        const coordinate = Array.isArray(p.coordinate) ? p.coordinate : null;
        const text = p.text !== undefined ? String(p.text) : undefined;
        const key = p.key !== undefined ? String(p.key) : undefined;
        const scrollDirection = String(p.scroll_direction || p.scrollDirection || "down");
        const scrollAmount = Number(p.scroll_amount || p.scrollAmount) || 3;
        const pageId = String(p.page_id || "default");
        const region = p.region && typeof p.region === "object" ? p.region : undefined;
        return await computerUseAction({
          action,
          coordinate,
          text,
          key,
          scrollDirection,
          scrollAmount,
          pageId,
          region,
        });
      }

      if (t === "linkdb_init") return await linkdbInit();
      if (t === "linkdb_upsert_links") return await linkdbUpsertLinks({ links: p.links });
      if (t === "linkdb_update") return await linkdbUpdate({ ...p });
      if (t === "linkdb_query") return await linkdbQuery({ ...p });
      if (t === "linkdb_digest") return await linkdbDigest({ ...p });

      // Generic SQLite (multi-project DBs)
      if (t === "sqlite_list") return await sqliteListDbs();
      if (t === "sqlite_exec") return await sqliteExec({ ...p });
      if (t === "sqlite_query") return await sqliteQuery({ ...p });

      // SQLite project registry
      if (t === "sqlite_project_list") return await sqliteProjectList();
      if (t === "sqlite_project_get_or_create") return await sqliteProjectGetOrCreate({ ...p });
      if (t === "sqlite_project_update") return await sqliteProjectUpdate({ ...p });

      // Files
      if (t === "file_read") return await fileRead({ filePath: String(p.path || ""), allowedRoots: undefined });
      if (t === "file_write")
        return await fileWrite({
          filePath: String(p.path || ""),
          content: String(p.content || ""),
          allowedRoots: undefined,
        });
      if (t === "file_list")
        return await fileList({
          dirPath: String(p.path || ""),
          allowedRoots: undefined,
          recursive: p.recursive === true,
        });
      if (t === "file_search")
        return await fileSearch({
          rootPath: String(p.root || p.path || ""),
          query: String(p.query || ""),
          allowedRoots: undefined,
          searchContent: p.search_content !== false,
        });
      if (t === "file_delete")
        return await fileDelete({ filePath: String(p.path || ""), allowedRoots: undefined });
      if (t === "file_mkdir")
        return await fileCreateDir({ dirPath: String(p.path || ""), allowedRoots: undefined });
      if (t === "file_move")
        return await fileMove({
          sourcePath: String(p.source || ""),
          destPath: String(p.destination || ""),
          allowedRoots: undefined,
        });

      // Obsidian
      if (t === "obsidian_discover") return await discoverVaults();
      if (t === "obsidian_read")
        return await obsidianRead({ vaultPath: String(p.vault_path || ""), notePath: String(p.note_path || "") });
      if (t === "obsidian_write")
        return await obsidianWrite({
          vaultPath: String(p.vault_path || ""),
          notePath: String(p.note_path || ""),
          content: String(p.content || ""),
        });
      if (t === "obsidian_search")
        return await obsidianSearch({
          vaultPath: String(p.vault_path || ""),
          query: String(p.query || ""),
          searchContent: p.search_content !== false,
          searchTags: p.search_tags !== false,
        });
      if (t === "obsidian_list") return await obsidianList({ vaultPath: String(p.vault_path || "") });
      if (t === "obsidian_daily")
        return await obsidianDailyNote({
          vaultPath: String(p.vault_path || ""),
          content: typeof p.content === "string" ? p.content : "",
          append: p.append !== false,
        });

      // WhatsApp (requires WhatsApp bridge enabled/running in this connector)
      if (t === "whatsapp_resolve_recipient") {
        return await runWhatsAppBridgeOp("scheduler_whatsapp_resolve_recipient", async () => {
          const unavailableResult = getScheduledWhatsAppUnavailableResult();
          if (unavailableResult) return unavailableResult;
          if (!whatsappBridge || typeof whatsappBridge.resolveRecipient !== "function") {
            return { ok: false, error: "whatsapp_not_running" };
          }
          const query = String(p.query || "");
          const result = await whatsappBridge.resolveRecipient({
            query,
            limit: p.limit,
          });
          rememberWhatsAppResolve(result, {
            query,
            source: "scheduler_whatsapp_resolve_recipient",
            scopeKey: whatsappResolveScopeKey,
          });
          return result;
        });
      }
      if (t === "whatsapp_send_text") {
        const result = await runWhatsAppBridgeOp("scheduler_whatsapp_send_text", async () => {
          const unavailableResult = getScheduledWhatsAppUnavailableResult();
          if (unavailableResult) return unavailableResult;
          if (!whatsappBridge || typeof whatsappBridge.sendTextToChatId !== "function") {
            return { ok: false, error: "whatsapp_not_running" };
          }
          const recipientQuery =
            typeof p.recipient_query === "string" && p.recipient_query.trim()
              ? p.recipient_query.trim()
              : typeof p.recipient_display === "string" && p.recipient_display.trim()
                ? p.recipient_display.trim()
                : "";
          const target = await pickWhatsAppSendChatId({
            requestedChatId: String(p.chat_id || ""),
            recipientQuery,
            source: "scheduler_whatsapp_send_text",
            scopeKey: whatsappResolveScopeKey,
            preferRecentResolve: p.guard_recent_resolve !== false,
            requireRecipientQueryForRecentResolve: false,
          });
          let result = await whatsappBridge.sendTextToChatId({
            chatId: target.chatId,
            text: String(p.text || ""),
          });
          if (target.correctionReason && result && typeof result === "object") {
            result = {
              ...result,
              corrected_chat_id_from: target.correctedFrom || String(p.chat_id || ""),
              corrected_chat_id_to: target.chatId,
              correction_reason: target.correctionReason,
            };
          }
          return result;
        });
        observeWhatsAppSendResult(result, "scheduler_whatsapp_send_text");
        return result;
      }
      if (t === "whatsapp_send_media") {
        const result = await runWhatsAppBridgeOp("scheduler_whatsapp_send_media", async () => {
          const unavailableResult = getScheduledWhatsAppUnavailableResult();
          if (unavailableResult) return unavailableResult;
          if (!whatsappBridge || typeof whatsappBridge.sendMediaToChatId !== "function") {
            return { ok: false, error: "whatsapp_not_running" };
          }
          const recipientQuery =
            typeof p.recipient_query === "string" && p.recipient_query.trim()
              ? p.recipient_query.trim()
              : typeof p.recipient_display === "string" && p.recipient_display.trim()
                ? p.recipient_display.trim()
                : "";
          const target = await pickWhatsAppSendChatId({
            requestedChatId: String(p.chat_id || ""),
            recipientQuery,
            source: "scheduler_whatsapp_send_media",
            scopeKey: whatsappResolveScopeKey,
            preferRecentResolve: p.guard_recent_resolve !== false,
            requireRecipientQueryForRecentResolve: false,
          });
          let result = await whatsappBridge.sendMediaToChatId({
            chatId: target.chatId,
            url: String(p.url || ""),
            localPath: String(p.local_path || ""),
            filename: typeof p.filename === "string" ? p.filename : undefined,
            caption: typeof p.caption === "string" ? p.caption : undefined,
          });
          if (target.correctionReason && result && typeof result === "object") {
            result = {
              ...result,
              corrected_chat_id_from: target.correctedFrom || String(p.chat_id || ""),
              corrected_chat_id_to: target.chatId,
              correction_reason: target.correctionReason,
            };
          }
          const pending_message_id = String(p.pending_message_id || "").trim();
          const recipient_display = String(p.recipient_display || "").trim();
          if (result && typeof result === "object") {
            result = {
              ...result,
              ...(pending_message_id ? { pending_message_id } : {}),
              ...(recipient_display ? { recipient_display } : {}),
            };
          }
          return result;
        });
        observeWhatsAppSendResult(result, "scheduler_whatsapp_send_media");
        return result;
      }

      if (t === "email_unsubscribe_execute") {
        return await executeLocalUnsubscribe({
          unsubscribeUrl: p.unsubscribe_url,
          unsubscribeMailto: p.unsubscribe_mailto,
        });
      }

      // Heartbeat: prefer default WhatsApp group; fall back to explicit chat_id when provided.
      if (t === "whatsapp_send_default_group") {
        return await sendScheduledDefaultGroupMessage(p);
      }

      return { ok: false, error: `unsupported_connector_type:${t}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  try {
    if (kind === "orchestrator") {
      const scheduledWhatsAppUnavailable = explicitScheduledWhatsAppRequirement
        ? getScheduledWhatsAppUnavailableResult()
        : null;
      if (scheduledWhatsAppUnavailable) {
        const err = new Error(String(scheduledWhatsAppUnavailable.error || "whatsapp_unavailable"));
        const unavailableDetail =
          typeof scheduledWhatsAppUnavailable.detail === "string"
            ? scheduledWhatsAppUnavailable.detail
            : "";
        err.cause = unavailableDetail;
        err.stderr = unavailableDetail;
        throw err;
      }
      const appUrl =
        activeAppUrl ||
        process.env.GROOVY_APP_URL ||
        process.env.FLOW_APP_URL ||
        process.env.NEXT_PUBLIC_APP_URL ||
        "";
      if (!appUrl) {
        throw new Error("GROOVY_APP_URL not set (required for orchestrator scheduled jobs). Pass --app-url or set GROOVY_APP_URL.");
      }
      if (!activeDeviceToken) {
        throw new Error("device_token not available yet; wait for connector_ready");
      }

      const baseUrl = String(appUrl).replace(/\/+$/, "");
      const MAX_ROUNDS = 12;
      let traceId = null;
      let toolResults = null;
      const upsertToolResult = (nextResult) => {
        if (!nextResult || typeof nextResult !== "object") return;
        const toolCallId =
          typeof nextResult.toolCallId === "string" ? nextResult.toolCallId : "";
        if (!toolCallId) return;
        if (!Array.isArray(toolResults)) toolResults = [];
        const idx = toolResults.findIndex((entry) => entry?.toolCallId === toolCallId);
        if (idx >= 0) {
          toolResults[idx] = nextResult;
        } else {
          toolResults.push(nextResult);
        }
      };
      let lastJson = null;
      let roundResolved = false;
      const schedulerWhatsAppThreadKey =
        whatsappBridge && typeof whatsappBridge.getThreadKey === "function"
          ? String(whatsappBridge.getThreadKey() || "").trim() || null
          : null;
      const rememberScheduledWhatsAppTarget = ({ chatId, recipientQuery }) => {
        const nextChatId = normalizeScheduledWhatsAppTargetValue(chatId);
        const nextRecipientQuery = isLikelyScheduledWhatsAppRecipientQuery(recipientQuery)
          ? normalizeScheduledWhatsAppTargetValue(recipientQuery)
          : "";
        if (nextChatId) expectedWhatsAppChatId = nextChatId;
        if (nextRecipientQuery) expectedWhatsAppRecipientQuery = nextRecipientQuery;
      };
      const shouldSkipRetryDuplicateWhatsAppSend = (connectorType, connectorParams) => {
        if (!didSendWhatsApp) return false;
        const t = String(connectorType || "").trim();
        if (t !== "whatsapp_send_text" && t !== "whatsapp_send_default_group") return false;
        const p = connectorParams && typeof connectorParams === "object" ? connectorParams : {};
        const chatId =
          typeof p.chat_id === "string" && p.chat_id.trim() ? p.chat_id.trim() : "";
        const recipientQuery =
          typeof p.recipient_query === "string" && p.recipient_query.trim()
            ? p.recipient_query.trim()
            : "";
        const priorChatId =
          sentWhatsAppMeta && typeof sentWhatsAppMeta.chatId === "string"
            ? sentWhatsAppMeta.chatId
            : "";
        const priorName =
          sentWhatsAppMeta && typeof sentWhatsAppMeta.name === "string"
            ? sentWhatsAppMeta.name
            : "";
        if (chatId && priorChatId) return chatId === priorChatId;
        if (recipientQuery && priorName) {
          return recipientQuery.toLowerCase() === priorName.toLowerCase();
        }
        if (t === "whatsapp_send_default_group" && schedulerWhatsAppThreadKey && priorChatId) {
          return schedulerWhatsAppThreadKey === priorChatId;
        }
        if (!chatId && !recipientQuery && expectedWhatsAppChatId && priorChatId) {
          return expectedWhatsAppChatId === priorChatId;
        }
        return false;
      };
      const noteExpectedWhatsAppSend = (connectorType, connectorParams) => {
        const t = String(connectorType || "").trim();
        if (
          t !== "whatsapp_send_text" &&
          t !== "whatsapp_send_media" &&
          t !== "whatsapp_send_default_group"
        ) {
          return;
        }
        expectedWhatsAppSend = true;
        const p = connectorParams && typeof connectorParams === "object" ? connectorParams : {};
        const chatId =
          typeof p.chat_id === "string" && p.chat_id.trim() ? p.chat_id.trim() : "";
        const recipientQuery =
          typeof p.recipient_query === "string" && p.recipient_query.trim()
            ? p.recipient_query.trim()
            : "";
        if (chatId) expectedWhatsAppChatId = chatId;
        if (recipientQuery) expectedWhatsAppRecipientQuery = recipientQuery;
        if (
          !expectedWhatsAppChatId &&
          t === "whatsapp_send_default_group" &&
          schedulerWhatsAppThreadKey
        ) {
          expectedWhatsAppChatId = schedulerWhatsAppThreadKey;
        }
      };
      const tryScheduledWhatsAppFinalFallback = async (finalText) => {
        const textToSend = String(finalText || "").trim();
        if (!textToSend) {
          return { ok: false, error: "scheduled_whatsapp_send_missing_after_final" };
        }
        if (expectedWhatsAppChatId || expectedWhatsAppRecipientQuery) {
          return await runConnectorOpWithPriority(
            "low",
            `scheduler:${jobId}:whatsapp_send_text_final_fallback`,
            () =>
              executeConnectorType("whatsapp_send_text", {
                chat_id: expectedWhatsAppChatId || undefined,
                ...(expectedWhatsAppRecipientQuery
                  ? { recipient_query: expectedWhatsAppRecipientQuery }
                  : {}),
                text: textToSend,
              })
          );
        }
        return { ok: false, error: "scheduled_whatsapp_send_missing_target_after_final" };
      };

      log("runScheduledJob: starting orchestrator job", { jobId, baseUrl, hasDeviceToken: !!activeDeviceToken });

      for (let i = 0; i < MAX_ROUNDS; i++) {
        log("runScheduledJob: calling /api/scheduler/run", { jobId, round: i + 1, traceId, toolResultsCount: toolResults?.length || 0 });
        const schedulerRequestTimeoutMs = 14 * 60 * 1000;
        const schedulerRequestSignal =
          typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(schedulerRequestTimeoutMs)
            : undefined;
        const resp = await fetch(`${baseUrl}/api/scheduler/run`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-device-token": String(activeDeviceToken || ""),
          },
          body: JSON.stringify({
            jobId,
            traceId: traceId || undefined,
            toolResults: toolResults || undefined,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            whatsappThreadKey: schedulerWhatsAppThreadKey || undefined,
            connectorPlatform:
              process.platform === "win32"
                ? "windows"
                : process.platform === "darwin"
                  ? "macos"
                  : "unknown",
          }),
          signal: schedulerRequestSignal,
        });
        const raw = await resp.text().catch(() => "");
        let json = {};
        let parseFailed = false;
        if (raw && raw.trim()) {
          try {
            json = JSON.parse(raw);
          } catch {
            parseFailed = true;
          }
        }
        lastJson = json;
        log("runScheduledJob: /api/scheduler/run response", {
          jobId,
          round: i + 1,
          status: resp.status,
          ok: json?.ok,
          kind: json?.kind,
          traceId: json?.traceId,
          parseFailed,
          bodyLen: raw.length,
          error: typeof json?.error === "string" ? json.error : undefined,
        });
        if (json?.requiresWhatsAppDelivery === true) {
          expectedWhatsAppSend = true;
        }
        if (!resp.ok || !json?.ok) {
          const parseFailureLikeTimeout =
            resp.ok &&
            (parseFailed || !raw.trim()) &&
            (!json || typeof json !== "object" || Object.keys(json).length === 0);
          const msg =
            typeof json?.error === "string" && json.error.trim()
              ? json.error
              : parseFailureLikeTimeout
                ? `scheduler_response_incomplete_or_non_json:status=${resp.status}:len=${raw.length}`
                : raw.trim() || `scheduler_run_failed:${resp.status}`;
          const err = new Error(msg || `scheduler_run_failed:${resp.status}`);
          if (json?.retryable === true || parseFailureLikeTimeout) err.retryable = true;
          throw err;
        }

        if (typeof json?.traceId === "string" && json.traceId) traceId = json.traceId;

        if (json.kind === "final") {
          stdout = typeof json?.text === "string" ? json.text : JSON.stringify(json);
          stderr = "";
          // Reliability fallback:
          // heartbeat route should normally return needs_connector for WhatsApp delivery.
          // If server responds final with a non-empty text while WhatsApp delivery is enabled,
          // send directly from connector to avoid silent drops.
          if (
            isHeartbeatJob &&
            heartbeatWhatsAppEnabled &&
            !didSendWhatsApp &&
            typeof json?.text === "string" &&
            json.text.trim() &&
            whatsappBridge &&
            typeof whatsappBridge.sendText === "function"
          ) {
            const heartbeatText = String(json.text || "").trim();
            const dedupe = await checkHeartbeatMessageDedupe({
              jobId,
              text: heartbeatText,
              windowMs: heartbeatDedupeWindowMs,
            });
            if (dedupe.deduped) {
              didSendWhatsApp = true;
              sentWhatsAppMeta = dedupe.lastChatId
                ? { chatId: dedupe.lastChatId, name: "" }
                : null;
              log("runScheduledJob: heartbeat final fallback deduped", {
                jobId,
                traceId,
                windowMs: heartbeatDedupeWindowMs,
                ageMs: dedupe.ageMs,
                hash: dedupe.hash.slice(0, 12),
              });
            } else {
              const fallbackResult = await runConnectorOpWithPriority(
                "low",
                `scheduler:${jobId}:whatsapp_send_default_group`,
                () =>
                  executeConnectorType(
                    "whatsapp_send_default_group",
                    {
                      text: heartbeatText,
                      open_followup_window: /\?/.test(heartbeatText),
                      followup_window_sec: 7200,
                      followup_source: "heartbeat_final_fallback",
                    }
                  )
              );
              const ok =
                !!(
                  fallbackResult &&
                  typeof fallbackResult === "object" &&
                  fallbackResult.ok === true
                );
              if (ok) {
                didSendWhatsApp = true;
                const chatId =
                  fallbackResult &&
                  typeof fallbackResult === "object" &&
                  typeof fallbackResult.chatId === "string"
                    ? fallbackResult.chatId
                    : "";
                const name =
                  fallbackResult &&
                  typeof fallbackResult === "object" &&
                  typeof fallbackResult.name === "string"
                    ? fallbackResult.name
                    : "";
                sentWhatsAppMeta = { chatId, name };
                await markHeartbeatMessageSent({
                  jobId,
                  hash: dedupe.hash,
                  chatId,
                  traceId,
                  toolCallId: "heartbeat_final_fallback",
                });
                log("runScheduledJob: heartbeat final fallback send ok", {
                  jobId,
                  chatId,
                  name,
                  textLen: heartbeatText.length,
                });
              } else {
                const fallbackError =
                  fallbackResult &&
                  typeof fallbackResult === "object" &&
                  typeof fallbackResult.error === "string"
                    ? fallbackResult.error
                    : "heartbeat_whatsapp_send_failed";
                warn("runScheduledJob: heartbeat final fallback send failed", {
                  jobId,
                  error: fallbackError,
                });
                status = "error";
                exitCode = 1;
                errorText = fallbackError;
              }
            }
          }
          if (!isHeartbeatJob && expectedWhatsAppSend && !didSendWhatsApp) {
            log("runScheduledJob: final without confirmed whatsapp send; attempting fallback", {
              jobId,
              traceId,
              expectedWhatsAppChatId: expectedWhatsAppChatId || undefined,
              expectedWhatsAppRecipientQuery: expectedWhatsAppRecipientQuery || undefined,
            });
            const fallbackResult = await tryScheduledWhatsAppFinalFallback(json?.text);
            const ok =
              !!(
                fallbackResult &&
                typeof fallbackResult === "object" &&
                fallbackResult.ok === true
              );
            if (ok) {
              didSendWhatsApp = true;
              const chatId =
                fallbackResult &&
                typeof fallbackResult === "object" &&
                typeof fallbackResult.chatId === "string"
                  ? fallbackResult.chatId
                  : expectedWhatsAppChatId || "";
              const name =
                fallbackResult &&
                typeof fallbackResult === "object" &&
                typeof fallbackResult.name === "string"
                  ? fallbackResult.name
                  : "";
              sentWhatsAppMeta = { chatId, name };
              log("runScheduledJob: scheduled final fallback send ok", {
                jobId,
                chatId: chatId || undefined,
                name: name || undefined,
                usedExpectedTarget: !!(expectedWhatsAppChatId || expectedWhatsAppRecipientQuery),
              });
            } else {
              const fallbackError =
                fallbackResult &&
                typeof fallbackResult === "object" &&
                typeof fallbackResult.error === "string"
                  ? fallbackResult.error
                  : "scheduled_whatsapp_send_missing_after_final";
              warn("runScheduledJob: scheduled final fallback send failed", {
                jobId,
                traceId,
                error: fallbackError,
              });
              status = "error";
              exitCode = 1;
              errorText = fallbackError;
              noteNonRetryableScheduledWhatsAppFailure(fallbackError);
              noteRetryWhenWhatsAppHealthy(fallbackError);
              if (isRetryableScheduleError(fallbackError)) {
                retryableFailure = true;
                retryReason = fallbackError;
              }
            }
          }
          roundResolved = true;
          break;
        }

        if (json.kind === "needs_connector") {
          const execs = Array.isArray(json?.connectorExecutes) ? json.connectorExecutes : [];
          if (execs.length === 0) {
            const err = new Error("scheduler_needs_connector_without_executes");
            err.retryable = true;
            throw err;
          }
          const skipWhatsappTextChatIds = new Set();
          for (const ex of execs) {
            const toolCallId = String(ex?.toolCallId || "");
            const toolName = String(ex?.toolName || "");
            const connectorType = String(ex?.connectorType || "");
            const connectorParams = ex?.connectorParams && typeof ex.connectorParams === "object" ? ex.connectorParams : {};
            noteExpectedWhatsAppSend(connectorType, connectorParams);
            const targetChatId =
              typeof connectorParams.chat_id === "string" && connectorParams.chat_id.trim()
                ? connectorParams.chat_id.trim()
                : "";
            if (
              (toolName === "whatsapp_send_text" || connectorType === "whatsapp_send_text") &&
              targetChatId &&
              skipWhatsappTextChatIds.has(targetChatId)
            ) {
              const skippedResult = {
                ok: false,
                skipped: true,
                error: "skipped_due_media_failure",
                chatId: targetChatId,
              };
              upsertToolResult({
                toolCallId,
                toolName,
                result: JSON.stringify(skippedResult),
              });
              continue;
            }
            let r;
            let heartbeatSendHash = "";
            let heartbeatSendDeduped = false;
            if (shouldSkipRetryDuplicateWhatsAppSend(connectorType, connectorParams)) {
              r = {
                ok: true,
                deduped: true,
                skipped: true,
                reason: "already_sent_in_previous_retry",
                chatId:
                  (sentWhatsAppMeta &&
                    typeof sentWhatsAppMeta.chatId === "string" &&
                    sentWhatsAppMeta.chatId) ||
                  targetChatId ||
                  expectedWhatsAppChatId ||
                  "",
                name:
                  sentWhatsAppMeta &&
                  typeof sentWhatsAppMeta.name === "string" &&
                  sentWhatsAppMeta.name
                    ? sentWhatsAppMeta.name
                    : "",
              };
              log("runScheduledJob: skipping duplicate whatsapp send on retry", {
                jobId,
                toolCallId,
                connectorType,
                chatId: r.chatId || undefined,
                name: r.name || undefined,
              });
            } else if (isHeartbeatJob && connectorType === "whatsapp_send_default_group") {
              const dedupe = await checkHeartbeatMessageDedupe({
                jobId,
                text: connectorParams.text,
                windowMs: heartbeatDedupeWindowMs,
              });
              heartbeatSendHash = dedupe.hash;
              if (dedupe.deduped) {
                heartbeatSendDeduped = true;
                r = {
                  ok: true,
                  deduped: true,
                  skipped: true,
                  reason: "duplicate_heartbeat_whatsapp_message",
                  dedupe_window_ms: heartbeatDedupeWindowMs,
                  dedupe_age_ms: dedupe.ageMs,
                  hash: dedupe.hash,
                  chatId: dedupe.lastChatId || "",
                };
                log("runScheduledJob: heartbeat whatsapp_send deduped", {
                  jobId,
                  toolCallId,
                  traceId,
                  windowMs: heartbeatDedupeWindowMs,
                  ageMs: dedupe.ageMs,
                  hash: dedupe.hash.slice(0, 12),
                });
              } else {
                r = await runConnectorOpWithPriority(
                  "low",
                  `scheduler:${jobId}:${connectorType || "unknown"}`,
                  () => executeConnectorType(connectorType, connectorParams)
                );
              }
            } else {
              r = await runConnectorOpWithPriority(
                "low",
                `scheduler:${jobId}:${connectorType || "unknown"}`,
                () => executeConnectorType(connectorType, connectorParams)
              );
            }
            const connectorErr =
              r && typeof r === "object" && r.ok !== true && typeof r.error === "string"
                ? r.error
                : "";
            if (connectorErr) {
              connectorErrors.push(connectorErr);
              noteNonRetryableScheduledWhatsAppFailure(connectorErr);
              noteRetryWhenWhatsAppHealthy(connectorErr);
            }
            if (
              connectorType === "whatsapp_send_text" ||
              connectorType === "whatsapp_send_media" ||
              connectorType === "whatsapp_send_default_group"
            ) {
              let ok = !!(r && typeof r === "object" && r.ok === true);
              let chatId =
                r && typeof r === "object" && typeof r.chatId === "string"
                  ? r.chatId
                  : typeof connectorParams.chat_id === "string"
                    ? String(connectorParams.chat_id)
                    : "";
              let name =
                r && typeof r === "object" && typeof r.name === "string"
                  ? r.name
                  : "";
              const sendError =
                r && typeof r === "object" && typeof r.error === "string"
                  ? r.error
                  : "";
              const primarySendError =
                r && typeof r === "object" && typeof r.primary_error === "string"
                  ? r.primary_error
                  : "";
              const effectiveSendError = sendError || primarySendError;
              log("runScheduledJob: whatsapp_send result", {
                jobId,
                toolCallId,
                connectorType,
                ok,
                chatId,
                name,
                error: sendError || undefined,
                primaryError: primarySendError || undefined,
              });
              // Auto-restart the WhatsApp bridge when the browser frame is dead,
              // then retry the send once so the current heartbeat isn't lost.
              if (
                !ok &&
                effectiveSendError === "bridge_needs_restart" &&
                connectorType === "whatsapp_send_default_group"
              ) {
                noteWhatsAppDegraded(
                  "scheduler_whatsapp_bridge_needs_restart",
                  effectiveSendError || "bridge_needs_restart",
                  typeof r?.detail === "string" ? r.detail : effectiveSendError
                );
                warn("runScheduledJob: WhatsApp bridge frame dead — restarting bridge", {
                  jobId,
                  detail: r?.detail,
                });
                try {
                  noteWhatsAppRecovering(
                    "scheduler_whatsapp_bridge_restarting",
                    "Restarting WhatsApp bridge after detached-frame failure"
                  );
                  if (!whatsappBridgeOpts) {
                    warn("runScheduledJob: no stored bridge opts — cannot restart", { jobId });
                  }
                  const bridgeOpts = whatsappBridgeOpts || {
                    deviceToken: activeDeviceToken || "",
                    groupName: "",
                    appUrl: activeAppUrl || "",
                  };
                  const schedulerRecoveryOnHealth = (healthEvent) => {
                    const status =
                      healthEvent && typeof healthEvent === "object" && typeof healthEvent.status === "string"
                        ? healthEvent.status
                        : "";
                    const reason =
                      healthEvent && typeof healthEvent === "object" && typeof healthEvent.reason === "string"
                        ? healthEvent.reason
                        : "";
                    const detail =
                      healthEvent && typeof healthEvent === "object" && typeof healthEvent.detail === "string"
                        ? healthEvent.detail
                        : "";
                    if (status === "healthy") {
                      noteWhatsAppHealthy(
                        "scheduler_whatsapp_bridge_ready",
                        detail || reason || "WhatsApp bridge ready after scheduled recovery"
                      );
                      return;
                    }
                    if (status === "recovering") {
                      noteWhatsAppRecovering(
                        "scheduler_whatsapp_bridge_restarting",
                        detail || reason || "WhatsApp bridge recovering during scheduled send retry"
                      );
                      return;
                    }
                    if (status === "disabled") {
                      applyWhatsAppHealthPatch({
                        status: "disabled",
                        reason: "scheduler_whatsapp_bridge_disabled",
                        detail:
                          detail ||
                          reason ||
                          "WhatsApp bridge disabled during scheduled send recovery",
                        consecutive_failures: 0,
                        recent_failures: 0,
                        auto_restart_pending: false,
                        auto_restart_count: whatsappAutoRestartCount,
                      });
                      return;
                    }
                    noteWhatsAppDegraded(
                      "scheduler_whatsapp_bridge_unhealthy",
                      reason || "whatsapp_unhealthy",
                      detail || "WhatsApp bridge reported an unhealthy state during scheduled recovery"
                    );
                  };
                  const startRecoveredBridge = async ({
                    resetSession = false,
                    disableWebVersionPin = false,
                  } = {}) => {
                    const bridge = await startWhatsAppBridge({
                      ...bridgeOpts,
                      ...(disableWebVersionPin ? { disableWebVersionPin: true } : {}),
                      ...(resetSession ? { resetSession: true } : {}),
                      onHealth: schedulerRecoveryOnHealth,
                    });
                    if (!bridge || typeof bridge !== "object" || bridge.ok !== true) {
                      throw new Error("whatsapp_bridge_restart_non_ok");
                    }
                    whatsappBridge = bridge;
                    await waitForWhatsAppBridgeReadyOrThrow(bridge);
                    return bridge;
                  };

                  let recoveryUsedSessionReset = false;
                  let recoveryUsedUnpinned = false;
                  try {
                    await startRecoveredBridge();
                  } catch (initialRestartErr) {
                    const initialRestartText =
                      initialRestartErr instanceof Error
                        ? initialRestartErr.message
                        : String(initialRestartErr);
                    if (initialRestartText !== "whatsapp_qr_required") {
                      whatsappBridge = null;
                    }
                    const retryableStartup = isRetryableWhatsAppStartupErrorMessage(initialRestartText);
                    const retryWithoutPin = shouldRetryWhatsAppStartupWithoutPin(initialRestartText);
                    const retryWithSessionReset =
                      shouldHardResetWhatsAppSessionOnStartupRetry(initialRestartText);
                    if (!retryableStartup || (!retryWithoutPin && !retryWithSessionReset)) {
                      throw initialRestartErr;
                    }
                    recoveryUsedSessionReset = retryWithSessionReset;
                    recoveryUsedUnpinned = retryWithoutPin;
                    noteWhatsAppRecovering(
                      "scheduler_whatsapp_bridge_retrying",
                      retryWithSessionReset
                        ? "Retrying scheduled WhatsApp recovery with full session reset"
                        : retryWithoutPin
                          ? "Retrying scheduled WhatsApp recovery without pinned WhatsApp Web version"
                          : "Retrying scheduled WhatsApp recovery"
                    );
                    await startRecoveredBridge({
                      resetSession: retryWithSessionReset,
                      disableWebVersionPin: retryWithoutPin,
                    });
                  }

                  log("runScheduledJob: WhatsApp bridge restarted and ready — retrying send", {
                    jobId,
                    resetSession: recoveryUsedSessionReset,
                    disableWebVersionPin: recoveryUsedUnpinned,
                  });
                  // Retry the send once with the fresh bridge.
                  let retryR = await sendScheduledDefaultGroupMessage(connectorParams, {
                    observe: false,
                  });
                  const retryDetail =
                    typeof retryR?.detail === "string"
                      ? retryR.detail
                      : typeof retryR?.error === "string"
                        ? retryR.error
                        : "";
                  const shouldEscalateToSessionReset =
                    retryR &&
                    retryR.ok !== true &&
                    typeof retryR?.error === "string" &&
                    retryR.error === "bridge_needs_restart" &&
                    !recoveryUsedSessionReset &&
                    shouldHardResetWhatsAppSessionOnStartupRetry(retryDetail || "bridge_needs_restart");

                  if (shouldEscalateToSessionReset) {
                    noteWhatsAppRecovering(
                      "scheduler_whatsapp_bridge_resetting",
                      "Resetting WhatsApp session after repeated bridge recovery failure"
                    );
                    whatsappBridge = null;
                    await startRecoveredBridge({
                      resetSession: true,
                      disableWebVersionPin:
                        recoveryUsedUnpinned || shouldRetryWhatsAppStartupWithoutPin(retryDetail),
                    });
                    recoveryUsedSessionReset = true;
                    log("runScheduledJob: WhatsApp session reset completed — retrying send", {
                      jobId,
                    });
                    retryR = await sendScheduledDefaultGroupMessage(connectorParams, {
                      observe: false,
                    });
                  }

                  if (retryR && retryR.ok) {
                    noteWhatsAppHealthy(
                      "scheduler_whatsapp_bridge_recovered",
                      recoveryUsedSessionReset
                        ? "WhatsApp send succeeded after full session reset"
                        : "WhatsApp send succeeded after bridge restart"
                    );
                    log("runScheduledJob: whatsapp_send succeeded after bridge restart", {
                      jobId,
                      chatId: retryR.chatId,
                      resetSession: recoveryUsedSessionReset,
                    });
                    // Overwrite the result so the rest of the loop sees success.
                    r = retryR;
                  } else {
                    r = retryR;
                    const retryError =
                      typeof retryR?.error === "string"
                        ? retryR.error
                        : "whatsapp_send_failed_after_restart";
                    const retryDetailText =
                      typeof retryR?.detail === "string" ? retryR.detail : "";
                    if (retryError === "whatsapp_qr_required") {
                      noteWhatsAppRecovering(
                        "scheduler_whatsapp_qr_required",
                        retryDetailText || "WhatsApp session reset requires QR re-link"
                      );
                    } else {
                      noteWhatsAppDegraded(
                        "scheduler_whatsapp_bridge_restart_failed",
                        retryError,
                        retryDetailText
                      );
                    }
                    warn("runScheduledJob: whatsapp_send still failed after bridge restart", {
                      jobId,
                      error: retryR?.error,
                      resetSession: recoveryUsedSessionReset,
                    });
                  }
                } catch (restartErr) {
                  const restartErrText =
                    restartErr instanceof Error ? restartErr.message : String(restartErr);
                  if (restartErrText !== "whatsapp_qr_required") {
                    whatsappBridge = null;
                  }
                  if (restartErrText === "whatsapp_qr_required") {
                    noteWhatsAppRecovering(
                      "scheduler_whatsapp_qr_required",
                      "WhatsApp session reset requires QR re-link"
                    );
                    r = {
                      ok: false,
                      error: "whatsapp_qr_required",
                      detail: "WhatsApp session reset requires QR re-link",
                    };
                  } else {
                    noteWhatsAppDegraded(
                      "scheduler_whatsapp_bridge_restart_exception",
                      restartErrText,
                      restartErrText
                    );
                  }
                  warn("runScheduledJob: WhatsApp bridge restart threw", {
                    jobId,
                    error: restartErrText,
                  });
                }
              }
              // Recompute from possibly-updated result (after bridge restart retry).
              ok = !!(r && typeof r === "object" && r.ok === true);
              chatId =
                r && typeof r === "object" && typeof r.chatId === "string"
                  ? r.chatId
                  : typeof connectorParams.chat_id === "string"
                    ? String(connectorParams.chat_id)
                    : "";
              name =
                r && typeof r === "object" && typeof r.name === "string"
                  ? r.name
                  : "";
              if (ok) {
                didSendWhatsApp = true;
                sentWhatsAppMeta = { chatId, name };
                rememberScheduledWhatsAppTarget({
                  chatId,
                  recipientQuery: expectedWhatsAppRecipientQuery || name || "",
                });
              }
              if (
                isHeartbeatJob &&
                connectorType === "whatsapp_send_default_group" &&
                ok &&
                !heartbeatSendDeduped &&
                heartbeatSendHash
              ) {
                await markHeartbeatMessageSent({
                  jobId,
                  hash: heartbeatSendHash,
                  chatId,
                  traceId,
                  toolCallId,
                });
              }
            }
            if (
              (toolName === "whatsapp_send_media" || connectorType === "whatsapp_send_media") &&
              targetChatId &&
              !(r && typeof r === "object" && r.ok === true)
            ) {
              skipWhatsappTextChatIds.add(targetChatId);
            }
            upsertToolResult({
              toolCallId,
              toolName,
              result: JSON.stringify(r),
            });
          }
          continue;
        }

        // partial/unsupported kinds
        if (!isHeartbeatJob && expectedWhatsAppSend && !didSendWhatsApp) {
          const unsupportedKind =
            typeof json?.kind === "string" && json.kind.trim() ? json.kind.trim() : "unknown";
          const partialError = `scheduled_whatsapp_delivery_incomplete_kind_${unsupportedKind}`;
          warn("runScheduledJob: unsupported scheduled kind before whatsapp delivery", {
            jobId,
            traceId,
            kind: unsupportedKind,
            expectedWhatsAppChatId: expectedWhatsAppChatId || undefined,
            expectedWhatsAppRecipientQuery: expectedWhatsAppRecipientQuery || undefined,
          });
          status = "error";
          exitCode = 1;
          errorText = partialError;
          roundResolved = true;
          break;
        }
        stdout = typeof json?.text === "string" ? json.text : JSON.stringify(json);
        stderr = "";
        roundResolved = true;
        break;
      }

      if (!roundResolved && lastJson && lastJson.kind === "needs_connector") {
        status = "error";
        exitCode = 1;
        errorText = connectorErrors[0] || "scheduler_connector_rounds_exhausted";
        if (nonRetryableFailure) {
          retryableFailure = false;
          retryReason = nonRetryableReason || errorText || "whatsapp_unavailable";
        } else {
          retryableFailure = true;
          retryReason =
            connectorErrors.find((x) => isRetryableScheduleError(x)) ||
            errorText ||
            "scheduler_connector_rounds_exhausted";
        }
      }

      if (!stdout && lastJson) {
        stdout = JSON.stringify(lastJson);
      }
    } else {
      const { stdout: out, stderr: err } = await execPortableCommand(String(job.command || ""), {
        cwd,
        env,
        timeout: 10 * 60 * 1000,
        maxBuffer: 5 * 1024 * 1024,
      });
      stdout = typeof out === "string" ? out : String(out || "");
      stderr = typeof err === "string" ? err : String(err || "");
    }
  } catch (e) {
    status = "error";
    const err = e && typeof e === "object" ? e : null;
    const code = err && "code" in err ? Number(err.code) : NaN;
    exitCode = Number.isFinite(code) ? code : 1;
    errorText =
      err && "message" in err ? String(err.message) : "command_failed";
    stdout = err && "stdout" in err ? String(err.stdout || "") : "";
    stderr = err && "stderr" in err ? String(err.stderr || "") : "";
    const isRetryableFromServer = !!(err && err.retryable === true);
    const errorCause =
      err && "cause" in err && err.cause
        ? err.cause instanceof Error
          ? err.cause.message
          : String(err.cause)
        : "";
    warn("runScheduledJob: orchestrator job failed", {
      jobId,
      error: errorText,
      cause: errorCause || undefined,
      retryableFromServer: isRetryableFromServer,
    });
    noteNonRetryableScheduledWhatsAppFailure(errorText);
    noteNonRetryableScheduledWhatsAppFailure(errorCause);
    noteRetryWhenWhatsAppHealthy(errorText);
    noteRetryWhenWhatsAppHealthy(errorCause);
    if (
      !nonRetryableFailure &&
      (
        isRetryableFromServer ||
        isRetryableScheduleError(errorText) ||
        connectorErrors.some((x) => isRetryableScheduleError(x))
      )
    ) {
      retryableFailure = true;
      retryReason =
        errorText ||
        connectorErrors.find((x) => isRetryableScheduleError(x)) ||
        "retryable_scheduler_error";
    }
  }

  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

  // Truncate logs to keep relay payload sane
  const MAX_LOG = 40_000;
  if (stdout.length > MAX_LOG) stdout = stdout.slice(-MAX_LOG);
  if (stderr.length > MAX_LOG) stderr = stderr.slice(-MAX_LOG);

  let scheduledRetry = false;
  let retryAttempt = 0;
  let retryNextAtIso = null;
  let retryWaitingForWhatsAppHealthy = false;
  if (kind === "orchestrator") {
    if (nonRetryableFailure) {
      retryableFailure = false;
      if (!errorText && nonRetryableReason) {
        errorText = nonRetryableReason;
      }
    }
    if (status === "success" || status === "skipped") {
      scheduleRetryState.delete(jobId);
    } else if (retryableFailure) {
      const prev = scheduleRetryState.get(jobId);
      const nextAttempt = Number(prev?.attempt || 0) + 1;
      if (nextAttempt <= SCHEDULE_RETRY_MAX_ATTEMPTS) {
        const waitForWhatsAppHealthy = retryWhenWhatsAppHealthy === true;
        const delayMs = waitForWhatsAppHealthy ? 0 : computeScheduleRetryDelayMs(nextAttempt);
        const nextAtMs = waitForWhatsAppHealthy ? 0 : Date.now() + delayMs;
        scheduledRetry = true;
        retryAttempt = nextAttempt;
        retryNextAtIso = waitForWhatsAppHealthy ? null : new Date(nextAtMs).toISOString();
        retryWaitingForWhatsAppHealthy = waitForWhatsAppHealthy;
        scheduleRetryState.set(jobId, {
          attempt: nextAttempt,
          nextAttemptAtMs: nextAtMs,
          lastError: String(errorText || retryReason || ""),
          waitForWhatsAppHealthy,
          didSendWhatsApp,
          sentWhatsAppMeta: didSendWhatsApp ? sentWhatsAppMeta || undefined : undefined,
          expectedWhatsAppSend,
          expectedWhatsAppChatId: expectedWhatsAppChatId || undefined,
          expectedWhatsAppRecipientQuery: expectedWhatsAppRecipientQuery || undefined,
        });
        if (!errorText && retryReason) {
          errorText = retryReason;
        }
        if (waitForWhatsAppHealthy) {
          log("scheduler: retry deferred until whatsapp healthy", {
            jobId,
            attempt: nextAttempt,
            whatsappStatus: whatsappHealthState.status || null,
            error: errorText || retryReason || null,
          });
        } else {
          log("scheduler: queued retry", {
            jobId,
            attempt: nextAttempt,
            nextAttemptAt: retryNextAtIso,
            error: errorText || retryReason || null,
          });
        }
      } else {
        scheduleRetryState.delete(jobId);
        warn("scheduler: retry budget exhausted", {
          jobId,
          attempts: nextAttempt - 1,
          lastError: errorText || retryReason || null,
        });
      }
    } else {
      scheduleRetryState.delete(jobId);
    }
  } else if (status === "success" || status === "skipped") {
    scheduleRetryState.delete(jobId);
  }

  // If WhatsApp bridge is running, post a short scheduled-job status back to the Groovy group.
  // Keep this to ONE LINE (visibility without spamming the group).
  try {
    const shouldPost =
      process.env.GROOVY_WHATSAPP_SCHEDULE_POST !== "0" &&
      process.env.WHATSAPP_SCHEDULE_POST !== "0";
    // Skip status alerts for heartbeat jobs (they have their own delivery logic).
    const taskObj = job?.task;
    const isHeartbeat = taskObj && typeof taskObj === "object" && taskObj.type === "heartbeat_v1";
    if (shouldPost && kind === "orchestrator" && whatsappBridge?.sendText && !isHeartbeat) {
      const jobName = String(job?.name || "Scheduled task");
      const headline = status === "success" ? "✅" : status === "skipped" ? "⏭️" : "❌";
      const suffix =
        didSendWhatsApp
          ? `sent to WhatsApp${sentWhatsAppMeta?.name ? ` (${sentWhatsAppMeta.name})` : sentWhatsAppMeta?.chatId ? ` (${sentWhatsAppMeta.chatId})` : ""}`
          : status === "success"
            ? "completed (no WhatsApp send detected)"
            : status === "skipped"
              ? "skipped"
              : "failed";
      const msg = `${headline} Scheduler: ${jobName} (${jobId}) — ${suffix}`;
      // Best-effort; don't block scheduler reporting if WhatsApp is flaky.
      await runConnectorOpWithPriority(
        "low",
        `scheduler:${jobId}:status_post_whatsapp`,
        async () => {
          const sendPromise = runWhatsAppBridgeOp(`scheduler:${jobId}:status_post_whatsapp`, () =>
            whatsappBridge.sendText(msg)
          ).catch(() => null);
          await Promise.race([sendPromise, new Promise((r) => setTimeout(r, 5000))]);
        }
      );
    }
  } catch {
    // ignore
  }

  // Update local copy so we don't re-run until sync catches up
  const local = scheduledJobs.get(jobId) || job;
  if (
    kind === "orchestrator" &&
    local &&
    local.task &&
    typeof local.task === "object" &&
    !Array.isArray(local.task) &&
    (
      didSendWhatsApp ||
      (configuredScheduledWhatsAppTarget &&
        configuredScheduledWhatsAppTarget.source === "task_options_or_delivery")
    )
  ) {
    const nextTask = { ...local.task };
    const nextOptions =
      nextTask.options && typeof nextTask.options === "object" && !Array.isArray(nextTask.options)
        ? { ...nextTask.options }
        : {};
    if (expectedWhatsAppChatId) {
      nextOptions.whatsapp_chat_id = expectedWhatsAppChatId;
    }
    if (expectedWhatsAppRecipientQuery) {
      nextOptions.whatsapp_recipient_query = expectedWhatsAppRecipientQuery;
    }
    nextTask.options = nextOptions;
    local.task = nextTask;
  }
  if (!scheduledRetry) {
    local.last_run_at = finishedAt.toISOString();
  }
  local.last_status = status;
  local.last_exit_code = exitCode;
  local.updated_at = new Date().toISOString();
  scheduledJobs.set(jobId, local);

  sendToRelay({
    type: "schedule_run_report",
    job_id: jobId,
    status,
    exit_code: exitCode,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,
    stdout,
    stderr,
    error: errorText,
    retryable_error: scheduledRetry,
    retry_attempt: scheduledRetry ? retryAttempt : null,
    retry_next_at: scheduledRetry ? retryNextAtIso : null,
    retry_waiting_for_whatsapp_healthy: scheduledRetry ? retryWaitingForWhatsAppHealthy : false,
    ...(didSendWhatsApp && expectedWhatsAppChatId
      ? { whatsapp_target_chat_id: expectedWhatsAppChatId }
      : {}),
    ...(didSendWhatsApp && expectedWhatsAppRecipientQuery
      ? { whatsapp_target_recipient_query: expectedWhatsAppRecipientQuery }
      : {}),
  });

  inFlightJobs.delete(jobId);
}

async function tickSchedules() {
  if (!activeRelayWs || activeRelayWs.readyState !== WebSocket.OPEN) return;
  const now = new Date();
  for (const job of Array.from(scheduledJobs.values())) {
    const jobId = String(job?.id || "");
    if (!jobId) continue;
    if (inFlightJobs.has(jobId)) continue;
    if (job.enabled === false) {
      scheduleRetryState.delete(jobId);
      continue;
    }

    const retryState = scheduleRetryState.get(jobId);
    if (retryState) {
      const waitForWhatsAppHealthy =
        retryState && typeof retryState === "object" && retryState.waitForWhatsAppHealthy === true;
      const whatsappUnavailableWhileWaitingForHealthy =
        waitForWhatsAppHealthy &&
        (!schedulerWhatsAppRuntimeConfig.enabled ||
          !schedulerWhatsAppRuntimeConfig.groupName ||
          !schedulerWhatsAppRuntimeConfig.appUrl);
      if (
        waitForWhatsAppHealthy &&
        !whatsappUnavailableWhileWaitingForHealthy &&
        whatsappHealthState.status !== "healthy"
      ) {
        continue;
      }
      const nowMs = now.getTime();
      const nextAttemptAtMs = Number(retryState.nextAttemptAtMs || 0);
      if (!waitForWhatsAppHealthy && Number.isFinite(nextAttemptAtMs) && nextAttemptAtMs > nowMs) {
        continue;
      }
      log("scheduler: retry due", {
        jobId,
        name: String(job?.name || ""),
        kind: String(job?.kind || "shell"),
        attempt: Number(retryState.attempt || 0),
        lastError: typeof retryState.lastError === "string" ? retryState.lastError : null,
        ...(waitForWhatsAppHealthy ? { waitForWhatsAppHealthy: true } : {}),
      });
      await runScheduledJob(job);
      continue;
    }

    const dueInfo = isDueNow(job, now);
    if (!dueInfo?.due) continue;

    log("scheduler: job due", {
      jobId,
      name: String(job?.name || ""),
      kind: String(job?.kind || "shell"),
      dueAt: dueInfo?.dueAt ? new Date(dueInfo.dueAt).toISOString() : null,
      now: now.toISOString(),
      last_run_at: job?.last_run_at || null,
      schedule: job?.schedule || null,
      skip_next_run: job?.skip_next_run === true,
    });

    // Cancel-next-run semantics: skip exactly one due execution
    if (job.skip_next_run === true) {
      const finishedAt = new Date();
      job.skip_next_run = false;
      job.last_run_at = finishedAt.toISOString();
      job.last_status = "skipped";
      job.last_exit_code = null;
      job.updated_at = new Date().toISOString();
      scheduledJobs.set(jobId, job);

      log("scheduler: skipped due job (consume skip_next_run)", {
        jobId,
        name: String(job?.name || ""),
        finishedAt: finishedAt.toISOString(),
      });

      sendToRelay({
        type: "schedule_run_report",
        job_id: jobId,
        status: "skipped",
        exit_code: null,
        started_at: finishedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: 0,
        stdout: "",
        stderr: "",
        error: null,
        consume_skip_next: true,
      });
      continue;
    }

    await runScheduledJob(job);
  }
}

const DEFAULT_ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302"] }];

let wrtcPromise = null;
async function getWrtc() {
  if (wrtcPromise) return wrtcPromise;
  wrtcPromise = import("@roamhq/wrtc")
    .then((m) => m?.default || m)
    .catch(() =>
      import("wrtc")
        .then((m) => m?.default || m)
        .catch(() => null)
    );
  return wrtcPromise;
}

function attachWebRtcChannel({ terminalId, webrtcId, pc, dc }) {
  try {
    dc.onopen = () => {
      const set = webrtcChannelsByTerminal.get(terminalId) || new Set();
      set.add(dc);
      webrtcChannelsByTerminal.set(terminalId, set);
      log("webrtc datachannel open", { terminalId, webrtcId });
    };

    dc.onclose = () => {
      const set = webrtcChannelsByTerminal.get(terminalId);
      if (set) {
        set.delete(dc);
        if (set.size === 0) webrtcChannelsByTerminal.delete(terminalId);
      }
      webrtcPeers.delete(webrtcId);
      log("webrtc datachannel closed", { terminalId, webrtcId });
      try {
        pc.close();
      } catch {
        // ignore
      }
    };

    dc.onmessage = (evt) => {
      const p = terminals.get(terminalId);
      if (!p) return;
      const data = evt && typeof evt === "object" && "data" in evt ? evt.data : evt;
      if (typeof data === "string") {
        p.write(data);
        return;
      }
      try {
        // node-webrtc may give Buffer/ArrayBuffer
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        p.write(buf.toString("utf8"));
      } catch {
        // ignore
      }
    };
  } catch (e) {
    warn(
      "failed to attach webrtc datachannel",
      e instanceof Error ? e.message : String(e)
    );
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function discoverClaudeSlashCommands({
  requestId = "",
  cwdRaw = "",
  apiKey = "",
  cliToken = "",
  timeoutMs = 20_000,
  claudeBin = resolveClaudeBin(),
}) {
  const startedAt = Date.now();
  const homeDir = os.homedir();
  const expandTilde = (p) => {
    if (typeof p !== "string") return homeDir;
    const s = p.trim();
    if (s === "~") return homeDir;
    if (s.startsWith("~/")) return path.join(homeDir, s.slice(2));
    return s;
  };
  const normalizeRuntimeCommand = (value) => {
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (!normalized) return "";
      return normalized.startsWith("/") ? normalized : `/${normalized}`;
    }
    if (!value || typeof value !== "object") return "";
    const maybeName =
      typeof value.command === "string"
        ? value.command
        : typeof value.name === "string"
          ? value.name
          : typeof value.slug === "string"
            ? value.slug
            : "";
    return normalizeRuntimeCommand(maybeName);
  };
  const extractRuntimeCommands = (event) => {
    if (!event || event.type !== "system" || event.subtype !== "init") return [];
    if (!Array.isArray(event.slash_commands)) return [];
    return event.slash_commands
      .map((command) => normalizeRuntimeCommand(command))
      .filter(Boolean);
  };

  const requestedCwdExpanded = expandTilde(cwdRaw || homeDir);
  const safeCwd = isDirectory(requestedCwdExpanded) ? requestedCwdExpanded : homeDir;
  const discoveryAttempts = [
    {
      authMode: "local",
      timeoutMs: Math.min(timeoutMs, 15_000),
      cliToken: undefined,
      apiKey: undefined,
    },
    ...(cliToken
      ? [
          {
            authMode: "cli_token",
            timeoutMs,
            cliToken,
            apiKey: undefined,
          },
        ]
      : []),
    ...(apiKey
      ? [
          {
            authMode: "api_key",
            timeoutMs,
            cliToken: undefined,
            apiKey,
          },
        ]
      : []),
  ];

  log("claude_discover_commands auth", {
    requestId,
    hasCliToken: !!cliToken,
    hasApiKey: !!apiKey,
    localAuthFirst: true,
  });

  let errorText = null;
  let commands = [];

  for (const attempt of discoveryAttempts) {
    let discoveredCommands = [];
    const attemptStartedAt = Date.now();
    try {
      log("claude_discover_commands starting", {
        requestId,
        cwd: safeCwd,
        claudeBin,
        authMode: attempt.authMode,
        timeoutMs: attempt.timeoutMs,
      });

      const spawnResult = await runHeadlessClaude({
        prompt: "Reply with the single word READY.",
        cwd: safeCwd,
        timeoutMs: attempt.timeoutMs,
        claudeBin,
        cliToken: attempt.cliToken,
        apiKey: attempt.apiKey,
        extraArgs: ["--max-turns", "1"],
        onStreamEvent: (event) => {
          const extracted = extractRuntimeCommands(event);
          if (extracted.length > 0) {
            discoveredCommands = extracted;
          }
        },
      });

      if (discoveredCommands.length === 0) {
        for (const event of Array.isArray(spawnResult.streamEvents) ? spawnResult.streamEvents : []) {
          const extracted = extractRuntimeCommands(event);
          if (extracted.length > 0) {
            discoveredCommands = extracted;
            break;
          }
        }
      }

      commands = Array.from(new Set(discoveredCommands));
      if (commands.length > 0) {
        log("claude_discover_commands finished", {
          requestId,
          durationMs: Date.now() - attemptStartedAt,
          totalDurationMs: Date.now() - startedAt,
          authMode: attempt.authMode,
          count: commands.length,
          sample: commands.slice(0, 12),
        });
        break;
      }

      if (spawnResult.timedOut === true) {
        errorText =
          typeof spawnResult.timeoutError === "string" && spawnResult.timeoutError.trim()
            ? spawnResult.timeoutError.trim()
            : `claude_discover_commands timed out after ${attempt.timeoutMs}ms`;
      } else if (spawnResult.aborted === true) {
        errorText = "claude_discover_commands_aborted";
      } else {
        errorText = "slash_commands_not_available";
      }
      warn("claude_discover_commands returned no slash_commands", {
        requestId,
        cwd: safeCwd,
        authMode: attempt.authMode,
        timedOut: spawnResult.timedOut === true,
        aborted: spawnResult.aborted === true,
        eventTypes: Array.isArray(spawnResult.streamEvents)
          ? spawnResult.streamEvents.map((event) => event?.type).filter(Boolean).slice(0, 12)
          : [],
      });
    } catch (e) {
      const err = e && typeof e === "object" ? e : null;
      errorText =
        err && "message" in err ? String(err.message) : "claude_discover_commands_failed";
      warn("claude_discover_commands error", {
        requestId,
        authMode: attempt.authMode,
        durationMs: Date.now() - attemptStartedAt,
        error: errorText,
      });
    }
  }

  return {
    ok: commands.length > 0,
    commands,
    errorText: commands.length > 0 ? null : errorText || "slash_commands_not_available",
    safeCwd,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function normalizePathString(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s;
}

function inferRepoWorkspaceCwd() {
  // Best-effort heuristic to avoid requiring GROOVY_CODE_CWD for most users.
  // Prefer current working directory (or its parents) if it "looks like" a repo/workspace.
  try {
    let cur = process.cwd();
    if (!cur || !isDirectory(cur)) return "";

    // Walk up a few levels (common: running from apps/connector inside a monorepo root)
    for (let i = 0; i < 6; i++) {
      const hasPkg = fileExists(path.join(cur, "package.json"));
      const hasGit = fileExists(path.join(cur, ".git"));
      const hasSrc = isDirectory(path.join(cur, "src")) || isDirectory(path.join(cur, "apps"));
      if (hasPkg && (hasGit || hasSrc)) return cur;

      const parent = path.dirname(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
    return "";
  } catch {
    return "";
  }
}

function isLikelyRepoWorkspacePath(p) {
  try {
    const s = typeof p === "string" ? p.trim() : "";
    if (!s || !path.isAbsolute(s) || !isDirectory(s)) return false;
    const hasPkg = fileExists(path.join(s, "package.json"));
    const hasGit = fileExists(path.join(s, ".git"));
    const hasSrc = isDirectory(path.join(s, "src")) || isDirectory(path.join(s, "apps"));
    return Boolean(hasPkg && (hasGit || hasSrc));
  } catch {
    return false;
  }
}

async function ensureClaudeTrustAcceptedForPath(projectPath) {
  // Claude Code stores per-project trust in ~/.claude.json under projects[<path>].hasTrustDialogAccepted
  // We set it when the user explicitly picks a workspace for WhatsApp Code mode, so Claude won't block on the trust prompt.
  try {
    const p = typeof projectPath === "string" ? projectPath.trim() : "";
    if (!p || !path.isAbsolute(p) || !isDirectory(p)) return false;

    const home = os.homedir();
    const cfgPath = path.join(home, ".claude.json");
    if (!fileExists(cfgPath)) return false;

    const raw = await fsp.readFile(cfgPath, "utf8").catch(() => "");
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return false;

    if (!parsed.projects || typeof parsed.projects !== "object") parsed.projects = {};
    if (!parsed.projects[p] || typeof parsed.projects[p] !== "object") parsed.projects[p] = {};

    parsed.projects[p].hasTrustDialogAccepted = true;

    // Write atomically (mirror Claude behavior)
    const tmp = `${cfgPath}.tmp.${process.pid}.${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
    await fsp.rename(tmp, cfgPath);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(p) {
  try {
    fs.accessSync(p, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniqueStrings(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const s = String(it);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function hasCommandInPath(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    execFileSync(locator, [String(command || "")], { timeout: 3000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function detectClaudeCliInstalled() {
  const candidates = uniqueStrings([
    process.env.GROOVY_CLAUDE_BIN,
    process.env.CLAUDE_BIN,
    process.env.CLAUDE_CODE_BIN,
    resolveClaudeBin(),
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "claude", "claude.exe")
      : null,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "claude", "claude.cmd")
      : null,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), "bin", "claude"),
  ]);

  for (const candidate of candidates) {
    if (candidate === "claude") continue;
    if (isExecutable(candidate)) return true;
  }
  return hasCommandInPath("claude");
}

function getPtyShellArgs(shellPath) {
  if (process.platform === "win32") {
    const base = path.basename(String(shellPath || "")).toLowerCase();
    if (base.includes("powershell")) return ["-NoLogo"];
    return [];
  }
  return ["-l"];
}

function ensureNodePtySpawnHelperExecutable() {
  try {
    const pkgPath = require.resolve("node-pty/package.json");
    const root = path.dirname(pkgPath);

    const candidates = [
      path.join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      ...(process.platform === "darwin"
        ? [
            path.join(root, "prebuilds", "darwin-arm64", "spawn-helper"),
            path.join(root, "prebuilds", "darwin-x64", "spawn-helper"),
          ]
        : []),
    ];

    for (const helper of uniqueStrings(candidates)) {
      if (!helper || !fs.existsSync(helper)) continue;
      const st = fs.statSync(helper);
      if ((st.mode & 0o111) === 0) {
        fs.chmodSync(helper, 0o755);
        log("fixed node-pty spawn-helper permissions", helper);
      }
    }
  } catch (err) {
    warn(
      "could not ensure node-pty spawn-helper is executable",
      err instanceof Error ? err.message : String(err)
    );
  }
}

function buildSanitizedEnv(safeCwd) {
  const env = { ...process.env };
  const SENSITIVE_KEYS = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "RELAY_JWT_SECRET",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_API_KEY",
  ];
  const SENSITIVE_PATTERNS = /(SECRET|TOKEN|PASSWORD|PRIVATE|ANON_KEY)/i;
  for (const k of Object.keys(env)) {
    if (SENSITIVE_KEYS.includes(k) || SENSITIVE_PATTERNS.test(k)) {
      delete env[k];
    }
  }
  env.PWD = safeCwd;
  return env;
}

function mergeExtraEnv(baseEnv, extraEnv) {
  const out = { ...(baseEnv || {}) };
  if (!extraEnv || typeof extraEnv !== "object") return out;
  const SENSITIVE_KEYS = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "RELAY_JWT_SECRET",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_API_KEY",
  ];
  const SENSITIVE_PATTERNS = /(SECRET|TOKEN|PASSWORD|PRIVATE|ANON_KEY)/i;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (typeof k !== "string" || !k) continue;
    if (SENSITIVE_KEYS.includes(k) || SENSITIVE_PATTERNS.test(k)) continue;
    if (typeof v !== "string") continue;
    // keep env payload small
    if (v.length > 4000) continue;
    out[k] = v;
  }
  return out;
}

async function saveDeviceTokenSecure(deviceToken) {
  try {
    if (keytar && deviceToken) {
      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, String(deviceToken));
      log("stored device_token in keychain");
      return true;
    }
  } catch (e) {
    warn(
      "failed to store device_token in keychain",
      e instanceof Error ? e.message : String(e)
    );
  }
  return false;
}

async function clearDeviceTokenSecure() {
  let cleared = false;
  try {
    if (keytar) {
      const removedCurrent = await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      const removedLegacy = await keytar.deletePassword(LEGACY_KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      if (removedCurrent || removedLegacy) {
        cleared = true;
      }
    }
  } catch (e) {
    warn(
      "failed to clear device_token from keychain",
      e instanceof Error ? e.message : String(e)
    );
  }
  return cleared;
}

async function readDeviceTokenSecure() {
  try {
    if (keytar) {
      const v =
        (await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)) ||
        (await keytar.getPassword(LEGACY_KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT));
      if (v) return v;
    }
  } catch {
    // ignore
  }
  return null;
}

function normalizeUserId(value) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v) return "";
  return UUID_RE.test(v) ? v.toLowerCase() : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// LaunchAgent: auto-start on login (macOS)
// ─────────────────────────────────────────────────────────────────────────────

function getLaunchAgentPlist(relayUrl) {
  // Get path to this script
  const connectorScript = fileURLToPath(import.meta.url);
  const nodeExe = process.execPath;

  const extraArgs =
    arguments.length > 1 && arguments[1] && typeof arguments[1] === "object"
      ? arguments[1]
      : {};
  const whatsappEnabled = extraArgs.whatsappEnabled === true;
  const whatsappGroupName = normalizeCliString(extraArgs.whatsappGroupName || "");
  const whatsappAppUrl = normalizeCliString(extraArgs.whatsappAppUrl || "");

  const programArgs = [
    nodeExe,
    connectorScript,
    "--kill-others",
    "--relay",
    relayUrl,
    ...(whatsappEnabled ? ["--whatsapp"] : []),
    ...(whatsappEnabled && whatsappGroupName ? ["--whatsapp-group", whatsappGroupName] : []),
    ...(whatsappEnabled && whatsappAppUrl ? ["--app-url", whatsappAppUrl] : []),
  ];

  const programArgsXml = programArgs
    .map((s) => `    <string>${String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${os.homedir()}/.groovy/connector.log</string>
  <key>StandardErrorPath</key>
  <string>${os.homedir()}/.groovy/connector.log</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
}

async function installLaunchAgent(relayUrl, extraArgs = {}) {
  if (process.platform !== "darwin") return false;

  try {
    const dir = path.dirname(LAUNCH_AGENT_PATH);
    await fsp.mkdir(dir, { recursive: true });

    const plist = getLaunchAgentPlist(relayUrl, extraArgs);
    // Only rewrite/reload if content changed (keeps updates safe + idempotent).
    let prev = "";
    try {
      prev = await fsp.readFile(LAUNCH_AGENT_PATH, "utf8");
    } catch {
      // ignore
    }
    if (prev !== plist) {
      await fsp.writeFile(LAUNCH_AGENT_PATH, plist, "utf8");
      log(prev ? "updated LaunchAgent at" : "installed LaunchAgent at", LAUNCH_AGENT_PATH);
    } else {
      log("LaunchAgent already up to date at", LAUNCH_AGENT_PATH);
      return true;
    }

    // Load the agent
    try {
      await execFileAsync("launchctl", ["unload", LAUNCH_AGENT_PATH]);
    } catch {
      // ignore if not loaded
    }
    await execFileAsync("launchctl", ["load", LAUNCH_AGENT_PATH]);
    log("loaded LaunchAgent - connector will now start automatically on login");

    return true;
  } catch (err) {
    warn(
      "failed to install LaunchAgent",
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kill other Groovy Connector instances (ensures clean update)
// ─────────────────────────────────────────────────────────────────────────────

async function killOtherInstances() {
  const myPid = process.pid;
  const result = await killProcessesByCommandFragment("connector.mjs", { excludePid: myPid });
  if (result.killed > 0) {
    log(`found ${result.matched} other connector instance(s), terminated ${result.killed}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function buildRestartArgs() {
  // Self-heal on restart: force new instance to take lock ownership and
  // terminate stale competing connector processes if needed.
  // Also strip WhatsApp CLI flags so restart behavior follows persisted config
  // (important for Kapso/company mode where personal WhatsApp is disabled),
  // and strip Aiyra voice CLI flags so persisted runtime settings are source of truth.
  const argv = process.argv.slice(2);
  const base = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || "");
    if (!arg) continue;
    if (arg === "--kill-others") continue;
    if (arg === "--whatsapp" || arg === "--whatsapp-web") continue;
    if (arg.startsWith("--whatsapp-group=") || arg.startsWith("--app-url=")) continue;
    if (arg === "--whatsapp-group" || arg === "--app-url") {
      i += 1; // skip value token
      continue;
    }
    if (arg === "--aiyra-voice") continue;
    if (
      arg.startsWith("--aiyra-wake-word=") ||
      arg.startsWith("--aiyra-app-url=") ||
      arg.startsWith("--aiyra-keyword-path=") ||
      arg.startsWith("--aiyra-wake-sensitivity=") ||
      arg.startsWith("--aiyra-idle-timeout-ms=") ||
      arg.startsWith("--aiyra-wake-engine=") ||
      arg.startsWith("--aiyra-openwakeword-threshold=") ||
      arg.startsWith("--aiyra-openwakeword-model-path=") ||
      arg.startsWith("--aiyra-openwakeword-python=") ||
      arg.startsWith("--aiyra-openwakeword-script-path=") ||
      arg.startsWith("--aiyra-openwakeword-allow-approximate=") ||
      arg.startsWith("--aiyra-device-index=")
    ) {
      continue;
    }
    if (
      arg === "--aiyra-wake-word" ||
      arg === "--aiyra-app-url" ||
      arg === "--aiyra-keyword-path" ||
      arg === "--aiyra-wake-sensitivity" ||
      arg === "--aiyra-idle-timeout-ms" ||
      arg === "--aiyra-wake-engine" ||
      arg === "--aiyra-openwakeword-threshold" ||
      arg === "--aiyra-openwakeword-model-path" ||
      arg === "--aiyra-openwakeword-python" ||
      arg === "--aiyra-openwakeword-script-path" ||
      arg === "--aiyra-openwakeword-allow-approximate" ||
      arg === "--aiyra-device-index"
    ) {
      i += 1;
      continue;
    }
    base.push(arg);
  }
  return [...base, "--kill-others"];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main with auto-reconnect
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // Ensure a single running instance (prevents launchd/manual run flapping).
  const ok = await ensureSingleInstance({ killOthers: hasFlag("--kill-others") });
  if (!ok) return;
  
  // Optional: allow an installer/updater to kill older instances explicitly.
  if (hasFlag("--kill-others")) {
    await killOtherInstances();
  }

  let cfg = await readConfig();

  const relayUrl =
    argValue("--relay") ||
    cfg.relay_url ||
    process.env.GROOVY_RELAY_URL ||
    "wss://groovy-relay.fly.dev";
  let pairingCode = argValue("--pair");
  const deviceName = argValue("--device-name") || cfg.device_name || os.hostname();
  const noAutoStartFlag = hasFlag("--no-autostart");
  const noAutoStartEnv =
    process.env.GROOVY_NO_AUTOSTART === "1" ||
    process.env.GROOVY_CONNECTOR_NO_AUTOSTART === "1";
  const noAutoStart = noAutoStartFlag || noAutoStartEnv;
  const allowUnboundStoredToken =
    hasFlag("--allow-unbound-token") ||
    process.env.GROOVY_ALLOW_UNBOUND_DEVICE_TOKEN === "1";

  const forceRePair = hasFlag("--reset");
  const allowAccountSwitch =
    forceRePair ||
    hasFlag("--allow-account-switch") ||
    process.env.GROOVY_ALLOW_ACCOUNT_SWITCH === "1";
  let deviceToken = !forceRePair ? cfg.device_token : null;
  if (!deviceToken && !pairingCode) {
    deviceToken = await readDeviceTokenSecure();
  }
  const pairedUserId = normalizeUserId(cfg.paired_user_id);
  if (deviceToken && !pairingCode && !pairedUserId && !allowUnboundStoredToken) {
    warn(
      "stored device_token exists but connector is not account-bound; forcing explicit re-pair to prevent wrong-account auth"
    );
    await clearDeviceTokenSecure();
    const nextCfg = { ...cfg };
    delete nextCfg.device_token;
    delete nextCfg.paired_user_id;
    await writeConfig(nextCfg);
    cfg = nextCfg;
    deviceToken = null;
    activeDeviceToken = null;
  }
  // Set module-level token for scheduler API calls
  if (deviceToken) activeDeviceToken = deviceToken;

  const whatsappFlag = hasFlag("--whatsapp") || hasFlag("--whatsapp-web");
  const { enabled: whatsappEnabled, groupName: whatsappGroupName, appUrl: whatsappAppUrl } =
    resolveWhatsAppRuntimeConfig(cfg);
  applySchedulerWhatsAppRuntimeConfig({
    enabled: whatsappEnabled,
    groupName: whatsappGroupName,
    appUrl: whatsappAppUrl,
  });

  const aiyraVoiceFlag = hasFlag("--aiyra-voice");
  const resolveAiyraRuntimeConfig = () => {
    const wakeSensitivity = normalizeClampedNumber(
      argValue("--aiyra-wake-sensitivity") ||
        process.env.AIYRA_WAKE_SENSITIVITY ||
        cfg.aiyra_wake_sensitivity,
      0.5,
      0,
      1
    );
    const explicitOpenWakewordThresholdRaw =
      argValue("--aiyra-openwakeword-threshold") ||
      process.env.AIYRA_OPENWAKEWORD_THRESHOLD;
    const storedOpenWakewordThresholdRaw = cfg.aiyra_openwakeword_threshold;
    const hasExplicitOpenWakewordThreshold =
      explicitOpenWakewordThresholdRaw !== null &&
      String(explicitOpenWakewordThresholdRaw).trim() !== "";
    const hasStoredOpenWakewordThreshold =
      storedOpenWakewordThresholdRaw !== null &&
      String(storedOpenWakewordThresholdRaw).trim() !== "";
    const cliMicMode = normalizeAiyraMicMode(argValue("--aiyra-mic-mode"), "");
    const envMicMode = normalizeAiyraMicMode(process.env.AIYRA_MIC_MODE, "");
    const cliMicName = normalizeAiyraMicName(argValue("--aiyra-mic-name"));
    const envMicName = normalizeAiyraMicName(process.env.AIYRA_MIC_NAME);
    const micSelectionSource =
      cliMicMode || cliMicName
        ? "cli"
        : envMicMode || envMicName
          ? "env"
          : "config";
    const openWakewordThreshold =
      hasExplicitOpenWakewordThreshold
        ? normalizeClampedNumber(
            explicitOpenWakewordThresholdRaw,
            DEFAULT_OPENWAKEWORD_THRESHOLD,
            0,
            1
          )
        : hasStoredOpenWakewordThreshold
          ? normalizeClampedNumber(
              storedOpenWakewordThresholdRaw,
              DEFAULT_OPENWAKEWORD_THRESHOLD,
              0,
              1
            )
          : DEFAULT_OPENWAKEWORD_THRESHOLD;
    const micSelection = resolveAiyraMicSelection({
      micMode: cliMicMode || envMicMode || cfg.aiyra_mic_mode,
      micName: cliMicName || envMicName || cfg.aiyra_mic_name,
      legacyDeviceIndex:
        argValue("--aiyra-device-index") ||
        process.env.AIYRA_DEVICE_INDEX ||
        cfg.aiyra_device_index,
    });
    const persistedMicMode =
      micSelectionSource === "config"
        ? micSelection.micMode
        : normalizeAiyraMicMode(cfg.aiyra_mic_mode, "");
    const persistedMicName =
      micSelectionSource === "config"
        ? micSelection.micName
        : normalizeAiyraMicName(cfg.aiyra_mic_name);

    return {
      enabled:
        cfg.aiyra_voice_enabled === true ||
        (aiyraVoiceFlag && cfg.aiyra_voice_enabled !== false),
      appUrl:
        normalizeCliString(argValue("--aiyra-app-url")) ||
        normalizeCliString(process.env.AIYRA_APP_URL) ||
        normalizeCliString(cfg.aiyra_app_url) ||
        whatsappAppUrl ||
        "",
      wakeWord:
        normalizeCliString(argValue("--aiyra-wake-word")) ||
        normalizeCliString(process.env.AIYRA_WAKE_WORD) ||
        normalizeCliString(cfg.aiyra_wake_word) ||
        "hey groovy",
      wakeSensitivity,
      idleTimeoutMs: normalizeIntegerRange(
        argValue("--aiyra-idle-timeout-ms") ||
          process.env.AIYRA_IDLE_TIMEOUT_MS ||
          cfg.aiyra_idle_timeout_ms,
        12000,
        2000,
        120000
      ),
      keywordPath:
        normalizePathString(argValue("--aiyra-keyword-path")) ||
        normalizePathString(
          process.env.AIYRA_WAKEWORD_PPN_PATH || cfg.aiyra_wakeword_ppn_path || ""
        ),
      wakeEngine:
        normalizeCliString(argValue("--aiyra-wake-engine")) ||
        normalizeCliString(process.env.AIYRA_WAKE_ENGINE) ||
        normalizeCliString(cfg.aiyra_wake_engine) ||
        "openwakeword",
      openWakewordThreshold,
      openWakewordModelPath:
        normalizePathString(argValue("--aiyra-openwakeword-model-path")) ||
        normalizePathString(
          process.env.AIYRA_OPENWAKEWORD_MODEL_PATH ||
            cfg.aiyra_openwakeword_model_path ||
            ""
        ),
      openWakewordPython:
        normalizeCliString(argValue("--aiyra-openwakeword-python")) ||
        normalizeCliString(process.env.AIYRA_OPENWAKEWORD_PYTHON) ||
        normalizeCliString(cfg.aiyra_openwakeword_python) ||
        "",
      openWakewordScriptPath:
        normalizePathString(argValue("--aiyra-openwakeword-script-path")) ||
        normalizePathString(
          process.env.AIYRA_OPENWAKEWORD_SCRIPT_PATH ||
            cfg.aiyra_openwakeword_script_path ||
            ""
        ),
      openWakewordAllowApproximate: normalizeBoolean(
        argValue("--aiyra-openwakeword-allow-approximate") ||
          process.env.AIYRA_OPENWAKEWORD_ALLOW_APPROXIMATE ||
          cfg.aiyra_openwakeword_allow_approximate,
        DEFAULT_OPENWAKEWORD_ALLOW_APPROXIMATE
      ),
      aecEnabled: normalizeBoolean(
        argValue("--aiyra-aec-enabled") ||
          process.env.AIYRA_AEC_ENABLED ||
          cfg.aiyra_aec_enabled,
        true
      ),
      aecBackend: normalizeAiyraAecBackend(
        argValue("--aiyra-aec-backend") ||
          process.env.AIYRA_AEC_BACKEND ||
          cfg.aiyra_aec_backend,
        "webrtc"
      ),
      deviceIndex: micSelection.resolvedDeviceIndex,
      micMode: micSelection.micMode,
      micName: micSelection.micName,
      persistedMicMode,
      persistedMicName,
      micSelectionSource,
      resolvedDeviceName: micSelection.resolvedDeviceName,
      micSelectionFallbackReason: micSelection.fallbackReason,
      audioDevices: micSelection.devices,
    };
  };
  let {
    enabled: aiyraVoiceEnabled,
    appUrl: aiyraAppUrl,
    wakeWord: aiyraWakeWord,
    wakeSensitivity: aiyraWakeSensitivity,
    idleTimeoutMs: aiyraIdleTimeoutMs,
    keywordPath: aiyraKeywordPath,
    wakeEngine: aiyraWakeEngine,
    openWakewordThreshold: aiyraOpenWakewordThreshold,
    openWakewordModelPath: aiyraOpenWakewordModelPath,
    openWakewordPython: aiyraOpenWakewordPython,
    openWakewordScriptPath: aiyraOpenWakewordScriptPath,
    openWakewordAllowApproximate: aiyraOpenWakewordAllowApproximate,
    aecEnabled: aiyraAecEnabled,
    aecBackend: aiyraAecBackend,
    deviceIndex: aiyraDeviceIndex,
    micMode: aiyraMicMode,
    micName: aiyraMicName,
    persistedMicMode: aiyraPersistedMicMode,
    persistedMicName: aiyraPersistedMicName,
    micSelectionSource: aiyraMicSelectionSource,
    resolvedDeviceName: aiyraResolvedDeviceName,
    micSelectionFallbackReason: aiyraMicSelectionFallbackReason,
  } = resolveAiyraRuntimeConfig();
  const applyResolvedAiyraRuntimeConfig = (nextAiyraConfig) => {
    aiyraVoiceEnabled = nextAiyraConfig.enabled;
    aiyraAppUrl = nextAiyraConfig.appUrl;
    aiyraWakeWord = nextAiyraConfig.wakeWord;
    aiyraWakeSensitivity = nextAiyraConfig.wakeSensitivity;
    aiyraIdleTimeoutMs = nextAiyraConfig.idleTimeoutMs;
    aiyraKeywordPath = nextAiyraConfig.keywordPath;
    aiyraWakeEngine = nextAiyraConfig.wakeEngine;
    aiyraOpenWakewordThreshold = nextAiyraConfig.openWakewordThreshold;
    aiyraOpenWakewordModelPath = nextAiyraConfig.openWakewordModelPath;
    aiyraOpenWakewordPython = nextAiyraConfig.openWakewordPython;
    aiyraOpenWakewordScriptPath = nextAiyraConfig.openWakewordScriptPath;
    aiyraOpenWakewordAllowApproximate = nextAiyraConfig.openWakewordAllowApproximate;
    aiyraAecEnabled = nextAiyraConfig.aecEnabled;
    aiyraAecBackend = nextAiyraConfig.aecBackend;
    aiyraDeviceIndex = nextAiyraConfig.deviceIndex;
    aiyraMicMode = nextAiyraConfig.micMode;
    aiyraMicName = nextAiyraConfig.micName;
    aiyraPersistedMicMode = nextAiyraConfig.persistedMicMode;
    aiyraPersistedMicName = nextAiyraConfig.persistedMicName;
    aiyraMicSelectionSource = nextAiyraConfig.micSelectionSource;
    aiyraResolvedDeviceName = nextAiyraConfig.resolvedDeviceName;
    aiyraMicSelectionFallbackReason = nextAiyraConfig.micSelectionFallbackReason;
  };
  const buildAiyraMicSelectionHealthExtra = () => ({
    configured_mic_name: aiyraMicName || null,
    resolved_device_name: aiyraResolvedDeviceName || null,
    mic_selection_fallback_reason: aiyraMicSelectionFallbackReason || null,
  });

  if (whatsappEnabled) {
    noteWhatsAppRecovering("whatsapp_startup_pending", "Waiting for WhatsApp bridge startup");
  } else {
    applyWhatsAppHealthPatch(
      {
        status: "disabled",
        reason: "whatsapp_disabled",
        detail: "WhatsApp bridge disabled in connector config",
        consecutive_failures: 0,
        recent_failures: 0,
        auto_restart_pending: false,
        auto_restart_count: whatsappAutoRestartCount,
      },
      { force: true }
    );
  }

  if (aiyraVoiceEnabled) {
    noteAiyraVoiceRecovering(
      "aiyra_startup_pending",
      "Waiting for connector auth before starting Aiyra runtime",
      {
        wake_word: aiyraWakeWord,
        wake_sensitivity: aiyraWakeSensitivity,
        ...(aiyraWakeEngine === "openwakeword"
          ? { openwakeword_threshold: aiyraOpenWakewordThreshold }
          : {}),
        idle_timeout_ms: aiyraIdleTimeoutMs,
        wake_engine: aiyraWakeEngine,
        aec_enabled: aiyraAecEnabled,
        aec_backend_requested: aiyraAecBackend,
        aec_backend: null,
        aec_status: aiyraAecEnabled ? "pending" : "disabled",
        aec_last_error: null,
        listening: false,
        active: false,
        ...buildAiyraMicSelectionHealthExtra(),
      }
    );
  } else {
    noteAiyraVoiceDisabled("aiyra_voice_disabled", "Aiyra voice runtime disabled in connector config");
  }

  // Set module-level app URL for scheduler API calls
  if (whatsappAppUrl) activeAppUrl = whatsappAppUrl;

  // WhatsApp @code mode (Claude Code via local PTY):
  // Prefer explicit CLI arg, then env, then persisted config, then a repo-heuristic from process.cwd().
  // We pass this through to whatsapp.mjs so LaunchAgent runs don't depend on shell env.
  const codeCwdCli = normalizePathString(argValue("--code-cwd"));
  const codeCwdEnv = normalizePathString(process.env.GROOVY_CODE_CWD || process.env.WHATSAPP_CODE_CWD || "");
  const codeCwdCfg = normalizePathString(cfg.code_cwd || "");
  const codeCwdInferred = inferRepoWorkspaceCwd();
  let codeCwd =
    codeCwdCli ||
    codeCwdEnv ||
    codeCwdCfg ||
    codeCwdInferred ||
    "";

  // If the persisted config points at a non-workspace (common mistake: $HOME), prefer inferred repo root.
  if (codeCwd && codeCwd === codeCwdCfg && !isLikelyRepoWorkspacePath(codeCwd) && codeCwdInferred) {
    codeCwd = codeCwdInferred;
  }

  // Best-effort: if we have a workspace, ensure Claude won't block on trust prompt for it.
  if (codeCwd && isDirectory(codeCwd)) {
    ensureClaudeTrustAcceptedForPath(codeCwd).catch(() => {});
  }
  let whatsappStarted = false;

  // If no token/code, prompt on macOS
  if (!deviceToken && !pairingCode) {
    pairingCode = await promptForPairingCode();
    if (!pairingCode) {
      fatal(
        "missing pairing code (cancelled). Re-open the app and paste your pairing code, or run with --pair <CODE>."
      );
    }
  }

  log("relay:", relayUrl);
  log("device:", deviceName);
  if (pairingCode) log("pairing:", pairingCode);
  if (deviceToken && !pairingCode) {
    log("auth: device_token", {
      bound_user_id: pairedUserId || null,
      strict_binding: !allowUnboundStoredToken,
    });
  }
  if (noAutoStart) {
    const source = noAutoStartFlag
      ? "--no-autostart"
      : process.env.GROOVY_NO_AUTOSTART === "1"
        ? "GROOVY_NO_AUTOSTART=1"
        : "GROOVY_CONNECTOR_NO_AUTOSTART=1";
    log("auto-start install disabled", { source });
  }

  ensureNodePtySpawnHelperExecutable();

  // Reconnect state
  let reconnectAttempts = 0;
  const MAX_RECONNECT_DELAY = 30000;
  let shouldReconnect = true;
  let autoUpdateTimer = null;
  let autoUpdateInProgress = false;
  let autoUpdateLoopStarted = false;
  let connectorRestartRequested = false;
  let aiyraRuntimeStarting = false;
  let aiyraRuntimeRecoveryTimer = null;
  let aiyraRuntimeRecoveryAttempt = 0;
  let aiyraSpecificMicRetryTimer = null;
  let aiyraSpecificMicWatchTimer = null;
  let aiyraActiveRuntimeDeviceName = "";
  let pendingShutdownCleanup = null;

  async function waitForAiyraRuntimeStartToSettle(timeoutMs = 10000) {
    const startedAt = Date.now();
    while (aiyraRuntimeStarting && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !aiyraRuntimeStarting;
  }

  async function clearStoredConnectorAuth(reason = "auth_reset") {
    await stopAiyraVoiceRuntime(reason).catch(() => {});
    await clearDeviceTokenSecure().catch(() => {});

    const nextCfg = { ...cfg };
    delete nextCfg.device_token;
    delete nextCfg.paired_user_id;

    cfg = nextCfg;
    deviceToken = null;
    pairingCode = null;
    activeDeviceToken = null;

    try {
      await writeConfig(nextCfg);
    } catch (e) {
      warn(
        "failed to persist cleared connector auth",
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  async function handleRelayAuthOrPairingError(rawError) {
    const errorText = typeof rawError === "string" ? rawError.trim() : String(rawError || "");
    const errorCode = errorText.toLowerCase();
    if (!errorCode) return false;

    const storedTokenRejected =
      !pairingCode &&
      !!deviceToken &&
      (errorCode === "invalid_device_token" ||
        errorCode === "device_token_user_mismatch" ||
        errorCode.includes("invalid device token"));

    if (storedTokenRejected) {
      shouldReconnect = false;
      pendingShutdownCleanup = clearStoredConnectorAuth(errorCode);
      try {
        await pendingShutdownCleanup;
      } catch (e) {
        warn("connector auth cleanup failed", e instanceof Error ? e.message : String(e));
      }
      warn(
        "stored connector auth was rejected by relay; cleared saved auth. Generate a new pairing code and relaunch the connector.",
        { error: errorText }
      );
      return true;
    }

    const pairingRejected =
      !!pairingCode &&
      (errorCode.includes("invalid pairing code") ||
        errorCode.includes("already used") ||
        errorCode.includes("pairing code expired"));

    if (pairingRejected) {
      shouldReconnect = false;
      pairingCode = null;
      warn(
        "pairing failed; stopping reconnect loop. Generate a new pairing code and relaunch the connector.",
        { error: errorText }
      );
      return true;
    }

    return false;
  }

  function stopAutoUpdateLoop() {
    if (autoUpdateTimer) {
      clearTimeout(autoUpdateTimer);
      autoUpdateTimer = null;
    }
  }

  function handoffToUpdatedProcess() {
    shouldReconnect = false;
    try {
      activeRelayWs?.close();
    } catch {
      // ignore
    }
    setTimeout(async () => {
      await releaseSingleInstanceLock();
      process.exit(0);
    }, 250);
  }

  function requestProcessRestart(reason = "manual_restart") {
    if (connectorRestartRequested) {
      log("connector restart already in progress", { reason });
      return false;
    }
    connectorRestartRequested = true;
    log("connector restart requested", { reason });
    shouldReconnect = false;
    try {
      activeRelayWs?.close();
    } catch {
      // ignore
    }

    setTimeout(async () => {
      await stopAiyraVoiceRuntime(reason).catch(() => {});
      await releaseSingleInstanceLock();
      const scriptPath = new URL(import.meta.url).pathname;
      const restartArgs = buildRestartArgs();
      const child = spawn(process.execPath, [scriptPath, ...restartArgs], {
        detached: true,
        stdio: "ignore",
        cwd: process.cwd(),
        env: process.env,
      });
      child.unref();

      log("new instance spawned, exiting...", { reason });
      process.exit(0);
    }, 200);
    return true;
  }

  requestConnectorProcessRestart = requestProcessRestart;

  function clearAiyraSpecificMicRetryTimer() {
    if (!aiyraSpecificMicRetryTimer) return;
    clearTimeout(aiyraSpecificMicRetryTimer);
    aiyraSpecificMicRetryTimer = null;
  }

  function clearAiyraSpecificMicWatchTimer() {
    if (!aiyraSpecificMicWatchTimer) return;
    clearTimeout(aiyraSpecificMicWatchTimer);
    aiyraSpecificMicWatchTimer = null;
  }

  function clearAiyraRuntimeRecoveryTimer({ resetAttempt = false } = {}) {
    if (aiyraRuntimeRecoveryTimer) {
      clearTimeout(aiyraRuntimeRecoveryTimer);
      aiyraRuntimeRecoveryTimer = null;
    }
    if (resetAttempt) {
      aiyraRuntimeRecoveryAttempt = 0;
    }
  }

  function canAutoRecoverAiyraRuntime() {
    if (!aiyraVoiceEnabled || !deviceToken || !aiyraAppUrl) {
      return false;
    }
    if (
      aiyraMicMode === "specific" &&
      aiyraMicName &&
      aiyraMicSelectionFallbackReason === "specific_device_missing"
    ) {
      return false;
    }
    return true;
  }

  function scheduleAiyraRuntimeRecovery(reason = "runtime_failed", detail = "") {
    if (!canAutoRecoverAiyraRuntime() || aiyraRuntimeRecoveryTimer) {
      return !!aiyraRuntimeRecoveryTimer;
    }
    const nextAttempt = Math.max(1, aiyraRuntimeRecoveryAttempt + 1);
    aiyraRuntimeRecoveryAttempt = nextAttempt;
    const delayMs = Math.min(
      AIYRA_RUNTIME_RECOVERY_MAX_DELAY_MS,
      AIYRA_RUNTIME_RECOVERY_BASE_DELAY_MS * Math.pow(2, nextAttempt - 1)
    );
    const recoveryDetail = detail
      ? `Aiyra runtime failed (${reason}): ${detail}. Retrying automatically.`
      : `Aiyra runtime failed (${reason}). Retrying automatically.`;
    log("aiyra runtime recovery scheduled", {
      reason,
      detail: detail || null,
      attempt: nextAttempt,
      delay_ms: delayMs,
      configuredMicName: aiyraMicName || null,
      activeRuntimeDeviceName: aiyraActiveRuntimeDeviceName || null,
    });
    noteAiyraVoiceRecovering("aiyra_runtime_recovery_scheduled", recoveryDetail, {
      listening: false,
      active: false,
      muted: false,
      mic_input_level: 0,
      mic_input_updated_at: null,
      recovery_attempt: nextAttempt,
      recovery_delay_ms: delayMs,
      ...buildAiyraMicSelectionHealthExtra(),
    });
    aiyraRuntimeRecoveryTimer = setTimeout(() => {
      aiyraRuntimeRecoveryTimer = null;
      (async () => {
        if (!canAutoRecoverAiyraRuntime()) return;
        if (aiyraVoiceRuntime) {
          await stopAiyraVoiceRuntime("runtime_recovery");
        }
        const started = await maybeStartAiyraVoiceRuntime();
        if (!started && canAutoRecoverAiyraRuntime() && !aiyraSpecificMicRetryTimer) {
          scheduleAiyraRuntimeRecovery(reason, detail);
        }
      })().catch((e) => {
        warn(
          "failed to recover Aiyra voice runtime",
          e instanceof Error ? e.message : String(e)
        );
        if (canAutoRecoverAiyraRuntime() && !aiyraSpecificMicRetryTimer) {
          scheduleAiyraRuntimeRecovery(
            "runtime_recovery_failed",
            e instanceof Error ? e.message : String(e)
          );
        }
      });
    }, delayMs);
    return true;
  }

  async function maybeReconcileAiyraSpecificMicBinding(trigger = "periodic_check") {
    if (
      !aiyraVoiceRuntime ||
      aiyraRuntimeStarting ||
      aiyraMicMode !== "specific" ||
      !aiyraMicName
    ) {
      return false;
    }

    let nextAiyraConfig = resolveAiyraRuntimeConfig();
    const configuredMicKey = normalizeAiyraMicNameLooseKey(nextAiyraConfig.micName);

    applyResolvedAiyraRuntimeConfig(nextAiyraConfig);

    if (!configuredMicKey) return false;

    if (nextAiyraConfig.micSelectionFallbackReason === "specific_device_missing") {
      const { matchedDevice, waitedMs } = await waitForSpecificAiyraMicAvailability(
        aiyraMicName,
        {
          timeoutMs: 1500,
          pollMs: 250,
        }
      );
      if (matchedDevice) {
        log("selected Aiyra microphone recovered before runtime stop", {
          trigger,
          configuredMicName: nextAiyraConfig.micName || null,
          matchedDeviceName: matchedDevice.name,
          waited_ms: waitedMs,
        });
        nextAiyraConfig = resolveAiyraRuntimeConfig();
        applyResolvedAiyraRuntimeConfig(nextAiyraConfig);
      }
    }

    if (nextAiyraConfig.micSelectionFallbackReason === "specific_device_missing") {
      const previousRuntimeDeviceName = aiyraActiveRuntimeDeviceName || null;
      log("selected Aiyra microphone became unavailable during active runtime", {
        trigger,
        configuredMicName: nextAiyraConfig.micName || null,
        activeRuntimeDeviceName: previousRuntimeDeviceName,
      });
      await stopAiyraVoiceRuntime("selected_mic_missing");
      noteAiyraVoiceDegraded(
        "aiyra_selected_mic_missing",
        `Selected microphone "${aiyraMicName}" is unavailable. Waiting for it to reconnect instead of listening on "${previousRuntimeDeviceName || "another microphone"}".`,
        {
          listening: false,
          active: false,
          muted: false,
          mic_input_level: 0,
          mic_input_updated_at: null,
          ...buildAiyraMicSelectionHealthExtra(),
        }
      );
      scheduleAiyraSpecificMicRetry("selected_mic_missing");
      return true;
    }

    const resolvedMicKey = normalizeAiyraMicNameLooseKey(
      nextAiyraConfig.resolvedDeviceName
    );
    const activeMicKey = normalizeAiyraMicNameLooseKey(aiyraActiveRuntimeDeviceName);
    const resolvedMatchesConfigured = !!resolvedMicKey && resolvedMicKey === configuredMicKey;
    const activeMatchesConfigured = !!activeMicKey && activeMicKey === configuredMicKey;
    if (resolvedMatchesConfigured && !activeMatchesConfigured) {
      if (aiyraVoiceHealthState?.active === true) {
        log("selected Aiyra microphone recovered during active session; deferring restart", {
          trigger,
          configuredMicName: nextAiyraConfig.micName || null,
          activeRuntimeDeviceName: aiyraActiveRuntimeDeviceName || null,
          nextResolvedDeviceName: nextAiyraConfig.resolvedDeviceName || null,
        });
        return false;
      }
      log("selected Aiyra microphone recovered; restarting runtime on desired mic", {
        trigger,
        configuredMicName: nextAiyraConfig.micName || null,
        activeRuntimeDeviceName: aiyraActiveRuntimeDeviceName || null,
        nextResolvedDeviceName: nextAiyraConfig.resolvedDeviceName || null,
      });
      await stopAiyraVoiceRuntime("selected_mic_recovered");
      return await maybeStartAiyraVoiceRuntime();
    }

    return false;
  }

  function scheduleAiyraSpecificMicWatch(reason = "specific_mic_monitor", delayMs = 3000) {
    if (
      aiyraSpecificMicWatchTimer ||
      !aiyraVoiceRuntime ||
      aiyraRuntimeStarting ||
      aiyraMicMode !== "specific" ||
      !aiyraMicName
    ) {
      return;
    }
    const normalizedDelayMs = Math.max(1000, Math.trunc(Number(delayMs) || 3000));
    aiyraSpecificMicWatchTimer = setTimeout(() => {
      aiyraSpecificMicWatchTimer = null;
      maybeReconcileAiyraSpecificMicBinding(reason)
        .catch((e) => {
          warn(
            "failed to reconcile Aiyra specific microphone binding",
            e instanceof Error ? e.message : String(e)
          );
        })
        .finally(() => {
          if (
            aiyraVoiceRuntime &&
            !aiyraRuntimeStarting &&
            aiyraMicMode === "specific" &&
            aiyraMicName
          ) {
            scheduleAiyraSpecificMicWatch(reason, normalizedDelayMs);
          }
        });
    }, normalizedDelayMs);
  }

  function scheduleAiyraSpecificMicRetry(reason = "selected_mic_missing", delayMs = 3000) {
    if (aiyraSpecificMicRetryTimer || !aiyraVoiceEnabled || aiyraVoiceRuntime) {
      return;
    }
    const normalizedDelayMs = Math.max(500, Math.trunc(Number(delayMs) || 3000));
    log("aiyra specific mic retry scheduled", {
      reason,
      delay_ms: normalizedDelayMs,
      configuredMicName: aiyraMicName || null,
    });
    aiyraSpecificMicRetryTimer = setTimeout(() => {
      aiyraSpecificMicRetryTimer = null;
      maybeStartAiyraVoiceRuntime().catch((e) => {
        warn(
          "failed to restart Aiyra voice runtime while waiting for selected microphone",
          e instanceof Error ? e.message : String(e)
        );
      });
    }, normalizedDelayMs);
  }

  async function stopAiyraVoiceRuntime(reason = "stopped") {
    clearAiyraRuntimeRecoveryTimer();
    clearAiyraSpecificMicRetryTimer();
    clearAiyraSpecificMicWatchTimer();
    if (!aiyraVoiceRuntime) return;
    const runtime = aiyraVoiceRuntime;
    aiyraVoiceRuntime = null;
    aiyraActiveRuntimeDeviceName = "";
    try {
      await runtime.stop();
    } catch (e) {
      warn("aiyra voice runtime stop failed", e instanceof Error ? e.message : String(e));
    }
    noteAiyraVoiceDisabled("aiyra_voice_stopped", `Aiyra voice runtime stopped (${reason})`);
  }

  async function maybeStartAiyraVoiceRuntime() {
    applyResolvedAiyraRuntimeConfig(resolveAiyraRuntimeConfig());
    if (!aiyraVoiceEnabled) {
      noteAiyraVoiceDisabled("aiyra_voice_disabled", "Aiyra voice runtime disabled in connector config");
      return false;
    }
    if (aiyraVoiceRuntime || aiyraRuntimeStarting) {
      return true;
    }
    if (!deviceToken) {
      noteAiyraVoiceDegraded(
        "aiyra_missing_device_token",
        "Cannot start Aiyra voice runtime before connector authentication"
      );
      return false;
    }
    if (!aiyraAppUrl) {
      noteAiyraVoiceDegraded(
        "aiyra_missing_app_url",
        "Set AIYRA_APP_URL or aiyra_app_url before enabling Aiyra voice"
      );
      return false;
    }

    clearAiyraSpecificMicRetryTimer();
    if (
      aiyraMicMode === "specific" &&
      aiyraMicName &&
      aiyraMicSelectionFallbackReason === "specific_device_missing"
    ) {
      noteAiyraVoiceRecovering(
        "aiyra_waiting_for_selected_mic",
        `Waiting for "${aiyraMicName}" to become available before starting voice.`,
        {
          listening: false,
          active: false,
          muted: false,
          mic_input_level: 0,
          mic_input_updated_at: null,
          ...buildAiyraMicSelectionHealthExtra(),
        }
      );
      const { matchedDevice, waitedMs } = await waitForSpecificAiyraMicAvailability(
        aiyraMicName,
        {
          timeoutMs: 7000,
          pollMs: 250,
        }
      );
      if (matchedDevice) {
        log("aiyra selected microphone became available", {
          configuredMicName: aiyraMicName,
          matchedDeviceName: matchedDevice.name,
          waited_ms: waitedMs,
        });
      }
      applyResolvedAiyraRuntimeConfig(resolveAiyraRuntimeConfig());
      if (
        aiyraMicMode === "specific" &&
        aiyraMicName &&
        aiyraMicSelectionFallbackReason === "specific_device_missing"
      ) {
        noteAiyraVoiceDegraded(
          "aiyra_selected_mic_missing",
          `Selected microphone "${aiyraMicName}" is unavailable. Waiting for it to reconnect instead of falling back to "${aiyraResolvedDeviceName || "another microphone"}".`,
          {
            listening: false,
            active: false,
            muted: false,
            mic_input_level: 0,
            mic_input_updated_at: null,
            ...buildAiyraMicSelectionHealthExtra(),
          }
        );
        scheduleAiyraSpecificMicRetry("selected_mic_missing");
        return false;
      }
    }

    aiyraRuntimeStarting = true;
    noteAiyraVoiceRecovering(
      "aiyra_runtime_starting",
      "Starting native Aiyra wake-word runtime",
      {
        wake_word: aiyraWakeWord,
        wake_sensitivity: aiyraWakeSensitivity,
        ...(aiyraWakeEngine === "openwakeword"
          ? { openwakeword_threshold: aiyraOpenWakewordThreshold }
          : {}),
        idle_timeout_ms: aiyraIdleTimeoutMs,
        aec_enabled: aiyraAecEnabled,
        aec_backend_requested: aiyraAecBackend,
        aec_backend: null,
        aec_status: aiyraAecEnabled ? "starting" : "disabled",
        aec_last_error: null,
        listening: false,
        active: false,
        mic_input_level: 0,
        mic_input_updated_at: null,
        ...buildAiyraMicSelectionHealthExtra(),
      }
    );
    try {
      log("aiyra microphone selection", {
        micMode: aiyraMicMode,
        micName: aiyraMicName || null,
        resolvedDeviceName: aiyraResolvedDeviceName || null,
        resolvedDeviceIndex: aiyraDeviceIndex,
        fallbackReason: aiyraMicSelectionFallbackReason || null,
      });
      log("starting Aiyra voice runtime internals", {
        wakeWord: aiyraWakeWord,
        wakeEngine: aiyraWakeEngine,
        appUrl: aiyraAppUrl || null,
        resolvedDeviceName: aiyraResolvedDeviceName || null,
        resolvedDeviceIndex: aiyraDeviceIndex,
      });
      const buildAiyraVoiceHealthExtra = (event) => {
        const isLowMicGainEvent =
          event?.low_mic_gain_detected === true ||
          (typeof event?.reason === "string" &&
            event.reason.trim().toLowerCase() === "aiyra_low_mic_gain");
        const lowMicGainDetected =
          isLowMicGainEvent
            ? true
            : event?.low_mic_gain_detected === false
              ? false
              : false;
        const lowMicGainAt =
          typeof event?.low_mic_gain_at === "string" &&
          event.low_mic_gain_at.trim() &&
          isLowMicGainEvent
            ? event.low_mic_gain_at.trim()
            : null;
        const lowMicGainMessage =
          typeof event?.low_mic_gain_message === "string"
          && isLowMicGainEvent
            ? event.low_mic_gain_message.trim() || null
            : null;
        const maxEnergyObserved = Number(event?.low_mic_gain_max_energy_observed);
        const lowMicGainThreshold = Number(event?.low_mic_gain_threshold);
        const aecEnabled =
          typeof event?.aec_enabled === "boolean" ? event.aec_enabled : undefined;
        const aecBackendRequested =
          typeof event?.aec_backend_requested === "string" &&
          event.aec_backend_requested.trim()
            ? normalizeAiyraAecBackend(event.aec_backend_requested, aiyraAecBackend)
            : undefined;
        const aecBackend =
          typeof event?.aec_backend === "string" && event.aec_backend.trim()
            ? normalizeAiyraAecBackend(event.aec_backend, aiyraAecBackend)
            : undefined;
        const aecStatus =
          typeof event?.aec_status === "string" && event.aec_status.trim()
            ? event.aec_status.trim()
            : undefined;
        const aecLastError =
          typeof event?.aec_last_error === "string"
            ? event.aec_last_error.trim() || null
            : undefined;
        const hasConversationId = Object.prototype.hasOwnProperty.call(
          event || {},
          "conversation_id"
        );
        const conversationId =
          typeof event?.conversation_id === "string"
            ? event.conversation_id.trim() || null
            : hasConversationId
              ? null
              : undefined;
        const hasOrchestratorSessionId = Object.prototype.hasOwnProperty.call(
          event || {},
          "orchestrator_session_id"
        );
        const orchestratorSessionId =
          typeof event?.orchestrator_session_id === "string"
            ? event.orchestrator_session_id.trim() || null
            : hasOrchestratorSessionId
              ? null
              : undefined;
        const hasTwilioSupervisorState = Object.prototype.hasOwnProperty.call(
          event || {},
          "twilio_supervisor_state"
        );
        const twilioSupervisorState =
          hasTwilioSupervisorState &&
          event?.twilio_supervisor_state &&
          typeof event.twilio_supervisor_state === "object" &&
          !Array.isArray(event.twilio_supervisor_state)
            ? event.twilio_supervisor_state
            : hasTwilioSupervisorState
              ? null
              : undefined;
        const resolvedWakeEngine =
          typeof event?.wake_engine === "string" && event.wake_engine.trim()
            ? event.wake_engine.trim()
            : aiyraWakeEngine;
        const resolvedOpenWakewordThreshold = Number.isFinite(
          Number(event?.openwakeword_threshold)
        )
          ? Number(event.openwakeword_threshold)
          : resolvedWakeEngine === "openwakeword"
            ? aiyraOpenWakewordThreshold
            : null;
        return {
          ...(typeof event?.listening === "boolean"
            ? { listening: event.listening }
            : {}),
          ...(typeof event?.active === "boolean" ? { active: event.active } : {}),
          ...(typeof event?.muted === "boolean" ? { muted: event.muted } : {}),
          wake_word:
            typeof event?.wake_word === "string" && event.wake_word.trim()
              ? event.wake_word.trim()
              : aiyraWakeWord,
          wake_sensitivity:
            Number.isFinite(Number(event?.wake_sensitivity))
              ? Number(event.wake_sensitivity)
              : aiyraWakeSensitivity,
          ...(resolvedOpenWakewordThreshold !== null
            ? { openwakeword_threshold: resolvedOpenWakewordThreshold }
            : {}),
          idle_timeout_ms:
            Number.isFinite(Number(event?.idle_timeout_ms))
              ? Number(event.idle_timeout_ms)
              : aiyraIdleTimeoutMs,
          wake_engine: resolvedWakeEngine,
          low_mic_gain_detected: lowMicGainDetected,
          low_mic_gain_at: lowMicGainAt,
          low_mic_gain_message: lowMicGainMessage,
          ...(Number.isFinite(maxEnergyObserved)
            && isLowMicGainEvent
            ? { low_mic_gain_max_energy_observed: maxEnergyObserved }
            : !isLowMicGainEvent
              ? { low_mic_gain_max_energy_observed: null }
              : {}),
          ...(Number.isFinite(lowMicGainThreshold)
            && isLowMicGainEvent
            ? { low_mic_gain_threshold: lowMicGainThreshold }
            : !isLowMicGainEvent
              ? { low_mic_gain_threshold: null }
              : {}),
          ...(aecEnabled !== undefined ? { aec_enabled: aecEnabled } : {}),
          ...(aecBackendRequested !== undefined
            ? { aec_backend_requested: aecBackendRequested }
            : {}),
          ...(aecBackend !== undefined ? { aec_backend: aecBackend } : {}),
          ...(aecStatus !== undefined ? { aec_status: aecStatus } : {}),
          ...(aecLastError !== undefined ? { aec_last_error: aecLastError } : {}),
          ...buildAiyraMicSelectionHealthExtra(),
          ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
          ...(orchestratorSessionId !== undefined
            ? { orchestrator_session_id: orchestratorSessionId }
            : {}),
          ...(twilioSupervisorState !== undefined
            ? { twilio_supervisor_state: twilioSupervisorState }
            : {}),
        };
      };
      const runtime = await startAiyraVoiceRuntime({
        appUrl: aiyraAppUrl,
        deviceToken,
        wakeWord: aiyraWakeWord,
        wakeSensitivity: aiyraWakeSensitivity,
        idleTimeoutMs: aiyraIdleTimeoutMs,
        keywordPath: aiyraKeywordPath || undefined,
        wakeEngine: aiyraWakeEngine || undefined,
        openWakewordThreshold: aiyraOpenWakewordThreshold,
        openWakewordModelPath: aiyraOpenWakewordModelPath || undefined,
        openWakewordPython: aiyraOpenWakewordPython || undefined,
        openWakewordScriptPath: aiyraOpenWakewordScriptPath || undefined,
        openWakewordAllowApproximate: aiyraOpenWakewordAllowApproximate,
        aecEnabled: aiyraAecEnabled,
        aecBackend: aiyraAecBackend,
        deviceIndex: aiyraDeviceIndex,
        resolveDeviceIndex: () => resolveAiyraRuntimeConfig().deviceIndex,
        log: (...args) => log(...args),
        warn: (...args) => warn(...args),
        onHealth: (event) => {
          const status = typeof event?.status === "string" ? event.status : "unknown";
          const healthExtra = buildAiyraVoiceHealthExtra(event);
          if (status === "healthy") {
            clearAiyraRuntimeRecoveryTimer({ resetAttempt: true });
            noteAiyraVoiceHealthy(
              event.reason || "aiyra_voice_healthy",
              event.detail || "",
              healthExtra
            );
            return;
          }
          if (status === "recovering") {
            noteAiyraVoiceRecovering(
              event.reason || "aiyra_voice_recovering",
              event.detail || "",
              healthExtra
            );
            return;
          }
          if (status === "disabled") {
            noteAiyraVoiceDisabled(
              event.reason || "aiyra_voice_disabled",
              event.detail || "Aiyra voice runtime disabled",
              healthExtra
            );
            return;
          }
          if (
            event?.reason === "aiyra_wakeword_failed" &&
            event?.active !== true &&
            scheduleAiyraRuntimeRecovery(event.reason, event.detail || "")
          ) {
            return;
          }
          noteAiyraVoiceDegraded(
            event.reason || "aiyra_voice_degraded",
            event.detail || "Aiyra voice runtime reported unhealthy state",
            healthExtra
          );
        },
        onMetric: (metric) => {
          if (metric && typeof metric === "object") {
            log("aiyra.voice.metric", metric);
          }
          recordAiyraVoiceMetric(metric);
        },
      });
      aiyraVoiceRuntime = runtime;
      aiyraActiveRuntimeDeviceName = aiyraResolvedDeviceName || "";
      log("Aiyra voice runtime object created", {
        wakeWord: aiyraWakeWord,
        wakeEngine: aiyraWakeEngine,
        resolvedDeviceName: aiyraResolvedDeviceName || null,
        resolvedDeviceIndex: aiyraDeviceIndex,
      });
      noteAiyraVoiceHealthy("aiyra_runtime_started", "Aiyra wake-word runtime started", {
        wake_word: aiyraWakeWord,
        wake_sensitivity: aiyraWakeSensitivity,
        ...(aiyraWakeEngine === "openwakeword"
          ? { openwakeword_threshold: aiyraOpenWakewordThreshold }
          : {}),
        idle_timeout_ms: aiyraIdleTimeoutMs,
        wake_engine: aiyraWakeEngine,
        aec_enabled: aiyraAecEnabled,
        aec_backend_requested: aiyraAecBackend,
        aec_backend: null,
        aec_status: aiyraAecEnabled ? "starting" : "disabled",
        aec_last_error: null,
        listening: true,
        active: false,
        muted: false,
        mic_input_level: 0,
        mic_input_updated_at: null,
        ...buildAiyraMicSelectionHealthExtra(),
      });
      scheduleAiyraSpecificMicWatch("runtime_started");
      return true;
    } catch (e) {
      aiyraActiveRuntimeDeviceName = "";
      noteAiyraVoiceDegraded(
        "aiyra_runtime_start_failed",
        e instanceof Error ? e.message : String(e)
      );
      scheduleAiyraRuntimeRecovery(
        "aiyra_runtime_start_failed",
        e instanceof Error ? e.message : String(e)
      );
      return false;
    } finally {
      aiyraRuntimeStarting = false;
    }
  }

  async function maybeRunConnectorUpdate({ force = false, source = "scheduled" } = {}) {
    if (autoUpdateInProgress) {
      return { ok: false, updated: false, reason: "update_in_progress" };
    }
    autoUpdateInProgress = true;
    try {
      const result = await maybeApplyLocalConnectorUpdate({ force });
      if (result.ok && result.updated) {
        log("connector update ready", {
          source,
          from: result.currentVersion,
          to: result.latestVersion,
          tag: result.latestTag || null,
        });
      }
      return result;
    } catch (e) {
      return {
        ok: false,
        updated: false,
        reason: "update_check_failed",
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      autoUpdateInProgress = false;
    }
  }

  function scheduleNextAutoUpdateCheck(delayMs, source = "scheduled") {
    if (!autoUpdateLoopStarted) return;
    stopAutoUpdateLoop();
    const waitMs = Math.max(15_000, Number(delayMs) || AUTO_UPDATE_CHECK_INTERVAL_MS);
    autoUpdateTimer = setTimeout(async () => {
      autoUpdateTimer = null;
      const result = await maybeRunConnectorUpdate({ force: false, source });
      if (result.ok && result.updated) {
        handoffToUpdatedProcess();
        return;
      }
      if (result.reason === "connector_busy") {
        scheduleNextAutoUpdateCheck(AUTO_UPDATE_BUSY_RETRY_MS, "busy_retry");
        return;
      }
      if (result.ok && result.updated === false) {
        scheduleNextAutoUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS, "interval");
        return;
      }
      const nonRetryable = new Set([
        "disabled",
        "hosted_runtime",
        "unsupported_arch",
        "unsupported_runtime",
        "unsupported_platform",
        "not_app_bundle",
        "dev_repo_runtime",
        "missing_launcher",
      ]);
      if (nonRetryable.has(String(result.reason || ""))) {
        return;
      }
      warn("auto-update check failed; will retry", {
        source,
        reason: result.reason || "unknown_error",
        error: result.error || null,
      });
      scheduleNextAutoUpdateCheck(AUTO_UPDATE_FAILURE_RETRY_MS, "failure_retry");
    }, waitMs);
  }

  function startAutoUpdateLoop() {
    if (autoUpdateLoopStarted) return;
    const disabled = isAutoUpdateDisabledByConfig();
    if (disabled.disabled) {
      log("auto-update disabled", { source: disabled.source });
      return;
    }
    const context = getLocalAutoUpdateContext();
    if (!context.ok) {
      return;
    }
    autoUpdateLoopStarted = true;
    const jitter = Math.floor(Math.random() * AUTO_UPDATE_INITIAL_JITTER_MS);
    scheduleNextAutoUpdateCheck(AUTO_UPDATE_INITIAL_DELAY_MS + jitter, "initial");
  }

  function connect() {
    const ws = new WebSocket(relayUrl);
    activeRelayWs = ws;
    let openedAt = Date.now();
    // Some sleep/wake cycles can leave the TCP socket half-open: readyState stays OPEN
    // but messages never flow. Use a ping watchdog to force reconnect in that state.
    let pingInterval = null;
    let pingOutstanding = false;
    let lastPongAt = Date.now();
    let lastAnyMessageAt = Date.now();
    let pingRequestId = null;

    ws.on("open", () => {
      activeRelayWs = ws;
      openedAt = Date.now();
      log("connected to relay");
      const connectorVersion = getConnectorVersion();

      // Check if Claude CLI is installed
      let claudeCliInstalled = false;
      try {
        claudeCliInstalled = detectClaudeCliInstalled();
      } catch {
        // ignore
      }
      
      ws.send(
        JSON.stringify({
          type: "connector_hello",
          pairing_code: pairingCode || null,
          device_token: pairingCode ? null : deviceToken || null,
          device_name: deviceName,
          public_key: null,
          version: connectorVersion,
          capabilities: { claudeCliInstalled, skillsManager: true },
        })
      );

      // App-level ping watchdog: more reliable than WS ping/pong in some environments.
      pingOutstanding = false;
      pingRequestId = null;
      lastPongAt = Date.now();
      lastAnyMessageAt = Date.now();
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const now = Date.now();

        // If we've been receiving any messages recently, don't force reconnects.
        if (now - lastAnyMessageAt < 45_000) {
          // Keep liveness fresh even if the relay isn't answering pongs.
          pingOutstanding = false;
          pingRequestId = null;
          return;
        }

        // If an app ping is outstanding for too long, reconnect.
        if (pingOutstanding && now - lastPongAt > 60_000) {
          warn("ping watchdog: no app_pong; terminating socket to reconnect");
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          return;
        }

        // Send an app-level ping.
        pingOutstanding = true;
        pingRequestId = `ping-${now}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          ws.send(JSON.stringify({ type: "app_ping", request_id: pingRequestId, ts: now }));
        } catch {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        }
      }, 20000);
    });

    ws.on("pong", () => {
      // Keep this for debugging, but don't rely on WS pong for liveness.
      lastPongAt = Date.now();
    });

    ws.on("message", async (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString("utf8"));
      } catch {
        return;
      }
      lastAnyMessageAt = Date.now();
      const messageType = String(msg?.type || "");
      const shouldAcquireGlobalPrioritySlot = shouldAcquireGlobalConnectorPrioritySlot(messageType);
      const releasePrioritySlot = shouldAcquireGlobalPrioritySlot
        ? await acquireConnectorOpSlot("high", `relay:${messageType || "unknown"}`)
        : null;

      try {

      if (msg.type === "app_pong") {
        const reqId = msg.request_id ? String(msg.request_id) : null;
        if (!pingRequestId || !reqId || reqId === pingRequestId) {
          pingOutstanding = false;
          pingRequestId = null;
          lastPongAt = Date.now();
        }
        return;
      }

      // Respond to app_ping from relay (server-initiated keepalive)
      if (msg.type === "app_ping") {
        const reqId = msg.request_id ? String(msg.request_id) : null;
        try {
          ws.send(JSON.stringify({ type: "app_pong", request_id: reqId, ts: Date.now() }));
        } catch {
          // ignore
        }
        return;
      }

      if (msg.type === "error") {
        const errorText =
          typeof msg.error === "string" ? msg.error.trim() : String(msg.error || "");
        warn("error:", errorText || msg.error);
        if (await handleRelayAuthOrPairingError(errorText)) {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
        return;
      }

      // ===== WebRTC signaling from relay (P2P terminal fast-path) =====
      if (msg.type === "webrtc_offer") {
        const terminalId = String(msg.terminal_id || "");
        const webrtcId = String(msg.webrtc_id || "");
        const sdp = String(msg.sdp || "");
        const sdpType = String(msg.sdp_type || "offer");
        if (!terminalId || !webrtcId || !sdp || sdpType !== "offer") return;

        if (!terminals.has(terminalId)) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "webrtc_error",
                terminal_id: terminalId,
                webrtc_id: webrtcId,
                error: "terminal_not_found",
              })
            );
          }
          return;
        }

        const wrtc = await getWrtc();
        if (!wrtc) {
          warn("wrtc not available; cannot accept WebRTC offer");
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "webrtc_error",
                terminal_id: terminalId,
                webrtc_id: webrtcId,
                error: "wrtc_not_installed",
              })
            );
          }
          return;
        }

        // Replace any existing session with the same ID
        const existing = webrtcPeers.get(webrtcId);
        if (existing) {
          try {
            existing.dc?.close();
          } catch {}
          try {
            existing.pc?.close();
          } catch {}
          webrtcPeers.delete(webrtcId);
        }

        const pc = new wrtc.RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
        webrtcPeers.set(webrtcId, { terminalId, pc, dc: null });

        pc.onicecandidate = (evt) => {
          const c = evt.candidate;
          if (!c) return;
          const candidate =
            typeof c.toJSON === "function"
              ? c.toJSON()
              : {
                  candidate: c.candidate,
                  sdpMid: c.sdpMid,
                  sdpMLineIndex: c.sdpMLineIndex,
                  usernameFragment: c.usernameFragment,
                };
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "webrtc_ice",
                terminal_id: terminalId,
                webrtc_id: webrtcId,
                candidate,
              })
            );
          }
        };

        pc.ondatachannel = (evt) => {
          const dc = evt.channel;
          const current = webrtcPeers.get(webrtcId);
          if (current) current.dc = dc;
          attachWebRtcChannel({ terminalId, webrtcId, pc, dc });
        };

        try {
          await pc.setRemoteDescription({ type: "offer", sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "webrtc_answer",
                terminal_id: terminalId,
                webrtc_id: webrtcId,
                sdp: answer.sdp,
                sdp_type: answer.type,
              })
            );
          }
        } catch (e) {
          warn(
            "failed handling webrtc_offer",
            e instanceof Error ? e.message : String(e)
          );
          try {
            pc.close();
          } catch {}
          webrtcPeers.delete(webrtcId);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "webrtc_error",
                terminal_id: terminalId,
                webrtc_id: webrtcId,
                error: "offer_failed",
              })
            );
          }
        }
        return;
      }

      if (msg.type === "webrtc_ice") {
        const terminalId = String(msg.terminal_id || "");
        const webrtcId = String(msg.webrtc_id || "");
        const candidate = msg.candidate || null;
        if (!terminalId || !webrtcId || !candidate) return;

        const sess = webrtcPeers.get(webrtcId);
        if (!sess || sess.terminalId !== terminalId || !sess.pc) return;

        try {
          await sess.pc.addIceCandidate(candidate);
        } catch {
          // ignore
        }
        return;
      }

      if (msg.type === "connector_ready") {
        log("authenticated as device:", msg.device_id);
        const readyUserId = normalizeUserId(msg.user_id);
        const configuredUserId = normalizeUserId(cfg.paired_user_id);
        if (readyUserId && configuredUserId && readyUserId !== configuredUserId && !allowAccountSwitch) {
          warn("connector account mismatch detected; clearing stored auth and exiting", {
            expected_user_id: configuredUserId,
            actual_user_id: readyUserId,
          });
          await clearDeviceTokenSecure();
          const nextCfg = { ...cfg };
          delete nextCfg.device_token;
          delete nextCfg.paired_user_id;
          await writeConfig(nextCfg);
          cfg = nextCfg;
          fatal(
            `Connector account mismatch: expected ${configuredUserId} but authenticated as ${readyUserId}. Re-pair using the correct account.`
          );
        }
        if (msg.device_token) {
          deviceToken = msg.device_token;
          activeDeviceToken = msg.device_token; // module-level for scheduler
          pairingCode = null; // Clear pairing code after successful auth

          await saveDeviceTokenSecure(msg.device_token);
        }
        const nextCfg = {
          ...cfg,
          relay_url: relayUrl,
          device_name: deviceName,
          ...(deviceToken ? { device_token: deviceToken } : {}),
          ...(readyUserId ? { paired_user_id: readyUserId } : {}),
        };
        // Persist WhatsApp settings if explicitly enabled via CLI flag.
        if (whatsappFlag) {
          nextCfg.whatsapp_enabled = true;
          if (whatsappGroupName) nextCfg.whatsapp_group_name = whatsappGroupName;
          if (whatsappAppUrl) nextCfg.whatsapp_app_url = whatsappAppUrl;
        }
        if (aiyraVoiceFlag) {
          nextCfg.aiyra_voice_enabled = true;
          if (aiyraWakeWord) nextCfg.aiyra_wake_word = aiyraWakeWord;
          if (aiyraAppUrl) nextCfg.aiyra_app_url = aiyraAppUrl;
          nextCfg.aiyra_wake_sensitivity = aiyraWakeSensitivity;
          nextCfg.aiyra_idle_timeout_ms = aiyraIdleTimeoutMs;
          if (aiyraWakeEngine) nextCfg.aiyra_wake_engine = aiyraWakeEngine;
          nextCfg.aiyra_aec_enabled = aiyraAecEnabled;
          if (aiyraAecBackend) nextCfg.aiyra_aec_backend = aiyraAecBackend;
          if (Number.isFinite(Number(aiyraOpenWakewordThreshold))) {
            nextCfg.aiyra_openwakeword_threshold = aiyraOpenWakewordThreshold;
          }
          if (aiyraOpenWakewordModelPath) {
            nextCfg.aiyra_openwakeword_model_path = aiyraOpenWakewordModelPath;
          }
          if (aiyraOpenWakewordPython) {
            nextCfg.aiyra_openwakeword_python = aiyraOpenWakewordPython;
          }
          if (aiyraOpenWakewordScriptPath) {
            nextCfg.aiyra_openwakeword_script_path = aiyraOpenWakewordScriptPath;
          }
          nextCfg.aiyra_openwakeword_allow_approximate =
            aiyraOpenWakewordAllowApproximate === true;
          const micModeToPersist =
            aiyraMicSelectionSource === "cli" || aiyraMicSelectionSource === "env"
              ? aiyraPersistedMicMode
              : aiyraMicMode;
          const micNameToPersist =
            aiyraMicSelectionSource === "cli" || aiyraMicSelectionSource === "env"
              ? aiyraPersistedMicName
              : aiyraMicName;
          if (micModeToPersist) {
            nextCfg.aiyra_mic_mode = micModeToPersist;
          } else {
            delete nextCfg.aiyra_mic_mode;
          }
          if (micModeToPersist === "specific" && micNameToPersist) {
            nextCfg.aiyra_mic_name = micNameToPersist;
          } else {
            delete nextCfg.aiyra_mic_name;
          }
          delete nextCfg.aiyra_device_index;
          if (aiyraKeywordPath) {
            nextCfg.aiyra_wakeword_ppn_path = aiyraKeywordPath;
          }
        }
        // Persist code workspace for WhatsApp @code mode if we can resolve it.
        // (Avoids needing GROOVY_CODE_CWD in LaunchAgent environments.)
        if (codeCwd && isDirectory(codeCwd)) {
          nextCfg.code_cwd = codeCwd;
        }
        const nextCfgJson = JSON.stringify(nextCfg);
        const prevCfgJson = JSON.stringify(cfg || {});
        if (nextCfgJson !== prevCfgJson) {
          await writeConfig(nextCfg);
          cfg = nextCfg;
          log("stored connector auth state at", getConfigPath(), {
            paired_user_id: readyUserId || null,
          });
        }

        // Hosted Groovy Mac: bind this device_id to the hosted request/workspace
        // so the user's UI can show it as online automatically.
        registerHostedMacDeviceIfNeeded().catch(() => {});
        // Auth is now complete; publish the latest connector health snapshot.
        sendConnectorHealthUpdate(true);
        if (aiyraVoiceEnabled) {
          maybeStartAiyraVoiceRuntime().catch((e) => {
            warn("failed to start Aiyra voice runtime", e instanceof Error ? e.message : String(e));
          });
        }

        // Start local WhatsApp Web bridge (optional)
        if (whatsappEnabled && !whatsappStarted && deviceToken) {
          if (!whatsappGroupName || !whatsappAppUrl) {
            warn(
              "WhatsApp enabled but missing config. Need WHATSAPP_GROUP_NAME + GROOVY_APP_URL (or --whatsapp-group/--app-url)."
            );
            noteWhatsAppDegraded(
              "whatsapp_config_invalid",
              "missing_whatsapp_config",
              "WhatsApp enabled but missing group name or app URL"
            );
          } else {
            const buildWhatsAppCodeRuntime = () => ({
              ensureTerminal: ensureTerminalForWhatsApp,
              sendInput: sendTerminalInputForWhatsApp,
              getBufferLen: getTerminalLocalBufferLen,
              getDelta: getTerminalLocalBufferDelta,
              getTail: getTerminalLocalBufferTail,
              pickWorkspace: async () => {
                const picked = await pickFolder();
                if (!picked?.ok) return picked;
                const p = String(picked.path || "").trim();
                if (!p) return { ok: false, error: "no_folder_selected" };
                if (!isDirectory(p)) return { ok: false, error: "picked_path_not_a_directory" };
                if (!isLikelyRepoWorkspacePath(p)) {
                  return {
                    ok: false,
                    error: "picked_path_not_a_workspace",
                  };
                }

                try {
                  const nextCfg = { ...cfg, code_cwd: p };
                  await writeConfig(nextCfg);
                  cfg = nextCfg;
                } catch {
                  // ignore (best-effort persistence)
                }

                // Best-effort: mark this workspace trusted for Claude Code so it won't block on the trust prompt.
                await ensureClaudeTrustAcceptedForPath(p);
                return { ok: true, path: p };
              },
            });
            whatsappStarted = true;
            noteWhatsAppRecovering("whatsapp_bridge_starting", "Starting WhatsApp Web bridge");
            startWhatsAppBridge({
              deviceToken,
              groupName: whatsappGroupName,
              appUrl: whatsappAppUrl,
              codeCwd: codeCwd && isDirectory(codeCwd) ? codeCwd : undefined,
              codeRuntime: buildWhatsAppCodeRuntime(),
              onHealth: (healthEvent) => {
                const status =
                  healthEvent && typeof healthEvent === "object" && typeof healthEvent.status === "string"
                    ? healthEvent.status
                    : "";
                const reason =
                  healthEvent && typeof healthEvent === "object" && typeof healthEvent.reason === "string"
                    ? healthEvent.reason
                    : "";
                const detail =
                  healthEvent && typeof healthEvent === "object" && typeof healthEvent.detail === "string"
                    ? healthEvent.detail
                    : "";
                if (status === "healthy") {
                  noteWhatsAppHealthy(reason || "whatsapp_ready", detail);
                  return;
                }
                if (status === "recovering") {
                  noteWhatsAppRecovering(reason || "whatsapp_recovering", detail);
                  return;
                }
                if (status === "disabled") {
                  applyWhatsAppHealthPatch({
                    status: "disabled",
                    reason: reason || "whatsapp_disabled",
                    detail: detail || "WhatsApp bridge disabled",
                    consecutive_failures: 0,
                    recent_failures: 0,
                    auto_restart_pending: false,
                    auto_restart_count: whatsappAutoRestartCount,
                  });
                  return;
                }
                noteWhatsAppDegraded(
                  reason || "whatsapp_unhealthy",
                  reason || "whatsapp_unhealthy",
                  detail || "WhatsApp bridge reported an unhealthy state"
                );
              },
            })
              .then(async (bridge) => {
                whatsappBridge = bridge && typeof bridge === "object" ? bridge : null;
                // Store opts so runScheduledJob can restart the bridge on frame detach.
                if (whatsappBridge) {
                  whatsappBridgeOpts = {
                    deviceToken,
                    groupName: whatsappGroupName,
                    appUrl: whatsappAppUrl,
                    codeCwd: codeCwd && isDirectory(codeCwd) ? codeCwd : undefined,
                    codeRuntime: buildWhatsAppCodeRuntime(),
                  };
                  await waitForWhatsAppBridgeReadyOrThrow(whatsappBridge);
                  noteWhatsAppHealthy(
                    "whatsapp_bridge_started",
                    "WhatsApp bridge started and reached ready state"
                  );
                } else {
                  noteWhatsAppDegraded(
                    "whatsapp_bridge_started_invalid",
                    "bridge_not_available",
                    "startWhatsAppBridge returned empty bridge object"
                  );
                }
              })
              .catch(async (e) => {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg !== "whatsapp_qr_required") {
                  whatsappBridge = null;
                }
                warn("whatsapp bridge failed", msg);
                // Auto-recovery: retry startup for crash/timeout-class startup failures.
                // For startup deadlocks, retry without WA web pin and optionally force a full session reset.
                const isStartupRetryable = isRetryableWhatsAppStartupErrorMessage(msg);
                const retryWithoutPin = shouldRetryWhatsAppStartupWithoutPin(msg);
                const retryWithSessionReset = shouldHardResetWhatsAppSessionOnStartupRetry(msg);

                if (msg === "whatsapp_qr_required") {
                  noteWhatsAppRecovering(
                    "whatsapp_qr_required",
                    "WhatsApp session reset requires QR re-link"
                  );
                } else if (isStartupRetryable) {
                  // Stay in "recovering" while we run our own 5s local bridge retry.
                  // Emitting "degraded" here while the connector is still about to self-heal
                  // causes the dashboard's isRestartableWhatsAppIssue() check to fire a full
                  // connector_restart (reason: 'ui_requested'), killing in-flight claude/codex
                  // runs. Only escalate to "degraded" if the retry itself fails below.
                  noteWhatsAppRecovering(
                    "whatsapp_bridge_retry_pending",
                    `WhatsApp bridge startup failed (${msg}); retrying locally in 5s`
                  );
                } else {
                  noteWhatsAppDegraded("whatsapp_bridge_start_failed", msg, msg);
                }

                if (isStartupRetryable) {
                  warn("Detected WhatsApp startup failure — retrying bridge in 5s", {
                    retryWithoutPin,
                    retryWithSessionReset,
                  });
                  await new Promise((r) => setTimeout(r, 5000));
                  noteWhatsAppRecovering(
                    "whatsapp_bridge_retrying",
                    retryWithSessionReset
                      ? "Retrying bridge startup with full WhatsApp session reset"
                      : retryWithoutPin
                        ? "Retrying bridge startup without pinned WhatsApp Web version"
                        : "Retrying bridge startup after crash"
                  );
                  try {
                    const bridge = await startWhatsAppBridge({
                      deviceToken,
                      groupName: whatsappGroupName,
                      appUrl: whatsappAppUrl,
                      disableWebVersionPin: retryWithoutPin,
                      resetSession: retryWithSessionReset,
                      codeCwd: codeCwd && isDirectory(codeCwd) ? codeCwd : undefined,
                      codeRuntime: buildWhatsAppCodeRuntime(),
                      onHealth: (healthEvent) => {
                        const status =
                          healthEvent && typeof healthEvent === "object" && typeof healthEvent.status === "string"
                            ? healthEvent.status
                            : "";
                        const reason =
                          healthEvent && typeof healthEvent === "object" && typeof healthEvent.reason === "string"
                            ? healthEvent.reason
                            : "";
                        const detail =
                          healthEvent && typeof healthEvent === "object" && typeof healthEvent.detail === "string"
                            ? healthEvent.detail
                            : "";
                        if (status === "healthy") {
                          noteWhatsAppHealthy(reason || "whatsapp_ready", detail);
                          return;
                        }
                        if (status === "recovering") {
                          noteWhatsAppRecovering(reason || "whatsapp_recovering", detail);
                          return;
                        }
                        if (status === "disabled") {
                          applyWhatsAppHealthPatch({
                            status: "disabled",
                            reason: reason || "whatsapp_disabled",
                            detail: detail || "WhatsApp bridge disabled",
                            consecutive_failures: 0,
                            recent_failures: 0,
                            auto_restart_pending: false,
                            auto_restart_count: whatsappAutoRestartCount,
                          });
                          return;
                        }
                        noteWhatsAppDegraded(
                          reason || "whatsapp_unhealthy",
                          reason || "whatsapp_unhealthy",
                          detail || "WhatsApp bridge reported an unhealthy state"
                        );
                      },
                    });
                    whatsappBridge = bridge && typeof bridge === "object" ? bridge : null;
                    if (whatsappBridge) {
                      whatsappBridgeOpts = {
                        deviceToken,
                        groupName: whatsappGroupName,
                        appUrl: whatsappAppUrl,
                        codeCwd: codeCwd && isDirectory(codeCwd) ? codeCwd : undefined,
                        codeRuntime: buildWhatsAppCodeRuntime(),
                      };
                      await waitForWhatsAppBridgeReadyOrThrow(whatsappBridge);
                      warn("WhatsApp bridge recovered successfully on retry");
                      noteWhatsAppHealthy(
                        "whatsapp_bridge_recovered",
                        "WhatsApp bridge recovered after retry and reached ready state"
                      );
                    } else {
                      noteWhatsAppDegraded(
                        "whatsapp_bridge_retry_invalid",
                        "bridge_not_available",
                        "Retry returned empty bridge object"
                      );
                    }
                  } catch (retryErr) {
                    const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                    if (retryMsg !== "whatsapp_qr_required") {
                      whatsappBridge = null;
                    }
                    warn("WhatsApp bridge retry also failed:", retryMsg);
                    if (retryMsg === "whatsapp_qr_required") {
                      noteWhatsAppRecovering(
                        "whatsapp_qr_required",
                        "WhatsApp session reset requires QR re-link"
                      );
                    } else {
                      noteWhatsAppDegraded("whatsapp_bridge_retry_failed", retryMsg, retryMsg);
                    }
                  }
                }
              });
          }
        }

        // Ensure auto-start is installed after auth (platform-specific).
        let windowsStartupResult = null;
        if (!noAutoStart) {
          if (process.platform === "darwin") {
            await installLaunchAgent(relayUrl, {
              whatsappEnabled: whatsappEnabled && !!whatsappGroupName && !!whatsappAppUrl,
              whatsappGroupName,
              whatsappAppUrl,
            });
          } else if (process.platform === "win32") {
            const startupResult = await installWindowsStartupArtifacts({
              taskName: "Groovy Connector",
              nodeExe: process.execPath,
              connectorScript: process.argv[1],
              relayUrl,
              extraArgs: [
                ...(whatsappEnabled ? ["--whatsapp"] : []),
                ...(whatsappEnabled && whatsappGroupName ? ["--whatsapp-group", whatsappGroupName] : []),
                ...(whatsappEnabled && whatsappAppUrl ? ["--app-url", whatsappAppUrl] : []),
              ],
              log: (message, meta) => log(message, meta || {}),
            });
            windowsStartupResult = startupResult;
            if (!startupResult?.ok) {
              warn("failed to install Windows startup", startupResult?.reason || "unknown_error");
            } else {
              log("Windows auto-start installed", {
                method: startupResult.method || "unknown",
                taskName: startupResult.taskName || null,
              });
            }
          }
        }

        // Windows first-pair handoff:
        // move execution to Task Scheduler so the connector remains alive in background
        // even after installer/console windows are closed.
        if (
          process.platform === "win32" &&
          msg.device_token &&
          !noAutoStart &&
          windowsStartupResult?.ok &&
          windowsStartupResult?.taskName
        ) {
          const taskName = String(windowsStartupResult.taskName);
          log("Windows first-pair: handing off to Task Scheduler", { taskName });
          shouldReconnect = false;
          try {
            ws.close();
          } catch {
            // ignore
          }

          setTimeout(async () => {
            await releaseSingleInstanceLock();

            let taskStarted = false;
            try {
              await execFileAsync(
                "schtasks",
                ["/run", "/tn", taskName],
                { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }
              );
              taskStarted = true;
              log("Windows first-pair: started scheduled task");
            } catch (runErr) {
              warn(
                "Windows first-pair: failed to start scheduled task",
                runErr instanceof Error ? runErr.message : String(runErr)
              );
            }

            // Safety fallback: spawn detached directly if scheduled task run fails.
            if (!taskStarted) {
              try {
                const { spawn } = await import("child_process");
                const scriptPath = new URL(import.meta.url).pathname;
                const rawArgs = process.argv.slice(2);
                const nextArgs = [];
                for (let i = 0; i < rawArgs.length; i += 1) {
                  const a = String(rawArgs[i] || "");
                  if (a === "--pair") {
                    i += 1; // skip pair code value
                    continue;
                  }
                  nextArgs.push(a);
                }
                const child = spawn(process.execPath, [scriptPath, ...nextArgs], {
                  detached: true,
                  stdio: "ignore",
                  cwd: process.cwd(),
                  env: process.env,
                });
                child.unref();
                log("Windows first-pair: started detached fallback process");
              } catch (spawnErr) {
                warn(
                  "Windows first-pair: detached fallback failed",
                  spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
                );
              }
            }

            process.exit(0);
          }, 250);
          return;
        }

        // Scheduler: sync jobs + start loops (best-effort)
        requestScheduleSync();
        startSchedulerLoops();
        startAutoUpdateLoop();
        return;
      }

      if (msg.type === "schedule_sync") {
        const ok = msg.ok !== false;
        if (!ok) {
          warn("schedule_sync failed:", msg.error || "unknown_error");
          return;
        }
        const jobs = Array.isArray(msg.jobs) ? msg.jobs : [];
        scheduledJobs.clear();
        const syncedJobIds = new Set();
        for (const j of jobs) {
          const id = j && typeof j === "object" && "id" in j ? String(j.id || "") : "";
          if (!id) continue;
          syncedJobIds.add(id);
          scheduledJobs.set(id, j);
        }
        for (const retriedJobId of Array.from(scheduleRetryState.keys())) {
          if (!syncedJobIds.has(retriedJobId)) {
            scheduleRetryState.delete(retriedJobId);
          }
        }
        scheduleSyncPending = false;
        lastScheduleSyncAtMs = Date.now();
        log("schedule_sync updated jobs:", scheduledJobs.size);
        // If a job is already due, fire quickly right after sync (don't wait up to 15s).
        tickSchedules().catch(() => {});
        return;
      }

      // Manual trigger from UI to run a job immediately
      if (msg.type === "schedule_trigger") {
        const requestId = String(msg.request_id || "");
        const jobId = String(msg.job_id || "");
        log("schedule_trigger received", {
          requestId,
          jobId,
          syncedJobCount: scheduledJobs.size,
          syncedJobIds: Array.from(scheduledJobs.keys()).slice(0, 10),
        });
        if (!jobId) {
          warn("schedule_trigger: missing job_id");
          if (requestId) {
            ws.send(JSON.stringify({
              type: "schedule_trigger_result",
              request_id: requestId,
              ok: false,
              error: "missing_job_id",
            }));
          }
          return;
        }
        const job = scheduledJobs.get(jobId);
        if (!job) {
          warn("schedule_trigger: job_not_found", { jobId, syncedJobIds: Array.from(scheduledJobs.keys()) });
          if (requestId) {
            ws.send(JSON.stringify({
              type: "schedule_trigger_result",
              request_id: requestId,
              ok: false,
              error: "job_not_found",
            }));
          }
          return;
        }
        log("schedule_trigger: running job manually", { jobId, name: job.name, kind: job.kind });
        // Run in background, respond immediately
        runScheduledJob(job).catch((e) => {
          warn("schedule_trigger runScheduledJob error:", e);
        });
        if (requestId) {
          ws.send(JSON.stringify({
            type: "schedule_trigger_result",
            request_id: requestId,
            ok: true,
            job_id: jobId,
            message: "Job triggered, running in background",
          }));
        }
        return;
      }

      if (msg.type === "aiyra_voice_report") {
        const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
        const kind =
          typeof msg.kind === "string" ? msg.kind.trim().toLowerCase() : "";
        if (kind === "missed_wake") {
          applyAiyraVoiceHealthPatch({
            missed_reports: incrementAiyraVoiceCounter("missed_reports", 1),
            detail: "User reported missed wake phrase",
            reason: "aiyra_missed_wake_reported",
          });
        } else if (kind === "false_trigger") {
          applyAiyraVoiceHealthPatch({
            false_trigger_reports: incrementAiyraVoiceCounter(
              "false_trigger_reports",
              1
            ),
            detail: "User reported false wake trigger",
            reason: "aiyra_false_trigger_reported",
          });
        }

        try {
          ws.send(
            JSON.stringify({
              type: "aiyra_voice_report_result",
              request_id: requestId || undefined,
              ok: kind === "missed_wake" || kind === "false_trigger",
              kind,
              health: { ...aiyraVoiceHealthState },
            })
          );
        } catch {
          // ignore
        }
        return;
      }

      if (msg.type === "aiyra_voice_control") {
        const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
        const action =
          typeof msg.action === "string" ? msg.action.trim().toLowerCase() : "";

        if (action !== "set_muted") {
          try {
            ws.send(
              JSON.stringify({
                type: "aiyra_voice_control_result",
                request_id: requestId || undefined,
                ok: false,
                error: "unsupported_action",
                health: { ...aiyraVoiceHealthState },
              })
            );
          } catch {
            // ignore
          }
          return;
        }

        if (!aiyraVoiceRuntime || typeof aiyraVoiceRuntime.setMuted !== "function") {
          try {
            ws.send(
              JSON.stringify({
                type: "aiyra_voice_control_result",
                request_id: requestId || undefined,
                ok: false,
                error: "aiyra_voice_runtime_unavailable",
                health: { ...aiyraVoiceHealthState },
              })
            );
          } catch {
            // ignore
          }
          return;
        }

        try {
          const result = await aiyraVoiceRuntime.setMuted(msg.muted === true);
          ws.send(
            JSON.stringify({
              type: "aiyra_voice_control_result",
              request_id: requestId || undefined,
              ok: result?.ok !== false,
              active: result?.active === true,
              muted: result?.muted === true,
              error:
                typeof result?.error === "string" && result.error
                  ? result.error
                  : undefined,
              health: { ...aiyraVoiceHealthState },
            })
          );
        } catch (e) {
          try {
            ws.send(
              JSON.stringify({
                type: "aiyra_voice_control_result",
                request_id: requestId || undefined,
                ok: false,
                error: e instanceof Error ? e.message : String(e),
                health: { ...aiyraVoiceHealthState },
              })
            );
          } catch {
            // ignore
          }
        }
        return;
      }

      if (msg.type === "aiyra_voice_stats") {
        const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
        try {
          ws.send(
            JSON.stringify({
              type: "aiyra_voice_stats_result",
              request_id: requestId || undefined,
              ok: true,
              stats: { ...aiyraVoiceHealthState },
            })
          );
        } catch {
          // ignore
        }
        return;
      }

      if (msg.type === "aiyra_list_audio_devices") {
        const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
        log("aiyra_list_audio_devices request", {
          requestId: requestId || null,
          currentDeviceIndex: aiyraDeviceIndex,
          currentMicMode: aiyraMicMode,
          currentMicName: aiyraMicName || null,
          resolvedDeviceName: aiyraResolvedDeviceName || null,
        });
        try {
          const currentAiyraConfig = resolveAiyraRuntimeConfig();
          const devices = Array.isArray(currentAiyraConfig.audioDevices)
            ? currentAiyraConfig.audioDevices
            : [];
          log("aiyra_list_audio_devices result", {
            requestId: requestId || null,
            count: devices.length,
            preview: devices.slice(0, 5).map((d) => d.name),
            currentDeviceIndex: currentAiyraConfig.deviceIndex,
            currentMicMode: currentAiyraConfig.micMode,
            currentMicName: currentAiyraConfig.micName || null,
            resolvedDeviceName: currentAiyraConfig.resolvedDeviceName || null,
          });
          ws.send(
            JSON.stringify({
              type: "aiyra_list_audio_devices_result",
              request_id: requestId || undefined,
              ok: true,
              devices,
              current_device_index: currentAiyraConfig.deviceIndex,
              current_device_mode: currentAiyraConfig.micMode,
              current_device_name: currentAiyraConfig.micName || undefined,
              resolved_device_name: currentAiyraConfig.resolvedDeviceName || undefined,
            })
          );
        } catch (e) {
          warn(
            "aiyra_list_audio_devices failed",
            e instanceof Error ? e.message : String(e)
          );
          ws.send(
            JSON.stringify({
              type: "aiyra_list_audio_devices_result",
              request_id: requestId || undefined,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
              devices: [],
            })
          );
        }
        return;
      }

      // Dashboard can write config keys (e.g. whatsapp_group_name) and optionally restart.
      if (msg.type === "connector_configure") {
        const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
        try {
          const raw =
            msg.config && typeof msg.config === "object"
              ? msg.config
              : {};
          const safeUpdates = {};

          // Whitelist supported config keys to avoid accidental config corruption.
          if (typeof raw.whatsapp_enabled === "boolean") {
            safeUpdates.whatsapp_enabled = raw.whatsapp_enabled;
          }
          if (
            typeof raw.whatsapp_group_name === "string" ||
            raw.whatsapp_group_name === null
          ) {
            safeUpdates.whatsapp_group_name =
              typeof raw.whatsapp_group_name === "string"
                ? raw.whatsapp_group_name.trim()
                : "";
          }
          if (typeof raw.whatsapp_app_url === "string") {
            safeUpdates.whatsapp_app_url = raw.whatsapp_app_url.trim();
          }
          if (typeof raw.aiyra_voice_enabled === "boolean") {
            safeUpdates.aiyra_voice_enabled = raw.aiyra_voice_enabled;
          }
          if (
            typeof raw.aiyra_wake_word === "string" ||
            raw.aiyra_wake_word === null
          ) {
            safeUpdates.aiyra_wake_word =
              typeof raw.aiyra_wake_word === "string"
                ? raw.aiyra_wake_word.trim()
                : "";
          }
          if (typeof raw.aiyra_app_url === "string") {
            safeUpdates.aiyra_app_url = raw.aiyra_app_url.trim();
          }
          if (typeof raw.aiyra_wakeword_ppn_path === "string") {
            safeUpdates.aiyra_wakeword_ppn_path =
              raw.aiyra_wakeword_ppn_path.trim();
          }
          if (typeof raw.aiyra_wake_engine === "string") {
            safeUpdates.aiyra_wake_engine = raw.aiyra_wake_engine.trim().toLowerCase();
          }
          if (Number.isFinite(Number(raw.aiyra_wake_sensitivity))) {
            safeUpdates.aiyra_wake_sensitivity = normalizeClampedNumber(
              raw.aiyra_wake_sensitivity,
              0.5,
              0,
              1
            );
          }
          if (Number.isFinite(Number(raw.aiyra_idle_timeout_ms))) {
            safeUpdates.aiyra_idle_timeout_ms = normalizeIntegerRange(
              raw.aiyra_idle_timeout_ms,
              12000,
              2000,
              120000
            );
          }
          if (typeof raw.aiyra_aec_enabled === "boolean") {
            safeUpdates.aiyra_aec_enabled = raw.aiyra_aec_enabled;
          }
          if (typeof raw.aiyra_aec_backend === "string" || raw.aiyra_aec_backend === null) {
            safeUpdates.aiyra_aec_backend =
              typeof raw.aiyra_aec_backend === "string"
                ? normalizeAiyraAecBackend(raw.aiyra_aec_backend, "webrtc")
                : "";
          }
          if (Number.isFinite(Number(raw.aiyra_openwakeword_threshold))) {
            safeUpdates.aiyra_openwakeword_threshold = normalizeClampedNumber(
              raw.aiyra_openwakeword_threshold,
              0.5,
              0,
              1
            );
          }
          if (typeof raw.aiyra_openwakeword_model_path === "string") {
            safeUpdates.aiyra_openwakeword_model_path =
              raw.aiyra_openwakeword_model_path.trim();
          }
          if (typeof raw.aiyra_openwakeword_python === "string") {
            safeUpdates.aiyra_openwakeword_python =
              raw.aiyra_openwakeword_python.trim();
          }
          if (typeof raw.aiyra_openwakeword_script_path === "string") {
            safeUpdates.aiyra_openwakeword_script_path =
              raw.aiyra_openwakeword_script_path.trim();
          }
          if (typeof raw.aiyra_openwakeword_allow_approximate === "boolean") {
            safeUpdates.aiyra_openwakeword_allow_approximate =
              raw.aiyra_openwakeword_allow_approximate;
          }
          if (typeof raw.aiyra_mic_mode === "string") {
            safeUpdates.aiyra_mic_mode = normalizeAiyraMicMode(
              raw.aiyra_mic_mode,
              "computer_default"
            );
          }
          if (typeof raw.aiyra_mic_name === "string" || raw.aiyra_mic_name === null) {
            safeUpdates.aiyra_mic_name =
              typeof raw.aiyra_mic_name === "string"
                ? normalizeAiyraMicName(raw.aiyra_mic_name)
                : "";
          }
          const hasModernMicSelectionFields =
            typeof raw.aiyra_mic_mode === "string" ||
            typeof raw.aiyra_mic_name === "string" ||
            raw.aiyra_mic_name === null;
          if (
            Number.isFinite(Number(raw.aiyra_device_index)) &&
            !hasModernMicSelectionFields
          ) {
            const legacyDeviceIndex = normalizeIntegerRange(
              raw.aiyra_device_index,
              -1,
              -1,
              99
            );
            if (legacyDeviceIndex < 0) {
              safeUpdates.aiyra_mic_mode = "computer_default";
              safeUpdates.aiyra_mic_name = "";
            } else {
              const devices = listAvailableAiyraAudioDevices();
              const matchedDevice = devices[legacyDeviceIndex] || null;
              safeUpdates.aiyra_mic_mode = "specific";
              safeUpdates.aiyra_mic_name = matchedDevice
                ? normalizeAiyraMicName(matchedDevice.name)
                : "";
              safeUpdates.aiyra_device_index = legacyDeviceIndex;
            }
          } else if (
            Number.isFinite(Number(raw.aiyra_device_index)) &&
            hasModernMicSelectionFields
          ) {
            log("ignoring legacy aiyra_device_index because modern mic selection was provided", {
              aiyra_device_index: Number(raw.aiyra_device_index),
              aiyra_mic_mode:
                typeof raw.aiyra_mic_mode === "string" ? raw.aiyra_mic_mode : null,
              aiyra_mic_name:
                typeof raw.aiyra_mic_name === "string" ? raw.aiyra_mic_name : null,
            });
          }

          const safeKeys = Object.keys(safeUpdates);
          let runtimeApplyError = "";
          if (safeKeys.length > 0) {
            const nextCfg = { ...cfg, ...safeUpdates };
            if (
              "aiyra_mic_mode" in safeUpdates ||
              "aiyra_mic_name" in safeUpdates ||
              "aiyra_device_index" in safeUpdates
            ) {
              const nextMicMode = normalizeAiyraMicMode(
                nextCfg.aiyra_mic_mode,
                "computer_default"
              );
              nextCfg.aiyra_mic_mode = nextMicMode;
              if (nextMicMode === "specific") {
                const nextMicName = normalizeAiyraMicName(nextCfg.aiyra_mic_name);
                if (nextMicName) {
                  nextCfg.aiyra_mic_name = nextMicName;
                } else {
                  nextCfg.aiyra_mic_mode = "computer_default";
                  delete nextCfg.aiyra_mic_name;
                }
              } else {
                delete nextCfg.aiyra_mic_name;
              }
              delete nextCfg.aiyra_device_index;
            }
            // Enabling with a non-empty group implies WhatsApp should run.
            if (
              typeof safeUpdates.whatsapp_group_name === "string" &&
              safeUpdates.whatsapp_group_name.length > 0 &&
              safeUpdates.whatsapp_enabled !== false
            ) {
              nextCfg.whatsapp_enabled = true;
            }
            await writeConfig(nextCfg);
            cfg = nextCfg;
            log("config updated via dashboard", safeKeys);
            applySchedulerWhatsAppRuntimeConfig(resolveWhatsAppRuntimeConfig(cfg));

            const hasAiyraConfigUpdate = safeKeys.some((key) =>
              key.startsWith("aiyra_")
            );
            if (hasAiyraConfigUpdate) {
              const prevAiyraConfigDigest = JSON.stringify({
                enabled: aiyraVoiceEnabled,
                appUrl: aiyraAppUrl,
                wakeWord: aiyraWakeWord,
                wakeSensitivity: aiyraWakeSensitivity,
                idleTimeoutMs: aiyraIdleTimeoutMs,
                keywordPath: aiyraKeywordPath || "",
                wakeEngine: aiyraWakeEngine || "",
                aecEnabled: aiyraAecEnabled,
                aecBackend: aiyraAecBackend || "",
                openWakewordThreshold: aiyraOpenWakewordThreshold,
                openWakewordModelPath: aiyraOpenWakewordModelPath || "",
                openWakewordPython: aiyraOpenWakewordPython || "",
                openWakewordScriptPath: aiyraOpenWakewordScriptPath || "",
                openWakewordAllowApproximate:
                  aiyraOpenWakewordAllowApproximate === true,
                micMode: aiyraMicMode,
                micName: aiyraMicName || "",
              });
              const nextAiyraConfig = resolveAiyraRuntimeConfig();
              const nextAiyraConfigDigest = JSON.stringify({
                enabled: nextAiyraConfig.enabled,
                appUrl: nextAiyraConfig.appUrl,
                wakeWord: nextAiyraConfig.wakeWord,
                wakeSensitivity: nextAiyraConfig.wakeSensitivity,
                idleTimeoutMs: nextAiyraConfig.idleTimeoutMs,
                keywordPath: nextAiyraConfig.keywordPath || "",
                wakeEngine: nextAiyraConfig.wakeEngine || "",
                aecEnabled: nextAiyraConfig.aecEnabled,
                aecBackend: nextAiyraConfig.aecBackend || "",
                openWakewordThreshold: nextAiyraConfig.openWakewordThreshold,
                openWakewordModelPath: nextAiyraConfig.openWakewordModelPath || "",
                openWakewordPython: nextAiyraConfig.openWakewordPython || "",
                openWakewordScriptPath: nextAiyraConfig.openWakewordScriptPath || "",
                openWakewordAllowApproximate:
                  nextAiyraConfig.openWakewordAllowApproximate === true,
                micMode: nextAiyraConfig.micMode,
                micName: nextAiyraConfig.micName || "",
              });

              aiyraVoiceEnabled = nextAiyraConfig.enabled;
              aiyraAppUrl = nextAiyraConfig.appUrl;
              aiyraWakeWord = nextAiyraConfig.wakeWord;
              aiyraWakeSensitivity = nextAiyraConfig.wakeSensitivity;
              aiyraIdleTimeoutMs = nextAiyraConfig.idleTimeoutMs;
              aiyraKeywordPath = nextAiyraConfig.keywordPath;
              aiyraWakeEngine = nextAiyraConfig.wakeEngine;
              aiyraAecEnabled = nextAiyraConfig.aecEnabled;
              aiyraAecBackend = nextAiyraConfig.aecBackend;
              aiyraOpenWakewordThreshold = nextAiyraConfig.openWakewordThreshold;
              aiyraOpenWakewordModelPath = nextAiyraConfig.openWakewordModelPath;
              aiyraOpenWakewordPython = nextAiyraConfig.openWakewordPython;
              aiyraOpenWakewordScriptPath = nextAiyraConfig.openWakewordScriptPath;
              aiyraOpenWakewordAllowApproximate =
                nextAiyraConfig.openWakewordAllowApproximate;
              aiyraDeviceIndex = nextAiyraConfig.deviceIndex;
              aiyraMicMode = nextAiyraConfig.micMode;
              aiyraMicName = nextAiyraConfig.micName;
              aiyraPersistedMicMode = nextAiyraConfig.persistedMicMode;
              aiyraPersistedMicName = nextAiyraConfig.persistedMicName;
              aiyraMicSelectionSource = nextAiyraConfig.micSelectionSource;
              aiyraResolvedDeviceName = nextAiyraConfig.resolvedDeviceName;
              aiyraMicSelectionFallbackReason =
                nextAiyraConfig.micSelectionFallbackReason;

              if (prevAiyraConfigDigest !== nextAiyraConfigDigest) {
                const settled = await waitForAiyraRuntimeStartToSettle();
                if (!settled) {
                  runtimeApplyError =
                    "Aiyra runtime update timed out while startup was in progress";
                } else {
                  await stopAiyraVoiceRuntime("config_updated");
                  if (aiyraVoiceEnabled) {
                    const started = await maybeStartAiyraVoiceRuntime();
                    if (!started) {
                      runtimeApplyError =
                        "Aiyra runtime failed to start with current connector config";
                    }
                  } else {
                    noteAiyraVoiceDisabled(
                      "aiyra_voice_disabled",
                      "Aiyra voice runtime disabled in connector config"
                    );
                  }
                }
              }
            }
          } else {
            warn("connector_configure called with no valid updates");
          }

          try {
            ws.send(
              JSON.stringify({
                type: "connector_configure_ack",
                request_id: requestId || undefined,
                ok: !runtimeApplyError,
                applied: safeKeys,
                ...(runtimeApplyError ? { error: runtimeApplyError } : {}),
              })
            );
          } catch {
            // ignore
          }
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          warn("connector_configure failed", error);
          try {
            ws.send(
              JSON.stringify({
                type: "connector_configure_ack",
                request_id: requestId || undefined,
                ok: false,
                error,
              })
            );
          } catch {
            // ignore
          }
        }

        if (msg.restart) {
          // Fall through to restart logic below
          msg.type = "connector_restart";
        } else {
          return;
        }
      }

      // Request from the web UI to restart the connector.
      // Spawns a new instance of itself before exiting to ensure it restarts.
      if (msg.type === "connector_restart") {
        requestProcessRestart("ui_requested");
        return;
      }

      if (msg.type === "connector_update") {
        const hostedRequestId = (process.env.GROOVY_HOSTED_MAC_REQUEST_ID || "").trim();
        log("update requested by UI - downloading latest connector...", {
          requestId: hostedRequestId || null,
        });

        // Hosted Mac: keep existing headless tarball update behavior.
        if (hostedRequestId) {
          shouldReconnect = false;
          try {
            // Best-effort ack so UI/relay can log it.
            ws.send(JSON.stringify({ type: "connector_update_started", ok: true }));
          } catch {}

          try {
            await updateHostedConnectorInPlace();
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            warn("hosted mac: update failed", errMsg);
            try {
              ws.send(JSON.stringify({ type: "connector_update_failed", ok: false, error: errMsg }));
            } catch {}
            // Fall back to restart anyway (maybe tarball already updated but extract failed)
          }

          try {
            ws.close();
          } catch {
            // ignore
          }

          setTimeout(async () => {
            await releaseSingleInstanceLock();
            const { spawn } = await import("child_process");
            const scriptPath = new URL(import.meta.url).pathname;
            const restartArgs = buildRestartArgs();
            const child = spawn(process.execPath, [scriptPath, ...restartArgs], {
              detached: true,
              stdio: "ignore",
              cwd: process.cwd(),
              env: process.env,
            });
            child.unref();
            log("updated instance spawned, exiting...");
            process.exit(0);
          }, 250);
          return;
        }

        try {
          ws.send(JSON.stringify({ type: "connector_update_started", ok: true }));
        } catch {}

        const localUpdateResult = await maybeRunConnectorUpdate({
          force: true,
          source: "relay_request",
        });
        if (!localUpdateResult.ok) {
          const errMsg = String(localUpdateResult.error || localUpdateResult.reason || "local_update_failed");
          warn("local connector update failed", {
            reason: localUpdateResult.reason || "unknown_error",
            error: errMsg,
          });
          try {
            ws.send(JSON.stringify({ type: "connector_update_failed", ok: false, error: errMsg }));
          } catch {}
          return;
        }
        if (!localUpdateResult.updated) {
          log("local connector update: already up to date", {
            currentVersion: localUpdateResult.currentVersion || null,
            latestVersion: localUpdateResult.latestVersion || null,
          });
          return;
        }

        handoffToUpdatedProcess();
        return;
      }

      if (msg.type === "workspace_pick") {
        const requestId = String(msg.request_id || "");
        log("workspace_pick received", { requestId });
        if (!requestId) {
          warn("workspace_pick: missing request_id");
          return;
        }
        log("workspace_pick: opening folder picker...");
        const picked = await pickFolder();
        log("workspace_pick: picker result", { ok: picked.ok, error: picked.error, path: picked.path });
        if (!picked.ok) {
          ws.send(
            JSON.stringify({
              type: "workspace_pick_result",
              request_id: requestId,
              ok: false,
              error: picked.error || "cancelled",
            })
          );
          return;
        }
        ws.send(
          JSON.stringify({
            type: "workspace_pick_result",
            request_id: requestId,
            ok: true,
            root_path: picked.path,
          })
        );
        log("workspace_pick: sent result to relay");
        return;
      }

      if (msg.type === "terminal_open") {
        const requestId = String(msg.request_id || "");
        const terminalId = String(msg.terminal_id || "");
        // Default to $HOME if no cwd provided (allows scan-only terminals)
        const cwd = String(msg.cwd || "") || process.env.HOME || os.homedir() || "/";
        const startClaude = msg.start_claude !== false;
        const persist = msg.persist !== false; // default true

        if (!requestId || !terminalId) {
          warn("terminal_open missing fields");
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "terminal_open_failed",
                request_id: requestId || "",
                terminal_id: terminalId || "",
                error: "terminal_open_missing_fields",
              })
            );
          }
          return;
        }

        if (terminals.has(terminalId)) {
          warn("terminal already exists:", terminalId);
          // Never leave the relay/browser hanging.
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "terminal_open_failed",
                request_id: requestId,
                terminal_id: terminalId,
                error: "terminal_id_in_use",
              })
            );
          }
          return;
        }

        const requestedCwd = cwd.trim();
        const safeCwd = isDirectory(requestedCwd) ? requestedCwd : os.homedir();
        if (safeCwd !== requestedCwd) {
          warn("requested cwd is not a directory; falling back", {
            requestedCwd,
            safeCwd,
          });
        }

        const shells = uniqueStrings(getPtyShellCandidates()).filter((s) => isExecutable(s));

        let p = null;
        let lastErr = null;
        for (const shell of shells) {
          try {
            ensureNodePtySpawnHelperExecutable();
            p = pty.spawn(shell, getPtyShellArgs(shell), {
              name: "xterm-256color",
              cols: 120,
              rows: 30,
              cwd: safeCwd,
              env: buildSanitizedEnv(safeCwd),
            });
            break;
          } catch (err) {
            lastErr = err;
            warn("pty.spawn failed; trying next shell", {
              shell,
              cwd: safeCwd,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (!p) {
          const error =
            lastErr instanceof Error ? lastErr.message : String(lastErr || "spawn_failed");
          ws.send(
            JSON.stringify({
              type: "terminal_open_failed",
              request_id: requestId,
              terminal_id: terminalId,
              error,
              cwd: safeCwd,
            })
          );
          return;
        }

        terminals.set(terminalId, p);
        terminalMeta.set(terminalId, { persist });
        terminalLocalBuffers.set(terminalId, "");

        p.onData((data) => {
          appendTerminalLocalBuffer(terminalId, data);
          const chans = webrtcChannelsByTerminal.get(terminalId);
          if (chans && chans.size > 0) {
            for (const dc of Array.from(chans)) {
              if (!dc || dc.readyState !== "open") {
                chans.delete(dc);
                continue;
              }
              try {
                dc.send(data);
              } catch {
                chans.delete(dc);
              }
            }
            if (chans.size === 0) webrtcChannelsByTerminal.delete(terminalId);
          }

          // Always send via relay as well; the relay filters WS output for browsers
          // that have an active WebRTC DataChannel to avoid duplicates, while still
          // supporting WS-only clients as fallback.
          const outWs = activeRelayWs;
          if (outWs && outWs.readyState === WebSocket.OPEN) {
            outWs.send(JSON.stringify({ type: "terminal_data", terminal_id: terminalId, data }));
          }
        });

        p.onExit(() => {
          terminals.delete(terminalId);
          terminalMeta.delete(terminalId);
          terminalLocalBuffers.delete(terminalId);
          const chans = webrtcChannelsByTerminal.get(terminalId);
          if (chans) {
            for (const dc of chans) {
              try {
                dc.close();
              } catch {
                // ignore
              }
            }
            webrtcChannelsByTerminal.delete(terminalId);
          }
          for (const [wid, sess] of webrtcPeers.entries()) {
            if (sess.terminalId === terminalId) {
              try {
                sess.dc?.close();
              } catch {}
              try {
                sess.pc?.close();
              } catch {}
              webrtcPeers.delete(wid);
            }
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "terminal_closed", terminal_id: terminalId }));
          }
        });

        ws.send(
          JSON.stringify({
            type: "terminal_opened",
            request_id: requestId,
            terminal_id: terminalId,
          })
        );

        if (startClaude) {
          // Use --allowedTools "All" to auto-accept tool permissions and skip interactive prompts
          p.write(`${buildClaudeStartCommand()}\r`);
        }
        return;
      }

      if (msg.type === "terminal_input") {
        const terminalId = String(msg.terminal_id || "");
        const data = String(msg.data || "");
        console.log("[connector] terminal_input:", terminalId, "data:", JSON.stringify(data));
        const p = terminals.get(terminalId);
        if (!p) {
          console.log("[connector] terminal not found:", terminalId);
          return;
        }
        p.write(data);
        console.log("[connector] wrote to pty");
        return;
      }

      if (msg.type === "terminal_resize") {
        const terminalId = String(msg.terminal_id || "");
        const cols = Number(msg.cols || 0);
        const rows = Number(msg.rows || 0);
        const p = terminals.get(terminalId);
        if (!p || !cols || !rows) return;
        try {
          p.resize(cols, rows);
        } catch {
          // ignore
        }
        return;
      }

      if (msg.type === "terminal_close") {
        const terminalId = String(msg.terminal_id || "");
        const p = terminals.get(terminalId);
        if (!p) return;
        terminals.delete(terminalId);
        terminalMeta.delete(terminalId);
        terminalLocalBuffers.delete(terminalId);
        try {
          p.kill();
        } catch {
          // ignore
        }
        return;
      }

      // ===== Non-interactive terminal execution =====
      if (msg.type === "terminal_exec") {
        const requestId = String(msg.request_id || "");
        const command = String(msg.command || "").trim();
        const cwdRaw = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd.trim() : os.homedir();
        const timeoutMs = Number.isFinite(Number(msg.timeout_ms)) ? Number(msg.timeout_ms) : 10 * 60 * 1000;
        const maxOutputChars = Number.isFinite(Number(msg.max_output_chars)) ? Number(msg.max_output_chars) : 40_000;
        const extraEnv = msg.env && typeof msg.env === "object" ? msg.env : null;

        const startedAt = Date.now();
        let ok = true;
        let exitCode = 0;
        let stdout = "";
        let stderr = "";
        let errorText = null;

        if (!command) {
          ok = false;
          exitCode = 1;
          errorText = "missing_command";
        } else {
          try {
            const safeCwd = cwdRaw || os.homedir();
            const env = mergeExtraEnv(buildSanitizedEnv(safeCwd), extraEnv);
            const { stdout: out, stderr: err } = await execPortableCommand(command, {
              cwd: safeCwd,
              env,
              timeout: Math.max(1000, timeoutMs),
              maxBuffer: 5 * 1024 * 1024,
            });
            stdout = typeof out === "string" ? out : String(out || "");
            stderr = typeof err === "string" ? err : String(err || "");
          } catch (e) {
            ok = false;
            const err = e && typeof e === "object" ? e : null;
            const code = err && "code" in err ? Number(err.code) : NaN;
            exitCode = Number.isFinite(code) ? code : 1;
            errorText = err && "message" in err ? String(err.message) : "command_failed";
            stdout = err && "stdout" in err ? String(err.stdout || "") : "";
            stderr = err && "stderr" in err ? String(err.stderr || "") : "";
          }
        }

        // Truncate output deterministically (tail) to keep payload sane
        const maxChars = Math.max(1000, maxOutputChars);
        if (stdout.length + stderr.length > maxChars) {
          const half = Math.floor(maxChars / 2);
          stdout = stdout.length > half ? stdout.slice(-half) : stdout;
          const remaining = Math.max(0, maxChars - stdout.length);
          stderr = stderr.length > remaining ? stderr.slice(-remaining) : stderr;
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "terminal_exec_result",
              request_id: requestId,
              ok,
              exit_code: exitCode,
              stdout,
              stderr,
              error: errorText,
              duration_ms: Math.max(0, Date.now() - startedAt),
            })
          );
        }
        return;
      }

      // ===== Claude Code CLI discovery =====
      if (msg.type === "claude_discover_commands") {
        const requestId = String(msg.request_id || "");
        const cwdRaw =
          typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd.trim() : os.homedir();
        const apiKey = typeof msg.api_key === "string" ? msg.api_key.trim() : "";
        const cliToken = typeof msg.cli_token === "string" ? msg.cli_token.trim() : "";
        const timeoutMs = Number.isFinite(Number(msg.timeout_ms))
          ? Number(msg.timeout_ms)
          : 20 * 1000;
        const claudeBin = resolveClaudeBin();
        const startedAt = Date.now();
        let ok = true;
        let errorText = null;
        let commands = [];

        log("claude_discover_commands received", {
          requestId,
          cwd: cwdRaw,
          timeoutMs,
        });
        const discovery = await discoverClaudeSlashCommands({
          requestId,
          cwdRaw,
          apiKey,
          cliToken,
          timeoutMs,
          claudeBin,
        });
        ok = discovery.ok;
        errorText = discovery.errorText;
        commands = discovery.commands;

        if (ws.readyState === WebSocket.OPEN) {
          log("claude_discover_commands sending result", {
            requestId,
            ok,
            error: errorText,
            commandsCount: commands.length,
            durationMs: Math.max(0, Date.now() - startedAt),
          });
          ws.send(
            JSON.stringify({
              type: "claude_discover_commands_result",
              request_id: requestId,
              ok,
              commands,
              error: errorText,
              duration_ms: Math.max(0, Date.now() - startedAt),
              discovered_at: new Date().toISOString(),
            })
          );
        }
        return;
      }

      // ===== Claude Code CLI — cancel a running task =====
      if (msg.type === "claude_run_cancel") {
        const requestId = String(msg.request_id || "");
        const targetRequestId = String(msg.target_request_id || "").trim();
        const targetAgentId = String(msg.agent_id || "").trim();
        const cancelAllForAgent = msg.cancel_all_for_agent === true;

        if (!targetRequestId && !(cancelAllForAgent && targetAgentId)) {
          if (ws.readyState === WebSocket.OPEN && requestId) {
            ws.send(JSON.stringify({
              type: "claude_run_cancel_result",
              request_id: requestId,
              ok: false,
              error: "missing_cancel_target",
            }));
          }
          return;
        }

        const canceledRequestIds = new Set();
        const abortRun = (runRequestId, entry) => {
          if (!runRequestId || canceledRequestIds.has(runRequestId)) return;
          try {
            if (abortPendingClaudeRun(entry)) {
              canceledRequestIds.add(runRequestId);
            }
          } catch {
            // ignore
          }
        };

        if (targetRequestId) {
          abortRun(targetRequestId, pendingClaudeRuns.get(targetRequestId));
        }

        if (cancelAllForAgent && targetAgentId) {
          for (const [runRequestId, entry] of pendingClaudeRuns.entries()) {
            if (entry?.agentId === targetAgentId) {
              abortRun(runRequestId, entry);
            }
          }
        }

        if (canceledRequestIds.size > 0) {
          log("claude_run_cancel aborted runs", {
            targetRequestId: targetRequestId || null,
            targetAgentId: targetAgentId || null,
            canceled: canceledRequestIds.size,
            requestIds: Array.from(canceledRequestIds),
          });
        }
        if (ws.readyState === WebSocket.OPEN && requestId) {
          ws.send(JSON.stringify({
            type: "claude_run_cancel_result",
            request_id: requestId,
            ok: true,
            canceled: canceledRequestIds.size,
            canceled_request_ids: Array.from(canceledRequestIds),
            target_request_id: targetRequestId,
            agent_id: targetAgentId || null,
          }));
        }
        return;
      }

      // ===== Claude Code CLI (headless, non-interactive) =====
      // Supports streaming via --output-format stream-json and explicit conversation resume via --resume
      if (msg.type === "claude_run") {
        const requestId = String(msg.request_id || "");
        const prompt = String(msg.prompt || "").trim();
        const cwdRaw = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd.trim() : os.homedir();
        const apiKey = typeof msg.api_key === "string" ? msg.api_key.trim() : "";
        const cliToken = typeof msg.cli_token === "string" ? msg.cli_token.trim() : "";
        const codeProvider = typeof msg.provider === "string" ? msg.provider.trim() : "claude";
        const agentId = typeof msg.agent_id === "string" ? msg.agent_id.trim() : "";
        const requestedAllowedTools =
          typeof msg.allowed_tools === "string" ? msg.allowed_tools.trim() : "Read,Edit,Bash";
        const timeoutMs = Number.isFinite(Number(msg.timeout_ms)) ? Number(msg.timeout_ms) : 15 * 60 * 1000;
        const sessionId = typeof msg.session_id === "string" ? msg.session_id.trim() : "";
        const planMode = msg.plan_mode === true;
        const requestedModel = typeof msg.model === "string" ? msg.model.trim() : "";
        const billingBillable =
          msg.billing_billable === true ? true : msg.billing_billable === false ? false : undefined;
        const billingChargeType =
          typeof msg.billing_charge_type === "string" ? msg.billing_charge_type.trim() : "";
        const billingAuthOrigin =
          typeof msg.billing_auth_origin === "string" ? msg.billing_auth_origin.trim() : "";
        const billingAuthMethod =
          typeof msg.billing_auth_method === "string" ? msg.billing_auth_method.trim() : "";
        const defaultClaudeModel = (() => {
          const envModel = [
            process.env.GROOVY_CODE_CLI_MODEL,
            process.env.GROOVY_CLAUDE_CLI_MODEL,
          ]
            .map((v) => (typeof v === "string" ? v.trim() : ""))
            .find((v) => !!v) || "";
          return envModel || "claude-opus-4-7";
        })();
        const resolveDefaultCodexModel = () => {
          const legacyOverride = (process.env.GROOVY_CODEX_CLI_MODEL || "").trim();
          if (apiKey) {
            return (
              (process.env.GROOVY_CODEX_CLI_API_MODEL || "").trim() ||
              legacyOverride ||
              "gpt-5.5"
            );
          }
          return (
            (process.env.GROOVY_CODEX_CLI_CHATGPT_MODEL || "").trim() ||
            legacyOverride ||
            "gpt-5.5"
          );
        };
        const defaultCodexModel = resolveDefaultCodexModel();
        const cliModel = requestedModel || (codeProvider === "codex" ? defaultCodexModel : defaultClaudeModel);
        const claudeBin = codeProvider !== "codex" ? resolveClaudeBin() : null;
        const codexBin = codeProvider === "codex" ? resolveCodexBin() : null;

        const startedAt = Date.now();
        let ok = true;
        let result = null;
        let errorText = null;
        let timedOut = false;
        let aborted = false;
        let partial = false;
        let exitCode = null;
        let exitSignal = null;
        let hadResultEvent = false;

        // Determine auth method: cli_token (OAuth) takes priority over api_key.
        // Codex can also use the connector machine's cached `codex login`
        // credentials when no explicit API key is supplied.
        const useCliToken = codeProvider !== "codex" && !!cliToken;
        const authMethod = codeProvider === "codex"
          ? (apiKey ? "api_key" : "local_codex_login")
          : (useCliToken ? "cli_token" : "api_key");
        log("claude_run auth", {
          method: authMethod,
          provider: codeProvider,
          source: codeProvider === "codex"
            ? (apiKey ? "provided" : "local")
            : (useCliToken ? "user" : (apiKey ? "provided" : "missing")),
          hasCliToken: !!cliToken,
          hasApiKey: !!apiKey,
        });

        if (prompt === CLAUDE_SLASH_DISCOVERY_COMPAT_PROMPT) {
          const discovery = await discoverClaudeSlashCommands({
            requestId,
            cwdRaw,
            apiKey,
            cliToken,
            timeoutMs,
            claudeBin,
          });
          const compatResultText = discovery.ok
            ? `${CLAUDE_SLASH_DISCOVERY_RESULT_PREFIX}${JSON.stringify({
                commands: discovery.commands,
              })}`
            : "";
          log("claude_run compat slash discovery result", {
            requestId,
            ok: discovery.ok,
            error: discovery.errorText,
            commandsCount: Array.isArray(discovery.commands) ? discovery.commands.length : 0,
            durationMs: discovery.durationMs,
          });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "claude_run_result",
                request_id: requestId,
                ok: discovery.ok,
                result: compatResultText,
                error: discovery.errorText,
                duration_ms: discovery.durationMs,
              })
            );
          }
          return;
        } else if (!prompt) {
          ok = false;
          errorText = "missing_prompt";
        } else if (codeProvider !== "codex" && !apiKey && !cliToken) {
          ok = false;
          errorText = "missing_api_key_or_cli_token";
        } else {
          try {
            const homeDir = os.homedir();
            const expandTilde = (p) => {
              if (typeof p !== "string") return homeDir;
              const s = p.trim();
              if (s === "~") return homeDir;
              if (s.startsWith("~/")) return path.join(homeDir, s.slice(2));
              return s;
            };
            const normalizeSiteSlug = (input) => {
              return String(input || "")
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 60);
            };
            const extractGroovySiteSlug = (text) => {
              const normalized = String(text || "").replace(/\\/g, "/");
              const m = normalized.match(/\/\.groovy\/sites\/([a-z0-9][a-z0-9-]{0,80})/i);
              if (!m) return "";
              return normalizeSiteSlug(m[1]);
            };

            const requestedCwdExpanded = expandTilde(cwdRaw || homeDir);
            let safeCwd = isDirectory(requestedCwdExpanded) ? requestedCwdExpanded : "";

            // If cwd is invalid, but this looks like a Groovy site task, force it into
            // the canonical local sites directory under the current user's home.
            if (!safeCwd) {
              const slug =
                extractGroovySiteSlug(requestedCwdExpanded) || extractGroovySiteSlug(prompt);
              if (slug) {
                const canonicalSiteCwd = path.join(homeDir, ".groovy", "sites", slug);
                try {
                  await fsp.mkdir(canonicalSiteCwd, { recursive: true });
                } catch {
                  // ignore
                }
                if (isDirectory(canonicalSiteCwd)) {
                  safeCwd = canonicalSiteCwd;
                }
              }
            }

            if (!safeCwd) safeCwd = homeDir;

            const siteWorkspaceRoot = path.join(homeDir, ".groovy", "sites");
            const siteRootWithSep = `${siteWorkspaceRoot}${path.sep}`;
            const isSiteWorkspace =
              safeCwd === siteWorkspaceRoot || safeCwd.startsWith(siteRootWithSep);
            const safeCwdResolved = path.resolve(safeCwd);
            let safeCwdReal = safeCwdResolved;
            try {
              safeCwdReal = fs.realpathSync.native(safeCwdResolved);
            } catch {
              // Keep the resolved path when realpath is unavailable.
            }
            const resolveWorkspacePath = (candidatePath) => {
              try {
                const raw = String(candidatePath || "").trim();
                if (!raw) return "";
                // Claude tool events often return relative file paths (e.g. "src/app/page.tsx").
                // Resolve those against the active workspace, not the connector process cwd.
                return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(safeCwd, raw);
              } catch {
                return "";
              }
            };
            const isPathInsideCwd = (candidatePath) => {
              try {
                const abs = resolveWorkspacePath(candidatePath);
                if (!abs) return false;
                const root = safeCwdResolved;
                const cwdWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
                if (abs === root || abs.startsWith(cwdWithSep)) return true;
                let realAbs = abs;
                try {
                  realAbs = fs.realpathSync.native(abs);
                } catch {
                  // New/deleted paths may not have a realpath yet.
                }
                const realRoot = safeCwdReal;
                const realCwdWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
                return realAbs === realRoot || realAbs.startsWith(realCwdWithSep);
              } catch {
                return false;
              }
            };
            const workspaceRelativePath = (candidatePath) => {
              try {
                const abs = resolveWorkspacePath(candidatePath);
                if (!abs) return "";
                const root = safeCwdResolved;
                const cwdWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
                if (abs === root || abs.startsWith(cwdWithSep)) {
                  const rel = path.relative(root, abs).split(path.sep).join("/");
                  return rel && !rel.startsWith("../") && rel !== ".." ? rel : "";
                }
                let realAbs = abs;
                try {
                  realAbs = fs.realpathSync.native(abs);
                } catch {
                  // New/deleted paths may not have a realpath yet.
                }
                const realRoot = safeCwdReal;
                const realCwdWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
                if (realAbs === realRoot || realAbs.startsWith(realCwdWithSep)) {
                  const rel = path.relative(realRoot, realAbs).split(path.sep).join("/");
                  return rel && !rel.startsWith("../") && rel !== ".." ? rel : "";
                }
                return "";
              } catch {
                return "";
              }
            };
            const captureFileFingerprint = (absPath) => {
              try {
                const stat = fs.statSync(absPath);
                if (!stat.isFile()) {
                  return {
                    exists: true,
                    isFile: false,
                    size: Number(stat.size || 0),
                    mtimeMs: Number(stat.mtimeMs || 0),
                    hash: "",
                  };
                }
                const buf = fs.readFileSync(absPath);
                return {
                  exists: true,
                  isFile: true,
                  size: Number(stat.size || 0),
                  mtimeMs: Number(stat.mtimeMs || 0),
                  hash: createHash("sha256").update(buf).digest("hex"),
                };
              } catch {
                return {
                  exists: false,
                  isFile: false,
                  size: 0,
                  mtimeMs: 0,
                  hash: "",
                };
              }
            };
            const didFingerprintChange = (before, after) => {
              if (!before || typeof before !== "object") return false;
              if (!after || typeof after !== "object") return false;
              if (!!before.exists !== !!after.exists) return true;
              if (!before.exists && !after.exists) return false;
              const beforeHash = typeof before.hash === "string" ? before.hash : "";
              const afterHash = typeof after.hash === "string" ? after.hash : "";
              if (beforeHash && afterHash) return beforeHash !== afterHash;
              return (
                Number(before.size || 0) !== Number(after.size || 0) ||
                Number(before.mtimeMs || 0) !== Number(after.mtimeMs || 0) ||
                !!before.isFile !== !!after.isFile
              );
            };
            const normalizeGitRelPath = (value) =>
              String(value || "")
                .trim()
                .replace(/\\/g, "/")
                .replace(/^\.\/+/, "");
            const parseGitStatusPaths = (statusText) => {
              const paths = [];
              const entries = String(statusText || "").split("\u0000");
              for (let i = 0; i < entries.length; i += 1) {
                const entry = entries[i];
                if (!entry) continue;
                const status = entry.slice(0, 2);
                const rel = normalizeGitRelPath(entry.slice(3));
                if (rel) paths.push(rel);
                if (status.includes("R") || status.includes("C")) {
                  const oldRel = normalizeGitRelPath(entries[i + 1] || "");
                  if (oldRel) paths.push(oldRel);
                  i += 1;
                }
              }
              return Array.from(new Set(paths)).filter(
                (rel) => rel && !rel.startsWith("../") && rel !== ".."
              );
            };
            const captureGitStatusSnapshot = (label = "snapshot") => {
              try {
                const inside = execFileSync("git", ["-C", safeCwd, "rev-parse", "--is-inside-work-tree"], {
                  encoding: "utf8",
                  timeout: 3000,
                  maxBuffer: 1024 * 1024,
                }).trim();
                if (inside !== "true") return { available: false, paths: new Set(), fingerprints: new Map() };

                const statusText = execFileSync(
                  "git",
                  ["-C", safeCwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
                  {
                    encoding: "utf8",
                    timeout: 5000,
                    maxBuffer: 5 * 1024 * 1024,
                  }
                );
                const paths = parseGitStatusPaths(statusText).slice(0, 1000);
                const fingerprints = new Map();
                for (const rel of paths) {
                  fingerprints.set(rel, captureFileFingerprint(path.resolve(safeCwd, rel)));
                }
                return {
                  available: true,
                  label,
                  truncated: paths.length >= 1000,
                  paths: new Set(paths),
                  fingerprints,
                };
              } catch {
                return { available: false, paths: new Set(), fingerprints: new Map() };
              }
            };
            const collectGitTouchedPathsSinceSnapshot = (snapshot) => {
              if (!snapshot?.available) return [];
              const after = captureGitStatusSnapshot("after");
              if (!after.available) return [];
              const touched = [];
              for (const rel of after.paths) {
                if (!snapshot.paths.has(rel)) {
                  touched.push(rel);
                  continue;
                }
                const beforeFingerprint = snapshot.fingerprints.get(rel);
                const afterFingerprint = after.fingerprints.get(rel);
                if (didFingerprintChange(beforeFingerprint, afterFingerprint)) {
                  touched.push(rel);
                }
              }
              return Array.from(new Set(touched));
            };
            const preRunFileFingerprints = new Map();
            const maybeCapturePreRunFingerprint = (rawFilePath) => {
              const abs = resolveWorkspacePath(rawFilePath);
              if (!abs) return;
              if (!isPathInsideCwd(abs)) return;
              if (preRunFileFingerprints.has(abs)) return;
              preRunFileFingerprints.set(abs, captureFileFingerprint(abs));
            };
            const preRunGitSnapshot = captureGitStatusSnapshot("before");

            // Hard guardrail for generated sites:
            // - keep a full toolset for scaffold + edits
            // - enforce an organized one-pass workflow to avoid verification loops
            const allowedTools = isSiteWorkspace ? "Read,Edit,Bash,Write" : requestedAllowedTools;
            const promptGuard =
              isSiteWorkspace &&
              !prompt.includes("STRICT SITE MODE:")
                ? `\n\nSTRICT SITE MODE:\n` +
                  `- Workspace: ${safeCwd}\n` +
                  `- Use app/* as the ONLY app-router root (do NOT use src/app/*)\n` +
                  `- If package.json is missing, scaffold once using Next.js template via Bash:\n` +
                  `  npx create-next-app@latest . --js --app --use-npm --eslint --yes --no-tailwind --no-src-dir\n` +
                  `- Then apply requested edits in one pass\n` +
                  `- Avoid repeated ls/find/cat/read verification loops\n` +
                  `- After edits, return completion summary; do not keep re-checking files`
                : "";
            const effectivePrompt = `${prompt}${promptGuard}`;
            if (safeCwd !== requestedCwdExpanded) {
              warn("claude_run requested cwd is invalid; resolved to safe cwd", {
                requestedCwd: cwdRaw,
                requestedCwdExpanded,
                safeCwd,
              });
            }
            
            log("claude_run starting", {
              cwd: safeCwd,
              promptLen: effectivePrompt.length,
              model: cliModel,
              claudeBin,
              allowedTools,
              planMode,
              sessionId: sessionId ? sessionId.slice(0, 8) + "..." : null,
            });

            const summarizeLiveToolUse = (toolName, input) => {
              if (!input || typeof input !== "object") return "";
              const clip = (value, maxLen = 320) => {
                const text = String(value || "").trim();
                if (!text) return "";
                return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
              };
              const clipInline = (value, maxLen = 220) =>
                clip(String(value || "").replace(/\s+/g, " "), maxLen);
              const numeric = (value) => {
                const n = Number(value);
                return Number.isFinite(n) ? n : null;
              };

              try {
                switch (toolName) {
                  case "Bash": {
                    const description =
                      typeof input.description === "string" ? clipInline(input.description, 140) : "";
                    const command = typeof input.command === "string" ? clip(input.command, 500) : "";
                    if (description && command) return `${description}\n$ ${command}`;
                    if (command) return `$ ${command}`;
                    return description;
                  }
                  case "Read": {
                    const filePath =
                      typeof input.file_path === "string" ? clip(input.file_path, 240) : "";
                    const offset = numeric(input.offset);
                    const limit = numeric(input.limit);
                    const rangeBits = [
                      offset !== null ? `offset=${offset}` : "",
                      limit !== null ? `limit=${limit}` : "",
                    ].filter(Boolean);
                    return [filePath, rangeBits.length > 0 ? `(${rangeBits.join(", ")})` : ""]
                      .filter(Boolean)
                      .join(" ");
                  }
                  case "Edit":
                  case "Write":
                    return typeof input.file_path === "string" ? clip(input.file_path, 240) : "";
                  case "Grep":
                  case "Glob":
                    return clipInline(
                      [
                        input.pattern ? `pattern=${input.pattern}` : "",
                        input.path ? `path=${input.path}` : "",
                      ]
                        .filter(Boolean)
                        .join(" "),
                      240
                    );
                  case "Task":
                    return typeof input.description === "string"
                      ? clipInline(input.description, 180)
                      : "";
                  case "TodoWrite": {
                    const count = Array.isArray(input.todos) ? input.todos.length : 0;
                    return count > 0 ? `${count} todo item${count === 1 ? "" : "s"}` : "Update todo list";
                  }
                  default: {
                    const keys = Object.keys(input).slice(0, 4);
                    const preview = keys
                      .map((key) => `${key}=${clipInline(input[key], 60)}`)
                      .filter(Boolean)
                      .join(" ");
                    return clipInline(preview, 240);
                  }
                }
              } catch {
                return "";
              }
            };

            const claudeRunAbort = new AbortController();
            pendingClaudeRuns.set(requestId, {
              abortController: claudeRunAbort,
              agentId,
              sessionId,
              provider: codeProvider,
              startedAtMs: startedAt,
            });

            let spawnResult;
            try {
              const sharedStreamCallbacks = {
                onAssistantText: (assistantText) => {
                  if (!assistantText || ws.readyState !== WebSocket.OPEN) return;
                  ws.send(
                    JSON.stringify({
                      type: "claude_run_progress",
                      request_id: requestId,
                      content: assistantText,
                      event_type: "assistant",
                    })
                  );
                },
                onStreamEvent: (event) => {
                  if (!event || event.type !== "assistant" || !event.message?.content) return;
                  for (const block of event.message.content) {
                    if (block?.type !== "tool_use") continue;
                    // Pre-capture fingerprints for Edit/Write
                    if (block?.name === "Edit" || block?.name === "Write") {
                      const filePath = block?.input?.file_path;
                      if (typeof filePath === "string" && filePath.trim()) {
                        maybeCapturePreRunFingerprint(filePath);
                      }
                    }
                    // Forward tool_use to dashboard for live display
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(
                        JSON.stringify({
                          type: "claude_run_progress",
                          request_id: requestId,
                          event_type: "tool_use",
                          tool_name: block.name || "unknown",
                          tool_input: summarizeLiveToolUse(block.name, block.input),
                        })
                      );
                    }
                  }
                },
              };

              if (codeProvider === "codex") {
                spawnResult = await runHeadlessCodex({
                  prompt: effectivePrompt,
                  cwd: safeCwd,
                  timeoutMs,
                  codexBin,
                  model: cliModel,
                  sessionId: sessionId || undefined,
                  apiKey: apiKey || undefined,
                  planMode,
                  abortSignal: claudeRunAbort.signal,
                  ...sharedStreamCallbacks,
                });
              } else {
                spawnResult = await runHeadlessClaude({
                  prompt: effectivePrompt,
                  cwd: safeCwd,
                  timeoutMs,
                  claudeBin,
                  model: cliModel,
                  allowedTools: allowedTools || undefined,
                  planMode,
                  sessionId: sessionId || undefined,
                  cliToken: useCliToken ? cliToken : undefined,
                  apiKey: useCliToken ? undefined : apiKey,
                  abortSignal: claudeRunAbort.signal,
                  ...sharedStreamCallbacks,
                });
              }
            } finally {
              const current = pendingClaudeRuns.get(requestId);
              if (getPendingClaudeRunAbortController(current) === claudeRunAbort) {
                pendingClaudeRuns.delete(requestId);
              }
            }

            // Extract final result from stream-json output
            // The last event with type "result" contains the final response
            let streamEvents = spawnResult.streamEvents || [];

            // Fallback: if incremental parsing missed events (e.g. due to chunk
            // splitting before the line-buffer fix), re-parse the complete stdout.
            // We use a Set of serialised events to avoid duplicates.
            if (spawnResult.stdout) {
              const seen = new Set(streamEvents.map(e => JSON.stringify(e)));
              const fullLines = spawnResult.stdout.split("\n").filter(l => l.trim());
              let recovered = 0;
              for (const line of fullLines) {
                try {
                  const event = JSON.parse(line.trim());
                  const key = JSON.stringify(event);
                  if (!seen.has(key)) {
                    streamEvents.push(event);
                    seen.add(key);
                    recovered++;
                  }
                } catch {
                  // skip non-JSON lines
                }
              }
              if (recovered > 0) {
                log("claude_run recovered events from full stdout re-parse", { recovered });
              }
            }

            const resultEvents = streamEvents.filter((e) => e && e.type === "result");
            const resultEvent = resultEvents.length > 0 ? resultEvents[resultEvents.length - 1] : null;
            hadResultEvent = !!resultEvent;
            exitCode = typeof spawnResult.code === "number" ? spawnResult.code : null;
            exitSignal = typeof spawnResult.signal === "string" ? spawnResult.signal : null;
            timedOut = spawnResult.timedOut === true;
            aborted = spawnResult.aborted === true;
            
            // Extract diffs from tool use events (file edits)
            const diffs = [];
            // Track intended writes so we can verify they actually landed on disk.
            const writeTargets = [];
            // Fallback text when result.result is empty/missing.
            let latestAssistantText = "";
            
            // Debug: log stream event types and structure
            log("claude_run stream events", {
              eventTypeCounts: streamEvents.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {}),
              eventSample: streamEvents.slice(0, 3).map(e => ({
                type: e.type,
                hasMessage: !!e.message,
                contentTypes: e.message?.content?.map(c => c.type) || [],
              })),
            });
            
            for (const event of streamEvents) {
              // Look for tool_result events that contain file content
              if (event.type === "assistant" && event.message?.content) {
                const assistantBlocks = Array.isArray(event.message.content) ? event.message.content : [];
                const assistantText = assistantBlocks
                  .filter((block) => block?.type === "text" && typeof block?.text === "string")
                  .map((block) => block.text)
                  .join("")
                  .trim();
                if (assistantText) {
                  latestAssistantText = assistantText;
                }
                for (const block of assistantBlocks) {
                  // Debug log block types
                  if (block.type === "tool_use" || block.type === "tool_result") {
                    log("claude_run tool block", {
                      type: block.type,
                      name: block.name,
                      hasInput: !!block.input,
                      inputKeys: block.input ? Object.keys(block.input) : [],
                    });
                  }
                  
                  // Look for tool_result blocks that might contain diffs
                  if (block.type === "tool_result" && block.content) {
                    // Check if it looks like a diff (has +/- lines)
                    const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
                    if (content.includes("--- ") && content.includes("+++ ")) {
                      diffs.push(content);
                    }
                  }
                  // Also look for text blocks that might contain diffs
                  if (block.type === "text" && block.text) {
                    // Extract any ```diff blocks
                    const diffMatch = block.text.match(/```diff\n([\s\S]*?)```/g);
                    if (diffMatch) {
                      diffs.push(...diffMatch.map(m => m.replace(/```diff\n?/, '').replace(/```$/, '').trim()));
                    }
                  }
                  
                  // Look for Edit tool usage - extract file path and content
                  if (block.type === "tool_use" && block.name === "Edit" && block.input) {
                    const { file_path, old_string, new_string } = block.input;
                    if (file_path && old_string !== undefined && new_string !== undefined) {
                      // Create a simple diff representation
                      const simpleDiff = `--- a/${file_path}\n+++ b/${file_path}\n@@ edit @@\n-${old_string.split('\n').join('\n-')}\n+${new_string.split('\n').join('\n+')}`;
                      diffs.push(simpleDiff);
                      writeTargets.push({
                        kind: "edit",
                        filePath: String(file_path),
                        oldString: String(old_string),
                        newString: String(new_string),
                      });
                      log("claude_run extracted Edit diff", { file_path, diffLen: simpleDiff.length });
                    }
                  }
                  
                  // Look for Write tool usage
                  if (block.type === "tool_use" && block.name === "Write" && block.input) {
                    const { file_path, content } = block.input;
                    if (file_path && content) {
                      // For Write, show as new file
                      const writeDiff = `--- /dev/null\n+++ b/${file_path}\n@@ new file @@\n+${content.split('\n').join('\n+')}`;
                      diffs.push(writeDiff);
                      writeTargets.push({
                        kind: "write",
                        filePath: String(file_path),
                        content: String(content),
                      });
                      log("claude_run extracted Write diff", { file_path, diffLen: writeDiff.length });
                    }
                  }
                }
              }
            }

            const extractDiffFilePath = (diffText) => {
              try {
                const text = String(diffText || "");
                const added = text.match(/\+\+\+ b\/([^\n]+)/);
                if (added) return added[1];
                const removed = text.match(/--- a\/([^\n]+)/);
                return removed ? removed[1] : "";
              } catch {
                return "";
              }
            };

            const splitUnifiedDiffs = (diffText) => {
              const chunks = [];
              let current = [];
              for (const line of String(diffText || "").split("\n")) {
                if (line.startsWith("diff --git ") && current.length > 0) {
                  const chunk = current.join("\n").trim();
                  if (chunk) chunks.push(chunk);
                  current = [line];
                } else {
                  current.push(line);
                }
              }
              const finalChunk = current.join("\n").trim();
              if (finalChunk) chunks.push(finalChunk);
              return chunks.length > 0 ? chunks : [];
            };

            const buildNewFileDiff = (relPath, absPath) => {
              try {
                const stat = fs.statSync(absPath);
                if (!stat.isFile() || stat.size > 1024 * 1024) return "";
                const content = fs.readFileSync(absPath, "utf8");
                if (content.includes("\u0000")) return "";
                if (!content) return `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +0,0 @@`;
                const lines = content.endsWith("\n")
                  ? content.slice(0, -1).split("\n")
                  : content.split("\n");
                const body = lines.map((line) => `+${line}`).join("\n");
                return `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
              } catch {
                return "";
              }
            };

            const buildCodexDiffsFromChanges = (changes) => {
              const relPaths = [];
              const absByRel = new Map();
              const kindByRel = new Map();
              const seen = new Set();
              for (const change of Array.isArray(changes) ? changes : []) {
                const rawPath =
                  typeof change?.file_path === "string"
                    ? change.file_path
                    : typeof change?.path === "string"
                      ? change.path
                      : "";
                if (!rawPath) continue;
                const abs = resolveWorkspacePath(rawPath);
                if (!abs || !isPathInsideCwd(abs)) continue;
                const rel = workspaceRelativePath(abs);
                if (!rel || rel.startsWith("../") || rel === "..") continue;
                if (seen.has(rel)) continue;
                seen.add(rel);
                relPaths.push(rel);
                absByRel.set(rel, abs);
                kindByRel.set(rel, String(change?.kind || "").toLowerCase());
              }

              if (relPaths.length === 0) return [];

              const built = [];
              const appendGitDiff = (extraArgs, label) => {
                try {
                  const diffText = execFileSync(
                    "git",
                    ["-C", safeCwd, "diff", "--no-ext-diff", ...extraArgs, "--", ...relPaths],
                    {
                      encoding: "utf8",
                      timeout: 5000,
                      maxBuffer: 10 * 1024 * 1024,
                    }
                  );
                  built.push(...splitUnifiedDiffs(diffText));
                } catch (err) {
                  warn("codex_run git diff extraction failed", {
                    cwd: safeCwd,
                    mode: label,
                    files: relPaths.slice(0, 8),
                    error: err?.message || String(err),
                  });
                }
              };

              appendGitDiff([], "worktree");
              appendGitDiff(["--cached"], "staged");

              const diffedFiles = new Set(built.map((d) => extractDiffFilePath(d)).filter(Boolean));
              let untracked = [];
              try {
                const untrackedText = execFileSync(
                  "git",
                  ["-C", safeCwd, "ls-files", "--others", "--exclude-standard", "--", ...relPaths],
                  {
                    encoding: "utf8",
                    timeout: 5000,
                    maxBuffer: 1024 * 1024,
                  }
                );
                untracked = untrackedText
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean);
              } catch {
                // Not a git workspace, or git is unavailable. Fall back below.
              }

              for (const rel of untracked) {
                if (diffedFiles.has(rel)) continue;
                const synthetic = buildNewFileDiff(rel, absByRel.get(rel) || path.resolve(safeCwd, rel));
                if (synthetic) {
                  built.push(synthetic);
                  diffedFiles.add(rel);
                }
              }

              for (const rel of relPaths) {
                if (diffedFiles.has(rel)) continue;
                const kind = kindByRel.get(rel) || "";
                if (!["add", "create", "created", "new", "write"].includes(kind)) continue;
                const synthetic = buildNewFileDiff(rel, absByRel.get(rel) || path.resolve(safeCwd, rel));
                if (synthetic) {
                  built.push(synthetic);
                  diffedFiles.add(rel);
                }
              }

              return built;
            };

            let codexExtracted = null;
            if (codeProvider === "codex") {
              codexExtracted = extractCodexResult(streamEvents);
              const codexChanges = Array.isArray(codexExtracted.diffs)
                ? [...codexExtracted.diffs]
                : [];
              const gitTouchedPaths = collectGitTouchedPathsSinceSnapshot(preRunGitSnapshot);
              for (const rel of gitTouchedPaths) {
                codexChanges.push({ path: rel, kind: "git_status" });
              }
              const codexDiffs = buildCodexDiffsFromChanges(codexChanges);
              const seenDiffTexts = new Set(diffs.map((existing) => String(existing)));
              for (const diffText of codexDiffs) {
                if (seenDiffTexts.has(diffText)) continue;
                diffs.push(diffText);
                seenDiffTexts.add(diffText);
              }
              log("codex_run diff extraction", {
                reportedChanges: Array.isArray(codexExtracted.diffs) ? codexExtracted.diffs.length : 0,
                gitTouchedPaths: gitTouchedPaths.length,
                builtDiffs: codexDiffs.length,
              });
            }

            if (codeProvider !== "codex") {
              const gitTouchedPaths = collectGitTouchedPathsSinceSnapshot(preRunGitSnapshot);
              const existingDiffFiles = new Set(diffs.map((d) => extractDiffFilePath(d)).filter(Boolean));
              const gitChanges = gitTouchedPaths
                .filter((rel) => !existingDiffFiles.has(rel))
                .map((rel) => ({ path: rel, kind: "git_status" }));
              const gitDiffs = buildCodexDiffsFromChanges(gitChanges);
              const seenDiffTexts = new Set(diffs.map((existing) => String(existing)));
              for (const diffText of gitDiffs) {
                if (seenDiffTexts.has(diffText)) continue;
                diffs.push(diffText);
                seenDiffTexts.add(diffText);
              }
              log("claude_run git snapshot diff extraction", {
                provider: codeProvider,
                gitTouchedPaths: gitTouchedPaths.length,
                skippedExistingDiffFiles: gitTouchedPaths.length - gitChanges.length,
                builtDiffs: gitDiffs.length,
              });
            }

            const filteredDiffs = diffs.filter((d) => {
              const filePath = extractDiffFilePath(d);
              if (!filePath) return !isSiteWorkspace;
              if (!isSiteWorkspace) return true;
              return isPathInsideCwd(filePath);
            });

            let verifiedWritesInCwd = 0;
            const verifiedWriteFiles = [];
            const attemptedOutsideCwd = [];
            for (const target of writeTargets) {
              const filePath = String(target?.filePath || "");
              const absFilePath = resolveWorkspacePath(filePath);
              const inCwd = !!absFilePath && isPathInsideCwd(absFilePath);
              if (!inCwd) {
                attemptedOutsideCwd.push(filePath);
                continue;
              }
              try {
                const actual = fs.readFileSync(absFilePath, "utf8");
                const beforeFingerprint = preRunFileFingerprints.get(absFilePath);
                const afterFingerprint = captureFileFingerprint(absFilePath);
                let verified = false;
                if (target?.kind === "write") {
                  verified = actual === String(target?.content || "");
                } else if (target?.kind === "edit") {
                  const changedFromBefore =
                    !!beforeFingerprint && didFingerprintChange(beforeFingerprint, afterFingerprint);
                  if (!changedFromBefore) {
                    verified = false;
                  } else {
                    const newString = String(target?.newString || "");
                    const oldString = String(target?.oldString || "");
                    if (newString) {
                      // Edit replaces a snippet, not the whole file.
                      verified = actual.includes(newString);
                    } else if (oldString) {
                      // Deletion-style edit (new_string empty): old snippet should be gone.
                      verified = !actual.includes(oldString);
                    }
                  }
                }
                if (verified) {
                  verifiedWritesInCwd += 1;
                  verifiedWriteFiles.push(absFilePath);
                }
              } catch {
                // ignore read failures; verification simply won't count this file
              }
            }
            if (attemptedOutsideCwd.length > 0) {
              warn("claude_run attempted writes outside cwd", {
                cwd: safeCwd,
                count: attemptedOutsideCwd.length,
                files: attemptedOutsideCwd.slice(0, 8),
              });
            }
            if (filteredDiffs.length !== diffs.length) {
              warn("claude_run filtered diffs outside cwd", {
                cwd: safeCwd,
                totalDiffs: diffs.length,
                keptDiffs: filteredDiffs.length,
              });
            }
            const fingerprintTouchedFiles = new Set();
            for (const target of writeTargets) {
              const abs = resolveWorkspacePath(target?.filePath);
              if (abs && isPathInsideCwd(abs)) fingerprintTouchedFiles.add(abs);
            }
            for (const d of filteredDiffs) {
              const rel = extractDiffFilePath(d);
              const abs = resolveWorkspacePath(rel);
              if (abs && isPathInsideCwd(abs)) fingerprintTouchedFiles.add(abs);
            }
            const fingerprintChangedFilesInCwd = [];
            for (const abs of fingerprintTouchedFiles) {
              const before = preRunFileFingerprints.get(abs);
              const after = captureFileFingerprint(abs);
              let changed = didFingerprintChange(before, after);
              // If we missed the pre-run snapshot, use mtime heuristic as a fallback signal.
              if (
                !changed &&
                !before &&
                after?.exists === true &&
                Number.isFinite(Number(after?.mtimeMs || 0)) &&
                Number(after.mtimeMs || 0) >= startedAt - 1000
              ) {
                changed = true;
              }
              if (changed) fingerprintChangedFilesInCwd.push(abs);
            }
            const confirmedWritesInCwd = verifiedWritesInCwd + fingerprintChangedFilesInCwd.length;
            
            if (codeProvider === "codex") {
              // Extract result from Codex JSONL events
              codexExtracted = codexExtracted || extractCodexResult(streamEvents);
              result = {
                result: codexExtracted.resultText || latestAssistantText || "",
                session_id: codexExtracted.threadId || null,
              };
              if (codexExtracted.usage && typeof codexExtracted.usage === "object") {
                result.usage = codexExtracted.usage;
                if (typeof codexExtracted.usage.input_tokens === "number") {
                  result.input_tokens = codexExtracted.usage.input_tokens;
                }
                if (typeof codexExtracted.usage.output_tokens === "number") {
                  result.output_tokens = codexExtracted.usage.output_tokens;
                }
                if (typeof codexExtracted.usage.total_tokens === "number") {
                  result.total_tokens = codexExtracted.usage.total_tokens;
                }
              }
              // Surface codex's own error messages so we don't fall back to
              // noisy stderr (codex always prints "Reading additional input
              // from stdin..." when stdin is piped, which is not an error).
              if (codexExtracted.turnFailed || codexExtracted.errorText) {
                if (codexExtracted.errorText) errorText = codexExtracted.errorText;
                result.is_error = true;
              }
            } else if (resultEvent) {
              result = resultEvent;
            } else {
              // Fallback: try to parse as regular JSON (in case stream-json wasn't used)
              const rawOutput = spawnResult.stdout || "";
              try {
                result = JSON.parse(rawOutput);
              } catch {
                result = { raw_output: rawOutput, stderr: spawnResult.stderr || "", exit_code: spawnResult.code };
              }
            }

            if (filteredDiffs.length > 0) {
              if (!result || typeof result !== "object") result = {};
              result.diffs = filteredDiffs;
            }

            // Some Claude stream-json runs (notably plan-mode variants) can end with an
            // empty result.result while the final assistant text is present in assistant events.
            if (latestAssistantText) {
              if (!result || typeof result !== "object") result = {};
              const currentResultText =
                result && typeof result === "object" && typeof result.result === "string"
                  ? result.result.trim()
                  : "";
              if (!currentResultText) {
                result.result = latestAssistantText;
              }
            }

            if (sessionId) {
              if (!result || typeof result !== "object") result = {};
              if (typeof result.session_id !== "string" || !result.session_id.trim()) {
                result.session_id = sessionId;
              }
            }

            // For Codex: extract thread_id as session_id for resume support
            if (codeProvider === "codex" && spawnResult.codexThreadId) {
              if (!result || typeof result !== "object") result = {};
              if (!result.session_id) {
                result.session_id = spawnResult.codexThreadId;
              }
            }

            const partialResultAvailable = Boolean(
              (result &&
                typeof result === "object" &&
                typeof result.result === "string" &&
                result.result.trim()) ||
                filteredDiffs.length > 0
            );

            if (timedOut) {
              ok = false;
              partial = partialResultAvailable;
              if (!errorText) {
                errorText =
                  typeof spawnResult.timeoutError === "string" && spawnResult.timeoutError.trim()
                    ? spawnResult.timeoutError.trim()
                    : `claude_run timed out after ${timeoutMs}ms`;
              }
            } else if (aborted) {
              ok = false;
              partial = partialResultAvailable;
              if (!errorText) errorText = "claude_run_aborted";
            }

            if (result && typeof result === "object" && result.is_error) {
              ok = false;
              const resultText =
                typeof result.result === "string" && result.result.trim()
                  ? result.result.trim()
                  : "";
              if (!errorText) errorText = resultText || "claude_run_error";
            }

            if (!timedOut && !aborted && exitCode !== null && exitCode !== 0) {
              // If we already have a valid result (non-empty text, not an error),
              // treat the run as successful despite non-zero exit code.
              // Claude CLI can exit 1 for benign reasons (context overflow, etc.)
              // while still producing a usable response.
              const hasValidResult =
                result &&
                typeof result === "object" &&
                typeof result.result === "string" &&
                result.result.trim() &&
                !result.is_error;
              const hasUsefulDiffs = filteredDiffs.length > 0;
              if (!hasValidResult) {
                if (hasUsefulDiffs) {
                  // Only treat timeout/non-zero as success when we can confirm writes
                  // actually landed under the requested cwd.
                  if (confirmedWritesInCwd > 0) {
                    ok = true;
                    errorText = null;
                    const touchedFiles = Array.from(
                      new Set(
                        filteredDiffs
                          .map((d) => {
                            const m = String(d).match(/\+\+\+ b\/([^\n]+)/);
                            return m ? m[1] : "";
                          })
                          .filter(Boolean)
                      )
                    );
                    const filesPreview = touchedFiles.slice(0, 5).join(", ");
                    const summary = filesPreview
                      ? `Applied code edits to ${filesPreview}.`
                      : `Applied ${diffs.length} code edit operation(s).`;
                    if (!result || typeof result !== "object") {
                      result = {};
                    }
                    if (typeof result.result !== "string" || !result.result.trim()) {
                      result.result = summary;
                    }
                    result.is_error = false;
                    result.diffs = filteredDiffs;
                    log("claude_run: non-zero exit with verified writes — treating as success", {
                      exitCode,
                      diffs: filteredDiffs.length,
                      verifiedWritesInCwd,
                      fingerprintConfirmedWritesInCwd: fingerprintChangedFilesInCwd.length,
                      verifiedFiles: verifiedWriteFiles.slice(0, 8),
                      fingerprintChangedFiles: fingerprintChangedFilesInCwd.slice(0, 8),
                    });
                  } else {
                    ok = false;
                    if (!errorText) {
                      errorText =
                        `${codeProvider} exited with code ${exitCode} before confirming file writes in ${safeCwd}`;
                    }
                  }
                } else {
                  ok = false;
                  if (!errorText) {
                    const stderrText = String(spawnResult.stderr || "").trim();
                    // Never dump raw stdout into errorText — it can be the entire
                    // stream-json output (hundreds of KB of JSON) which gets shown
                    // as a huge red wall of text in the UI.
                    // Only use stderr (usually short and human-readable).
                    errorText = stderrText || `${codeProvider} exited with code ${exitCode}`;
                  }
                }
              } else {
                log("claude_run: non-zero exit code but valid result — treating as success", { exitCode });
              }
            }

            // Extra safety for site mode: if this was a write/scaffold intent but no in-workspace
            // writes were confirmed, do not report success.
            const explicitWriteIntent = /\b(write|edit|replace|create|refactor|update|rewrite|implement|patch|scaffold)\b/i.test(
              prompt
            );
            const explicitReadIntent = /\b(show|read|list|display|verify|check)\b/i.test(prompt);
            const looksLikeWriteIntent = explicitWriteIntent || (prompt.length > 1400 && !explicitReadIntent);
            const looksLikeScaffoldIntent = /\bcreate-next-app\b/i.test(prompt) || /\bscaffold\b/i.test(prompt);
            const scaffoldLooksReady =
              fs.existsSync(path.join(safeCwd, "package.json")) &&
              (isDirectory(path.join(safeCwd, "app")) ||
                isDirectory(path.join(safeCwd, "src", "app")) ||
                isDirectory(path.join(safeCwd, "pages")) ||
                isDirectory(path.join(safeCwd, "src", "pages")));
            if (
              ok &&
              isSiteWorkspace &&
              looksLikeWriteIntent &&
              confirmedWritesInCwd === 0 &&
              !(looksLikeScaffoldIntent && scaffoldLooksReady)
            ) {
              ok = false;
              errorText =
                `claude_run finished without confirmed file writes in ${safeCwd}; retry with explicit Edit/Write actions in that workspace.`;
              warn("claude_run site write verification failed", {
                cwd: safeCwd,
                promptLen: prompt.length,
                looksLikeScaffoldIntent,
                scaffoldLooksReady,
                filteredDiffs: filteredDiffs.length,
                verifiedWritesInCwd,
                fingerprintConfirmedWritesInCwd: fingerprintChangedFilesInCwd.length,
              });
            }

            log("claude_run finished", {
              durationMs: Date.now() - startedAt,
              exitCode,
              signal: exitSignal,
              isError: result?.is_error,
              ok,
              timedOut,
              aborted,
              partial,
              errorText: errorText || null,
              resultLen: result?.result?.length,
              resultPreview: typeof result?.result === "string" ? result.result.slice(0, 200) : null,
              hasResultEvent: hadResultEvent,
              latestAssistantTextLen: latestAssistantText?.length || 0,
              sessionId: result?.session_id ? result.session_id.slice(0, 8) + "..." : null,
              streamEventsCount: streamEvents.length,
              eventTypeCounts: streamEvents.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {}),
              diffsFound: filteredDiffs.length,
              wsOpen: ws.readyState === WebSocket.OPEN,
            });
          } catch (e) {
            ok = false;
            const err = e && typeof e === "object" ? e : null;
            errorText = err && "message" in err ? String(err.message) : "claude_run_failed";
            timedOut = /timed out/i.test(errorText);
            aborted = errorText === "claude_run_aborted";
            warn("claude_run error", { error: errorText });
          }
        }

        if (ws.readyState === WebSocket.OPEN) {
          // result is the full stream-json "result" event object.
          // The client expects result to be the text string, and session_id / cost at top level.
          const rawResultField = result && typeof result === "object" ? result.result : undefined;
          let resultText = "";
          if (typeof rawResultField === "string") {
            resultText = rawResultField;
          } else if (rawResultField !== undefined && rawResultField !== null) {
            try {
              resultText = JSON.stringify(rawResultField);
            } catch {
              resultText = String(rawResultField);
            }
          }
          const totalCostUsd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : undefined;
          const usageObj = result && typeof result === "object" ? result.usage : undefined;
          const inputTokens =
            typeof result?.input_tokens === "number"
              ? result.input_tokens
              : usageObj && typeof usageObj === "object" && typeof usageObj.input_tokens === "number"
                ? usageObj.input_tokens
                : undefined;
          const outputTokens =
            typeof result?.output_tokens === "number"
              ? result.output_tokens
              : usageObj && typeof usageObj === "object" && typeof usageObj.output_tokens === "number"
                ? usageObj.output_tokens
                : undefined;
          const totalTokens =
            typeof result?.total_tokens === "number"
              ? result.total_tokens
              : typeof inputTokens === "number" && typeof outputTokens === "number"
                ? inputTokens + outputTokens
                : undefined;
          const resultDiffs = Array.isArray(result?.diffs) ? result.diffs : [];
          ws.send(
            JSON.stringify({
              type: "claude_run_result",
              request_id: requestId,
              ok,
              result: resultText,
              session_id: result?.session_id || null,
              model: cliModel,
              total_cost_usd: totalCostUsd,
              cost_usd: totalCostUsd,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              total_tokens: totalTokens,
              usage: usageObj,
              ...(typeof billingBillable === "boolean" ? { billing_billable: billingBillable } : {}),
              ...(billingChargeType ? { billing_charge_type: billingChargeType } : {}),
              ...(billingAuthOrigin ? { billing_auth_origin: billingAuthOrigin } : {}),
              ...(billingAuthMethod ? { billing_auth_method: billingAuthMethod } : {}),
              diffs: resultDiffs,
              error: errorText,
              timed_out: timedOut,
              aborted,
              partial,
              exit_code: exitCode,
              signal: exitSignal,
              has_result_event: hadResultEvent,
              duration_ms: Math.max(0, Date.now() - startedAt),
            })
          );
        }
        return;
      }

      // ===== Link Inbox (SQLite) =====
      if (msg.type === "linkdb_init") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await linkdbInit();
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "linkdb_init_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "linkdb_upsert_links") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await linkdbUpsertLinks({ links: msg.links });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "linkdb_upsert_links_result",
              request_id: requestId,
              ...result,
            })
          );
        }
        return;
      }

      if (msg.type === "linkdb_update") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await linkdbUpdate({
            url: msg.url,
            title: msg.title,
            summary: msg.summary,
            tags: msg.tags,
            note: msg.note,
            read: msg.read,
            source: msg.source,
          });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "linkdb_update_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "linkdb_query") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await linkdbQuery({
            text: msg.text,
            tags_any: msg.tags_any,
            unread_only: msg.unread_only,
            limit: msg.limit,
          });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "linkdb_query_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "linkdb_digest") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await linkdbDigest({
            since_days: msg.since_days,
            unread_only: msg.unread_only,
            limit: msg.limit,
          });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "linkdb_digest_result", request_id: requestId, ...result }));
        }
        return;
      }

      // ===== Generic SQLite (multi-project DBs) =====
      if (msg.type === "sqlite_list") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await sqliteListDbs();
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "sqlite_list_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "sqlite_exec") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await sqliteExec({
            dbKey: msg.dbKey,
            sql: msg.sql,
            statements: msg.statements,
            timeout_ms: msg.timeout_ms,
          });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "sqlite_exec_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "sqlite_query") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await sqliteQuery({
            dbKey: msg.dbKey,
            sql: msg.sql,
            limit: msg.limit,
            append_limit: msg.append_limit,
            timeout_ms: msg.timeout_ms,
          });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "sqlite_query_result", request_id: requestId, ...result }));
        }
        return;
      }

      // ===== SQLite Project Registry =====
      if (msg.type === "sqlite_project_list") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await sqliteProjectList();
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "sqlite_project_list_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "sqlite_project_get_or_create") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await sqliteProjectGetOrCreate({
            name: msg.name,
            description: msg.description,
            tags: msg.tags,
            preferredDbKey: msg.preferredDbKey,
          });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: "sqlite_project_get_or_create_result", request_id: requestId, ...result })
          );
        }
        return;
      }

      if (msg.type === "sqlite_project_update") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await sqliteProjectUpdate({
            dbKey: msg.dbKey,
            name: msg.name,
            description: msg.description,
            tags: msg.tags,
          });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "sqlite_project_update_result", request_id: requestId, ...result }));
        }
        return;
      }

      // ===== Skills Manager Operations =====
      if (String(msg.type || "").startsWith("skills_")) {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await executeSkillsConnectorRpc(String(msg.type), msg);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e || "skills_rpc_failed") };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: `${String(msg.type)}_result`, request_id: requestId, ...result }));
        }
        return;
      }

      // ===== File System Operations =====
      if (msg.type === "file_read") {
        const requestId = String(msg.request_id || "");
        const filePath = String(msg.path || "");
        const allowedRoots = Array.isArray(msg.allowed_roots) ? msg.allowed_roots : undefined;
        
        const result = await fileRead({ filePath, allowedRoots });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "file_read_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "file_write") {
        const requestId = String(msg.request_id || "");
        const filePath = String(msg.path || "");
        const content = String(msg.content || "");
        const allowedRoots = Array.isArray(msg.allowed_roots) ? msg.allowed_roots : undefined;
        
        const result = await fileWrite({ filePath, content, allowedRoots });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "file_write_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "file_list") {
        const requestId = String(msg.request_id || "");
        const dirPath = String(msg.path || "");
        const recursive = msg.recursive === true;
        const allowedRoots = Array.isArray(msg.allowed_roots) ? msg.allowed_roots : undefined;
        
        const result = await fileList({ dirPath, allowedRoots, recursive });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "file_list_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "file_search") {
        const requestId = String(msg.request_id || "");
        const rootPath = String(msg.root || msg.path || "");
        const query = String(msg.query || "");
        const searchContent = msg.search_content !== false;
        const allowedRoots = Array.isArray(msg.allowed_roots) ? msg.allowed_roots : undefined;
        
        const result = await fileSearch({ rootPath, query, allowedRoots, searchContent });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "file_search_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "file_delete") {
        const requestId = String(msg.request_id || "");
        const filePath = String(msg.path || "");
        const allowedRoots = Array.isArray(msg.allowed_roots) ? msg.allowed_roots : undefined;
        
        const result = await fileDelete({ filePath, allowedRoots });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "file_delete_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "file_mkdir") {
        const requestId = String(msg.request_id || "");
        const dirPath = String(msg.path || "");
        const allowedRoots = Array.isArray(msg.allowed_roots) ? msg.allowed_roots : undefined;
        
        const result = await fileCreateDir({ dirPath, allowedRoots });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "file_mkdir_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "file_move") {
        const requestId = String(msg.request_id || "");
        const sourcePath = String(msg.source || "");
        const destPath = String(msg.destination || "");
        const allowedRoots = Array.isArray(msg.allowed_roots) ? msg.allowed_roots : undefined;
        
        const result = await fileMove({ sourcePath, destPath, allowedRoots });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "file_move_result", request_id: requestId, ...result }));
        }
        return;
      }

      // ===== Code Plans Discovery =====
      if (msg.type === "claude_plans_list") {
        const startedAt = Date.now();
        const requestId = String(msg.request_id || "");
        const workspaceRoots = Array.isArray(msg.workspace_roots) ? msg.workspace_roots : [];
        const plans = [];
        const seenPlanPaths = new Set();
        const planScanTargets = buildClaudePlanScanTargets(workspaceRoots);
        const claudeTargetResults = await Promise.all(
          planScanTargets.map((target) =>
            withTimeoutResult(scanClaudePlanTarget(target), CLAUDE_PLAN_TARGET_SCAN_TIMEOUT_MS, [])
          )
        );
        let claudeTimedOutTargetCount = 0;
        for (const result of claudeTargetResults) {
          if (result.timedOut) {
            claudeTimedOutTargetCount += 1;
            continue;
          }
          if (result.error) continue;
          for (const plan of Array.isArray(result.value) ? result.value : []) {
            const sourcePath = String(plan.sourcePath || "");
            if (sourcePath && seenPlanPaths.has(sourcePath)) continue;
            if (sourcePath) seenPlanPaths.add(sourcePath);
            plans.push(plan);
          }
        }

        let codexPlanCount = 0;
        let codexFallbackUsed = false;
        let codexTimedOut = false;
        try {
          const codexResult = await withTimeoutResult(
            collectCodexPlansInChild(workspaceRoots, CODEX_PLAN_SCAN_TIMEOUT_MS),
            CODEX_PLAN_SCAN_TIMEOUT_MS,
            []
          );
          if (codexResult.timedOut) {
            codexTimedOut = true;
          } else if (codexResult.error) {
            throw codexResult.error;
          }
          let codexPlans = Array.isArray(codexResult.value) ? codexResult.value : [];
          if (!codexTimedOut && codexPlans.length === 0 && workspaceRoots.length > 0) {
            codexFallbackUsed = true;
            const fallbackResult = await withTimeoutResult(
              collectCodexPlansInChild([], CODEX_PLAN_SCAN_TIMEOUT_MS),
              CODEX_PLAN_SCAN_TIMEOUT_MS,
              []
            );
            if (fallbackResult.timedOut) {
              codexTimedOut = true;
            } else if (fallbackResult.error) {
              throw fallbackResult.error;
            } else {
              codexPlans = Array.isArray(fallbackResult.value) ? fallbackResult.value : [];
            }
          }
          codexPlanCount = codexPlans.length;
          plans.push(...codexPlans);
        } catch (e) {
          warn("failed to collect Codex plans", e instanceof Error ? e.message : String(e));
        }

        log("claude_plans_list result", {
          requestId,
          workspaceRootsCount: workspaceRoots.length,
          claudeTargetCount: planScanTargets.length,
          claudeTimedOutTargetCount,
          codexPlanCount,
          codexFallbackUsed,
          codexTimedOut,
          totalPlanCount: plans.length,
          elapsedMs: Date.now() - startedAt,
        });

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "claude_plans_list_result",
            request_id: requestId,
            ok: true,
            plans,
            count: plans.length,
            diagnostics: {
              workspaceRootsCount: workspaceRoots.length,
              claudeTargetCount: planScanTargets.length,
              claudeTimedOutTargetCount,
              codexPlanCount,
              codexFallbackUsed,
              codexTimedOut,
              elapsedMs: Date.now() - startedAt,
            },
          }));
        }
        return;
      }

      // ===== Obsidian Vault Operations =====
      if (msg.type === "obsidian_discover") {
        const requestId = String(msg.request_id || "");
        
        const result = await discoverVaults();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "obsidian_discover_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "obsidian_read") {
        const requestId = String(msg.request_id || "");
        const vaultPath = String(msg.vault_path || "");
        const notePath = String(msg.note_path || "");
        
        const result = await obsidianRead({ vaultPath, notePath });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "obsidian_read_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "obsidian_write") {
        const requestId = String(msg.request_id || "");
        const vaultPath = String(msg.vault_path || "");
        const notePath = String(msg.note_path || "");
        const content = String(msg.content || "");
        
        const result = await obsidianWrite({ vaultPath, notePath, content });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "obsidian_write_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "obsidian_search") {
        const requestId = String(msg.request_id || "");
        const vaultPath = String(msg.vault_path || "");
        const query = String(msg.query || "");
        const searchContent = msg.search_content !== false;
        const searchTags = msg.search_tags !== false;
        const result = await obsidianSearch({ vaultPath, query, searchContent, searchTags });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "obsidian_search_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "obsidian_list") {
        const requestId = String(msg.request_id || "");
        const vaultPath = String(msg.vault_path || "");
        
        const result = await obsidianList({ vaultPath });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "obsidian_list_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "obsidian_delete") {
        const requestId = String(msg.request_id || "");
        const vaultPath = String(msg.vault_path || "");
        const notePath = String(msg.note_path || "");
        
        const result = await obsidianDelete({ vaultPath, notePath });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "obsidian_delete_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "obsidian_daily") {
        const requestId = String(msg.request_id || "");
        const vaultPath = String(msg.vault_path || "");
        const content = msg.content !== undefined ? String(msg.content) : undefined;
        const append = msg.append !== false;
        
        const result = await obsidianDailyNote({ vaultPath, content, append });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "obsidian_daily_result", request_id: requestId, ...result }));
        }
        return;
      }

      // ===== WhatsApp (local WhatsApp Web bridge) =====
      if (msg.type === "whatsapp_resolve_recipient") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await runWhatsAppBridgeOp("relay_whatsapp_resolve_recipient", async () => {
            if (!whatsappBridge || typeof whatsappBridge.resolveRecipient !== "function") {
              return { ok: false, error: "whatsapp_not_running" };
            }
            const query = String(msg.query || "");
            const result = await whatsappBridge.resolveRecipient({ query, limit: msg.limit });
            rememberWhatsAppResolve(result, {
              query,
              source: "relay_whatsapp_resolve_recipient",
              scopeKey: "relay",
            });
            return result;
          });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "whatsapp_resolve_recipient_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "whatsapp_send_text") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await runWhatsAppBridgeOp("relay_whatsapp_send_text", async () => {
            if (!whatsappBridge || typeof whatsappBridge.sendTextToChatId !== "function") {
              return { ok: false, error: "whatsapp_not_running" };
            }
            const recipientQuery =
              typeof msg.recipient_query === "string" && msg.recipient_query.trim()
                ? msg.recipient_query.trim()
                : typeof msg.recipient_display === "string" && msg.recipient_display.trim()
                  ? msg.recipient_display.trim()
                  : "";
            const target = await pickWhatsAppSendChatId({
              requestedChatId: String(msg.chat_id || ""),
              recipientQuery,
              source: "relay_whatsapp_send_text",
              scopeKey: "relay",
              preferRecentResolve: msg.guard_recent_resolve === true,
              requireRecipientQueryForRecentResolve: true,
            });
            let result = await whatsappBridge.sendTextToChatId({
              chatId: target.chatId,
              text: String(msg.text || ""),
            });
            if (target.correctionReason && result && typeof result === "object") {
              result = {
                ...result,
                corrected_chat_id_from: target.correctedFrom || String(msg.chat_id || ""),
                corrected_chat_id_to: target.chatId,
                correction_reason: target.correctionReason,
              };
            }
            return result;
          });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        observeWhatsAppSendResult(result, "relay_whatsapp_send_text");
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "whatsapp_send_text_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "whatsapp_send_media") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await runWhatsAppBridgeOp("relay_whatsapp_send_media", async () => {
            if (!whatsappBridge || typeof whatsappBridge.sendMediaToChatId !== "function") {
              return { ok: false, error: "whatsapp_not_running" };
            }
            const recipientQuery =
              typeof msg.recipient_query === "string" && msg.recipient_query.trim()
                ? msg.recipient_query.trim()
                : typeof msg.recipient_display === "string" && msg.recipient_display.trim()
                  ? msg.recipient_display.trim()
                  : "";
            const target = await pickWhatsAppSendChatId({
              requestedChatId: String(msg.chat_id || ""),
              recipientQuery,
              source: "relay_whatsapp_send_media",
              scopeKey: "relay",
              preferRecentResolve: msg.guard_recent_resolve === true,
              requireRecipientQueryForRecentResolve: true,
            });
            let result = await whatsappBridge.sendMediaToChatId({
              chatId: target.chatId,
              url: String(msg.url || ""),
              localPath: String(msg.local_path || ""),
              filename: typeof msg.filename === "string" ? msg.filename : undefined,
              caption: typeof msg.caption === "string" ? msg.caption : undefined,
            });
            if (target.correctionReason && result && typeof result === "object") {
              result = {
                ...result,
                corrected_chat_id_from: target.correctedFrom || String(msg.chat_id || ""),
                corrected_chat_id_to: target.chatId,
                correction_reason: target.correctionReason,
              };
            }
            const pending_message_id = String(msg.pending_message_id || "").trim();
            const recipient_display = String(msg.recipient_display || "").trim();
            if (result && typeof result === "object") {
              result = {
                ...result,
                ...(pending_message_id ? { pending_message_id } : {}),
                ...(recipient_display ? { recipient_display } : {}),
              };
            }
            return result;
          });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        observeWhatsAppSendResult(result, "relay_whatsapp_send_media");
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "whatsapp_send_media_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "email_unsubscribe_execute") {
        const requestId = String(msg.request_id || "");
        let result = { ok: false, error: "unknown" };
        try {
          result = await executeLocalUnsubscribe({
            unsubscribeUrl: msg.unsubscribe_url,
            unsubscribeMailto: msg.unsubscribe_mailto,
          });
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "email_unsubscribe_execute_result",
              request_id: requestId,
              ...(result && typeof result === "object" ? result : { ok: false, error: "unsubscribe_failed" }),
              ...(typeof msg.subject === "string" && msg.subject.trim()
                ? { subject: msg.subject.trim() }
                : {}),
              ...(typeof msg.action_id === "string" && msg.action_id.trim()
                ? { action_id: msg.action_id.trim() }
                : {}),
            })
          );
        }
        return;
      }

      // ===== Browser Automation Operations =====
      if (msg.type === "browser_init") {
        const requestId = String(msg.request_id || "");
        const headless = msg.headless !== false;
        
        const result = await initBrowser({ headless });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_init_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_close") {
        const requestId = String(msg.request_id || "");
        
        const result = await closeBrowser();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_close_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_navigate") {
        const requestId = String(msg.request_id || "");
        const url = String(msg.url || "");
        const pageId = String(msg.page_id || "default");
        const waitUntil = msg.wait_until ? String(msg.wait_until) : undefined; // domcontentloaded | load | networkidle0 | networkidle2
        const timeoutMs = msg.timeout_ms !== undefined ? Number(msg.timeout_ms) : undefined;
        
        const result = await browserNavigate({ url, pageId, waitUntil, timeoutMs });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_navigate_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_click") {
        const requestId = String(msg.request_id || "");
        const selector = String(msg.selector || "");
        const pageId = String(msg.page_id || "default");
        const waitForNav = msg.wait_for_nav === true;
        
        const result = await browserClick({ selector, pageId, waitForNav });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_click_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_type") {
        const requestId = String(msg.request_id || "");
        const selector = String(msg.selector || "");
        const text = String(msg.text || "");
        const pageId = String(msg.page_id || "default");
        const clear = msg.clear !== false;
        
        const result = await browserType({ selector, text, pageId, clear });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_type_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_press_key") {
        const requestId = String(msg.request_id || "");
        const key = String(msg.key || "");
        const pageId = String(msg.page_id || "default");
        
        const result = await browserPressKey({ key, pageId });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_press_key_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_screenshot") {
        const requestId = String(msg.request_id || "");
        const pageId = String(msg.page_id || "default");
        const fullPage = msg.full_page === true;
        const selector = msg.selector ? String(msg.selector) : null;
        
        const result = await browserScreenshot({ pageId, fullPage, selector });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_screenshot_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_extract") {
        const requestId = String(msg.request_id || "");
        const pageId = String(msg.page_id || "default");
        const selector = msg.selector ? String(msg.selector) : null;
        const extractType = String(msg.extract_type || "text");
        
        const result = await browserExtract({ pageId, selector, type: extractType });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_extract_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_wait") {
        const requestId = String(msg.request_id || "");
        const pageId = String(msg.page_id || "default");
        const selector = msg.selector ? String(msg.selector) : null;
        const timeout = Number(msg.timeout) || 10000;
        
        const result = await browserWait({ pageId, selector, timeout });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_wait_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_scroll") {
        const requestId = String(msg.request_id || "");
        const pageId = String(msg.page_id || "default");
        const direction = String(msg.direction || "down");
        const amount = Number(msg.amount) || 500;
        
        const result = await browserScroll({ pageId, direction, amount });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_scroll_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_info") {
        const requestId = String(msg.request_id || "");
        const pageId = String(msg.page_id || "default");
        
        const result = await browserGetInfo({ pageId });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_info_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_evaluate") {
        const requestId = String(msg.request_id || "");
        const pageId = String(msg.page_id || "default");
        const script = String(msg.script || "");
        
        const result = await browserEvaluate({ pageId, script });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_evaluate_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_fill_form") {
        const requestId = String(msg.request_id || "");
        const pageId = String(msg.page_id || "default");
        const formSelector = String(msg.form_selector || "form");
        const fields = msg.fields && typeof msg.fields === "object" ? msg.fields : {};
        
        const result = await browserFillForm({ pageId, formSelector, fields });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_fill_form_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_close_page") {
        const requestId = String(msg.request_id || "");
        const pageId = String(msg.page_id || "default");
        
        const result = await browserClosePage({ pageId });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_close_page_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_list_pages") {
        const requestId = String(msg.request_id || "");
        
        const result = browserListPages();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_list_pages_result", request_id: requestId, ...result }));
        }
        return;
      }

      // ===== Browser Task Runner =====
      // Prefer Playwright MCP (claude -p + playwright) for reliable DOM-based automation.
      // Falls back to legacy Computer Use (Puppeteer + screenshot loop) if claude CLI unavailable.
      if (msg.type === "browser_task_cancel") {
        const requestId = String(msg.request_id || "");
        const targetRequestId = String(msg.target_request_id || "").trim();
        const cancelAll = msg.cancel_all === true;

        if (!cancelAll && !targetRequestId) {
          if (ws.readyState === WebSocket.OPEN && requestId) {
            ws.send(
              JSON.stringify({
                type: "browser_task_cancel_result",
                request_id: requestId,
                ok: false,
                error: "missing_target_request_id",
              })
            );
          }
          return;
        }

        let canceled = 0;
        if (cancelAll) {
          for (const [rid, controller] of pendingBrowserTaskRuns.entries()) {
            try {
              controller.abort();
              canceled += 1;
              log("browser_task_cancel aborted run", { requestId: rid });
            } catch {
              // ignore
            }
          }
        } else {
          const controller = pendingBrowserTaskRuns.get(targetRequestId);
          if (controller) {
            try {
              controller.abort();
              canceled = 1;
              log("browser_task_cancel aborted run", { requestId: targetRequestId });
            } catch {
              // ignore
            }
          }
        }

        if (ws.readyState === WebSocket.OPEN && requestId) {
          ws.send(
            JSON.stringify({
              type: "browser_task_cancel_result",
              request_id: requestId,
              ok: true,
              canceled,
              target_request_id: targetRequestId || null,
            })
          );
        }
        return;
      }

      if (msg.type === "browser_task_run") {
        const requestId = String(msg.request_id || "");
        const task = String(msg.task || "").trim();
        const startUrl = typeof msg.start_url === "string" ? msg.start_url : undefined;
        const appUrl = String(msg.app_url || "").trim();
        const profileName = typeof msg.profile_name === "string" ? msg.profile_name : "default";
        const apiKey = typeof msg.api_key === "string" ? msg.api_key.trim() : "";
        const cliToken = typeof msg.cli_token === "string" ? msg.cli_token.trim() : "";
        const billingBillable =
          msg.billing_billable === true ? true : msg.billing_billable === false ? false : undefined;
        const billingChargeType =
          typeof msg.billing_charge_type === "string" ? msg.billing_charge_type.trim() : "";
        const billingAuthOrigin =
          typeof msg.billing_auth_origin === "string" ? msg.billing_auth_origin.trim() : "";
        const billingAuthMethod =
          typeof msg.billing_auth_method === "string" ? msg.billing_auth_method.trim() : "";
        const requestedTimeoutMs = Number(msg.timeout_ms);
        const envBrowserTimeoutMs = Number(
          process.env.GROOVY_BROWSER_TASK_TIMEOUT_MS || process.env.GROOVY_PLAYWRIGHT_TIMEOUT_MS || ""
        );
        const browserTaskTimeoutMs =
          Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
            ? requestedTimeoutMs
            : Number.isFinite(envBrowserTimeoutMs) && envBrowserTimeoutMs > 0
              ? envBrowserTimeoutMs
              : 8 * 60 * 1000;

        if (!requestId) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "browser_task_run_result",
                request_id: "",
                ok: false,
                error: "missing_request_id",
              })
            );
          }
          return;
        }

        const browserTaskSignature = buildBrowserTaskSignature({
          task,
          startUrl: startUrl || "",
          profileName,
        });
        const browserTaskSessionKey = buildBrowserTaskSessionKey({
          profileName,
          startUrl: startUrl || "",
        });
        const nowMs = Date.now();
        pruneBrowserTaskSuccessCache(nowMs);
        pruneBrowserTaskClaudeSessions(nowMs);
        const cachedClaudeSession = browserTaskClaudeSessionByProfile.get(browserTaskSessionKey);
        const continueSessionId =
          cachedClaudeSession && typeof cachedClaudeSession.sessionId === "string"
            ? cachedClaudeSession.sessionId.trim()
            : "";
        const cachedSuccess = recentBrowserTaskSuccessBySignature.get(browserTaskSignature);
        if (cachedSuccess) {
          const duplicateHits = Number(cachedSuccess.duplicateHits || 0) + 1;
          cachedSuccess.duplicateHits = duplicateHits;
          recentBrowserTaskSuccessBySignature.set(browserTaskSignature, cachedSuccess);
          log("browser_task_run duplicate detected; reusing cached success", {
            duplicateHits,
            cacheAgeMs: nowMs - Number(cachedSuccess.tsMs || nowMs),
          });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "browser_task_run_result",
                request_id: requestId,
                ...(cachedSuccess.result || {}),
                ...(typeof billingBillable === "boolean" ? { billing_billable: billingBillable } : {}),
                ...(billingChargeType ? { billing_charge_type: billingChargeType } : {}),
                ...(billingAuthOrigin ? { billing_auth_origin: billingAuthOrigin } : {}),
                ...(billingAuthMethod ? { billing_auth_method: billingAuthMethod } : {}),
                cached_duplicate: true,
                loop_guard: true,
                warning:
                  "Repeated browser_task_run detected for the same task. Reusing previous successful result to avoid infinite loops.",
                duplicate_hits: duplicateHits,
              })
            );
          }
          return;
        }

        const existing = pendingBrowserTaskRuns.get(requestId);
        if (existing) {
          try {
            existing.abort();
          } catch {
            // ignore
          }
          pendingBrowserTaskRuns.delete(requestId);
        }

        const abortController = new AbortController();
        pendingBrowserTaskRuns.set(requestId, abortController);
        const runOne = async () => {
          let result;
          try {
            const usePlaywright = await isPlaywrightAvailable();
            if (usePlaywright) {
              log("browser_task_run using Playwright MCP", {
                hasContinueSession: !!continueSessionId,
                continueSessionPreview: continueSessionId ? continueSessionId.slice(0, 8) : null,
              });
              result = await runBrowserTaskViaPlaywright({
                task,
                start_url: startUrl,
                api_key: apiKey,
                cli_token: cliToken,
                timeout_ms: browserTaskTimeoutMs,
                profile_name: profileName,
                session_id: continueSessionId || undefined,
                abortSignal: abortController.signal,
              });
              if (
                continueSessionId &&
                result &&
                typeof result === "object" &&
                result.ok !== true &&
                typeof result.error === "string" &&
                /continue|session/i.test(result.error)
              ) {
                log("browser_task_run continue session failed; retrying fresh session", {
                  continueSessionPreview: continueSessionId.slice(0, 8),
                  error: result.error,
                });
                result = await runBrowserTaskViaPlaywright({
                  task,
                  start_url: startUrl,
                  api_key: apiKey,
                  cli_token: cliToken,
                  timeout_ms: browserTaskTimeoutMs,
                  profile_name: profileName,
                  abortSignal: abortController.signal,
                });
              }
            } else {
              log("browser_task_run using legacy Computer Use", { usePlaywright, hasApiKey: !!apiKey, hasCliToken: !!cliToken });
              result = await runBrowserTaskOnConnector({
                task,
                start_url: startUrl,
                app_url: appUrl,
                profile_name: profileName,
                device_token: activeDeviceToken || undefined,
              });
            }
            return result;
          } finally {
            const current = pendingBrowserTaskRuns.get(requestId);
            if (current === abortController) {
              pendingBrowserTaskRuns.delete(requestId);
            }
          }
        };

        const queuedRun = browserTaskRunQueue.then(runOne, runOne);
        browserTaskRunQueue = queuedRun.then(
          () => undefined,
          () => undefined
        );
        const result = await queuedRun;

        if (
          result &&
          typeof result === "object" &&
          result.ok === true &&
          typeof result.text === "string" &&
          result.text.trim()
        ) {
          recentBrowserTaskSuccessBySignature.set(browserTaskSignature, {
            tsMs: Date.now(),
            duplicateHits: 0,
            result,
          });
          if (typeof result.sessionId === "string" && result.sessionId.trim()) {
            browserTaskClaudeSessionByProfile.set(browserTaskSessionKey, {
              sessionId: result.sessionId.trim(),
              tsMs: Date.now(),
            });
          }
        } else if (continueSessionId) {
          // Avoid repeatedly trying a stale session id on follow-up runs.
          browserTaskClaudeSessionByProfile.delete(browserTaskSessionKey);
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "browser_task_run_result",
            request_id: requestId,
            ...result,
            ...(typeof billingBillable === "boolean" ? { billing_billable: billingBillable } : {}),
            ...(billingChargeType ? { billing_charge_type: billingChargeType } : {}),
            ...(billingAuthOrigin ? { billing_auth_origin: billingAuthOrigin } : {}),
            ...(billingAuthMethod ? { billing_auth_method: billingAuthMethod } : {}),
          }));
        }
        return;
      }

      // ===== Credentials (local prompt + local encrypted vault) =====
      if (msg.type === "browser_credential_get") {
        const requestId = String(msg.request_id || "");
        const domain = String(msg.domain || "").trim();
        const result = await credentialGetMeta({ domain });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_credential_get_result", request_id: requestId, ...result }));
        }
        return;
      }

      if (msg.type === "browser_credential_request") {
        const requestId = String(msg.request_id || "");
        const domain = String(msg.domain || "").trim();
        const reason = typeof msg.reason === "string" ? msg.reason : undefined;
        const result = await credentialRequest({ domain, reason });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "browser_credential_request_result", request_id: requestId, ...result }));
        }
        return;
      }

      // ===== Claude Computer Use Actions =====
      // These are coordinate-based actions for Claude's Computer Use capability
      if (msg.type === "computer_use_action") {
        const requestId = String(msg.request_id || "");
        const action = String(msg.action || "screenshot");
        const coordinate = Array.isArray(msg.coordinate) ? msg.coordinate : null;
        const text = msg.text !== undefined ? String(msg.text) : undefined;
        const key = msg.key !== undefined ? String(msg.key) : undefined;
        const scrollDirection = String(msg.scroll_direction || "down");
        const scrollAmount = Number(msg.scroll_amount) || 3;
        const pageId = String(msg.page_id || "default");
        
        const result = await computerUseAction({
          action,
          coordinate,
          text,
          key,
          scrollDirection,
          scrollAmount,
          pageId,
        });
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: "computer_use_action_result", 
            request_id: requestId,
            action,
            ...result,
          }));
        }
        return;
      }

      if (msg.type === "computer_use_get_dimensions") {
        const requestId = String(msg.request_id || "");
        
        const result = getDisplayDimensions();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: "computer_use_get_dimensions_result", 
            request_id: requestId,
            ...result,
          }));
        }
        return;
      }

      // ===== Site Builder: dev server management =====

      if (msg.type === "site_dev_start") {
        const requestId = String(msg.request_id || "");
        const slug = String(msg.slug || "").trim();
        const sitePath = typeof msg.site_path === "string" ? msg.site_path.trim() : undefined;
        const startedAt = Date.now();
        let result = null;
        let errorText = null;
        try {
          result = await siteDevStart({ slug, sitePath });
        } catch (e) {
          errorText = e instanceof Error ? e.message : String(e);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "site_dev_start_result",
            request_id: requestId,
            ok: !errorText,
            ...(result || {}),
            error: errorText,
            duration_ms: Date.now() - startedAt,
          }));
        }
        return;
      }

      if (msg.type === "site_dev_stop") {
        const requestId = String(msg.request_id || "");
        const slug = String(msg.slug || "").trim();
        const startedAt = Date.now();
        let result = null;
        let errorText = null;
        try {
          result = await siteDevStop({ slug });
        } catch (e) {
          errorText = e instanceof Error ? e.message : String(e);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "site_dev_stop_result",
            request_id: requestId,
            ok: !errorText,
            ...(result || {}),
            error: errorText,
            duration_ms: Date.now() - startedAt,
          }));
        }
        return;
      }

      if (msg.type === "site_read_files") {
        const requestId = String(msg.request_id || "");
        const slug = String(msg.slug || "").trim();
        const sitePath = typeof msg.site_path === "string" ? msg.site_path.trim() : undefined;
        const startedAt = Date.now();
        let result = null;
        let errorText = null;
        try {
          result = await siteReadFiles({ slug, sitePath });
        } catch (e) {
          errorText = e instanceof Error ? e.message : String(e);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "site_read_files_result",
            request_id: requestId,
            ok: !errorText,
            ...(result || {}),
            error: errorText,
            duration_ms: Date.now() - startedAt,
          }));
        }
        return;
      }

      if (msg.type === "site_tunnel_request") {
        const requestId = String(msg.request_id || "");
        const nonce = String(msg.nonce || "").trim();
        const reqPath = String(msg.path || "/");
        const method = String(msg.method || "GET");
        const headers = msg.headers && typeof msg.headers === "object" ? msg.headers : {};
        let result = null;
        let errorText = null;
        try {
          result = await siteTunnelRequest({ nonce, reqPath, method, headers });
        } catch (e) {
          errorText = e instanceof Error ? e.message : String(e);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "site_tunnel_request_result",
            request_id: requestId,
            ok: result?.ok ?? false,
            ...(result || {}),
            error: errorText || result?.error || null,
          }));
        }
        return;
      }
      } finally {
        if (releasePrioritySlot) {
          try {
            releasePrioritySlot();
          } catch {
            // ignore
          }
        }
      }
    });

    ws.on("close", (code, reason) => {
      if (activeRelayWs === ws) activeRelayWs = null;
      const reasonText =
        reason && Buffer.isBuffer(reason) && reason.length
          ? reason.toString("utf8")
          : "";
      warn(
        "disconnected from relay",
        code ? `code=${code}` : "",
        reasonText ? `reason=${reasonText}` : ""
      );

      if (pingInterval) {
        try {
          clearInterval(pingInterval);
        } catch {
          // ignore
        }
        pingInterval = null;
      }
      pingOutstanding = false;
      pingRequestId = null;

      // Stop scheduler loops until we reconnect + re-auth
      stopSchedulerLoops();

      // Any in-flight browser_task_run / claude_run can no longer return a result while relay is down.
      // Abort them so Playwright/Claude child processes don't keep running orphaned.
      if (pendingBrowserTaskRuns.size > 0) {
        log("aborting in-flight browser tasks after relay disconnect", {
          count: pendingBrowserTaskRuns.size,
        });
        for (const [, controller] of pendingBrowserTaskRuns.entries()) {
          try {
            controller.abort();
          } catch {
            // ignore
          }
        }
        pendingBrowserTaskRuns.clear();
      }
      if (pendingClaudeRuns.size > 0) {
        log("aborting in-flight claude runs after relay disconnect", {
          count: pendingClaudeRuns.size,
        });
        for (const [, entry] of pendingClaudeRuns.entries()) {
          try { abortPendingClaudeRun(entry); } catch { /* ignore */ }
        }
        pendingClaudeRuns.clear();
      }

      // Close WebRTC sessions
      for (const [, sess] of webrtcPeers.entries()) {
        try {
          sess.dc?.close();
        } catch {}
        try {
          sess.pc?.close();
        } catch {}
      }
      webrtcPeers.clear();
      for (const [, chans] of webrtcChannelsByTerminal.entries()) {
        for (const dc of chans) {
          try {
            dc.close();
          } catch {
            // ignore
          }
        }
      }
      webrtcChannelsByTerminal.clear();

      // Keep persistent terminals alive across reconnects; only kill ephemeral ones.
      for (const [terminalId, p] of terminals.entries()) {
        const meta = terminalMeta.get(terminalId);
        const persist = meta?.persist === true;
        if (persist) continue;
        try {
          p.kill();
        } catch {
          // ignore
        }
        terminals.delete(terminalId);
        terminalMeta.delete(terminalId);
      }

      if (!shouldReconnect) {
        const exitProcess = () => releaseSingleInstanceLock().finally(() => process.exit(0));
        if (pendingShutdownCleanup) {
          Promise.resolve(pendingShutdownCleanup)
            .catch((e) => {
              warn("shutdown cleanup failed", e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
              pendingShutdownCleanup = null;
              exitProcess();
            });
        } else {
          exitProcess();
        }
        return;
      }

      // Auto-reconnect with exponential backoff
      // Treat "short-lived opens" as failures so we don't get stuck in 1s reconnect loops.
      const uptimeMs = Math.max(0, Date.now() - (openedAt || Date.now()));
      if (uptimeMs >= 30_000) {
        reconnectAttempts = 0;
      }
      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
      log(`reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
      setTimeout(connect, delay);
    });

    ws.on("error", (err) => {
      warn("ws error:", err?.message || String(err));
      // Let onclose handle reconnection
    });
  }

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    log("shutting down...");
    shouldReconnect = false;
    siteDevStopAll();
    for (const [, controller] of pendingBrowserTaskRuns.entries()) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    pendingBrowserTaskRuns.clear();
    for (const [, entry] of pendingClaudeRuns.entries()) {
      try { abortPendingClaudeRun(entry); } catch { /* ignore */ }
    }
    pendingClaudeRuns.clear();
    for (const [, p] of terminals.entries()) {
      try {
        p.kill();
      } catch {
        // ignore
      }
    }
    releaseSingleInstanceLock().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    log("shutting down...");
    shouldReconnect = false;
    siteDevStopAll();
    for (const [, controller] of pendingBrowserTaskRuns.entries()) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    pendingBrowserTaskRuns.clear();
    for (const [, entry] of pendingClaudeRuns.entries()) {
      try { abortPendingClaudeRun(entry); } catch { /* ignore */ }
    }
    pendingClaudeRuns.clear();
    for (const [, p] of terminals.entries()) {
      try {
        p.kill();
      } catch {
        // ignore
      }
    }
    releaseSingleInstanceLock().finally(() => process.exit(0));
  });

  function isIgnorableConnectorRuntimeError(err) {
    const msg = (err && typeof err === "object" && "message" in err ? String(err.message) : String(err || "")).toLowerCase();
    // Puppeteer/Playwright-style transient navigation/session errors that shouldn't kill the connector.
    // These can happen during WhatsApp Web reloads, Chrome profile recovery, or page navigation.
    return (
      msg.includes("execution context was destroyed") ||
      msg.includes("most likely because of a navigation") ||
      msg.includes("target closed") ||
      msg.includes("session closed") ||
      msg.includes("protocol error") ||
      msg.includes("runtime.callfunctionon timed out") ||
      msg.includes("increase the 'protocoltimeout' setting") ||
      msg.includes("cannot find context with specified id") ||
      msg.includes("page has been closed") ||
      msg.includes("navigating frame was detached") ||
      msg.includes("frame was detached")
    );
  }
  // Ensure we release the lock on unexpected crashes as well.
  process.on("uncaughtException", (err) => {
    const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err || "");
    if (isIgnorableConnectorRuntimeError(err)) {
      warn("uncaughtException (ignored):", msg);
      return;
    }
    warn("uncaughtException:", msg);
    try {
      siteDevStopAll();
    } catch {
      // ignore
    }
    releaseSingleInstanceLock().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (err) => {
    const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err || "");
    if (isIgnorableConnectorRuntimeError(err)) {
      warn("unhandledRejection (ignored):", msg);
      return;
    }
    warn("unhandledRejection:", msg);
    try {
      siteDevStopAll();
    } catch {
      // ignore
    }
    releaseSingleInstanceLock().finally(() => process.exit(1));
  });

  // Start connection
  connect();
}

main().catch((err) => fatal(err?.message || String(err)));
