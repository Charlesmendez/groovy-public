import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureWikiBootstrapped } from "@/lib/live/wiki/bootstrap";
import { WikiClient } from "@/lib/live/wiki/client";
import { withWikiMutationLock } from "@/lib/live/wiki/mutationLock";
import { validateWikiPath } from "@/lib/live/wiki/paths";

const MAX_LEARNING_CHARS = 1200;
const MAX_READ_CHARS = 8000;
const MAX_SEARCH_CHARS = 10000;

export type WikiLearningCategory = "entities" | "concepts" | "projects";

export type WikiLearningTarget = {
  category?: WikiLearningCategory;
  page?: string;
  title?: string;
};

export type WikiLearningResult = {
  filed: boolean;
  path?: string;
  created?: boolean;
  reason?: string;
};

type WikiContext = {
  supabase: SupabaseClient;
  userId: string;
  profileId?: string;
};

function profilePrefix(profileId?: string): string {
  const normalized = typeof profileId === "string" ? profileId.trim() : "";
  return normalized ? `profiles/${normalized}` : "";
}

function scopeWikiPath(path: string, profileId?: string): string {
  const prefix = profilePrefix(profileId);
  if (!prefix || path.startsWith(`${prefix}/`)) return path;
  return `${prefix}/${path}`;
}

export async function searchWikiKnowledge(
  context: WikiContext,
  query: string,
  limit = 5
): Promise<Array<{ path: string; content: string }>> {
  const client = new WikiClient(context.supabase, context.userId);
  const prefix = profilePrefix(context.profileId);
  const matches = await client.search(
    query,
    Math.max(1, Math.min(limit, 8)),
    prefix || undefined,
  );
  let remaining = MAX_SEARCH_CHARS;

  return matches
    .filter(({ path }) => !prefix || path.startsWith(`${prefix}/`))
    .map(({ path, content }) => {
    const excerpt = content.slice(0, Math.max(0, Math.min(remaining, 3500)));
    remaining -= excerpt.length;
    return {
      path,
      content: excerpt.length < content.length ? `${excerpt}\n...(truncated)` : excerpt,
    };
    });
}

export async function readWikiKnowledge(
  context: WikiContext,
  path: string
): Promise<{ path: string; content: string | null }> {
  const client = new WikiClient(context.supabase, context.userId);
  const scopedPath = scopeWikiPath(path, context.profileId);
  const content = await client.read(scopedPath);
  if (content == null) return { path: scopedPath, content: null };
  return {
    path: scopedPath,
    content:
      content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS)}\n...(truncated)`
        : content,
  };
}

export async function fileLearningToWiki(input: {
  supabase: SupabaseClient;
  userId: string;
  content: string;
  label?: string;
  source?: string;
  target?: WikiLearningTarget;
  profileId?: string;
}): Promise<WikiLearningResult> {
  const content = compactLearning(input.content);
  if (!content) return { filed: false, reason: "empty_learning" };
  const sensitiveMaterial = [
    input.content,
    input.label,
    input.target?.page,
    input.target?.title,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (containsSecretLikeMaterial(sensitiveMaterial)) {
    return { filed: false, reason: "secret_like_material_blocked" };
  }

  const category = resolveCategory(
    input.target?.category,
    input.target?.page,
    input.label
  );
  const path = scopeWikiPath(
    resolveLearningPath(category, input.target, input.label),
    input.profileId,
  );
  const validated = validateWikiPath(path);
  const requiredPrefix = input.profileId
    ? `${profilePrefix(input.profileId)}/${category}/`
    : `${category}/`;
  const logPath = scopeWikiPath("log.md", input.profileId);
  if (!validated.ok || !validated.path.startsWith(requiredPrefix)) {
    return { filed: false, reason: `invalid_wiki_path: ${validated.ok ? path : validated.reason}` };
  }

  return withWikiMutationLock(input.userId, async () => {
    const client = new WikiClient(input.supabase, input.userId);
    await ensureWikiBootstrapped(client);

    const existing = await client.read(validated.path);
    if (existing && containsEquivalentLearning(existing, content)) {
      await client.appendLog(
        `noop | learning already present in ${validated.path}`,
        logPath,
      );
      return {
        filed: false,
        path: validated.path,
        created: false,
        reason: "duplicate",
      };
    }

    const now = new Date().toISOString();
    const date = now.slice(0, 10);
    const title =
      compactTitle(input.target?.title) ||
      titleFromSlug(validated.path.split("/").pop()?.replace(/\.md$/i, "") || "memory learnings");
    const source = sanitizeInline(input.source || "orchestrator memory");
    const entry = `- [${date}] ${content} _(source: ${source})_`;
    const nextContent = existing
      ? appendLearning(updateFrontmatterTimestamp(existing, now), entry)
      : createLearningPage({
          title,
          now,
          category,
          label: input.label,
          source,
          entry,
        });

    await client.write(validated.path, nextContent);
    if (!existing) {
      await addPageToIndex(client, category, validated.path, title, input.profileId);
    }
    await client.appendLog(
      `${existing ? "update" : "ingest"} | filed memory learning in ${validated.path}`,
      logPath,
    );

    return {
      filed: true,
      path: validated.path,
      created: !existing,
    };
  });
}

function resolveCategory(
  requested: WikiLearningCategory | undefined,
  requestedPage: string | undefined,
  label: string | undefined
): WikiLearningCategory {
  if (requested) return requested;
  const pathCategory = requestedPage?.trim().split("/")[0];
  if (
    pathCategory === "entities" ||
    pathCategory === "concepts" ||
    pathCategory === "projects"
  ) {
    return pathCategory;
  }
  const normalized = (label || "").toLowerCase();
  if (/\b(project|initiative|workstream|roadmap)\b/.test(normalized)) return "projects";
  if (/\b(entity|person|people|company|product|place|organization)\b/.test(normalized)) {
    return "entities";
  }
  return "concepts";
}

function resolveLearningPath(
  category: WikiLearningCategory,
  target: WikiLearningTarget | undefined,
  label: string | undefined
): string {
  const requestedPage = target?.page?.trim();
  if (requestedPage) {
    if (requestedPage.includes("/")) {
      return requestedPage.endsWith(".md") ? requestedPage : `${requestedPage}.md`;
    }
    const slug = slugify(requestedPage.replace(/\.md$/i, ""));
    if (slug) return `${category}/${slug}.md`;
  }

  const requestedTitleSlug = slugify(target?.title || "");
  if (requestedTitleSlug) return `${category}/${requestedTitleSlug}.md`;

  const normalizedLabel = (label || "").toLowerCase();
  if (category === "projects") return "projects/project-learnings.md";
  if (category === "entities") return "entities/entity-learnings.md";
  if (/\b(preference|constraint|instruction|standing rule)\b/.test(normalizedLabel)) {
    return "concepts/user-preferences.md";
  }
  if (/\b(decision|choice)\b/.test(normalizedLabel)) {
    return "concepts/standing-decisions.md";
  }
  return "concepts/memory-learnings.md";
}

function createLearningPage(input: {
  title: string;
  now: string;
  category: WikiLearningCategory;
  label?: string;
  source: string;
  entry: string;
}): string {
  const tags = [input.category, input.label ? slugify(input.label) : "memory"]
    .filter(Boolean)
    .map((tag) => `"${tag}"`)
    .join(", ");
  return `---
