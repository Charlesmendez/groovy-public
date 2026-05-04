/**
 * Site Development: dev server management, file reading, and HTTP tunnel
 * for the AI site builder feature.
 */

import { spawn } from "child_process";
import { promises as fsp } from "fs";
import fs from "fs";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";
import http from "http";

// Active dev servers: slug -> { port, pid, process, tunnelNonce }
const activeSites = new Map();

const SITES_DIR = path.join(os.homedir(), ".groovy", "sites");

// Ports we try to allocate from
const PORT_START = 3847;
const PORT_END = 3899;
const MAX_NPM_INSTALL_MS = 120_000;
const DEV_READY_TIMEOUT_MS = 60_000;
const EXISTING_DEV_GRACE_MS = 90_000;
const SITE_DEV_IDLE_MS = (() => {
  const raw = Number(process.env.GROOVY_SITE_DEV_IDLE_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 20 * 60 * 1000;
})();

function emitSiteDevEvent(event, details = {}) {
  try {
    console.info(
      "[site-dev]",
      JSON.stringify({
        event,
        ...details,
      })
    );
  } catch {
    // ignore logging failures
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, "127.0.0.1");
  });
}

async function isHttpReachable(port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        method: "GET",
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearIdleTimer(entry) {
  if (!entry || !entry.idleTimer) return;
  try {
    clearTimeout(entry.idleTimer);
  } catch {
    // ignore
  }
  entry.idleTimer = null;
}

function scheduleIdleStop(entry) {
  if (!entry || entry.exited) return;
  clearIdleTimer(entry);
  if (!Number.isFinite(SITE_DEV_IDLE_MS) || SITE_DEV_IDLE_MS <= 0) return;

  const slug = entry.slug;
  entry.idleTimer = setTimeout(() => {
    const current = activeSites.get(slug);
    if (!current || current !== entry || current.exited) return;
    const now = Date.now();
    const lastActivityAt = Number(current.lastActivityAt || current.startedAt || now);
    const idleForMs = Math.max(0, now - lastActivityAt);
    current.stopReason = "idle_timeout";
    current.exited = true;
    activeSites.delete(slug);
    try {
      current.process?.kill?.("SIGTERM");
    } catch {
      // ignore
    }
    emitSiteDevEvent("auto_stop", {
      slug,
      pid: current.pid || null,
      stop_reason: "idle_timeout",
      idle_for_ms: idleForMs,
      idle_limit_ms: SITE_DEV_IDLE_MS,
    });
  }, SITE_DEV_IDLE_MS);

  if (typeof entry.idleTimer?.unref === "function") {
    entry.idleTimer.unref();
  }
}

function touchSiteActivity(entry, source) {
  if (!entry || entry.exited) return;
  const now = Date.now();
  entry.lastActivityAt = now;
  scheduleIdleStop(entry);
  if (!entry.lastActivityLoggedAt || now - entry.lastActivityLoggedAt >= 60_000) {
    entry.lastActivityLoggedAt = now;
    emitSiteDevEvent("last_activity", {
      slug: entry.slug,
      source: source || "unknown",
      pid: entry.pid || null,
      idle_limit_ms: SITE_DEV_IDLE_MS,
    });
  }
}

function stopSiteEntry(entry, stopReason) {
  if (!entry) return false;
  clearIdleTimer(entry);
  const reason = String(stopReason || "stop");
  const wasRunning = !entry.exited;
  entry.stopReason = reason;
  if (!entry.exited) {
    try {
      entry.process?.kill?.("SIGTERM");
    } catch {
      // ignore
    }
    entry.exited = true;
  }
  if (activeSites.get(entry.slug) === entry) {
    activeSites.delete(entry.slug);
  }
  emitSiteDevEvent("stop", {
    slug: entry.slug,
    pid: entry.pid || null,
    stop_reason: reason,
    was_running: wasRunning,
  });
  return true;
}

async function findFreePort() {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port found in range ${PORT_START}-${PORT_END}`);
}

function resolveLocalNextCliPath(dir) {
  const primary = path.join(dir, "node_modules", "next", "dist", "bin", "next");
  if (fs.existsSync(primary)) return primary;
  return null;
}

async function installSiteDependencies(dir) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve();
    };
    const proc = spawn("npm", ["install"], { cwd: dir, shell: true, stdio: "pipe" });
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`npm install failed (${code}): ${stderr.slice(0, 500)}`));
    });
    proc.on("error", (err) => finish(err));
    const timeout = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      finish(new Error("npm install timed out after 120s"));
    }, MAX_NPM_INSTALL_MS);
  });
}

function sanitizeSlug(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function expandHomePath(inputPath) {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function resolveSiteDir(slugInput, sitePathInput) {
  const slug = sanitizeSlug(slugInput);
  if (!slug) {
    throw new Error("slug is required");
  }

  const expectedDir = path.resolve(path.join(SITES_DIR, slug));
  if (sitePathInput && String(sitePathInput).trim()) {
    const requested = path.resolve(expandHomePath(String(sitePathInput).trim()));
    if (requested !== expectedDir) {
      throw new Error("sitePath must match ~/.groovy/sites/<slug>");
    }
  }

  return { slug, dir: expectedDir };
}

function isDirectory(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

async function maybePruneBootstrapAppShadow(dir) {
  const appDir = path.join(dir, "app");
  const srcAppDir = path.join(dir, "src", "app");
  if (!isDirectory(appDir) || !isDirectory(srcAppDir)) return false;

  const appPagePath = ["page.js", "page.jsx", "page.tsx", "page.ts"]
    .map((name) => path.join(appDir, name))
    .find((p) => fs.existsSync(p));
  const srcPagePath = ["page.js", "page.jsx", "page.tsx", "page.ts"]
    .map((name) => path.join(srcAppDir, name))
    .find((p) => fs.existsSync(p));

  if (!appPagePath || !srcPagePath) return false;

  let appPageContent = "";
  try {
    appPageContent = await fsp.readFile(appPagePath, "utf8");
  } catch {
    return false;
  }

  const looksLikeConnectorBootstrap =
    appPageContent.includes("Your site is running locally. Ask Groovy to customize it.") ||
    (appPageContent.includes("export default function HomePage") &&
      appPageContent.includes("Hello from"));

  if (!looksLikeConnectorBootstrap) return false;

  try {
    await fsp.rm(appDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function ensureMinimalNextApp(dir, safeSlug) {
  const appDir = path.join(dir, "app");
  const pagesDir = path.join(dir, "pages");
  const srcAppDir = path.join(dir, "src", "app");
  const srcPagesDir = path.join(dir, "src", "pages");
  if (isDirectory(appDir) || isDirectory(pagesDir) || isDirectory(srcAppDir) || isDirectory(srcPagesDir)) {
    return { bootstrapped: false };
  }

  await fsp.mkdir(appDir, { recursive: true });

  const title = safeSlug
    ? safeSlug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : "Groovy Site";

  const layoutPath = path.join(appDir, "layout.js");
  if (!fs.existsSync(layoutPath)) {
    await fsp.writeFile(
      layoutPath,
      `export const metadata = {
  title: "${title}",
  description: "Generated with Groovy",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "Inter, system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
`
    );
  }

  const pagePath = path.join(appDir, "page.js");
  if (!fs.existsSync(pagePath)) {
    await fsp.writeFile(
      pagePath,
      `export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "24px",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <h1 style={{ margin: 0, fontSize: "2rem" }}>Hello from ${title}</h1>
        <p style={{ marginTop: "0.75rem", opacity: 0.75 }}>
          Your site is running locally. Ask Groovy to customize it.
        </p>
      </div>
    </main>
  );
}
`
    );
  }

  return { bootstrapped: true };
}

// ── Start dev server ─────────────────────────────────────────────────────────

/**
 * Start a Next.js dev server for a site.
 * Returns { port, tunnelNonce, slug } on success.
 */
export async function siteDevStart({ slug, sitePath }) {
  const resolved = resolveSiteDir(slug, sitePath);
  const safeSlug = resolved.slug;
  const dir = resolved.dir;

  // Already running?
  const existing = activeSites.get(safeSlug);
  if (existing && !existing.exited) {
    const pidAlive = isPidAlive(existing.pid);
    const reachable = await isHttpReachable(existing.port);
    const startedAt =
      typeof existing.startedAt === "number" && Number.isFinite(existing.startedAt)
        ? existing.startedAt
        : 0;
    const ageMs = startedAt > 0 ? Date.now() - startedAt : Number.POSITIVE_INFINITY;

    // Healthy existing server: reuse it.
    if (pidAlive && reachable) {
      touchSiteActivity(existing, "site_dev_start_reuse");
      emitSiteDevEvent("start", {
        slug: safeSlug,
        pid: existing.pid || null,
        port: existing.port,
        already_running: true,
        reused: true,
        idle_limit_ms: SITE_DEV_IDLE_MS,
      });
      return {
        ok: true,
        port: existing.port,
        tunnelNonce: existing.tunnelNonce,
        slug: safeSlug,
        alreadyRunning: true,
      };
    }

    // Give very fresh startups a short grace window before forcing restart.
    if (pidAlive && ageMs < EXISTING_DEV_GRACE_MS) {
      touchSiteActivity(existing, "site_dev_start_grace_reuse");
      emitSiteDevEvent("start", {
        slug: safeSlug,
        pid: existing.pid || null,
        port: existing.port,
        already_running: true,
        reused: true,
        idle_limit_ms: SITE_DEV_IDLE_MS,
      });
      return {
        ok: true,
        port: existing.port,
        tunnelNonce: existing.tunnelNonce,
        slug: safeSlug,
        alreadyRunning: true,
      };
    }

    // Stale entry: kill and restart cleanly.
    stopSiteEntry(existing, "stale_restart");
  }

  // Double-check for races after stale cleanup.
  const existingAfterCleanup = activeSites.get(safeSlug);
  if (existingAfterCleanup && !existingAfterCleanup.exited) {
    touchSiteActivity(existingAfterCleanup, "site_dev_start_race_reuse");
    emitSiteDevEvent("start", {
      slug: safeSlug,
      pid: existingAfterCleanup.pid || null,
      port: existingAfterCleanup.port,
      already_running: true,
      reused: true,
      idle_limit_ms: SITE_DEV_IDLE_MS,
    });
    return {
      ok: true,
      port: existingAfterCleanup.port,
      tunnelNonce: existingAfterCleanup.tunnelNonce,
      slug: safeSlug,
      alreadyRunning: true,
    };
  }

  // Ensure dir exists
  if (!fs.existsSync(dir)) {
    await fsp.mkdir(dir, { recursive: true });
  }

  // If a connector bootstrap app/ exists alongside a real src/app, remove
  // the fallback so Next resolves the intended source tree.
  const prunedBootstrapShadow = await maybePruneBootstrapAppShadow(dir);

  // If no package.json, create a minimal one
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    await fsp.writeFile(
      pkgPath,
      JSON.stringify(
        {
          name: safeSlug,
          version: "1.0.0",
          private: true,
          scripts: {
            dev: "next dev",
            build: "next build",
          },
          dependencies: {
            next: "14.2.21",
            react: "^18",
            "react-dom": "^18",
          },
        },
        null,
        2
      )
    );
  }

  const { bootstrapped } = await ensureMinimalNextApp(dir, safeSlug);

  // npm install if no node_modules
  const nmPath = path.join(dir, "node_modules");
  if (!fs.existsSync(nmPath)) {
    await installSiteDependencies(dir);
  }

  // Ensure local Next.js CLI exists; recover from partial/stale node_modules.
  let nextCliPath = resolveLocalNextCliPath(dir);
  if (!nextCliPath) {
    await installSiteDependencies(dir);
    nextCliPath = resolveLocalNextCliPath(dir);
  }
  if (!nextCliPath) {
    throw new Error(
      `Next.js CLI not found in ${dir}. Please ensure dependencies are installed (missing node_modules/next/dist/bin/next).`
    );
  }

  // Find a free port
  const port = await findFreePort();
  const tunnelNonce = randomBytes(32).toString("hex");

  // Spawn next dev using local CLI path (avoids relying on npx in PATH).
  const child = spawn(process.execPath, [nextCliPath, "dev", "-p", String(port)], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  const entry = {
    port,
    tunnelNonce,
    slug: safeSlug,
    dir,
    process: child,
    exited: false,
    pid: child.pid,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    lastActivityLoggedAt: 0,
    idleTimer: null,
    stopReason: null,
  };
  activeSites.set(safeSlug, entry);
  emitSiteDevEvent("start", {
    slug: safeSlug,
    pid: entry.pid || null,
    port,
    already_running: false,
    phase: "spawned",
    idle_limit_ms: SITE_DEV_IDLE_MS,
  });

  child.on("exit", (code, signal) => {
    entry.exited = true;
    clearIdleTimer(entry);
    if (activeSites.get(safeSlug) === entry) {
      activeSites.delete(safeSlug);
    }
    emitSiteDevEvent("exited", {
      slug: safeSlug,
      pid: entry.pid || null,
      code: code ?? null,
      signal: signal ?? null,
      stop_reason: entry.stopReason || "process_exit",
    });
  });

  // Wait for the "ready" message (up to 60s)
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      let buf = "";
      let stderrBuf = "";
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        if (err) reject(err);
        else resolve();
      };
      const timeout = setTimeout(() => {
        void (async () => {
          if (settled) return;
          if (entry.exited) {
            finish(new Error(`next dev exited before becoming ready for ${safeSlug}`));
            return;
          }
          const reachable = await isHttpReachable(port);
          if (reachable) {
            finish();
            return;
          }
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
          const stderrTail = stderrBuf.trim().slice(-500);
          finish(
            new Error(
              `next dev timed out waiting for readiness for ${safeSlug}${
                stderrTail ? `: ${stderrTail}` : ""
              }`
            )
          );
        })();
      }, DEV_READY_TIMEOUT_MS);

      const onStdout = (chunk) => {
        buf += chunk.toString();
        if (/ready/i.test(buf) || /started server/i.test(buf)) {
          finish();
        }
      };
      const onStderr = (chunk) => {
        const text = chunk.toString();
        stderrBuf += text;
        buf += text;
        if (/ready/i.test(buf) || /started server/i.test(buf)) {
          finish();
        }
      };
      const onError = (err) => finish(err);
      const onExit = (code, signal) =>
        finish(
          new Error(
            `next dev exited early for ${safeSlug} (code=${code ?? "null"}, signal=${signal ?? "none"}): ${stderrBuf.slice(-500)}`
          )
        );

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.on("error", onError);
      child.on("exit", onExit);

      if (entry.exited) {
        finish(new Error(`next dev exited before becoming ready for ${safeSlug}`));
      }
    });
  } catch (err) {
    stopSiteEntry(entry, "start_failed");
    throw err;
  }

  touchSiteActivity(entry, "site_dev_start_ready");
  emitSiteDevEvent("start", {
    slug: safeSlug,
    pid: entry.pid || null,
    port,
    already_running: false,
    phase: "ready",
    idle_limit_ms: SITE_DEV_IDLE_MS,
  });

  return {
    ok: true,
    port,
    tunnelNonce,
    slug: safeSlug,
    alreadyRunning: false,
    bootstrapped,
    prunedBootstrapShadow,
  };
}

// ── Stop dev server ──────────────────────────────────────────────────────────

export async function siteDevStop({ slug }) {
  const safeSlug = sanitizeSlug(slug);
  if (!safeSlug) throw new Error("slug is required");
  const entry = activeSites.get(safeSlug);
  if (!entry) return { ok: true, wasRunning: false };

  const wasRunning = !entry.exited;
  stopSiteEntry(entry, "manual_stop");
  return { ok: true, wasRunning };
}

// ── Stop all dev servers (cleanup) ───────────────────────────────────────────

export function siteDevStopAll() {
  for (const [, entry] of activeSites) {
    stopSiteEntry(entry, "shutdown");
  }
  activeSites.clear();
}

// ── Read all files for deployment ────────────────────────────────────────────

const READ_DENY = new Set([
  "node_modules",
  ".git",
  ".next",
  "out",
  ".env",
  ".env.local",
  ".env.production",
]);

/**
 * Recursively read all files in a site directory.
 * Returns InlinedFile[] compatible with Vercel deployments API.
 */
export async function siteReadFiles({ slug, sitePath }) {
  const resolved = resolveSiteDir(slug, sitePath);
  const dir = resolved.dir;
  if (!fs.existsSync(dir)) throw new Error(`Site directory not found: ${dir}`);

  const files = [];
  const MAX_FILES = 500;
  const MAX_TOTAL = 50 * 1024 * 1024; // 50MB
  let totalBytes = 0;

  async function walk(currentDir, prefix) {
    if (files.length >= MAX_FILES) return;
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (READ_DENY.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(currentDir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(fullPath);
        if (stat.size > 5 * 1024 * 1024) continue; // skip >5MB files
        if (totalBytes + stat.size > MAX_TOTAL) continue;

        const buf = await fsp.readFile(fullPath);
        totalBytes += buf.length;

        // Binary detection: check for null bytes in first 512 bytes
        const head = buf.subarray(0, 512);
        const isBinary = head.includes(0);

        files.push({
          file: relPath,
          data: isBinary ? buf.toString("base64") : buf.toString("utf-8"),
          encoding: isBinary ? "base64" : "utf-8",
        });
      }
    }
  }

  await walk(dir, "");
  return { ok: true, files, totalBytes };
}

// ── HTTP tunnel ──────────────────────────────────────────────────────────────

/**
 * Proxy an HTTP request to a running site dev server.
 * Validates the tunnelNonce first.
 */
export async function siteTunnelRequest({ nonce, reqPath, method, headers: reqHeaders }) {
  // Find site by nonce
  let target = null;
  for (const [, entry] of activeSites) {
    if (entry.tunnelNonce === nonce && !entry.exited) {
      target = entry;
      break;
    }
  }

  if (!target) {
    return { ok: false, error: "tunnel_not_found", status: 404, body: "" };
  }

  touchSiteActivity(target, "tunnel_request");

  const safeReqPath = typeof reqPath === "string" && reqPath.startsWith("/") ? reqPath : "/";
  const safeHeaders = {};
  if (reqHeaders && typeof reqHeaders === "object") {
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (typeof v !== "string") continue;
      const key = k.toLowerCase();
      if (key === "host" || key === "content-length" || key === "connection") continue;
      safeHeaders[key] = v;
    }
  }

  const url = `http://127.0.0.1:${target.port}${safeReqPath}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(url, {
      method: method || "GET",
      headers: {
        ...safeHeaders,
        host: `127.0.0.1:${target.port}`,
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeout);

    const contentType = res.headers.get("content-type") || "";
    const isText =
      contentType.includes("text/") ||
      contentType.includes("json") ||
      contentType.includes("javascript") ||
      contentType.includes("css") ||
      contentType.includes("xml") ||
      contentType.includes("svg");

    let body;
    let encoding;
    if (isText) {
      body = await res.text();
      encoding = "utf-8";
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      body = buf.toString("base64");
      encoding = "base64";
    }

    return {
      ok: true,
      status: res.status,
      contentType,
      body,
      encoding,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "tunnel_fetch_failed",
      status: 502,
      body: "",
    };
  }
}

/** Get status of active dev sites. */
export function siteDevStatus() {
  const sites = [];
  for (const [slug, entry] of activeSites) {
    sites.push({
      slug,
      port: entry.port,
      exited: entry.exited,
      pid: entry.pid,
      startedAt: entry.startedAt || null,
      lastActivityAt: entry.lastActivityAt || null,
      idleLimitMs: SITE_DEV_IDLE_MS,
      stopReason: entry.stopReason || null,
    });
  }
  return sites;
}
