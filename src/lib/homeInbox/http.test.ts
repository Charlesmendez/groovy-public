import assert from "node:assert/strict";
import test from "node:test";
import { bindingBody, bindingResponseError } from "./http";
import { HomeInboxError } from "./contracts";

test("binding body rejects extra authority, truncated JSON and oversized secrets", async () => {
  const request = (body: string) =>
    new Request("https://groovy.example/settings", { method: "POST", body });
  assert.deepEqual(
    await bindingBody(request('{"status":"paused"}'), ["status"]),
    { status: "paused" },
  );
  for (const body of [
    '{"status":"active","owner_user_id":"other"}',
    '{"status":',
    "[]",
    "null",
    '{"status":"' + "a".repeat(17_000) + '"}',
  ])
    await assert.rejects(() => bindingBody(request(body), ["status"]));
});
test("unexpected database or upstream errors are redacted", async () => {
  const response = bindingResponseError(
    new Error("secret-credential body=email@example.com"),
  );
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("secret"));
  const known = bindingResponseError(
    new HomeInboxError("profile_admin_required", "Admin required", 403),
  );
  assert.equal(known.status, 403);
  assert.equal(known.headers.get("cache-control"), "no-store");
});
