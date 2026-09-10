import fs from "node:fs";
import path from "node:path";

export function getDirectorySizeBytes(rootPath, fsModule = fs) {
  let totalBytes = 0;
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = fsModule.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        totalBytes += Math.max(0, Number(fsModule.statSync(absolutePath).size) || 0);
      } catch {
        // Ignore files removed while the profile is being measured.
      }
    }
  }
  return totalBytes;
}

function compactTimestamp(nowMs) {
  return new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function prepareWhatsAppProfile({
  dataPath,
  maxProfileBytes,
  nowMs = Date.now(),
  fsModule = fs,
} = {}) {
  const sessionPath = path.join(String(dataPath || ""), "session");
  const limitBytes = Math.max(0, Number(maxProfileBytes) || 0);
  if (!limitBytes || !fsModule.existsSync(sessionPath)) {
    return { rotated: false, sessionPath, sizeBytes: 0, limitBytes };
  }
  const sizeBytes = getDirectorySizeBytes(sessionPath, fsModule);
  if (sizeBytes < limitBytes) {
    return { rotated: false, sessionPath, sizeBytes, limitBytes };
  }

  const baseBackupPath = path.join(
    String(dataPath || ""),
    `session-battery-backup-${compactTimestamp(nowMs)}`
  );
  let backupPath = baseBackupPath;
  let suffix = 1;
  while (fsModule.existsSync(backupPath)) {
    backupPath = `${baseBackupPath}-${suffix}`;
    suffix += 1;
  }
  fsModule.renameSync(sessionPath, backupPath);
  return {
    rotated: true,
    sessionPath,
    backupPath,
    sizeBytes,
    limitBytes,
  };
}
