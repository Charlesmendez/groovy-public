/**
 * Browser Automation Module (Puppeteer)
 * Supports Claude Computer Use actions - screenshot, click at coordinates, type, key, scroll.
 */

import os from "os";
import path from "path";
import fs from "fs";
import { credentialGetSecret } from "./credentials.mjs";
import {
  killProcessesByCommandFragment,
  removeSingletonLocks,
} from "./platform/process/index.mjs";

let puppeteer = null;
let browser = null;
let pages = new Map(); // pageId -> page

// Display dimensions for Claude Computer Use (matches what we tell Claude)
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;

// Computer Use screenshot encoding:
// - Default to JPEG for much smaller payloads (faster loops, fewer 413s).
// - Use zoom (PNG) when Claude needs pixel-perfect detail.
const CU_SCREENSHOT_FORMAT = (process.env.GROOVY_CU_SCREENSHOT_FORMAT || "jpeg").toLowerCase() === "png" ? "png" : "jpeg";
const CU_JPEG_QUALITY_RAW = Number.parseInt(process.env.GROOVY_CU_JPEG_QUALITY || "80", 10);
const CU_JPEG_QUALITY = Number.isFinite(CU_JPEG_QUALITY_RAW) ? Math.max(40, Math.min(95, CU_JPEG_QUALITY_RAW)) : 80;

function safeDomainFromUrl(u) {
  try {
    const url = new URL(String(u));
    return String(url.hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

// Track auto-login attempts to avoid hammering a login page on every screenshot.
const autoLoginStateByPageId = new Map(); // pageId -> { domain, lastAttemptAtMs, attempts }
const AUTO_LOGIN_COOLDOWN_MS = 45_000;

async function detectLoginState(page) {
  try {
    return await page.evaluate(() => {
      function isVisible(el) {
        try {
          return !!(el && el.offsetParent !== null);
        } catch {
          return false;
        }
      }

      const url = String(window.location?.href || "");
      const title = String(document?.title || "");
      const bodyText = String(document?.body?.innerText || "");

      const pwEl = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible) || null;

      const userSelectors = [
        '#email-signup-input', // ClassLink step-1 (text input)
        'input[type="email"]',
        'input[name*="email" i]',
        'input[id*="email" i]',
        'input[autocomplete*="email" i]',
        'input[name*="user" i]',
        'input[id*="user" i]',
        'input[name*="login" i]',
        'input[id*="login" i]',
        'input[placeholder*="email" i]',
        'input[placeholder*="user" i]',
        'input[aria-label*="email" i]',
        'input[aria-label*="user" i]',
        'input[type="text"]',
      ];

      let userEl = null;
      for (const sel of userSelectors) {
        const cand = Array.from(document.querySelectorAll(sel)).find(isVisible);
        if (cand && cand !== pwEl) {
          userEl = cand;
          break;
        }
      }

      const submitSelectors = [
        '#oneroster-login', // ClassLink step-1 submit
        '#btn-finallogin', // ClassLink step-2 submit
        'button[type="submit"]',
        'input[type="submit"]',
        'button',
        '[role="button"]',
      ];

      // Prefer submit inside the same form when possible.
      let submitEl = null;
      const form = (pwEl && pwEl.form) || (userEl && userEl.form) || null;
      if (form) {
        for (const sel of submitSelectors) {
          const cand = form.querySelector(sel);
          if (cand && isVisible(cand)) {
            submitEl = cand;
            break;
          }
        }
      }
      if (!submitEl) {
        for (const sel of submitSelectors) {
          const cand = Array.from(document.querySelectorAll(sel)).find(isVisible);
          if (cand) {
            submitEl = cand;
            break;
          }
        }
      }

      const hasPw = !!pwEl;
      const hasUserish = !!userEl;
      const hasSubmit = !!submitEl;

      const urlHint = /login|signin|sign-in|auth/i.test(url) || /login|sign in|signin|password/i.test(title);
      const textHint = /(password|one-time|otp|forgot password|sign in|log in)/i.test(bodyText);

      // Only consider "email-only" forms as login if the page strongly hints it.
      const likely = hasPw || (hasUserish && hasSubmit && (urlHint || textHint));

      return {
        ok: true,
        url,
        title,
        hasPw,
        hasUserish,
        hasSubmit,
        likely,
      };
    });
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: err?.message || String(e) };
  }
}

async function waitForLoginDomChange(page, { timeoutMs = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const det = await detectLoginState(page);
    if (det?.ok) return det;
    await new Promise((r) => setTimeout(r, 200));
  }
  return await detectLoginState(page);
}

async function maybeWaitForNavigation(page, { timeoutMs = 6000 } = {}) {
  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => null),
      new Promise((r) => setTimeout(r, Math.min(timeoutMs, 1200))),
    ]);
  } catch {
    // ignore
  }
}

