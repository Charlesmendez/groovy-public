/**
 * Obsidian Vault Operations Module
 * Handles search, read, and write operations on Obsidian vaults.
 */

import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import os from "os";

// Common Obsidian vault locations
const OBSIDIAN_COMMON_PATHS = [
  path.join(os.homedir(), "Documents"),
  path.join(os.homedir(), "Obsidian"),
  path.join(os.homedir(), "vaults"),
  path.join(os.homedir(), "Notes"),
  ...(process.platform === "win32"
    ? [
        path.join(os.homedir(), "OneDrive", "Documents"),
        path.join(os.homedir(), "OneDrive", "Obsidian"),
        path.join(os.homedir(), "AppData", "Roaming", "Obsidian"),
      ]
    : [
        // iCloud Obsidian (common on macOS)
        path.join(os.homedir(), "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents"),
        // Generic iCloud Drive folder (some users keep vaults here)
        path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs"),
      ]),
  os.homedir(),
];

function uniqVaults(vaults) {
  const seen = new Set();
  const out = [];
  for (const v of vaults) {
    const p = typeof v?.path === "string" ? path.resolve(v.path) : "";
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push({ name: v?.name || path.basename(p), path: p });
  }
  return out;
}

async function readObsidianVaultsFromConfig() {
  // Obsidian maintains a registry of vaults in obsidian.json. This is the most reliable
  // way to discover vaults (works for iCloud/Dropbox/custom locations) and matches
  // how the old implementation likely behaved.
  const home = os.homedir();

  const configPaths = [
    path.join(home, "Library", "Application Support", "obsidian", "obsidian.json"),
    path.join(home, "Library", "Application Support", "Obsidian", "obsidian.json"),
    path.join(home, ".config", "obsidian", "obsidian.json"),
    path.join(home, "AppData", "Roaming", "Obsidian", "obsidian.json"),
    path.join(home, "AppData", "Roaming", "obsidian", "obsidian.json"),
  ];

  for (const p of configPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = await fsp.readFile(p, "utf8");
      const json = JSON.parse(raw);
      const vaultsObj = json?.vaults;
      if (!vaultsObj || typeof vaultsObj !== "object") continue;

      const vaults = [];
      for (const v of Object.values(vaultsObj)) {
        const vp = v?.path;
        if (typeof vp !== "string" || !vp.trim()) continue;
        const resolved = path.resolve(vp);
        // Prefer actual vaults, but don't hard-fail if the .obsidian folder is missing;
        // some users keep the vault on external drives that may be temporarily disconnected.
        const name = typeof v?.name === "string" && v.name.trim() ? v.name.trim() : path.basename(resolved);
        vaults.push({ name, path: resolved });
      }

      if (vaults.length > 0) return uniqVaults(vaults);
    } catch {
      // ignore and continue
    }
  }

  return [];
}

/**
 * Check if a directory is an Obsidian vault
 */
function isObsidianVault(dirPath) {
  try {
    return fs.existsSync(path.join(dirPath, ".obsidian"));
  } catch {
    return false;
  }
}

/**
 * Discover Obsidian vaults in common locations
 */
export async function discoverVaults() {
  // 1) Best-effort: read Obsidian's own vault registry
  const configVaults = await readObsidianVaultsFromConfig();
  if (configVaults.length > 0) {
    return { ok: true, vaults: configVaults };
  }

  // 2) Fallback: scan common locations (1-level deep)
  const vaults = [];
  const seen = new Set();

  for (const basePath of OBSIDIAN_COMMON_PATHS) {
    try {
      if (!fs.existsSync(basePath)) continue;

      // Check if the path itself is a vault
      if (isObsidianVault(basePath)) {
        const resolved = path.resolve(basePath);
        if (!seen.has(resolved)) {
          seen.add(resolved);
          vaults.push({
            name: path.basename(basePath),
            path: resolved,
          });
        }
        continue;
      }

      // Check subdirectories (1 level deep)
      const items = await fsp.readdir(basePath, { withFileTypes: true });
      for (const item of items) {
        if (!item.isDirectory() || item.name.startsWith(".")) continue;

        const fullPath = path.join(basePath, item.name);
        if (isObsidianVault(fullPath)) {
          const resolved = path.resolve(fullPath);
          if (!seen.has(resolved)) {
            seen.add(resolved);
            vaults.push({
              name: item.name,
              path: resolved,
            });
          }
        }
      }
    } catch {
      // Skip inaccessible paths
    }
  }

  return { ok: true, vaults };
}

