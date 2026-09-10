import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ERR_ABORTED,
  HostedPageRecovery,
  hostedPageRecoveryDelayMs,
  hostedPageRecoveryUrl,
  isHostedPageUrl,
  shouldRecoverFailedLoad,
  shouldRecoverUnexpectedPage,
} = require("../dist/main/hostedPageRecovery.js");

test("recovers only failed main-frame navigations that were not aborted", () => {
  assert.equal(shouldRecoverFailedLoad(-105, true), true);
  assert.equal(shouldRecoverFailedLoad(ERR_ABORTED, true), false);
  assert.equal(shouldRecoverFailedLoad(-105, false), false);
});

test("uses bounded exponential-style recovery delays", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 100].map(hostedPageRecoveryDelayMs),
    [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000]
  );
});

test("preserves an app route but rejects Chromium and foreign origins", () => {
  const origin = "https://www.gogroovy.ai";
  const fallback = origin + "/";
  assert.equal(isHostedPageUrl(origin + "/chat/channel-1", origin), true);
  assert.equal(isHostedPageUrl("chrome-error://chromewebdata/", origin), false);
  assert.equal(
    hostedPageRecoveryUrl(origin + "/chat/channel-1", origin, fallback),
    origin + "/chat/channel-1"
  );
  assert.equal(
    hostedPageRecoveryUrl("chrome-error://chromewebdata/", origin, fallback),
    fallback
  );
  assert.equal(
    hostedPageRecoveryUrl("https://example.com/", origin, fallback),
    fallback
  );
});

test("recovers a completed Chromium error page but not startup or active loads", () => {
  const origin = "https://www.gogroovy.ai";
  assert.equal(
    shouldRecoverUnexpectedPage("chrome-error://chromewebdata/", origin, false),
    true
  );
  assert.equal(
    shouldRecoverUnexpectedPage("https://example.com/", origin, false),
    true
  );
  assert.equal(
    shouldRecoverUnexpectedPage(origin + "/chat/channel-1", origin, false),
    false
  );
  assert.equal(shouldRecoverUnexpectedPage("about:blank", origin, false), false);
  assert.equal(
    shouldRecoverUnexpectedPage("chrome-error://chromewebdata/", origin, true),
    false
  );
});

test("coalesces duplicate failures and resets backoff after success", async () => {
  const scheduled = [];
  const recovered = [];
  const recovery = new HostedPageRecovery({
    recover: async () => recovered.push("recovered"),
    schedule: (callback, delayMs) => {
      const handle = { callback, delayMs, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    cancel: (handle) => {
      handle.cancelled = true;
    },
  });

  recovery.noteFailure("first");
  recovery.noteFailure("duplicate");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 1_000);

  scheduled[0].callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(recovered, ["recovered"]);

  recovery.noteFailure("after success");
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].delayMs, 1_000);
  recovery.dispose();
});

test("retries a failed recovery with increasing backoff", async () => {
  const scheduled = [];
  let attempts = 0;
  const recovery = new HostedPageRecovery({
    recover: async () => {
      attempts += 1;
      throw new Error("offline");
    },
    schedule: (callback, delayMs) => {
      const handle = { callback, delayMs, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    cancel: (handle) => {
      handle.cancelled = true;
    },
  });

  recovery.noteFailure("offline");
  scheduled[0].callback();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(attempts, 1);
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].delayMs, 2_000);
  recovery.dispose();
});
