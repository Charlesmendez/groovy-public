/**
 * File sanitization before uploading to Vercel.
 * Enforces static export, strips secrets and API routes.
 */

import type { InlinedFile } from "./deployments";

/** Files/dirs that must never be uploaded. */
const DENY_PATTERNS = [
  /^\.env/,
  /^\.env\..*/,
  /\.key$/,
  /\.pem$/,
  /^credentials\.json$/,
  /^secrets\..*/,
  /^connector\.json$/,
  /^node_modules\//,
  /^\.git\//,
  /^\.next\//,
  /^out\//,
];

/** Directories whose contents are stripped entirely. */
const STRIP_DIRS = [
  "app/api/",
  "pages/api/",
  "src/app/api/",
  "src/pages/api/",
];

const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_FILE_BYTES = 5 * 1024 * 1024;   // 5 MB per file

/** next.config.js/mjs content that enforces static export. */
const STATIC_EXPORT_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
};

module.exports = nextConfig;
`;

export type SanitizeResult = {
  files: InlinedFile[];
  strippedFiles: string[];
  warnings: string[];
};

/**
 * Sanitize a file list for safe Vercel deployment.
 * - Strips secret files, node_modules, API routes
 * - Overwrites next.config to enforce static export
 * - Enforces size limits
 */
export function sanitizeFiles(files: InlinedFile[]): SanitizeResult {
  const out: InlinedFile[] = [];
  const stripped: string[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  // Overwrite next.config.js (or .mjs) with static export config
  let hasNextConfig = false;

  for (const f of files) {
    const path = f.file;

    // Check deny patterns
    const basename = path.split("/").pop() || path;
    if (DENY_PATTERNS.some((re) => re.test(basename) || re.test(path))) {
      stripped.push(path);
      continue;
    }

    // Strip API route directories
    if (STRIP_DIRS.some((dir) => path.startsWith(dir))) {
      stripped.push(path);
      continue;
    }

    // Check file size
    const size = f.encoding === "base64"
      ? Math.ceil((f.data.length * 3) / 4)
      : Buffer.byteLength(f.data, "utf-8");

    if (size > MAX_FILE_BYTES) {
      warnings.push(`Skipped ${path}: exceeds 5MB limit (${(size / 1024 / 1024).toFixed(1)}MB)`);
      stripped.push(path);
      continue;
    }

    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      warnings.push(`Total upload exceeds 50MB limit; remaining files skipped starting at ${path}`);
      break;
    }

    // Intercept next.config.js / next.config.mjs
    if (/^next\.config\.(js|mjs|ts)$/.test(path)) {
      hasNextConfig = true;
      out.push({
        file: "next.config.js",
        data: STATIC_EXPORT_CONFIG,
        encoding: "utf-8",
      });
      continue;
    }

    out.push(f);
  }

  // Ensure next.config.js exists
  if (!hasNextConfig) {
    out.push({
      file: "next.config.js",
      data: STATIC_EXPORT_CONFIG,
      encoding: "utf-8",
    });
  }

  if (stripped.length > 0) {
    warnings.push(`Stripped ${stripped.length} file(s): ${stripped.slice(0, 10).join(", ")}${stripped.length > 10 ? "..." : ""}`);
  }

  return { files: out, strippedFiles: stripped, warnings };
}
