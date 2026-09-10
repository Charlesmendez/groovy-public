import assert from "node:assert/strict";
import { test } from "node:test";
import { groovyUsageReport, usageWindowSchema } from "./reporting";
const input = {
  tenant_id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
  from: "2026-09-01T00:00:00Z",
  to: "2026-09-07T00:00:00Z",
};
const totals = {
  records: 2,
  input_tokens: 50,
  output_tokens: 10,
  cached_input_tokens: null,
  known_cost_micros: 4000,
  unmetered_records: 1,
  unpriced_records: 1,
};
test("queries exact immutable Home origin and project; returns accounting metadata only", async () => {
  const report = await groovyUsageReport(input, {
    homeOrigin: "https://home.example.test",
    query: async (args) => {
      assert.deepEqual(args, {
        p_tenant: input.tenant_id,
        p_project: input.project_id,
        p_origin: "https://home.example.test",
        p_from: input.from,
        p_to: input.to,
      });
      return { data: totals, error: null };
    },
  });
  assert.deepEqual(report.totals, totals);
  assert.equal(report.scope.product_key, "groovy");
});
test("rejects provider failure and private/invalid accounting projections", async () => {
  for (const result of [
    { error: {}, data: null },
    { error: null, data: { ...totals, prompt: "private" } },
    { error: null, data: { ...totals, unpriced_records: 3 } },
  ])
    await assert.rejects(
      groovyUsageReport(input, {
        homeOrigin: "https://home.example.test",
        query: async () => result,
      }),
    );
});
test("requires both scope IDs, bounded dates, and no caller-selected origin", () => {
  for (const value of [
    { ...input, project_id: "" },
    { ...input, origin: "https://other.test" },
    { ...input, to: input.from },
    { ...input, from: "2025-01-01T00:00:00Z" },
  ])
    assert.equal(usageWindowSchema.safeParse(value).success, false);
});
