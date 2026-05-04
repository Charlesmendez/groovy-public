import os from "os";
import path from "path";
import fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

let BetterSqlite3 = null;
function getBetterSqlite3() {
  if (!BetterSqlite3) {
    // eslint-disable-next-line global-require
    BetterSqlite3 = require("better-sqlite3");
  }
  return BetterSqlite3;
}

function homeDir() {
  return os.homedir();
}

function ensureGroovyDir() {
  const dir = path.join(homeDir(), ".groovy");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return dir;
}

export function getLinkDbPath() {
  const dir = ensureGroovyDir();
  return path.join(dir, "linkbox.sqlite");
}

function sqlQuote(v) {
  if (v == null) return "NULL";
  const s = String(v);
  // strip NULs (sqlite3 CLI can choke)
  const safe = s.replace(/\u0000/g, "");
  return `'${safe.replace(/'/g, "''")}'`;
}

function normalizeTag(t) {
  return String(t || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
}

function coerceTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const n = normalizeTag(t);
    if (!n) continue;
    if (!out.includes(n)) out.push(n);
    if (out.length >= 20) break;
  }
  return out;
}

function openDb() {
  const Database = getBetterSqlite3();
  const dbPath = getLinkDbPath();
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch {}
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
  } catch {}
  try {
    db.pragma("synchronous = NORMAL");
  } catch {}
  return { db, dbPath };
}

