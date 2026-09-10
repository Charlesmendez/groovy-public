import assert from "node:assert/strict";
import test from "node:test";
import { jsonError } from "./auth";

test("email API errors preserve upstream rate-limit status", async () => {
  const response = jsonError(
    Object.assign(new Error("Rate limit exceeded"), {
      status: 429,
      retryAfterMs: 7_000,
    }),
    "Could not load email.",
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "7");
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "Rate limit exceeded",
  });
});

test("email API errors preserve ordinary server failures", () => {
  assert.equal(jsonError(new Error("Database failed"), "Fallback").status, 500);
  assert.equal(
    jsonError(
      Object.assign(new Error("Upstream unavailable"), { status: 503 }),
      "Fallback",
    ).status,
    503,
  );
});
