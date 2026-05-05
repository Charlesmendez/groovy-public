import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dns from "dns";
import net from "net";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import { execPortableCommand } from "./platform/shell/index.mjs";
import {
  killProcessesByCommandFragment,
  removeSingletonLocks,
} from "./platform/process/index.mjs";
import { runHeadlessClaude } from "./platform/claude/runHeadless.mjs";

import {
  initBrowser,
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
  computerUseAction,
  getDisplayDimensions,
  closeBrowser,
} from "./browser.mjs";
import { runBrowserTaskOnConnector, runBrowserTaskViaPlaywright, isPlaywrightAvailable } from "./browserTask.mjs";
import { credentialGetMeta, credentialRequest } from "./credentials.mjs";
import {
  fileRead,
  fileWrite,
  fileList,
  fileSearch,
  fileDelete,
  fileCreateDir,
  fileMove,
} from "./files.mjs";
import { siteDevStart, siteDevStop, siteReadFiles } from "./siteDev.mjs";
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
  linkdbInit,
  linkdbUpsertLinks,
  linkdbUpdate,
  linkdbQuery,
  linkdbDigest,
} from "./linkdb.mjs";
import { sqliteExec, sqliteQuery, sqliteListDbs } from "./sqlitedb.mjs";
import { sqliteProjectList, sqliteProjectGetOrCreate, sqliteProjectUpdate } from "./sqliteProjects.mjs";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatErrorWithCause(err) {
  if (err instanceof Error) {
    const cause =
      err && typeof err === "object" && "cause" in err && err.cause != null
        ? err.cause
        : null;
    let fallbackCauseText = "";
    if (cause && !(cause instanceof Error) && typeof cause !== "string") {
      try {
        fallbackCauseText = JSON.stringify(cause);
      } catch {
        fallbackCauseText = String(cause);
      }
    }
    const causeText =
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : fallbackCauseText;
    return causeText && causeText !== err.message ? `${err.message} | cause: ${causeText}` : err.message;
  }
  return String(err || "unknown_error");
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

async function fetchPublicUrlBuffer({ startUrl, timeoutMs = 10000, maxRedirects = 3, maxBytes = 15 * 1024 * 1024 }) {
  let currentUrl = String(startUrl || "").trim();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return { ok: false, error: "invalid_url" };
    }
    if (parsed.protocol !== "https:") return { ok: false, error: "url_must_be_https" };
    try {
      await assertPublicHostname(parsed.hostname);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "host_blocked" };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop >= maxRedirects) return { ok: false, error: "redirect_limit_exceeded" };
      const location = res.headers.get("location");
      if (!location) return { ok: false, error: "redirect_missing_location" };
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        return { ok: false, error: "redirect_invalid_location" };
      }
      continue;
    }

    if (!res.ok) return { ok: false, error: "download_failed", status: res.status };
    const contentLength = Number(res.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { ok: false, error: "file_too_large" };
    }

    const chunks = [];
    let total = 0;
    const reader = res.body?.getReader?.();
    if (!reader) {
      const ab = await res.arrayBuffer();
      if (ab.byteLength > maxBytes) return { ok: false, error: "file_too_large" };
      return {
        ok: true,
        buffer: Buffer.from(ab),
        contentType: String(res.headers.get("content-type") || "").trim(),
        finalUrl: currentUrl,
      };
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        return { ok: false, error: "file_too_large" };
      }
      chunks.push(chunk);
    }

    return {
      ok: true,
      buffer: Buffer.concat(chunks),
      contentType: String(res.headers.get("content-type") || "").trim(),
      finalUrl: currentUrl,
    };
  }
  return { ok: false, error: "redirect_loop" };
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
        detail:
          "Unsubscribe URL failed. Mailto unsubscribe prepared for manual send.",
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

/**
 * On Windows, Puppeteer's bundled Chrome isn't included in the connector bundle.
 * Detect a usable Chromium-based browser (Edge ships with every Windows 10+ install).
 * On macOS/Linux, return null to let Puppeteer use its own bundled Chrome.
 */
function detectBrowserExecutable() {
  if (process.platform !== "win32") return null;
  const candidates = [
    // Edge (always present on Windows 10+)
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    // Chrome
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
  }
  return null;
}

function log(...args) {
  console.log("[whatsapp]", ...args);
}

function warn(...args) {
  console.warn("[whatsapp]", ...args);
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

function homeDir() {
  return os.homedir();
}

function getDataPath() {
  return path.join(homeDir(), ".groovy", "whatsapp-web-session");
}

// Clear corrupted Chrome caches that cause "Target closed" crashes after unclean shutdowns.
// Preserves WhatsApp auth credentials (LocalAuth stores them separately from Chrome caches).
function clearCorruptedSessionCaches() {
  const sessionPath = path.join(getDataPath(), "session");
  // These directories contain GPU/shader/site-data caches that can corrupt on force-kill.
  // Removing them forces Chrome to rebuild them on next launch — harmless but fixes crashes.
  const cacheDirs = [
    "GrShaderCache",
    "ShaderCache",
    "GraphiteDawnCache",
    "Default/GPUCache",
    "Default/Service Worker",
    "Default/Cache",
    "Default/Code Cache",
    "Default/DawnGraphiteCache",
    "Default/DawnWebGPUCache",
  ];
  let cleared = 0;
  for (const dir of cacheDirs) {
    const fullPath = path.join(sessionPath, dir);
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      cleared++;
    } catch {
      // ignore — directory may not exist
    }
  }
  // Also clear IndexedDB/LocalStorage corruption markers
  const corruptionFiles = [
    "Default/IndexedDB/.csrc", // Chrome corruption sentinel
    "Default/Local Storage/leveldb/LOCK",
  ];
  for (const f of corruptionFiles) {
    try {
      fs.unlinkSync(path.join(sessionPath, f));
    } catch {
      // ignore
    }
  }
  if (cleared > 0) {
    log(`cleared ${cleared} corrupted cache directories from WhatsApp session`);
  }
  return cleared;
}

// Nuclear option for startup deadlocks/corruption loops.
// This removes LocalAuth/session state and forces a fresh QR link.
function hardResetWhatsAppSessionData() {
  const dataPath = getDataPath();
  try {
    fs.rmSync(dataPath, { recursive: true, force: true });
    fs.mkdirSync(dataPath, { recursive: true });
    log("hard-reset WhatsApp session data at", dataPath);
    return { ok: true };
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    warn("failed to hard-reset WhatsApp session data:", errText);
    return { ok: false, error: errText };
  }
}

// Kill any stale Chrome/puppeteer processes using our WhatsApp session directory.
// This prevents "browser already running" errors after unclean restarts.
async function killStaleBrowserForSession() {
  const sessionPath = path.join(getDataPath(), "session");
  try {
    const killResult = await killProcessesByCommandFragment(sessionPath, {
      processNameRegex: "chrome|chromium|msedge|whatsapp|puppeteer",
    });
    if (killResult.killed > 0) {
      log("killed stale browser processes", {
        matched: killResult.matched,
        killed: killResult.killed,
      });
      await sleep(300);
    }

    await removeSingletonLocks(sessionPath);
    await sleep(150); // brief pause for OS cleanup
  } catch (e) {
    warn("killStaleBrowserForSession error:", e instanceof Error ? e.message : String(e));
  }
}

function getBridgeStatePath() {
  return path.join(homeDir(), ".groovy", "whatsapp-bridge.json");
}

function normalizeText(s) {
  // Normalize whitespace + punctuation so queries like "Propheta.io-Team"
  // match chat names like "Propheta.io - Team".
  return (
    String(s || "")
      .replace(/\u00A0/g, " ")
      // treat separators as spaces
      .replace(/[‐‑‒–—−]/g, "-")
      .replace(/[-_./\\|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function stripAnsi(input) {
  // Good-enough ANSI stripper for WhatsApp output.
  // Covers CSI, OSC, and a few common control sequences.
  const s = String(input || "");
  return (
    s
      // OSC: \x1b] ... BEL or ST
      .replace(/\x1b\][0-9;]*[^\x07]*(\x07|\x1b\\)/g, "")
      // CSI: \x1b[ ... command
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // 2-byte escapes
      .replace(/\x1b[@-Z\\-_]/g, "")
  );
}

function connectorExecuteStatusText(ex) {
  const row = ex && typeof ex === "object" ? ex : {};
  const message = typeof row.message === "string" ? row.message.trim() : "";
  if (message) return message;

  const connectorType = String(row.connectorType || row.type || "").trim();
  if (connectorType === "site_dev_start") return "Starting local preview...";
  if (connectorType === "site_dev_stop") return "Stopping local preview...";
  if (connectorType === "site_read_files") return "Preparing deployment...";
  if (connectorType.startsWith("obsidian_")) return "Searching Obsidian vault...";
  if (connectorType.startsWith("browser_")) return "Working in browser...";
  if (connectorType.startsWith("file_")) return "Accessing files...";
  if (connectorType === "email_unsubscribe_execute") return "Executing unsubscribe locally...";
  if (connectorType === "terminal_step") return "Working in Claude Code...";
  if (connectorType === "claude_run") return "Running Claude...";
  if (connectorType === "runtime_branch_parallel_batch") return "Running parallel workers...";
  if (connectorType) return `Running ${connectorType}...`;
  return "Processing...";
}

function createProgressSender(sendReply, opts = {}) {
  const minIntervalMs = Math.max(500, Number(opts.minIntervalMs) || 3500);
  const maxChars = Math.max(80, Number(opts.maxChars) || 220);
  let lastSentAt = 0;
  let lastTextKey = "";

  return async (rawText, meta = {}) => {
    if (typeof sendReply !== "function") return;
    const force = meta && typeof meta === "object" && meta.force === true;
    const cleaned = stripAnsi(String(rawText || ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return;
    // Keep the most recent part of long progress text so updates don't look frozen.
    const text =
      cleaned.length > maxChars ? `...${cleaned.slice(-maxChars)}` : cleaned;
    const key = normalizeText(text).toLowerCase();
    const now = Date.now();

    if (!force) {
      if (key && key === lastTextKey) return;
      if (now - lastSentAt < minIntervalMs) return;
    }

    lastTextKey = key;
    lastSentAt = now;
    try {
      await sendReply(text);
    } catch {
      // ignore progress send failures
    }
  };
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
    if (SENSITIVE_KEYS.includes(k) || SENSITIVE_PATTERNS.test(k)) delete env[k];
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
    if (v.length > 4000) continue;
    out[k] = v;
  }
  return out;
}

function extractCommand(msg, prefix) {
  const t = normalizeText(msg);
  const lowerT = t.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  
  // Try exact match first (e.g., "@groovy")
  let idx = lowerT.indexOf(lowerPrefix);
  let matchLen = lowerPrefix.length;
  
  // WhatsApp sometimes strips the @ from mentions, so also try without @
  // e.g., "Groovy what's up" should match "@groovy"
  if (idx === -1 && lowerPrefix.startsWith("@")) {
    const withoutAt = lowerPrefix.slice(1);
    // Only match at word boundaries to avoid false positives
    const patterns = [
      new RegExp(`^${withoutAt}\\b`, "i"),           // Start of message: "Groovy ..."
      new RegExp(`\\s${withoutAt}\\b`, "i"),         // After space: "Hey Groovy ..."
    ];
    for (const pattern of patterns) {
      const match = lowerT.match(pattern);
      if (match) {
        idx = match.index || 0;
        // Adjust for the space if matched after space
        if (match[0].startsWith(" ") || match[0].startsWith("\t")) {
          idx += 1;
        }
        matchLen = withoutAt.length;
        break;
      }
    }
  }
  
  if (idx === -1) return null;
  
  // Remove the tag and return the rest of the message
  const withoutPrefix = t.slice(0, idx) + t.slice(idx + matchLen);
  return withoutPrefix.replace(/\s+/g, " ").trim();
}

function resolveGroupName(opts) {
  return (
    opts.groupName ||
    process.env.WHATSAPP_GROUP_NAME ||
    process.env.GROOVY_WHATSAPP_GROUP ||
    ""
  ).trim();
}

function resolveAppUrl(opts) {
  const raw =
    opts.appUrl ||
    process.env.GROOVY_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "";
  return raw.trim().replace(/\/+$/, "");
}

function resolveWhatsAppWebVersion() {
  // Known-good versions reported in the wild for recent WA regressions:
  // - 2.3000.1031490220-alpha
  // - 2.3000.1031980585-alpha
  return (process.env.WHATSAPP_WEB_VERSION || "2.3000.1031980585-alpha").trim();
}

function resolveWhatsAppWebVersionRemotePath(version) {
  // whatsapp-web.js supports pinning the WA Web bundle via remote HTML snapshots.
  // Default to wppconnect-team/wa-version.
  const custom = (process.env.WHATSAPP_WEB_VERSION_REMOTE_PATH || "").trim();
  if (custom) return custom;
  return `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${version}.html`;
}

function shouldPinWhatsAppWebVersion(version) {
  const v = String(version || "").trim().toLowerCase();
  if (!v) return false;
  return !["auto", "latest", "none", "off", "disable"].includes(v);
}

function buildApiUrl(base) {
  return `${base}/api/whatsapp/local`;
}

function buildCodeApiUrl(base) {
  return `${base}/api/whatsapp/code`;
}

function buildSitesDeployApiUrl(base) {
  return `${base}/api/sites/deploy`;
}

const WHATSAPP_API_MAX_ATTEMPTS = Number.parseInt(
  process.env.WHATSAPP_API_FETCH_RETRIES || "",
  10
);
const WHATSAPP_API_TIMEOUT_MS = Number.parseInt(
  process.env.WHATSAPP_API_FETCH_TIMEOUT_MS || "",
  10
);

function resolveWhatsAppApiAttempts() {
  if (Number.isFinite(WHATSAPP_API_MAX_ATTEMPTS) && WHATSAPP_API_MAX_ATTEMPTS >= 1) {
    return Math.min(6, WHATSAPP_API_MAX_ATTEMPTS);
  }
  return 3;
}

function resolveWhatsAppApiTimeoutMs() {
  if (Number.isFinite(WHATSAPP_API_TIMEOUT_MS) && WHATSAPP_API_TIMEOUT_MS >= 5000) {
    return Math.min(120_000, WHATSAPP_API_TIMEOUT_MS);
  }
  return 120_000;
}

function buildWhatsAppIngressTraceId(messageLike) {
  const serialized =
    messageLike && typeof messageLike === "object" && typeof messageLike.id?._serialized === "string"
      ? messageLike.id._serialized.trim()
      : "";
  return serialized ? `wa:${serialized}` : null;
}

function whatsappApiRetryDelayMs(attempt) {
  const base = 500;
  return Math.min(4000, base * 2 ** Math.max(0, attempt - 1));
}

async function callWhatsAppApi({ baseUrl, deviceToken, body, allowRetries = false }) {
  const url = buildApiUrl(baseUrl);
  const timeoutMs = resolveWhatsAppApiTimeoutMs();
  const maxAttempts = allowRetries ? resolveWhatsAppApiAttempts() : 1;
  let lastNetworkErr = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Token": deviceToken,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text().catch(() => "");
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (res.ok) {
        return { ok: true, data: json };
      }

      const baseErr = json?.error || text || `HTTP ${res.status}`;
      if (res.status === 401) {
        return {
          ok: false,
          status: res.status,
          error:
            "Unauthorized (401). Your GROOVY_APP_URL must have RELAY_JWT_SECRET that matches the relay which minted this device_token. " +
            "If you're using localhost, set RELAY_JWT_SECRET to the production relay secret (or re-pair against a local relay).",
        };
      }

      const retryableStatus = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
      if (retryableStatus && attempt < maxAttempts) {
        const waitMs = whatsappApiRetryDelayMs(attempt);
        warn(
          `callWhatsAppApi retrying after HTTP ${res.status} (attempt ${attempt}/${maxAttempts}) in ${waitMs}ms`
        );
        await sleep(waitMs);
        continue;
      }
      return { ok: false, status: res.status, error: baseErr };
    } catch (e) {
      const errText = formatErrorWithCause(e);
      const timedOut = e instanceof Error && e.name === "AbortError";
      lastNetworkErr = timedOut ? `request_timeout_${timeoutMs}ms` : errText || "fetch failed";
      if (attempt < maxAttempts) {
        const waitMs = whatsappApiRetryDelayMs(attempt);
        warn(
          `callWhatsAppApi network failure (attempt ${attempt}/${maxAttempts}): ${lastNetworkErr}; retrying in ${waitMs}ms`
        );
        await sleep(waitMs);
        continue;
      }
      return { ok: false, status: 0, error: lastNetworkErr };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, status: 0, error: lastNetworkErr || "fetch failed" };
}

function isTerminalTwilioFollowupStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  return value === "completed" || value === "failed" || value === "ended";
}

async function watchTwilioFollowupThread({
  baseUrl,
  deviceToken,
  threadKey,
  threadName,
  initialFollowup,
  sendReply,
  watcherToken,
}) {
  const sessionId =
    initialFollowup && typeof initialFollowup.sessionId === "string"
      ? initialFollowup.sessionId.trim()
      : "";
  let cursor =
    initialFollowup && typeof initialFollowup.cursor === "string"
      ? initialFollowup.cursor.trim()
      : "";
  const childKind =
    initialFollowup && typeof initialFollowup.childKind === "string"
      ? initialFollowup.childKind.trim().toLowerCase()
      : "";
  let pollAfterMs =
    initialFollowup && Number.isFinite(Number(initialFollowup.pollAfterMs))
      ? Math.max(2500, Math.min(30000, Math.trunc(Number(initialFollowup.pollAfterMs))))
      : childKind === "sms"
        ? 15_000
        : 7_000;
  const maxWatchMs = childKind === "sms" ? 120_000 : 12 * 60_000;
  const startedAt = Date.now();

  while (
    twilioFollowupWatchersByThread.get(threadKey) === watcherToken &&
    Date.now() - startedAt < maxWatchMs
  ) {
    await sleep(pollAfterMs);
    if (twilioFollowupWatchersByThread.get(threadKey) !== watcherToken) break;

    const res = await callWhatsAppApi({
      baseUrl,
      deviceToken,
      allowRetries: true,
      body: {
        provider: "whatsapp_web",
        threadKey,
        threadName,
        twilioFollowup: {
          sinceCursor: cursor || undefined,
          sessionId: sessionId || undefined,
        },
      },
    });
    if (!res.ok) {
      warn("twilio followup poll failed:", res.error || "unknown_error");
      break;
    }

    const data = res.data && typeof res.data === "object" ? res.data : {};
    if (data.kind !== "twilio_followup") {
      warn("unexpected twilio followup response kind:", data.kind || "unknown");
      break;
    }

    const followup =
      data.twilioFollowup && typeof data.twilioFollowup === "object"
        ? data.twilioFollowup
        : {};
    const nextCursor =
      typeof followup.cursor === "string" ? followup.cursor.trim() : "";
    const nextMessage =
      typeof followup.message === "string" ? followup.message.trim() : "";
    const terminal =
      followup.terminal === true ||
      isTerminalTwilioFollowupStatus(followup.status);
    const nextPollAfterMs = Number(followup.pollAfterMs);

    if (nextMessage) {
      try {
        await sendReply(nextMessage);
        if (nextCursor) cursor = nextCursor;
      } catch (err) {
        warn("failed to send twilio followup message:", formatErrorWithCause(err));
      }
    } else if (nextCursor) {
      cursor = nextCursor;
    }

    if (Number.isFinite(nextPollAfterMs)) {
      pollAfterMs = Math.max(2500, Math.min(30000, Math.trunc(nextPollAfterMs)));
    }
    if (terminal) break;
  }

  if (twilioFollowupWatchersByThread.get(threadKey) === watcherToken) {
    twilioFollowupWatchersByThread.delete(threadKey);
  }
}

async function callWhatsAppCodeApi({ baseUrl, deviceToken, body }) {
  const url = buildCodeApiUrl(baseUrl);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Token": deviceToken,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const baseErr = json?.error || text || `HTTP ${res.status}`;
      if (res.status === 401) {
        return {
          ok: false,
          status: res.status,
          error:
            "Unauthorized (401). Your GROOVY_APP_URL must have RELAY_JWT_SECRET that matches the relay which minted this device_token. " +
            "If you're using localhost, set RELAY_JWT_SECRET to the production relay secret (or re-pair against a local relay).",
        };
      }
      return { ok: false, status: res.status, error: baseErr };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, status: 0, error: formatErrorWithCause(e) || "fetch failed" };
  }
}