async function autoLoginIfNeeded({ pageId, page }) {
  const url = page.url();
  const domain = safeDomainFromUrl(url);
  if (!domain) return { attempted: false };

  const det0 = await detectLoginState(page);
  if (!det0?.ok || !det0.likely) return { attempted: false };

  const st = autoLoginStateByPageId.get(pageId);
  if (st && st.domain === domain && Date.now() - st.lastAttemptAtMs < AUTO_LOGIN_COOLDOWN_MS) {
    return { attempted: false, skipped: "cooldown" };
  }

  // Only attempt if credentials exist locally (never prompt here).
  const secret = await credentialGetSecret({ domain }).catch((e) => ({
    ok: false,
    error: e?.message || "credential_get_failed",
  }));
  if (!secret?.ok || !secret.hasCredential || !secret.password) {
    return { attempted: false };
  }

  autoLoginStateByPageId.set(pageId, {
    domain,
    lastAttemptAtMs: Date.now(),
    attempts: (st?.attempts || 0) + 1,
  });

  const username = String(secret.username || "");
  const password = String(secret.password || "");

  // Helper: fill visible user/pw inputs and click submit (best-effort)
  const fillAndSubmit = async ({ fillUser, fillPw }) => {
    return await page.evaluate(
      ({ username, password, fillUser, fillPw }) => {
        function isVisible(el) {
          try {
            return !!(el && el.offsetParent !== null);
          } catch {
            return false;
          }
        }

        function nativeSetValue(el, val) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(el, val);
          else el.value = val;
        }

        function setValue(el, val) {
          try {
            el.focus();
            nativeSetValue(el, "");
            el.dispatchEvent(new Event("input", { bubbles: true }));
            nativeSetValue(el, val);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } catch {
            // ignore
          }
        }

        const pwEl = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible) || null;
        const userSelectors = [
          '#email-signup-input',
          'input[type="email"]',
          'input[name*="email" i]',
          'input[id*="email" i]',
          'input[autocomplete*="email" i]',
          'input[name*="user" i]',
          'input[id*="user" i]',
          'input[name*="login" i]',
          'input[id*="login" i]',
          'input[placeholder*="email" i]',
          'input[placeholder*="user" i]',
          'input[aria-label*="email" i]',
          'input[aria-label*="user" i]',
          'input[type="text"]',
        ];

        let userEl = null;
        for (const sel of userSelectors) {
          const cand = Array.from(document.querySelectorAll(sel)).find(isVisible);
          if (cand && cand !== pwEl) {
            userEl = cand;
            break;
          }
        }

        if (fillUser && userEl && username) setValue(userEl, username);
        if (fillPw && pwEl && password) setValue(pwEl, password);

        return {
          ok: true,
          filledUser: !!(fillUser && userEl && username),
          filledPw: !!(fillPw && pwEl && password),
          clickedSubmit: false,
        };
      },
      { username, password, fillUser, fillPw }
    );
  };

  // Attempt flow:
  // Fill credentials locally, but never auto-submit them. Submitting a login
  // form sends the password to whatever action URL the page controls.
  let det = det0;
  let stage = det.hasPw ? "password" : det.hasUserish ? "user_only" : "unknown";

  if (!det.hasPw && det.hasUserish) {
    await fillAndSubmit({ fillUser: true, fillPw: false }).catch(() => null);
    stage = "user_only_filled";
  }

  if (det?.ok && det.hasPw) {
    await fillAndSubmit({ fillUser: true, fillPw: true }).catch(() => null);
    stage = "password_filled";
  }

  return {
    attempted: true,
    ok: true,
    auto_login_attempted: true,
    note:
      `Credentials were filled locally for ${domain}, but not submitted. ` +
      `Submit only after verifying the page and destination are legitimate.`,
    stage,
  };
}

/**
 * Clean up stale browser locks before launching.
 * Chrome leaves SingletonLock files if it crashes/is killed, blocking future launches.
 */
async function cleanupStaleBrowserLocks(userDataDir) {
  try {
    const killResult = await killProcessesByCommandFragment(userDataDir, {
      processNameRegex: "chrome|chromium|msedge|puppeteer",
    });
    if (killResult.killed > 0) {
      console.log(`[browser] Killed ${killResult.killed} stale browser process(es)`);
      await new Promise((r) => setTimeout(r, 250));
    }

    const removed = await removeSingletonLocks(userDataDir);
    if (removed > 0) {
      console.log(`[browser] Removed ${removed} stale browser lock file(s)`);
    }

    // Brief pause for OS cleanup
    await new Promise((r) => setTimeout(r, 200));
  } catch (e) {
    console.warn("[browser] cleanupStaleBrowserLocks error:", e instanceof Error ? e.message : String(e));
  }
}

// Load puppeteer lazily
async function getPuppeteer() {
  if (!puppeteer) {
    try {
      puppeteer = (await import("puppeteer")).default;
    } catch (err) {
      console.error("[browser] Failed to load puppeteer:", err.message);
      return null;
    }
  }
  return puppeteer;
}

/**
 * Initialize browser instance
 */
