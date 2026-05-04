import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createRequire } from "module";
import { promptForCredentials as promptForCredentialsPrompt } from "./platform/prompt/index.mjs";

const require = createRequire(import.meta.url);

let BetterSqlite3 = null;
function getBetterSqlite3() {
  if (!BetterSqlite3) {
    BetterSqlite3 = require("better-sqlite3");
  }
  return BetterSqlite3;
}

let keytar = null;
try {
  keytar = require("keytar");
} catch {
  keytar = null;
}

const KEYCHAIN_SERVICE = "groovy-connector";
const MASTER_KEY_ACCOUNT = "credentials-master-key-v1";

// Prevent duplicate macOS dialogs if multiple parts of the connector request
// credentials for the same domain at the same time.
const inFlightCredentialRequests = new Map();

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

function getDbPath() {
  const dir = path.join(homeDir(), ".groovy", "sqlite");
  ensureDir(dir);
  return path.join(dir, "credentials.sqlite");
}

function openDb() {
  const Database = getBetterSqlite3();
  const dbPath = getDbPath();
  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
  } catch {}
  try {
    db.pragma("synchronous = NORMAL");
  } catch {}
  db.exec(`CREATE TABLE IF NOT EXISTS credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    enc_json TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_used_at TEXT
  )`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS credentials_domain_username_uq ON credentials(domain, username)");
  db.exec("CREATE INDEX IF NOT EXISTS credentials_domain_last_used_idx ON credentials(domain, COALESCE(last_used_at, updated_at) DESC)");
  return { db, dbPath };
}

async function getOrCreateMasterKeyBytes() {
  if (!keytar) throw new Error("keytar_unavailable");
  const existing = await keytar.getPassword(KEYCHAIN_SERVICE, MASTER_KEY_ACCOUNT);
  if (existing) {
    const b = Buffer.from(existing, "base64");
    if (b.length === 32) return b;
  }
  const key = crypto.randomBytes(32);
  await keytar.setPassword(KEYCHAIN_SERVICE, MASTER_KEY_ACCOUNT, key.toString("base64"));
  return key;
}

function encryptSecret({ masterKey, plaintext }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv_b64: iv.toString("base64"),
    tag_b64: tag.toString("base64"),
    ct_b64: ciphertext.toString("base64"),
  };
}

