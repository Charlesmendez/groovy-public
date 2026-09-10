import assert from "node:assert/strict";
import test from "node:test";
import { buildPowerEfficientPuppeteerOptions } from "./platform/whatsapp/browserRuntime.mjs";
import {
  resolveInboundPollIntervalMs,
  resolveWhatsAppImageBlocking,
  resolveWhatsAppResourceMonitorPolicy,
} from "./platform/whatsapp/powerPolicy.mjs";

test("restores Chromium background throttling and keeps hardware acceleration enabled", () => {
  const options = buildPowerEfficientPuppeteerOptions({
    executablePath: "/browser/chrome",
    headless: "new",
  });
  assert.deepEqual(options.ignoreDefaultArgs, [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ]);
  assert.equal(options.args.includes("--disable-gpu"), false);
  assert.equal(options.args.includes("--disable-accelerated-2d-canvas"), false);
  assert.equal(options.args.includes("--use-fake-device-for-media-stream"), false);
  assert.equal(
    options.args.some((arg) => arg.includes("max-old-space-size")),
    false,
    "WhatsApp history sync must not be constrained by a renderer heap cap"
  );
  assert.equal(options.executablePath, "/browser/chrome");
});

test("uses a one-minute inbound fallback poll with bounded overrides", () => {
  assert.equal(resolveInboundPollIntervalMs(undefined), 60_000);
  assert.equal(resolveInboundPollIntervalMs("1000"), 30_000);
  assert.equal(resolveInboundPollIntervalMs("99999999"), 15 * 60_000);
  assert.equal(resolveInboundPollIntervalMs("0"), 0);
});

test("request interception is opt-in and respects explicit options", () => {
  assert.equal(resolveWhatsAppImageBlocking(), false);
  assert.equal(resolveWhatsAppImageBlocking({ envValue: "true" }), true);
  assert.equal(resolveWhatsAppImageBlocking({ option: false, envValue: "true" }), false);
  assert.equal(resolveWhatsAppImageBlocking({ option: true, envValue: "false" }), true);
});

test("resource guards keep the monitor running when time-based recycling is disabled", () => {
  assert.deepEqual(
    resolveWhatsAppResourceMonitorPolicy({
      recycleIntervalMs: 0,
      memoryLimitBytes: 2 * 1024 ** 3,
      cpuLimitPercent: 125,
    }),
    {
      enabled: true,
      timeBasedRecycleEnabled: false,
      resourceGuardsEnabled: true,
      checkIntervalMs: 60_000,
    }
  );
});

test("resource monitor disables only when every recycle and guard is disabled", () => {
  assert.deepEqual(
    resolveWhatsAppResourceMonitorPolicy({
      recycleIntervalMs: 0,
      memoryLimitBytes: 0,
      cpuLimitPercent: 0,
    }),
    {
      enabled: false,
      timeBasedRecycleEnabled: false,
      resourceGuardsEnabled: false,
      checkIntervalMs: 0,
    }
  );
});