export async function initBrowser(options = {}) {
  const pptr = await getPuppeteer();
  if (!pptr) {
    return { ok: false, error: "Puppeteer not installed" };
  }

  if (browser) {
    try {
      // Check if browser is still connected
      if (browser.isConnected()) {
        return { ok: true, reused: true };
      }
    } catch {
      browser = null;
    }
  }

  try {
    const profileName =
      typeof options.profile_name === "string" && options.profile_name.trim()
        ? options.profile_name.trim()
        : typeof options.profileName === "string" && options.profileName.trim()
          ? options.profileName.trim()
          : "default";
    const userDataDir =
      typeof options.user_data_dir === "string" && options.user_data_dir.trim()
        ? options.user_data_dir.trim()
        : path.join(os.homedir(), ".groovy", "browser-profiles", profileName);
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
    } catch {
      // ignore
    }

    // Clean up stale locks from crashed/killed browser processes
    await cleanupStaleBrowserLocks(userDataDir);

    // Use dimensions that match what we tell Claude for Computer Use
    browser = await pptr.launch({
      headless: options.headless !== false ? "new" : false,
      userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        `--window-size=${DISPLAY_WIDTH},${DISPLAY_HEIGHT}`,
      ],
      defaultViewport: {
        width: DISPLAY_WIDTH,
        height: DISPLAY_HEIGHT,
        // Keep coordinates stable and avoid retina-sized screenshots.
        deviceScaleFactor: 1,
      },
    });

    console.log(`[browser] Launched browser (${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}) profile=${profileName}`);
    return {
      ok: true,
      launched: true,
      displayWidth: DISPLAY_WIDTH,
      displayHeight: DISPLAY_HEIGHT,
      profileName,
      userDataDir,
    };
  } catch (err) {
    return { ok: false, error: `Failed to launch browser: ${err.message}` };
  }
}

/**
 * Close browser instance
 */
