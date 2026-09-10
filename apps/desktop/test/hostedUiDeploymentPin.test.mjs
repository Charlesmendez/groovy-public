import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  VERCEL_DEPLOYMENT_PIN_COOKIE,
  clearHostedUiDeploymentPin,
} = require("../dist/main/hostedUiDeploymentPin.js");

test("removes Vercel's persistent deployment pin for the hosted origin", async () => {
  const removals = [];
  const cookies = {
    async remove(url, name) {
      removals.push({ url, name });
    },
  };

  await clearHostedUiDeploymentPin(cookies, "https://www.gogroovy.ai");

  assert.deepEqual(removals, [
    {
      url: "https://www.gogroovy.ai/",
      name: VERCEL_DEPLOYMENT_PIN_COOKIE,
    },
  ]);
});

test("rejects an invalid hosted origin before touching cookies", async () => {
  let removeCalled = false;
  const cookies = {
    async remove() {
      removeCalled = true;
    },
  };

  await assert.rejects(
    clearHostedUiDeploymentPin(cookies, "not a url"),
    /Invalid URL/
  );
  assert.equal(removeCalled, false);
});