function decryptSecret({ masterKey, enc }) {
  const iv = Buffer.from(String(enc.iv_b64 || ""), "base64");
  const tag = Buffer.from(String(enc.tag_b64 || ""), "base64");
  const ct = Buffer.from(String(enc.ct_b64 || ""), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return plaintext;
}

function normalizeDomain(domain) {
  const d = String(domain || "").trim().toLowerCase();
  if (!d) return "";
  const host = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // Canonicalize common variants so stored creds survive redirects like:
  // - reddit.com <-> www.reddit.com
  // - mobile subdomains
  return host.replace(/^www\./, "").replace(/^m\./, "");
}

async function promptForCredentials({ domain, reason }) {
  const d = normalizeDomain(domain);
  if (!d) throw new Error("missing_domain");
  const safeReason = typeof reason === "string" && reason.trim() ? reason.trim() : "Login required to continue.";
  const securityNote =
    "Security note: saved locally in an encrypted vault (key in system keychain). Never sent to Groovy servers or stored in chat logs.";

  const prompted = await promptForCredentialsPrompt({
    domain: d,
    reason: safeReason,
    securityNote,
  });
  if (!prompted?.ok) {
    throw new Error(prompted?.error || "user_cancelled");
  }
  const username = String(prompted.username || "").trim();
  const password = String(prompted.password || "");

  if (!password.trim()) throw new Error("empty_password");
  return { domain: d, username, password };
}

async function upsertCredentialSecret({ domain, username, password }) {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, error: "missing_domain" };

  const masterKey = await getOrCreateMasterKeyBytes();
  const enc = encryptSecret({ masterKey, plaintext: password });
  const encJson = JSON.stringify(enc);
  const now = new Date().toISOString();

  let db = null;
  try {
    const opened = openDb();
    db = opened.db;
    const u = typeof username === "string" ? username.trim() : "";
    db.prepare(
      `INSERT INTO credentials(domain, username, enc_json, created_at, updated_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain, username) DO UPDATE SET
         enc_json = excluded.enc_json,
         updated_at = excluded.updated_at`
    ).run(d, u, encJson, now, now, now);
    return { ok: true, domain: d, username: u };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function selectBestRow(db, domain) {
  const d = normalizeDomain(domain);
  if (!d) return null;

  // Deterministic local matching (no vault disclosure to the model):
  // - exact canonical match
  // - legacy exact match (www./m. stored historically)
  // - stored parent domain: d endswith "."+domain (use base domain creds for subdomains)
  // - stored child domain: domain endswith "."+d (if creds were stored on a subdomain)
  //
  // This fixes repeated prompts on sites that redirect between subdomains
  // (e.g. reddit.com <-> accounts.reddit.com) without hardcoding per-site logic.
  return db
    .prepare(
      `SELECT id, domain, username, enc_json, created_at, updated_at, last_used_at
       FROM credentials
       WHERE domain = ?
          OR domain = ('www.' || ?)
          OR domain = ('m.' || ?)
          OR ? LIKE ('%.' || domain)
          OR domain LIKE ('%.' || ?)
       ORDER BY
         CASE
           WHEN domain = ? THEN 0
           WHEN domain = ('www.' || ?) THEN 1
           WHEN domain = ('m.' || ?) THEN 2
           WHEN ? LIKE ('%.' || domain) THEN 3
           WHEN domain LIKE ('%.' || ?) THEN 4
           ELSE 9
         END ASC,
         LENGTH(domain) DESC,
         COALESCE(last_used_at, updated_at) DESC
       LIMIT 1`
    )
    .get(d, d, d, d, d, d, d, d, d, d);
}

export async function credentialGetMeta({ domain }) {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, error: "missing_domain" };
  let db = null;
  try {
    const opened = openDb();
    db = opened.db;
    const row = selectBestRow(db, domain);
    if (!row) return { ok: true, hasCredential: false };
    return { ok: true, hasCredential: true, domain: row.domain, username: row.username || "" };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: err?.message || String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

// Internal use (browser runner). Do NOT expose this to server/tool results.
export async function credentialGetSecret({ domain }) {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, error: "missing_domain" };
  let db = null;
  try {
    const opened = openDb();
    db = opened.db;
    const row = selectBestRow(db, domain);
    if (!row) return { ok: true, hasCredential: false };

    const masterKey = await getOrCreateMasterKeyBytes();
    const enc = JSON.parse(String(row.enc_json || "{}"));
    const password = decryptSecret({ masterKey, enc });

    // Update last_used_at
    const now = new Date().toISOString();
    try {
      db.prepare("UPDATE credentials SET last_used_at = ? WHERE id = ?").run(now, row.id);
    } catch {
      // ignore
    }

    return {
      ok: true,
      hasCredential: true,
      domain: row.domain,
      username: row.username || "",
      password,
    };
  } catch (e) {
    const err = e instanceof Error ? e : null;
    return { ok: false, error: err?.message || String(e) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export async function credentialRequest({ domain, reason }) {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, error: "missing_domain" };

  // Idempotent: if we already have a credential for this domain (or a matching
  // subdomain/base-domain row), do NOT prompt again.
  const existing = await credentialGetMeta({ domain: d }).catch(() => null);
  if (existing?.ok && existing.hasCredential) return existing;

  if (inFlightCredentialRequests.has(d)) {
    return await inFlightCredentialRequests.get(d);
  }

  const p = (async () => {
    try {
      const { domain: d2, username, password } = await promptForCredentials({ domain: d, reason });
      const up = await upsertCredentialSecret({ domain: d2, username, password });
      if (!up.ok) return up;
      // Return meta only (no password)
      return await credentialGetMeta({ domain: d2 });
    } catch (e) {
      const err = e instanceof Error ? e : null;
      // osascript returns non-zero on cancel
      if (err?.message && /User canceled|(-128)/i.test(err.message)) {
        return { ok: false, error: "user_cancelled" };
      }
      // If we ever hit a timeout, treat as cancelled (and don't spam re-prompts).
      if (err?.message && /timed out|ETIMEDOUT/i.test(err.message)) {
        return { ok: false, error: "user_cancelled" };
      }
      return { ok: false, error: err?.message || String(e) };
    } finally {
      inFlightCredentialRequests.delete(d);
    }
  })();

  inFlightCredentialRequests.set(d, p);
  return await p;
}