export async function linkdbInit() {
  // Basic schema + lightweight migration for earlier local DB versions.
  // NOTE: earlier prototypes created a different links schema (e.g. `read` int, `tags` text).
  // We "upgrade in place" by adding missing columns before creating indexes that reference them.
  let db = null;
  let dbPath = "";
  try {
    const opened = openDb();
    db = opened.db;
    dbPath = opened.dbPath;
    db.exec(`CREATE TABLE IF NOT EXISTS links (
        url TEXT PRIMARY KEY,
        title TEXT,
        summary TEXT,
        tags_json TEXT,
        tags_text TEXT,
        note TEXT,
        status TEXT DEFAULT 'unread',
        source TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        read_at TEXT
      );`);

    // Introspect current columns
    const cols = db.prepare("SELECT name FROM pragma_table_info('links') ORDER BY cid").all();
    const existing = new Set((cols || []).map((r) => String(r.name || "").trim()).filter(Boolean));

    const addColumn = (sql) => {
      try {
        db.exec(sql);
      } catch {
        // ignore - column might already exist
      }
    };

    if (!existing.has("tags_json")) addColumn("ALTER TABLE links ADD COLUMN tags_json TEXT");
    if (!existing.has("tags_text")) addColumn("ALTER TABLE links ADD COLUMN tags_text TEXT");
    if (!existing.has("status")) addColumn("ALTER TABLE links ADD COLUMN status TEXT DEFAULT 'unread'");
    if (!existing.has("read_at")) addColumn("ALTER TABLE links ADD COLUMN read_at TEXT");
    if (!existing.has("note")) addColumn("ALTER TABLE links ADD COLUMN note TEXT");
    if (!existing.has("source")) addColumn("ALTER TABLE links ADD COLUMN source TEXT");
    if (!existing.has("summary")) addColumn("ALTER TABLE links ADD COLUMN summary TEXT");
    if (!existing.has("title")) addColumn("ALTER TABLE links ADD COLUMN title TEXT");
    if (!existing.has("created_at")) {
      addColumn(
        "ALTER TABLE links ADD COLUMN created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
      );
    }
    if (!existing.has("updated_at")) {
      addColumn(
        "ALTER TABLE links ADD COLUMN updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
      );
    }

    db.exec("CREATE INDEX IF NOT EXISTS links_status_updated_idx ON links(status, updated_at DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS links_updated_idx ON links(updated_at DESC)");

    return { ok: true, dbPath };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: err?.message || String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export async function linkdbUpsertLinks(input) {
  const init = await linkdbInit();
  if (!init.ok) return init;
  const links = Array.isArray(input?.links) ? input.links : [];
  const results = [];

  let db = null;
  try {
    const opened = openDb();
    db = opened.db;

    const stmt = db.prepare(`INSERT INTO links(url, title, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title = COALESCE(excluded.title, links.title),
         source = COALESCE(excluded.source, links.source),
         updated_at = excluded.updated_at`);

    const now = new Date().toISOString();
    for (const raw of links.slice(0, 50)) {
      const url = typeof raw?.url === "string" ? raw.url.trim() : "";
      if (!url) continue;
      const title = typeof raw?.title === "string" ? raw.title.trim() : "";
      const source = typeof raw?.source === "string" ? raw.source.trim() : "";
      stmt.run(url, title || null, source || null, now, now);
      results.push({ url, ok: true });
    }
    return { ok: true, count: results.length, results };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: err?.message || String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export async function linkdbUpdate(input) {
  const init = await linkdbInit();
  if (!init.ok) return init;
  const url = typeof input?.url === "string" ? input.url.trim() : "";
  if (!url) return { ok: false, error: "missing_url" };

  const sets = [];
  const now = new Date().toISOString();
  sets.push(`updated_at = ${sqlQuote(now)}`);

  if (typeof input?.title === "string") {
    sets.push(`title = ${sqlQuote(input.title.trim())}`);
  }
  if (typeof input?.summary === "string") {
    sets.push(`summary = ${sqlQuote(input.summary.trim())}`);
  }
  if (typeof input?.note === "string") {
    sets.push(`note = ${sqlQuote(input.note.trim())}`);
  }
  if (typeof input?.source === "string") {
    sets.push(`source = ${sqlQuote(input.source.trim())}`);
  }

  if (Array.isArray(input?.tags)) {
    const tags = coerceTags(input.tags);
    const tagsJson = JSON.stringify(tags);
    const tagsText = tags.join(",");
    sets.push(`tags_json = ${sqlQuote(tagsJson)}`);
    sets.push(`tags_text = ${sqlQuote(tagsText)}`);
  }

  if (input?.read === true) {
    sets.push(`status = 'read'`);
    sets.push(`read_at = ${sqlQuote(now)}`);
  } else if (input?.read === false) {
    sets.push(`status = 'unread'`);
    sets.push(`read_at = NULL`);
  }

  if (sets.length === 0) return { ok: false, error: "no_updates" };

  let db = null;
  try {
    const opened = openDb();
    db = opened.db;
    const stmt = `UPDATE links SET ${sets.join(", ")} WHERE url = ${sqlQuote(url)}`;
    db.exec(stmt);
    return { ok: true, url };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: err?.message || String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export async function linkdbQuery(input) {
  const init = await linkdbInit();
  if (!init.ok) return init;
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  const tagsAny = Array.isArray(input?.tags_any) ? coerceTags(input.tags_any) : [];
  const unreadOnly = input?.unread_only === true;
  const limitRaw = Number(input?.limit || 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 50;

  const where = [];
  if (unreadOnly) where.push(`status = 'unread'`);
  if (text) {
    const q = `%${text.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    where.push(`(url LIKE ${sqlQuote(q)} ESCAPE '\\\\' OR title LIKE ${sqlQuote(q)} ESCAPE '\\\\' OR summary LIKE ${sqlQuote(q)} ESCAPE '\\\\' OR note LIKE ${sqlQuote(q)} ESCAPE '\\\\')`);
  }
  if (tagsAny.length > 0) {
    const parts = tagsAny.map((t) => `tags_text LIKE ${sqlQuote(`%${t}%`)}`);
    where.push(`(${parts.join(" OR ")})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  let db = null;
  try {
    const opened = openDb();
    db = opened.db;
    const rows = db
      .prepare(
        `SELECT url, title, summary, tags_text, note, status, source, created_at, updated_at, read_at
         FROM links
         ${whereSql}
         ORDER BY updated_at DESC
         LIMIT ${limit}`
      )
      .all();
    const items = (rows || []).map((r) => ({
      url: r.url,
      title: r.title || null,
      summary: r.summary || null,
      tags: typeof r.tags_text === "string" && r.tags_text ? r.tags_text.split(",").filter(Boolean) : [],
      note: r.note || null,
      status: r.status || "unread",
      source: r.source || null,
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
      read_at: r.read_at || null,
    }));
    return { ok: true, count: items.length, items };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: err?.message || String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export async function linkdbDigest(input) {
  const init = await linkdbInit();
  if (!init.ok) return init;
  const sinceDaysRaw = Number(input?.since_days || 7);
  const sinceDays = Number.isFinite(sinceDaysRaw) ? Math.min(Math.max(1, sinceDaysRaw), 365) : 7;
  const unreadOnly = input?.unread_only !== false; // default true
  const limitRaw = Number(input?.limit || 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 50;

  const where = [];
  if (unreadOnly) where.push(`status = 'unread'`);
  where.push(`updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-${sinceDays} days')`);
  const whereSql = `WHERE ${where.join(" AND ")}`;

  let db = null;
  try {
    const opened = openDb();
    db = opened.db;
    const rows = db
      .prepare(
        `SELECT url, title, summary, tags_text, status, source, updated_at
         FROM links
         ${whereSql}
         ORDER BY updated_at DESC
         LIMIT ${limit}`
      )
      .all();
    const items = (rows || []).map((r) => ({
      url: r.url,
      title: r.title || null,
      summary: r.summary || null,
      tags: typeof r.tags_text === "string" && r.tags_text ? r.tags_text.split(",").filter(Boolean) : [],
      status: r.status || "unread",
      source: r.source || null,
      updated_at: r.updated_at || null,
    }));
    return { ok: true, count: items.length, items };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: err?.message || String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