async function callSitesDeployApi({ baseUrl, deviceToken, body }) {
  const url = buildSitesDeployApiUrl(baseUrl);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Token": deviceToken,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const baseErr = json?.error || text || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: baseErr, data: json };
    }
    return { ok: true, data: json };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: formatErrorWithCause(e) || "fetch failed",
      data: null,
    };
  }
}

async function maybeHandleSitePublishDeploy({
  baseUrl,
  deviceToken,
  connectorExecute,
  connectorResult,
  onProgress,
}) {
  const ex = connectorExecute && typeof connectorExecute === "object" ? connectorExecute : {};
  const r = connectorResult && typeof connectorResult === "object" ? connectorResult : {};
  const connectorType = String(ex.connectorType || "").trim();
  const toolName = String(ex.toolName || "").trim();
  if (connectorType !== "site_read_files" || toolName !== "site_publish") {
    return connectorResult;
  }

  const readOk = r.ok === true;
  const files = readOk && Array.isArray(r.files) ? r.files : [];
  if (!readOk || files.length === 0) {
    return connectorResult;
  }

  const params = ex.connectorParams && typeof ex.connectorParams === "object" ? ex.connectorParams : {};
  const slug = typeof params.slug === "string" ? params.slug.trim() : "";
  const siteId = typeof params.siteId === "string" ? params.siteId.trim() : "";

  if (typeof onProgress === "function") {
    try {
      await onProgress(`Deploying ${slug || "site"}...`);
    } catch {
      // ignore progress callback failures
    }
  }

  const deployRes = await callSitesDeployApi({
    baseUrl,
    deviceToken,
    body: {
      ...(siteId ? { siteId } : {}),
      ...(slug ? { slug } : {}),
      files,
    },
  });
  if (!deployRes.ok) {
    return {
      ok: false,
      error: deployRes.error || "deploy_failed",
      status: deployRes.status,
      response: deployRes.data || null,
    };
  }
  return {
    ok: true,
    ...(deployRes.data && typeof deployRes.data === "object" ? deployRes.data : {}),
  };
}

