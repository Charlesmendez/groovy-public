import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  parseChromiumMajor,
  parseRevisionMajor,
  resolveWhatsAppBrowserRuntime,
} from "./platform/whatsapp/browserRuntime.mjs";

test("parses Chrome, Chromium, and HeadlessChrome versions", () => {
  assert.equal(parseChromiumMajor("Google Chrome 151.0.7922.140"), 151);
  assert.equal(parseChromiumMajor("Google Chrome for Testing 144.0.7559.96"), 144);
  assert.equal(parseChromiumMajor("Chromium 144.0.7559.96"), 144);
  assert.equal(parseChromiumMajor("HeadlessChrome/144.0.7559.96"), 144);
  assert.equal(parseChromiumMajor("Microsoft Edge 151.0.1.2"), 151);
  assert.equal(parseChromiumMajor("not a browser"), null);
  assert.equal(parseRevisionMajor("144.0.7559.96"), 144);
});

test("selects a current system browser before Puppeteer's too-old cache", async () => {
  const cachePath = path.resolve("/fake/cache/chrome");
  const systemPath = path.resolve(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  );
  const result = await resolveWhatsAppBrowserRuntime({
    env: {},
    platform: "darwin",
    homeDirectory: "/fake/home",
    existsSync: (candidate) => candidate === cachePath || candidate === systemPath,
    inspectVersion: async (candidate) =>
      candidate === cachePath ? "Google Chrome for Testing 144.0.7559.96" : "Google Chrome 151.0.1.2",
    puppeteerInfo: {
      expectedRevision: "144.0.7559.96",
      executablePath: cachePath,
      puppeteerVersion: "24.36.0",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "system");
  assert.equal(result.executablePath, systemPath);
  assert.equal(result.compatible, true);
  assert.equal(result.protocolExact, false);
  assert.equal(result.protocolMajorSkew, 7);
});

test("fails closed when every available browser is too old for WhatsApp", async () => {
  const systemPath = path.resolve("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  const result = await resolveWhatsAppBrowserRuntime({
    env: {},
    platform: "darwin",
    homeDirectory: "/fake/home",
    existsSync: (candidate) => candidate === systemPath,
    inspectVersion: async () => "Google Chrome 148.0.7922.140",
    puppeteerInfo: {
      expectedRevision: "144.0.7559.96",
      executablePath: "/missing/cache/chrome",
      puppeteerVersion: "24.36.0",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "supported_browser_not_found");
  assert.equal(
    result.rejected.some((candidate) => candidate.reason === "browser_too_old"),
    true
  );
});

test("an explicit old browser requires the emergency opt-in escape hatch", async () => {
  const explicitPath = path.resolve("/custom/chrome");
  const shared = {
    platform: "linux",
    existsSync: (candidate) => candidate === explicitPath,
    inspectVersion: async () => "Chromium 148.0.0.0",
    puppeteerInfo: {
      expectedRevision: "144.0.7559.96",
      executablePath: "/missing/cache/chrome",
      puppeteerVersion: "24.36.0",
    },
  };

  assert.equal(
    (await resolveWhatsAppBrowserRuntime({
      ...shared,
      env: { GROOVY_WHATSAPP_CHROME_PATH: explicitPath },
    })).ok,
    false
  );
  const allowed = await resolveWhatsAppBrowserRuntime({
    ...shared,
    env: {
      GROOVY_WHATSAPP_CHROME_PATH: explicitPath,
      GROOVY_WHATSAPP_ALLOW_OLD_BROWSER: "1",
    },
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.compatible, false);
  assert.equal(allowed.mismatchAllowed, true);
});
