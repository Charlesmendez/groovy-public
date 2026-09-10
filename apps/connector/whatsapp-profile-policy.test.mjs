import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getDirectorySizeBytes,
  prepareWhatsAppProfile,
} from "./platform/whatsapp/profilePolicy.mjs";

test("measures regular files while ignoring symlinks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "groovy-profile-size-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "a"), Buffer.alloc(10));
  fs.writeFileSync(path.join(root, "nested", "b"), Buffer.alloc(15));
  fs.symlinkSync(path.join(root, "a"), path.join(root, "link"));
  assert.equal(getDirectorySizeBytes(root), 25);
});

test("rotates an oversized profile to a recoverable backup", (t) => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "groovy-profile-policy-"));
  t.after(() => fs.rmSync(dataPath, { recursive: true, force: true }));
  const sessionPath = path.join(dataPath, "session");
  fs.mkdirSync(sessionPath);
  fs.writeFileSync(path.join(sessionPath, "oversized"), Buffer.alloc(100));

  const result = prepareWhatsAppProfile({
    dataPath,
    maxProfileBytes: 50,
    nowMs: Date.UTC(2026, 7, 20, 12, 0, 0),
  });

  assert.equal(result.rotated, true);
  assert.equal(fs.existsSync(sessionPath), false);
  assert.equal(fs.existsSync(path.join(result.backupPath, "oversized")), true);
  assert.match(path.basename(result.backupPath), /^session-battery-backup-20260820T120000Z/);
});

test("leaves a healthy profile in place", (t) => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "groovy-profile-policy-"));
  t.after(() => fs.rmSync(dataPath, { recursive: true, force: true }));
  const sessionPath = path.join(dataPath, "session");
  fs.mkdirSync(sessionPath);
  fs.writeFileSync(path.join(sessionPath, "small"), Buffer.alloc(10));
  const result = prepareWhatsAppProfile({ dataPath, maxProfileBytes: 50 });
  assert.equal(result.rotated, false);
  assert.equal(fs.existsSync(sessionPath), true);
});
