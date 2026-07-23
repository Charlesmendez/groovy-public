const VALID_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

const RESERVED_TOP_LEVEL_FILES = new Set([
  "index.md",
  "log.md",
  "schema.md",
]);

const ALLOWED_TOP_LEVEL_DIRS = new Set([
  "entities",
  "concepts",
  "projects",
  "sources",
  "ui",
  "profiles",
]);

const UI_ALLOWED_FILES = new Set(["canvas.html"]);

export type WikiPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export function validateWikiPath(input: unknown): WikiPathResult {
  if (typeof input !== "string") return { ok: false, reason: "path must be a string" };

  const raw = input.trim();
  if (!raw) return { ok: false, reason: "path is empty" };
  if (raw.includes("\0")) return { ok: false, reason: "path has null byte" };
  if (raw.startsWith("/")) return { ok: false, reason: "path must be relative" };
  if (raw.includes("\\")) return { ok: false, reason: "path uses backslash" };
  if (raw.length > 200) return { ok: false, reason: "path too long" };

  const segments = raw.split("/");
  for (const segment of segments) {
    if (!segment) return { ok: false, reason: "empty segment" };
    if (segment === "." || segment === "..") return { ok: false, reason: "traversal" };
    if (!VALID_SEGMENT.test(segment)) {
      return { ok: false, reason: `invalid segment: ${segment}` };
    }
  }

  if (segments.length === 1) {
    if (!RESERVED_TOP_LEVEL_FILES.has(segments[0])) {
      return { ok: false, reason: "top-level files must be index.md, log.md, or schema.md" };
    }
    return { ok: true, path: raw };
  }

  const [top, ...rest] = segments;
  if (!ALLOWED_TOP_LEVEL_DIRS.has(top)) {
    return { ok: false, reason: `unknown directory: ${top}` };
  }

  if (top === "profiles") {
    if (rest.length < 2) {
      return { ok: false, reason: "profiles paths require a profile id and file" };
    }
    const [profileId, profileTop, ...profileRest] = rest;
    if (!/^[a-f0-9-]{16,64}$/i.test(profileId)) {
      return { ok: false, reason: "invalid profile id" };
    }
    if (profileRest.length === 0) {
      if (!RESERVED_TOP_LEVEL_FILES.has(profileTop)) {
        return { ok: false, reason: "profile top-level files must be index.md, log.md, or schema.md" };
      }
      return { ok: true, path: raw };
    }
    if (!["entities", "concepts", "projects", "sources"].includes(profileTop)) {
      return { ok: false, reason: `unknown profile directory: ${profileTop}` };
    }
    const profileLeaf = profileRest[profileRest.length - 1];
    if (!profileLeaf.endsWith(".md")) {
      return { ok: false, reason: "profile content files must end with .md" };
    }
    return { ok: true, path: raw };
  }

  const leaf = rest[rest.length - 1];
  if (top === "ui") {
    if (rest.length !== 1 || !UI_ALLOWED_FILES.has(leaf)) {
      return { ok: false, reason: "ui/ allows only canvas.html" };
    }
    return { ok: true, path: raw };
  }

  if (!leaf.endsWith(".md")) {
    return { ok: false, reason: "files under content directories must end with .md" };
  }

  return { ok: true, path: raw };
}

export function storageKey(userId: string, relativePath: string): string {
  return `${userId}/${relativePath}`;
}

export const WIKI_BUCKET = "wiki";

export const WELL_KNOWN = {
  index: "index.md",
  log: "log.md",
  schema: "schema.md",
  canvas: "ui/canvas.html",
} as const;
