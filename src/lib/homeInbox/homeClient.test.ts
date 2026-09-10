import assert from "node:assert/strict";
import test from "node:test";
import { createHomeInboxClient, homeInboxOrigin } from "./homeClient";
import { claim, decisionId, ids, item } from "./fixtures.test-support";

test("gateway pins server origin, project scope, key and original receipt token", async () => {
  const requests: Record<string, unknown>[] = [];
  const client = createHomeInboxClient(ids, "fake-project-secret", (async (
    url,
    init,
  ) => {
    assert.equal(url, `${homeInboxOrigin()}/api/platform/tools/invoke`);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer fake-project-secret",
    );
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    assert.equal(body.tenant_id, ids.tenantId);
    assert.equal(body.project_id, ids.projectId);
    const data = body.capability.endsWith("list")
      ? { items: [item] }
      : body.capability.endsWith("claim")
        ? claim()
        : {
            decision_id: decisionId,
            recorded: true,
            replay: false,
            applied: true,
          };
    return Response.json({
      ok: true,
      invocation_id: body.invocation_id,
      receipt: {
        tenant_id: ids.tenantId,
        project_id: ids.projectId,
        capability: body.capability,
      },
      data,
    });
  }) as typeof fetch);
  assert.deepEqual(await client.list(1), [item]);
  assert.equal(
    (await client.claim(decisionId, "stable-claim-key")).execute,
    true,
  );
  const result = { outcome_key: "keep", summary: null, usage: null };
  await client.complete(decisionId, claim().claim_token, result);
  await client.complete(decisionId, claim().claim_token, result);
  assert.equal(requests[1].idempotency_key, "stable-claim-key");
  assert.equal(requests[2].idempotency_key, requests[3].idempotency_key);
  assert.deepEqual(requests[2].input, {
    harness_ref: ids.harnessRef,
    decision_id: decisionId,
    claim_token: claim().claim_token,
    result,
  });
});
test("lost HTTP acknowledgement is not automatically retried and does not leak upstream errors", async () => {
  let calls = 0;
  const client = createHomeInboxClient(ids, "fake", (async () => {
    calls++;
    throw new Error("private token=secret");
  }) as typeof fetch);
  await assert.rejects(
    () => client.claim(decisionId, "stable-key"),
    (error: Error) =>
      !error.message.includes("secret") && /acknowledge/.test(error.message),
  );
  assert.equal(calls, 1);
});
test("wrong outer receipt blocks valid-looking customer input", async () => {
  const client = createHomeInboxClient(ids, "fake", (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      ok: true,
      invocation_id: body.invocation_id,
      receipt: {
        tenant_id: ids.tenantId,
        project_id: decisionId,
        capability: body.capability,
      },
      data: claim(),
    });
  }) as typeof fetch);
  await assert.rejects(() => client.claim(decisionId, "stable-key"));
});
test("bad list limit and a changed Home origin fail without sending a credential", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return Response.json({});
  }) as typeof fetch;
  assert.throws(() =>
    createHomeInboxClient(ids, "fake", fetcher, "https://another.example"),
  );
  const client = createHomeInboxClient(ids, "fake", fetcher);
  for (const limit of [0, 51, 1.5, NaN])
    await assert.rejects(() => client.list(limit));
  assert.equal(calls, 0);
});
