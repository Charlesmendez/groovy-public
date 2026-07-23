import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveChatModel,
  getOrchestratorAnthropicModel,
  getAnthropicContextProviderOptions,
} from "@/lib/ai/modelResolver";
import { logWarn } from "@/lib/observability/log";
import { WikiClient } from "./wiki/client";
import { WELL_KNOWN } from "./wiki/paths";
import { ensureWikiBootstrapped, type WikiState } from "./wiki/bootstrap";
import { withWikiMutationLock } from "./wiki/mutationLock";
import { storeRawSource, type RawSourceRecord } from "./wiki/rawSources";
import { SEED_CANVAS_HTML } from "./canvas/seed";
import { sanitizeCanvasHtml } from "./canvas/sanitize";
import { renderErrorCanvas } from "./canvas/errorCanvas";
import { appendCanvasRevision } from "./canvas/revisions";
import { loadLiveOrchestratorContext } from "./context/orchestrator";
import { buildLiveSystemPrompt } from "./prompts/system";
import {
  MAX_CANVAS_OUTPUT_TOKENS,
  MAX_CANVAS_REPAIR_HTML_CHARS,
  LOG_TAIL_LINES,
  MAX_COLLECTED_HTML_BYTES,
  WIKI_UPDATE_STEP_BUDGET,
} from "./limits";

const CANVAS_GENERATION_TIMEOUT_MS = 150_000;
const CANVAS_REPAIR_TIMEOUT_MS = 90_000;
const REPAIR_REQUIRED_REMOVALS = new Set([
  "script",
  "script-open",
  "forbidden-element",
  "link-element",
  "inline-event-handler",
  "srcset",
  "javascript-url",
  "data-html-url",
  "css-import",
  "forbidden-meta",
  "off-origin-action",
  "off-origin-formaction",
  "off-origin-href",
  "off-origin-src",
  "off-origin-poster",
  "off-origin-xlink:href",
]);

export type LiveTurnInput = {
  supabase: SupabaseClient;
  userId: string;
  userEmail?: string | null;
  cookies?: string;
  userAgent?: string;
  intent: string;
  text: string;
  extra: Record<string, string>;
};

export type LiveTurnResult = {
  html: string;
};

export type LiveTurnProgress = (
  message: string,
  kind?: "info" | "warn" | "done"
) => void | Promise<void>;

type TurnContext = {
  supabase: SupabaseClient;
  userId: string;
  wiki: WikiClient;
  state: WikiState;
  userIntent: string;
  recentLog: string;
  rawSource: RawSourceRecord | null;
  rawSourceError: string | null;
};

type ValidatedCanvas = {
  html: string;
  shouldUpdateWiki: boolean;
  revisionReason: string;
};

type CanvasValidation = {
  ok: boolean;
  html: string;
  errors: string[];
  removed: string[];
};

