import type { SupabaseClient } from "@supabase/supabase-js";
import { storageKey, validateWikiPath, WIKI_BUCKET, WELL_KNOWN } from "./paths";
import { MAX_WIKI_FILE_BYTES } from "../limits";

const TEXT_DECODER = new TextDecoder("utf-8");

export type WikiFile = { path: string; content: string };

export class WikiClient {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly userId: string
  ) {}

  async read(relativePath: string): Promise<string | null> {
    const v = validateWikiPath(relativePath);
    if (!v.ok) throw new WikiError(`bad path: ${v.reason}`);
    const { data, error } = await this.supabase.storage
      .from(WIKI_BUCKET)
      .download(storageKey(this.userId, v.path));
    if (error) {
      if (isNotFoundError(error)) return null;
      throw new WikiError(`read ${v.path}: ${error.message}`);
    }
    if (!data) return null;
    if (typeof data.size === "number" && data.size > MAX_WIKI_FILE_BYTES) {
      throw new WikiError(`read ${v.path}: file too large (${data.size} bytes)`);
    }
    const buffer = await data.arrayBuffer();
    if (buffer.byteLength > MAX_WIKI_FILE_BYTES) {
      throw new WikiError(`read ${v.path}: file too large (${buffer.byteLength} bytes)`);
    }
    return TEXT_DECODER.decode(buffer);
  }

  async write(relativePath: string, content: string): Promise<void> {
    await this.upload(relativePath, content, true);
  }

  async writeIfAbsent(relativePath: string, content: string): Promise<boolean> {
    try {
      await this.upload(relativePath, content, false);
      return true;
    } catch (error) {
      if (error instanceof WikiError && error.code === "already_exists") {
        return false;
      }
      throw error;
    }
  }

  private async upload(
    relativePath: string,
    content: string,
    upsert: boolean
  ): Promise<void> {
    const v = validateWikiPath(relativePath);
    if (!v.ok) throw new WikiError(`bad path: ${v.reason}`);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_WIKI_FILE_BYTES) {
      throw new WikiError(`file too large (${bytes} bytes, max ${MAX_WIKI_FILE_BYTES})`);
    }
    const contentType = v.path.endsWith(".html")
      ? "text/html; charset=utf-8"
      : "text/markdown; charset=utf-8";
    const { error } = await this.supabase.storage
      .from(WIKI_BUCKET)
      .upload(storageKey(this.userId, v.path), content, {
        upsert,
        contentType,
      });
    if (error) {
      if (!upsert && isAlreadyExistsError(error)) {
        throw new WikiError(`write ${v.path}: already exists`, "already_exists");
      }
      throw new WikiError(`write ${v.path}: ${error.message}`);
    }
  }

  async list(prefix?: string): Promise<string[]> {
    const safePrefix = (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
    const fullPrefix = safePrefix ? `${this.userId}/${safePrefix}` : this.userId;
    const out: string[] = [];
    const stack: string[] = [fullPrefix];
    while (stack.length) {
      const dir = stack.pop()!;
      const { data, error } = await this.supabase.storage
        .from(WIKI_BUCKET)
        .list(dir, { limit: 1000, sortBy: { column: "name", order: "asc" } });
      if (error) throw new WikiError(`list ${dir}: ${error.message}`);
      if (!data) continue;
      for (const entry of data) {
        if (!entry.name) continue;
        const next = `${dir}/${entry.name}`;
        if (entry.id === null) {
          stack.push(next);
        } else {
          out.push(next.slice(this.userId.length + 1));
        }
      }
    }
    return out.sort();
  }

  async search(query: string, limit = 8, prefix?: string): Promise<WikiFile[]> {
    const terms = searchTerms(query);
    if (terms.length === 0) return [];
    const allPaths = (await this.list(prefix))
      .filter((p) => p.endsWith(".md") && p !== WELL_KNOWN.log && p !== WELL_KNOWN.schema)
      .slice(0, 80);
    const files = await Promise.all(
      allPaths.map(async (path) => ({ path, content: await this.read(path) }))
    );
    const scored: Array<WikiFile & { score: number }> = [];
    for (const { path, content } of files) {
      if (!content) continue;
      const pathLower = path.toLowerCase();
      const contentLower = content.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (pathLower.includes(term)) score += 4;
        if (contentLower.includes(term)) score += 1;
      }
      if (score > 0) scored.push({ path, content, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, Math.max(1, Math.min(limit, 8)))
      .map(({ path, content }) => ({ path, content }));
  }

  async appendLog(line: string, relativePath: string = WELL_KNOWN.log): Promise<void> {
    const prior = (await this.read(relativePath)) ?? "";
    const stamp = new Date().toISOString().slice(0, 10);
    const entry = `## [${stamp}] ${line.trim()}\n`;
    await this.write(relativePath, fitLogToMaxBytes(prior + entry));
  }

  async remove(relativePath: string): Promise<void> {
    const v = validateWikiPath(relativePath);
    if (!v.ok) throw new WikiError(`bad path: ${v.reason}`);
    const { error } = await this.supabase.storage
      .from(WIKI_BUCKET)
      .remove([storageKey(this.userId, v.path)]);
    if (error) throw new WikiError(`remove ${v.path}: ${error.message}`);
  }
}

const SEARCH_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "before",
  "from",
  "have",
  "into",
  "just",
  "like",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "this",
  "turn",
  "user",
  "what",
  "when",
  "where",
  "with",
  "your",
]);

function searchTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of query.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (term.length < 3 || SEARCH_STOP_WORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= 12) break;
  }
  return terms;
}

function fitLogToMaxBytes(log: string): string {
  if (Buffer.byteLength(log, "utf8") <= MAX_WIKI_FILE_BYTES) return log;

  const entries = log
    .split(/\n(?=## \[\d{4}-\d{2}-\d{2}\] )/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  while (entries.length > 1 && Buffer.byteLength(`${entries.join("\n")}\n`, "utf8") > MAX_WIKI_FILE_BYTES) {
    entries.shift();
  }

  let next = `${entries.join("\n")}\n`;
  while (Buffer.byteLength(next, "utf8") > MAX_WIKI_FILE_BYTES && next.length > 0) {
    next = next.slice(Math.ceil(next.length * 0.1));
  }
  return next;
}

export class WikiError extends Error {
  constructor(
    message: string,
    readonly code?: "already_exists"
  ) {
    super(message);
    this.name = "WikiError";
  }
}

function isAlreadyExistsError(error: {
  message?: string;
  statusCode?: string | number;
  error?: string;
}): boolean {
  const status = String(error.statusCode ?? "");
  const message = `${error.error || ""} ${error.message || ""}`.toLowerCase();
  return (
    status === "409" ||
    message.includes("already exists") ||
    message.includes("duplicate") ||
    message.includes("resource exists")
  );
}

function isNotFoundError(error: { message?: string; statusCode?: string | number; error?: string }): boolean {
  const message = error.message?.toLowerCase() ?? "";
  const status = String(error.statusCode ?? "");
  const code = error.error?.toLowerCase() ?? "";
  const parsed = parseStorageErrorMessage(error.message);

  return (
    message.includes("not found") ||
    message.includes("object not found") ||
    code.includes("not_found") ||
    status === "404" ||
    parsed?.statusCode === "404" ||
    parsed?.statusCode === 404 ||
    parsed?.error?.toLowerCase?.().includes("not_found") ||
    isUrlOnlyStorageReadError(parsed)
  );
}

function parseStorageErrorMessage(
  message: string | undefined
): { statusCode?: string | number; error?: string; message?: string; url?: string } | null {
  if (!message) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isUrlOnlyStorageReadError(
  parsed: { statusCode?: string | number; error?: string; message?: string; url?: string } | null
): boolean {
  if (!parsed?.url) return false;
  return Object.keys(parsed).length === 1 && /\/storage\/v1\/object\/wiki\//.test(parsed.url);
}
