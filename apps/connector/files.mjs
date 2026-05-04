/**
 * File System Operations Module
 * Handles read, write, list, and search operations on the local filesystem.
 */

import { promises as fsp } from "fs";
import path from "path";
import os from "os";

// Security: directories that are allowed by default
const DEFAULT_ALLOWED_ROOTS = [os.homedir()];

// Directories that should never be accessed
const FORBIDDEN_PATHS =
  process.platform === "win32"
    ? [
        "C:\\Windows",
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        "C:\\ProgramData",
        "C:\\Users\\Default",
        path.join(os.homedir(), ".ssh"),
        path.join(os.homedir(), ".gnupg"),
        path.join(os.homedir(), ".aws"),
      ]
    : [
        "/etc",
        "/var",
        "/usr",
        "/bin",
        "/sbin",
        "/System",
        "/Library",
        "/private",
        path.join(os.homedir(), ".ssh"),
        path.join(os.homedir(), ".gnupg"),
        path.join(os.homedir(), ".aws"),
        path.join(os.homedir(), ".config/gcloud"),
      ];

function normalizeForCompare(p) {
  const normalized = path.normalize(String(p || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isForbiddenPath(p) {
  const normalized = normalizeForCompare(p);
  const home = normalizeForCompare(os.homedir());
  for (const forbidden of FORBIDDEN_PATHS) {
    const blocked = normalizeForCompare(forbidden);
    if (
      normalized === blocked ||
      normalized.startsWith(`${blocked}${path.sep}`)
    ) {
      // Allow subdirs of home even if they match patterns like .ssh
      if (normalized.startsWith(home)) {
        // Still block sensitive subdirs
        const rel = normalized.slice(home.length);
        if (
          rel.startsWith(`${path.sep}.ssh`) ||
          rel.startsWith(`${path.sep}.gnupg`) ||
          rel.startsWith(`${path.sep}.aws`)
        ) {
          return true;
        }
        continue;
      }
      return true;
    }
  }
  return false;
}

function isWithinAllowedRoot(targetPath, allowedRoots = DEFAULT_ALLOWED_ROOTS) {
  const normalized = normalizeForCompare(path.normalize(path.resolve(targetPath)));
  for (const root of allowedRoots) {
    const normalizedRoot = normalizeForCompare(path.normalize(path.resolve(root)));
    if (
      normalized === normalizedRoot ||
      normalized.startsWith(normalizedRoot + path.sep)
    ) {
      return true;
    }
  }
  return false;
}

async function resolveRealpathSafe(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

async function normalizeAllowedRootsReal(allowedRoots) {
  const roots = Array.isArray(allowedRoots) && allowedRoots.length ? allowedRoots : DEFAULT_ALLOWED_ROOTS;
  const out = [];
  for (const raw of roots) {
    if (!raw) continue;
    const resolved = path.resolve(String(raw));
    const real = (await resolveRealpathSafe(resolved)) || resolved;
    out.push(real);
  }
  // de-dupe (case-insensitive on windows)
  const seen = new Set();
  const deduped = [];
  for (const r of out) {
    const key = normalizeForCompare(r);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped.length ? deduped : DEFAULT_ALLOWED_ROOTS;
}

function validateResolvedAgainstRoots(resolvedPath, allowedRootsReal) {
  if (isForbiddenPath(resolvedPath)) {
    return { ok: false, error: "Access to this path is forbidden" };
  }
  if (!isWithinAllowedRoot(resolvedPath, allowedRootsReal)) {
    return { ok: false, error: "Path is outside allowed directories" };
  }
  return { ok: true, path: resolvedPath };
}

async function validateExistingPathNoSymlinkEscape(resolvedPath, allowedRoots) {
  const allowedRootsReal = await normalizeAllowedRootsReal(allowedRoots);
  const real = (await resolveRealpathSafe(resolvedPath)) || resolvedPath;
  return validateResolvedAgainstRoots(real, allowedRootsReal);
}

async function validateParentDirNoSymlinkEscape(resolvedPath, allowedRoots) {
  const allowedRootsReal = await normalizeAllowedRootsReal(allowedRoots);
  const parent = path.dirname(resolvedPath);
  const parentReal = (await resolveRealpathSafe(parent)) || parent;
  return validateResolvedAgainstRoots(parentReal, allowedRootsReal);
}

function validatePath(targetPath, allowedRoots = DEFAULT_ALLOWED_ROOTS) {
  if (!targetPath || typeof targetPath !== "string") {
    return { ok: false, error: "Invalid path" };
  }

  const resolved = path.resolve(targetPath);

  if (isForbiddenPath(resolved)) {
    return { ok: false, error: "Access to this path is forbidden" };
  }

  if (!isWithinAllowedRoot(resolved, allowedRoots)) {
    return { ok: false, error: "Path is outside allowed directories" };
  }

  return { ok: true, path: resolved };
}

/**
 * Read a file's contents
 */
export async function fileRead({ filePath, allowedRoots, encoding = "utf8" }) {
  const validation = validatePath(filePath, allowedRoots);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  try {
    // Prevent symlink escapes: validate realpath (follows symlinks).
    const realValidation = await validateExistingPathNoSymlinkEscape(validation.path, allowedRoots);
    if (!realValidation.ok) return { ok: false, error: realValidation.error };

    const stats = await fsp.stat(validation.path);
    if (stats.isDirectory()) {
      return { ok: false, error: "Path is a directory, not a file" };
    }

    // Limit file size to 10MB
    if (stats.size > 10 * 1024 * 1024) {
      return { ok: false, error: "File too large (max 10MB)" };
    }

    const content = await fsp.readFile(validation.path, encoding);
    return {
      ok: true,
      path: validation.path,
      content,
      size: stats.size,
      modified: stats.mtime.toISOString(),
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ok: false, error: "File not found" };
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Write content to a file
 */
export async function fileWrite({
  filePath,
  content,
  allowedRoots,
  createDirs = true,
}) {
  const validation = validatePath(filePath, allowedRoots);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  try {
    // Prevent writing through symlinks (would write to the target).
    try {
      const ls = await fsp.lstat(validation.path);
      if (ls.isSymbolicLink()) {
        return { ok: false, error: "Refusing to write through a symlink path" };
      }
    } catch {
      // ignore (file may not exist yet)
    }

    // Prevent symlink/junction directory escapes.
    const parentValidation = await validateParentDirNoSymlinkEscape(validation.path, allowedRoots);
    if (!parentValidation.ok) return { ok: false, error: parentValidation.error };

    if (createDirs) {
      await fsp.mkdir(path.dirname(validation.path), { recursive: true });
    }

    await fsp.writeFile(validation.path, content, "utf8");
    const stats = await fsp.stat(validation.path);

    return {
      ok: true,
      path: validation.path,
      size: stats.size,
      modified: stats.mtime.toISOString(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * List contents of a directory
 */
export async function fileList({
  dirPath,
  allowedRoots,
  recursive = false,
  maxDepth = 3,
}) {
  const validation = validatePath(dirPath, allowedRoots);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  try {
    const realValidation = await validateExistingPathNoSymlinkEscape(validation.path, allowedRoots);
    if (!realValidation.ok) return { ok: false, error: realValidation.error };

    const stats = await fsp.stat(validation.path);
    if (!stats.isDirectory()) {
      return { ok: false, error: "Path is not a directory" };
    }

    const entries = [];

    async function listDir(dir, depth) {
      if (depth > maxDepth) return;

      const items = await fsp.readdir(dir, { withFileTypes: true });

      for (const item of items) {
        // Skip hidden files/dirs
        if (item.name.startsWith(".")) continue;

        const fullPath = path.join(dir, item.name);
        const relativePath = path.relative(validation.path, fullPath);

        try {
          // Use lstat to avoid following symlinks (prevents leaking target metadata).
          const itemStats = await fsp.lstat(fullPath);
          entries.push({
            name: item.name,
            path: relativePath,
            fullPath,
            isDirectory: item.isDirectory(),
            isSymlink: typeof item.isSymbolicLink === "function" ? item.isSymbolicLink() : false,
            size: item.isDirectory() ? null : itemStats.size,
            modified: itemStats.mtime.toISOString(),
          });

          if (recursive && item.isDirectory()) {
            await listDir(fullPath, depth + 1);
          }
        } catch {
          // Skip files we can't stat
        }
      }
    }

    await listDir(validation.path, 0);

    return {
      ok: true,
      path: validation.path,
      entries,
      count: entries.length,
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ok: false, error: "Directory not found" };
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Search for files matching a query (by name or content)
 */
export async function fileSearch({
  rootPath,
  query,
  allowedRoots,
  searchContent = false,
  maxResults = 50,
  maxDepth = 5,
}) {
  const validation = validatePath(rootPath, allowedRoots);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  if (!query || typeof query !== "string") {
    return { ok: false, error: "Search query is required" };
  }

  const results = [];
  const queryLower = query.toLowerCase();

  async function searchDir(dir, depth) {
    if (depth > maxDepth || results.length >= maxResults) return;

    try {
      const items = await fsp.readdir(dir, { withFileTypes: true });

      for (const item of items) {
        if (results.length >= maxResults) break;
        if (item.name.startsWith(".")) continue;

        const fullPath = path.join(dir, item.name);
        const isSymlink = typeof item.isSymbolicLink === "function" ? item.isSymbolicLink() : false;

        // Check filename match
        if (item.name.toLowerCase().includes(queryLower)) {
          try {
            const stats = await fsp.lstat(fullPath);
            results.push({
              name: item.name,
              path: fullPath,
              isDirectory: item.isDirectory(),
              isSymlink,
              size: item.isDirectory() ? null : stats.size,
              modified: stats.mtime.toISOString(),
              matchType: "filename",
            });
          } catch {
            // Skip
          }
        }

        // Search content for text files
        if (
          searchContent &&
          !isSymlink &&
          !item.isDirectory() &&
          /\.(txt|md|json|js|ts|jsx|tsx|html|css|py|rb|go|rs|java|c|cpp|h|xml|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh)$/i.test(
            item.name
          )
        ) {
          try {
            const stats = await fsp.stat(fullPath);
            if (stats.size < 1024 * 1024) {
              // Only search files < 1MB
              const content = await fsp.readFile(fullPath, "utf8");
              if (content.toLowerCase().includes(queryLower)) {
                // Find the matching line
                const lines = content.split("\n");
                const matchingLine = lines.findIndex((line) =>
                  line.toLowerCase().includes(queryLower)
                );

                if (
                  !results.find(
                    (r) => r.path === fullPath && r.matchType === "filename"
                  )
                ) {
                  results.push({
                    name: item.name,
                    path: fullPath,
                    isDirectory: false,
                    size: stats.size,
                    modified: stats.mtime.toISOString(),
                    matchType: "content",
                    matchLine: matchingLine >= 0 ? matchingLine + 1 : null,
                    matchPreview:
                      matchingLine >= 0
                        ? lines[matchingLine].trim().slice(0, 100)
                        : null,
                  });
                }
              }
            }
          } catch {
            // Skip unreadable files
          }
        }

        if (item.isDirectory()) {
          await searchDir(fullPath, depth + 1);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  // Prevent symlink/junction escapes at the root.
  const realValidation = await validateExistingPathNoSymlinkEscape(validation.path, allowedRoots);
  if (!realValidation.ok) return { ok: false, error: realValidation.error };

  await searchDir(validation.path, 0);

  return {
    ok: true,
    query,
    rootPath: validation.path,
    results,
    count: results.length,
    truncated: results.length >= maxResults,
  };
}

/**
 * Delete a file or empty directory
 */
export async function fileDelete({ filePath, allowedRoots }) {
  const validation = validatePath(filePath, allowedRoots);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  try {
    // Allow deleting a symlink itself (safe), but prevent directory symlink escapes.
    const parentValidation = await validateParentDirNoSymlinkEscape(validation.path, allowedRoots);
    if (!parentValidation.ok) return { ok: false, error: parentValidation.error };

    let isSymlink = false;
    try {
      const ls = await fsp.lstat(validation.path);
      isSymlink = ls.isSymbolicLink();
    } catch {
      // ignore; handled by stat below
    }

    if (!isSymlink) {
      const realValidation = await validateExistingPathNoSymlinkEscape(validation.path, allowedRoots);
      if (!realValidation.ok) return { ok: false, error: realValidation.error };
    }

    const stats = await fsp.stat(validation.path);

    if (stats.isDirectory()) {
      // Only delete empty directories for safety
      const contents = await fsp.readdir(validation.path);
      if (contents.length > 0) {
        return { ok: false, error: "Directory is not empty" };
      }
      await fsp.rmdir(validation.path);
    } else {
      await fsp.unlink(validation.path);
    }

    return { ok: true, path: validation.path, deleted: true };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ok: false, error: "File or directory not found" };
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Create a directory
 */
export async function fileCreateDir({ dirPath, allowedRoots }) {
  const validation = validatePath(dirPath, allowedRoots);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  try {
    // Prevent creating directories through symlink/junction parents.
    const parentValidation = await validateParentDirNoSymlinkEscape(validation.path, allowedRoots);
    if (!parentValidation.ok) return { ok: false, error: parentValidation.error };

    // If the path exists and is a symlink, refuse (mkdir would follow in some cases).
    try {
      const ls = await fsp.lstat(validation.path);
      if (ls.isSymbolicLink()) return { ok: false, error: "Refusing to create directory on a symlink path" };
    } catch {
      // ignore (doesn't exist yet)
    }

    await fsp.mkdir(validation.path, { recursive: true });
    return { ok: true, path: validation.path, created: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Move/rename a file or directory
 */
export async function fileMove({ sourcePath, destPath, allowedRoots }) {
  const sourceValidation = validatePath(sourcePath, allowedRoots);
  if (!sourceValidation.ok) {
    return { ok: false, error: `Source: ${sourceValidation.error}` };
  }

  const destValidation = validatePath(destPath, allowedRoots);
  if (!destValidation.ok) {
    return { ok: false, error: `Destination: ${destValidation.error}` };
  }

  try {
    // Prevent moving files through symlink/junction parent dirs.
    const sourceParentValidation = await validateParentDirNoSymlinkEscape(sourceValidation.path, allowedRoots);
    if (!sourceParentValidation.ok) return { ok: false, error: `Source: ${sourceParentValidation.error}` };
    const destParentValidation = await validateParentDirNoSymlinkEscape(destValidation.path, allowedRoots);
    if (!destParentValidation.ok) return { ok: false, error: `Destination: ${destParentValidation.error}` };

    // Ensure destination directory exists
    await fsp.mkdir(path.dirname(destValidation.path), { recursive: true });
    await fsp.rename(sourceValidation.path, destValidation.path);

    return {
      ok: true,
      source: sourceValidation.path,
      destination: destValidation.path,
      moved: true,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