export async function runLiveTurn(
  input: LiveTurnInput,
  progress: LiveTurnProgress = () => undefined
): Promise<LiveTurnResult> {
  const { supabase, userId, intent, text, extra } = input;
  await progress("reading your wiki");
  const wiki = new WikiClient(supabase, userId);
  const state = await ensureWikiBootstrapped(wiki);

  const recentLog = state.logMd
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-LOG_TAIL_LINES)
    .join("\n");

  const userIntent = formatUserIntent({ intent, text, extra });
  if (intent === "ingest_source") {
    await progress("saving the raw source");
  }
  const { rawSource, rawSourceError } = await maybeStoreRawSource({
    supabase,
    userId,
    intent,
    text,
    extra,
  });
  await progress("searching related wiki pages");
  const relevantWikiMd = await loadRelevantWikiContext(wiki, userIntent, userId);
  const orchestratorContext = await loadLiveOrchestratorContext({
    supabase,
    userId,
    userEmail: input.userEmail,
    message: text.trim() || userIntent,
    cookies: input.cookies,
    userAgent: input.userAgent,
    progress,
  }).catch((err) => {
    logWarn("live.turn.orchestrator_context_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "The orchestrator tool pass failed for this turn.";
  });
  const ctx: TurnContext = {
    supabase,
    userId,
    wiki,
    state,
    userIntent,
    recentLog,
    rawSource,
    rawSourceError,
  };

  const systemPrompt = buildLiveSystemPrompt({
    schemaMd: state.schemaMd,
    indexMd: state.indexMd,
    relevantWikiMd,
    orchestratorContext,
    rawSourceMd: rawSource?.markdown ?? "",
    rawSourceRef: rawSource?.ref ?? "",
    rawSourceError,
    recentLog,
    currentCanvasHtml: state.canvasHtml,
    userIntent,
    isFirstTurn: state.logMd.trim().length === 0,
  });

  const modelName = getOrchestratorAnthropicModel();
  const model = resolveChatModel("anthropic", modelName);
  const providerOptions = getAnthropicContextProviderOptions("anthropic", modelName);
  await progress("drafting the next canvas");
  const canvas = await generateValidatedCanvas({
    model,
    providerOptions,
    systemPrompt,
    userIntent,
    userId,
    progress,
  });
  await finalizeTurn(ctx, canvas, progress);
  return { html: canvas.html };
}

