import { strict as assert } from "node:assert";
import test from "node:test";
import { filterExternalHarnessOutput } from "./outputFilter";
import {
  hashHarnessApiKey,
  PublicApiAuthError,
  resolveHarnessRequestOrigin,
} from "./auth";

test("API keys are deterministically SHA-256 hashed", () => {
  assert.equal(hashHarnessApiKey("key"), hashHarnessApiKey("key"));
  assert.equal(hashHarnessApiKey("key").length, 64);
});

test("signed internal storage URLs are removed from public output", () => {
  const filtered = filterExternalHarnessOutput(
    "Download https://example.supabase.co/storage/v1/object/sign/wiki/a.pdf?token=secret now",
  );
  assert.equal(filtered.includes("token=secret"), false);
  assert.equal(filtered.includes("[private file link omitted]"), true);
});

test("cross-origin browser requests cannot spoof an allowed widget parent", () => {
  const request = new Request("https://groovy.example/api/v1/harnesses/support/threads", {
    headers: {
      Origin: "https://attacker.example",
      "X-Harness-Origin": "https://allowed.example",
    },
  });
  assert.throws(
    () => resolveHarnessRequestOrigin(request),
    (error) =>
      error instanceof PublicApiAuthError &&
      error.status === 403 &&
      error.code === "origin_mismatch",
  );
});

test("same-origin widget calls use their CSP-bound parent origin claim", () => {
  const request = new Request("https://groovy.example/api/v1/harnesses/support/threads", {
    headers: {
      Origin: "https://groovy.example",
      "X-Harness-Origin": "https://allowed.example",
    },
  });
  assert.equal(
    resolveHarnessRequestOrigin(request).requestOrigin,
    "https://allowed.example",
  );
});
