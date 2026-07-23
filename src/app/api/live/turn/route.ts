import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runLiveTurn } from "@/lib/live/turn";
import { CANVAS_CSP_HEADER } from "@/lib/live/canvas/sanitize";
import { renderErrorCanvas } from "@/lib/live/canvas/errorCanvas";
import { WikiClient } from "@/lib/live/wiki/client";
import { WELL_KNOWN } from "@/lib/live/wiki/paths";
import {
  renderProgressFailure,
  renderProgressFinish,
  renderProgressLine,
  renderProgressStart,
  renderProgressStillWorking,
} from "@/lib/live/canvas/progressCanvas";
import {
  MAX_FORM_FIELDS,
  MAX_SOURCE_TEXT_LEN,
  MAX_TEXT_LEN,
} from "@/lib/live/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: Request) {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");

  // CSRF: this endpoint is navigated to from inside our iframe, which sits in
  // a sandboxed srcdoc. Sandbox + SameSite=Lax already block most cross-site
  // posts; we additionally require the referer/origin to match our host when
  // present (the iframe may report null origin under sandbox).
  if (!matchesHost(referer, host)) return errorResponse(403, "cross-origin referer");
  if (origin && origin !== "null" && !matchesHost(origin, host)) {
    return errorResponse(403, "cross-origin");
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) return errorResponse(401, "unauthorized");

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return errorResponse(400, "expected form-encoded body");
  }

  let intent = normalizeIntent(formData.get("intent"));
  const textLimit = intent === "ingest_source" ? MAX_SOURCE_TEXT_LEN : MAX_TEXT_LEN;
  let text = String(formData.get("text") ?? "").trim().slice(0, textLimit);

  const extra: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of formData.entries()) {
    if (key === "intent" || key === "text") continue;
    if (typeof value !== "string") continue;
    if (count >= MAX_FORM_FIELDS) break;
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
    if (!safeKey) continue;
    const fieldLimit =
      intent === "ingest_source" && isSourceTextField(safeKey) ? MAX_SOURCE_TEXT_LEN : MAX_TEXT_LEN;
    extra[safeKey] = value.slice(0, fieldLimit);
    count++;
  }

  if (!text && intent === "user_message" && Object.keys(extra).length === 0) {
    const inferred = await inferEmptySubmissionFromCurrentCanvas({
      supabase,
      userId: user.id,
    });
    if (inferred) {
      intent = "button_click";
      text = `The user clicked the "${inferred.label}" button on the Live canvas. Treat that click as the user's requested action.`;
      extra.clicked_button = inferred.label;
    } else {
      intent = "repair_empty_submit";
      text =
        "A Live canvas control was clicked, but the form submitted no message or action payload. Repair the canvas so every retry/action button sends a specific intent, hidden text value, or submit button name/value.";
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (html: string) => controller.enqueue(encoder.encode(html));
      let lastProgressKey = "";
      const sendProgress = (message: string, kind?: "info" | "warn" | "done") => {
        const compact = message.replace(/\s+/g, " ").trim();
        const key = `${kind || "info"}:${compact}`;
        if (!compact || key === lastProgressKey) return;
        lastProgressKey = key;
        send(renderProgressLine(compact, kind));
      };
      send(renderProgressStart());
      sendProgress("received your message");
      send(renderProgressStillWorking());

      try {
        const result = await runLiveTurn(
          {
            supabase,
            userId: user.id,
            userEmail: user.email,
            cookies: req.headers.get("cookie") || undefined,
            userAgent: req.headers.get("user-agent") || undefined,
            intent,
            text,
            extra,
          },
          sendProgress
        );
        send(renderProgressFinish(result.html));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(renderProgressFailure(message));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": CANVAS_CSP_HEADER,
      "Referrer-Policy": "no-referrer",
    },
  });
}

function isSourceTextField(key: string): boolean {
  return /^(source_text|source_body|source_content|raw_source|content)$/i.test(key);
}

