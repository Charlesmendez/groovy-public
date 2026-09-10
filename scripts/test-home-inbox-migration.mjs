// Disposable local PostgreSQL only. Never reads application/production env files.
// HOME_INBOX_TEST_DATABASE_URL=postgresql://.../groovy_inbox_test_* node scripts/test-home-inbox-migration.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
const raw = process.env.HOME_INBOX_TEST_DATABASE_URL;
if (!raw)
  throw new Error("Provide an empty, disposable HOME_INBOX_TEST_DATABASE_URL.");
const url = new URL(raw);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !/^\/groovy_inbox_test_[a-z0-9_]+$/.test(url.pathname)
)
  throw new Error(
    "Only a disposable local groovy_inbox_test_* database is allowed.",
  );
const client = new pg.Client({ connectionString: raw });
await client.connect();
let checks = 0;
async function rejects(query, params, code) {
  await assert.rejects(
    () => client.query(query, params),
    (error) => error.code === code,
  );
  checks++;
}
try {
  const existing = await client.query(
    "select count(*)::int n from information_schema.tables where table_schema in ('public','auth')",
  );
  assert.equal(
    existing.rows[0].n,
    0,
    "Use an empty test database; no existing data is modified.",
  );
  await client.query(`
    create extension if not exists pgcrypto;
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
    end $$;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table public.workspaces(id uuid primary key);
    create table public.orchestrator_profiles(id uuid primary key);
    create table public.orchestrator_sessions(id uuid primary key);
    grant select,update on public.orchestrator_profiles to service_role;
  `);
  await client.query(
    await readFile(
      new URL(
        "../supabase/migrations/20260906130000_home_inbox_decision_consumer.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  checks++;
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  await client.query("insert into auth.users values($1);", [id(1)]);
  await client.query("insert into orchestrator_profiles values($1),($2)", [
    id(2),
    id(3),
  ]);
  const insert =
    "insert into home_inbox_bindings(id,profile_id,owner_user_id,tenant_id,project_id,harness_ref,home_key_enc,home_origin,verified_at) values($1,$2,$3,$4,$5,'retention','encrypted','https://home.datagran.io',now())";
  await client.query(insert, [id(6), id(2), id(1), id(4), id(5)]);
  assert.equal(
    (await client.query("select status from home_inbox_bindings")).rows[0]
      .status,
    "paused",
  );
  checks++;
  await rejects(insert, [id(7), id(3), id(1), id(4), id(5)], "23505");
  await rejects(
    "update home_inbox_bindings set project_id=$1 where id=$2",
    [id(99), id(6)],
    "23514",
  );
  await rejects(
    "update home_inbox_bindings set home_key_enc='changed' where id=$1",
    [id(6)],
    "23514",
  );
  const reserve =
    "insert into home_inbox_decision_runs(id,binding_id,decision_id,claim_key,state,expires_at) values($1,$2,$3,'stable-claim','claiming',now()+interval '10 minutes')";
  await client.query(reserve, [id(10), id(6), id(9)]);
  await rejects(reserve, [id(11), id(6), id(9)], "23505");
  await rejects(
    "update home_inbox_decision_runs set state='running' where id=$1",
    [id(10)],
    "23514",
  );
  await client.query(
    "update home_inbox_decision_runs set state='running',claim_enc='encrypted-claim',profile_snapshot='{}' where id=$1 and state='claiming'",
    [id(10)],
  );
  const lost = await client.query(
    "update home_inbox_decision_runs set state='running' where id=$1 and state='claiming' returning id",
    [id(10)],
  );
  assert.equal(lost.rowCount, 0);
  checks++;
  await rejects(
    "update home_inbox_decision_runs set state='completed' where id=$1",
    [id(10)],
    "23514",
  );
  await client.query(
    `update home_inbox_decision_runs set state='completed',result='{"outcome_key":"keep","summary":null,"usage":null}' where id=$1`,
    [id(10)],
  );
  const uncertain = await client.query(
    "update home_inbox_decision_runs set state='unknown' where id=$1 and state in ('claiming','running') returning id",
    [id(10)],
  );
  assert.equal(uncertain.rowCount, 0);
  checks++;
  for (const role of ["anon", "authenticated"]) {
    await client.query(`set role ${role}`);
    await rejects("select * from home_inbox_bindings", [], "42501");
    await rejects("select * from home_inbox_decision_runs", [], "42501");
    await rejects(
      "update home_inbox_bindings set status='active'",
      [],
      "42501",
    );
    await client.query("reset role");
  }
  await client.query("set role service_role");
  assert.equal(
    (await client.query("select * from home_inbox_decision_runs")).rowCount,
    1,
  );
  checks++;
  await client.query(
    "update home_inbox_bindings set status='revoked' where id=$1",
    [id(6)],
  );
  await rejects(
    "update home_inbox_bindings set status='active' where id=$1",
    [id(6)],
    "23514",
  );
  await rejects(insert, [id(12), id(2), id(1), id(4), id(99)], "23514");
  await client.query(insert, [id(13), id(2), id(1), id(4), id(5)]);
  assert.equal(
    (
      await client.query("select * from home_inbox_decision_runs where id=$1", [
        id(10),
      ])
    ).rowCount,
    1,
  );
  checks++;
  await rejects(
    "delete from home_inbox_bindings where id=$1",
    [id(6)],
    "23503",
  );
  await client.query("reset role");
  // Upgrade with existing completed history and revoked bindings, not only an
  // empty table. Missing historic measurements must stay null.
  await client.query(await readFile(new URL("../supabase/migrations/20260906160000_home_inbox_usage_receipts.sql", import.meta.url), "utf8"));
  assert.equal((await client.query("select usage_receipt from home_inbox_decision_runs where id=$1", [id(10)])).rows[0].usage_receipt, null);
  checks++;
  const accounting = { version: 1, status: "reported", observed_at: new Date().toISOString(), components: [
    { id: "step-1", provider: "synthetic", model: "brain", input_tokens: 100, output_tokens: 20, cached_input_tokens: 50, cache_write_input_tokens: 0, provider_cost_usd: 0.01 },
    { id: "step-2", provider: "synthetic", model: "helper", input_tokens: 20, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, provider_cost_usd: null },
  ] };
  await client.query("update home_inbox_decision_runs set usage_receipt=$2 where id=$1", [id(10), accounting]);
  const report = async (tenant = id(4), project = id(5), origin = "https://home.datagran.io") =>
    (await client.query("select home_inbox_usage_report($1,$2,$3,now()-interval '1 day',now()+interval '1 day') result", [tenant, project, origin])).rows[0].result;
  assert.deepEqual(await report(), { records: 1, input_tokens: 120, output_tokens: 25, cached_input_tokens: 50, known_cost_micros: 10000, unmetered_records: 0, unpriced_records: 1 }); checks++;
  for (const args of [[id(99),id(5)],[id(4),id(99)],[id(4),id(5),"https://other.test"]]) { assert.equal((await report(...args)).records, 0); checks++; }
  await rejects("update home_inbox_decision_runs set usage_receipt='{}' where id=$1", [id(10)], "23514");
  await client.query("set role authenticated");
  await rejects("select home_inbox_usage_report($1,$2,$3,now()-interval '1 day',now())", [id(4),id(5),"https://home.datagran.io"], "42501");
  await client.query("reset role");
  console.log(
    `${checks} migration/state/privacy checks passed. Test history retained in disposable database.`,
  );
} finally {
  await client.end();
}
