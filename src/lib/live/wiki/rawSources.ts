import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_RAW_SOURCE_BYTES } from "../limits";

export const RAW_SOURCES_BUCKET = "wiki_raw_sources";

export type RawSourceRecord = {
  bucket: typeof RAW_SOURCES_BUCKET;
  storagePath: string;
  ref: string;
  title: string;
  url: string | null;
  sha256: string;
  markdown: string;
};

export async function storeRawSource(args: {
  supabase: SupabaseClient;
  userId: string;
  title: string;
  content: string;
  url?: string | null;
}): Promise<RawSourceRecord> {
  const title = normalizeTitle(args.title, args.content);
  const content = args.content.trim();
  if (!content) {
    throw new Error("Source content is required");
  }

  const sha256 = createHash("sha256").update(content).digest("hex");
  const createdAt = new Date().toISOString();
  const date = createdAt.slice(0, 10);
  const slug = slugify(title);
  const storagePath = `${args.userId}/${date}-${slug}-${sha256.slice(0, 12)}.md`;
  const url = normalizeUrl(args.url);
  const markdown = renderRawSourceMarkdown({
    title,
    content,
    url,
    sha256,
    createdAt,
    ref: `raw://${RAW_SOURCES_BUCKET}/${storagePath}`,
  });
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > MAX_RAW_SOURCE_BYTES) {
    throw new Error(`Raw source too large (${bytes} bytes, max ${MAX_RAW_SOURCE_BYTES})`);
  }

  const { error } = await args.supabase.storage
    .from(RAW_SOURCES_BUCKET)
    .upload(storagePath, markdown, {
      upsert: false,
      contentType: "text/markdown; charset=utf-8",
    });
  if (error) {
    if (isDuplicateStorageObjectError(error)) {
      return {
        bucket: RAW_SOURCES_BUCKET,
        storagePath,
        ref: `raw://${RAW_SOURCES_BUCKET}/${storagePath}`,
        title,
        url,
        sha256,
        markdown,
      };
    }
    throw new Error(`write raw source: ${error.message}`);
  }

  return {
    bucket: RAW_SOURCES_BUCKET,
    storagePath,
    ref: `raw://${RAW_SOURCES_BUCKET}/${storagePath}`,
    title,
    url,
    sha256,
    markdown,
  };
}

function isDuplicateStorageObjectError(error: { message?: string; statusCode?: string | number; error?: string }): boolean {
  const statusCode = typeof error.statusCode === "number" ? error.statusCode : Number(error.statusCode);
  if (statusCode === 409) return true;

  const text = `${error.message ?? ""} ${error.error ?? ""}`.toLowerCase();
  return text.includes("already exists") || text.includes("duplicate");
}

function renderRawSourceMarkdown(args: {
  title: string;
  content: string;
  url: string | null;
  sha256: string;
  createdAt: string;
  ref: string;
}): string {
  return `---
title: ${JSON.stringify(args.title)}
created: ${JSON.stringify(args.createdAt)}
url: ${JSON.stringify(args.url)}
sha256: ${JSON.stringify(args.sha256)}
immutable: true
---

# ${args.title}

${args.url ? `Source URL: ${args.url}\n\n` : ""}Raw source ref: \`${args.ref}\`

## Content

${args.content}
`;
}

function normalizeTitle(title: string, content: string): string {
  const cleanTitle = title.trim().replace(/\s+/g, " ");
  if (cleanTitle) return cleanTitle.slice(0, 120);
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine || "Untitled source").slice(0, 120);
}

function normalizeUrl(value?: string | null): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "source";
}