export async function closeBrowser() {
  if (browser) {
    try {
      await browser.close();
      browser = null;
      pages.clear();
      console.log("[browser] Closed browser instance");
      return { ok: true, closed: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: true, wasNotOpen: true };
}

/**
 * Get or create a page
 */
async function getPage(pageId = "default") {
  if (!browser || !browser.isConnected()) {
    const init = await initBrowser();
    if (!init.ok) return { ok: false, error: init.error };
  }

  if (pages.has(pageId)) {
    const page = pages.get(pageId);
    try {
      // Check if page is still valid
      await page.title();
      return { ok: true, page };
    } catch {
      pages.delete(pageId);
    }
  }

  try {
    const page = await browser.newPage();
    
    // Set user agent to avoid bot detection
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Set default timeout
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    pages.set(pageId, page);
    return { ok: true, page, created: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Navigate to a URL
 */
export async function browserNavigate({ url, pageId = "default", waitUntil = "networkidle2", timeoutMs }) {
  console.log(`[browser-navigate] url=${url}, waitUntil=${waitUntil}, timeoutMs=${timeoutMs}`);
  
  if (!url || typeof url !== "string") {
    return { ok: false, error: "URL is required" };
  }

  // Ensure URL has protocol
  let fullUrl = url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    fullUrl = `https://${url}`;
  }

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    console.log(`[browser-navigate] Starting navigation to ${fullUrl}...`);
    const startTime = Date.now();
    const response = await page.goto(fullUrl, {
      waitUntil,
      timeout: typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : 30000,
    });
    console.log(`[browser-navigate] Navigation complete in ${Date.now() - startTime}ms`);
    const title = await page.title();
    const finalUrl = page.url();

    return {
      ok: true,
      url: finalUrl,
      title,
      status: response?.status() || null,
      pageId,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Click an element
 */
export async function browserClick({ selector, pageId = "default", waitForNav = false }) {
  if (!selector || typeof selector !== "string") {
    return { ok: false, error: "Selector is required" };
  }

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    await page.waitForSelector(selector, { timeout: 10000 });
    
    if (waitForNav) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2" }),
        page.click(selector),
      ]);
    } else {
      await page.click(selector);
    }

    return {
      ok: true,
      selector,
      clicked: true,
      url: page.url(),
      title: await page.title(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Type text into an element
 */
export async function browserType({ selector, text, pageId = "default", clear = true, delay = 50 }) {
  if (!selector || typeof selector !== "string") {
    return { ok: false, error: "Selector is required" };
  }
  if (typeof text !== "string") {
    return { ok: false, error: "Text is required" };
  }

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    await page.waitForSelector(selector, { timeout: 10000 });

    if (clear) {
      await page.click(selector, { clickCount: 3 }); // Select all
      await page.keyboard.press("Backspace");
    }

    await page.type(selector, text, { delay });

    return {
      ok: true,
      selector,
      text,
      typed: true,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Press a key
 */
export async function browserPressKey({ key, pageId = "default" }) {
  if (!key || typeof key !== "string") {
    return { ok: false, error: "Key is required" };
  }

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    await page.keyboard.press(key);
    return { ok: true, key, pressed: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Take a screenshot
 */
export async function browserScreenshot({ pageId = "default", fullPage = false, selector = null }) {
  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    let screenshotOptions = {
      encoding: "base64",
      type: "png",
    };

    let screenshot;
    if (selector) {
      const element = await page.$(selector);
      if (!element) {
        return { ok: false, error: `Element not found: ${selector}` };
      }
      screenshot = await element.screenshot(screenshotOptions);
    } else {
      screenshotOptions.fullPage = fullPage;
      screenshot = await page.screenshot(screenshotOptions);
    }

    return {
      ok: true,
      screenshot: `data:image/png;base64,${screenshot}`,
      url: page.url(),
      title: await page.title(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Extract content from page
 */
export async function browserExtract({ pageId = "default", selector = null, type = "text" }) {
  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    if (selector) {
      await page.waitForSelector(selector, { timeout: 10000 });
    }

    let content;

    switch (type) {
      case "html":
        if (selector) {
          content = await page.$eval(selector, (el) => el.innerHTML);
        } else {
          content = await page.content();
        }
        break;

      case "text":
        if (selector) {
          content = await page.$eval(selector, (el) => el.innerText);
        } else {
          content = await page.evaluate(() => document.body.innerText);
        }
        break;

      case "links":
        content = await page.evaluate((sel) => {
          const container = sel ? document.querySelector(sel) : document;
          if (!container) return [];
          const links = container.querySelectorAll("a[href]");
          return Array.from(links).map((a) => ({
            text: a.innerText.trim(),
            href: a.href,
          }));
        }, selector);
        break;

      case "images":
        content = await page.evaluate((sel) => {
          const container = sel ? document.querySelector(sel) : document;
          if (!container) return [];
          const images = container.querySelectorAll("img[src]");
          return Array.from(images).map((img) => ({
            alt: img.alt,
            src: img.src,
          }));
        }, selector);
        break;

      case "table":
        if (!selector) {
          return { ok: false, error: "Selector required for table extraction" };
        }
        content = await page.evaluate((sel) => {
          const table = document.querySelector(sel);
          if (!table) return null;

          const headers = Array.from(table.querySelectorAll("th")).map(
            (th) => th.innerText.trim()
          );

          const rows = Array.from(table.querySelectorAll("tr"))
            .slice(headers.length ? 1 : 0)
            .map((tr) =>
              Array.from(tr.querySelectorAll("td")).map((td) =>
                td.innerText.trim()
              )
            );

          return { headers, rows };
        }, selector);
        break;

      case "form":
        if (!selector) {
          return { ok: false, error: "Selector required for form extraction" };
        }
        content = await page.evaluate((sel) => {
          const form = document.querySelector(sel);
          if (!form) return null;

          const inputs = Array.from(form.querySelectorAll("input, select, textarea"));
          return inputs.map((input) => ({
            name: input.name,
            type: input.type || input.tagName.toLowerCase(),
            value: input.value,
            placeholder: input.placeholder,
          }));
        }, selector);
        break;

      default:
        return { ok: false, error: `Unknown extraction type: ${type}` };
    }

    return {
      ok: true,
      type,
      selector,
      content,
      url: page.url(),
      title: await page.title(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Wait for element or condition
 */
export async function browserWait({ pageId = "default", selector = null, timeout = 10000, visible = true }) {
  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    if (selector) {
      await page.waitForSelector(selector, { timeout, visible });
      return { ok: true, selector, found: true };
    } else {
      await new Promise((resolve) => setTimeout(resolve, timeout));
      return { ok: true, waited: timeout };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Scroll the page
 */
export async function browserScroll({ pageId = "default", direction = "down", amount = 500 }) {
  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    const scrollAmount = direction === "up" ? -amount : amount;
    await page.evaluate((y) => window.scrollBy(0, y), scrollAmount);

    return {
      ok: true,
      direction,
      amount,
      scrolled: true,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get page info
 */
export async function browserGetInfo({ pageId = "default" }) {
  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    const info = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      scrollY: window.scrollY,
      scrollHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    }));

    return { ok: true, ...info, pageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Execute JavaScript in page context
 */
export async function browserEvaluate({ pageId = "default", script }) {
  if (!script || typeof script !== "string") {
    return { ok: false, error: "Script is required" };
  }

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    // Wrap in async function to allow await
    const wrappedScript = `(async () => { ${script} })()`;
    const result = await page.evaluate(wrappedScript);

    return {
      ok: true,
      result,
      url: page.url(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Fill a form
 */
export async function browserFillForm({ pageId = "default", formSelector, fields }) {
  if (!formSelector || typeof formSelector !== "string") {
    return { ok: false, error: "Form selector is required" };
  }
  if (!fields || typeof fields !== "object") {
    return { ok: false, error: "Fields object is required" };
  }

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    await page.waitForSelector(formSelector, { timeout: 10000 });

    const filled = [];

    for (const [name, value] of Object.entries(fields)) {
      try {
        // Try by name attribute
        const selector = `${formSelector} [name="${name}"]`;
        const element = await page.$(selector);

        if (element) {
          const tagName = await element.evaluate((el) => el.tagName.toLowerCase());
          const type = await element.evaluate((el) => el.type?.toLowerCase());

          if (tagName === "select") {
            await page.select(selector, value);
          } else if (type === "checkbox" || type === "radio") {
            const checked = await element.evaluate((el) => el.checked);
            if ((value && !checked) || (!value && checked)) {
              await element.click();
            }
          } else {
            await page.click(selector, { clickCount: 3 });
            await page.keyboard.press("Backspace");
            await page.type(selector, String(value));
          }

          filled.push({ name, value, success: true });
        } else {
          filled.push({ name, value, success: false, error: "Element not found" });
        }
      } catch (err) {
        filled.push({ name, value, success: false, error: err.message });
      }
    }

    return {
      ok: true,
      formSelector,
      filled,
      url: page.url(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Close a specific page
 */
export async function browserClosePage({ pageId = "default" }) {
  const page = pages.get(pageId);
  if (!page) {
    return { ok: true, wasNotOpen: true };
  }

  try {
    await page.close();
    pages.delete(pageId);
    return { ok: true, closed: true, pageId };
  } catch (err) {
    pages.delete(pageId);
    return { ok: false, error: err.message };
  }
}

/**
 * List open pages
 */
export function browserListPages() {
  const pageList = [];
  for (const [id, page] of pages.entries()) {
    try {
      pageList.push({
        id,
        url: page.url(),
      });
    } catch {
      // Page may be closed
    }
  }
  return { ok: true, pages: pageList };
}

// ============================================================================
// CLAUDE COMPUTER USE ACTIONS
// These functions implement the actions Claude can request via Computer Use
// ============================================================================

function mapKeyName(key) {
  const k = String(key || "").trim();
  if (!k) return "";
  const keyMap = {
    ctrl: "Control",
    control: "Control",
    alt: "Alt",
    shift: "Shift",
    meta: "Meta",
    cmd: "Meta",
    super: "Meta",
    enter: "Enter",
    return: "Enter",
    escape: "Escape",
    esc: "Escape",
    tab: "Tab",
    space: " ",
    backspace: "Backspace",
    delete: "Delete",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
  };
  return keyMap[k.toLowerCase()] || k;
}

/**
 * Execute a Claude Computer Use action
 * This is the main entry point for Computer Use - routes to specific handlers
 */
export async function computerUseAction({ action, coordinate, text, key, scrollDirection, scrollAmount, region, pageId = "default" }) {
  const textPreview =
    typeof text === "string"
      ? text.slice(0, 50)
      : typeof text === "number"
        ? String(text)
        : text && typeof text === "object"
          ? JSON.stringify(text).slice(0, 50)
          : "";
  console.log(`[browser-computer-use] action=${action}, coord=${JSON.stringify(coordinate)}, text=${textPreview}`);
  
  switch (action) {
    case "screenshot":
      return computerUseScreenshot({ pageId });
    
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
      return computerUseClick({ pageId, coordinate, button: action, text });
    
    case "type":
      return computerUseType({ pageId, text });
    
    case "key":
      return computerUsePressKey({ pageId, key: key || text });
    
    case "scroll":
      return computerUseScroll({ pageId, coordinate, direction: scrollDirection, amount: scrollAmount, text });
    
    case "mouse_move":
      return computerUseMouseMove({ pageId, coordinate });
    
    case "left_click_drag":
      return computerUseDrag({ pageId, startCoordinate: coordinate, endCoordinate: text }); // text holds end coords as JSON
    
    case "left_mouse_down":
      return computerUseMouseDown({ pageId, coordinate });

    case "left_mouse_up":
      return computerUseMouseUp({ pageId, coordinate });

    case "hold_key": {
      const seconds =
        typeof text === "number"
          ? text
          : typeof text === "string" && text.trim() && !Number.isNaN(Number.parseFloat(text))
            ? Number.parseFloat(text)
            : 1;
      const holdKey = key || (typeof text === "string" && Number.isNaN(Number.parseFloat(text)) ? text : "");
      return computerUseHoldKey({ pageId, key: holdKey, seconds });
    }

    case "wait":
      const waitMs = (typeof text === "number" ? text : parseFloat(text) || 1) * 1000;
      await new Promise(r => setTimeout(r, Math.min(waitMs, 10000)));
      return { ok: true, action: "wait", waited: waitMs };

    case "zoom":
      return computerUseZoom({ pageId, region });
    
    default:
      return { ok: false, error: `Unknown Computer Use action: ${action}` };
  }
}

/**
 * Take screenshot for Claude Computer Use
 * Returns base64-encoded PNG at the display dimensions
 */
export async function computerUseScreenshot({ pageId = "default" }) {
  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    // If we're on a login page and credentials exist locally, attempt auto-login BEFORE capturing.
    const auto = await autoLoginIfNeeded({ pageId, page }).catch(() => ({ attempted: false }));

    // Let the browser paint at least one frame before capturing.
    // This reduces "black/blank" screenshots during navigation/transitions.
    try {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 75));

    // Get scroll position BEFORE screenshot
    const scrollY = await page.evaluate(() => (typeof window !== "undefined" ? window.scrollY : 0));
    
    console.log(`[browser-screenshot] Taking screenshot at scrollY=${scrollY}`);
    
    // IMPORTANT:
    // For Computer Use we need the *current viewport* screenshot so Claude can see
    // the effects of scroll/click. Using `clip: { x:0, y:0, ... }` captures the
    // top-left of the *document*, which stays constant even when the page scrolls.
    const screenshotType = CU_SCREENSHOT_FORMAT === "png" ? "png" : "jpeg";
    const screenshotMediaType = screenshotType === "png" ? "image/png" : "image/jpeg";
    const screenshotOpts = {
      encoding: "base64",
      type: screenshotType,
      ...(screenshotType === "jpeg" ? { quality: CU_JPEG_QUALITY } : {}),
      // Keep within viewport; don't capture offscreen content.
      captureBeyondViewport: false,
    };

    let screenshot = await page.screenshot(screenshotOpts);

    // Heuristic retry: a uniform/blank frame compresses extremely well (tiny PNG).
    // If it's suspiciously small, wait briefly and retry once.
    let retried = false;
    if (typeof screenshot === "string" && screenshot.length > 0 && screenshot.length < 15000) {
      retried = true;
      await new Promise((r) => setTimeout(r, 250));
      const retry = await page.screenshot(screenshotOpts);
      if (typeof retry === "string" && retry.length > screenshot.length) {
        screenshot = retry;
      }
    }
    
    console.log(`[browser-screenshot] Screenshot taken, size=${screenshot.length}, scrollY=${scrollY}`);

    return {
      ok: true,
      action: "screenshot",
      screenshot, // Raw base64 (no data: prefix for Claude API)
      screenshotMediaType,
      url: page.url(),
      title: await page.title(),
      scrollY,
      displayWidth: DISPLAY_WIDTH,
      displayHeight: DISPLAY_HEIGHT,
      screenshotRetried: retried || undefined,
      ...(auto && auto.attempted ? { ...auto } : {}),
    };
  } catch (err) {
    return { ok: false, error: `Screenshot failed: ${err.message}` };
  }
}

/**
 * Click at coordinates (x, y) for Claude Computer Use
 */
export async function computerUseClick({ pageId = "default", coordinate, button = "left_click", text }) {
  if (!coordinate || !Array.isArray(coordinate) || coordinate.length !== 2) {
    return { ok: false, error: "Coordinate [x, y] required for click" };
  }

  const [x, y] = coordinate;
  
  // Validate coordinates are within display bounds
  if (x < 0 || x >= DISPLAY_WIDTH || y < 0 || y >= DISPLAY_HEIGHT) {
    return { ok: false, error: `Coordinates (${x}, ${y}) outside display bounds (${DISPLAY_WIDTH}x${DISPLAY_HEIGHT})` };
  }

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    // Handle modifier keys if provided (e.g., "shift", "ctrl")
    const modifiers = [];
    if (typeof text === "string" && text.trim()) {
      const mod = text.toLowerCase();
      if (mod === "shift") modifiers.push("Shift");
      if (mod === "ctrl" || mod === "control") modifiers.push("Control");
      if (mod === "alt") modifiers.push("Alt");
      if (mod === "super" || mod === "meta" || mod === "cmd") modifiers.push("Meta");
    }

    // Perform click based on button type
    const buttonMap = {
      left_click: "left",
      right_click: "right",
      middle_click: "middle",
    };
    
    const mouseButton = buttonMap[button] || "left";
    const clickCount = button === "double_click" ? 2 : button === "triple_click" ? 3 : 1;

    try {
      // Hold modifier keys
      for (const mod of modifiers) {
        await page.keyboard.down(mod);
      }

      await page.mouse.click(x, y, { button: mouseButton, clickCount });
    } finally {
      // Always release modifiers even if click throws
      for (const mod of modifiers.reverse()) {
        try {
          await page.keyboard.up(mod);
        } catch {
          // ignore
        }
      }
    }

    // Wait a moment for any UI updates
    await new Promise(r => setTimeout(r, 100));

    return {
      ok: true,
      action: button,
      coordinate: [x, y],
      modifiers: modifiers.length > 0 ? modifiers : undefined,
      url: page.url(),
    };
  } catch (err) {
    return { ok: false, error: `Click failed: ${err.message}` };
  }
}

/**
 * Type text for Claude Computer Use
 */
export async function computerUseType({ pageId = "default", text }) {
  if (typeof text !== "string") {
    return { ok: false, error: "Text string required for type action" };
  }

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    // Type with a small delay between characters for reliability
    await page.keyboard.type(text, { delay: 30 });

    return {
      ok: true,
      action: "type",
      text: text.length > 50 ? text.slice(0, 50) + "..." : text,
      charCount: text.length,
    };
  } catch (err) {
    return { ok: false, error: `Type failed: ${err.message}` };
  }
}

/**
 * Press key combination for Claude Computer Use
 * Supports combinations like "ctrl+s", "Enter", "Escape", etc.
 */
export async function computerUsePressKey({ pageId = "default", key }) {
  if (!key || typeof key !== "string") {
    return { ok: false, error: "Key string required for key action" };
  }

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    // Handle key combinations like "ctrl+s", "shift+enter"
    const parts = key.split("+").map(k => k.trim());
    const mappedKeys = parts.map(mapKeyName);
    
    // If it's a combination, hold modifiers and press the last key
    if (mappedKeys.length > 1) {
      const modifiers = mappedKeys.slice(0, -1);
      const mainKey = mappedKeys[mappedKeys.length - 1];

      try {
        for (const mod of modifiers) {
          await page.keyboard.down(mod);
        }
        await page.keyboard.press(mainKey);
      } finally {
        for (const mod of modifiers.reverse()) {
          try {
            await page.keyboard.up(mod);
          } catch {
            // ignore
          }
        }
      }
    } else {
      await page.keyboard.press(mappedKeys[0]);
    }

    return {
      ok: true,
      action: "key",
      key,
      pressed: mappedKeys.join("+"),
    };
  } catch (err) {
    return { ok: false, error: `Key press failed: ${err.message}` };
  }
}

/**
 * Scroll for Claude Computer Use
 */
export async function computerUseScroll({ pageId = "default", coordinate, direction = "down", amount = 3, text }) {
  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    // Calculate scroll amount (each unit is ~100 pixels)
    const pixelAmount = (amount || 3) * 100;
    
    // Scroll direction mapping
    const scrollDeltas = {
      up: { x: 0, y: -pixelAmount },
      down: { x: 0, y: pixelAmount },
      left: { x: -pixelAmount, y: 0 },
      right: { x: pixelAmount, y: 0 },
    };
    
    const delta = scrollDeltas[direction] || scrollDeltas.down;
    
    // Handle modifier keys if provided (e.g., "shift", "ctrl") and scroll the nearest scrollable container.
    // This improves reliability in modals/sidebars with nested scroll regions.
    const modifiers = [];
    if (typeof text === "string" && text.trim()) {
      const mod = text.toLowerCase();
      if (mod === "shift") modifiers.push("Shift");
      if (mod === "ctrl" || mod === "control") modifiers.push("Control");
      if (mod === "alt") modifiers.push("Alt");
      if (mod === "super" || mod === "meta" || mod === "cmd") modifiers.push("Meta");
    }
    try {
      for (const mod of modifiers) {
        await page.keyboard.down(mod);
      }

      const [cx, cy] =
        Array.isArray(coordinate) && coordinate.length === 2
          ? [Number(coordinate[0]) || 0, Number(coordinate[1]) || 0]
          : [Math.floor(DISPLAY_WIDTH / 2), Math.floor(DISPLAY_HEIGHT / 2)];

      const scrollResult = await page.evaluate(
        ({ x, y, dx, dy }) => {
          function isScrollable(el) {
            if (!el || el === document.body || el === document.documentElement) return false;
            try {
              const style = window.getComputedStyle(el);
              const overflowY = style.overflowY;
              const overflowX = style.overflowX;
              const canScrollY = (overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1;
              const canScrollX = (overflowX === "auto" || overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1;
              return canScrollY || canScrollX;
            } catch {
              return false;
            }
          }

          const beforeWin = { x: window.scrollX, y: window.scrollY };

          let el = null;
          try {
            el = document.elementFromPoint(x, y);
          } catch {
            el = null;
          }

          let target = el;
          while (target && target !== document.body && target !== document.documentElement && !isScrollable(target)) {
            target = target.parentElement;
          }

          if (target && isScrollable(target)) {
            const before = { left: target.scrollLeft, top: target.scrollTop };
            try {
              target.scrollBy(dx, dy);
            } catch {
              // Fallback
              target.scrollLeft = before.left + dx;
              target.scrollTop = before.top + dy;
            }
            const after = { left: target.scrollLeft, top: target.scrollTop };
            return {
              target: "element",
              before,
              after,
              scrolled: before.left !== after.left || before.top !== after.top,
              window: { before: beforeWin, after: { x: window.scrollX, y: window.scrollY } },
            };
          }

          // Fallback: scroll the window
          window.scrollBy(dx, dy);
          const afterWin = { x: window.scrollX, y: window.scrollY };
          return {
            target: "window",
            window: { before: beforeWin, after: afterWin },
            scrolled: beforeWin.x !== afterWin.x || beforeWin.y !== afterWin.y,
          };
        },
        { x: cx, y: cy, dx: delta.x, dy: delta.y }
      );

      console.log(`[browser-scroll] direction=${direction}, delta=${JSON.stringify(delta)}, result=${JSON.stringify(scrollResult)}`);

      // Wait for scroll to settle and any lazy-loaded content
      await new Promise(r => setTimeout(r, 300));

      return {
        ok: true,
        action: "scroll",
        direction,
        amount,
        coordinate,
        scrollY:
          scrollResult?.target === "window"
            ? scrollResult?.window?.after?.y
            : scrollResult?.window?.after?.y,
        scrolled: scrollResult.scrolled,
        modifiers: modifiers.length > 0 ? modifiers : undefined,
      };
    } finally {
      for (const mod of modifiers.reverse()) {
        try {
          await page.keyboard.up(mod);
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    return { ok: false, error: `Scroll failed: ${err.message}` };
  }
}

/**
 * Mouse down/up for fine-grained interactions (e.g., selecting ranges).
 */
export async function computerUseMouseDown({ pageId = "default", coordinate }) {
  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;
  const { page } = pageResult;

  try {
    if (Array.isArray(coordinate) && coordinate.length === 2) {
      const [x, y] = coordinate;
      if (x < 0 || x >= DISPLAY_WIDTH || y < 0 || y >= DISPLAY_HEIGHT) {
        return { ok: false, error: `Coordinates (${x}, ${y}) outside display bounds (${DISPLAY_WIDTH}x${DISPLAY_HEIGHT})` };
      }
      await page.mouse.move(x, y);
    }
    await page.mouse.down({ button: "left" });
    return { ok: true, action: "left_mouse_down", coordinate, url: page.url() };
  } catch (err) {
    return { ok: false, error: `Mouse down failed: ${err.message}` };
  }
}

export async function computerUseMouseUp({ pageId = "default", coordinate }) {
  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;
  const { page } = pageResult;

  try {
    if (Array.isArray(coordinate) && coordinate.length === 2) {
      const [x, y] = coordinate;
      if (x < 0 || x >= DISPLAY_WIDTH || y < 0 || y >= DISPLAY_HEIGHT) {
        return { ok: false, error: `Coordinates (${x}, ${y}) outside display bounds (${DISPLAY_WIDTH}x${DISPLAY_HEIGHT})` };
      }
      await page.mouse.move(x, y);
    }
    await page.mouse.up({ button: "left" });
    return { ok: true, action: "left_mouse_up", coordinate, url: page.url() };
  } catch (err) {
    return { ok: false, error: `Mouse up failed: ${err.message}` };
  }
}

/**
 * Hold a key down for N seconds.
 */
export async function computerUseHoldKey({ pageId = "default", key, seconds = 1 }) {
  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;
  const { page } = pageResult;

  const mapped = mapKeyName(key);
  if (!mapped) return { ok: false, error: "Key is required for hold_key" };

  const s = Math.max(0.05, Math.min(Number(seconds) || 1, 10));

  try {
    await page.keyboard.down(mapped);
    await new Promise((r) => setTimeout(r, s * 1000));
    return { ok: true, action: "hold_key", key: mapped, seconds: s };
  } catch (err) {
    return { ok: false, error: `Hold key failed: ${err.message}` };
  } finally {
    try {
      await page.keyboard.up(mapped);
    } catch {
      // ignore
    }
  }
}

/**
 * Move mouse to coordinates for Claude Computer Use
 */
export async function computerUseMouseMove({ pageId = "default", coordinate }) {
  if (!coordinate || !Array.isArray(coordinate) || coordinate.length !== 2) {
    return { ok: false, error: "Coordinate [x, y] required for mouse_move" };
  }

  const [x, y] = coordinate;

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    await page.mouse.move(x, y);

    return {
      ok: true,
      action: "mouse_move",
      coordinate: [x, y],
    };
  } catch (err) {
    return { ok: false, error: `Mouse move failed: ${err.message}` };
  }
}

/**
 * Click and drag for Claude Computer Use
 */
export async function computerUseDrag({ pageId = "default", startCoordinate, endCoordinate }) {
  if (!startCoordinate || !Array.isArray(startCoordinate) || startCoordinate.length !== 2) {
    return { ok: false, error: "Start coordinate required for drag" };
  }
  
  // End coordinate might be passed as JSON string
  let endCoords = endCoordinate;
  if (typeof endCoordinate === "string") {
    try {
      endCoords = JSON.parse(endCoordinate);
    } catch {
      return { ok: false, error: "Invalid end coordinate format" };
    }
  }
  
  if (!endCoords || !Array.isArray(endCoords) || endCoords.length !== 2) {
    return { ok: false, error: "End coordinate required for drag" };
  }

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    await page.mouse.move(startCoordinate[0], startCoordinate[1]);
    await page.mouse.down();
    await page.mouse.move(endCoords[0], endCoords[1], { steps: 10 });
    await page.mouse.up();

    return {
      ok: true,
      action: "left_click_drag",
      startCoordinate,
      endCoordinate: endCoords,
    };
  } catch (err) {
    return { ok: false, error: `Drag failed: ${err.message}` };
  }
}

/**
 * Zoom into a region for Claude Computer Use (computer_20251124 / Opus 4.6)
 * Takes a cropped screenshot of the specified region at full resolution.
 */
export async function computerUseZoom({ pageId = "default", region }) {
  if (!region || !Array.isArray(region) || region.length !== 4) {
    return { ok: false, error: "Region [x1, y1, x2, y2] required for zoom" };
  }

  const [x1, y1, x2, y2] = region;

  const pageResult = await getPage(pageId);
  if (!pageResult.ok) return pageResult;

  const { page } = pageResult;

  try {
    // `region` is in viewport coordinates (from the screenshot). Puppeteer's `clip` is document-relative,
    // so we must add scroll offsets or zoom will crop the wrong area when scrolled.
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    const sx = Number(scroll?.x) || 0;
    const sy = Number(scroll?.y) || 0;

    // Clamp region to the viewport bounds (avoid errors on invalid regions)
    const vx1 = Math.max(0, Math.min(DISPLAY_WIDTH - 1, Math.floor(x1)));
    const vy1 = Math.max(0, Math.min(DISPLAY_HEIGHT - 1, Math.floor(y1)));
    const vx2 = Math.max(vx1 + 1, Math.min(DISPLAY_WIDTH, Math.floor(x2)));
    const vy2 = Math.max(vy1 + 1, Math.min(DISPLAY_HEIGHT, Math.floor(y2)));

    let screenshot = await page.screenshot({
      encoding: "base64",
      type: "png",
      clip: {
        x: sx + vx1,
        y: sy + vy1,
        width: Math.max(1, vx2 - vx1),
        height: Math.max(1, vy2 - vy1),
      },
    });

    // Retry if zoom crop came back suspiciously small (often a blank frame)
    let retried = false;
    if (typeof screenshot === "string" && screenshot.length > 0 && screenshot.length < 8000) {
      retried = true;
      await new Promise((r) => setTimeout(r, 200));
      const retry = await page.screenshot({
        encoding: "base64",
        type: "png",
        clip: {
          x: sx + vx1,
          y: sy + vy1,
          width: Math.max(1, vx2 - vx1),
          height: Math.max(1, vy2 - vy1),
        },
      });
      if (typeof retry === "string" && retry.length > screenshot.length) {
        screenshot = retry;
      }
    }

    return {
      ok: true,
      action: "zoom",
      screenshot,
      screenshotMediaType: "image/png",
      region: [vx1, vy1, vx2, vy2],
      url: page.url(),
      title: await page.title(),
      screenshotRetried: retried || undefined,
    };
  } catch (err) {
    return { ok: false, error: `Zoom failed: ${err.message}` };
  }
}

/**
 * Get display dimensions for Claude Computer Use tool definition
 */
export function getDisplayDimensions() {
  return {
    ok: true,
    displayWidth: DISPLAY_WIDTH,
    displayHeight: DISPLAY_HEIGHT,
  };
}
