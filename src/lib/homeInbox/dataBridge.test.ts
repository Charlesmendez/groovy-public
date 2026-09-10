import assert from "node:assert/strict";
import test from "node:test";
import { createHomeDataBridge } from "./dataBridge";
import { homeInboxOrigin } from "./homeClient";
import { ids, now } from "./fixtures.test-support";

const operation = {
  id: "80000000-0000-4000-8000-000000000008",
  name: "Client-selected lookup",
  description: "Read the fields chosen by this project's admin.",
  provider: "salesforce",
  effect: "read",
  parameters: [
    {
      name: "customer",
      type: "string",
      description: "Client CRM reference",
      required: true,
    },
  ],
  fields: ["Id", "State__c"],
  max_records: 2,
};
const catalog = () => ({
  operations: [structuredClone(operation)],
  next_cursor: null,
  readiness: "local_grants_only",
});
const observation = () => ({
  operation_id: operation.id,
  records: [{ Id: "synthetic-record", State__c: "client-state" }],
  limit_reached: false,
  observed_at: new Date(now).toISOString(),
});
const readInput = () => ({
  operation_id: operation.id,
  parameters: { customer: "synthetic-customer" },
});
function fixture() {
  const controller = new AbortController();
  const requests: Array<Record<string, unknown>> = [];
  let authorizeCalls = 0;
  let clock = now;
  const handlers = {
    authorize: async () => {},
    data: (capability: string): unknown =>
      capability.endsWith("list") ? catalog() : observation(),
    response: (envelope: Record<string, unknown>): Response =>
      Response.json(envelope),
  };
  const scope = { ...ids };
  const bridge = createHomeDataBridge({
    scope,
    key: "synthetic-project-key",
    origin: homeInboxOrigin(),
    signal: controller.signal,
    deadlineAt: now + 180_000,
    now: () => clock,
    authorize: async () => {
      authorizeCalls++;
      await handlers.authorize();
    },
    fetcher: (async (url, init) => {
      assert.equal(url, `${homeInboxOrigin()}/api/platform/tools/invoke`);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer synthetic-project-key",
      );
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      assert.equal(body.tenant_id, ids.tenantId);
      assert.equal(body.project_id, ids.projectId);
      return handlers.response({
        invocation_id: body.invocation_id,
        ok: true,
        error: null,
        data: handlers.data(body.capability),
        receipt: {
          tenant_id: ids.tenantId,
          project_id: ids.projectId,
          capability: body.capability,
          completed_at: new Date(now).toISOString(),
        },
      });
    }) as typeof fetch,
  });
  return {
    bridge,
    handlers,
    controller,
    requests,
    scope,
    authorizeCalls: () => authorizeCalls,
    advance: () => {
      clock += 180_001;
    },
  };
}

test("discovers granted operations then reads exact typed inputs with fixed scope, receipts and fresh authorization", async () => {
  const f = fixture();
  f.scope.projectId = operation.id;
  assert.deepEqual(
    await f.bridge.execute("home_data_operations", {}),
    catalog(),
  );
  assert.deepEqual(
    await f.bridge.execute("home_data_read", readInput()),
    observation(),
  );
  assert.equal(f.authorizeCalls(), 4);
  assert.deepEqual(f.requests[1].input, readInput());
  assert.doesNotThrow(f.bridge.assertHealthy);
});

test("operation pagination is explicit; later-page operations can be invoked", async () => {
  const f = fixture();
  f.handlers.data = () => ({ ...catalog(), next_cursor: operation.id });
  const first = await f.bridge.execute("home_data_operations", { limit: 1 });
  assert.equal((first as { next_cursor: string }).next_cursor, operation.id);
  const second = { ...operation, id: "90000000-0000-4000-8000-000000000009" };
  f.handlers.data = () => ({ ...catalog(), operations: [second] });
  await f.bridge.execute("home_data_operations", { after: operation.id });
  f.handlers.data = () => ({ ...observation(), operation_id: second.id });
  await f.bridge.execute("home_data_read", {
    ...readInput(),
    operation_id: second.id,
  });
});

test("unknown operation, arbitrary cursor and extra authority fail before network access", async () => {
  for (const [tool, input] of [
    ["home_data_read", readInput()],
    ["home_data_operations", { after: operation.id }],
    ["home_data_operations", { tenant_id: operation.id }],
    ["home_data_operations", { url: "https://other.example" }],
    ["data_query", { query: "UPDATE" }],
    ["schedule_create", {}],
  ] as const) {
    const f = fixture();
    await assert.rejects(() => f.bridge.execute(tool, input));
    assert.equal(f.requests.length, 0);
    assert.throws(f.bridge.assertHealthy);
  }
});