async function executeConnectorRpc({
  connectorType,
  connectorParams,
  codeRuntime,
  whatsappRuntime,
  deviceToken,
  onProgress,
}) {
  const t = String(connectorType || "");
  const p = connectorParams && typeof connectorParams === "object" ? connectorParams : {};
  const emitProgress = (text) => {
    const value = String(text || "").trim();
    if (!value || typeof onProgress !== "function") return;
    try {
      const maybePromise = onProgress(value);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.catch(() => {});
      }
    } catch {
      // ignore progress callback failures
    }
  };
  try {
    // WhatsApp (send/resolve) - requires the WhatsApp Web client runtime from startWhatsAppBridge
    if (t === "whatsapp_resolve_recipient") {
      if (!whatsappRuntime || typeof whatsappRuntime.resolveRecipient !== "function") {
        return { ok: false, error: "whatsapp_not_running" };
      }
      const query = String(p.query || "").trim();
      const limit = Number.isFinite(Number(p.limit)) ? Number(p.limit) : undefined;
      if (!query) return { ok: false, error: "missing_query" };
      return await whatsappRuntime.resolveRecipient({ query, limit });
    }
    if (t === "whatsapp_send_text") {
      if (!whatsappRuntime || typeof whatsappRuntime.sendTextToChatId !== "function") {
        return { ok: false, error: "whatsapp_not_running" };
      }
      const chatId = String(p.chat_id || "").trim();
      const text = String(p.text || "");
      if (!chatId) return { ok: false, error: "missing_chat_id" };
      if (!String(text || "").trim()) return { ok: false, error: "empty_message" };
      const r = await whatsappRuntime.sendTextToChatId({ chatId, text });
      // Echo back correlation fields (optional) so the server can mark pending sends as consumed
      const pending_message_id = String(p.pending_message_id || "").trim();
      const recipient_display = String(p.recipient_display || "").trim();
      return {
        ...(r && typeof r === "object" ? r : { ok: false, error: "send_failed" }),
        ...(pending_message_id ? { pending_message_id } : {}),
        ...(recipient_display ? { recipient_display } : {}),
      };
    }
    if (t === "whatsapp_send_media") {
      if (!whatsappRuntime || typeof whatsappRuntime.sendMediaToChatId !== "function") {
        return { ok: false, error: "whatsapp_not_running" };
      }
      const chatId = String(p.chat_id || "").trim();
      const url = String(p.url || "").trim();
      const localPath = String(p.local_path || "").trim();
      const filename = typeof p.filename === "string" ? p.filename : undefined;
      const caption = typeof p.caption === "string" ? p.caption : undefined;
      if (!chatId) return { ok: false, error: "missing_chat_id" };
      if (!url && !localPath) return { ok: false, error: "missing_url_or_local_path" };
      const r = await whatsappRuntime.sendMediaToChatId({
        chatId,
        url,
        localPath,
        filename,
        caption,
      });
      const pending_message_id = String(p.pending_message_id || "").trim();
      const recipient_display = String(p.recipient_display || "").trim();
      return {
        ...(r && typeof r === "object" ? r : { ok: false, error: "send_failed" }),
        ...(pending_message_id ? { pending_message_id } : {}),
        ...(recipient_display ? { recipient_display } : {}),
      };
    }

    // Inbox unsubscribe execution (local + guarded)
    if (t === "email_unsubscribe_execute") {
      const result = await executeLocalUnsubscribe({
        unsubscribeUrl: p.unsubscribe_url,
        unsubscribeMailto: p.unsubscribe_mailto,
      });
      const subject = typeof p.subject === "string" ? p.subject : "";
      const actionId = typeof p.action_id === "string" ? p.action_id : "";
      return {
        ...(result && typeof result === "object" ? result : { ok: false, error: "unsubscribe_failed" }),
        ...(subject ? { subject } : {}),
        ...(actionId ? { action_id: actionId } : {}),
      };
    }

    // Claude Code PTY relay (interactive)
    if (t === "terminal_step") {
      const runtime = codeRuntime || null;
      if (!runtime || typeof runtime.ensureTerminal !== "function") {
        return { ok: false, error: "missing_code_runtime" };
      }

      const terminalId = String(p.terminal_id || "").trim();
      const cwd = typeof p.cwd === "string" ? p.cwd.trim() : "";
      const input = String(p.input || "");
      const maxWaitMs = Number(p.max_wait_ms || 120_000);
      const quietMs = Number(p.quiet_ms || 1200);
      const captureMaxChars = Number(p.capture_max_chars || 12_000);

      if (!terminalId) return { ok: false, error: "missing_terminal_id" };
      const ensure = await runtime.ensureTerminal({
        terminalId,
        cwd: cwd || undefined,
        persist: true,
        startClaude: true,
      });
      if (!ensure?.ok) return { ok: false, error: ensure?.error || "ensure_terminal_failed" };

      const beforeLen =
        typeof runtime.getBufferLen === "function" ? runtime.getBufferLen(terminalId) : 0;

      const toSend = input.endsWith("\n") || input.endsWith("\r") ? input : `${input}\r`;
      if (toSend) {
        runtime.sendInput({ terminalId, data: toSend });
      }

      const start = Date.now();
      let lastLen = beforeLen;
      let stableSince = Date.now();
      let lastProgressAt = 0;
      let lastProgressSample = "";
      while (Date.now() - start < maxWaitMs) {
        await sleep(200);
        const curLen =
          typeof runtime.getBufferLen === "function" ? runtime.getBufferLen(terminalId) : lastLen;
        if (curLen !== lastLen) {
          lastLen = curLen;
          stableSince = Date.now();
          const now = Date.now();
          if (now - lastProgressAt >= 1500 && typeof runtime.getDelta === "function") {
            const liveDelta = stripAnsi(runtime.getDelta(terminalId, beforeLen, 900) || "")
              .replace(/\s+/g, " ")
              .trim();
            if (liveDelta && liveDelta !== lastProgressSample) {
              lastProgressSample = liveDelta;
              emitProgress(`Claude output: ${liveDelta}`);
            }
            lastProgressAt = now;
          }
          continue;
        }
        if (Date.now() - stableSince >= quietMs) break;
      }

      const delta =
        typeof runtime.getDelta === "function"
          ? runtime.getDelta(terminalId, beforeLen, captureMaxChars)
          : "";
      const tail =
        typeof runtime.getTail === "function" ? runtime.getTail(terminalId, captureMaxChars) : "";

      return {
        ok: true,
        terminalId,
        beforeLen,
        afterLen: lastLen,
        waitedMs: Date.now() - start,
        delta: stripAnsi(delta || "").trim(),
        tail: stripAnsi(tail || "").trim(),
      };
    }

    // Site Builder local runtime
    if (t === "site_dev_start") {
      const slug = String(p.slug || "").trim();
      const sitePath = typeof p.site_path === "string" ? p.site_path.trim() : undefined;
      if (!slug) return { ok: false, error: "missing_slug" };
      return await siteDevStart({ slug, sitePath });
    }
    if (t === "site_dev_stop") {
      const slug = String(p.slug || "").trim();
      if (!slug) return { ok: false, error: "missing_slug" };
      return await siteDevStop({ slug });
    }
    if (t === "site_read_files") {
      const slug = String(p.slug || "").trim();
      const sitePath = typeof p.site_path === "string" ? p.site_path.trim() : undefined;
      if (!slug) return { ok: false, error: "missing_slug" };
      return await siteReadFiles({ slug, sitePath });
    }

    // Non-interactive shell execution (bash -lc)
    if (t === "terminal_exec") {
      const command = String(p.command || "").trim();
      const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : os.homedir();
      const timeoutMs = Number.isFinite(Number(p.timeout_ms)) ? Number(p.timeout_ms) : 10 * 60 * 1000;
      const maxOutputChars = Number.isFinite(Number(p.max_output_chars)) ? Number(p.max_output_chars) : 40_000;
      const extraEnv = p.env && typeof p.env === "object" ? p.env : null;

      if (!command) return { ok: false, error: "missing_command" };

      const startedAt = Date.now();
      let ok = true;
      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      let errorText = null;
      try {
        const env = mergeExtraEnv(buildSanitizedEnv(cwd), extraEnv);
        const { stdout: out, stderr: err } = await execPortableCommand(command, {
          cwd,
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

      // Truncate output deterministically (tail)
      const maxChars = Math.max(1000, maxOutputChars);
      if (stdout.length + stderr.length > maxChars) {
        const half = Math.floor(maxChars / 2);
        stdout = stdout.length > half ? stdout.slice(-half) : stdout;
        const remaining = Math.max(0, maxChars - stdout.length);
        stderr = stderr.length > remaining ? stderr.slice(-remaining) : stderr;
      }

      return {
        ok,
        exit_code: exitCode,
        stdout: stripAnsi(stdout || "").trim(),
        stderr: stripAnsi(stderr || "").trim(),
        error: errorText,
        duration_ms: Math.max(0, Date.now() - startedAt),
      };
    }

    // Claude Code CLI (headless, non-interactive)
    // Uses stream-json for streaming and extracts diffs from Edit/Write tool usage
    if (t === "claude_run") {
      const prompt = String(p.prompt || "").trim();
      const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : os.homedir();
      const apiKey = typeof p.api_key === "string" ? p.api_key.trim() : "";
      const allowedTools = typeof p.allowed_tools === "string" ? p.allowed_tools.trim() : "Read,Edit,Bash";
      const timeoutMs = Number.isFinite(Number(p.timeout_ms)) ? Number(p.timeout_ms) : 5 * 60 * 1000;
      const sessionId = typeof p.session_id === "string" ? p.session_id.trim() : "";

      if (!prompt) return { ok: false, error: "missing_prompt" };
      if (!apiKey) return { ok: false, error: "missing_api_key" };

      const startedAt = Date.now();
      try {
        log("claude_run starting", { cwd, promptLen: prompt.length, allowedTools, sessionId: sessionId ? sessionId.slice(0, 8) + "..." : null });
        const spawnResult = await runHeadlessClaude({
          prompt,
          cwd,
          timeoutMs,
          apiKey,
          allowedTools,
          sessionId: sessionId || undefined,
          onAssistantText: (assistantText) => {
            const text = stripAnsi(String(assistantText || ""))
              .replace(/\s+/g, " ")
              .trim();
            if (text) emitProgress(`Claude: ${text}`);
          },
        });

        // Extract diffs from Edit/Write tool usage in stream events
        const diffs = [];
        const streamEvents = Array.isArray(spawnResult.streamEvents) ? spawnResult.streamEvents : [];
        let latestAssistantText = "";
        for (const event of streamEvents) {
          if (event.type === "assistant" && event.message?.content) {
            const assistantText = Array.isArray(event.message.content)
              ? event.message.content
                  .filter((block) => block?.type === "text" && typeof block?.text === "string")
                  .map((block) => block.text)
                  .join("")
                  .trim()
              : "";
            if (assistantText) {
              latestAssistantText = assistantText;
            }
            for (const block of event.message.content) {
              // Extract Edit tool diffs
              if (block.type === "tool_use" && block.name === "Edit" && block.input) {
                const { file_path, old_string, new_string } = block.input;
                if (file_path && old_string !== undefined && new_string !== undefined) {
                  const simpleDiff = `--- a/${file_path}\n+++ b/${file_path}\n@@ edit @@\n-${old_string.split('\n').join('\n-')}\n+${new_string.split('\n').join('\n+')}`;
                  diffs.push({ file: file_path, diff: simpleDiff, additions: new_string.split('\n').length, deletions: old_string.split('\n').length });
                }
              }
              // Extract Write tool diffs (new files)
              if (block.type === "tool_use" && block.name === "Write" && block.input) {
                const { file_path, content } = block.input;
                if (file_path && content) {
                  const writeDiff = `--- /dev/null\n+++ b/${file_path}\n@@ new file @@\n+${content.split('\n').join('\n+')}`;
                  diffs.push({ file: file_path, diff: writeDiff, additions: content.split('\n').length, deletions: 0 });
                }
              }
            }
          }
        }

        // Get result from stream events
        const resultEvents = streamEvents.filter((e) => e?.type === "result");
        const resultEvent = resultEvents.length > 0 ? resultEvents[resultEvents.length - 1] : null;
        let result =
          resultEvent || {
            raw_output: spawnResult.stdout || "",
            stderr: spawnResult.stderr || "",
            exit_code: spawnResult.code,
          };
        const timedOut = spawnResult.timedOut === true;
        const aborted = spawnResult.aborted === true;
        const partial =
          (typeof result?.result === "string" && result.result.trim().length > 0) ||
          latestAssistantText.length > 0 ||
          diffs.length > 0;

        if ((!result || typeof result.result !== "string" || !result.result.trim()) && latestAssistantText) {
          result.result = latestAssistantText;
        }
        if (sessionId && (typeof result?.session_id !== "string" || !result.session_id.trim())) {
          result.session_id = sessionId;
        }
        
        // Attach diffs to result
        if (diffs.length > 0) {
          result.diffs = diffs;
        }

        log("claude_run finished", {
          durationMs: Date.now() - startedAt,
          exitCode: spawnResult.code,
          signal: spawnResult.signal || null,
          isError: result?.is_error,
          resultLen: result?.result?.length,
          sessionId: result?.session_id ? result.session_id.slice(0, 8) + "..." : null,
          diffsFound: diffs.length,
          timedOut,
          aborted,
          partial,
        });

        if (timedOut || aborted) {
          return {
            ok: false,
            error: timedOut
              ? spawnResult.timeoutError || `claude_run timed out after ${timeoutMs}ms`
              : "claude_run_aborted",
            result,
            session_id: result?.session_id || null,
            diffs,
            timed_out: timedOut,
            aborted,
            partial,
            duration_ms: Date.now() - startedAt,
          };
        }

        return {
          ok: true,
          result,
          session_id: result?.session_id || null,
          diffs,
          duration_ms: Date.now() - startedAt,
        };
      } catch (e) {
        const err = e && typeof e === "object" ? e : null;
        const errorText = err && "message" in err ? String(err.message) : "claude_run_failed";
        warn("claude_run error", { error: errorText });
        return {
          ok: false,
          error: errorText,
          duration_ms: Date.now() - startedAt,
        };
      }
    }

    // Link Inbox (SQLite)
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

    // Credentials (local prompt + local encrypted vault)
    if (t === "browser_credential_get") return await credentialGetMeta({ domain: p.domain });
    if (t === "browser_credential_request") return await credentialRequest({ domain: p.domain, reason: p.reason });

    // Browser
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
        process.env.GROOVY_APP_URL ||
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
      if (!deviceToken) {
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

          const progressText = typeof row.message === "string" && row.message.trim()
            ? row.message.trim()
            : `Running ${nestedType} for worker ${branchId.slice(0, 8)}...`;
          emitProgress(progressText);

          let nestedResult;
          try {
            nestedResult = await executeConnectorRpc({
              connectorType: nestedType,
              connectorParams: nestedParams,
              codeRuntime,
              whatsappRuntime,
              deviceToken,
              onProgress,
            });
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
            "x-device-token": String(deviceToken),
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

    if (t === "browser_task_run") {
      const apiKey = typeof p.api_key === "string" ? p.api_key.trim() : "";
      const cliToken = typeof p.cli_token === "string" ? p.cli_token.trim() : "";
      const usePlaywright = await isPlaywrightAvailable();

      if (usePlaywright) {
        console.log("[whatsapp] browser_task_run using Playwright MCP");
        return await runBrowserTaskViaPlaywright({
          task: p.task,
          start_url: p.start_url,
          api_key: apiKey,
          cli_token: cliToken,
          timeout_ms: 8 * 60 * 1000,
          onProgress: emitProgress,
        });
      }

      console.log("[whatsapp] browser_task_run using legacy Computer Use");
      return await runBrowserTaskOnConnector({
        task: p.task,
        start_url: p.start_url,
        app_url: p.app_url,
        profile_name: p.profile_name || "default",
        device_token: deviceToken || undefined,
        onProgress: emitProgress,
      });
    }
    if (t === "browser_init") return await initBrowser(p);
    if (t === "browser_close") return await closeBrowser();
    if (t === "browser_navigate") return await browserNavigate({ url: p.url, pageId: p.page_id || "default" });
    if (t === "browser_click") return await browserClick({ selector: p.selector, pageId: p.page_id || "default", waitForNav: p.wait_for_nav === true });
    if (t === "browser_type") return await browserType({ selector: p.selector, text: p.text, pageId: p.page_id || "default", clear: p.clear !== false });
    if (t === "browser_press_key") return await browserPressKey({ key: p.key, pageId: p.page_id || "default" });
    if (t === "browser_screenshot") return await browserScreenshot({ pageId: p.page_id || "default", fullPage: p.full_page === true, selector: p.selector || null });
    if (t === "browser_extract") return await browserExtract({ pageId: p.page_id || "default", selector: p.selector || null, type: p.extract_type || "text" });
    if (t === "browser_wait") return await browserWait({ pageId: p.page_id || "default", selector: p.selector || null, timeout: Number(p.timeout) || 10000 });
    if (t === "browser_scroll") return await browserScroll({ pageId: p.page_id || "default", direction: p.direction || "down", amount: Number(p.amount) || 500 });
    if (t === "browser_info") return await browserGetInfo({ pageId: p.page_id || "default" });
    if (t === "browser_evaluate") return await browserEvaluate({ pageId: p.page_id || "default", script: p.script || "" });
    if (t === "browser_fill_form") return await browserFillForm({ pageId: p.page_id || "default", formSelector: p.form_selector || "form", fields: p.fields || {} });
    if (t === "browser_close_page") return await browserClosePage({ pageId: p.page_id || "default" });
    if (t === "browser_list_pages") return browserListPages();
    if (t === "computer_use_action") return await computerUseAction({ ...p });
    if (t === "computer_use_get_dimensions") return getDisplayDimensions();

    // Files
    if (t === "file_read") return await fileRead({ filePath: p.path, allowedRoots: p.allowed_roots });
    if (t === "file_write") return await fileWrite({ filePath: p.path, content: p.content, allowedRoots: p.allowed_roots });
    if (t === "file_list") return await fileList({ dirPath: p.path, recursive: p.recursive === true, allowedRoots: p.allowed_roots });
    if (t === "file_search") return await fileSearch({ rootPath: p.root || p.path, query: p.query, allowedRoots: p.allowed_roots, searchContent: p.search_content !== false });
    if (t === "file_delete") return await fileDelete({ filePath: p.path, allowedRoots: p.allowed_roots });
    if (t === "file_mkdir") return await fileCreateDir({ dirPath: p.path, allowedRoots: p.allowed_roots });
    if (t === "file_move") return await fileMove({ sourcePath: p.source, destPath: p.destination, allowedRoots: p.allowed_roots });

    // Obsidian
    if (t === "obsidian_discover") return await discoverVaults();
    if (t === "obsidian_read") return await obsidianRead({ vaultPath: p.vault_path || "", notePath: p.note_path || "" });
    if (t === "obsidian_write") return await obsidianWrite({ vaultPath: p.vault_path || "", notePath: p.note_path || "", content: p.content || "" });
    if (t === "obsidian_search") return await obsidianSearch({ vaultPath: p.vault_path || "", query: p.query || "", searchContent: p.search_content !== false, searchTags: p.search_tags !== false });
    if (t === "obsidian_list") return await obsidianList({ vaultPath: p.vault_path || "" });
    if (t === "obsidian_delete") return await obsidianDelete({ vaultPath: p.vault_path || "", notePath: p.note_path || "" });
    if (t === "obsidian_daily") return await obsidianDailyNote({ vaultPath: p.vault_path || "", content: p.content, append: p.append !== false });

    return { ok: false, error: `unsupported_connector_type:${t}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- Bridge state (persisted to disk) ---

function readBridgeState() {
  const p = getBridgeStatePath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // ignore
  }
  return {};
}

function writeBridgeState(next) {
  const p = getBridgeStatePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

// NOTE: The old non-interactive `claude -p` implementation (with local prompt history)
// was removed in favor of an orchestrator-driven interactive PTY relay.

function getWelcomeText() {
  // NOTE: Do NOT use literal @groovy or @code here - it triggers command detection on our own message!
  return (
    "👋 Groovy WhatsApp bridge connected!\n\n" +
    "Commands:\n" +
    "• groovy <message> — chat with Groovy\n" +
    "• groovy new — start a fresh session\n" +
    "• code <message> — Claude Code mode\n" +
    "• code new — start a fresh Code session\n\n" +
    "(prefix commands with @)"
  );
}

function getWelcomeHash() {
  return sha256Hex(getWelcomeText());
}

// Track messages we sent to avoid loops
const recentBotSends = new Map();
const twilioFollowupWatchersByThread = new Map(); // threadKey -> watcherToken
function rememberBotSend(text) {
  const key = sha256Hex(normalizeText(text));
  recentBotSends.set(key, Date.now());
  // Clean old entries
  for (const [k, ts] of recentBotSends.entries()) {
    if (Date.now() - ts > 120_000) recentBotSends.delete(k);
  }
}

function wasRecentlyBotSent(text) {
  const key = sha256Hex(normalizeText(text));
  const ts = recentBotSends.get(key);
  return typeof ts === "number" && Date.now() - ts < 60_000;
}

// Follow-up window for heartbeat prompts:
// if heartbeat asks a question, the next natural user message in that group
// can be auto-routed as a Groovy command (without requiring @groovy).
const heartbeatFollowupWindows = new Map(); // chatId -> { expiresAt, source, openedAt, promptPreview }

function pruneHeartbeatFollowupWindows() {
  const now = Date.now();
  for (const [chatId, row] of heartbeatFollowupWindows.entries()) {
    const expiresAt = Number(row?.expiresAt || 0);
    if (!expiresAt || expiresAt <= now) heartbeatFollowupWindows.delete(chatId);
  }
}

function peekHeartbeatFollowupWindow(chatId) {
  const cid = String(chatId || "").trim();
  if (!cid) return null;
  pruneHeartbeatFollowupWindows();
  return heartbeatFollowupWindows.get(cid) || null;
}

function consumeHeartbeatFollowupWindow(chatId) {
  const cid = String(chatId || "").trim();
  if (!cid) return null;
  const row = peekHeartbeatFollowupWindow(cid);
  if (row) heartbeatFollowupWindows.delete(cid);
  return row;
}

function setHeartbeatFollowupWindow(chatId, opts = {}) {
  const cid = String(chatId || "").trim();
  if (!cid) return;
  const rawSec =
    opts && typeof opts === "object" && Number.isFinite(Number(opts.windowSec))
      ? Number(opts.windowSec)
      : 7200;
  const windowSec = Math.max(30, Math.min(6 * 60 * 60, Math.floor(rawSec)));
  heartbeatFollowupWindows.set(cid, {
    openedAt: Date.now(),
    expiresAt: Date.now() + windowSec * 1000,
    source:
      opts && typeof opts === "object" && typeof opts.source === "string" && opts.source.trim()
        ? opts.source.trim()
        : "heartbeat",
    promptPreview:
      opts && typeof opts === "object" && typeof opts.promptPreview === "string"
        ? String(opts.promptPreview).slice(0, 160)
        : "",
  });
}

function normalizeImplicitFollowupPayload(text) {
  const raw = normalizeText(text);
  if (!raw) return "";
  const stripped = raw.replace(/^(?:yes|ok|okay|sure|yep|yeah)\b[\s,.:;-]*/i, "").trim();
  return stripped || raw;
}

function getCodeCwd(opts) {
  return (
    opts.codeCwd ||
    process.env.GROOVY_CODE_CWD ||
    process.env.WHATSAPP_CODE_CWD ||
    ""
  ).trim();
}

async function handleCodeMessage({
  chatId,
  chatName,
  opts,
  text,
  sendReply,
  whatsappRuntime,
  initialTraceId = null,
}) {
  const runtime = opts.codeRuntime || null;
  if (!runtime || typeof runtime.ensureTerminal !== "function") {
    await sendReply?.("Code mode runtime not available (connector upgrade required).");
    return;
  }

  const lower = normalizeText(text).toLowerCase();
  const isNew = lower === "new";
  const isSetup = lower === "setup";

  let cwd = getCodeCwd(opts);
  if (!cwd || isSetup) {
    if (typeof runtime.pickWorkspace !== "function") {
      await sendReply?.(
        "No workspace configured for Code mode. Open the dashboard and create/select a Code workspace, then restart the connector."
      );
      return;
    }

    await sendReply?.(
      isSetup
        ? "Pick the repo/workspace folder for Code mode (a macOS folder dialog will open on this Mac)…"
        : "First-time Code setup: pick the repo/workspace folder (a macOS folder dialog will open on this Mac)…"
    );

    const picked = await runtime.pickWorkspace();
    if (!picked?.ok) {
      await sendReply?.(
        "Setup cancelled. To enable Code mode, try `@code setup` again or open the dashboard and create/select a Code workspace."
      );
      return;
    }

    cwd = String(picked.path || "").trim();
    if (!cwd) {
      await sendReply?.(
        "Setup failed (empty path). Open the dashboard and create/select a Code workspace."
      );
      return;
    }
  }
  const baseUrl = resolveAppUrl(opts);
  const deviceToken = String(opts.deviceToken || "");
  const provider = "whatsapp_web";

  // Create/rotate session server-side so it shows up in the dashboard.
  log("code/calling_api", { baseUrl, provider, threadKey: chatId, isNew, codeCwd: cwd });
  const res = await callWhatsAppCodeApi({
    baseUrl,
    deviceToken,
    body: {
      provider,
      threadKey: chatId,
      threadName: chatName || null,
      command: isNew ? "new" : undefined,
      codeCwd: cwd,
    },
  });
  log("code/api_response", { ok: res.ok, error: res.error, data: res.data });

  if (!res.ok) {
    await sendReply?.(`Error: ${res.error}`);
    return;
  }

  const data = res.data || {};
  const terminalId = String(data.terminalId || "");
  const workspaceRootPath = String(data.workspaceRootPath || cwd);
  if (!terminalId) {
    await sendReply?.("Error: missing terminalId from server");
    return;
  }

  if (isNew) {
    await sendReply?.("✅ Started a new Code session for this WhatsApp thread (visible in the dashboard).");
    return;
  }

  // Relay to server-side orchestrator in code mode.
  // The orchestrator will decide what to send into Claude Code, and parse the resulting output.
  const userPrompt = String(text || "").trim();
  if (!userPrompt) return;

  let traceId = initialTraceId || null;
  let toolResults = [];
  const upsertToolResult = (nextResult) => {
    if (!nextResult || typeof nextResult !== "object") return;
    const toolCallId =
      typeof nextResult.toolCallId === "string" ? nextResult.toolCallId : "";
    if (!toolCallId) return;
    const idx = toolResults.findIndex((entry) => entry?.toolCallId === toolCallId);
    if (idx >= 0) {
      toolResults[idx] = nextResult;
    } else {
      toolResults.push(nextResult);
    }
  };
  let reply = "";

  log("code/relay_start", { chatId, terminalId, workspaceRootPath });
  // Timed pings to avoid dead air across the ENTIRE multi-round flow (emoji-free)
  // Desired cadence:
  // - first ping when we "have it" (we treat this as 10s)
  // - second ping at ~1.5 minutes
  // - third ping at ~3 minutes
  let ping1 = null;
  let ping2 = null;
  let ping3 = null;
  try {
    ping1 = setTimeout(() => {
      log("whatsapp/ping", { kind: "code", at: "10s" });
      sendReply("Still working…").catch(() => {});
    }, 10_000);
    ping2 = setTimeout(() => {
      log("whatsapp/ping", { kind: "code", at: "90s" });
      sendReply("Still working (almost there)…").catch(() => {});
    }, 90_000);
    ping3 = setTimeout(() => {
      log("whatsapp/ping", { kind: "code", at: "180s" });
      sendReply("Still working (taking longer than usual)…").catch(() => {});
    }, 180_000);
  } catch {
    // ignore
  }

  const sendProgress = createProgressSender(sendReply, {
    minIntervalMs: 2500,
    maxChars: 240,
  });
  for (let round = 0; round < 12; round++) {
    const body = {
      provider: "whatsapp_web",
      connectorPlatform:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "macos"
            : "unknown",
      threadKey: chatId,
      threadName: chatName || null,
      mode: "code",
      code: {
        terminalId,
        workspaceRootPath,
      },
      message: round === 0 ? userPrompt : "",
      toolResults: toolResults.length ? toolResults : undefined,
      traceId: traceId || undefined,
    };

    const res2 = await callWhatsAppApi({ baseUrl, deviceToken, body });
    if (!res2.ok) {
      reply = `Error: ${res2.error}`;
      break;
    }

    const data2 = res2.data || {};
    traceId = data2.traceId || traceId;
    log("code/relay_round", { round, traceId, kind: data2.kind });

    if (data2.kind === "final") {
      reply =
        String(data2.reply || "").trim() ||
        "I ran into an internal processing error. Please retry your @code message.";
      break;
    }

    if (data2.kind === "in_progress") {
      if (data2.statusMessage) await sendProgress(String(data2.statusMessage));
      const pollAfterMs = Number(data2.pollAfterMs);
      await sleep(
        Number.isFinite(pollAfterMs) ? Math.max(1000, Math.min(5000, Math.trunc(pollAfterMs))) : 2000
      );
      continue;
    }

    if (data2.kind === "needs_connector") {
      const execs = Array.isArray(data2.connectorExecutes) ? data2.connectorExecutes : [];
      if (execs.length === 0) {
        reply = String(data2.partialText || "").trim() || "(no response - tool execution issue)";
        break;
      }
      if (data2.statusMessage) await sendProgress(String(data2.statusMessage));
      for (const ex of execs) {
        log("code/relay_exec", { traceId, connectorType: ex.connectorType, toolName: ex.toolName });
        await sendProgress(connectorExecuteStatusText(ex));
        const rawResult = await executeConnectorRpc({
          connectorType: ex.connectorType,
          connectorParams: ex.connectorParams,
          codeRuntime: runtime,
          whatsappRuntime,
          deviceToken,
          onProgress: (msg) => {
            sendProgress(msg).catch(() => {});
          },
        });
        const r = await maybeHandleSitePublishDeploy({
          baseUrl,
          deviceToken,
          connectorExecute: ex,
          connectorResult: rawResult,
          onProgress: (msg) => sendProgress(msg),
        });
        upsertToolResult({
          toolCallId: ex.toolCallId,
          toolName: ex.toolName,
          result: JSON.stringify({ ok: !!r.ok, result: r, error: r.ok ? undefined : r.error }),
        });
      }
      continue;
    }

    if (data2.kind === "ui_open_code") {
      reply = "You're already in Code mode here — just send `@code <message>`.";
      break;
    }

    reply = `Unhandled response: ${data2.kind || "unknown"}`;
    break;
  }

  try {
    if (ping1) clearTimeout(ping1);
    if (ping2) clearTimeout(ping2);
    if (ping3) clearTimeout(ping3);
  } catch {
    // ignore
  }

  if (reply) await sendReply?.(reply);
}

// --- Main WhatsApp Bridge using whatsapp-web.js ---

export async function startWhatsAppBridge(opts = {}) {
  const groupName = resolveGroupName(opts);
  const appUrl = resolveAppUrl(opts);
  const deviceToken = String(opts.deviceToken || "");
  const disableWebVersionPin = opts.disableWebVersionPin === true;
  const resetSession = opts.resetSession === true;
  const onHealth = typeof opts.onHealth === "function" ? opts.onHealth : null;
  const emitHealth = (status, reason, detail = "") => {
    if (!onHealth) return;
    try {
      onHealth({
        status: String(status || "unknown"),
        reason: String(reason || "unknown"),
        detail: detail ? String(detail) : "",
        at: new Date().toISOString(),
      });
    } catch {
      // ignore connector callback errors
    }
  };

  if (!groupName) {
    warn("WHATSAPP_GROUP_NAME not set; skipping WhatsApp bridge");
    return;
  }
  if (!appUrl) {
    warn("GROOVY_APP_URL not set; skipping WhatsApp bridge");
    return;
  }
  if (!deviceToken) {
    warn("missing deviceToken; skipping WhatsApp bridge");
    return;
  }

  const dataPath = getDataPath();

  if (resetSession) {
    emitHealth(
      "recovering",
      "session_reset",
      "Resetting WhatsApp session data before startup (QR re-link may be required)"
    );
    hardResetWhatsAppSessionData();
  }

  fs.mkdirSync(dataPath, { recursive: true });

  log("starting WhatsApp Web bridge", { groupName, appUrl, dataPath });
  emitHealth("recovering", "starting", "Starting WhatsApp Web bridge");

  // Kill any stale browser processes from previous runs (prevents "browser already running" errors)
  await killStaleBrowserForSession();

  // Proactively clear Chrome caches that can get corrupted by unclean shutdowns.
  // This is cheap (Chrome rebuilds them) and prevents the "Target closed" crash loop.
  clearCorruptedSessionCaches();

  const webVersion = resolveWhatsAppWebVersion();
  const pinWebVersionRequested =
    !disableWebVersionPin && shouldPinWhatsAppWebVersion(webVersion);
  // The currently pinned alpha bundle can render enough DOM for the fallback
  // path while never finishing Store injection, which leaves the bridge stuck
  // in `whatsapp_store_not_ready`. Default to the live unpinned bundle until
  // we have a known-good pin again.
  const pinWebVersion = false;
  const webVersionRemotePath = pinWebVersion
    ? resolveWhatsAppWebVersionRemotePath(webVersion)
    : "";
  if (pinWebVersion) {
    log("pinning WhatsApp Web version", { webVersion, webVersionRemotePath });
  } else {
    log("using unpinned WhatsApp Web version fallback", {
      requestedPin: pinWebVersionRequested,
      disableWebVersionPin,
    });
  }

  const clientOptions = {
    authStrategy: new LocalAuth({ dataPath }),
    // Let Puppeteer advertise the real browser UA. whatsapp-web.js defaults to
    // a baked-in Chrome/101 UA, which can load enough DOM to trip the fallback
    // path while never finishing Store bootstrap on current WhatsApp Web.
    userAgent: false,
    puppeteer: {
    headless: false,
    ...(detectBrowserExecutable() ? { executablePath: detectBrowserExecutable() } : {}),
    // 4 min: cold boots after app updates can be significantly slower on some Macs.
    // A higher timeout avoids false-negative startup failures that require manual restarts.
    protocolTimeout: 240_000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-position=0,0",
      "--window-size=1650,1050",
    ],
    },
  };
  const webVersionCachePath = path.join(getDataPath(), ".wwebjs_cache");
  if (pinWebVersion) {
    // Pin WhatsApp Web build to avoid breakages/regressions in latest bundle.
    clientOptions.webVersionCache = {
      type: "remote",
      remotePath: webVersionRemotePath,
    };
  } else {
    // whatsapp-web.js defaults to a relative ./.wwebjs_cache path, which breaks
    // when the packaged app launches with a different cwd. Keep the cache inside
    // the connector data dir so auth-ready persistence does not throw ENOENT.
    clientOptions.webVersionCache = {
      type: "local",
      path: webVersionCachePath,
    };
  }
  const client = new Client(clientOptions);

  let targetChatId = null;
  let readySignalSeen = false;
  let storeReadyResolved = false;
  let readyResolved = false;
  let readyResolve = null;
  let lastOperationalReadyError = "";
  let lastLoggedOperationalReadyError = "";
  let qrPending = false;
  let authFailureText = "";
  let disconnectedReason = "";

  function buildOperationalReadyDetail(source, detail = "") {
    const base =
      source === "ready_fallback_dom"
        ? "WhatsApp Web send layer verified after DOM fallback"
        : "WhatsApp Web client is ready";
    return detail ? `${base} (${detail})` : base;
  }

  async function probeOperationalReadyOnce({ requireTargetBinding = false } = {}) {
    if (authFailureText) {
      return { ok: false, error: `auth_failure:${authFailureText}` };
    }
    if (qrPending) {
      return { ok: false, error: "whatsapp_qr_required" };
    }
    if (disconnectedReason) {
      return { ok: false, error: disconnectedReason };
    }

    let state = "";
    if (typeof client.getState === "function") {
      try {
        state = String((await client.getState()) || "").trim();
      } catch {
        state = "";
      }
    }
    const normalizedState = state.toUpperCase();
    if (normalizedState === "UNPAIRED" || normalizedState === "UNPAIRED_IDLE") {
      return { ok: false, error: "whatsapp_qr_required" };
    }
    if (normalizedState === "CONFLICT") {
      return { ok: false, error: "whatsapp_state_conflict" };
    }

    // When the caller requires target binding, the invariant we actually care
    // about is that whatsapp-web.js' in-page Store is injected AND the target
    // chat is resolvable. `readySignalSeen` alone is not enough — the DOM
    // fallback path (`ready_fallback_dom`) can set it before Store is wired,
    // which causes later client.sendMessage() to throw
    //   "Cannot read properties of undefined (reading 'getChat')"
    // and wedge the bridge in a restart loop. Probe Store directly here.
    //
    // We intentionally do NOT re-check chatMatchesConfiguredGroup here: the
    // binding was validated at bind time, and tightening it on every probe
    // would regress cases where the group was renamed (or where the DM/group
    // heuristic is flaky). A successful getChatById(targetChatId) is proof
    // Store is reachable, which is the only thing this probe validates.
    if (requireTargetBinding && targetChatId) {
      try {
        const directTarget = await client.getChatById(targetChatId);
        if (directTarget) {
          return {
            ok: true,
            detail: readySignalSeen
              ? `chat_id=${targetChatId}; target_bound=1`
              : `chat_id=${targetChatId}`,
          };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isDeadStoreError(msg)) {
          return { ok: false, error: "whatsapp_store_not_ready", detail: msg };
        }
        return { ok: false, error: msg };
      }
    }

    let chats = [];
    try {
      chats = await client.getChats();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isDeadStoreError(msg)) {
        return { ok: false, error: "whatsapp_store_not_ready", detail: msg };
      }
      return { ok: false, error: msg };
    }
    if (!Array.isArray(chats) || chats.length === 0) {
      return { ok: false, error: "whatsapp_chat_store_empty" };
    }

    if (!requireTargetBinding) {
      return {
        ok: true,
        detail: `store_chats=${chats.length}`,
      };
    }

    if (!targetChatId) {
      const found = chats.find((c) => chatMatchesConfiguredGroup(c)) || null;
      if (!found) {
        return { ok: false, error: `configured_group_not_loaded:${groupName}` };
      }
      await bindTargetChat(found, "operational_ready_name_match");
    }

    if (targetChatId) {
      try {
        const byId = await client.getChatById(targetChatId).catch(() => null);
        const resolved =
          byId || chats.find((c) => c?.id?._serialized === targetChatId) || null;
        if (!resolved) {
          return { ok: false, error: `target_chat_not_loaded:${targetChatId}` };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isDeadStoreError(msg)) {
          return { ok: false, error: "whatsapp_store_not_ready", detail: msg };
        }
        return { ok: false, error: msg };
      }
    }

    return {
      ok: true,
      detail: targetChatId ? `chat_id=${targetChatId}` : `group=${groupName}`,
    };
  }

  async function ensureOperationalReady(
    source = "startup",
    { requireTargetBinding = false, allowQrPending = false } = {}
  ) {
    if (requireTargetBinding && readyResolved) return { ok: true };
    if (!requireTargetBinding && (storeReadyResolved || readyResolved)) return { ok: true };

    let delayMs = 500;
    while (requireTargetBinding ? !readyResolved : !storeReadyResolved && !readyResolved) {
      const probe = await probeOperationalReadyOnce({ requireTargetBinding });
      if (probe.ok) {
        lastOperationalReadyError = "";
        lastLoggedOperationalReadyError = "";
        qrPending = false;
        authFailureText = "";
        disconnectedReason = "";
        if (!storeReadyResolved) {
          storeReadyResolved = true;
        }
        if (requireTargetBinding && !readyResolved) {
          readyResolved = true;
          if (readyResolve) readyResolve();
          log("WhatsApp Web client ready", {
            source,
            detail: probe.detail || null,
          });
          emitHealth(
            "healthy",
            source === "ready" ? "ready" : "ready_fallback",
            buildOperationalReadyDetail(source, probe.detail || "")
          );
        }
        return { ok: true, detail: probe.detail || "" };
      }

      lastOperationalReadyError = String(probe.error || "");
      if (
        lastOperationalReadyError &&
        lastOperationalReadyError !== lastLoggedOperationalReadyError
      ) {
        lastLoggedOperationalReadyError = lastOperationalReadyError;
        warn("WhatsApp operational ready pending", {
          source,
          requireTargetBinding,
          error: lastOperationalReadyError,
        });
      }
      if (lastOperationalReadyError === "whatsapp_qr_required" && allowQrPending) {
        await sleep(delayMs);
        delayMs = Math.min(5000, Math.round(delayMs * 1.5));
        continue;
      }
      if (
        lastOperationalReadyError === "whatsapp_qr_required" ||
        lastOperationalReadyError === "whatsapp_state_conflict" ||
        lastOperationalReadyError.startsWith("auth_failure:")
      ) {
        return { ok: false, error: lastOperationalReadyError };
      }

      await sleep(delayMs);
      delayMs = Math.min(5000, Math.round(delayMs * 1.5));
    }

    return { ok: true };
  }

  async function waitForOperationalReadyForSend(
    timeoutMs = 30000,
    source = "send",
    { requireTargetBinding = false } = {}
  ) {
    if (qrPending) {
      return {
        ok: false,
        error: "whatsapp_qr_required",
        detail: "QR scan required for WhatsApp Web",
      };
    }
    if (authFailureText) {
      return {
        ok: false,
        error: "whatsapp_auth_failure",
        detail: authFailureText,
      };
    }
    if (disconnectedReason) {
      if (isBridgeRestartNeeded(disconnectedReason)) {
        return { ok: false, error: "bridge_needs_restart", detail: disconnectedReason };
      }
      return { ok: false, error: `chat_not_ready (disconnected: ${disconnectedReason})` };
    }
    if (requireTargetBinding ? readyResolved : storeReadyResolved || readyResolved) {
      return { ok: true };
    }

    const outcome = await Promise.race([
      ensureOperationalReady(source, { requireTargetBinding }),
      sleep(timeoutMs).then(() => null),
    ]);

    if ((requireTargetBinding ? readyResolved : storeReadyResolved || readyResolved) || (outcome && outcome.ok === true)) {
      return { ok: true };
    }

    const outcomeError =
      outcome && typeof outcome === "object" && outcome.ok === false && typeof outcome.error === "string"
        ? outcome.error
        : "";
    if (outcomeError === "whatsapp_qr_required") {
      return {
        ok: false,
        error: "whatsapp_qr_required",
        detail: "QR scan required for WhatsApp Web",
      };
    }
    if (outcomeError.startsWith("auth_failure:")) {
      return {
        ok: false,
        error: "whatsapp_auth_failure",
        detail: outcomeError.replace(/^auth_failure:/, ""),
      };
    }

    const detail =
      lastOperationalReadyError ||
      outcomeError ||
      `operational_ready_timeout:${Math.max(0, Math.trunc(timeoutMs || 0))}ms`;
    if (isBridgeRestartNeeded(detail)) {
      return { ok: false, error: "bridge_needs_restart", detail };
    }
    return {
      ok: false,
      error: `chat_not_ready (operational_ready=0, detail: ${detail})`,
    };
  }

  async function markClientReady(source = "ready") {
    if (readySignalSeen || readyResolved) return;
    readySignalSeen = true;

    if (source === "ready") {
      log("WhatsApp Web ready event received; verifying chat store");
      emitHealth(
        "recovering",
        "ready_event",
        "WhatsApp ready event received; verifying chat access"
      );
    } else {
      warn("WhatsApp ready fallback activated before whatsapp-web.js emitted ready");
      emitHealth(
        "recovering",
        "ready_fallback",
        "WhatsApp Web became usable before the library ready event; verifying chat access"
      );
    }

    let saved = null;
    try {
      const savedState = readBridgeState();
      saved =
        savedState && typeof savedState === "object" && savedState.targetChatBinding && typeof savedState.targetChatBinding === "object"
          ? savedState.targetChatBinding
          : null;
    } catch {
      // corrupt bridge state — continue without persisted binding
    }
    const savedChatId = saved && typeof saved.chatId === "string" ? saved.chatId.trim() : "";
    const savedGroupNameNorm = saved && typeof saved.groupNameNorm === "string" ? saved.groupNameNorm.trim() : "";
    const savedChatName = saved && typeof saved.chatName === "string" ? saved.chatName : null;

    // Prefer persisted binding to avoid drift when multiple chats share the same name.
    if (savedChatId && (!savedGroupNameNorm || savedGroupNameNorm === groupNameNorm)) {
      try {
        const savedChat = await client.getChatById(savedChatId).catch(() => null);
        if (savedChat && chatMatchesConfiguredGroup(savedChat)) {
          await bindTargetChat(savedChat, source === "ready" ? "startup_saved_chatId" : "ready_fallback_saved_chatId");
        }
      } catch {
        // ignore
      }

      if (!targetChatId) {
        bindTargetChatById(savedChatId, savedChatName, source === "ready" ? "startup_persisted_id" : "ready_fallback_persisted_id");
      }
    }

    // Best-effort: try to bind immediately by name via library APIs.
    if (!targetChatId) {
      try {
        const chats = await client.getChats().catch(() => []);
        const found = chats.find((c) => chatMatchesConfiguredGroup(c)) || null;
        if (found) {
          await bindTargetChat(found, source === "ready" ? "startup_name_match" : "ready_fallback_name_match");
        } else {
          warn(
            `chat "${groupName}" not found yet (WhatsApp may still be syncing). ` +
              `Will auto-bind when a command is received in that group. ` +
              `Available chats (sample):`,
            chats.slice(0, 12).map((c) => getChatDisplayName(c) || "(unnamed)")
          );

          (async () => {
            const start = Date.now();
            const timeoutMs = 90_000;
            let delayMs = 1500;
            while (!targetChatId && Date.now() - start < timeoutMs) {
              await sleep(delayMs);
              delayMs = Math.min(8000, Math.round(delayMs * 1.4));
              try {
                const next = await client.getChats().catch(() => []);
                const f = next.find((c) => chatMatchesConfiguredGroup(c)) || null;
                if (f) {
                  await bindTargetChat(f, "retry_name_match");
                  break;
                }
              } catch {
                // ignore
              }
            }
          })().catch(() => {});
        }
      } catch (e) {
        warn("failed to enumerate chats on ready; will auto-bind on first command", e instanceof Error ? e.message : String(e));
      }
    }

    ensureOperationalReady(source, { requireTargetBinding: true }).catch(() => {});
  }

  const groupNameNorm = normalizeText(groupName).toLowerCase();
  function getChatDisplayName(chat) {
    // whatsapp-web.js sometimes leaves `name` undefined for some chat models.
    // Try a few likely fields.
    const any = chat && typeof chat === "object" ? chat : null;
    const contact = any && typeof any.contact === "object" && any.contact ? any.contact : null;
    const name =
      (any && typeof any.name === "string" && any.name) ||
      (any && typeof any.formattedTitle === "string" && any.formattedTitle) ||
      (any && typeof any.pushname === "string" && any.pushname) ||
      (contact && typeof contact.name === "string" && contact.name) ||
      (contact && typeof contact.pushname === "string" && contact.pushname) ||
      (contact && typeof contact.shortName === "string" && contact.shortName) ||
      (contact && typeof contact.verifiedName === "string" && contact.verifiedName) ||
      (contact && typeof contact.formattedName === "string" && contact.formattedName) ||
      "";
    const normalized = normalizeText(name);
    if (normalized) return normalized;

    // Fallback: use the id so DMs without loaded names are still searchable.
    const serialized = any?.id?._serialized ? String(any.id._serialized) : "";
    if (!serialized) return "";
    const base = serialized.split("@")[0] || serialized;
    return normalizeText(base) || serialized;
  }

  function chatMatchesConfiguredGroup(chat) {
    if (!groupNameNorm) return false;
    // Only bind to a GROUP chat. If there's a DM/contact with the same display name,
    // binding can drift and create new server sessions under the same "Groovy" title.
    if (!chat || chat.isGroup !== true) return false;
    const n = getChatDisplayName(chat).toLowerCase();
    return n === groupNameNorm;
  }

  async function maybeSendWelcomeToChat(chat) {
    const chatId = chat?.id?._serialized;
    if (!chatId) return;

    const state = readBridgeState();
    const welcomed = state?.welcomedThreads?.[chatId];
    const prevHash = welcomed?.hash || "";
    if (welcomed && prevHash === getWelcomeHash()) return;

    const welcomeText = getWelcomeText();
    try {
      await chat.sendMessage(welcomeText);
      rememberBotSend(welcomeText);
      writeBridgeState({
        ...state,
        welcomedThreads: {
          ...state.welcomedThreads,
          [chatId]: { at: new Date().toISOString(), hash: getWelcomeHash() },
        },
      });
      log("sent welcome message");
    } catch (e) {
      warn("failed to send welcome message:", e instanceof Error ? e.message : String(e));
    }
  }

  async function maybeEnsureCodeSessionForChat(chat) {
    try {
      const chatId = chat?.id?._serialized;
      if (!chatId) return;
      const codeCwd = getCodeCwd(opts);
      if (!codeCwd) return;
      await callWhatsAppCodeApi({
        baseUrl: appUrl,
        deviceToken,
        body: {
          provider: "whatsapp_web",
          threadKey: chatId,
          threadName: getChatDisplayName(chat) || groupName || null,
          codeCwd,
        },
      });
    } catch {
      // ignore
    }
  }

  function bindTargetChatById(chatId, chatName, reason = "auto") {
    if (!chatId) return false;
    targetChatId = chatId;
    log("bound target chat by id", { id: targetChatId, name: chatName || null, reason });
    try {
      const state = readBridgeState();
      writeBridgeState({
        ...state,
        targetChatBinding: {
          groupNameNorm,
          chatId: targetChatId,
          chatName: chatName || null,
          boundAt: new Date().toISOString(),
        },
      });
    } catch {
      // ignore
    }
    return true;
  }

  async function bindTargetChat(chat, reason = "auto") {
    const chatId = chat?.id?._serialized;
    if (!chatId) return false;
    targetChatId = chatId;
    log("bound target chat", { id: targetChatId, name: getChatDisplayName(chat), reason });
    // Persist binding so restarts don't re-scan by name and accidentally bind a different threadKey.
    try {
      const state = readBridgeState();
      writeBridgeState({
        ...state,
        targetChatBinding: {
          groupNameNorm,
          chatId: targetChatId,
          chatName: getChatDisplayName(chat) || null,
          boundAt: new Date().toISOString(),
        },
      });
    } catch {
      // ignore
    }
    await maybeSendWelcomeToChat(chat);
    await maybeEnsureCodeSessionForChat(chat);
    return true;
  }

  function truncateForWhatsApp(text, maxLen = 50000) {
    const t = String(text || "").trim();
    if (!t) return "";
    if (t.length <= maxLen) return t;
    // Keep the head (report summary/findings) since that's the most valuable content.
    // Truncate at the end with a clear marker.
    const truncated = t.slice(0, maxLen - 50);
    // Try to break at a paragraph or sentence boundary
    const lastPara = truncated.lastIndexOf("\n\n");
    const lastSentence = truncated.lastIndexOf(". ");
    const breakAt = lastPara > maxLen * 0.7 ? lastPara : lastSentence > maxLen * 0.7 ? lastSentence + 1 : truncated.length;
    return truncated.slice(0, breakAt) + "\n\n…[message truncated]";
  }

  /** Returns true when an error message indicates the browser frame/context is dead. */
  function isDetachedFrameError(msg) {
    if (!msg || typeof msg !== "string") return false;
    const lower = msg.toLowerCase();
    return (
      lower.includes("detached frame") ||
      lower.includes("execution context was destroyed") ||
      lower.includes("target closed") ||
      lower.includes("session closed") ||
      lower.includes("browser has disconnected") ||
      lower.includes("protocol error")
    );
  }

  function isDeadStoreError(msg) {
    if (!msg || typeof msg !== "string") return false;
    const lower = msg.toLowerCase();
    if (!lower.includes("cannot read properties of undefined")) return false;
    return (
      lower.includes("'getchat'") ||
      lower.includes("'getchats'") ||
      lower.includes("'sendmessage'") ||
      lower.includes("'findchat'") ||
      lower.includes("'getcontact'") ||
      lower.includes("'modelclass'")
    );
  }

  function isBridgeRestartNeeded(msg) {
    return isDetachedFrameError(msg) || isDeadStoreError(msg);
  }

  async function resolveTargetChatSafe() {
    if (!targetChatId) return null;
    try {
      return await client.getChatById(targetChatId);
    } catch {
      // Fallback to scanning chats (covers WA Store races)
      try {
        const chats = await client.getChats().catch(() => []);
        const found = chats.find((c) => c?.id?._serialized === targetChatId) || null;
        return found;
      } catch {
        return null;
      }
    }
  }

  async function sendTextToGroup(text, options = {}) {
    const msg = truncateForWhatsApp(text);
    if (!msg) return { ok: false, error: "empty_message" };
    const openFollowupWindow =
      options && typeof options === "object" && options.openFollowupWindow === true;
    const followupWindowSec =
      options && typeof options === "object" && Number.isFinite(Number(options.followupWindowSec))
        ? Number(options.followupWindowSec)
        : 7200;
    const followupSource =
      options && typeof options === "object" && typeof options.source === "string"
        ? options.source
        : "heartbeat";

    const readyCheck = await waitForOperationalReadyForSend(30000, "send_text_group", {
      requireTargetBinding: true,
    });
    if (!readyCheck.ok) return readyCheck;

    const maybeOpenFollowupWindow = (deliveredChatId) => {
      if (!openFollowupWindow || !deliveredChatId) return;
      setHeartbeatFollowupWindow(deliveredChatId, {
        windowSec: followupWindowSec,
        source: followupSource,
        promptPreview: msg,
      });
      log("heartbeat follow-up window opened", {
        chatId: deliveredChatId,
        windowSec: Math.max(30, Math.min(6 * 60 * 60, Math.floor(followupWindowSec))),
        source: followupSource,
      });
    };

    let chat = targetChatId ? await resolveTargetChatSafe() : null;
    if (!chat && targetChatId) {
      // Fallback: sometimes the chat model is stale/missing even though the chat id is valid.
      // Try direct send by chat id before failing the heartbeat.
      try {
        rememberBotSend(msg);
        await client.sendMessage(targetChatId, msg);
        maybeOpenFollowupWindow(targetChatId);
        log("heartbeat sent via direct chatId fallback", { chatId: targetChatId });
        return {
          ok: true,
          chatId: targetChatId,
          followupWindowOpened: openFollowupWindow,
          fallback: true,
        };
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        warn("heartbeat direct chatId fallback failed", {
          chatId: targetChatId,
          error: errMsg,
        });
        // If the browser frame is dead, no retry will help — tell the connector to restart the bridge.
        if (isBridgeRestartNeeded(errMsg)) {
          return { ok: false, error: "bridge_needs_restart", detail: errMsg };
        }
      }
    }

    if (!chat) {
      // Last attempt: re-scan chats by configured group name and rebind.
      try {
        const chats = await client.getChats().catch(() => []);
        const found = chats.find((c) => chatMatchesConfiguredGroup(c)) || null;
        if (found) {
          await bindTargetChat(found, "heartbeat_send_rebind");
          chat = found;
        }
      } catch {
        // ignore
      }
    }

    if (!chat && targetChatId) {
      try {
        await client.sendMessage(targetChatId, msg);
        rememberBotSend(msg);
        maybeOpenFollowupWindow(targetChatId);
        log("heartbeat sent via direct sendMessage (no Chat object)", { chatId: targetChatId });
        return {
          ok: true,
          chatId: targetChatId,
          followupWindowOpened: openFollowupWindow,
          fallback: true,
        };
      } catch (directErr) {
        const directErrMsg = directErr instanceof Error ? directErr.message : String(directErr);
        if (isBridgeRestartNeeded(directErrMsg)) {
          return { ok: false, error: "bridge_needs_restart", detail: directErrMsg };
        }
        return {
          ok: false,
          error: `chat_not_ready (targetChatId=${targetChatId}, ready=${readyResolved ? "1" : "0"}, sendMessage_failed: ${directErrMsg})`,
        };
      }
    }

    if (!chat) {
      return {
        ok: false,
        error: `chat_not_ready (targetChatId=${targetChatId || "none"}, ready=${readyResolved ? "1" : "0"})`,
      };
    }

    try {
      rememberBotSend(msg);
      await chat.sendMessage(msg);
      const deliveredChatId =
        chat?.id?._serialized ? String(chat.id._serialized) : targetChatId || "";
      maybeOpenFollowupWindow(deliveredChatId);
      return { ok: true, chatId: deliveredChatId || undefined, followupWindowOpened: openFollowupWindow };
    } catch (e) {
      const primaryErr = e instanceof Error ? e.message : String(e);
      const deliveredChatId =
        chat?.id?._serialized ? String(chat.id._serialized) : targetChatId || "";
      if (deliveredChatId) {
        try {
          rememberBotSend(msg);
          await client.sendMessage(deliveredChatId, msg);
          maybeOpenFollowupWindow(deliveredChatId);
          log("heartbeat sent via sendMessage fallback", {
            chatId: deliveredChatId,
            error: primaryErr,
          });
          return {
            ok: true,
            chatId: deliveredChatId,
            followupWindowOpened: openFollowupWindow,
            fallback: true,
          };
        } catch (fallbackErr) {
          const fallbackMessage =
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          if (isBridgeRestartNeeded(primaryErr) || isBridgeRestartNeeded(fallbackMessage)) {
            return { ok: false, error: "bridge_needs_restart", detail: `${primaryErr}; ${fallbackMessage}` };
          }
          return {
            ok: false,
            error: `chat_send_failed: ${primaryErr}; fallback_failed: ${fallbackMessage}`,
          };
        }
      }
      if (isBridgeRestartNeeded(primaryErr)) {
        return { ok: false, error: "bridge_needs_restart", detail: primaryErr };
      }
      return { ok: false, error: primaryErr };
    }
  }

  function looksLikePhoneQuery(q) {
    const s = String(q || "").trim();
    if (!s) return false;
    // Basic heuristic: mostly digits with optional +, spaces, dashes, parentheses
    return /^[+()\-.\s\d]{7,}$/.test(s) && /\d{7,}/.test(s);
  }

  function normalizeDigits(q) {
    return String(q || "").replace(/[^\d]/g, "");
  }

  function buildResolvedRecipient({ chatId, name, isGroup }) {
    const normalizedChatId = String(chatId || "").trim();
    const normalizedName = String(name || "").trim() || normalizedChatId;
    const group = isGroup === true;
    const idBase = normalizedChatId ? normalizedChatId.split("@")[0] || "" : "";
    const phoneDigits = !group && idBase && !idBase.includes("-") ? normalizeDigits(idBase) : "";
    const phoneE164 =
      phoneDigits && phoneDigits.length >= 7 && phoneDigits.length <= 15
        ? `+${phoneDigits}`
        : null;
    return {
      chatId: normalizedChatId,
      name: normalizedName,
      isGroup: group,
      phoneDigits: phoneDigits || null,
      phoneE164,
      twilioUsable: !group && !!phoneE164,
    };
  }

  async function resolveRecipient({ query, limit }) {
    const rawQ = String(query || "").trim();
    const max = Math.max(1, Math.min(20, Number(limit) || 10));
    if (!rawQ) return { ok: false, error: "missing_query" };

    const readyCheck = await waitForOperationalReadyForSend(30000, "resolve_recipient");
    if (!readyCheck.ok) return readyCheck;

    const qNorm = normalizeText(rawQ).toLowerCase();
    const qTokens = qNorm.split(" ").filter(Boolean);
    const digits = normalizeDigits(rawQ);

    log("resolve_recipient", {
      query: rawQ.slice(0, 120),
      qNorm: qNorm.slice(0, 120),
      hasDigits: digits.length >= 7,
      limit: max,
      readyResolved,
    });

    // Phone path: resolve to a WhatsApp ID even if chat thread isn't loaded yet.
    if (looksLikePhoneQuery(rawQ) || (digits && digits.length >= 7)) {
      try {
        const wid = await client.getNumberId(digits);
        const serialized =
          wid && typeof wid === "object"
            ? String(wid._serialized || wid.id?._serialized || "")
            : "";
        if (serialized) {
          const exact = buildResolvedRecipient({
            chatId: serialized,
            name: digits,
            isGroup: false,
          });
          log("resolve_recipient/phone_exact", { chatId: serialized, digitsLen: digits.length });
          return { ok: true, candidates: [exact], exact };
        }
      } catch (e) {
        warn("resolve_recipient/getNumberId failed:", e instanceof Error ? e.message : String(e));
      }
    }

    // Prefer searching chats, but retry once if WA store isn't synced yet.
    let chats = await client.getChats().catch(() => []);
    if (!Array.isArray(chats) || chats.length === 0) {
      await sleep(750);
      chats = await client.getChats().catch(() => []);
    }
    const scored = [];
    for (const c of chats || []) {
      const name = getChatDisplayName(c);
      const nameNorm = name.toLowerCase();
      const serialized = c?.id?._serialized ? String(c.id._serialized) : "";
      const idBase = serialized ? serialized.split("@")[0] : "";
      const idDigits = idBase ? normalizeDigits(idBase) : "";

      const tokenMatch = qTokens.length > 1 && qTokens.every((t) => nameNorm.includes(t));
      const substringMatch = qNorm && nameNorm.includes(qNorm);
      const digitsMatch = digits && digits.length >= 7 && idDigits.includes(digits);

      if (!substringMatch && !tokenMatch && !digitsMatch) continue;
      let score = 1;
      if (nameNorm === qNorm) score = 100;
      else if (nameNorm.startsWith(qNorm)) score = 80;
      else if (substringMatch) score = 60;
      else if (tokenMatch) score = 50;
      else if (digitsMatch) score = 40;
      scored.push({
        score,
        ...buildResolvedRecipient({
          chatId: serialized,
          name: name || serialized,
          isGroup: c?.isGroup === true,
        }),
      });
    }
    scored.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));

    const candidates = scored
      .map((x) =>
        buildResolvedRecipient({
          chatId: String(x.chatId || ""),
          name: String(x.name || ""),
          isGroup: !!x.isGroup,
        })
      )
      .filter((x) => x.chatId)
      .slice(0, max);

    const exact =
      candidates.length === 1
        ? candidates[0]
        : candidates.find((c) => normalizeText(c.name).toLowerCase() === qNorm) || null;

    // If no chat match, try contacts list (many DMs don't have Chat.name populated).
    if (candidates.length === 0) {
      const contacts = await client.getContacts().catch(() => []);
      const contactScored = [];
      for (const ct of contacts || []) {
        const id = ct?.id?._serialized ? String(ct.id._serialized) : "";
        if (!id) continue;
        const ctName = normalizeText(
          (typeof ct.name === "string" && ct.name) ||
            (typeof ct.pushname === "string" && ct.pushname) ||
            (typeof ct.shortName === "string" && ct.shortName) ||
            (typeof ct.verifiedName === "string" && ct.verifiedName) ||
            (typeof ct.formattedName === "string" && ct.formattedName) ||
            ""
        );
        const n = (ctName || id).toLowerCase();
        const tokenMatch = qTokens.length > 1 && qTokens.every((t) => n.includes(t));
        const substringMatch = qNorm && n.includes(qNorm);
        const idDigits = normalizeDigits(id.split("@")[0] || "");
        const digitsMatch = digits && digits.length >= 7 && idDigits.includes(digits);
        if (!substringMatch && !tokenMatch && !digitsMatch) continue;
        let score = 1;
        if (n === qNorm) score = 100;
        else if (n.startsWith(qNorm)) score = 80;
        else if (substringMatch) score = 60;
        else if (tokenMatch) score = 50;
        else if (digitsMatch) score = 40;
        contactScored.push({
          score,
          ...buildResolvedRecipient({
            chatId: id,
            name: ctName || id,
            isGroup: false,
          }),
        });
      }
      contactScored.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
      const merged = contactScored.slice(0, max).map((x) =>
        buildResolvedRecipient({
          chatId: String(x.chatId || ""),
          name: String(x.name || ""),
          isGroup: false,
        })
      );
      const exact2 =
        merged.length === 1 ? merged[0] : merged.find((c) => normalizeText(c.name).toLowerCase() === qNorm) || null;
      log("resolve_recipient/result", {
        query: rawQ.slice(0, 120),
        chatsCount: Array.isArray(chats) ? chats.length : 0,
        contactsCount: Array.isArray(contacts) ? contacts.length : 0,
        candidates: merged.length,
        exact: exact2?.chatId ? exact2.chatId.slice(0, 16) + "…" : null,
      });
      return { ok: true, candidates: merged, exact: exact2 || undefined };
    }

    log("resolve_recipient/result", {
      query: rawQ.slice(0, 120),
      chatsCount: Array.isArray(chats) ? chats.length : 0,
      candidates: candidates.length,
      exact: exact?.chatId ? exact.chatId.slice(0, 16) + "…" : null,
    });
    return { ok: true, candidates, exact: exact || undefined };
  }

  async function sendTextToChatId({ chatId, text, openFollowupWindow, followupWindowSec, source }) {
    const cid = String(chatId || "").trim();
    const msg = truncateForWhatsApp(String(text || ""));
    if (!cid) return { ok: false, error: "missing_chat_id" };
    if (!msg) return { ok: false, error: "empty_message" };
    const shouldOpenFollowupWindow = openFollowupWindow === true;
    const followupWindowSeconds = Number.isFinite(Number(followupWindowSec)) ? Number(followupWindowSec) : 7200;
    const followupSource = typeof source === "string" && source.trim() ? source.trim() : "heartbeat";

    const maybeOpenFollowupWindow = () => {
      if (!shouldOpenFollowupWindow) return;
      setHeartbeatFollowupWindow(cid, {
        windowSec: followupWindowSeconds,
        source: followupSource,
        promptPreview: msg,
      });
      log("heartbeat follow-up window opened", {
        chatId: cid,
        windowSec: Math.max(30, Math.min(6 * 60 * 60, Math.floor(followupWindowSeconds))),
        source: followupSource,
      });
    };

    const readyCheck = await waitForOperationalReadyForSend(30000, "send_text_chat_id");
    if (!readyCheck.ok) return readyCheck;

    let chat = null;
    try {
      chat = await client.getChatById(cid);
    } catch {
      chat = null;
    }
    if (!chat) {
      try {
        const chats = await client.getChats().catch(() => []);
        chat = chats.find((c) => c?.id?._serialized === cid) || null;
      } catch {
        chat = null;
      }
    }
    if (!chat) {
      // Last resort: whatsapp-web.js can send without an eager Chat model.
      try {
        rememberBotSend(msg);
        await client.sendMessage(cid, msg);
        maybeOpenFollowupWindow();
        return {
          ok: true,
          chatId: cid,
          isGroup: cid.endsWith("@g.us"),
          followupWindowOpened: shouldOpenFollowupWindow,
        };
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (isBridgeRestartNeeded(errMsg)) {
          return { ok: false, error: "bridge_needs_restart", detail: errMsg };
        }
        return { ok: false, error: errMsg };
      }
    }

    try {
      rememberBotSend(msg);
      await chat.sendMessage(msg);
      maybeOpenFollowupWindow();
      return {
        ok: true,
        chatId: cid,
        name: getChatDisplayName(chat) || undefined,
        isGroup: chat?.isGroup === true,
        followupWindowOpened: shouldOpenFollowupWindow,
      };
    } catch (e) {
      const primaryErr = e instanceof Error ? e.message : String(e);
      // Fallback: direct send
      try {
        rememberBotSend(msg);
        await client.sendMessage(cid, msg);
        maybeOpenFollowupWindow();
        return {
          ok: true,
          chatId: cid,
          name: getChatDisplayName(chat) || undefined,
          isGroup: chat?.isGroup === true,
          followupWindowOpened: shouldOpenFollowupWindow,
        };
      } catch (fallbackErr) {
        const fallbackMsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        if (isBridgeRestartNeeded(primaryErr) || isBridgeRestartNeeded(fallbackMsg)) {
          return {
            ok: false,
            error: "bridge_needs_restart",
            detail: `${primaryErr}; fallback_failed: ${fallbackMsg}`,
          };
        }
      }
      if (isBridgeRestartNeeded(primaryErr)) {
        return { ok: false, error: "bridge_needs_restart", detail: primaryErr };
      }
      return { ok: false, error: primaryErr };
    }
  }

  function inferMediaTypeFromFilename(name) {
    const lower = String(name || "").toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".pdf")) return "application/pdf";
    if (lower.endsWith(".csv")) return "text/csv";
    if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return "application/octet-stream";
  }

  function filenameFromUrl(u) {
    try {
      const url = new URL(String(u || ""));
      const base = url.pathname.split("/").pop() || "";
      return base ? decodeURIComponent(base) : "";
    } catch {
      return "";
    }
  }

  function resolveLocalMediaPath(rawPath) {
    const input = String(rawPath || "").trim();
    if (!input) return "";
    if (/^[a-z]+:\/\//i.test(input)) return "";
    if (input.startsWith("~/") || input.startsWith("~\\")) {
      const suffix = input.slice(1).replace(/^[/\\]+/, "");
      return path.normalize(path.join(os.homedir(), suffix));
    }
    if (path.isAbsolute(input)) return path.normalize(input);
    if (/^[a-zA-Z]:[\\/]/.test(input)) return path.normalize(input);
    return "";
  }

  function normalizePathForComparison(p) {
    const resolved = path.resolve(String(p || ""));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  function isPathWithin(root, target) {
    const rootNorm = normalizePathForComparison(root);
    const targetNorm = normalizePathForComparison(target);
    const rel = path.relative(rootNorm, targetNorm);
    if (!rel) return true;
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  async function resolveAllowedMediaRoots() {
    const out = [];

    // Keep uploads rooted at the configured home path (do not follow symlinks here).
    const uploadsRoot = path.resolve(path.join(os.homedir(), ".groovy", "uploads"));
    out.push(uploadsRoot);

    const tmpRoots = [os.tmpdir()];
    if (process.platform !== "win32") tmpRoots.push("/tmp");
    for (const tmpRoot of tmpRoots) {
      const candidate = String(tmpRoot || "").trim();
      if (!candidate) continue;
      out.push(path.resolve(candidate));
      try {
        out.push(await fs.promises.realpath(candidate));
      } catch {
        // Ignore canonicalization failures; resolved path is already included.
      }
    }

    return Array.from(new Set(out.map((r) => normalizePathForComparison(r))));
  }

  async function waitForLocalMediaFile(localFilePath, timeoutMs = 4000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      try {
        const stats = await fs.promises.stat(localFilePath);
        if (stats && stats.isFile()) return stats;
      } catch {
        // Keep polling until the grace window expires.
      }
      if (Date.now() >= deadline) return null;
      await sleep(250);
    }
  }

  async function sendMediaToChatId({ chatId, url, localPath, filename, caption }) {
    const cid = String(chatId || "").trim();
    const mediaUrl = String(url || "").trim();
    const localPathRaw = String(localPath || "").trim();
    const localFilePath = resolveLocalMediaPath(localPathRaw);
    const cap = typeof caption === "string" ? caption : "";
    const safeCaption = cap.length > 1024 ? cap.slice(0, 1024) : cap;
    if (!cid) return { ok: false, error: "missing_chat_id" };
    if (!mediaUrl && localPathRaw && !localFilePath) {
      return { ok: false, error: "invalid_local_path" };
    }
    if (!mediaUrl && !localFilePath) return { ok: false, error: "missing_url_or_local_path" };

    const readyCheck = await waitForOperationalReadyForSend(30000, "send_media_chat_id");
    if (!readyCheck.ok) return readyCheck;

    let chat = null;
    try {
      chat = await client.getChatById(cid);
    } catch {
      chat = null;
    }
    if (!chat) {
      // We'll still try `client.sendMessage` below; it can work without the Chat model.
      warn("sendMediaToChatId: chat_not_found; attempting direct send", { chatId: cid });
    }

    let buf = null;
    let detectedContentType = "";
    let fallbackName = "file";
    if (localFilePath) {
      // Fresh connector-generated files can be created immediately before send.
      const stats = await waitForLocalMediaFile(localFilePath);
      if (!stats || !stats.isFile()) return { ok: false, error: "local_file_not_found" };
      if (stats.size > 15 * 1024 * 1024) return { ok: false, error: "file_too_large" };
      let canonicalLocalPath = "";
      try {
        canonicalLocalPath = await fs.promises.realpath(localFilePath);
      } catch {
        canonicalLocalPath = path.resolve(localFilePath);
      }
      const allowedRoots = await resolveAllowedMediaRoots();
      const inAllowedScope = allowedRoots.some((root) =>
        isPathWithin(root, canonicalLocalPath)
      );
      if (!inAllowedScope) {
        return { ok: false, error: "local_path_out_of_scope" };
      }
      try {
        buf = await fs.promises.readFile(canonicalLocalPath);
      } catch {
        return { ok: false, error: "local_file_read_failed" };
      }
      fallbackName = path.basename(canonicalLocalPath) || "file";
      detectedContentType = inferMediaTypeFromFilename(fallbackName);
    } else {
      const fetched = await fetchPublicUrlBuffer({ startUrl: mediaUrl });
      if (!fetched.ok) return { ok: false, error: fetched.error || "download_failed" };
      detectedContentType = fetched.contentType || "";
      buf = fetched.buffer;
      fallbackName = filenameFromUrl(mediaUrl) || "file";
    }

    const fname = String(filename || "").trim() || fallbackName;
    const mediaType = detectedContentType || inferMediaTypeFromFilename(fname);

    try {
      // IMPORTANT: base64 is generated ONLY inside the connector; never returned to the server/model.
      const base64 = buf.toString("base64");
      const media = new MessageMedia(mediaType, base64, fname);
      rememberBotSend(`[media:${fname}]`);
      try {
        await client.sendMessage(cid, media, safeCaption ? { caption: safeCaption } : undefined);
      } catch (e) {
        if (chat) {
          await chat.sendMessage(media, safeCaption ? { caption: safeCaption } : undefined);
        } else {
          throw e;
        }
      }
      return {
        ok: true,
        chatId: cid,
        name: chat ? getChatDisplayName(chat) || undefined : undefined,
        filename: fname,
        mediaType,
        sizeBytes: buf.length,
        source: localFilePath ? "local_path" : "url",
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  client.on("qr", () => {
    qrPending = true;
    authFailureText = "";
    disconnectedReason = "";
    log("QR code received. Please scan with WhatsApp mobile app.");
    // You could generate QR code in terminal here using qrcode-terminal
    emitHealth("recovering", "qr_received", "QR scan required for WhatsApp Web");
  });

  client.on("authenticated", () => {
    qrPending = false;
    authFailureText = "";
    disconnectedReason = "";
    log("authenticated successfully");
    emitHealth("recovering", "authenticated", "WhatsApp session authenticated");
    ensureOperationalReady("authenticated", { requireTargetBinding: true }).catch(() => {});
  });

  client.on("auth_failure", (msg) => {
    qrPending = false;
    authFailureText = typeof msg === "string" ? msg : JSON.stringify(msg || {});
    disconnectedReason = "";
    warn("authentication failed:", msg);
    emitHealth(
      "degraded",
      "auth_failure",
      typeof msg === "string" ? msg : JSON.stringify(msg || {})
    );
  });

  client.on("ready", async () => {
    await markClientReady("ready");
  });

  // Listen for all messages (including from self)
  client.on("message_create", async (message) => {
    let shouldNotifyFailure = false;
    let fallbackChatId = "";
    let safeSendReply = null;
    try {
      // Process messages from the target group.
      // If we failed to resolve it at startup (common after fresh QR scan), we can auto-bind
      // when we first see a command in the configured group.
      const chat = await message.getChat();
      if (!chat) return;

      const text = normalizeText(message.body);
      const fromMe = message.fromMe;
      const chatId = chat?.id?._serialized || "";
      if (!chatId) return;
      fallbackChatId = chatId;

      log("message received:", { fromMe, text: text.slice(0, 80), chatId });

      // Ignore our own bot messages (prevents feedback loops), but do NOT ignore all fromMe messages:
      // WhatsApp sets fromMe=true for messages you send from your phone too.
      if (fromMe && wasRecentlyBotSent(text)) return;

      // Check for commands
      let groovyPayload = extractCommand(text, "@groovy");
      const codePayload = extractCommand(text, "@code");
      const pendingHeartbeatFollowup =
        !groovyPayload && !codePayload && fromMe ? peekHeartbeatFollowupWindow(chatId) : null;

      if (!groovyPayload && !codePayload && !pendingHeartbeatFollowup) {
        return;
      }

      // Ensure we are bound to the right group before acting on commands.
      if (targetChatId) {
        if (!chatId || chatId !== targetChatId) return;
      } else {
        // Not bound yet: bind when command comes from the configured group.
        // Only bind to groups to avoid accidentally latching onto a DM.
        const isGroup = chat?.isGroup === true;
        if (!isGroup) return;
        if (!chatMatchesConfiguredGroup(chat)) return;
        await bindTargetChat(chat, "first_command");
      }

      if (!groovyPayload && !codePayload && pendingHeartbeatFollowup) {
        const consumed = consumeHeartbeatFollowupWindow(chatId);
        if (consumed) {
          groovyPayload = normalizeImplicitFollowupPayload(text);
          log("heartbeat follow-up auto-routed", {
            chatId,
            source: consumed.source || "heartbeat",
          });
        }
      }

      if (!groovyPayload && !codePayload) return;
      shouldNotifyFailure = true;

      log("command detected:", {
        groovyPayload,
        codePayload,
        implicitHeartbeatFollowup: !!pendingHeartbeatFollowup && !codePayload,
      });

      // Helper to send reply safely (library-based; never crash the process)
      async function sendReply(replyText, files) {
        try {
          if (typeof replyText === "string" && replyText.trim()) {
            rememberBotSend(replyText);
          }
          const chatId = chat?.id?._serialized;
          if (!chatId) throw new Error("missing_chat_id");

          // WORKAROUND: whatsapp-web.js can throw `markedUnread` when its internal Store
          // doesn't have the Chat model loaded yet. Force-resolve the Chat from the client.
          let resolvedChat = null;
          try {
            resolvedChat = await client.getChatById(chatId);
          } catch {
            resolvedChat = null;
          }

          if (!resolvedChat) {
            const chats = await client.getChats().catch(() => []);
            resolvedChat =
              chats.find((c) => c?.id?._serialized === chatId) ||
              chats.find((c) => c?.name === chat?.name) ||
              null;
          }

          if (!resolvedChat) {
            // Small delay + one retry (covers immediate post-ready races)
            await sleep(750);
            try {
              resolvedChat = await client.getChatById(chatId);
            } catch {
              resolvedChat = null;
            }
          }

          if (!resolvedChat) throw new Error(`chat_not_resolved:${chatId}`);

          // Use chat-level send (avoid message.reply path).
          if (Array.isArray(files) && files.length > 0 && MessageMedia) {
            // Send media (one per message). WhatsApp is picky about large payloads; keep it small.
            for (let i = 0; i < Math.min(files.length, 3); i++) {
              const f = files[i] || {};
              const mediaType = String(f.mediaType || "");
              const base64 = String(f.base64 || "");
              const filename = f.filename != null ? String(f.filename) : undefined;
              if (!mediaType || !base64) continue;
              const media = new MessageMedia(mediaType, base64, filename);
              const caption = i === 0 ? (replyText || "").trim() : "";
              const isImage = mediaType.startsWith("image/");
              await resolvedChat.sendMessage(
                media,
                caption
                  ? { caption, sendMediaAsDocument: !isImage }
                  : { sendMediaAsDocument: !isImage }
              );
            }
            return;
          }

          await resolvedChat.sendMessage(replyText);
        } catch (e) {
          warn("failed to send reply:", e instanceof Error ? e.message : String(e));
        }
      }
      safeSendReply = sendReply;

      // Show "typing…" while the orchestrator is working so WhatsApp doesn't feel dead.
      let typingInterval = null;
      let typingActive = false;
      let ping1 = null;
      let ping2 = null;
      let ping3 = null;

      const clearProgressPings = () => {
        try {
          if (ping1) clearTimeout(ping1);
          if (ping2) clearTimeout(ping2);
          if (ping3) clearTimeout(ping3);
        } catch {
          // ignore
        } finally {
          ping1 = null;
          ping2 = null;
          ping3 = null;
        }
      };

      const startTyping = async () => {
        try {
          if (typingInterval) {
            clearInterval(typingInterval);
            typingInterval = null;
          }
          // sendStateTyping exists in whatsapp-web.js Chat
          await chat.sendStateTyping();
          typingActive = true;
          typingInterval = setInterval(() => {
            chat.sendStateTyping().catch(() => {});
          }, 4000);
        } catch {
          // ignore
        }
      };
      const stopTyping = async () => {
        if (!typingActive && !typingInterval) return;
        try {
          if (typingInterval) clearInterval(typingInterval);
          typingInterval = null;
          await chat.clearState();
        } catch {
          // ignore
        } finally {
          typingActive = false;
        }
      };

      try {
        // Handle @code
        if (codePayload != null) {
          await startTyping();
          const ingressTraceId = buildWhatsAppIngressTraceId(message);
          await handleCodeMessage({
            chatId: chat.id._serialized,
            chatName: chat.name,
            opts,
            text: codePayload,
            sendReply,
            whatsappRuntime: { resolveRecipient, sendTextToChatId, sendMediaToChatId },
            initialTraceId: ingressTraceId,
          });
          return;
        }

        // Handle @groovy
        const userText = groovyPayload || "";
        if (!userText) return;

        const threadKey = chat.id._serialized;
        const threadName = chat.name;
        const ingressTraceId = buildWhatsAppIngressTraceId(message);

        // Download any attached media (images, documents, etc.)
        let attachedFiles = [];
        if (message.hasMedia) {
          try {
            const media = await message.downloadMedia();
            if (media && media.mimetype && media.data) {
              attachedFiles.push({
                mediaType: media.mimetype,
                base64: media.data,
                filename: media.filename || null,
              });
              log("downloaded media attachment:", {
                mimetype: media.mimetype,
                filename: media.filename,
                size: media.data?.length || 0,
              });
            }
          } catch (e) {
            warn("failed to download media:", e instanceof Error ? e.message : String(e));
          }
        }

        // Handle "new" command
        if (userText.trim().toLowerCase() === "new") {
          await startTyping();
          const res = await callWhatsAppApi({
            baseUrl: appUrl,
            deviceToken,
            body: {
              provider: "whatsapp_web",
              threadKey,
              threadName,
              command: "new",
              traceId: ingressTraceId || undefined,
            },
          });
          const reply = res.ok ? "✅ new Groovy session started" : `Error: ${res.error}`;
          await sendReply(reply);
          return;
        }

        // Regular orchestrator message - handle tool execution loop
        let traceId = ingressTraceId || null;
        let toolResults = [];
        let deferredFollowupText = "";
        let deferredReplyPrefix = "";
        let deferredPendingMessageId = "";
        let deferredPendingToolResults = [];
        let pendingTwilioFollowup = null;
        const upsertToolResult = (nextResult) => {
          if (!nextResult || typeof nextResult !== "object") return;
          const toolCallId =
            typeof nextResult.toolCallId === "string" ? nextResult.toolCallId : "";
          if (!toolCallId) return;
          const idx = toolResults.findIndex((entry) => entry?.toolCallId === toolCallId);
          if (idx >= 0) {
            toolResults[idx] = nextResult;
          } else {
            toolResults.push(nextResult);
          }
        };
        let reply = "";

        await startTyping();

        // For file-heavy workflows, proactively acknowledge the attachment (reduces "dead air")
        if (attachedFiles.length > 0) {
          try {
            await sendReply("Got the file — processing it now…");
          } catch {
            // ignore
          }
        }

        // Timed pings to avoid dead air across the ENTIRE multi-round flow (emoji-free)
        // Desired cadence:
        // - first ping when we "have it" (we treat this as 10s)
        // - second ping at ~1.5 minutes
        // - third ping at ~3 minutes
        try {
          ping1 = setTimeout(() => {
            log("whatsapp/ping", { kind: "groovy", at: "10s" });
            sendReply("Still working…").catch(() => {});
          }, 10_000);
          ping2 = setTimeout(() => {
            log("whatsapp/ping", { kind: "groovy", at: "90s" });
            sendReply("Still working (almost there)…").catch(() => {});
          }, 90_000);
          ping3 = setTimeout(() => {
            log("whatsapp/ping", { kind: "groovy", at: "180s" });
            sendReply("Still working (taking longer than usual)…").catch(() => {});
          }, 180_000);
        } catch {
          // ignore
        }

        const sendProgress = createProgressSender(sendReply, {
          minIntervalMs: 2500,
          maxChars: 240,
        });
        for (let round = 0; round < 12; round++) {
          const messageForRound = deferredFollowupText || (round === 0 ? userText : "");
          const body = {
            provider: "whatsapp_web",
            connectorPlatform:
              process.platform === "win32"
                ? "windows"
                : process.platform === "darwin"
                  ? "macos"
                  : "unknown",
            threadKey,
            threadName,
            message: messageForRound,
            // Only send files on first round (with the user message)
            files: round === 0 && attachedFiles.length > 0 ? attachedFiles : undefined,
            toolResults: toolResults.length ? toolResults : undefined,
            traceId: traceId || undefined,
          };
          deferredFollowupText = "";

          let res;
          res = await callWhatsAppApi({ baseUrl: appUrl, deviceToken, body });
          if (!res.ok) {
            reply = `Error: ${res.error}`;
            break;
          }

          const data = res.data || {};
          traceId = data.traceId || traceId;

          if (data.kind === "final") {
            const files = Array.isArray(data.files) ? data.files : [];
            const textReply = String(data.reply || "").trim();
            pendingTwilioFollowup =
              data.twilioFollowup && typeof data.twilioFollowup === "object"
                ? {
                    ...data.twilioFollowup,
                    sessionId:
                      typeof data.sessionId === "string" && data.sessionId.trim()
                        ? data.sessionId.trim()
                        : typeof data.twilioFollowup.sessionId === "string"
                          ? data.twilioFollowup.sessionId.trim()
                          : "",
                  }
                : null;
            const mergedReply = [deferredReplyPrefix, textReply].filter(Boolean).join("\n\n").trim();
            const finalReplyText = mergedReply || textReply;
            if (deferredPendingMessageId && deferredPendingToolResults.length > 0) {
              const persist = await callWhatsAppApi({
                baseUrl: appUrl,
                deviceToken,
                allowRetries: true,
                body: {
                  provider: "whatsapp_web",
                  threadKey,
                  threadName,
                  message: "",
                  toolResults: deferredPendingToolResults,
                  traceId: traceId || undefined,
                  commandFollowup: {
                    pendingMessageId: deferredPendingMessageId,
                    finalReply: finalReplyText || "(done)",
                  },
                },
              });
              if (!persist.ok) {
                warn("failed to persist deferred command followup metadata", persist.error || "unknown");
              }
              deferredPendingMessageId = "";
              deferredPendingToolResults = [];
            }
            if (files.length > 0) {
              // Send image(s) directly to WhatsApp.
              await sendReply(finalReplyText || "Here you go:", files);
              reply = "";
              break;
            }

            reply =
              finalReplyText ||
              "I ran into an internal processing error. Please resend your message (or prefix with @groovy).";
            break;
          }

          if (data.kind === "in_progress") {
            if (data.statusMessage) await sendProgress(String(data.statusMessage));
            const pollAfterMs = Number(data.pollAfterMs);
            await sleep(
              Number.isFinite(pollAfterMs) ? Math.max(1000, Math.min(5000, Math.trunc(pollAfterMs))) : 2000
            );
            continue;
          }

          if (data.kind === "needs_connector") {
            const execs = Array.isArray(data.connectorExecutes) ? data.connectorExecutes : [];
            const pendingMessageId =
              typeof data.pendingMessageId === "string" ? data.pendingMessageId.trim() : "";
            if (execs.length === 0) {
              warn(`round ${round}: needs_connector but no connectorExecutes!`);
              reply = data.partialText || "(no response - tool execution issue)";
              break;
            }

            if (data.statusMessage) await sendProgress(data.statusMessage);
            const roundToolResults = [];
            let skipWhatsappTextForBatch = false;
            for (const ex of execs) {
              if (skipWhatsappTextForBatch && ex.toolName === "whatsapp_send_text") {
                const p =
                  ex.connectorParams && typeof ex.connectorParams === "object"
                    ? ex.connectorParams
                    : {};
                const pending_message_id = String(p.pending_message_id || "").trim();
                const recipient_display = String(p.recipient_display || "").trim();
                const skippedResult = {
                  ok: false,
                  skipped: true,
                  error: "skipped_due_media_failure",
                  ...(pending_message_id ? { pending_message_id } : {}),
                  ...(recipient_display ? { recipient_display } : {}),
                };
                const toolResultEntry = {
                  toolCallId: ex.toolCallId,
                  toolName: ex.toolName,
                  result: JSON.stringify({
                    ok: false,
                    result: skippedResult,
                    error: skippedResult.error,
                  }),
                };
                roundToolResults.push(toolResultEntry);
                upsertToolResult(toolResultEntry);
                continue;
              }
              await sendProgress(connectorExecuteStatusText(ex));
              const rawResult = await executeConnectorRpc({
                connectorType: ex.connectorType,
                connectorParams: ex.connectorParams,
                codeRuntime: opts.codeRuntime || null,
                whatsappRuntime: { resolveRecipient, sendTextToChatId, sendMediaToChatId },
                deviceToken,
                onProgress: (msg) => {
                  sendProgress(msg).catch(() => {});
                },
              });
              const r = await maybeHandleSitePublishDeploy({
                baseUrl: appUrl,
                deviceToken,
                connectorExecute: ex,
                connectorResult: rawResult,
                onProgress: (msg) => sendProgress(msg),
              });
              const toolResultEntry = {
                toolCallId: ex.toolCallId,
                toolName: ex.toolName,
                result: JSON.stringify({ ok: !!r.ok, result: r, error: r.ok ? undefined : r.error }),
              };
              roundToolResults.push(toolResultEntry);
              upsertToolResult(toolResultEntry);
              if (ex.toolName === "whatsapp_send_media" && !r.ok) {
                skipWhatsappTextForBatch = true;
              }
            }
            if (data.completeAfterConnector === true) {
              const baseReply = String(data.finalReply || data.partialText || "").trim();
              const followupText =
                typeof data.followupText === "string" ? data.followupText.trim() : "";
              const connectorLines = roundToolResults.map((tr, idx) => {
                let parsed = null;
                try {
                  parsed = JSON.parse(String(tr.result || ""));
                } catch {
                  parsed = null;
                }
                const wrapped = parsed && typeof parsed === "object" ? parsed : {};
                const inner =
                  wrapped &&
                  typeof wrapped === "object" &&
                  wrapped.result &&
                  typeof wrapped.result === "object"
                    ? wrapped.result
                    : {};
                const subject =
                  inner && typeof inner.subject === "string" && inner.subject.trim()
                    ? inner.subject.trim()
                    : `#${idx + 1}`;
                const ok =
                  wrapped &&
                  typeof wrapped === "object" &&
                  wrapped.ok === true &&
                  (!inner || typeof inner !== "object" || inner.ok !== false);
                if (ok) {
                  const detail =
                    inner && typeof inner.detail === "string" && inner.detail.trim()
                      ? inner.detail.trim()
                      : "completed";
                  return `- ${subject}: ${detail}`;
                }
                const err =
                  (inner && typeof inner.error === "string" && inner.error.trim()) ||
                  (wrapped && typeof wrapped === "object" && typeof wrapped.error === "string" && wrapped.error.trim()) ||
                  "failed";
                return `- ${subject}: failed (${err})`;
              });
              const connectorSummary = connectorLines.length
                ? `Local unsubscribe results:\n${connectorLines.join("\n")}`
                : "";
              const commandReply =
                [baseReply, connectorSummary].filter(Boolean).join("\n\n").trim() || "(done)";
              if (followupText) {
                deferredReplyPrefix = commandReply;
                deferredFollowupText = followupText;
                deferredPendingMessageId = pendingMessageId || "";
                deferredPendingToolResults = roundToolResults.slice();
                toolResults = [];
                continue;
              }
              reply = commandReply;
              if (pendingMessageId) {
                const persist = await callWhatsAppApi({
                  baseUrl: appUrl,
                  deviceToken,
                  allowRetries: true,
                  body: {
                    provider: "whatsapp_web",
                    threadKey,
                    threadName,
                    message: "",
                    toolResults: roundToolResults.length ? roundToolResults : undefined,
                    traceId: traceId || undefined,
                    commandFollowup: {
                      pendingMessageId,
                      finalReply: reply,
                    },
                  },
                });
                if (!persist.ok) {
                  warn("failed to persist command followup metadata", persist.error || "unknown");
                }
              }
              deferredReplyPrefix = "";
              deferredPendingMessageId = "";
              deferredPendingToolResults = [];
              break;
            }
            continue;
          }

          if (data.kind === "ui_open_code") {
            reply = "Use @code in WhatsApp to enter Claude Code mode.";
            break;
          }

          if (data.kind === "browser_task") {
            // Should not happen: browser_task should be executed via connector in WhatsApp.
            const task = data.browserTask?.task || "browse the web";
            reply =
              `Browser task "${task}" returned an unexpected UI-only marker. ` +
              `This connector build expects browser_task to run locally. Try again or update the server/connector.`;
            break;
          }

          reply = `Unhandled response: ${data.kind || "unknown"}`;
          break;
        }

        if (!reply && deferredReplyPrefix) {
          reply =
            "I completed the inbox action command, but the follow-up answer did not finish. Please resend the follow-up question.";
        }
        if (deferredReplyPrefix && reply) {
          reply = [deferredReplyPrefix, reply].filter(Boolean).join("\n\n").trim();
        }
        if (reply && deferredPendingMessageId && deferredPendingToolResults.length > 0) {
          const persist = await callWhatsAppApi({
            baseUrl: appUrl,
            deviceToken,
            allowRetries: true,
            body: {
              provider: "whatsapp_web",
              threadKey,
              threadName,
              message: "",
              toolResults: deferredPendingToolResults,
              traceId: traceId || undefined,
              commandFollowup: {
                pendingMessageId: deferredPendingMessageId,
                finalReply: reply,
              },
            },
          });
          if (!persist.ok) {
            warn(
              "failed to persist deferred command followup metadata after non-final flow",
              persist.error || "unknown"
            );
          }
        }
        if (reply) {
          await sendReply(reply);
        }
        if (pendingTwilioFollowup && typeof pendingTwilioFollowup === "object") {
          const watcherToken =
            typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `twilio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          twilioFollowupWatchersByThread.set(threadKey, watcherToken);
          void watchTwilioFollowupThread({
            baseUrl: appUrl,
            deviceToken,
            threadKey,
            threadName,
            initialFollowup: pendingTwilioFollowup,
            sendReply,
            watcherToken,
          }).catch((err) => {
            if (twilioFollowupWatchersByThread.get(threadKey) === watcherToken) {
              twilioFollowupWatchersByThread.delete(threadKey);
            }
            warn("twilio followup watcher error:", formatErrorWithCause(err));
          });
        }
      } finally {
        await stopTyping();
        clearProgressPings();
      }

    } catch (e) {
      warn("message handler error:", formatErrorWithCause(e));
      if (shouldNotifyFailure) {
        const fallbackText =
          "I hit a temporary network error while processing that. Please resend your last message.";
        try {
          if (typeof safeSendReply === "function") {
            await safeSendReply(fallbackText);
          } else if (fallbackChatId) {
            const fallbackChat = await client.getChatById(fallbackChatId).catch(() => null);
            if (fallbackChat) {
              rememberBotSend(fallbackText);
              await fallbackChat.sendMessage(fallbackText);
            }
          }
        } catch (sendErr) {
          warn("failed to send error fallback reply:", formatErrorWithCause(sendErr));
        }
      }
    }
  });

  client.on("disconnected", (reason) => {
    disconnectedReason = typeof reason === "string" ? reason : JSON.stringify(reason || {});
    warn("client disconnected:", reason);
    emitHealth(
      "degraded",
      "disconnected",
      typeof reason === "string" ? reason : JSON.stringify(reason || {})
    );
  });

  // whatsapp-web.js occasionally loads the full app UI without ever emitting `ready` or
  // `authenticated`. The library's initialize() can hang indefinitely in that state.
  // Run a concurrent DOM probe that marks the client ready as soon as the chat list appears,
  // regardless of whether initialize() or the library events have fired.
  const domReadyFallbackPromise = (async () => {
    const start = Date.now();
    let delayMs = 2000;
    while (!readyResolved && Date.now() - start < 90_000) {
      await sleep(delayMs);
      delayMs = Math.min(6000, Math.round(delayMs * 1.3));
      if (readyResolved) return;
      try {
        const page = client?.pupPage;
        if (!page || typeof page.evaluate !== "function") continue;
        const hasChatList = await page.evaluate(() => {
          const spans = Array.from(document.querySelectorAll("span[title]"));
          return spans.some(
            (el) =>
              (el.getAttribute("title") || "").trim().length > 0 &&
              (el.closest('[role="listitem"]') || el.closest('[role="gridcell"]'))
          );
        }).catch(() => false);
        if (hasChatList) {
          await markClientReady("ready_fallback_dom");
          return;
        }
      } catch {
        // ignore and keep polling until timeout
      }
    }
  })();
  domReadyFallbackPromise.catch(() => {});

  // Initialize the client
  try {
    await client.initialize();
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    emitHealth("degraded", "initialize_failed", errText);
    throw e;
  }

  return {
    ok: true,
    groupName,
    appUrl,
    // Used by the scheduler in connector.mjs
    sendText: sendTextToGroup,
    // Used by orchestrator tools (send to arbitrary chats)
    resolveRecipient,
    sendTextToChatId,
    sendMediaToChatId,
    // Useful for debugging/introspection
    getThreadKey: () => targetChatId,
    waitUntilReady: async () => {
      const result = await ensureOperationalReady("wait_until_ready", {
        requireTargetBinding: true,
        allowQrPending: true,
      });
      if (!result || result.ok !== true) {
        const err =
          result && typeof result === "object" && typeof result.error === "string"
            ? result.error
            : lastOperationalReadyError || "whatsapp_operational_ready_failed";
        throw new Error(err);
      }
    },
  };
}
