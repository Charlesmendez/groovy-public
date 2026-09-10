// Offline cross-repository parity check. Uses actual Home query/projection code
// and synthetic records; never imports a DB repository or makes network calls.
// Run with a TypeScript import loader and the local Home checkout as argv[2].
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

if (!process.argv[2])
  throw new Error("Provide the local Home source directory.");
const home = await import(
  pathToFileURL(resolve(process.argv[2], "lib/platform/data-read-contracts.ts"))
    .href
);
const groovy = await import("../src/lib/homeInbox/dataContracts.ts");
const definition = {
  provider: "salesforce",
  object: "ClientRecord__c",
  fields: ["Id", "State__c"],
  filters: [
    { field: "Project__c", source: "fixed", value: "synthetic-project" },
    {
      field: "Customer__c",
      source: "parameter",
      name: "customer",
      type: "string",
      description: "Client-defined customer reference",
    },
  ],
  limit: 2,
};
const operation = {
  id: "80000000-0000-4000-8000-000000000008",
  name: "Client read",
  description: "Synthetic cross-contract verification",
  definition,
};

test("Groovy consumes Home's actual operation description without connection secrets or fixed filters", () => {
  const described = home.describeDataReadOperation(operation);
  assert.deepEqual(groovy.homeDataOperation.parse(described), described);
  assert.equal("filters" in described, false);
  assert.equal("connection_id" in described, false);
  assert.deepEqual(
    groovy.homeDataCatalog.parse({
      operations: [described],
      next_cursor: null,
      readiness: "local_grants_only",
    }).operations,
    [described],
  );
});

test("Groovy typed parameters compile through Home's actual immutable definition", () => {
  const input = groovy.homeDataReadInput.parse({
    operation_id: operation.id,
    parameters: { customer: "synthetic-person" },
  });
  assert.equal(
    home.compileDataReadQuery(definition, input.parameters),
    "SELECT Id, State__c FROM ClientRecord__c WHERE Project__c = 'synthetic-project' AND Customer__c = 'synthetic-person' LIMIT 2",
  );
  assert.throws(() =>
    home.compileDataReadQuery(definition, {
      ...input.parameters,
      project: "another-project",
    }),
  );
});

test("Groovy accepts Home's projected observations including empty and incomplete results", () => {
  for (const providerResult of [
    { done: true, records: [] },
    {
      done: false,
      records: [
        { Id: "synthetic", State__c: null, Private__c: "must-not-cross" },
      ],
    },
    {
      done: true,
      records: [
        { Id: "one", State__c: "x" },
        { Id: "two", State__c: "y" },
      ],
    },
  ]) {
    const projected = home.projectDataReadResult(definition, providerResult);
    const result = {
      operation_id: operation.id,
      ...projected,
      observed_at: "2026-09-06T12:00:00.000Z",
    };
    assert.deepEqual(groovy.homeDataResult.parse(result), result);
    assert.equal(JSON.stringify(result).includes("must-not-cross"), false);
    assert.equal(
      projected.limit_reached,
      !providerResult.done || providerResult.records.length === 2,
    );
  }
});