test("missing, wrong-type, oversized and extra parameters never reach Home", async () => {
  for (const parameters of [
    {},
    { customer: 4 },
    { customer: "" },
    { customer: "x\n" },
    { customer: "x".repeat(1025) },
    { customer: "x", query: "SELECT" },
    { customer: "x", project_id: ids.projectId },
  ]) {
    const f = fixture();
    await f.bridge.execute("home_data_operations", {});
    await assert.rejects(() =>
      f.bridge.execute("home_data_read", {
        operation_id: operation.id,
        parameters,
      }),
    );
    assert.equal(f.requests.length, 1);
  }
});

test("every outer receipt identity and authority field is validated", async () => {
  const mutations: Array<(envelope: Record<string, unknown>) => void> = [
    (e) => {
      e.invocation_id = operation.id;
    },
    (e) => {
      e.ok = false;
    },
    (e) => {
      e.error = { secret: "private" };
    },
    (e) => {
      e.extra = "authority";
    },
    ...["tenant_id", "project_id", "capability", "completed_at"].map(
      (field) => (e: Record<string, unknown>) => {
        (e.receipt as Record<string, unknown>)[field] = "wrong";
      },
    ),
    (e) => {
      (e.receipt as Record<string, unknown>).actor = "override";
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    f.handlers.response = (e) => {
      mutate(e);
      return Response.json(e);
    };
    await assert.rejects(() => f.bridge.execute("home_data_operations", {}));
    assert.throws(f.bridge.assertHealthy);
  }
});

test("catalog rejects writes, unsupported providers, private extra fields and duplicate schema entries", async () => {
  for (const patch of [
    { effect: "write" },
    { provider: "unverified-database" },
    { connection_id: "secret" },
    { fields: ["Id", "id"] },
    { parameters: [...operation.parameters, ...operation.parameters] },
    { parameters: [{ ...operation.parameters[0], name: "constructor" }] },
    { max_records: 51 },
  ]) {
    const f = fixture();
    f.handlers.data = () => ({
      ...catalog(),
      operations: [{ ...operation, ...patch }],
    });
    await assert.rejects(() => f.bridge.execute("home_data_operations", {}));
  }
});

test("catalog bounds, invalid cursors and changed immutable definitions fail closed", async () => {
  for (const value of [
    { ...catalog(), operations: [operation, operation] },
    { ...catalog(), next_cursor: ids.tenantId },
    { ...catalog(), operations: [], next_cursor: operation.id },
    { ...catalog(), readiness: "provider_verified" },
  ]) {
    const f = fixture();
    f.handlers.data = () => value;
    await assert.rejects(() => f.bridge.execute("home_data_operations", {}));
  }
  const f = fixture();
  await f.bridge.execute("home_data_operations", {});
  f.handlers.data = () => ({
    ...catalog(),
    operations: [{ ...operation, fields: ["Private__c"] }],
  });
  await assert.rejects(() => f.bridge.execute("home_data_operations", {}));
});

test("read results reject wrong operations, unapproved fields, nested values and invalid observation metadata", async () => {
  for (const patch of [
    { operation_id: ids.tenantId },
    { records: [{ Id: "x" }] },
    { records: [{ Id: "x", State__c: "x", Private__c: "secret" }] },
    { records: [{ Id: "x", State__c: { nested: "secret" } }] },
    { records: Array(3).fill({ Id: "x", State__c: "x" }) },
    { observed_at: "unknown" },
    { limit_reached: "false" },
    { actions: [] },
  ]) {
    const f = fixture();
    await f.bridge.execute("home_data_operations", {});
    f.handlers.data = () => ({ ...observation(), ...patch });
    await assert.rejects(() => f.bridge.execute("home_data_read", readInput()));
    assert.throws(f.bridge.assertHealthy);
  }
});

test("empty success and incomplete results remain distinct from unavailable reads", async () => {
  for (const result of [
    { ...observation(), records: [] },
    { ...observation(), limit_reached: true },
  ]) {
    const f = fixture();
    await f.bridge.execute("home_data_operations", {});
    f.handlers.data = () => result;
    assert.deepEqual(
      await f.bridge.execute("home_data_read", readInput()),
      result,
    );
  }
  for (const status of [401, 403, 404, 409, 429, 500, 503]) {
    const f = fixture();
    f.handlers.response = () =>
      new Response("private-provider-error", { status });
    await assert.rejects(
      () => f.bridge.execute("home_data_operations", {}),
      (e: Error) => !e.message.includes("private-provider-error"),
    );
    assert.throws(f.bridge.assertHealthy);
    assert.equal(f.requests.length, 1);
  }
});

test("revocation before a read prevents it; revocation after a response suppresses records", async () => {
  for (const late of [false, true]) {
    const f = fixture();
    await f.bridge.execute("home_data_operations", {});
    f.handlers.authorize = async () => {
      if (!late || f.authorizeCalls() === 4)
        throw new Error("private-owner-lookup");
    };
    await assert.rejects(
      () => f.bridge.execute("home_data_read", readInput()),
      (e: Error) => !e.message.includes("private-owner"),
    );
    assert.equal(f.requests.length, late ? 2 : 1);
    assert.throws(f.bridge.assertHealthy);
  }
});

test("deadline and cancellation stop reads and final decisions", async () => {
  for (const mode of ["before", "late", "abort"] as const) {
    const f = fixture();
    if (mode === "before") f.advance();
    if (mode === "abort") f.controller.abort();
    if (mode === "late")
      f.handlers.data = () => {
        f.advance();
        return catalog();
      };
    await assert.rejects(() => f.bridge.execute("home_data_operations", {}));
    assert.throws(f.bridge.assertHealthy);
    assert.equal(f.requests.length, mode === "late" ? 1 : 0);
  }
});

test("lost acknowledgements and malformed bodies are held without automatic retries", async () => {
  for (const response of [
    () => {
      throw new Error("secret-network-error");
    },
    () => new Response("bad json"),
    () => new Response("x".repeat(600 * 1024)),
  ]) {
    const f = fixture();
    f.handlers.response = response;
    await assert.rejects(() => f.bridge.execute("home_data_operations", {}));
    await assert.rejects(() => f.bridge.execute("home_data_operations", {}));
    assert.equal(f.requests.length, 1);
  }
});

test("parallel tool calls share a budget and cannot turn a failed read into a healthy decision", async () => {
  const f = fixture();
  const results = await Promise.allSettled(
    Array.from({ length: 13 }, () =>
      f.bridge.execute("home_data_operations", {}),
    ),
  );
  assert.ok(results.every((r) => r.status === "rejected"));
  assert.equal(f.requests.length, 0);
  assert.throws(f.bridge.assertHealthy);
});

test("explicit repeated reads have different invocation IDs and preserve each observation", async () => {
  const f = fixture();
  await f.bridge.execute("home_data_operations", {});
  await f.bridge.execute("home_data_read", readInput());
  f.handlers.data = () => ({
    ...observation(),
    records: [],
    observed_at: new Date(now + 1_000).toISOString(),
  });
  const second = await f.bridge.execute("home_data_read", readInput());
  assert.notEqual(f.requests[1].invocation_id, f.requests[2].invocation_id);
  assert.notEqual(f.requests[1].idempotency_key, f.requests[2].idempotency_key);
  assert.deepEqual((second as { records: unknown[] }).records, []);
});

test("client-defined number, boolean and parameter-free operations keep their declared types", async () => {
  for (const [parameters, values] of [
    [[], {}],
    [
      [
        {
          name: "amount",
          type: "number",
          description: "Client amount",
          required: true,
        },
        {
          name: "active",
          type: "boolean",
          description: "Client flag",
          required: true,
        },
      ],
      { amount: 0, active: false },
    ],
  ] as const) {
    const f = fixture();
    f.handlers.data = () => ({
      ...catalog(),
      operations: [{ ...operation, parameters }],
    });
    await f.bridge.execute("home_data_operations", {});
    f.handlers.data = () => observation();
    await f.bridge.execute("home_data_read", {
      operation_id: operation.id,
      parameters: values,
    });
    assert.deepEqual(
      (f.requests[1].input as { parameters: unknown }).parameters,
      values,
    );
  }
});

test("total data budget applies across individually bounded successful responses", async () => {
  const f = fixture();
  const fields = Array.from({ length: 16 }, (_, i) => `Field${i}__c`);
  f.handlers.data = () => ({
    ...catalog(),
    operations: [{ ...operation, fields }],
  });
  await f.bridge.execute("home_data_operations", {});
  f.handlers.data = () => ({
    ...observation(),
    records: Array.from({ length: 2 }, () =>
      Object.fromEntries(fields.map((field) => [field, "x".repeat(16_384)])),
    ),
    limit_reached: true,
  });
  await f.bridge.execute("home_data_read", readInput());
  await assert.rejects(() => f.bridge.execute("home_data_read", readInput()));
  assert.throws(f.bridge.assertHealthy);
});

test("returned catalog objects cannot mutate the run's approved field snapshot", async () => {
  const f = fixture();
  const discovered = (await f.bridge.execute(
    "home_data_operations",
    {},
  )) as ReturnType<typeof catalog>;
  discovered.operations[0].fields.push("Private__c");
  f.handlers.data = () => ({
    ...observation(),
    records: [{ ...observation().records[0], Private__c: "not-approved" }],
  });
  await assert.rejects(() => f.bridge.execute("home_data_read", readInput()));
});