function normalizeForCompare(p) {
  const normalized = path.normalize(String(p || ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinRootPath(targetPath, rootPath) {
  const target = normalizeForCompare(path.normalize(String(targetPath || "")));
  const root = normalizeForCompare(path.normalize(String(rootPath || "")));
  if (!target || !root) return false;
  return target === root || target.startsWith(root + path.sep);
}

function normalizeNotePath(notePath) {
  if (!notePath || typeof notePath !== "string") return "";
  const raw = String(notePath || "").replace(/\0/g, "").trim();
  if (!raw) return "";
  if (path.isAbsolute(raw)) return "";
  const normalized = path.normalize(raw);
  if (normalized === ".." || normalized.startsWith(".." + path.sep)) return "";
  return normalized;
}

async function resolveRealpathSafe(p) {
  try {
    return await fsp.realpath(String(p || ""));
  } catch {
    return null;
  }
}

/**
 * Validate a vault path
 */
function validateVaultPath(vaultPath) {
  if (!vaultPath || typeof vaultPath !== "string") {
    return { ok: false, error: "Vault path is required" };
  }

  const resolved = path.resolve(vaultPath);

  if (!fs.existsSync(resolved)) {
    return { ok: false, error: "Vault path does not exist" };
  }

  if (!isObsidianVault(resolved)) {
    return { ok: false, error: "Path is not an Obsidian vault (no .obsidian folder)" };
  }

  let realPath = resolved;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    // ignore and use resolved
  }
  return { ok: true, path: resolved, realPath };
}

/**
 * Parse YAML frontmatter from markdown content
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: null, body: content };

  const frontmatterStr = match[1];
  const body = content.slice(match[0].length);

  // Simple YAML parsing (key: value pairs)
  const frontmatter = {};
  for (const line of frontmatterStr.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1).trim();
      
      // Handle arrays (simple case: [item1, item2])
      if (value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((v) => v.trim().replace(/^["']|["']$/g, ""));
      } else {
        // Remove quotes
        value = value.replace(/^["']|["']$/g, "");
      }
      
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/**
 * Extract tags from markdown content (both frontmatter and inline)
 */
function extractTags(content, frontmatter) {
  const tags = new Set();

  // Tags from frontmatter
  if (frontmatter?.tags) {
    const fmTags = Array.isArray(frontmatter.tags)
      ? frontmatter.tags
      : [frontmatter.tags];
    fmTags.forEach((t) => tags.add(t.replace(/^#/, "")));
  }

  // Inline tags (#tag)
  const inlineTags = content.match(/#[\w\-\/]+/g) || [];
  inlineTags.forEach((t) => tags.add(t.slice(1)));

  return Array.from(tags);
}

/**
 * Extract links from markdown content
 */
function extractLinks(content) {
  const links = [];

  // Wiki links [[note]] or [[note|alias]]
  const wikiLinks = content.match(/\[\[([^\]]+)\]\]/g) || [];
  for (const link of wikiLinks) {
    const inner = link.slice(2, -2);
    const [target, alias] = inner.split("|");
    links.push({ type: "wiki", target: target.trim(), alias: alias?.trim() });
  }

  // Markdown links [text](url)
  const mdLinks = content.match(/\[([^\]]*)\]\(([^)]+)\)/g) || [];
  for (const link of mdLinks) {
    const match = link.match(/\[([^\]]*)\]\(([^)]+)\)/);
    if (match) {
      links.push({ type: "markdown", text: match[1], url: match[2] });
    }
  }

  return links;
}

/**
 * Read a note from the vault
 */
export async function obsidianRead({ vaultPath, notePath }) {
  const validation = validateVaultPath(vaultPath);
  if (!validation.ok) return validation;

  if (!notePath || typeof notePath !== "string") {
    return { ok: false, error: "Note path is required" };
  }

  const vaultRoot = validation.realPath || validation.path;
  const safeNotePath = normalizeNotePath(notePath);
  if (!safeNotePath) {
    return { ok: false, error: "Path traversal not allowed" };
  }

  // Ensure .md extension
  const normalizedPath = safeNotePath.endsWith(".md") ? safeNotePath : `${safeNotePath}.md`;
  const fullPath = path.resolve(vaultRoot, normalizedPath);

  // Security: ensure we're still within the vault
  if (!isWithinRootPath(fullPath, vaultRoot)) {
    return { ok: false, error: "Path traversal not allowed" };
  }

  try {
    const realFullPath = await resolveRealpathSafe(fullPath);
    if (!realFullPath) {
      return { ok: false, error: "Note not found" };
    }
    if (!isWithinRootPath(realFullPath, vaultRoot)) {
      return { ok: false, error: "Path traversal not allowed" };
    }

    const content = await fsp.readFile(realFullPath, "utf8");
    const stats = await fsp.stat(realFullPath);
    const { frontmatter, body } = parseFrontmatter(content);
    const tags = extractTags(content, frontmatter);
    const links = extractLinks(content);

    return {
      ok: true,
      path: normalizedPath,
      fullPath: realFullPath,
      content,
      body,
      frontmatter,
      tags,
      links,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      created: stats.birthtime.toISOString(),
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ok: false, error: "Note not found" };
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Write/create a note in the vault
 */
export async function obsidianWrite({
  vaultPath,
  notePath,
  content,
  createDirs = true,
}) {
  const validation = validateVaultPath(vaultPath);
  if (!validation.ok) return validation;

  if (!notePath || typeof notePath !== "string") {
    return { ok: false, error: "Note path is required" };
  }

  if (typeof content !== "string") {
    return { ok: false, error: "Content must be a string" };
  }

  const vaultRoot = validation.realPath || validation.path;
  const safeNotePath = normalizeNotePath(notePath);
  if (!safeNotePath) {
    return { ok: false, error: "Path traversal not allowed" };
  }

  // Ensure .md extension
  const normalizedPath = safeNotePath.endsWith(".md") ? safeNotePath : `${safeNotePath}.md`;
  const fullPath = path.resolve(vaultRoot, normalizedPath);

  // Security: ensure we're still within the vault
  if (!isWithinRootPath(fullPath, vaultRoot)) {
    return { ok: false, error: "Path traversal not allowed" };
  }

  try {
    // Prevent writing through symlinks (including junction-based escapes).
    try {
      const st = await fsp.lstat(fullPath);
      if (st.isSymbolicLink()) {
        return { ok: false, error: "Path traversal not allowed" };
      }
    } catch {
      // ignore (file may not exist)
    }

    // Ensure the nearest existing parent directory resolves within the vault.
    let parent = path.dirname(fullPath);
    while (parent && !fs.existsSync(parent)) {
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    const parentReal = await resolveRealpathSafe(parent);
    if (parentReal && !isWithinRootPath(parentReal, vaultRoot)) {
      return { ok: false, error: "Path traversal not allowed" };
    }

    if (createDirs) {
      await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    }

    const isNew = !fs.existsSync(fullPath);
    await fsp.writeFile(fullPath, content, "utf8");
    const stats = await fsp.stat(fullPath);

    return {
      ok: true,
      path: normalizedPath,
      fullPath,
      created: isNew,
      updated: !isNew,
      size: stats.size,
      modified: stats.mtime.toISOString(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Search for notes in the vault
 */
export async function obsidianSearch({
  vaultPath,
  query,
  searchContent = true,
  searchTags = true,
  maxResults = 30,
}) {
  const validation = validateVaultPath(vaultPath);
  if (!validation.ok) return validation;
  const vaultRoot = validation.realPath || validation.path;

  if (!query || typeof query !== "string") {
    return { ok: false, error: "Search query is required" };
  }

  const results = [];
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(Boolean);

  async function searchDir(dir, relativePath = "") {
    if (results.length >= maxResults) return;

    try {
      const items = await fsp.readdir(dir, { withFileTypes: true });

      for (const item of items) {
        if (results.length >= maxResults) break;

        // Skip hidden files and .obsidian folder
        if (item.name.startsWith(".")) continue;

        const fullPath = path.join(dir, item.name);
        const itemRelPath = relativePath
          ? `${relativePath}/${item.name}`
          : item.name;

        if (item.isDirectory()) {
          const realDir = await resolveRealpathSafe(fullPath);
          if (!realDir || !isWithinRootPath(realDir, vaultRoot)) continue;
          await searchDir(fullPath, itemRelPath);
        } else if (item.name.endsWith(".md")) {
          try {
            const realFile = await resolveRealpathSafe(fullPath);
            if (!realFile || !isWithinRootPath(realFile, vaultRoot)) continue;
            const content = await fsp.readFile(realFile, "utf8");
            const stats = await fsp.stat(realFile);
            const { frontmatter, body } = parseFrontmatter(content);
            const tags = extractTags(content, frontmatter);

            let score = 0;
            const matches = [];

            // Check filename
            const filenameLower = item.name.toLowerCase();
            for (const term of queryTerms) {
              if (filenameLower.includes(term)) {
                score += 10;
                matches.push({ type: "filename", term });
              }
            }

            // Check tags
            if (searchTags) {
              for (const tag of tags) {
                const tagLower = tag.toLowerCase();
                for (const term of queryTerms) {
                  if (tagLower.includes(term)) {
                    score += 5;
                    matches.push({ type: "tag", tag, term });
                  }
                }
              }
            }

            // Check content
            if (searchContent) {
              const contentLower = content.toLowerCase();
              for (const term of queryTerms) {
                const index = contentLower.indexOf(term);
                if (index >= 0) {
                  score += 3;

                  // Extract context around match
                  const start = Math.max(0, index - 50);
                  const end = Math.min(content.length, index + term.length + 50);
                  const preview = content.slice(start, end).replace(/\n/g, " ");

                  matches.push({
                    type: "content",
                    term,
                    preview: (start > 0 ? "..." : "") + preview + (end < content.length ? "..." : ""),
                  });
                }
              }
            }

            // Check frontmatter title
            if (frontmatter?.title) {
              const titleLower = String(frontmatter.title).toLowerCase();
              for (const term of queryTerms) {
                if (titleLower.includes(term)) {
                  score += 8;
                  matches.push({ type: "title", term });
                }
              }
            }

            if (score > 0) {
              results.push({
                path: itemRelPath.replace(/\.md$/, ""),
                fullPath: realFile,
                filename: item.name,
                title: frontmatter?.title || item.name.replace(/\.md$/, ""),
                tags,
                score,
                matches,
                modified: stats.mtime.toISOString(),
                excerpt: body.slice(0, 200).replace(/\n/g, " ").trim(),
              });
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  await searchDir(vaultRoot);

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return {
    ok: true,
    query,
    vaultPath: vaultRoot,
    results: results.slice(0, maxResults),
    count: results.length,
    truncated: results.length >= maxResults,
  };
}

/**
 * List all notes in the vault
 */
export async function obsidianList({ vaultPath, maxDepth = 10 }) {
  const validation = validateVaultPath(vaultPath);
  if (!validation.ok) return validation;
  const vaultRoot = validation.realPath || validation.path;

  const notes = [];
  const folders = [];

  async function listDir(dir, relativePath = "", depth = 0) {
    if (depth > maxDepth) return;

    try {
      const items = await fsp.readdir(dir, { withFileTypes: true });

      for (const item of items) {
        if (item.name.startsWith(".")) continue;

        const fullPath = path.join(dir, item.name);
        const itemRelPath = relativePath
          ? `${relativePath}/${item.name}`
          : item.name;

        if (item.isDirectory()) {
          const realDir = await resolveRealpathSafe(fullPath);
          if (!realDir || !isWithinRootPath(realDir, vaultRoot)) continue;
          folders.push({
            name: item.name,
            path: itemRelPath,
          });
          await listDir(fullPath, itemRelPath, depth + 1);
        } else if (item.name.endsWith(".md")) {
          try {
            const realFile = await resolveRealpathSafe(fullPath);
            if (!realFile || !isWithinRootPath(realFile, vaultRoot)) continue;
            const stats = await fsp.stat(realFile);
            notes.push({
              name: item.name.replace(/\.md$/, ""),
              path: itemRelPath.replace(/\.md$/, ""),
              fullPath: realFile,
              modified: stats.mtime.toISOString(),
              size: stats.size,
            });
          } catch {
            // Skip
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  await listDir(vaultRoot);

  return {
    ok: true,
    vaultPath: vaultRoot,
    notes,
    folders,
    noteCount: notes.length,
    folderCount: folders.length,
  };
}

/**
 * Delete a note from the vault
 */
export async function obsidianDelete({ vaultPath, notePath }) {
  const validation = validateVaultPath(vaultPath);
  if (!validation.ok) return validation;

  if (!notePath || typeof notePath !== "string") {
    return { ok: false, error: "Note path is required" };
  }

  const vaultRoot = validation.realPath || validation.path;
  const safeNotePath = normalizeNotePath(notePath);
  if (!safeNotePath) {
    return { ok: false, error: "Path traversal not allowed" };
  }

  const normalizedPath = safeNotePath.endsWith(".md") ? safeNotePath : `${safeNotePath}.md`;
  const fullPath = path.resolve(vaultRoot, normalizedPath);

  if (!isWithinRootPath(fullPath, vaultRoot)) {
    return { ok: false, error: "Path traversal not allowed" };
  }

  try {
    const realFullPath = await resolveRealpathSafe(fullPath);
    if (!realFullPath) return { ok: false, error: "Note not found" };
    if (!isWithinRootPath(realFullPath, vaultRoot)) {
      return { ok: false, error: "Path traversal not allowed" };
    }
    await fsp.unlink(realFullPath);
    return { ok: true, path: normalizedPath, deleted: true };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ok: false, error: "Note not found" };
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Get daily note path based on vault settings or default
 */
export function getDailyNotePath(vaultPath, date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  // Default format: YYYY-MM-DD
  return `${year}-${month}-${day}`;
}

/**
 * Create or append to daily note
 */
export async function obsidianDailyNote({ vaultPath, content, append = true }) {
  const validation = validateVaultPath(vaultPath);
  if (!validation.ok) return validation;

  const vaultRoot = validation.realPath || validation.path;
  const notePath = getDailyNotePath(vaultRoot);
  const fullPath = path.join(vaultRoot, `${notePath}.md`);

  try {
    let existingContent = "";
    let isNew = true;

    try {
      const existingReal = await resolveRealpathSafe(fullPath);
      if (existingReal) {
        if (!isWithinRootPath(existingReal, vaultRoot)) {
          return { ok: false, error: "Path traversal not allowed" };
        }
        existingContent = await fsp.readFile(existingReal, "utf8");
        isNew = false;
      }
    } catch {
      // File doesn't exist, will create new
    }

    const finalContent = append && existingContent
      ? `${existingContent}\n\n${content}`
      : content || `# ${notePath}\n\n`;

    await fsp.writeFile(fullPath, finalContent, "utf8");
    const stats = await fsp.stat(fullPath);

    return {
      ok: true,
      path: notePath,
      fullPath,
      created: isNew,
      appended: append && !isNew,
      size: stats.size,
      modified: stats.mtime.toISOString(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
