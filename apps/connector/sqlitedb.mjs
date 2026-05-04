import os from "os";
import path from "path";
import fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

let BetterSqlite3 = null;
function getBetterSqlite3() {
  if (!BetterSqlite3) {
    // better-sqlite3 is a C++ addon. We keep this require lazy so the connector can start
    // even if dependency install is partially broken, and surface a clear error per-call.
    // eslint-disable-next-line global-require
    BetterSqlite3 = require("better-sqlite3");
  }
  return BetterSqlite3;
}

function homeDir() {
  return os.homedir();
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function normalizeDbKey(dbKey) {
  const raw = String(dbKey || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  // Keep it filesystem-safe and predictable.
  const safe = raw
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
  return safe.slice(0, 80);
}

function getDbRootDir() {
  const dir = path.join(homeDir(), ".groovy", "sqlite");
  ensureDir(dir);
  return dir;
}

export function sqliteGetDbPath(dbKey) {
  const key = normalizeDbKey(dbKey);
  if (!key) throw new Error("invalid_db_key");
  return path.join(getDbRootDir(), `${key}.sqlite`);
}

function openDb(dbPath) {
  const Database = getBetterSqlite3();
  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  // Reasonable defaults for local automation DBs.
  try {
    db.pragma("journal_mode = WAL");
  } catch {}
  try {
    db.pragma("synchronous = NORMAL");
  } catch {}
  return db;
}

export async function sqliteListDbs() {
  const dir = getDbRootDir();
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  const dbs = entries
    .filter((e) => e.endsWith(".sqlite"))
    .map((e) => ({ dbKey: e.slice(0, -".sqlite".length), path: path.join(dir, e) }))
    .sort((a, b) => a.dbKey.localeCompare(b.dbKey));
  return { ok: true, dbs };
}

export async function sqliteExec(input) {
  const dbKey = normalizeDbKey(input?.dbKey);
  if (!dbKey) return { ok: false, error: "missing_dbKey" };

  const dbPath = sqliteGetDbPath(dbKey);
  const sqlRaw = typeof input?.sql === "string" ? input.sql : "";
  const statementsRaw = Array.isArray(input?.statements) ? input.statements : null;

  const statements = statementsRaw
    ? statementsRaw.map((s) => String(s || "")).filter(Boolean)
    : sqlRaw
      ? [String(sqlRaw)]
      : [];

  if (statements.length === 0) return { ok: false, error: "missing_sql" };
  if (statements.length > 50) return { ok: false, error: "too_many_statements" };

  // best-effort: preserve existing timeout_ms param shape (though better-sqlite3 is sync)
  void input?.timeout_ms;

  const sql = statements.join(";\n");
  let db = null;
  try {
    db = openDb(dbPath);
    db.exec(sql);
    return { ok: true, dbKey, dbPath, stdout: "", stderr: "" };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return {
      ok: false,
      error: "sqlite_exec_failed",
      dbKey,
      dbPath,
      stdout: "",
      stderr: err?.message || String(e),
    };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export async function sqliteQuery(input) {
  const dbKey = normalizeDbKey(input?.dbKey);
  if (!dbKey) return { ok: false, error: "missing_dbKey" };
  const dbPath = sqliteGetDbPath(dbKey);

  const sql = typeof input?.sql === "string" ? input.sql.trim() : "";
  if (!sql) return { ok: false, error: "missing_sql" };

  const limitRaw = Number(input?.limit || 200);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 2000) : 200;
  const shouldAppendLimit = input?.append_limit !== false;
  const hasLimit = /\blimit\b/i.test(sql);
  const finalSql = shouldAppendLimit && !hasLimit ? `${sql}\nLIMIT ${limit}` : sql;

  // best-effort: preserve existing timeout_ms param shape (though better-sqlite3 is sync)
  void input?.timeout_ms;

  let db = null;
  try {
    db = openDb(dbPath);
    const stmt = db.prepare(finalSql);
    const rows = stmt.all();
    return {
      ok: true,
      dbKey,
      dbPath,
      format: "json",
      json: JSON.stringify(rows || []),
      stderr: "",
    };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return {
      ok: false,
      error: "sqlite_query_failed",
      dbKey,
      dbPath,
      stdout: "",
      stderr: err?.message || String(e),
    };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

