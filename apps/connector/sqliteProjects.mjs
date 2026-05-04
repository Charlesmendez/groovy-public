import fs from "fs";
import os from "os";
import path from "path";
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

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function getSqliteRootDir() {
  const dir = path.join(homeDir(), ".groovy", "sqlite");
  ensureDir(dir);
  return dir;
}

export function getRegistryDbPath() {
  return path.join(getSqliteRootDir(), "_registry.sqlite");
}

function normalizeDbKey(dbKey) {
  const raw = String(dbKey || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  const safe = raw
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
  return safe.slice(0, 80);
}

function slugifyName(name) {
  const raw = String(name || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  const slug = raw
    .replace(/['"]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.slice(0, 80);
}

function coerceTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const n = String(t || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9._-]/g, "");
    if (!n) continue;
    if (!out.includes(n)) out.push(n);
    if (out.length >= 20) break;
  }
  return out;
}

function openDb(dbPath) {
  const Database = getBetterSqlite3();
  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
  } catch {}
  try {
    db.pragma("synchronous = NORMAL");
  } catch {}
  return db;
}

async function ensureRegistry() {
  // Ensure directory exists and schema is present (additive).
  const dbPath = getRegistryDbPath();
  let db = null;
  try {
    db = openDb(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS projects (
      db_key TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      description TEXT,
      tags_json TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );`);
    db.exec("CREATE INDEX IF NOT EXISTS projects_updated_idx ON projects(updated_at DESC)");
    return { ok: true, dbPath };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: "registry_init_failed", stderr: err?.message || String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function safeParseJsonArray(s) {
  try {
    const v = JSON.parse(String(s || "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function sqliteProjectList() {
  const init = await ensureRegistry();
  if (!init.ok) return init;
  const dbPath = init.dbPath;
  let db = null;
  try {
    db = openDb(dbPath);
    const rows = db.prepare("SELECT db_key, name, description, tags_json, created_at, updated_at FROM projects ORDER BY updated_at DESC").all();
    const projects = (rows || []).map((r) => ({
      dbKey: r.db_key,
      name: r.name,
      description: r.description || null,
      tags: typeof r.tags_json === "string" && r.tags_json ? safeParseJsonArray(r.tags_json) : [],
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
    }));
    return { ok: true, dbPath, projects };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: "query_failed", stderr: err?.message || String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export async function sqliteProjectGetOrCreate(input) {
  const init = await ensureRegistry();
  if (!init.ok) return init;
  const dbPath = init.dbPath;

  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "missing_name" };

  let db = null;
  try {
    db = openDb(dbPath);

    // If name already exists, return existing mapping.
    const existing = db
      .prepare("SELECT db_key, name, description, tags_json, created_at, updated_at FROM projects WHERE name = ? LIMIT 1")
      .get(name);
    if (existing && existing.db_key) {
      return {
        ok: true,
        dbPath,
        created: false,
        project: {
          dbKey: existing.db_key,
          name: existing.name,
          description: existing.description || null,
          tags: typeof existing.tags_json === "string" && existing.tags_json ? safeParseJsonArray(existing.tags_json) : [],
          created_at: existing.created_at || null,
          updated_at: existing.updated_at || null,
        },
      };
    }

    const preferred = normalizeDbKey(input?.preferredDbKey);
    let dbKey = preferred || slugifyName(name);
    if (!dbKey) dbKey = `project-${Math.random().toString(36).slice(2, 8)}`;

    const description = typeof input?.description === "string" ? input.description.trim() : "";
    const tags = coerceTags(input?.tags);
    const tagsJson = JSON.stringify(tags);
    const now = new Date().toISOString();

    // Ensure dbKey is unique; if taken, append -2, -3, ...
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? dbKey : `${dbKey}-${i + 1}`;
      const taken = db.prepare("SELECT 1 FROM projects WHERE db_key = ? LIMIT 1").get(candidate);
      if (taken) continue;

      db.prepare(
        "INSERT INTO projects(db_key, name, description, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(candidate, name, description || null, tagsJson, now, now);

      return {
        ok: true,
        dbPath,
        created: true,
        project: {
          dbKey: candidate,
          name,
          description: description || null,
          tags,
          created_at: now,
          updated_at: now,
        },
      };
    }

    return { ok: false, error: "dbKey_conflict" };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: "project_create_failed", stderr: err?.message || String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export async function sqliteProjectUpdate(input) {
  const init = await ensureRegistry();
  if (!init.ok) return init;
  const dbPath = init.dbPath;

  const dbKey = normalizeDbKey(input?.dbKey);
  if (!dbKey) return { ok: false, error: "missing_dbKey" };

  let db = null;
  try {
    db = openDb(dbPath);

    const now = new Date().toISOString();
    const nextName =
      typeof input?.name === "string" && input.name.trim() ? input.name.trim() : undefined;
    const nextDesc = typeof input?.description === "string" ? input.description.trim() : undefined;
    const nextTags = Array.isArray(input?.tags) ? JSON.stringify(coerceTags(input.tags)) : undefined;

    if (nextName === undefined && nextDesc === undefined && nextTags === undefined) {
      return { ok: false, error: "no_updates" };
    }

    const existing = db
      .prepare("SELECT db_key, name, description, tags_json, created_at, updated_at FROM projects WHERE db_key = ? LIMIT 1")
      .get(dbKey);

    const updatedName = nextName !== undefined ? nextName : existing?.name;
    const updatedDesc = nextDesc !== undefined ? (nextDesc || null) : existing?.description;
    const updatedTagsJson = nextTags !== undefined ? nextTags : existing?.tags_json;

    db.prepare(
      "UPDATE projects SET name = ?, description = ?, tags_json = ?, updated_at = ? WHERE db_key = ?"
    ).run(updatedName, updatedDesc, updatedTagsJson, now, dbKey);

    const row = db
      .prepare("SELECT db_key, name, description, tags_json, created_at, updated_at FROM projects WHERE db_key = ? LIMIT 1")
      .get(dbKey);

    return {
      ok: true,
      dbPath,
      project: row
        ? {
            dbKey: row.db_key,
            name: row.name,
            description: row.description || null,
            tags: typeof row.tags_json === "string" && row.tags_json ? safeParseJsonArray(row.tags_json) : [],
            created_at: row.created_at || null,
            updated_at: row.updated_at || null,
          }
        : { dbKey, updated_at: now },
    };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: "project_update_failed", stderr: err?.message || String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