async function generateValidatedCanvas(args: {
  model: Parameters<typeof generateText>[0]["model"];
  providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
  systemPrompt: string;
  userIntent: string;
  userId: string;
  progress: LiveTurnProgress;
}): Promise<ValidatedCanvas> {
  try {
    const firstHtml = await generateCanvasHtml({
      ...args,
      prompt: args.userIntent,
      timeoutMs: CANVAS_GENERATION_TIMEOUT_MS,
    });
    await args.progress("checking the canvas");
    const firstValidation = validateCanvasHtml(firstHtml);
    if (firstValidation.ok) {
      return {
        html: firstValidation.html,
        shouldUpdateWiki: true,
        revisionReason: revisionReason("turn", firstValidation),
      };
    }

    logWarn("live.turn.canvas_validation_failed", {
      userId: args.userId,
      errors: firstValidation.errors,
      removed: firstValidation.removed,
    });

    await args.progress("the first draft had broken html; repairing it", "warn");
    const repairedHtml = await generateCanvasHtml({
      ...args,
      prompt: buildCanvasRepairPrompt({
        userIntent: args.userIntent,
        badHtml: firstHtml,
        errors: firstValidation.errors,
        removed: firstValidation.removed,
      }),
      timeoutMs: CANVAS_REPAIR_TIMEOUT_MS,
    });
    await args.progress("checking the repaired canvas");
    const repairValidation = validateCanvasHtml(repairedHtml);
    if (repairValidation.ok) {
      return {
        html: repairValidation.html,
        shouldUpdateWiki: true,
        revisionReason: revisionReason("auto-repaired", repairValidation, firstValidation.errors),
      };
    }

    logWarn("live.turn.canvas_repair_failed", {
      userId: args.userId,
      originalErrors: firstValidation.errors,
      repairErrors: repairValidation.errors,
      removed: repairValidation.removed,
    });

    return validationFallbackCanvas(repairValidation.errors, firstValidation.errors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn("live.turn.canvas_generation_failed", {
      userId: args.userId,
      error: message,
    });
    return {
      html: renderErrorCanvas(message, { withRetry: true }),
      shouldUpdateWiki: false,
      revisionReason: "generation failed",
    };
  }
}

async function generateCanvasHtml(args: {
  model: Parameters<typeof generateText>[0]["model"];
  providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  const result = await generateText({
    model: args.model,
    system: args.systemPrompt,
    prompt: args.prompt,
    providerOptions: args.providerOptions,
    maxOutputTokens: MAX_CANVAS_OUTPUT_TOKENS,
    maxRetries: 1,
    timeout: { totalMs: args.timeoutMs, chunkMs: 45_000 },
  });

  const html = result.text ?? "";
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_COLLECTED_HTML_BYTES) {
    throw new Error(`Canvas HTML too large (${bytes} bytes, max ${MAX_COLLECTED_HTML_BYTES})`);
  }
  if (result.finishReason === "length") {
    throw new Error(`Canvas generation reached the ${MAX_CANVAS_OUTPUT_TOKENS} token limit`);
  }
  return html;
}

function buildCanvasRepairPrompt(args: {
  userIntent: string;
  badHtml: string;
  errors: string[];
  removed: string[];
}): string {
  const removed = args.removed.length > 0 ? args.removed.join(", ") : "(none)";
  return `The HTML canvas you just wrote failed validation and was not saved.

Return one complete corrected HTML document only. Do not use markdown fences.

Requirements:
- include <!doctype html>, <html>, <head>, and <body>
- include visible body content
- include a usable form that posts back to /api/live/turn with method="post"
- make every button-only form submit meaning: use a specific intent,
  a hidden text value, or a submit button with name/value
- keep CSS inline in <style>; do not use scripts, iframes, external stylesheets,
  event handlers, or off-origin form actions
- preserve the user's requested content and interaction

Validation errors:
${args.errors.map((error) => `- ${error}`).join("\n")}

Sanitizer removals:
${removed}

Original user intent:
${args.userIntent}

Rejected HTML, truncated if needed:
${truncateForPrompt(args.badHtml, MAX_CANVAS_REPAIR_HTML_CHARS)}`;
}

async function maybeStoreRawSource(args: {
  supabase: SupabaseClient;
  userId: string;
  intent: string;
  text: string;
  extra: Record<string, string>;
}): Promise<{ rawSource: RawSourceRecord | null; rawSourceError: string | null }> {
  if (args.intent !== "ingest_source") {
    return { rawSource: null, rawSourceError: null };
  }

  const sourceFields = [
    args.extra.source_text,
    args.extra.source_body,
    args.extra.source_content,
    args.extra.raw_source,
    args.extra.content,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  const sourceText = uniqueTextParts(sourceFields.length > 0 ? sourceFields : [args.text]).join(
    "\n\n"
  );

  try {
    const rawSource = await storeRawSource({
      supabase: args.supabase,
      userId: args.userId,
      title: args.extra.source_title || args.extra.title || "",
      content: sourceText,
      url: args.extra.source_url || args.extra.url || null,
    });
    return { rawSource, rawSourceError: null };
  } catch (err) {
    const rawSourceError = err instanceof Error ? err.message : String(err);
    logWarn("live.turn.raw_source_failed", {
      userId: args.userId,
      error: rawSourceError,
    });
    return { rawSource: null, rawSourceError };
  }
}

function uniqueTextParts(parts: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const part of parts) {
    const normalized = part.trim().replace(/\r\n/g, "\n");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

async function loadRelevantWikiContext(
  wiki: WikiClient,
  userIntent: string,
  userId: string
): Promise<string> {
  if (/^intent:\s*lint_wiki/im.test(userIntent)) {
    return loadWikiLintContext(wiki, userId);
  }

  const query = userIntent.replace(/^intent:\s*\w+/im, "").trim();
  if (!query) return "";

  try {
    const hits = await wiki.search(query, 5);
    return hits
      .map(({ path, content }) => {
        const body = content.length > 2500 ? `${content.slice(0, 2500)}\n...` : content;
        return `## ${path}\n\n${body}`;
      })
      .join("\n\n---\n\n");
  } catch (err) {
    logWarn("live.turn.relevant_wiki_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

async function loadWikiLintContext(wiki: WikiClient, userId: string): Promise<string> {
  try {
    const paths = (await wiki.list()).filter((path) => path.endsWith(".md")).slice(0, 60);
    const files = await Promise.all(
      paths.map(async (path) => ({ path, content: (await wiki.read(path)) ?? "" }))
    );
    return files
      .map(({ path, content }) => {
        const body = content.length > 1200 ? `${content.slice(0, 1200)}\n...` : content;
        return `## ${path}\n\n${body || "(empty)"}`;
      })
      .join("\n\n---\n\n");
  } catch (err) {
    logWarn("live.turn.lint_context_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

function formatUserIntent(args: {
  intent: string;
  text: string;
  extra: Record<string, string>;
}): string {
  const lines = [`intent: ${args.intent}`];
  if (args.text) {
    lines.push(formatIntentField("text", args.text, args.intent));
  }
  for (const [k, v] of Object.entries(args.extra)) {
    if (!v) continue;
    lines.push(formatIntentField(k, v, args.intent));
  }
  return lines.join("\n");
}

function formatIntentField(key: string, value: string, intent: string): string {
  const trimmed = value.trim();
  if (!trimmed) return `${key}:`;

  if (intent === "ingest_source" && isSourceContentField(key)) {
    const preview = truncateForPrompt(trimmed, 1200);
    return `${key}_bytes: ${Buffer.byteLength(trimmed, "utf8")}\n${key}_preview: ${preview}`;
  }

  return `${key}: ${truncateForPrompt(trimmed, 4000)}`;
}

function isSourceContentField(key: string): boolean {
  return /^(text|source_text|source_body|source_content|raw_source|content)$/i.test(key);
}

function truncateForPrompt(value: string, maxLen: number): string {
  return value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;
}

function validateCanvasHtml(rawHtml: string): CanvasValidation {
  const errors: string[] = [];
  const trimmed = rawHtml.trim();

  if (!trimmed) {
    errors.push("HTML output is empty");
  }

  const ensured = ensureDoctype(trimmed);
  if (!ensured) {
    errors.push("HTML must be a complete document with an <html>, <body>, or <main> root");
  }

  const { html, removed } = sanitizeCanvasHtml(ensured || trimmed);
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_COLLECTED_HTML_BYTES) {
    errors.push(`HTML is too large after sanitization (${bytes} bytes)`);
  }

  if (!/^<!doctype\s+html>/i.test(html)) {
    errors.push("HTML must start with <!doctype html>");
  }
  if (!/<html\b/i.test(html)) {
    errors.push("HTML must include an <html> element");
  }
  if (!/<head\b/i.test(html)) {
    errors.push("HTML must include a <head> element");
  }
  if (!/<body\b/i.test(html)) {
    errors.push("HTML must include a <body> element");
  }

  const body = extractBodyHtml(html);
  if (!body) {
    errors.push("HTML body could not be found");
  } else {
    const visibleText = stripHtmlForPrompt(body, 600);
    const hasControls = /<(form|input|textarea|button|select|a)\b/i.test(body);
    if (visibleText.length < 3 && !hasControls) {
      errors.push("HTML body has no visible content or controls");
    }
    if (!hasLiveTurnForm(body)) {
      errors.push('HTML must include a form with action="/api/live/turn" and method="post"');
    } else if (!hasMeaningfulLiveTurnFormPayload(body)) {
      errors.push(
        'Live forms must submit a meaningful payload. For button-only actions, use a specific intent such as "retry_calendar" or give the clicked button/hidden input a name and value.'
      );
    }
    if (!/<(input|textarea|button|select)\b/i.test(body)) {
      errors.push("HTML must include at least one input, textarea, button, or select control");
    }
  }

  if (hasHiddenRootCss(html)) {
    errors.push("Root content appears to be hidden by CSS");
  }

  const repairRemovals = removed.filter((tag) => REPAIR_REQUIRED_REMOVALS.has(tag));
  if (repairRemovals.length > 0) {
    errors.push(`Sanitizer removed unsafe or render-critical markup: ${repairRemovals.join(", ")}`);
  }

  return { ok: errors.length === 0, html, errors, removed };
}

function extractBodyHtml(html: string): string {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  return match?.[1]?.trim() ?? "";
}

function hasLiveTurnForm(bodyHtml: string): boolean {
  return getLiveTurnForms(bodyHtml).length > 0;
}

function hasMeaningfulLiveTurnFormPayload(bodyHtml: string): boolean {
  return getLiveTurnForms(bodyHtml).some((form) => {
    const intent = findNamedControlValue(form, "intent");
    if (intent && !GENERIC_FORM_INTENTS.has(intent.toLowerCase())) return true;

    const controls = form.match(/<(input|textarea|select|button)\b[^>]*>/gi) ?? [];
    return controls.some((control) => {
      const name = getHtmlAttr(control, "name");
      return !!name && name.toLowerCase() !== "intent";
    });
  });
}

const GENERIC_FORM_INTENTS = new Set([
  "user_message",
  "query",
  "form_submit",
  "open_page",
  "retry",
]);

function getLiveTurnForms(bodyHtml: string): string[] {
  const forms = bodyHtml.match(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi) ?? [];
  return forms.filter((form) => {
    const openTag = form.match(/<form\b[^>]*>/i)?.[0] ?? "";
    const action = getHtmlAttr(openTag, "action");
    const method = getHtmlAttr(openTag, "method");
    const normalizedAction = action.replace(/\/+$/, "");
    const postsToLive =
      normalizedAction === "/api/live/turn" || normalizedAction.endsWith("/api/live/turn");
    return postsToLive && (!method || method.toLowerCase() === "post");
  });
}

function findNamedControlValue(formHtml: string, name: string): string {
  const controls = formHtml.match(/<(input|button)\b[^>]*>/gi) ?? [];
  for (const control of controls) {
    if (getHtmlAttr(control, "name").toLowerCase() !== name.toLowerCase()) continue;
    const value = getHtmlAttr(control, "value");
    if (value) return value;
  }
  return "";
}

function getHtmlAttr(tag: string, attr: string): string {
  const match = tag.match(new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, "i"));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function hasHiddenRootCss(html: string): boolean {
  return /(?:html|body|main)\s*\{[^}]*\b(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)\b/i.test(
    html
  );
}

function revisionReason(
  prefix: string,
  validation: CanvasValidation,
  originalErrors: string[] = []
): string {
  const details = [
    ...originalErrors.map((error) => `fixed ${error}`),
    ...validation.removed.map((tag) => `sanitized ${tag}`),
  ];
  if (details.length === 0) return prefix;
  return `${prefix}: ${details.join(", ").slice(0, 180)}`;
}

function validationFallbackCanvas(errors: string[], originalErrors: string[]): ValidatedCanvas {
  const allErrors = [...originalErrors, ...errors].filter(Boolean);
  const message =
    allErrors.length > 0
      ? `I tried to repair the canvas, but it still failed validation: ${allErrors
          .slice(0, 4)
          .join("; ")}`
      : "I tried to repair the canvas, but it still failed validation.";
  return {
    html: renderErrorCanvas(message, { withRetry: true }),
    shouldUpdateWiki: false,
    revisionReason: "validation failed",
  };
}

async function finalizeTurn(
  ctx: TurnContext,
  canvas: ValidatedCanvas,
  progress: LiveTurnProgress
): Promise<void> {
  const html = canvas.html || SEED_CANVAS_HTML;

  await progress("saving the canvas");
  await ctx.wiki.write(WELL_KNOWN.canvas, html);
  await appendCanvasRevision({
    supabase: ctx.supabase,
    userId: ctx.userId,
    html,
    reason: canvas.revisionReason,
  });

  if (!canvas.shouldUpdateWiki) {
    await progress("ready", "done");
    return;
  }

  await progress("filing useful memory into the wiki");
  await withWikiMutationLock(ctx.userId, () =>
    runWikiUpdatePass(ctx, html, progress)
  ).catch((err) => {
    logWarn("live.turn.wiki_update_failed", {
      userId: ctx.userId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  await progress("ready", "done");
}

function ensureDoctype(html: string): string {
  if (!html) return "";
  if (/^<!doctype/i.test(html)) return html;
  const bodyStart = html.search(/<html|<body|<main/i);
  if (bodyStart === -1) return "";
  return `<!doctype html>\n${html}`;
}

function stripHtmlForPrompt(html: string, maxLen: number): string {
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

async function runWikiUpdatePass(
  ctx: TurnContext,
  sanitizedCanvas: string,
  progress: LiveTurnProgress
): Promise<void> {
  const { wiki, userIntent, state, recentLog, rawSource, rawSourceError } = ctx;
  const modelName = getOrchestratorAnthropicModel();
  const model = resolveChatModel("anthropic", modelName);
  let didWriteLog = false;

  const tools = {
    wiki_read: tool({
      description: "Read a wiki file. Returns null if it doesn't exist.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        await progress(`wiki read ${path}`);
        return (await wiki.read(path)) ?? "(not found)";
      },
    }),
    wiki_search: tool({
      description: "Search markdown wiki files by substring.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(8).optional(),
      }),
      execute: async ({ query, limit }) => {
        await progress(`wiki search ${query}`);
        return wiki.search(query, limit ?? 8);
      },
    }),
    wiki_write: tool({
      description:
        "Create or overwrite a wiki file with the given content. Always include a one-line reason.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
        reason: z.string(),
      }),
      execute: async ({ path, content }) => {
        await progress(`wiki write ${path}`);
        await wiki.write(path, content);
        return "ok";
      },
    }),
    wiki_log: tool({
      description:
        "Append a single line to log.md. Format: '<op> | <title>'. The date is prefixed automatically.",
      inputSchema: z.object({ entry: z.string() }),
      execute: async ({ entry }) => {
        didWriteLog = true;
        await progress(`wiki log ${entry}`);
        await wiki.appendLog(entry);
        return "ok";
      },
    }),
  };

  const updatePrompt = `you just finished writing a canvas for the user. now decide what (if
anything) to file into the wiki, based on what they said this turn.

guidance:
- store: preferences, facts about the user, named entities (people,
  products, places, companies), active projects, standing decisions.
- integrate new information into existing pages instead of creating
  isolated notes when a relevant page already exists.
- preserve contradictions by annotating the newer claim with date/source
  context; do not silently delete the older claim.
- file useful query answers, comparisons, decisions, and analyses back
  into the wiki when they should compound.
- when a raw source is present, create or update a \`sources/*.md\`
  summary page for it and cite the raw source ref in frontmatter or
  a sources section.
- source-backed claims should include a source reference. prefer
  \`[[sources/...]]\` for wiki summaries and raw refs for immutable raw
  source records.
- skip: greetings, transient chitchat, generic knowledge.
- a typical turn touches 1-5 wiki files. zero is fine.
- always finish by calling wiki_log once with a one-line summary
  (format: "<op> | <short title>"). examples:
    "ingest | user introduced themselves as carlos"
    "update | added pricing decision to projects/flow.md"
    "noop | small talk, nothing filed"
- read index.md if you need to find existing pages before writing.
- when you create a new page, also update index.md to list it.

# context

## index.md

${state.indexMd}

## recent log

${recentLog || "(empty)"}

## user intent this turn

${userIntent}

## raw source for this turn

${rawSource ? rawSource.markdown : rawSourceError ? `raw source failed: ${rawSourceError}` : "(none)"}

## summary of canvas you just wrote (text content only, truncated)

${stripHtmlForPrompt(sanitizedCanvas, 1200)}

call wiki_* tools as needed. when finished, respond with the single
word "done".`;

  await generateText({
    model,
    prompt: updatePrompt,
    tools,
    stopWhen: stepCountIs(WIKI_UPDATE_STEP_BUDGET),
    maxOutputTokens: 1200,
    maxRetries: 1,
  });

  if (!didWriteLog) {
    await wiki.appendLog(fallbackWikiLogEntry(userIntent));
  }
}

function fallbackWikiLogEntry(userIntent: string): string {
  const compact = userIntent.replace(/\s+/g, " ").trim();
  if (!compact) return "noop | live turn processed";
  return `noop | ${compact.slice(0, 80)}`;
}
