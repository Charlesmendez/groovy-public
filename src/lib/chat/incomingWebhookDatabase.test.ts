import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client, Pool } from "pg";

// Opt-in integration check. Only connects to local PostgreSQL and creates its
// own disposable database, never any application tables in an existing DB.
const databaseUrl = process.env.WEBHOOK_TEST_DATABASE_URL;
test(
  "incoming webhook SQL enforces delivery, isolation, retries, revocation, and quotas",
  { skip: !databaseUrl },
  async () => {
    const url = new URL(databaseUrl!);
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
      "Use an isolated local PostgreSQL server",
    );
    const root = new Client({ connectionString: url.toString() });
    await root.connect();
    const database = `groovy_webhook_test_${randomUUID().replaceAll("-", "")}`;
    await root.query(`create database ${database}`);
    url.pathname = `/${database}`;
    const pool = new Pool({ connectionString: url.toString(), max: 8 });
    try {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const found = await root.query(
          "select 1 from pg_roles where rolname = $1",
          [role],
        );
        if (!found.rowCount) await root.query(`create role ${role}`);
      }
      await pool.query(`
      create extension if not exists pgcrypto;
      create schema auth;
      create table auth.users(id uuid primary key);
      create table public.workspaces(id uuid primary key);
      create table public.workspace_members(workspace_id uuid, user_id uuid, role text);
      create table public.chat_channels(id uuid primary key, workspace_id uuid, kind text, is_archived boolean default false, created_by uuid);
      create table public.chat_messages(id uuid primary key default gen_random_uuid(), channel_id uuid references chat_channels(id), author_type text, author_user_id uuid, author_agent_id uuid, content text check (char_length(content) between 1 and 40000), metadata jsonb default '{}', created_at timestamptz default now(), check(author_agent_id is null and ((author_type = 'system' and author_user_id is null) or (author_type = 'user' and author_user_id is not null))));
    `);
      await pool.query(
        await readFile(
          new URL(
            "../../../supabase/migrations/20260905010000_channel_incoming_webhooks.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const user = randomUUID(),
        workspace = randomUUID(),
        channel = randomUUID(),
        hook = randomUUID();
      const hash = "a".repeat(64),
        otherHash = "b".repeat(64);
      await pool.query("insert into auth.users values ($1)", [user]);
      await pool.query("insert into workspaces values ($1)", [workspace]);
      await pool.query("insert into workspace_members values ($1,$2,'admin')", [
        workspace,
        user,
      ]);
      await pool.query(
        "insert into chat_channels(id,workspace_id,kind,created_by) values($1,$2,'channel',$3)",
        [channel, workspace, user],
      );
      await pool.query(
        "insert into chat_incoming_webhooks(id,workspace_id,channel_id,created_by,name,token_hash,token_enc) values($1,$2,$3,$4,'Build bot',$5,'encrypted')",
        [hook, workspace, channel, user, hash],
      );
      const deliver = async (
        text: string,
        key: string | null = null,
        token = hash,
      ) =>
        (
          await pool.query(
            "select deliver_chat_incoming_webhook($1,$2,$3) as receipt",
            [token, text, key],
          )
        ).rows[0].receipt;
      assert.equal(
        (await deliver("No", null, otherHash)).error,
        "webhook_not_found",
      );
      assert.equal((await deliver(" ")).error, "invalid_text");
      // Client-authored metadata cannot impersonate or block a webhook receipt.
      await pool.query(
        "insert into chat_messages(channel_id,author_type,author_user_id,content,metadata) values($1,'user',$2,'Forged receipt',$3)",
        [
          channel,
          user,
          {
            kind: "incoming_webhook",
            webhook_id: hook,
            webhook_event_id: "build-1",
          },
        ],
      );
      const receipts = await Promise.all(
        Array.from({ length: 8 }, () => deliver("Build passed", "build-1")),
      );
      assert.equal(
        new Set(receipts.map((receipt) => receipt.message_id)).size,
        1,
      );
      assert.equal(receipts.filter((receipt) => !receipt.duplicate).length, 1);
      const row = (
        await pool.query("select * from chat_messages where id=$1", [
          receipts[0].message_id,
        ])
      ).rows[0];
      assert.equal(row.channel_id, channel);
      assert.equal(row.author_type, "system");
      assert.equal(row.author_user_id, null);
      assert.equal(row.metadata.webhook_name, "Build bot");
      assert.equal(JSON.stringify(row).includes(hash), false);
      assert.equal(
        (await deliver("Changed body", "build-1")).error,
        "idempotency_conflict",
      );
      await pool.query(
        "update chat_incoming_webhooks set enabled=false where id=$1",
        [hook],
      );
      assert.equal((await deliver("Paused")).error, "webhook_paused");
      await pool.query(
        "update chat_incoming_webhooks set enabled=true where id=$1",
        [hook],
      );
      await pool.query(
        "update chat_channels set is_archived=true where id=$1",
        [channel],
      );
      assert.equal((await deliver("Archived")).error, "channel_unavailable");
      await pool.query(
        "update chat_channels set is_archived=false, kind='dm' where id=$1",
        [channel],
      );
      assert.equal((await deliver("DM")).error, "channel_unavailable");
      await pool.query("update chat_channels set kind='channel' where id=$1", [
        channel,
      ]);
      const otherWorkspace = randomUUID();
      await pool.query("insert into workspaces values ($1)", [otherWorkspace]);
      await pool.query(
        "update chat_incoming_webhooks set workspace_id=$1 where id=$2",
        [otherWorkspace, hook],
      );
      assert.equal(
        (await deliver("Wrong workspace")).error,
        "channel_unavailable",
      );
      await pool.query(
        "update chat_incoming_webhooks set workspace_id=$1 where id=$2",
        [workspace, hook],
      );
      await pool.query("delete from workspace_members where user_id=$1", [
        user,
      ]);
      assert.equal(
        (await deliver("Creator left workspace")).error,
        "channel_unavailable",
      );
      await pool.query("insert into workspace_members values ($1,$2,'admin')", [
        workspace,
        user,
      ]);
      await pool.query("update workspace_members set role='guest'");
      assert.equal((await deliver("Guest")).error, "channel_unavailable");
      await pool.query("update workspace_members set role='member'");
      assert.equal((await deliver("Channel owner")).duplicate, false);
      await pool.query("update chat_channels set created_by=$1", [
        randomUUID(),
      ]);
      assert.equal(
        (await deliver("No longer manager")).error,
        "channel_unavailable",
      );
      await pool.query("update workspace_members set role='admin'");
      await pool.query(
        "update chat_incoming_webhooks set rate_window=now(),rate_count=59 where id=$1",
        [hook],
      );
      const burst = await Promise.all(
        Array.from({ length: 8 }, () => deliver("Concurrent burst")),
      );
      assert.equal(burst.filter((receipt) => !receipt.error).length, 1);
      assert.equal(
        burst.filter((receipt) => receipt.error === "rate_limited").length,
        7,
      );
      assert.equal((await deliver("Build passed", "build-1")).duplicate, true);
      await pool.query(
        "update chat_incoming_webhooks set rate_window=now()-interval '2 minutes',token_hash=$1 where id=$2",
        [otherHash, hook],
      );
      assert.equal((await deliver("Old URL")).error, "webhook_not_found");
      assert.equal(
        (await deliver("New URL", null, otherHash)).duplicate,
        false,
      );
      await pool.query(
        "update chat_incoming_webhooks set revoked_at=now() where id=$1",
        [hook],
      );
      assert.equal(
        (await deliver("Revoked", null, otherHash)).error,
        "webhook_not_found",
      );
      for (const role of ["anon", "authenticated"]) {
        assert.equal(
          (
            await pool.query(
              "select has_table_privilege($1,'chat_incoming_webhooks','SELECT') as allowed",
              [role],
            )
          ).rows[0].allowed,
          false,
        );
        assert.equal(
          (
            await pool.query(
              "select has_function_privilege($1,'deliver_chat_incoming_webhook(text,text,text)','EXECUTE') as allowed",
              [role],
            )
          ).rows[0].allowed,
          false,
        );
      }
      assert.equal(
        (
          await pool.query(
            "select has_function_privilege('service_role','deliver_chat_incoming_webhook(text,text,text)','EXECUTE') as allowed",
          )
        ).rows[0].allowed,
        true,
      );
    } finally {
      await pool.end();
      await root.query(`drop database ${database}`);
      await root.end();
    }
  },
);
