import assert from "node:assert/strict";
import test from "node:test";
import {
  executeDirectPostgresSql,
  extractDirectPostgresSql,
} from "./postgresDirect";

test("extractDirectPostgresSql accepts raw and fenced DML", () => {
  assert.equal(
    extractDirectPostgresSql('SELECT "Symbol" FROM trades LIMIT 50;'),
    'SELECT "Symbol" FROM trades LIMIT 50;',
  );
  assert.equal(
    extractDirectPostgresSql("```sql\nUPDATE trades SET \"Actual Cost\" = 10 WHERE id = 7;\n```"),
    'UPDATE trades SET "Actual Cost" = 10 WHERE id = 7;',
  );
});

test("extractDirectPostgresSql leaves natural-language requests to the data agent", () => {
  assert.equal(
    extractDirectPostgresSql("Find recent trades and summarize the result."),
    null,
  );
  assert.equal(extractDirectPostgresSql("DROP TABLE trades;"), null);
});

test("executeDirectPostgresSql retries a rejected stored key with the server key", async () => {
  const calls: Array<{ url: string; key: string; body: string }> = [];
  const fetchImpl = async (url: URL | RequestInfo, init?: RequestInit) => {
    const key = String((init?.headers as Record<string, string>)["x-api-key"]);
    calls.push({
      url: String(url),
      key,
      body: String(init?.body || ""),
    });
    if (key === "stale") {
      return new Response('{"error":"invalid api key"}', { status: 401 });
    }
    return new Response('{"rows":[{"id":1}]}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await executeDirectPostgresSql({
    apiKeys: ["stale", "current"],
    connectionId: "connection-1",
    sql: "SELECT id FROM trades LIMIT 1;",
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(result.ok, true);
  assert.equal(result.usedApiKeyIndex, 1);
  assert.deepEqual(result.data, { rows: [{ id: 1 }] });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /connection_id=connection-1/);
  assert.deepEqual(JSON.parse(calls[1].body), {
    sql: "SELECT id FROM trades LIMIT 1;",
    params: [],
  });
});