created: "${input.now}"
updated: "${input.now}"
tags: [${tags}]
sources: ["${escapeYaml(input.source)}"]
---

# ${input.title}

## learnings

${input.entry}
`;
}

function appendLearning(content: string, entry: string): string {
  const trimmed = content.trimEnd();
  const headingMatch = /^## learnings\s*$/im.exec(trimmed);
  if (!headingMatch) return `${trimmed}\n\n## learnings\n\n${entry}\n`;

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const nextHeading = trimmed.slice(sectionStart).search(/\n##\s+/);
  const insertAt = nextHeading >= 0 ? sectionStart + nextHeading : trimmed.length;
  return `${trimmed.slice(0, insertAt).trimEnd()}\n${entry}\n${trimmed
    .slice(insertAt)
    .replace(/^\n*/, "")}${insertAt < trimmed.length ? "\n" : ""}`;
}

function updateFrontmatterTimestamp(content: string, now: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return content;
  const frontmatter = content.slice(4, end);
  const nextFrontmatter = /^updated:/m.test(frontmatter)
    ? frontmatter.replace(/^updated:.*$/m, `updated: "${now}"`)
    : `${frontmatter.trimEnd()}\nupdated: "${now}"`;
  return `---\n${nextFrontmatter}\n---${content.slice(end + 4)}`;
}

async function addPageToIndex(
  client: WikiClient,
  category: WikiLearningCategory,
  path: string,
  title: string,
  profileId?: string,
): Promise<void> {
  const indexPath = scopeWikiPath("index.md", profileId);
  const current = (await client.read(indexPath)) || "# index\n";
  if (current.includes(`[[${path}]]`)) return;

  const heading = `## ${category}`;
  const entry = `- [[${path}]] — ${title}`;
  const headingPattern = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "im");
  const match = headingPattern.exec(current);
  let next: string;

  if (!match) {
    next = `${current.trimEnd()}\n\n${heading}\n\n${entry}\n`;
  } else {
    const sectionStart = match.index + match[0].length;
    const nextHeading = current.slice(sectionStart).search(/\n##\s+/);
    const insertAt = nextHeading >= 0 ? sectionStart + nextHeading : current.length;
    next = `${current.slice(0, insertAt).trimEnd()}\n${entry}\n${current.slice(insertAt).replace(/^\n*/, "\n")}`;
  }

  await client.write(indexPath, next);
}

function compactLearning(value: string): string {
  return sanitizeInline(value).slice(0, MAX_LEARNING_CHARS).trim();
}

function sanitizeInline(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
}

function compactTitle(value: string | undefined): string {
  return sanitizeInline(value || "").slice(0, 100);
}

function containsEquivalentLearning(existing: string, learning: string): boolean {
  const normalizedExisting = normalizeForComparison(existing);
  const normalizedLearning = normalizeForComparison(learning);
  return normalizedLearning.length > 0 && normalizedExisting.includes(normalizedLearning);
}

function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsSecretLikeMaterial(value: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) return true;
  if (
    /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|client[_ -]?secret)\s*[:=]\s*\S{8,}/i.test(
      value
    )
  ) {
    return true;
  }
  if (/\bbearer\s+[a-z0-9._~+/-]{16,}/i.test(value)) return true;
  if (/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/.test(value)) {
    return true;
  }
  if (/\bsk-(?:ant-|proj-|live-)?[a-zA-Z0-9_-]{16,}\b/.test(value)) return true;
  if (/\bgh[pousr]_[a-zA-Z0-9]{20,}\b/.test(value)) return true;
  if (/\bAKIA[0-9A-Z]{16}\b/.test(value)) return true;
  if (/\bAIza[0-9A-Za-z_-]{30,}\b/.test(value)) return true;
  if (/\bxox[baprs]-[a-zA-Z0-9-]{16,}\b/.test(value)) return true;
  if (/\b(?:sk|rk)_live_[a-zA-Z0-9]{16,}\b/.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{8,}@/im.test(value)) return true;
  return /\b(?:\d[ -]*?){13,19}\b/.test(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