function normalizeIntent(value: FormDataEntryValue | null): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "user_message";
  const normalized = raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 48);
  return normalized || "user_message";
}

async function inferEmptySubmissionFromCurrentCanvas(args: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  userId: string;
}): Promise<{ label: string } | null> {
  try {
    const wiki = new WikiClient(args.supabase, args.userId);
    const html = (await wiki.read(WELL_KNOWN.canvas)) ?? "";
    const candidates = findEmptySubmitButtonLabels(html);
    return candidates.length === 1 ? { label: candidates[0] } : null;
  } catch {
    return null;
  }
}

function findEmptySubmitButtonLabels(html: string): string[] {
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi) ?? [];
  const labels: string[] = [];
  for (const form of forms) {
    if (!isLivePostForm(form)) continue;
    if (formHasMeaningfulPayload(form)) continue;

    for (const label of extractSubmitLabels(form)) {
      if (label) labels.push(label);
    }
  }
  return Array.from(new Set(labels.map((label) => label.trim()).filter(Boolean)));
}

function isLivePostForm(formHtml: string): boolean {
  const openTag = formHtml.match(/<form\b[^>]*>/i)?.[0] ?? "";
  const action = getHtmlAttr(openTag, "action");
  const method = getHtmlAttr(openTag, "method");
  const normalizedAction = action.replace(/\/+$/, "");
  const postsToLive =
    normalizedAction === "/api/live/turn" || normalizedAction.endsWith("/api/live/turn");
  return postsToLive && (!method || method.toLowerCase() === "post");
}

function formHasMeaningfulPayload(formHtml: string): boolean {
  const intent = findControlValue(formHtml, "intent");
  if (intent && !GENERIC_FORM_INTENTS.has(intent.toLowerCase())) return true;

  const controls = formHtml.match(/<(input|textarea|select|button)\b[^>]*>/gi) ?? [];
  return controls.some((control) => {
    const name = getHtmlAttr(control, "name");
    return !!name && name.toLowerCase() !== "intent";
  });
}

const GENERIC_FORM_INTENTS = new Set([
  "user_message",
  "query",
  "form_submit",
  "open_page",
  "retry",
]);

function findControlValue(formHtml: string, name: string): string {
  const controls = formHtml.match(/<(input|button)\b[^>]*>/gi) ?? [];
  for (const control of controls) {
    if (getHtmlAttr(control, "name").toLowerCase() !== name.toLowerCase()) continue;
    const value = getHtmlAttr(control, "value");
    if (value) return value;
  }
  return "";
}

function extractSubmitLabels(formHtml: string): string[] {
  const labels: string[] = [];
  for (const button of formHtml.match(/<button\b[^>]*>[\s\S]*?<\/button\s*>/gi) ?? []) {
    const type = getHtmlAttr(button, "type").toLowerCase();
    if (type && type !== "submit") continue;
    labels.push(stripHtml(button.replace(/^<button\b[^>]*>/i, "").replace(/<\/button\s*>$/i, "")));
  }

  for (const input of formHtml.match(/<input\b[^>]*>/gi) ?? []) {
    const type = getHtmlAttr(input, "type").toLowerCase();
    if (type !== "submit" && type !== "button") continue;
    const value = getHtmlAttr(input, "value");
    if (value) labels.push(value);
  }

  return labels.map((label) => label.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function stripHtml(value: string): string {
  return value.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

function getHtmlAttr(tag: string, attr: string): string {
  const match = tag.match(new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, "i"));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function matchesHost(urlString: string | null, expectedHost: string | null): boolean {
  if (!urlString) return true;
  if (!expectedHost) return false;
  try {
    return new URL(urlString).host === expectedHost;
  } catch {
    return false;
  }
}

function errorResponse(status: number, message: string): NextResponse {
  return new NextResponse(renderErrorCanvas(message), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CANVAS_CSP_HEADER,
    },
  });
}
